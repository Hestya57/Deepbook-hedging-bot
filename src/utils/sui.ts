import { SuiClient, getFullnodeUrl }  from '@mysten/sui/client';
import { Ed25519Keypair }              from '@mysten/sui/keypairs/ed25519';
import { Transaction }                 from '@mysten/sui/transactions';
import { DeepBookV3Client }            from '@mysten/deepbook-v3';

import { HedgingError }               from '../types.js';
import { CONFIG }                     from '../config.js';
import { logger }                     from './logger.js';
import { loadMnemonicFromKeystore }   from './keystore.js';

// ── Clients (initialisés dans initClients()) ──────────────────
export let client!:        SuiClient;
export let keypair!:       Ed25519Keypair;
export let walletAddress!: string;
export let db!:            DeepBookV3Client;

let _initialized = false;

/**
 * Initialise les clients Sui/DeepBook.
 * Doit être appelé AVANT tout autre usage des clients.
 * Supporte deux modes :
 *   1. MNEMONIC en .env (développement / CI rapide)
 *   2. Keystore chiffré (production recommandée)
 */
export async function initClients(): Promise<void> {
  if (_initialized) return;

  const rpcUrl = process.env.RPC_URL ?? getFullnodeUrl('mainnet');
  client = new SuiClient({ url: rpcUrl });

  // ── Chargement sécurisé du mnémonique ─────────────────────
  let mnemonic: string;

  if (process.env.MNEMONIC) {
    // Fallback dev : MNEMONIC direct en .env
    logger.warn(
      'MNEMONIC chargé depuis .env — utilisez un keystore chiffré en production !',
      { hint: 'npm run keystore:create' }
    );
    mnemonic = process.env.MNEMONIC;
  } else {
    // Production : keystore chiffré AES-256-GCM
    mnemonic = await loadMnemonicFromKeystore(CONFIG.keystorePath);
  }

  keypair       = Ed25519Keypair.deriveKeypair(mnemonic);
  walletAddress = keypair.getPublicKey().toSuiAddress();

  db = new DeepBookV3Client({
    client,
    env:    (process.env.SUI_ENV ?? 'mainnet') as 'mainnet' | 'testnet',
    params: { adminCap: undefined },
  });

  // Efface le mnémonique de la mémoire après usage
  mnemonic = '';

  _initialized = true;
  logger.info('Clients Sui initialisés', {
    address: walletAddress.slice(0, 12) + '...',
    rpc:     rpcUrl,
  });
}

// ── Normalisation des erreurs ─────────────────────────────────
export function normalizeError(err: unknown): HedgingError {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes('InsufficientGas')) {
    return new HedgingError('Gaz insuffisant', 'INSUFFICIENT_GAS', true);
  }
  if (msg.includes('timeout') || msg.includes('429') || msg.includes('network')) {
    return new HedgingError('Problème réseau', 'NETWORK', true);
  }
  if (msg.includes('MoveAbort') || msg.includes('abort')) {
    return new HedgingError('Erreur Move (abort)', 'MOVE_ABORT', false);
  }

  return new HedgingError(`Erreur inconnue: ${msg}`, 'UNKNOWN', false, err);
}

// ── Simulation pre-envoi (dryRun) ─────────────────────────────
export async function dryRunTransaction(tx: Transaction): Promise<void> {
  logger.info('Simulation de la transaction (dryRun)...');

  // Construire les bytes de la transaction signée pour la simulation
  const txBytes = await tx.build({ client });

  const dryResult = await client.dryRunTransactionBlock({
    transactionBlock: txBytes,
  });

  if (dryResult.effects.status.status !== 'success') {
    const errMsg = dryResult.effects.status.error ?? 'DryRun: statut inconnu';
    throw new HedgingError(
      `Simulation échouée avant envoi: ${errMsg}`,
      dryResult.effects.status.error?.includes('MoveAbort') ? 'MOVE_ABORT' : 'DRYRUN_FAILED',
      false,
      { dryRunError: errMsg }
    );
  }

  // Estimer le gas consommé
  const gasUsed = dryResult.effects.gasUsed;
  const totalGas = Number(gasUsed.computationCost)
    + Number(gasUsed.storageCost)
    - Number(gasUsed.storageRebate);

  logger.info('Simulation réussie', {
    gasEstimé: `${(totalGas / 1e9).toFixed(6)} SUI`,
  });
}

// ── Exécution sécurisée avec dryRun + retry ───────────────────
export async function executeSafe(
  tx: Transaction,
  options: { retries?: number; delay?: number; skipDryRun?: boolean } = {}
): Promise<unknown> {
  const {
    retries     = CONFIG.maxRetries,
    delay       = CONFIG.retryDelayBaseMs,
    skipDryRun  = false,
  } = options;

  // ── 1. Simulation obligatoire avant envoi réel ────────────
  if (!skipDryRun) {
    await dryRunTransaction(tx);
  }

  // ── 2. Envoi réel avec retry + backoff ────────────────────
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const result = await client.signAndExecuteTransaction({
        signer:      keypair,
        transaction: tx,
        options:     { showEffects: true, showEvents: true },
      });

      if (result.effects?.status?.status !== 'success') {
        const errorMsg = result.effects?.status?.error ?? 'Transaction failed';
        throw new HedgingError(
          `Transaction échouée: ${errorMsg}`,
          errorMsg.includes('MoveAbort') ? 'MOVE_ABORT' : 'TX_FAILED',
          false,
          { digest: result.digest }
        );
      }

      logger.info('Transaction réussie', { digest: result.digest });
      return result;

    } catch (err) {
      const error = err instanceof HedgingError ? err : normalizeError(err);
      logger.error(error, { attempt, max: retries + 1 });

      if (!error.retryable || attempt === retries + 1) throw error;

      const backoff = delay * Math.pow(2, attempt - 1) + Math.random() * 200;
      logger.warn(`Retry dans ${Math.round(backoff)}ms...`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw new HedgingError('Max retries atteint sans succès', 'FATAL', false);
}

// ── Lecture du solde SUI ──────────────────────────────────────
export async function getWalletBalanceSui(): Promise<number> {
  const balance = await client.getBalance({
    owner: walletAddress,
    coinType: '0x2::sui::SUI',
  });
  return Number(balance.totalBalance) / 1e9;
}
