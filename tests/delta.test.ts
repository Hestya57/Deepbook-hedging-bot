import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  CONFIG: {
    deltaThreshold:  10,
    orderSizeBase:   5,
    leverage:        2,
    maxSlippagePct:  1.0,
    cacheTtlMs:      30_000,
    maxRetries:      3,
    retryDelayBaseMs: 1_500,
    indexerUrl:      'http://test',
    pools:           [],
    checkIntervalMs:  30_000,
    wsReconnectDelayMs: 7_000,
    keystorePath:    './keystore.enc',
    metricsPort:     9090,
    metricsEnabled:  false,
    alertTelegramToken:  '',
    alertTelegramChatId: '',
    alertDiscordWebhook: '',
    alertMinSeverity:    'warn',
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { checkSlippage } from '../src/core/delta.js';

describe('checkSlippage', () => {
  describe('ordre BID (achat)', () => {
    it('slippage acceptable si prix = mid', () => {
      const { acceptable, slippagePct } = checkSlippage(100, 100, true);
      expect(acceptable).toBe(true);
      expect(slippagePct).toBeCloseTo(0);
    });

    it('slippage acceptable si prix < mid (achat sous le marché)', () => {
      const { acceptable } = checkSlippage(99, 100, true);
      expect(acceptable).toBe(true); // -1% est acceptable
    });

    it('slippage inacceptable si prix >> mid (achat très au-dessus)', () => {
      // orderPrice = 102, midPrice = 100 → slippage = +2% > 1%
      const { acceptable, slippagePct } = checkSlippage(102, 100, true);
      expect(acceptable).toBe(false);
      expect(slippagePct).toBeCloseTo(2);
    });

    it('slippage exactement à la limite (1%) est accepté', () => {
      // orderPrice = 101, midPrice = 100 → slippage = 1%
      const { acceptable } = checkSlippage(101, 100, true);
      expect(acceptable).toBe(true);
    });
  });

  describe('ordre ASK (vente)', () => {
    it('slippage acceptable si prix = mid', () => {
      const { acceptable } = checkSlippage(100, 100, false);
      expect(acceptable).toBe(true);
    });

    it('slippage inacceptable si prix << mid (vente très en-dessous)', () => {
      // orderPrice = 98, midPrice = 100 → slippage = 2% > 1%
      const { acceptable, slippagePct } = checkSlippage(98, 100, false);
      expect(acceptable).toBe(false);
      expect(slippagePct).toBeCloseTo(2);
    });

    it('slippage acceptable si prix > mid (vente au-dessus du marché)', () => {
      const { acceptable } = checkSlippage(101, 100, false);
      expect(acceptable).toBe(true); // -1% est négatif → acceptable
    });
  });

  describe('cas limites', () => {
    it('retourne acceptable si midPrice = 0 (pas de marché)', () => {
      const { acceptable, slippagePct } = checkSlippage(100, 0, true);
      expect(acceptable).toBe(true);
      expect(slippagePct).toBe(0);
    });

    it('slippage = 0 si orderPrice = midPrice', () => {
      const { slippagePct } = checkSlippage(50, 50, true);
      expect(slippagePct).toBeCloseTo(0);
    });
  });
});

describe('Calcul du delta net (logique)', () => {
  it('delta net = position + ordres ouverts', () => {
    const rawDelta        = 20;
    const openOrdersDelta = -5;  // 5 unités en vente en attente
    const netDelta        = rawDelta + openOrdersDelta;
    expect(netDelta).toBe(15);
  });

  it('ordres bid augmentent le delta', () => {
    const rawDelta        = 10;
    const openBidQty      = 3;  // 3 unités en achat en attente
    const openOrdersDelta = +openBidQty;
    const netDelta        = rawDelta + openOrdersDelta;
    expect(netDelta).toBe(13);
  });

  it('ordres ask diminuent le delta', () => {
    const rawDelta        = 10;
    const openAskQty      = 4;  // 4 unités en vente en attente
    const openOrdersDelta = -openAskQty;
    const netDelta        = rawDelta + openOrdersDelta;
    expect(netDelta).toBe(6);
  });

  it('delta valorisé = delta net × mid price', () => {
    const netDelta   = 15;
    const midPrice   = 3.5;
    const pricedDelta = netDelta * midPrice;
    expect(pricedDelta).toBeCloseTo(52.5);
  });

  it('delta valorisé = 0 si mid price = 0', () => {
    const netDelta    = 15;
    const midPrice    = 0;
    const pricedDelta = netDelta * midPrice;
    expect(pricedDelta).toBe(0);
  });
});
