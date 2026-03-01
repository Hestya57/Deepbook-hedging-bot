import { Transaction } from '@mysten/sui/transactions';

import { CONFIG }                           from '../config.js';
import { HedgingError }                     from '../types.js';
import type { AppContext, ErrorStats, HedgeDecision, DeltaCache } from '../types.js';
import { executeSafe, normalizeError }      from '../utils/sui.js';
import { logger }                           from '../utils/logger.js';

// ─── État interne du module ───────────────────────────────────
const deltaCache  = new Map<string, DeltaCache>();
const errorStats: ErrorStats = { count: 0, lastError: null, consecutiveFailures: 0 };
const MAX_CONSECUTIVE_ERRORS = 5;

// ─── Récupération de la position nette via l'indexer ─────────
async function getPositionFromIndexer(poolId: string, address: string): Promise<number> {
  const query = `
    query {
      position(poolId: "${poolId}", owner: "${address}") {
        base_quantity
        quote_quantity
      }
    }
  `;

  const response = await fetch(CONFIG.indexerUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new HedgingError(
      `Indexer HTTP ${response.status}`,
      'NETWORK',
      true
    );
  }

  const json = await response.json() as {
    data?: { position?: { base_quantity?: string; quote_quantity?: string } };
    errors?: unknown[];
  };

  if (json.errors?.length) {
    throw new HedgingError('Erreur GraphQL indexer', 'INDEXER', true, json.errors);
  }

  // Delta = quantité base nette (positif → long, négatif → short)
  const baseQty = Number(json.data?.position?.base_quantity ?? 0);
  return baseQty;
}

// ─── Cache delta ──────────────────────────────────────────────
export async function getCachedDelta(poolId: string, ctx: AppContext): Promise<number> {
  const cached = deltaCache.get(poolId);
  if (cached && Date.now() - cached.timestamp < CONFIG.cacheTtlMs) {
    logger.info(`Cache hit delta ${poolId.slice(0, 8)}...`, { delta: cached.delta });
    return cached.delta;
  }

  try {
    const delta = await getPositionFromIndexer(poolId, ctx.address);
    deltaCache.set(poolId, { delta, timestamp: Date.now(), poolId });
    return delta;
  } catch (err) {
    logger.warn('Indexer indisponible → SDK fallback', { poolId });
    try {
      // Fallback SDK : getLevel2 pour estimer la position ouverte
      const book = await ctx.db.getLevel2Order(poolId, BigInt(1), BigInt(1), true);
      // En l'absence d'un endpoint de position directe dans le SDK public,
      // on retourne 0 (aucune position connue) — à adapter selon votre usage.
      const delta = book ? 0 : 0;
      deltaCache.set(poolId, { delta, timestamp: Date.now(), poolId });
      return delta;
    } catch (sdkErr) {
      throw new HedgingError(
        'Impossible de récupérer la position (indexer + SDK)',
        'POSITION_FETCH',
        false,
        { poolId, original: (err as Error).message }
      );
    }
  }
}

// ─── Décision de hedging ──────────────────────────────────────
export function decideHedging(delta: number, poolId: string): HedgeDecision {
  const absD = Math.abs(delta);

  if (absD < CONFIG.deltaThreshold) {
    return { action: 'none', quantity: 0, reason: `Delta ${delta.toFixed(2)} sous le seuil ${CONFIG.deltaThreshold}` };
  }

  const quantity = CONFIG.orderSizeBase * CONFIG.leverage;

  if (delta > 0) {
    return {
      action:   'sell',
      quantity,
      reason:   `Delta long ${delta.toFixed(2)} → vente de ${quantity} pour neutraliser`,
    };
  }

  return {
    action:   'buy',
    quantity,
    reason:   `Delta short ${delta.toFixed(2)} → achat de ${quantity} pour neutraliser`,
  };
}

// ─── Construction de l'ordre de marché DeepBook ──────────────
function buildMarketOrderTx(
  ctx: AppContext,
  poolId: string,
  decision: HedgeDecision
): Transaction {
  const tx = new Transaction();

  // Appel à la fonction place_market_order du contrat DeepBook
  // La signature exacte dépend de la version du contrat déployé.
  // Adaptez pool_key, base_coin, quote_coin selon votre contexte.
  if (decision.action === 'buy') {
    ctx.db.placeLimitOrder(
      {
        poolKey:       poolId,
        balanceManagerKey: 'MANAGER',
        clientOrderId: Date.now(),
        price:         0,            // 0 = market order
        quantity:      BigInt(Math.round(decision.quantity * 1e9)),
        isBid:         true,
        expiration:    BigInt(0),
        orderType:     0,           // MARKET
        selfMatchingOption: 0,
        payWithDeep:   true,
      },
      tx
    );
  } else {
    ctx.db.placeLimitOrder(
      {
        poolKey:       poolId,
        balanceManagerKey: 'MANAGER',
        clientOrderId: Date.now(),
        price:         0,
        quantity:      BigInt(Math.round(decision.quantity * 1e9)),
        isBid:         false,
        expiration:    BigInt(0),
        orderType:     0,
        selfMatchingOption: 0,
        payWithDeep:   true,
      },
      tx
    );
  }

  return tx;
}

// ─── Hedge d'un pool ──────────────────────────────────────────
export async function hedgePosition(poolId: string, ctx: AppContext): Promise<void> {
  try {
    const delta    = await getCachedDelta(poolId, ctx);
    const decision = decideHedging(delta, poolId);

    logger.info('Analyse hedging', {
      pool:     poolId.slice(0, 8),
      delta:    delta.toFixed(2),
      decision: decision.action,
      reason:   decision.reason,
    });

    if (decision.action === 'none') return;

    const tx = buildMarketOrderTx(ctx, poolId, decision);
    await executeSafe(tx);

    // Invalider le cache après un ordre exécuté
    deltaCache.delete(poolId);
    errorStats.consecutiveFailures = 0;

  } catch (err) {
    const error = err instanceof HedgingError ? err : normalizeError(err);

    errorStats.count++;
    errorStats.lastError         = error;
    errorStats.consecutiveFailures++;

    logger.error(error, { poolId });

    if (errorStats.consecutiveFailures >= MAX_CONSECUTIVE_ERRORS) {
      logger.error(
        `Trop d'erreurs consécutives (${errorStats.consecutiveFailures}/${MAX_CONSECUTIVE_ERRORS}) → arrêt`
      );
      process.exit(1);
    }

    if (!error.retryable) {
      logger.warn(`Erreur non-retriable sur le pool ${poolId.slice(0, 8)}, pool ignoré ce cycle.`);
    }
  }
}

// ─── Hedge de tous les pools ──────────────────────────────────
export async function hedgeAllPools(ctx: AppContext): Promise<void> {
  logger.info('Début cycle hedging multi-pools');

  const results = await Promise.allSettled(
    CONFIG.pools.map((p) => hedgePosition(p.id, ctx))
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.warn(`Pool ${CONFIG.pools[i]?.id.slice(0, 8) ?? '?'}... a échoué`, {
        reason: (r.reason as Error)?.message,
      });
    }
  });
}

// ─── Export stats pour monitoring ────────────────────────────
export function getErrorStats(): Readonly<ErrorStats> {
  return errorStats;
}
