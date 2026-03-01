import { describe, it, expect, beforeEach } from 'vitest';
import { decideHedging } from '../src/core/hedging.js';

// On mocke la config pour contrôler les seuils
import { vi } from 'vitest';
vi.mock('../src/config.js', () => ({
  CONFIG: {
    deltaThreshold: 10,
    orderSizeBase:  5,
    leverage:       2,
    maxSlippagePct: 1.0,
    cacheTtlMs:     30_000,
    maxRetries:     3,
    retryDelayBaseMs: 1_500,
    indexerUrl:     'http://test',
    pools:          [],
    checkIntervalMs:  30_000,
    wsReconnectDelayMs: 7_000,
    keystorePath:   './keystore.enc',
    metricsPort:    9090,
    metricsEnabled: false,
    alertTelegramToken:  '',
    alertTelegramChatId: '',
    alertDiscordWebhook: '',
    alertMinSeverity:    'warn',
  },
}));

const POOL_ID = '0x' + 'a'.repeat(64);

describe('decideHedging', () => {
  describe('action none — delta sous le seuil', () => {
    it('retourne none quand delta = 0', () => {
      const d = decideHedging(0, POOL_ID);
      expect(d.action).toBe('none');
      expect(d.quantity).toBe(0);
    });

    it('retourne none quand delta = 9.99 (juste sous le seuil)', () => {
      const d = decideHedging(9.99, POOL_ID);
      expect(d.action).toBe('none');
    });

    it('retourne none quand delta = -9.99', () => {
      const d = decideHedging(-9.99, POOL_ID);
      expect(d.action).toBe('none');
    });

    it('retourne none quand delta = exactement le seuil (non strict)', () => {
      // threshold = 10, delta = 10 : |10| < 10 est faux → doit déclencher
      const d = decideHedging(10, POOL_ID);
      expect(d.action).not.toBe('none');
    });
  });

  describe('action sell — delta positif (long)', () => {
    it('retourne sell quand delta = 20 (long)', () => {
      const d = decideHedging(20, POOL_ID);
      expect(d.action).toBe('sell');
    });

    it('quantité = min(excess, orderSizeBase) × leverage', () => {
      // delta = 15, threshold = 10, excess = 5
      // min(5, 5) × 2 = 10
      const d = decideHedging(15, POOL_ID);
      expect(d.action).toBe('sell');
      expect(d.quantity).toBe(10);
    });

    it('quantité plafonnée à orderSizeBase × leverage quand excès > orderSizeBase', () => {
      // delta = 100, threshold = 10, excess = 90
      // min(90, 5) × 2 = 10 (plafonné)
      const d = decideHedging(100, POOL_ID);
      expect(d.action).toBe('sell');
      expect(d.quantity).toBe(10);
    });

    it('contient une reason non vide', () => {
      const d = decideHedging(20, POOL_ID);
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.reason).toContain('long');
    });
  });

  describe('action buy — delta négatif (short)', () => {
    it('retourne buy quand delta = -20 (short)', () => {
      const d = decideHedging(-20, POOL_ID);
      expect(d.action).toBe('buy');
    });

    it('quantité correcte pour delta short', () => {
      // delta = -15, excess = 5, min(5,5) × 2 = 10
      const d = decideHedging(-15, POOL_ID);
      expect(d.action).toBe('buy');
      expect(d.quantity).toBe(10);
    });

    it('contient une reason mentionnant short', () => {
      const d = decideHedging(-20, POOL_ID);
      expect(d.reason).toContain('short');
    });
  });

  describe('symétrie', () => {
    it('buy et sell sont symétriques en quantité', () => {
      const dBuy  = decideHedging(-25, POOL_ID);
      const dSell = decideHedging(+25, POOL_ID);
      expect(dBuy.quantity).toBe(dSell.quantity);
    });
  });
});
