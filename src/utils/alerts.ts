/**
 * Système d'alertes — Telegram & Discord
 *
 * Alertes envoyées automatiquement pour :
 *   - Trop d'erreurs consécutives (critical)
 *   - Solde wallet faible (warn)
 *   - Transaction réussie de hedging (info)
 *   - Démarrage / arrêt du bot (info)
 */

import { CONFIG }     from '../config.js';
import { logger }     from './logger.js';
import type { Alert, AlertSeverity } from '../types.js';

// ── Niveaux de sévérité ───────────────────────────────────────
const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  info:     0,
  warn:     1,
  critical: 2,
};

function shouldSend(severity: AlertSeverity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[CONFIG.alertMinSeverity];
}

// ── Emojis par sévérité ───────────────────────────────────────
const EMOJI: Record<AlertSeverity, string> = {
  info:     'ℹ️',
  warn:     '⚠️',
  critical: '🚨',
};

// ── Formatage du message ──────────────────────────────────────
function formatMessage(alert: Alert): string {
  const ts  = new Date(alert.timestamp).toISOString();
  const ctx = alert.context
    ? '\n```\n' + JSON.stringify(alert.context, null, 2) + '\n```'
    : '';

  return (
    `${EMOJI[alert.severity]} *[${alert.severity.toUpperCase()}]* ${alert.title}\n` +
    `${alert.message}\n` +
    `_${ts}_${ctx}`
  );
}

// ── Envoi Telegram ────────────────────────────────────────────
async function sendTelegram(alert: Alert): Promise<void> {
  const { alertTelegramToken: token, alertTelegramChatId: chatId } = CONFIG;
  if (!token || !chatId) return;

  const url  = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id:    chatId,
    text:       formatMessage(alert),
    parse_mode: 'Markdown',
  };

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.warn('Échec envoi alerte Telegram', { status: res.status, body: text });
  }
}

// ── Envoi Discord ─────────────────────────────────────────────
async function sendDiscord(alert: Alert): Promise<void> {
  const webhook = CONFIG.alertDiscordWebhook;
  if (!webhook) return;

  // Discord Embed
  const colorMap: Record<AlertSeverity, number> = {
    info:     0x3498db,  // bleu
    warn:     0xf39c12,  // orange
    critical: 0xe74c3c,  // rouge
  };

  const body = {
    embeds: [{
      title:       `${EMOJI[alert.severity]} ${alert.title}`,
      description: alert.message,
      color:       colorMap[alert.severity],
      timestamp:   new Date(alert.timestamp).toISOString(),
      fields:      alert.context
        ? Object.entries(alert.context).map(([k, v]) => ({
            name:   k,
            value:  String(v),
            inline: true,
          }))
        : [],
    }],
  };

  const res = await fetch(webhook, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    logger.warn('Échec envoi alerte Discord', { status: res.status });
  }
}

// ── API publique ──────────────────────────────────────────────
export async function sendAlert(
  severity: AlertSeverity,
  title: string,
  message: string,
  context?: Record<string, unknown>
): Promise<void> {
  if (!shouldSend(severity)) return;

  const alert: Alert = { severity, title, message, context, timestamp: Date.now() };

  // Log local systématiquement
  const logFn = severity === 'critical' || severity === 'warn'
    ? logger.warn
    : logger.info;
  logFn(`[ALERT] ${title}: ${message}`, context);

  // Envoi parallèle (on ne bloque pas le bot si les alertes échouent)
  await Promise.allSettled([
    sendTelegram(alert),
    sendDiscord(alert),
  ]);
}

// ── Alertes prédéfinies ───────────────────────────────────────
export const alerts = {
  botStarted(wallet: string, pools: string[]): Promise<void> {
    return sendAlert('info', '🤖 Bot démarré', `Wallet: ${wallet}`, {
      pools: pools.join(', '),
      network: process.env.SUI_ENV ?? 'mainnet',
    });
  },

  botStopped(reason: string): Promise<void> {
    return sendAlert('warn', '🛑 Bot arrêté', reason);
  },

  hedgeExecuted(poolId: string, action: string, qty: number, delta: number): Promise<void> {
    return sendAlert(
      'info',
      '✅ Hedge exécuté',
      `Pool ${poolId.slice(0, 8)}: ${action.toUpperCase()} ${qty}`,
      { delta: delta.toFixed(4), pool: poolId }
    );
  },

  tooManyErrors(consecutive: number, lastError: string): Promise<void> {
    return sendAlert(
      'critical',
      '🚨 Trop d\'erreurs consécutives',
      `${consecutive} échecs → arrêt imminent`,
      { lastError }
    );
  },

  lowWalletBalance(balanceSui: number): Promise<void> {
    return sendAlert(
      'warn',
      '💸 Solde wallet faible',
      `Solde SUI: ${balanceSui.toFixed(4)} — rechargez le wallet`,
      { balance_sui: balanceSui }
    );
  },

  dryRunFailed(poolId: string, error: string): Promise<void> {
    return sendAlert(
      'warn',
      '⛔ DryRun échoué',
      `Transaction simulée rejetée sur pool ${poolId.slice(0, 8)}`,
      { error, poolId }
    );
  },
};
