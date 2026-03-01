import { CONFIG }          from '../config.js';
import { db }              from './sui.js';
import { logger }          from './logger.js';
import type { LoadedPool, PoolMap } from '../types.js';

const poolsCache: PoolMap  = new Map();
const CACHE_DURATION_MS    = 24 * 60 * 60 * 1000; // 24 h

const DEFAULT_PAIRS = [
  {
    base:        '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    quote:       '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    baseSymbol:  'SUI',
    quoteSymbol: 'USDC',
  },
  {
    base:        '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
    quote:       '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    baseSymbol:  'DEEP',
    quoteSymbol: 'SUI',
  },
];

async function resolvePoolId(baseType: string, quoteType: string): Promise<string | null> {
  try {
    const poolId = await db.getPoolIdByAssets(baseType, quoteType);
    if (poolId) {
      logger.info('Pool ID résolu via SDK', {
        base:  baseType.split('::')[2],
        quote: quoteType.split('::')[2],
        poolId,
      });
      return poolId;
    }
  } catch (err) {
    logger.warn('Échec resolvePoolId', {
      base:  baseType,
      quote: quoteType,
      error: (err as Error).message,
    });
  }
  return null;
}

/** Parse "SYM:0x2::mod::TYPE" → [symbol, fullMoveType] */
function parseSymbolEntry(part: string): [string, string] {
  const colonIdx = part.indexOf(':');
  if (colonIdx === -1) return ['UNK', part];
  return [part.slice(0, colonIdx), part.slice(colonIdx + 1)];
}

export async function loadDeepBookPools(forceRefresh = false): Promise<PoolMap> {
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
    if (/^0x[0-9a-fA-F]{64}$/.test(cfg.id)) {
      loadedPools.push({
        id: cfg.id, baseType: 'unknown', quoteType: 'unknown',
        baseSymbol: cfg.baseSymbol, quoteSymbol: cfg.quoteSymbol,
        loadedAt: Date.now(),
      });
      continue;
    }

    const pipeIdx = cfg.id.indexOf('|');
    if (pipeIdx === -1) {
      logger.warn(`Entrée POOLS non reconnue, ignorée : ${cfg.id}`);
      continue;
    }

    const [baseSymbol,  baseType]  = parseSymbolEntry(cfg.id.slice(0, pipeIdx));
    const [quoteSymbol, quoteType] = parseSymbolEntry(cfg.id.slice(pipeIdx + 1));

    const poolId = await resolvePoolId(baseType, quoteType);
    if (!poolId) {
      logger.warn(`Impossible de résoudre ${baseSymbol}/${quoteSymbol}`);
      continue;
    }

    loadedPools.push({ id: poolId, baseType, quoteType, baseSymbol, quoteSymbol, loadedAt: Date.now() });
  }

  if (loadedPools.length === 0) {
    logger.warn('Aucun pool .env valide → paires par défaut');
    for (const pair of DEFAULT_PAIRS) {
      const poolId = await resolvePoolId(pair.base, pair.quote);
      if (poolId) {
        loadedPools.push({
          id: poolId, baseType: pair.base, quoteType: pair.quote,
          baseSymbol: pair.baseSymbol, quoteSymbol: pair.quoteSymbol,
          loadedAt: Date.now(),
        });
      }
    }
  }

  if (loadedPools.length === 0) {
    throw new Error('Aucun pool DeepBook disponible. Vérifiez .env');
  }

  poolsCache.clear();
  loadedPools.forEach((p) => poolsCache.set(p.id, p));
  logger.info('Pools chargés', { count: loadedPools.length });
  return poolsCache;
}
