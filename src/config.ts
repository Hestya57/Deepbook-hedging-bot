import * as dotenv from 'dotenv';
import type { HedgingConfig, PoolConfig } from './types.js';

dotenv.config();

/**
 * Parse la variable POOLS du .env.
 * Supporte deux formats :
 *   - ID direct : 0xabc123...  (64 hex chars après 0x)
 *   - Symbolique : SUI:0x2::sui::SUI|USDC:0xdba...::usdc::USDC
 *
 * On stocke la chaîne brute ici ; pools.ts s'occupe de la résolution.
 */
function parsePools(): PoolConfig[] {
  const raw = process.env.POOLS || '';
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((entry): PoolConfig => {
      // Format ID direct (0x suivi de 64 chars hex)
      if (/^0x[0-9a-fA-F]{64}$/.test(entry)) {
        return { id: entry, baseSymbol: 'UNK', quoteSymbol: 'UNK' };
      }

      // Format symbolique BASE_SYM:BASE_TYPE|QUOTE_SYM:QUOTE_TYPE
      // On utilise '|' pour séparer base et quote, puis le premier ':' pour séparer symbole et type
      const pipeIdx = entry.indexOf('|');
      if (pipeIdx !== -1) {
        const basePart  = entry.slice(0, pipeIdx);
        const quotePart = entry.slice(pipeIdx + 1);

        const baseColonIdx  = basePart.indexOf(':');
        const quoteColonIdx = quotePart.indexOf(':');

        const baseSymbol  = baseColonIdx  !== -1 ? basePart.slice(0, baseColonIdx)   : 'UNK';
        const quoteSymbol = quoteColonIdx !== -1 ? quotePart.slice(0, quoteColonIdx) : 'UNK';

        // On stocke la chaîne complète ; pools.ts l'interprétera
        return { id: entry, baseSymbol, quoteSymbol };
      }

      // Valeur non reconnue — on la stocke telle quelle, pools.ts la rejettera proprement
      return { id: entry, baseSymbol: 'UNK', quoteSymbol: 'UNK' };
    });
}

export const CONFIG: HedgingConfig = {
  pools: parsePools(),

  deltaThreshold:   Number(process.env.DELTA_THRESHOLD)     || 10,
  orderSizeBase:    Number(process.env.ORDER_SIZE_BASE)      || 5,
  leverage:         Number(process.env.LEVERAGE)             || 5,
  checkIntervalMs:  Number(process.env.CHECK_INTERVAL_MS)    || 30_000,
  wsReconnectDelayMs: Number(process.env.WS_RECONNECT_DELAY_MS) || 7_000,
  maxRetries:       Number(process.env.MAX_RETRIES)          || 3,
  retryDelayBaseMs: Number(process.env.RETRY_DELAY_BASE_MS)  || 1_500,
  cacheTtlMs:       Number(process.env.CACHE_TTL_MS)         || 30_000,
  indexerUrl:       process.env.INDEXER_URL || 'https://deepbook-indexer.mainnet.mystenlabs.com/graphql',
};

if (CONFIG.pools.length === 0) {
  throw new Error('Aucun pool configuré. Ajoutez POOLS=0x... dans .env');
}
