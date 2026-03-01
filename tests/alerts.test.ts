import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globalement
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../src/config.js', () => ({
  CONFIG: {
    alertTelegramToken:  'test-token',
    alertTelegramChatId: '123456',
    alertDiscordWebhook: 'https://discord.com/api/webhooks/test',
    alertMinSeverity:    'info',
    deltaThreshold: 10, orderSizeBase: 5, leverage: 2,
    maxSlippagePct: 1.0, cacheTtlMs: 30_000, maxRetries: 3,
    retryDelayBaseMs: 1_500, indexerUrl: 'http://test', pools: [],
    checkIntervalMs: 30_000, wsReconnectDelayMs: 7_000,
    keystorePath: './keystore.enc', metricsPort: 9090, metricsEnabled: false,
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sendAlert, alerts } from '../src/utils/alerts.js';

beforeEach(() => {
  mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sendAlert', () => {
  it('envoie à Telegram et Discord pour severity = critical', async () => {
    await sendAlert('critical', 'Test critique', 'Quelque chose a planté');
    // Telegram + Discord = 2 appels fetch
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('envoie au bon endpoint Telegram', async () => {
    await sendAlert('warn', 'Test', 'Message');
    const calls = mockFetch.mock.calls;
    const telegramCall = calls.find(([url]) =>
      String(url).includes('api.telegram.org')
    );
    expect(telegramCall).toBeDefined();
    expect(String(telegramCall![0])).toContain('test-token');
    expect(String(telegramCall![0])).toContain('sendMessage');
  });

  it('envoie au bon endpoint Discord', async () => {
    await sendAlert('warn', 'Test', 'Message');
    const calls = mockFetch.mock.calls;
    const discordCall = calls.find(([url]) =>
      String(url).includes('discord.com')
    );
    expect(discordCall).toBeDefined();
  });

  it('le body Telegram contient le titre et le message', async () => {
    await sendAlert('info', 'Mon Titre', 'Mon message détaillé');
    const calls = mockFetch.mock.calls;
    const tgCall = calls.find(([url]) => String(url).includes('telegram'));
    const body   = JSON.parse(tgCall![1].body as string) as {
      text: string;
      chat_id: string;
    };
    expect(body.text).toContain('Mon Titre');
    expect(body.text).toContain('Mon message détaillé');
    expect(body.chat_id).toBe('123456');
  });

  it('gère gracieusement un échec fetch (ne plante pas le bot)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    await expect(sendAlert('warn', 'Test', 'Msg')).resolves.not.toThrow();
  });

  it('ne plante pas si Telegram retourne un statut non-ok', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, text: async () => 'Too Many Requests' });
    await expect(sendAlert('warn', 'Test', 'Msg')).resolves.not.toThrow();
  });
});

describe('alertes prédéfinies', () => {
  it('alerts.botStarted envoie une alerte info', async () => {
    await alerts.botStarted('0xabc123...', ['SUI/USDC', 'DEEP/SUI']);
    expect(mockFetch).toHaveBeenCalled();
    const tgCall = mockFetch.mock.calls.find(([url]) =>
      String(url).includes('telegram')
    );
    const body = JSON.parse(tgCall![1].body as string) as { text: string };
    expect(body.text).toContain('démarré');
  });

  it('alerts.tooManyErrors envoie une alerte critical', async () => {
    await alerts.tooManyErrors(5, 'Erreur réseau');
    const tgCall = mockFetch.mock.calls.find(([url]) =>
      String(url).includes('telegram')
    );
    const body = JSON.parse(tgCall![1].body as string) as { text: string };
    expect(body.text.toLowerCase()).toContain('critical');
  });

  it('alerts.lowWalletBalance inclut le solde dans le contexte', async () => {
    await alerts.lowWalletBalance(0.1);
    const tgCall = mockFetch.mock.calls.find(([url]) =>
      String(url).includes('telegram')
    );
    const body = JSON.parse(tgCall![1].body as string) as { text: string };
    expect(body.text).toContain('0.1');
  });
});
