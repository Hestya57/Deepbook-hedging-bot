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

  // Slippage
  maxSlippagePct: Number(process.env.MAX_SLIPPAGE_PCT) || 1.0,

  // ── Gestion de la liquidation ────────────────────────────
  // Seuil d'avertissement : ratio de marge en % (ex: 30 = 30%)
  marginWarnPct:          Number(process.env.MARGIN_WARN_PCT)           || 30,
  // Seuil critique : circuit breaker s'active, plus de nouveau hedge
  marginCriticalPct:      Number(process.env.MARGIN_CRITICAL_PCT)       || 20,
  // Seuil d'urgence : fermeture forcée de toutes les positions
  marginEmergencyPct:     Number(process.env.MARGIN_EMERGENCY_PCT)      || 10,
  // Fréquence de vérification de la marge (ms)
  marginCheckIntervalMs:  Number(process.env.MARGIN_CHECK_INTERVAL_MS)  || 15_000,
  // Active la fermeture automatique en cas d'urgence
  emergencyCloseEnabled:  process.env.EMERGENCY_CLOSE_ENABLED !== 'false',
  // Active le circuit breaker (bloque les hedges si marge critique)
  circuitBreakerEnabled:  process.env.CIRCUIT_BREAKER_ENABLED !== 'false',
  // Ratio de marge minimum pour réarmer le circuit breaker
  circuitBreakerResetPct: Number(process.env.CIRCUIT_BREAKER_RESET_PCT) || 40,
};

if (CONFIG.pools.length === 0) {
  throw new Error('Aucun pool configuré. Ajoutez POOLS=0x... dans .env');
}
