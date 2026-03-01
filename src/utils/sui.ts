import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair }            from '@mysten/sui/keypairs/ed25519';
import { Transaction }               from '@mysten/sui/transactions';
import { DeepBookV3Client }          from '@mysten/deepbook-v3';
import * as dotenv                   from 'dotenv';

import { HedgingError }   from '../types.js';
import { CONFIG }         from '../config.js';
import { logger }         from './logger.js';

dotenv.config();

// ─── Client Sui ──────────────────────────────────────────────
const rpcUrl = process.env.RPC_URL ?? getFullnodeUrl('mainnet');
export const client = new SuiClient({ url: rpcUrl });

// ─── Keypair depuis mnémonique ────────────────────────────────
const mnemonic = process.env.MNEMONIC;
if (!mnemonic) throw new Error('MNEMONIC manquant dans .env');

export const keypair = Ed25519Keypair.deriveKeypair(mnemonic);
export const walletAddress = keypair.getPublicKey().toSuiAddress();

// ─── Client DeepBook ─────────────────────────────────────────
export const db = new DeepBookV3Client({
  client,
  env: (process.env.SUI_ENV ?? 'mainnet') as 'mainnet' | 'testnet',
  params: { adminCap: undefined },
});

// ─── Normalisation des erreurs ───────────────────────────────
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

// ─── Exécution sécurisée avec retry ──────────────────────────
export async function executeSafe(
  tx: Transaction,
  options: { retries?: number; delay?: number } = {}
): Promise<unknown> {
  const { retries = CONFIG.maxRetries, delay = CONFIG.retryDelayBaseMs } = options;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const result = await client.signAndExecuteTransaction({
        signer:      keypair,
        transaction: tx,
        options: { showEffects: true, showEvents: true },
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

      // Backoff exponentiel + jitter
      const backoff = delay * Math.pow(2, attempt - 1) + Math.random() * 200;
      logger.warn(`Retry dans ${Math.round(backoff)}ms...`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw new HedgingError('Max retries atteint sans succès', 'FATAL', false);
}
