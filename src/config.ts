import * as dotenv from 'dotenv';
import type { HedgingConfig, PoolConfig, AlertSeverity } from './types.js';

dotenv.config();

// ── Parsing des pools depuis .env ──────────────────────────────
function parsePools(): PoolConfig[] {
  const raw = process.env.POOLS ?? '';
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((entry): PoolConfig => {
      if (/^0x[0-9a-fA-F]{64}$/.test(entry)) {
        return { id: entry, baseSymbol: 'UNK', quoteSymbol: 'UNK' };
      }
      const pipeIdx = entry.indexOf('|');
      if (pipeIdx !== -1) {
        const basePart  = entry.slice(0, pipeIdx);
        const quotePart = entry.slice(pipeIdx + 1);
        const baseColonIdx  = basePart.indexOf(':');
        const quoteColonIdx = quotePart.indexOf(':');
        const baseSymbol  = baseColonIdx  !== -1 ? basePart.slice(0, baseColonIdx)   : 'UNK';
        const quoteSymbol = quoteColonIdx !== -1 ? quotePart.slice(0, quoteColonIdx) : 'UNK';
        return { id: entry, baseSymbol, quoteSymbol };
      }
      return { id: entry, baseSymbol: 'UNK', quoteSymbol: 'UNK' };
    });
}

function parseSeverity(val: string | undefined): AlertSeverity {
  if (val === 'info' || val === 'warn' || val === 'critical') return val;
  return 'warn';
}

export const CONFIG: HedgingConfig = {
  pools: parsePools(),

  // Hedging
  deltaThreshold:     Number(process.env.DELTA_THRESHOLD)      || 10,
  orderSizeBase:      Number(process.env.ORDER_SIZE_BASE)       || 5,
  leverage:           Number(process.env.LEVERAGE)              || 5,
  maxSlippagePct:     Number(process.env.MAX_SLIPPAGE_PCT)      || 1.0,

  // Fréquences
  checkIntervalMs:    Number(process.env.CHECK_INTERVAL_MS)     || 30_000,
  wsReconnectDelayMs: Number(process.env.WS_RECONNECT_DELAY_MS) || 7_000,
  maxRetries:         Number(process.env.MAX_RETRIES)           || 3,
  retryDelayBaseMs:   Number(process.env.RETRY_DELAY_BASE_MS)   || 1_500,
  cacheTtlMs:         Number(process.env.CACHE_TTL_MS)          || 30_000,

  // Indexer
  indexerUrl: process.env.INDEXER_URL
    || 'https://deepbook-indexer.mainnet.mystenlabs.com/graphql',

  // Sécurité clés
  keystorePath: process.env.KEYSTORE_PATH || './keystore.enc',

  // Métriques Prometheus
  metricsPort:    Number(process.env.METRICS_PORT)   || 9090,
  metricsEnabled: process.env.METRICS_ENABLED !== 'false',

  // Alertes
  alertTelegramToken:  process.env.ALERT_TELEGRAM_TOKEN  ?? '',
  alertTelegramChatId: process.env.ALERT_TELEGRAM_CHAT_ID ?? '',
  alertDiscordWebhook: process.env.ALERT_DISCORD_WEBHOOK  ?? '',
  alertMinSeverity:    parseSeverity(process.env.ALERT_MIN_SEVERITY),
};

if (CONFIG.pools.length === 0) {
  throw new Error('Aucun pool configuré. Ajoutez POOLS=0x... dans .env');
}
