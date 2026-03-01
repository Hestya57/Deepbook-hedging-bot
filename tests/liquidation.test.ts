import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────
vi.mock('../src/config.js', () => ({
  CONFIG: {
    // Seuils de liquidation
    marginWarnPct:          30,
    marginCriticalPct:      20,
    marginEmergencyPct:     10,
    marginCheckIntervalMs:  15_000,
    emergencyCloseEnabled:  true,
    circuitBreakerEnabled:  true,
    circuitBreakerResetPct: 40,
    // Hedging
    deltaThreshold: 10, orderSizeBase: 5, leverage: 2,
    maxSlippagePct: 1.0, cacheTtlMs: 30_000, maxRetries: 3,
    retryDelayBaseMs: 1_500, indexerUrl: 'http://test', pools: [],
    checkIntervalMs: 30_000, wsReconnectDelayMs: 7_000,
    keystorePath: './keystore.enc', metricsPort: 9090,
    metricsEnabled: false,
    alertTelegramToken: '', alertTelegramChatId: '',
    alertDiscordWebhook: '', alertMinSeverity: 'warn',
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/metrics.js', () => ({
  metrics: {
    setGauge:    vi.fn(),
    incCounter:  vi.fn(),
    setDelta:    vi.fn(),
  },
}));

vi.mock('../src/utils/alerts.js', () => ({
  alerts: {
    circuitBreakerOpen:  vi.fn().mockResolvedValue(undefined),
    circuitBreakerReset: vi.fn().mockResolvedValue(undefined),
    emergencyClose:      vi.fn().mockResolvedValue(undefined),
    emergencyManual:     vi.fn().mockResolvedValue(undefined),
    marginWarning:       vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../src/utils/sui.js', () => ({
  executeSafe:    vi.fn().mockResolvedValue({ digest: '0xtest' }),
  normalizeError: vi.fn((e: unknown) => e),
}));

import {
  classifyRisk,
  isCircuitBreakerOpen,
  getCircuitBreakerState,
  resetCircuitBreakerManually,
  evaluateAndActOnMargin,
  forceCloseAllPositions,
} from '../src/core/liquidation.js';
import type { MarginState, AppContext } from '../src/types.js';

const POOL_ID = '0x' + 'a'.repeat(64);

// ── Helper pour créer un MarginState ─────────────────────────
function makeMarginState(overrides: Partial<MarginState> = {}): MarginState {
  return {
    poolId:           POOL_ID,
    collateralUsd:    1000,
    positionValueUsd: 2000,
    marginRatio:      0.5,
    liquidationRatio: 0.4,
    risk:             'SAFE',
    timestamp:        Date.now(),
    ...overrides,
  };
}

// ── Contexte mock ─────────────────────────────────────────────
const mockCtx: AppContext = {
  address: '0x' + 'b'.repeat(64),
  db: {
    getOpenOrders:    vi.fn().mockResolvedValue([]),
    cancelOrder:      vi.fn(),
    getBalanceManager: vi.fn().mockResolvedValue({ balance: BigInt(1000e9) }),
  } as unknown as AppContext['db'],
  client: {} as AppContext['client'],
};

beforeEach(() => {
  // Réarmer le circuit breaker avant chaque test
  resetCircuitBreakerManually(POOL_ID);
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
describe('classifyRisk', () => {
  it('retourne SAFE quand marge >= marginWarnPct (30%)', () => {
    expect(classifyRisk(100)).toBe('SAFE');
    expect(classifyRisk(50)).toBe('SAFE');
    expect(classifyRisk(30)).toBe('SAFE');
  });

  it('retourne WARN quand marge entre 20% et 30% (exclusif)', () => {
    expect(classifyRisk(29)).toBe('WARN');
    expect(classifyRisk(25)).toBe('WARN');
    expect(classifyRisk(20)).toBe('WARN');
  });

  it('retourne CRITICAL quand marge entre 10% et 20% (exclusif)', () => {
    expect(classifyRisk(19)).toBe('CRITICAL');
    expect(classifyRisk(15)).toBe('CRITICAL');
    expect(classifyRisk(10)).toBe('CRITICAL');
  });

  it('retourne EMERGENCY quand marge sous 10%', () => {
    expect(classifyRisk(9)).toBe('EMERGENCY');
    expect(classifyRisk(5)).toBe('EMERGENCY');
    expect(classifyRisk(0)).toBe('EMERGENCY');
    expect(classifyRisk(-5)).toBe('EMERGENCY');
  });

  it('retourne SAFE si marge infinie (aucune position ouverte)', () => {
    expect(classifyRisk(Infinity)).toBe('SAFE');
  });
});

// ─────────────────────────────────────────────────────────────
describe('Circuit breaker', () => {
  it('est fermé (safe) par défaut', () => {
    expect(isCircuitBreakerOpen(POOL_ID)).toBe(false);
  });

  it('s\'ouvre sur état CRITICAL', async () => {
    const state = makeMarginState({ risk: 'CRITICAL', marginRatio: 0.15 });
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    expect(isCircuitBreakerOpen(POOL_ID)).toBe(true);
  });

  it('s\'ouvre sur état EMERGENCY', async () => {
    const state = makeMarginState({ risk: 'EMERGENCY', marginRatio: 0.08 });
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    expect(isCircuitBreakerOpen(POOL_ID)).toBe(true);
  });

  it('ne s\'ouvre pas sur état WARN', async () => {
    const state = makeMarginState({ risk: 'WARN', marginRatio: 0.25 });
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    expect(isCircuitBreakerOpen(POOL_ID)).toBe(false);
  });

  it('incrémente blockedCycles à chaque appel bloqué', async () => {
    const state = makeMarginState({ risk: 'CRITICAL', marginRatio: 0.15 });
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    expect(getCircuitBreakerState(POOL_ID).blockedCycles).toBe(3);
  });

  it('ne s\'ouvre pas deux fois (idempotent)', async () => {
    const state = makeMarginState({ risk: 'CRITICAL', marginRatio: 0.15 });
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    // L'alerte d'ouverture n'est envoyée qu'une fois
    const { alerts } = await import('../src/utils/alerts.js');
    const cbOpen = (alerts as Record<string, ReturnType<typeof vi.fn>>)['circuitBreakerOpen'];
    expect(cbOpen).toHaveBeenCalledTimes(1);
  });

  describe('Réarmement automatique', () => {
    it('se réarme quand marge remonte au-dessus de circuitBreakerResetPct (40%)', async () => {
      // 1. Ouvrir le CB
      await evaluateAndActOnMargin(
        POOL_ID,
        makeMarginState({ risk: 'CRITICAL', marginRatio: 0.15 }),
        mockCtx
      );
      expect(isCircuitBreakerOpen(POOL_ID)).toBe(true);

      // 2. Marge remonte à 45% → au-dessus du seuil de reset (40%)
      await evaluateAndActOnMargin(
        POOL_ID,
        makeMarginState({ risk: 'SAFE', marginRatio: 0.45 }),
        mockCtx
      );
      expect(isCircuitBreakerOpen(POOL_ID)).toBe(false);
    });

    it('ne se réarme pas si marge est entre criticalPct et resetPct', async () => {
      // Ouvrir le CB
      await evaluateAndActOnMargin(
        POOL_ID,
        makeMarginState({ risk: 'CRITICAL', marginRatio: 0.15 }),
        mockCtx
      );

      // Marge = 35% : au-dessus de SAFE (30%) mais sous resetPct (40%)
      await evaluateAndActOnMargin(
        POOL_ID,
        makeMarginState({ risk: 'SAFE', marginRatio: 0.35 }),
        mockCtx
      );
      // Le CB reste ouvert (hysteresis)
      expect(isCircuitBreakerOpen(POOL_ID)).toBe(true);
    });

    it('resetCircuitBreakerManually ferme le CB', () => {
      // Simuler un CB ouvert
      const state = getCircuitBreakerState(POOL_ID) as { open: boolean };
      state.open = true;
      expect(isCircuitBreakerOpen(POOL_ID)).toBe(true);

      resetCircuitBreakerManually(POOL_ID);
      expect(isCircuitBreakerOpen(POOL_ID)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────
describe('forceCloseAllPositions', () => {
  it('retourne success=true et quantityClosed=0 si aucun ordre ouvert', async () => {
    (mockCtx.db.getOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const result = await forceCloseAllPositions(POOL_ID, mockCtx);
    expect(result.success).toBe(true);
    expect(result.quantityClosed).toBe(0);
  });

  it('annule les ordres ouverts et retourne la quantité totale', async () => {
    const mockOrders = [
      { order_id: '1', is_bid: true,  price: BigInt(3e9), original_quantity: BigInt(10e9), filled_quantity: BigInt(0) },
      { order_id: '2', is_bid: false, price: BigInt(3e9), original_quantity: BigInt(5e9),  filled_quantity: BigInt(2e9) },
    ];
    (mockCtx.db.getOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockOrders);

    const result = await forceCloseAllPositions(POOL_ID, mockCtx);

    expect(result.success).toBe(true);
    // 10 unités (ordre 1 entier) + 3 unités (5 - 2, ordre 2 partiellement rempli)
    expect(result.quantityClosed).toBeCloseTo(13, 1);
  });

  it('retourne success=false si executeSafe lève une erreur', async () => {
    const mockOrders = [
      { order_id: '1', is_bid: true, price: BigInt(3e9), original_quantity: BigInt(10e9), filled_quantity: BigInt(0) },
    ];
    (mockCtx.db.getOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockOrders);

    const { executeSafe } = await import('../src/utils/sui.js');
    (executeSafe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

    const result = await forceCloseAllPositions(POOL_ID, mockCtx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });
});

// ─────────────────────────────────────────────────────────────
describe('evaluateAndActOnMargin — alertes', () => {
  it('envoie une alerte marginWarning sur WARN', async () => {
    const state = makeMarginState({ risk: 'WARN', marginRatio: 0.25 });
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    const { alerts } = await import('../src/utils/alerts.js');
    const warn = (alerts as Record<string, ReturnType<typeof vi.fn>>)['marginWarning'];
    expect(warn).toHaveBeenCalledWith(POOL_ID, 25, 30);
  });

  it('envoie une alerte circuitBreakerOpen sur CRITICAL', async () => {
    const state = makeMarginState({ risk: 'CRITICAL', marginRatio: 0.15 });
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    const { alerts } = await import('../src/utils/alerts.js');
    const cbOpen = (alerts as Record<string, ReturnType<typeof vi.fn>>)['circuitBreakerOpen'];
    expect(cbOpen).toHaveBeenCalled();
  });

  it('envoie une alerte emergencyClose sur EMERGENCY si enabled', async () => {
    const state = makeMarginState({ risk: 'EMERGENCY', marginRatio: 0.05 });
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    const { alerts } = await import('../src/utils/alerts.js');
    const eClose = (alerts as Record<string, ReturnType<typeof vi.fn>>)['emergencyClose'];
    expect(eClose).toHaveBeenCalled();
  });

  it('ne déclanche pas de fermeture sur SAFE', async () => {
    const state = makeMarginState({ risk: 'SAFE', marginRatio: 0.80 });
    await evaluateAndActOnMargin(POOL_ID, state, mockCtx);
    const { alerts } = await import('../src/utils/alerts.js');
    const eClose = (alerts as Record<string, ReturnType<typeof vi.fn>>)['emergencyClose'];
    expect(eClose).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('Scénarios bout-en-bout', () => {
  it('scénario dégradation progressive : SAFE → WARN → CRITICAL → EMERGENCY → SAFE', async () => {
    // SAFE
    await evaluateAndActOnMargin(POOL_ID, makeMarginState({ risk: 'SAFE', marginRatio: 0.60 }), mockCtx);
    expect(isCircuitBreakerOpen(POOL_ID)).toBe(false);

    // WARN
    await evaluateAndActOnMargin(POOL_ID, makeMarginState({ risk: 'WARN', marginRatio: 0.25 }), mockCtx);
    expect(isCircuitBreakerOpen(POOL_ID)).toBe(false);

    // CRITICAL → CB s'ouvre
    await evaluateAndActOnMargin(POOL_ID, makeMarginState({ risk: 'CRITICAL', marginRatio: 0.15 }), mockCtx);
    expect(isCircuitBreakerOpen(POOL_ID)).toBe(true);

    // EMERGENCY → fermeture forcée déclenchée
    await evaluateAndActOnMargin(POOL_ID, makeMarginState({ risk: 'EMERGENCY', marginRatio: 0.08 }), mockCtx);
    expect(isCircuitBreakerOpen(POOL_ID)).toBe(true);

    // Récupération : marge remonte à 50% → CB réarmé
    await evaluateAndActOnMargin(POOL_ID, makeMarginState({ risk: 'SAFE', marginRatio: 0.50 }), mockCtx);
    expect(isCircuitBreakerOpen(POOL_ID)).toBe(false);
  });
});
