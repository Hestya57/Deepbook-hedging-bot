// ─────────────────────────────────────────────────────────────
// Types & interfaces — DeepBook Hedging Bot v2
// ─────────────────────────────────────────────────────────────

// ── Erreurs ──────────────────────────────────────────────────
export class HedgingError extends Error {
  code: string;
  retryable: boolean;
  details?: unknown;

  constructor(message: string, code: string, retryable = false, details?: unknown) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.name = 'HedgingError';
  }
}

// ── Configuration ─────────────────────────────────────────────
export interface PoolConfig {
  id: string;
  baseSymbol: string;
  quoteSymbol: string;
}

export interface HedgingConfig {
  pools: PoolConfig[];
  deltaThreshold: number;
  orderSizeBase: number;
  leverage: number;
  checkIntervalMs: number;
  wsReconnectDelayMs: number;
  maxRetries: number;
  retryDelayBaseMs: number;
  cacheTtlMs: number;
  indexerUrl: string;
  // Sécurité clés
  keystorePath: string;
  // Métriques
  metricsPort: number;
  metricsEnabled: boolean;
  // Alertes
  alertTelegramToken: string;
  alertTelegramChatId: string;
  alertDiscordWebhook: string;
  alertMinSeverity: AlertSeverity;
  // Slippage
  maxSlippagePct: number;
}

// ── Pools ─────────────────────────────────────────────────────
export interface LoadedPool {
  id: string;
  baseType: string;
  quoteType: string;
  baseSymbol: string;
  quoteSymbol: string;
  tickSize?: number;
  lotSize?: number;
  loadedAt: number;
}

export type PoolMap = Map<string, LoadedPool>;

// ── Delta ─────────────────────────────────────────────────────
export interface DeltaCache {
  delta: number;
  rawDelta: number;        // delta brut (en unités de base)
  pricedDelta: number;     // delta valorisé en USD/USDC
  openOrdersDelta: number; // contribution des ordres ouverts
  midPrice: number;        // prix mid au moment du calcul
  timestamp: number;
  poolId: string;
}

export interface OpenOrder {
  orderId: string;
  isBid: boolean;
  price: number;
  quantity: number;
  filledQuantity: number;
}

export interface PreciseDelta {
  rawDelta: number;
  openOrdersDelta: number;
  netDelta: number;
  pricedDelta: number;
  midPrice: number;
  openOrders: OpenOrder[];
}

// ── Hedging ───────────────────────────────────────────────────
export type HedgeAction = 'buy' | 'sell' | 'none';

export interface HedgeDecision {
  action: HedgeAction;
  quantity: number;
  reason: string;
}

export interface AppContext {
  address: string;
  db: import('@mysten/deepbook-v3').DeepBookV3Client;
  client: import('@mysten/sui/client').SuiClient;
}

// ── Stats & monitoring ────────────────────────────────────────
export interface ErrorStats {
  count: number;
  lastError: HedgingError | null;
  consecutiveFailures: number;
}

export interface TradeRecord {
  poolId: string;
  action: HedgeAction;
  quantity: number;
  delta: number;
  pricedDelta: number;
  digest: string;
  timestamp: number;
  dryRunPassed: boolean;
}

// ── Alertes ───────────────────────────────────────────────────
export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface Alert {
  severity: AlertSeverity;
  title: string;
  message: string;
  context?: Record<string, unknown>;
  timestamp: number;
}
