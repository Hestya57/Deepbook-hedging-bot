// ─────────────────────────────────────────────────────────────
// Types & interfaces du bot de hedging DeepBook
// ─────────────────────────────────────────────────────────────

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
}

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

export interface DeltaCache {
  delta: number;
  timestamp: number;
  poolId: string;
}

export interface AppContext {
  address: string;
  db: import('@mysten/deepbook-v3').DeepBookV3Client;
  client: import('@mysten/sui/client').SuiClient;
}

export interface ErrorStats {
  count: number;
  lastError: HedgingError | null;
  consecutiveFailures: number;
}

export type HedgeAction = 'buy' | 'sell' | 'none';

export interface HedgeDecision {
  action: HedgeAction;
  quantity: number;
  reason: string;
}
