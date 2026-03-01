import { Transaction }                   from '@mysten/sui/transactions';

import { CONFIG }                         from '../config.js';
import { HedgingError }                   from '../types.js';
import type { AppContext, ErrorStats, HedgeDecision, DeltaCache } from '../types.js';
import { executeSafe, normalizeError }    from '../utils/sui.js';
import { logger }                         from '../utils/logger.js';
import { metrics }                        from '../utils/metrics.js';
import { alerts }                         from '../utils/alerts.js';
import { computePreciseDelta }            from './delta.js';

// ── État interne ──────────────────────────────────────────────
const deltaCache  = new Map<string, DeltaCache>();
const errorStats: ErrorStats = { count: 0, lastError: null, consecutiveFailures: 0 };
const MAX_CONSECUTIVE_ERRORS = 5;

// ── Cache delta ───────────────────────────────────────────────
export async function getCachedDelta(poolId: string, ctx: AppContext): Promise<DeltaCache> {
  const cached = deltaCache.get(poolId);
  if (cached && Date.now() - cached.timestamp < CONFIG.cacheTtlMs) {
    logger.info(`Cache hit delta ${poolId.slice(0, 8)}...`, { delta: cached.delta });
    return cached;
  }

  // Calcul précis : position + ordres ouverts + prix mid
  const precise = await computePreciseDelta(poolId, ctx);

  const entry: DeltaCache = {
    delta:           precise.netDelta,
    rawDelta:        precise.rawDelta,
    pricedDelta:     precise.pricedDelta,
    openOrdersDelta: precise.openOrdersDelta,
    midPrice:        precise.midPrice,
    timestamp:       Date.now(),
    poolId,
  };

  deltaCache.set(poolId, entry);

  // Mise à jour métriques
  metrics.setDelta(poolId, precise.netDelta, precise.pricedDelta);

  return entry;
}

// ── Décision de hedging ───────────────────────────────────────
export function decideHedging(delta: number, poolId: string): HedgeDecision {
  const absD = Math.abs(delta);

  if (absD < CONFIG.deltaThreshold) {
    return {
      action:   'none',
      quantity: 0,
      reason:   `Delta ${delta.toFixed(4)} sous le seuil ${CONFIG.deltaThreshold}`,
    };
  }

  // La quantité à hedger = la moitié de l'excès × levier
  // (on vise à revenir sous le seuil, pas forcément à zéro)
  const excess   = absD - CONFIG.deltaThreshold;
  const quantity = Math.min(excess, CONFIG.orderSizeBase) * CONFIG.leverage;

  if (delta > 0) {
    return {
      action:   'sell',
      quantity,
      reason:   `Delta long ${delta.toFixed(4)} → SELL ${quantity.toFixed(4)} pour neutraliser`,
    };
  }

  return {
    action:   'buy',
    quantity,
    reason:   `Delta short ${delta.toFixed(4)} → BUY ${quantity.toFixed(4)} pour neutraliser`,
  };
}

// ── Construction de l'ordre ───────────────────────────────────
function buildMarketOrderTx(
  ctx: AppContext,
  poolId: string,
  decision: HedgeDecision
): Transaction {
  const tx = new Transaction();

  ctx.db.placeLimitOrder(
    {
      poolKey:            poolId,
      balanceManagerKey:  'MANAGER',
      clientOrderId:      Date.now(),
      price:              0,                 // 0 = exécution au marché
      quantity:           BigInt(Math.round(decision.quantity * 1e9)),
      isBid:              decision.action === 'buy',
      expiration:         BigInt(0),
      orderType:          0,                 // MARKET
      selfMatchingOption: 0,
      payWithDeep:        true,
    },
    tx
  );

  return tx;
}

// ── Hedge d'un pool ───────────────────────────────────────────
export async function hedgePosition(poolId: string, ctx: AppContext): Promise<void> {
  const start = Date.now();

  try {
    // 1. Delta précis (avec cache)
    const deltaEntry = await getCachedDelta(poolId, ctx);
    const decision   = decideHedging(deltaEntry.delta, poolId);

    logger.info('Analyse hedging', {
      pool:     poolId.slice(0, 8),
      delta:    deltaEntry.delta.toFixed(4),
      priced:   `${deltaEntry.pricedDelta.toFixed(2)} USD`,
      midPrice: deltaEntry.midPrice.toFixed(4),
      decision: decision.action,
      reason:   decision.reason,
    });

    if (decision.action === 'none') {
      metrics.setCycleTimestamp(poolId);
      return;
    }

    // 2. Construction de la transaction
    const tx = buildMarketOrderTx(ctx, poolId, decision);

    // 3. Envoi avec dryRun automatique dans executeSafe
    await executeSafe(tx);

    // 4. Succès : mise à jour des métriques et alertes
    const durationMs = Date.now() - start;
    metrics.recordOrder(poolId, decision.action);
    metrics.setTxDuration(poolId, durationMs);
    metrics.setCycleTimestamp(poolId);

    deltaCache.delete(poolId);  // invalider le cache
    errorStats.consecutiveFailures = 0;

    await alerts.hedgeExecuted(poolId, decision.action, decision.quantity, deltaEntry.delta);

  } catch (err) {
    const error = err instanceof HedgingError ? err : normalizeError(err);

    errorStats.count++;
    errorStats.lastError           = error;
    errorStats.consecutiveFailures++;

    metrics.recordError(poolId, error.code);
    metrics.setConsecutiveFailures(errorStats.consecutiveFailures);

    logger.error(error, { poolId });

    if (errorStats.consecutiveFailures >= MAX_CONSECUTIVE_ERRORS) {
      await alerts.tooManyErrors(
        errorStats.consecutiveFailures,
        error.message
      );
      logger.error(
        `Trop d'erreurs consécutives (${errorStats.consecutiveFailures}/${MAX_CONSECUTIVE_ERRORS}) → arrêt`
      );
      process.exit(1);
    }
  }
}

// ── Hedge de tous les pools ───────────────────────────────────
export async function hedgeAllPools(ctx: AppContext): Promise<void> {
  logger.info('Début cycle hedging multi-pools');

  const results = await Promise.allSettled(
    CONFIG.pools.map((p) => hedgePosition(p.id, ctx))
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.warn(`Pool ${CONFIG.pools[i]?.id.slice(0, 8) ?? '?'} a échoué`, {
        reason: (r.reason as Error)?.message,
      });
    }
  });
}

// ── Export stats ──────────────────────────────────────────────
export function getErrorStats(): Readonly<ErrorStats> {
  return errorStats;
}
