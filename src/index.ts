import * as dotenv from 'dotenv';
dotenv.config();

import { getFullnodeUrl }         from '@mysten/sui/client';

import { CONFIG }                 from './config.js';
import { logger }                 from './utils/logger.js';
import { loadDeepBookPools }      from './utils/pools.js';
import { initClients, client, db, walletAddress, getWalletBalanceSui } from './utils/sui.js';
import { startMetricsServer, stopMetricsServer, metrics } from './utils/metrics.js';
import { alerts }                 from './utils/alerts.js';
import { hedgeAllPools, getErrorStats } from './core/hedging.js';
import { checkAllPoolsMargin, resetCircuitBreakerManually } from './core/liquidation.js';
import type { AppContext }         from './types.js';

// ── Contexte global ───────────────────────────────────────────
let ctx: AppContext;

// ── Surveillance du solde ─────────────────────────────────────
const LOW_BALANCE_THRESHOLD_SUI = 0.5;

async function checkWalletBalance(): Promise<void> {
  try {
    const balance = await getWalletBalanceSui();
    metrics.setWalletBalance(balance);

    if (balance < LOW_BALANCE_THRESHOLD_SUI) {
      await alerts.lowWalletBalance(balance);
    }
  } catch (err) {
    logger.warn('Impossible de lire le solde du wallet', {
      error: (err as Error).message,
    });
  }
}

// ── WebSocket (reconnexion automatique) ───────────────────────
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function setupWebSocket(): void {
  logger.info('Connexion WebSocket aux events DeepBook...');

  try {
    const unsubscribePromise = client.subscribeEvent({
      filter: {
        Package: '0x000000000000000000000000000000000000000000000000000000000000dee9',
      },
      onMessage: (event) => {
        logger.info('Event DeepBook reçu', { type: event.type });
        hedgeAllPools(ctx).catch((err) =>
          logger.error('Erreur hedging sur event WS', { err: (err as Error).message })
        );
      },
    });

    logger.info('WebSocket abonné aux events DeepBook');

    const cleanup = async (): Promise<void> => {
      try {
        const unsub = await unsubscribePromise;
        if (typeof unsub === 'function') unsub();
      } catch { /* ignore */ }
    };

    process.once('SIGINT',  () => { void cleanup().then(() => process.exit(0)); });
    process.once('SIGTERM', () => { void cleanup().then(() => process.exit(0)); });

  } catch (err) {
    logger.warn('WebSocket indisponible → polling seulement', {
      error: (err as Error).message,
    });
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(setupWebSocket, CONFIG.wsReconnectDelayMs);
  }
}

// ── Arrêt propre ──────────────────────────────────────────────
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Signal ${signal} reçu → arrêt propre`);
  await alerts.botStopped(`Signal ${signal}`);
  await stopMetricsServer();
  process.exit(0);
}

// ── Point d'entrée ────────────────────────────────────────────
async function main(): Promise<void> {
  // 1. Initialiser les clients (keystore ou .env)
  await initClients();

  ctx = { address: walletAddress, db, client };

  logger.info('Démarrage bot hedging DeepBook v2', {
    wallet:  walletAddress.slice(0, 12) + '...',
    network: process.env.SUI_ENV ?? 'mainnet',
  });

  // 2. Charger et résoudre les pools
  const poolsMap = await loadDeepBookPools();
  CONFIG.pools   = Array.from(poolsMap.values()).map((p) => ({
    id:          p.id,
    baseSymbol:  p.baseSymbol,
    quoteSymbol: p.quoteSymbol,
  }));

  logger.info('Pools actifs', {
    pools: CONFIG.pools.map((p) => `${p.baseSymbol}/${p.quoteSymbol} → ${p.id.slice(0, 8)}...`),
  });

  // 3. Démarrer le serveur de métriques
  startMetricsServer();

  // 4. Alerte démarrage
  await alerts.botStarted(
    walletAddress.slice(0, 12) + '...',
    CONFIG.pools.map((p) => `${p.baseSymbol}/${p.quoteSymbol}`)
  );

  // 5. Vérification initiale du solde
  await checkWalletBalance();

  // 6. Vérification initiale de la marge (avant le premier hedge)
  await checkAllPoolsMargin(ctx);

  // 7. Premier cycle immédiat de hedging
  await hedgeAllPools(ctx);

  // 8. WebSocket temps-réel
  setupWebSocket();

  // 9. Polling de secours
  setInterval(async () => {
    logger.info('[POLL] Vérification périodique');
    await hedgeAllPools(ctx);
  }, CONFIG.checkIntervalMs);

  // 10. Surveillance de la marge (circuit breaker & liquidation)
  setInterval(async () => {
    logger.info('[MARGIN] Vérification des marges');
    await checkAllPoolsMargin(ctx);
  }, CONFIG.marginCheckIntervalMs);

  // 11. Vérification du solde toutes les 5 min
  setInterval(() => { void checkWalletBalance(); }, 5 * 60_000);

  // 11. Rapport d'erreurs toutes les 10 min
  setInterval(() => {
    const stats = getErrorStats();
    if (stats.count > 0) {
      logger.warn('Rapport erreurs', {
        total:       stats.count,
        consecutive: stats.consecutiveFailures,
        last:        stats.lastError?.message,
      });
    }
  }, 600_000);
}

// ── Gestionnaires globaux ─────────────────────────────────────
process.on('SIGINT',  () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

process.on('uncaughtException', (err) => {
  logger.error('Exception non capturée', { message: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Promise rejetée non gérée', { reason: String(reason) });
});

main().catch((err) => {
  logger.error('Échec démarrage', { message: (err as Error).message });
  process.exit(1);
});
