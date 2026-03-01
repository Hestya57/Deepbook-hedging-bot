import { CONFIG }          from '../config.js';
import { db }              from './sui.js';
import { logger }          from './logger.js';
import type { LoadedPool, PoolMap } from '../types.js';

const poolsCache: PoolMap  = new Map();
const CACHE_DURATION_MS    = 24 * 60 * 60 * 1000; // 24 h

// Paires par défaut si aucun pool n'est configuré dans .env
const DEFAULT_PAIRS = [
  {
    base:    '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    quote:   '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    baseSymbol:  'SUI',
    quoteSymbol: 'USDC',
  },
  {
    base:    '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
    quote:   '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    baseSymbol:  'DEEP',
    quoteSymbol: 'SUI',
  },
];

/**
 * Résout un Pool ID à partir des types Move base/quote via le SDK DeepBook.
 */
async function resolvePoolId(baseType: string, quoteType: string): Promise<string | null> {
  try {
    const poolId = await db.getPoolIdByAssets(baseType, quoteType);
    if (poolId) {
      logger.info('Pool ID résolu via SDK', { base: baseType.split('::')[2], quote: quoteType.split('::')[2], poolId });
      return poolId;
    }
  } catch (err) {
    logger.warn('Échec resolvePoolId via SDK', {
      base: baseType,
      quote: quoteType,
      error: (err as Error).message,
    });
  }
  return null;
}

/**
 * Parse une entrée de type "SYM:0x2::mod::TYPE" en [symbol, fullType].
 * Cherche le premier ':' mais ignore les '::' des types Move.
 */
function parseSymbolEntry(part: string): [string, string] {
  const colonIdx = part.indexOf(':');
  if (colonIdx === -1) return ['UNK', part];
  const symbol   = part.slice(0, colonIdx);
  const moveType = part.slice(colonIdx + 1); // garde "0x2::sui::SUI" complet
  return [symbol, moveType];
}

/**
 * Charge les pools DeepBook et retourne une Map id → LoadedPool.
 * Ordre de priorité :
 *   1. IDs directs dans .env
 *   2. Format symbolique dans .env  →  résolution via SDK
 *   3. Paires par défaut            →  résolution via SDK
 */
export async function loadDeepBookPools(forceRefresh = false): Promise<PoolMap> {
  // Retourner le cache si encore valide
  if (!forceRefresh && poolsCache.size > 0) {
    const now   = Date.now();
    const fresh = Array.from(poolsCache.values()).every(
      (p) => now - p.loadedAt < CACHE_DURATION_MS
    );
    if (fresh) {
      logger.info(`Pools depuis cache (${poolsCache.size} pools)`);
      return poolsCache;
    }
  }

  logger.info('Chargement des pools DeepBook...');
  const loadedPools: LoadedPool[] = [];

  for (const cfg of CONFIG.pools) {
    // ── Format ID direct ──────────────────────────────────────
    if (/^0x[0-9a-fA-F]{64}$/.test(cfg.id)) {
      loadedPools.push({
        id:          cfg.id,
        baseType:    'unknown',
        quoteType:   'unknown',
        baseSymbol:  cfg.baseSymbol,
        quoteSymbol: cfg.quoteSymbol,
        loadedAt:    Date.now(),
      });
      continue;
    }

    // ── Format symbolique  BASE_SYM:BASE_TYPE|QUOTE_SYM:QUOTE_TYPE ──
    const pipeIdx = cfg.id.indexOf('|');
    if (pipeIdx === -1) {
      logger.warn(`Entrée POOLS non reconnue, ignorée : ${cfg.id}`);
      continue;
    }

    const basePart  = cfg.id.slice(0, pipeIdx);
    const quotePart = cfg.id.slice(pipeIdx + 1);

    const [baseSymbol,  baseType]  = parseSymbolEntry(basePart);
    const [quoteSymbol, quoteType] = parseSymbolEntry(quotePart);

    const poolId = await resolvePoolId(baseType, quoteType);
    if (!poolId) {
      logger.warn(`Impossible de résoudre le pool ${baseSymbol}/${quoteSymbol}`);
      continue;
    }

    loadedPools.push({
      id: poolId,
      baseType,
      quoteType,
      baseSymbol,
      quoteSymbol,
      loadedAt: Date.now(),
    });
  }

  // ── Fallback sur paires par défaut ────────────────────────
  if (loadedPools.length === 0) {
    logger.warn('Aucun pool résolu depuis .env → utilisation des paires par défaut');
    for (const pair of DEFAULT_PAIRS) {
      const poolId = await resolvePoolId(pair.base, pair.quote);
      if (poolId) {
        loadedPools.push({
          id:          poolId,
          baseType:    pair.base,
          quoteType:   pair.quote,
          baseSymbol:  pair.baseSymbol,
          quoteSymbol: pair.quoteSymbol,
          loadedAt:    Date.now(),
        });
      }
    }
  }

  if (loadedPools.length === 0) {
    throw new Error('Aucun pool DeepBook disponible. Vérifiez votre configuration .env.');
  }

  poolsCache.clear();
  loadedPools.forEach((p) => poolsCache.set(p.id, p));
  logger.info('Pools chargés', { count: loadedPools.length });
  return poolsCache;
}
