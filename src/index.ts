import * as dotenv from 'dotenv';
dotenv.config();

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

import { CONFIG }             from './config.js';
import { logger }             from './utils/logger.js';
import { loadDeepBookPools }  from './utils/pools.js';
import { db, client, keypair, walletAddress } from './utils/sui.js';
import { hedgeAllPools, getErrorStats }       from './core/hedging.js';
import type { AppContext }    from './types.js';

// ─── Contexte global de l'application ────────────────────────
const ctx: AppContext = {
  address: walletAddress,
  db,
  client,
};

// ─── WebSocket de surveillance (reconnexion automatique) ──────
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function setupWebSocket(): void {
  const wsUrl = (process.env.RPC_URL ?? getFullnodeUrl('mainnet'))
    .replace('https://', 'wss://')
    .replace('http://',  'ws://');

  logger.info('Connexion WebSocket...', { url: wsUrl });

  try {
    // Sui fournit une API d'abonnement aux events via SuiClient
    // On souscrit aux events DeepBook pour réagir en temps réel
    const unsubscribe = client.subscribeEvent({
      filter: { Package: '0x000000000000000000000000000000000000000000000000000000000000dee9' },
      onMessage: (event) => {
        logger.info('Event DeepBook reçu', { type: event.type });
        // Déclenche un cycle de hedging immédiat sur réception d'un event
        hedgeAllPools(ctx).catch((err) =>
          logger.error('Erreur hedging sur event WS', { err: (err as Error).message })
        );
      },
    });

    logger.info('WebSocket abonné aux events DeepBook');

    // Nettoyage propre à l'arrêt
    process.once('SIGINT',  () => { unsubscribe.then?.(() => void 0); process.exit(0); });
    process.once('SIGTERM', () => { unsubscribe.then?.(() => void 0); process.exit(0); });

  } catch (err) {
    logger.warn('WebSocket indisponible, utilisation du polling uniquement', {
      error: (err as Error).message,
    });

    // Reconnexion après délai configurable
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(setupWebSocket, CONFIG.wsReconnectDelayMs);
  }
}

// ─── Point d'entrée principal ─────────────────────────────────
async function main(): Promise<void> {
  logger.info('Démarrage bot hedging DeepBook', {
    wallet:  walletAddress.slice(0, 10) + '...',
    network: process.env.RPC_URL ?? 'mainnet (défaut)',
  });

  // 1. Charger et résoudre les pools
  const poolsMap = await loadDeepBookPools();
  CONFIG.pools = Array.from(poolsMap.values()).map((p) => ({
    id:          p.id,
    baseSymbol:  p.baseSymbol,
    quoteSymbol: p.quoteSymbol,
  }));

  logger.info('Pools actifs', {
    pools: CONFIG.pools.map((p) => `${p.baseSymbol}/${p.quoteSymbol} → ${p.id.slice(0, 8)}...`),
  });

  // 2. Premier cycle immédiat
  await hedgeAllPools(ctx);

  // 3. Abonnement WebSocket pour réactivité temps-réel
  setupWebSocket();

  // 4. Polling de secours périodique
  setInterval(async () => {
    logger.info('[POLL] Vérification périodique');
    await hedgeAllPools(ctx);
  }, CONFIG.checkIntervalMs);

  // 5. Monitoring des erreurs toutes les 10 min
  setInterval(() => {
    const stats = getErrorStats();
    if (stats.count > 0) {
      logger.warn('Statistiques erreurs', {
        total:       stats.count,
        consecutive: stats.consecutiveFailures,
        last:        stats.lastError?.message,
      });
    }
  }, 600_000);
}

// ─── Gestionnaires d'erreurs globaux ─────────────────────────
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
