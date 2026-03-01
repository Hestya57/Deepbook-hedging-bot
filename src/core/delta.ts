/**
 * Calcul précis du delta
 *
 * Delta = position nette en base, valorisée en quote (USD/USDC).
 *
 * Le delta "brut" (position on-chain) est insuffisant : il faut y ajouter
 * la contribution des ordres OUVERTS qui ne sont pas encore exécutés,
 * car ils représentent un engagement futur qui modifie l'exposition réelle.
 *
 *   delta_net = delta_position + delta_open_orders
 *   delta_priced = delta_net × mid_price
 *
 * Les ordres bid (achat) en attente augmentent le delta (exposition long).
 * Les ordres ask (vente) en attente diminuent le delta (exposition short).
 */

import { CONFIG }   from '../config.js';
import { logger }   from '../utils/logger.js';
import type { AppContext, PreciseDelta, OpenOrder } from '../types.js';

// ── Récupération des ordres ouverts ───────────────────────────
async function fetchOpenOrders(poolId: string, ctx: AppContext): Promise<OpenOrder[]> {
  try {
    const rawOrders = await ctx.db.getOpenOrders(poolId, ctx.address);

    if (!rawOrders || !Array.isArray(rawOrders)) return [];

    return rawOrders.map((o: {
      order_id?: string | bigint;
      is_bid?: boolean;
      price?: bigint | string | number;
      original_quantity?: bigint | string | number;
      filled_quantity?: bigint | string | number;
    }): OpenOrder => ({
      orderId:        String(o.order_id ?? ''),
      isBid:          Boolean(o.is_bid),
      price:          Number(o.price ?? 0) / 1e9,
      quantity:       Number(o.original_quantity ?? 0) / 1e9,
      filledQuantity: Number(o.filled_quantity ?? 0) / 1e9,
    }));
  } catch (err) {
    logger.warn('Impossible de récupérer les ordres ouverts', {
      poolId,
      error: (err as Error).message,
    });
    return [];
  }
}

// ── Récupération du prix mid (best bid + best ask) / 2 ────────
async function fetchMidPrice(poolId: string, ctx: AppContext): Promise<number> {
  try {
    // getLevel2Order retourne les N meilleurs niveaux bid/ask
    const bids = await ctx.db.getLevel2Order(poolId, BigInt(1), BigInt(0), true);
    const asks = await ctx.db.getLevel2Order(poolId, BigInt(0), BigInt(1), true);

    const bestBid = bids?.inner_price_vec?.[0]
      ? Number(bids.inner_price_vec[0]) / 1e9
      : null;
    const bestAsk = asks?.inner_price_vec?.[0]
      ? Number(asks.inner_price_vec[0]) / 1e9
      : null;

    if (bestBid !== null && bestAsk !== null) {
      return (bestBid + bestAsk) / 2;
    }
    if (bestBid !== null) return bestBid;
    if (bestAsk !== null) return bestAsk;

    logger.warn('Impossible de calculer le mid price, retour à 0', { poolId });
    return 0;
  } catch (err) {
    logger.warn('Erreur fetchMidPrice', { poolId, error: (err as Error).message });
    return 0;
  }
}

// ── Récupération de la position nette via l'indexer ───────────
async function fetchPositionFromIndexer(
  poolId: string,
  address: string,
  indexerUrl: string
): Promise<number> {
  const query = `
    query {
      position(poolId: "${poolId}", owner: "${address}") {
        base_quantity
        quote_quantity
      }
    }
  `;

  const response = await fetch(indexerUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Indexer HTTP ${response.status}`);
  }

  const json = await response.json() as {
    data?: { position?: { base_quantity?: string } };
    errors?: unknown[];
  };

  if (json.errors?.length) {
    throw new Error('GraphQL errors from indexer');
  }

  return Number(json.data?.position?.base_quantity ?? 0) / 1e9;
}

// ── Calcul complet du delta ───────────────────────────────────
export async function computePreciseDelta(
  poolId: string,
  ctx: AppContext
): Promise<PreciseDelta> {
  logger.info(`Calcul delta précis pour pool ${poolId.slice(0, 8)}...`);

  // 1. Position nette on-chain (via indexer, fallback 0)
  let rawDelta = 0;
  try {
    rawDelta = await fetchPositionFromIndexer(poolId, ctx.address, CONFIG.indexerUrl);
  } catch (err) {
    logger.warn('Fallback delta → 0 (indexer indisponible)', {
      poolId,
      error: (err as Error).message,
    });
  }

  // 2. Ordres ouverts (contribution au delta futur)
  const openOrders = await fetchOpenOrders(poolId, ctx);

  // Contribution des ordres non exécutés :
  //   bid (achat) = exposition long supplémentaire → +
  //   ask (vente) = exposition short supplémentaire → -
  const openOrdersDelta = openOrders.reduce((acc, order) => {
    const remaining = order.quantity - order.filledQuantity;
    return acc + (order.isBid ? +remaining : -remaining);
  }, 0);

  // 3. Prix mid courant
  const midPrice = await fetchMidPrice(poolId, ctx);

  // 4. Delta net et valorisé
  const netDelta    = rawDelta + openOrdersDelta;
  const pricedDelta = netDelta * midPrice;

  logger.info('Delta calculé', {
    pool:             poolId.slice(0, 8),
    rawDelta:         rawDelta.toFixed(6),
    openOrdersDelta:  openOrdersDelta.toFixed(6),
    netDelta:         netDelta.toFixed(6),
    pricedDelta:      `${pricedDelta.toFixed(4)} USD`,
    midPrice:         midPrice.toFixed(4),
    openOrdersCount:  openOrders.length,
  });

  return { rawDelta, openOrdersDelta, netDelta, pricedDelta, midPrice, openOrders };
}

// ── Vérification du slippage ──────────────────────────────────
export function checkSlippage(
  orderPrice: number,
  midPrice: number,
  isBid: boolean
): { acceptable: boolean; slippagePct: number } {
  if (midPrice === 0) return { acceptable: true, slippagePct: 0 };

  const slippagePct = isBid
    ? ((orderPrice - midPrice) / midPrice) * 100
    : ((midPrice - orderPrice) / midPrice) * 100;

  const acceptable = slippagePct <= CONFIG.maxSlippagePct;

  if (!acceptable) {
    logger.warn('Slippage trop élevé', {
      orderPrice: orderPrice.toFixed(6),
      midPrice:   midPrice.toFixed(6),
      slippagePct: slippagePct.toFixed(2) + '%',
      maxAllowed:  CONFIG.maxSlippagePct + '%',
    });
  }

  return { acceptable, slippagePct };
}
