/**
 * Métriques Prometheus — exposées sur http://localhost:{METRICS_PORT}/metrics
 *
 * Métriques disponibles :
 *   hedge_delta_current          - Delta courant par pool
 *   hedge_delta_priced_usd       - Delta valorisé USD par pool
 *   hedge_orders_total           - Nombre total d'ordres passés (labels: pool, action)
 *   hedge_errors_total           - Nombre total d'erreurs (labels: pool, code)
 *   hedge_consecutive_failures   - Échecs consécutifs courants
 *   hedge_tx_duration_ms         - Durée des transactions (gauge)
 *   hedge_wallet_balance_sui     - Solde SUI du wallet
 *   hedge_cycle_last_timestamp   - Timestamp du dernier cycle réussi
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { CONFIG } from '../config.js';
import { logger } from './logger.js';

// ── Store des métriques (in-memory) ───────────────────────────
interface Counter  { [label: string]: number }
interface Gauge    { [label: string]: number }

const counters: Record<string, Counter> = {
  hedge_orders_total: {},
  hedge_errors_total: {},
};

const gauges: Record<string, Gauge> = {
  hedge_delta_current:        {},
  hedge_delta_priced_usd:     {},
  hedge_consecutive_failures: { '': 0 },
  hedge_tx_duration_ms:       {},
  hedge_wallet_balance_sui:   { '': 0 },
  hedge_cycle_last_timestamp: {},
};

// ── API publique ──────────────────────────────────────────────
export const metrics = {
  // Incrémente un compteur
  incCounter(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = labelsToKey(labels);
    counters[name] ??= {};
    counters[name]![key] = (counters[name]![key] ?? 0) + by;
  },

  // Met à jour un gauge
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = labelsToKey(labels);
    gauges[name] ??= {};
    gauges[name]![key] = value;
  },

  // Raccourcis sémantiques
  recordOrder(poolId: string, action: string): void {
    this.incCounter('hedge_orders_total', { pool: poolId.slice(0, 8), action });
  },

  recordError(poolId: string, code: string): void {
    this.incCounter('hedge_errors_total', { pool: poolId.slice(0, 8), code });
  },

  setDelta(poolId: string, raw: number, priced: number): void {
    this.setGauge('hedge_delta_current',    raw,    { pool: poolId.slice(0, 8) });
    this.setGauge('hedge_delta_priced_usd', priced, { pool: poolId.slice(0, 8) });
  },

  setConsecutiveFailures(n: number): void {
    this.setGauge('hedge_consecutive_failures', n);
  },

  setTxDuration(poolId: string, ms: number): void {
    this.setGauge('hedge_tx_duration_ms', ms, { pool: poolId.slice(0, 8) });
  },

  setWalletBalance(sui: number): void {
    this.setGauge('hedge_wallet_balance_sui', sui);
  },

  setCycleTimestamp(poolId: string): void {
    this.setGauge('hedge_cycle_last_timestamp', Date.now(), { pool: poolId.slice(0, 8) });
  },
};

// ── Rendu Prometheus text format ──────────────────────────────
function labelsToKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${labels[k]}"`).join(',') + '}';
}

function renderMetrics(): string {
  const lines: string[] = [];

  const HELP: Record<string, [string, string]> = {
    hedge_delta_current:        ['gauge',   'Delta courant (unités base) par pool'],
    hedge_delta_priced_usd:     ['gauge',   'Delta valorisé en USD par pool'],
    hedge_orders_total:         ['counter', 'Nombre total d\'ordres passés'],
    hedge_errors_total:         ['counter', 'Nombre total d\'erreurs'],
    hedge_consecutive_failures: ['gauge',   'Échecs consécutifs courants'],
    hedge_tx_duration_ms:       ['gauge',   'Durée de la dernière transaction (ms)'],
    hedge_wallet_balance_sui:   ['gauge',   'Solde SUI du wallet'],
    hedge_cycle_last_timestamp: ['gauge',   'Timestamp UNIX du dernier cycle (ms)'],
  };

  for (const [name, [type, help]] of Object.entries(HELP)) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);

    const store = counters[name] ?? gauges[name] ?? {};
    for (const [labelKey, value] of Object.entries(store)) {
      lines.push(`${name}${labelKey} ${value}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ── Serveur HTTP ──────────────────────────────────────────────
let server: ReturnType<typeof createServer> | null = null;

export function startMetricsServer(): void {
  if (!CONFIG.metricsEnabled) {
    logger.info('Métriques désactivées (METRICS_ENABLED=false)');
    return;
  }

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      const body = renderMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
    } else if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(CONFIG.metricsPort, () => {
    logger.info(`Métriques Prometheus disponibles`, {
      url: `http://localhost:${CONFIG.metricsPort}/metrics`,
    });
  });

  server.on('error', (err) => {
    logger.error('Erreur serveur métriques', { error: (err as Error).message });
  });
}

export function stopMetricsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}
