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
  // Liquidation (inline pour garder un seul objet CONFIG)
  marginWarnPct: number;
  marginCriticalPct: number;
  marginEmergencyPct: number;
  marginCheckIntervalMs: number;
  emergencyCloseEnabled: boolean;
  circuitBreakerEnabled: boolean;
  circuitBreakerResetPct: number;
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

// ── Liquidation ───────────────────────────────────────────────

/**
 * États de risque de liquidation — machine à états à sens unique vers le haut
 * (on ne repasse pas de EMERGENCY à SAFE sans intervention manuelle).
 *
 * SAFE      : margin ratio au-dessus du seuil d'avertissement
 * WARN      : margin ratio entre warn_pct et critical_pct → alerte envoyée
 * CRITICAL  : margin ratio entre critical_pct et emergency_pct
 *             → circuit breaker activé, plus aucun nouveau hedge autorisé
 * EMERGENCY : margin ratio sous emergency_pct
 *             → fermeture forcée de toutes les positions
 */
export type LiquidationRisk = 'SAFE' | 'WARN' | 'CRITICAL' | 'EMERGENCY';

/** État de la marge pour un pool donné */
export interface MarginState {
  poolId: string;
  /** Valeur totale du collatéral en USD */
  collateralUsd: number;
  /** Valeur notionnelle de la position ouverte en USD */
  positionValueUsd: number;
  /** Ratio de marge = collateral / positionValue (1 = 100%) */
  marginRatio: number;
  /** Ratio de liquidation estimé fourni par le protocole (si disponible) */
  liquidationRatio: number;
  /** Niveau de risque calculé */
  risk: LiquidationRisk;
  /** Timestamp du calcul */
  timestamp: number;
}

/** Résultat d'une action de fermeture d'urgence */
export interface EmergencyCloseResult {
  poolId: string;
  success: boolean;
  digest?: string;
  quantityClosed: number;
  error?: string;
}

/** État du circuit breaker par pool */
export interface CircuitBreakerState {
  poolId: string;
  /** true = hedging bloqué pour ce pool */
  open: boolean;
  /** Raison de l'ouverture */
  reason: string;
  /** Timestamp d'ouverture */
  openedAt: number | null;
  /** Nombre de cycles bloqués depuis ouverture */
  blockedCycles: number;
}

/** Config liquidation (dans HedgingConfig) */
export interface LiquidationConfig {
  /** Ratio marge en % en-dessous duquel on émet un warning (ex: 30 = 30%) */
  marginWarnPct: number;
  /** Ratio marge en % → circuit breaker activé (ex: 20) */
  marginCriticalPct: number;
  /** Ratio marge en % → fermeture forcée (ex: 10) */
  marginEmergencyPct: number;
  /** Fréquence de vérification de la marge (ms) */
  marginCheckIntervalMs: number;
  /** Active la fermeture automatique d'urgence */
  emergencyCloseEnabled: boolean;
  /** Active le circuit breaker */
  circuitBreakerEnabled: boolean;
  /** Ratio de marge minimum pour réarmer le circuit breaker (ex: 40) */
  circuitBreakerResetPct: number;
}
