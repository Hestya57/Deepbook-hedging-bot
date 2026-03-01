/**
 * Keystore chiffré — AES-256-GCM
 *
 * Le fichier .env ne doit PLUS contenir MNEMONIC en clair.
 * Workflow :
 *   1. Première utilisation : `npm run keystore:create`
 *      → lit MNEMONIC depuis stdin, chiffre avec un mot de passe, écrit keystore.enc
 *   2. Au démarrage du bot, le mot de passe est lu depuis :
 *      a. La variable d'env KEYSTORE_PASSWORD (CI/CD, Docker secret)
 *      b. Sinon, invite interactive (TTY)
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync }                    from 'node:fs';
import { createInterface }                                            from 'node:readline';
import { logger }                                                     from './logger.js';

// ── Constantes cryptographiques ───────────────────────────────
const ALGO        = 'aes-256-gcm';
const SALT_LEN    = 32;
const IV_LEN      = 12;
const TAG_LEN     = 16;
const KEY_LEN     = 32;
const SCRYPT_N    = 32768;
const SCRYPT_R    = 8;
const SCRYPT_P    = 1;
const VERSION     = 1;

interface KeystoreFile {
  version: number;
  salt:    string;   // hex
  iv:      string;   // hex
  tag:     string;   // hex
  data:    string;   // hex (ciphertext)
}

// ── Dérivation de clé ─────────────────────────────────────────
function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

// ── Chiffrement ───────────────────────────────────────────────
export function encryptMnemonic(mnemonic: string, password: string): KeystoreFile {
  const salt    = randomBytes(SALT_LEN);
  const iv      = randomBytes(IV_LEN);
  const key     = deriveKey(password, salt);
  const cipher  = createCipheriv(ALGO, key, iv);
  const plain   = Buffer.from(mnemonic, 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag     = cipher.getAuthTag();

  return {
    version: VERSION,
    salt:    salt.toString('hex'),
    iv:      iv.toString('hex'),
    tag:     tag.toString('hex'),
    data:    encrypted.toString('hex'),
  };
}

// ── Déchiffrement ─────────────────────────────────────────────
export function decryptMnemonic(ks: KeystoreFile, password: string): string {
  if (ks.version !== VERSION) {
    throw new Error(`Version keystore inconnue : ${ks.version}`);
  }

  const salt     = Buffer.from(ks.salt, 'hex');
  const iv       = Buffer.from(ks.iv,   'hex');
  const tag      = Buffer.from(ks.tag,  'hex');
  const data     = Buffer.from(ks.data, 'hex');
  const key      = deriveKey(password, salt);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  try {
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString('utf-8');
  } catch {
    throw new Error('Mot de passe incorrect ou fichier keystore corrompu');
  }
}

// ── Lecture du mot de passe ───────────────────────────────────
async function readPasswordFromTty(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function getKeystorePassword(): Promise<string> {
  const envPwd = process.env.KEYSTORE_PASSWORD;
  if (envPwd) {
    logger.info('Mot de passe keystore chargé depuis KEYSTORE_PASSWORD');
    return envPwd;
  }
  logger.info('Aucun KEYSTORE_PASSWORD trouvé → invite interactive');
  return readPasswordFromTty('🔑 Mot de passe du keystore : ');
}

// ── Chargement au démarrage ───────────────────────────────────
export async function loadMnemonicFromKeystore(keystorePath: string): Promise<string> {
  if (!existsSync(keystorePath)) {
    throw new Error(
      `Keystore introuvable : ${keystorePath}\n` +
      `Créez-le avec : npm run keystore:create`
    );
  }

  const raw = readFileSync(keystorePath, 'utf-8');
  let ks: KeystoreFile;

  try {
    ks = JSON.parse(raw) as KeystoreFile;
  } catch {
    throw new Error(`Keystore invalide (JSON malformé) : ${keystorePath}`);
  }

  const password = await getKeystorePassword();
  const mnemonic = decryptMnemonic(ks, password);
  logger.info('Mnémonique déchiffré depuis le keystore');
  return mnemonic;
}

// ── Outil CLI : création du keystore ─────────────────────────
export async function createKeystore(keystorePath: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q: string): Promise<string> =>
    new Promise((r) => rl.question(q, (a) => r(a.trim())));

  logger.info('=== Création du keystore chiffré ===');
  const mnemonic  = await ask('Entrez votre mnémonique (12 mots) : ');
  const password  = await ask('Mot de passe de chiffrement : ');
  const password2 = await ask('Confirmez le mot de passe : ');
  rl.close();

  if (password !== password2) {
    throw new Error('Les mots de passe ne correspondent pas');
  }
  if (mnemonic.split(' ').length < 12) {
    throw new Error('Le mnémonique doit contenir au moins 12 mots');
  }

  const ks = encryptMnemonic(mnemonic, password);
  writeFileSync(keystorePath, JSON.stringify(ks, null, 2), { mode: 0o600 });
  logger.info(`Keystore créé : ${keystorePath} (permissions 600)`);
  logger.warn('Ne commitez JAMAIS ce fichier. Ajoutez *.enc à .gitignore.');
}
