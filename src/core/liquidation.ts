/**
 * Gestion de la liquidation — DeepBook Hedging Bot v3
 *
 * Machine à états : SAFE → WARN → CRITICAL → EMERGENCY
 *
 * SAFE      : marge OK, hedging normal autorisé
 * WARN      : marge faible (< marginWarnPct), alerte envoyée
 * CRITICAL  : marge très faible (< marginCriticalPct)
 *             → circuit breaker ouvert, plus de nouveau hedge
 * EMERGENCY : marge critique (< marginEmergencyPct)
 *             → fermeture forcée de toutes les positions ouvertes
 *
 * Le circuit breaker NE SE RÉARME que lorsque la marge remonte
 * au-dessus de circuitBreakerResetPct (hysteresis volontaire pour
 * éviter les oscillations rapides).
 */

import { Transaction }          from '@mysten/sui/transactions';

import { CONFIG }               from '../config.js';
import { HedgingError }         from '../types.js';
import type {
  AppContext,
  MarginState,
  LiquidationRisk,
  CircuitBreakerState,
  EmergencyCloseResult,
} from '../types.js';
import { executeSafe, normalizeError } from '../utils/sui.js';
import { logger }               from '../utils/logger.js';
import { metrics }              from '../utils/metrics.js';
import { alerts }               from '../utils/alerts.js';

// ── État des circuit breakers par pool ────────────────────────
const circuitBreakers = new Map<string, CircuitBreakerState>();

function getCircuitBreaker(poolId: string): CircuitBreakerState {
  if (!circuitBreakers.has(poolId)) {
    circuitBreakers.set(poolId, {
      poolId,
      open:         false,
      reason:       '',
      openedAt:     null,
      blockedCycles: 0,
    });
  }
  return circuitBreakers.get(poolId)!;
}

// ── Récupération de l'état de la marge ───────────────────────
/**
 * Calcule le ratio de marge pour un pool.
 *
 * Sur DeepBook (order book pur), il n'y a pas de levier au sens
 * d'un protocole de prêt. La "marge" ici représente le ratio :
 *
 *   margin_ratio = solde_disponible_en_quote / valeur_position_ouverte
 *
 * Un ratio de 1.0 (100%) signifie que le collatéral couvre exactement
 * la position. En dessous de 20%, le risque d'insolvabilité augmente.
 *
 * Si DeepBook expose un endpoint de marge natif, remplacez le calcul
 * ci-dessous par l'appel SDK approprié.
 */
export async function fetchMarginState(
  poolId: string,
  ctx: AppContext
): Promise<MarginState> {
  try {
    // 1. Récupérer le solde disponible en quote (USDC) dans le balance manager
    const balanceManager = await ctx.db.getBalanceManager('MANAGER');
    const quoteBalance   = balanceManager
      ? Number(balanceManager.balance ?? 0) / 1e9
      : 0;

    // 2. Récupérer les ordres ouverts pour estimer la valeur de position
    const openOrders = await ctx.db.getOpenOrders(poolId, ctx.address);
    const orders = Array.isArray(openOrders) ? openOrders : [];

    // 3. Estimer la valeur notionnelle des positions ouvertes
    //    = somme(quantité_restante × prix) pour chaque ordre
    const positionValueUsd = orders.reduce((acc, o: {
      price?: bigint | string | number;
      original_quantity?: bigint | string | number;
      filled_quantity?: bigint | string | number;
    }) => {
      const price     = Number(o.price ?? 0) / 1e9;
      const qty       = Number(o.original_quantity ?? 0) / 1e9;
      const filled    = Number(o.filled_quantity ?? 0) / 1e9;
      const remaining = qty - filled;
      return acc + (remaining * price);
    }, 0);

    // 4. Calculer le ratio de marge
    //    Si aucune position ouverte → marge infinie → SAFE
    const marginRatio = positionValueUsd > 0
      ? quoteBalance / positionValueUsd
      : Infinity;

    // 5. Ratio de liquidation estimé (typiquement 1.0 sur DeepBook sans levier)
    //    Sur un protocole avec levier, ce serait le ratio minimal imposé
    const liquidationRatio = 1.0 / CONFIG.leverage;

    // 6. Classifier le risque
    const risk = classifyRisk(marginRatio * 100);

    const state: MarginState = {
      poolId,
      collateralUsd:    quoteBalance,
      positionValueUsd,
      marginRatio:      isFinite(marginRatio) ? marginRatio : 999,
      liquidationRatio,
      risk,
      timestamp:        Date.now(),
    };

    // Mise à jour métriques
    metrics.setGauge('hedge_margin_ratio',      marginRatio,      { pool: poolId.slice(0, 8) });
    metrics.setGauge('hedge_collateral_usd',    quoteBalance,     { pool: poolId.slice(0, 8) });
    metrics.setGauge('hedge_position_value_usd', positionValueUsd, { pool: poolId.slice(0, 8) });

    logger.info('État de la marge', {
      pool:             poolId.slice(0, 8),
      collateral:       `${quoteBalance.toFixed(2)} USD`,
      positionValue:    `${positionValueUsd.toFixed(2)} USD`,
      marginRatio:      `${(marginRatio * 100).toFixed(1)}%`,
      risk,
    });

    return state;

  } catch (err) {
    logger.warn('Impossible de lire l\'état de la marge', {
      poolId,
      error: (err as Error).message,
    });

    // En cas d'erreur, on retourne SAFE pour ne pas bloquer le bot,
    // mais on log clairement l'avertissement.
    return {
      poolId,
      collateralUsd:    0,
      positionValueUsd: 0,
      marginRatio:      999,
      liquidationRatio: 1.0 / CONFIG.leverage,
      risk:             'SAFE',
      timestamp:        Date.now(),
    };
  }
}

// ── Classification du risque ──────────────────────────────────
export function classifyRisk(marginPct: number): LiquidationRisk {
  if (!isFinite(marginPct) || marginPct >= CONFIG.marginWarnPct) return 'SAFE';
  if (marginPct >= CONFIG.marginCriticalPct)                      return 'WARN';
  if (marginPct >= CONFIG.marginEmergencyPct)                     return 'CRITICAL';
  return 'EMERGENCY';
}

// ── Évaluation et gestion du circuit breaker ─────────────────
export async function evaluateAndActOnMargin(
  poolId: string,
  state: MarginState,
  ctx: AppContext
): Promise<void> {
  const cb = getCircuitBreaker(poolId);

  switch (state.risk) {

    case 'SAFE':
      // Tentative de réarmement du circuit breaker si marge suffisante
      if (cb.open && state.marginRatio * 100 >= CONFIG.circuitBreakerResetPct) {
        logger.info('Circuit breaker réarmé', {
          pool:        poolId.slice(0, 8),
          marginRatio: `${(state.marginRatio * 100).toFixed(1)}%`,
          resetAt:     `${CONFIG.circuitBreakerResetPct}%`,
        });
        cb.open          = false;
        cb.reason        = '';
        cb.openedAt      = null;
        cb.blockedCycles = 0;
        await (alerts as Record<string, (a: string, b: number) => Promise<void>>)['circuitBreakerReset']?.(poolId, state.marginRatio * 100);
      }
      break;

    case 'WARN':
      await (alerts as Record<string, (a: string, b: number, c?: number) => Promise<void>>)['marginWarning']?.(poolId, state.marginRatio * 100, CONFIG.marginWarnPct);
      break;

    case 'CRITICAL':
      if (CONFIG.circuitBreakerEnabled && !cb.open) {
        cb.open     = true;
        cb.reason   = `Marge critique : ${(state.marginRatio * 100).toFixed(1)}% < ${CONFIG.marginCriticalPct}%`;
        cb.openedAt = Date.now();
        logger.warn('⚡ Circuit breaker ouvert — hedging suspendu', {
          pool:   poolId.slice(0, 8),
          reason: cb.reason,
        });
        await (alerts as Record<string, (a: string, b: number) => Promise<void>>)['circuitBreakerOpen']?.(poolId, state.marginRatio * 100);
      }
      cb.blockedCycles++;
      break;

    case 'EMERGENCY':
      if (CONFIG.circuitBreakerEnabled && !cb.open) {
        cb.open     = true;
        cb.reason   = `URGENCE : marge ${(state.marginRatio * 100).toFixed(1)}% < ${CONFIG.marginEmergencyPct}%`;
        cb.openedAt = Date.now();
      }
      cb.blockedCycles++;

      if (CONFIG.emergencyCloseEnabled) {
        logger.error('🚨 URGENCE LIQUIDATION — fermeture forcée des positions', {
          pool:        poolId.slice(0, 8),
          marginRatio: `${(state.marginRatio * 100).toFixed(1)}%`,
        });
        await (alerts as Record<string, (a: string, b: number) => Promise<void>>)['emergencyClose']?.(poolId, state.marginRatio * 100);
        const result = await forceCloseAllPositions(poolId, ctx);
        if (!result.success) {
          logger.error('Fermeture forcée échouée', { pool: poolId.slice(0, 8), error: result.error });
        }
      } else {
        logger.error('🚨 URGENCE LIQUIDATION — fermeture automatique désactivée', {
          pool:  poolId.slice(0, 8),
          hint:  'Activez EMERGENCY_CLOSE_ENABLED=true ou fermez manuellement',
        });
        await (alerts as Record<string, (a: string, b: number) => Promise<void>>)['emergencyManual']?.(poolId, state.marginRatio * 100);
      }
      break;
  }
}

// ── Fermeture forcée de toutes les positions ──────────────────
export async function forceCloseAllPositions(
  poolId: string,
  ctx: AppContext
): Promise<EmergencyCloseResult> {
  logger.warn('Tentative de fermeture forcée de toutes les positions', {
    pool: poolId.slice(0, 8),
  });

  try {
    // 1. Récupérer tous les ordres ouverts
    const rawOrders = await ctx.db.getOpenOrders(poolId, ctx.address);
    const orders    = Array.isArray(rawOrders) ? rawOrders : [];

    if (orders.length === 0) {
      logger.info('Aucun ordre ouvert à fermer', { pool: poolId.slice(0, 8) });
      return { poolId, success: true, quantityClosed: 0 };
    }

    logger.info(`Annulation de ${orders.length} ordres ouverts`, {
      pool: poolId.slice(0, 8),
    });

    // 2. Annuler tous les ordres en une seule transaction (batch)
    const tx = new Transaction();
    let   totalQtyClosed = 0;

    for (const order of orders) {
      const orderId = BigInt(String(order.order_id ?? 0));
      const isBid   = Boolean(order.is_bid);
      const qty     = Number(order.original_quantity ?? 0) / 1e9;
      const filled  = Number(order.filled_quantity ?? 0) / 1e9;
      totalQtyClosed += (qty - filled);

      // Annulation de l'ordre via SDK DeepBook
      ctx.db.cancelOrder(
        {
          poolKey:           poolId,
          balanceManagerKey: 'MANAGER',
          orderId,
          isBid,
        },
        tx
      );
    }

    // 3. Exécuter la transaction (skipDryRun en urgence pour aller vite)
    const result = await executeSafe(tx, { skipDryRun: true }) as {
      digest?: string;
    };

    metrics.incCounter('hedge_emergency_closes_total', { pool: poolId.slice(0, 8) });

    logger.info('Fermeture forcée réussie', {
      pool:            poolId.slice(0, 8),
      ordersAnnulés:   orders.length,
      quantitéFermée:  totalQtyClosed.toFixed(4),
      digest:          result.digest,
    });

    return {
      poolId,
      success:        true,
      digest:         result.digest,
      quantityClosed: totalQtyClosed,
    };

  } catch (err) {
    const error = err instanceof HedgingError ? err : normalizeError(err);
    logger.error('Échec fermeture forcée', {
      pool:  poolId.slice(0, 8),
      error: error.message,
    });
    return {
      poolId,
      success:        false,
      quantityClosed: 0,
      error:          error.message,
    };
  }
}

// ── API publique : le circuit breaker est-il ouvert ? ─────────
export function isCircuitBreakerOpen(poolId: string): boolean {
  return getCircuitBreaker(poolId).open;
}

export function getCircuitBreakerState(poolId: string): Readonly<CircuitBreakerState> {
  return getCircuitBreaker(poolId);
}

/**
 * Réarmement manuel du circuit breaker (ex: après rechargement du wallet).
 * À utiliser avec précaution — préférer le réarmement automatique via la marge.
 */
export function resetCircuitBreakerManually(poolId: string): void {
  const cb = getCircuitBreaker(poolId);
  logger.warn('Réarmement MANUEL du circuit breaker', { pool: poolId.slice(0, 8) });
  cb.open          = false;
  cb.reason        = '';
  cb.openedAt      = null;
  cb.blockedCycles = 0;
}

// ── Vérification complète de la marge pour tous les pools ─────
export async function checkAllPoolsMargin(ctx: AppContext): Promise<void> {
  logger.info('Vérification de la marge pour tous les pools');

  for (const pool of CONFIG.pools) {
    try {
      const state = await fetchMarginState(pool.id, ctx);
      await evaluateAndActOnMargin(pool.id, state, ctx);
    } catch (err) {
      logger.warn('Erreur vérification marge pool', {
        pool:  pool.id.slice(0, 8),
        error: (err as Error).message,
      });
    }
  }
}
