# How to Ika — Intégration MPC sub-seconde dans le DeepBook Hedging Bot

> **Document de référence** pour une intégration future (v4/v5).
> Ika n'est pas intégré dans la v3 actuelle — ce fichier documente les concepts,
> le SDK, et les applications concrètes pour le bot.

---

## Table des matières

1. [Qu'est-ce qu'Ika ?](#1-quest-ce-quika)
2. [Concepts fondamentaux](#2-concepts-fondamentaux)
3. [Installation & configuration](#3-installation--configuration)
4. [Flux de base : DKG → Presign → Sign](#4-flux-de-base--dkg--presign--sign)
5. [Code complet pas à pas](#5-code-complet-pas-à-pas)
6. [Applications concrètes pour le bot](#6-applications-concrètes-pour-le-bot)
7. [Roadmap d'intégration suggérée](#7-roadmap-dintégration-suggérée)
8. [Ressources](#8-ressources)

---

## 1. Qu'est-ce qu'Ika ?

Ika est un réseau de signature à seuil **Zero-Trust**, implémentant un protocole appelé
**2PC-MPC** (Two-Party Computation + Multi-Party Computation).

### Principe fondamental

Une signature cryptographique ne peut **jamais** être générée sans la participation
simultanée de deux parties :

- **L'utilisateur** — détient sa "user share" (part de clé privée chiffrée)
- **Le réseau Ika** — un ensemble de validateurs détenant collectivement une "network share"

Ni l'utilisateur seul, ni le réseau seul ne peuvent produire une signature valide.
C'est la définition du "Zero-Trust".

### Propriétés clés

| Propriété | Description |
|---|---|
| **Non-collusif** | Impossible de signer sans le consentement de l'utilisateur |
| **Décentralisé** | Des centaines de nœuds participent à chaque signature |
| **Programmable** | La logique de signature est définie dans un smart contract Sui |
| **Transférable** | La propriété du dWallet peut changer de mains |
| **Sub-seconde** | ~10 000 signatures/seconde grâce au pré-calcul (presign) |

### Pourquoi c'est révolutionnaire pour un bot de trading

Avec un bot traditionnel (v3 actuelle), la clé privée existe quelque part — même
chiffrée dans un keystore AES-256-GCM, elle doit être déchiffrée en mémoire pour signer.
Si le serveur est compromis à ce moment, l'attaquant peut voler les fonds.

Avec Ika, **la clé privée n'existe en entier chez personne, jamais**. L'attaquant qui
compromet le serveur obtient uniquement la "user share" chiffrée — inutilisable sans
le réseau Ika.

---

## 2. Concepts fondamentaux

### dWallet

La primitive centrale d'Ika. Un dWallet est un objet on-chain Sui qui encapsule
une paire de clés MPC. Il peut signer des transactions sur n'importe quelle blockchain
supportée (Sui, Ethereum, Bitcoin, Solana...).

```
dWallet = user_share (chiffré, stocké off-chain) + network_share (distribué entre validateurs)
```

### DKG — Distributed Key Generation

La cérémonie de création d'un dWallet. Les deux parties (utilisateur + réseau) génèrent
ensemble une paire de clés sans que personne ne voie jamais la clé privée complète.

**À faire une seule fois par dWallet.**

### Presign

Un pré-calcul cryptographique coûteux effectué **à l'avance**, avant de connaître le
message à signer. C'est ce qui permet la performance sub-seconde : quand vient le moment
de signer, le travail lourd est déjà fait.

Il existe deux types :
- **Presign lié à un dWallet** : réservé à un dWallet spécifique
- **Global Presign** : non lié à l'avance, utilisable avec n'importe quel dWallet
  (plus flexible, recommandé pour le bot)

### Sign (Future Sign)

La signature finale, produite en combinant le presign + le message à signer + la
participation active de l'utilisateur. Sub-seconde si le presign est déjà disponible.

### Future Transaction (Sign conditionnel)

Une fonctionnalité avancée : signer une transaction incomplète qui sera finalisée par Ika
**uniquement si des conditions définies dans un smart contract Sui sont respectées**.
Application directe au bot : order de fermeture d'urgence pré-signé, déclenché
automatiquement on-chain sans que le bot soit en ligne.

### Algorithmes de signature supportés

| Algorithme | Hash | Blockchain cible |
|---|---|---|
| ECDSA Secp256k1 | SHA256 | Bitcoin |
| ECDSA Secp256k1 | KECCAK256 | Ethereum, EVM |
| Taproot / Schnorr (BIP-340) | — | Bitcoin (Taproot) |
| ECDSA Secp256r1 | SHA256 | WebAuthn, Apple Secure Enclave |
| EdDSA Ed25519 | — | Solana, Sui |

---

## 3. Installation & configuration

### Installation du SDK

```bash
# npm / yarn / pnpm — au choix
pnpm add @ika.xyz/sdk
npm  install @ika.xyz/sdk
```

### Depuis les sources (pour contribuer ou utiliser une version dev)

```bash
# Prérequis
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
brew install sui                                                     # Sui CLI
npm install -g pnpm                                                  # pnpm
curl https://drager.github.io/wasm-pack/installer/init.sh -sSf | sh # wasm-pack
cargo install wasm-bindgen-cli --version 0.2.100                     # wasm-bindgen

# Build
git clone https://github.com/dwallet-labs/ika.git
cd ika/sdk/typescript
pnpm install && pnpm build
```

### Variables d'environnement à ajouter au .env

```env
# ── Ika SDK ──────────────────────────────────────────────────
IKA_NETWORK=testnet                    # testnet | mainnet
IKA_SEED_SECRET=votre-seed-secret     # seed pour dériver les UserShareEncryptionKeys
                                       # ⚠️ NE JAMAIS commiter, à stocker dans le keystore
IKA_CURVE=SECP256K1                    # SECP256K1 | SECP256R1 | ED25519
```

---

## 4. Flux de base : DKG → Presign → Sign

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   [1] DKG                [2] Presign          [3] Sign     │
│   Créer le dWallet       Pré-calculer         Signer       │
│   (une seule fois)       (à l'avance)         (sub-sec)    │
│                                                             │
│   ~quelques secondes     ~quelques secondes   < 1 seconde  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Stratégie optimale pour le bot :**
- Créer le dWallet une seule fois au setup
- Maintenir un pool de presigns pré-calculés en permanence
- Consommer un presign à chaque transaction de hedging

---

## 5. Code complet pas à pas

### 5.1 Initialiser les clients

```typescript
import { getNetworkConfig, IkaClient, IkaTransaction } from '@ika.xyz/sdk';
import { getFullnodeUrl, SuiClient }                   from '@mysten/sui/client';
import { Transaction }                                  from '@mysten/sui/transactions';
import { Ed25519Keypair }                               from '@mysten/sui/keypairs/ed25519';

const network    = (process.env.IKA_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
const suiClient  = new SuiClient({ url: getFullnodeUrl(network) });

const ikaClient  = new IkaClient({
  suiClient,
  config:  getNetworkConfig(network),
  network,
});

// Initialiser le client (charge les configs réseau on-chain)
await ikaClient.initialize();

const keypair       = Ed25519Keypair.deriveKeypair(process.env.MNEMONIC!);
const signerAddress = keypair.getPublicKey().toSuiAddress();
```

### 5.2 Créer les clés de chiffrement utilisateur (une fois)

```typescript
import {
  UserShareEncryptionKeys,
  Curve,
} from '@ika.xyz/sdk';

const curve = Curve.SECP256K1; // ou SECP256R1, ED25519

// Dériver les clés de chiffrement depuis un seed secret
// Ce seed doit être protégé — stocker dans le keystore chiffré (v3)
const seed = new TextEncoder().encode(process.env.IKA_SEED_SECRET!);
const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);

// Enregistrer la clé publique de chiffrement on-chain (une seule fois par adresse)
const tx             = new Transaction();
const ikaTransaction = new IkaTransaction({
  ikaClient,
  transaction: tx,
  userShareEncryptionKeys,
});

await ikaTransaction.registerEncryptionKey({ curve });

// Signer et exécuter via SuiClient
const result = await suiClient.signAndExecuteTransaction({
  signer:      keypair,
  transaction: tx,
  options:     { showEffects: true },
});
console.log('Clé de chiffrement enregistrée :', result.digest);
```

### 5.3 Créer un dWallet (DKG)

```typescript
import {
  prepareDKGAsync,
  createRandomSessionIdentifier,
  IkaTransaction,
  SignatureAlgorithm,
} from '@ika.xyz/sdk';

async function createDWallet(): Promise<string> {
  const identifier = createRandomSessionIdentifier();

  // Préparer les données DKG côté client (crypto locale)
  const dkgInput = await prepareDKGAsync(
    ikaClient,
    curve,
    userShareEncryptionKeys,
    identifier,
    signerAddress,
  );

  // Construire la transaction Sui
  const tx             = new Transaction();
  const ikaTransaction = new IkaTransaction({
    ikaClient,
    transaction: tx,
    userShareEncryptionKeys,
  });

  // Ajouter la demande DKG à la transaction
  const { dwallet: dWalletRef } = await ikaTransaction.requestDKG({
    curve,
    dkgInput,
    encryptionKeyAddress: signerAddress,
  });

  tx.transferObjects([dWalletRef], signerAddress);

  // Exécuter la transaction
  const result = await suiClient.signAndExecuteTransaction({
    signer:      keypair,
    transaction: tx,
    options:     { showEffects: true, showObjectChanges: true },
  });

  // Récupérer l'ID du dWallet créé
  const dWalletId = result.objectChanges
    ?.find(c => c.type === 'created' && c.objectType?.includes('DWallet'))
    ?.objectId;

  if (!dWalletId) throw new Error('dWallet non trouvé dans les objectChanges');

  console.log('dWallet créé :', dWalletId);
  return dWalletId;
}
```

### 5.4 Créer un Global Presign (à préparer à l'avance)

```typescript
import { SignatureAlgorithm } from '@ika.xyz/sdk';

async function createGlobalPresign(): Promise<string> {
  const tx             = new Transaction();
  const ikaTransaction = new IkaTransaction({
    ikaClient,
    transaction: tx,
    userShareEncryptionKeys,
  });

  // Récupérer les coins nécessaires pour les frais Ika
  const [ikaCoin, suiCoin] = await getIkaAndSuiCoins(suiClient, signerAddress);

  // Récupérer la clé de chiffrement réseau
  const networkEncKeyId = await ikaClient.getDWalletNetworkEncryptionKeyId();

  // Créer le presign global
  const presignCap = await ikaTransaction.requestGlobalPresign({
    curve,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    ikaCoin,
    suiCoin,
    dWalletNetworkEncryptionKeyId: networkEncKeyId,
  });

  tx.transferObjects([presignCap], signerAddress);

  const result = await suiClient.signAndExecuteTransaction({
    signer:      keypair,
    transaction: tx,
    options:     { showEffects: true, showObjectChanges: true },
  });

  // Extraire l'ID du presign
  const presignId = result.objectChanges
    ?.find(c => c.type === 'created' && c.objectType?.includes('PresignCap'))
    ?.objectId;

  if (!presignId) throw new Error('PresignCap non trouvé');

  // Attendre que le réseau Ika complète le presign (quelques secondes)
  const completedPresign = await ikaClient.getPresignInParticularState(
    presignId,
    'Completed',
  );

  console.log('Presign complété :', completedPresign.id);
  return completedPresign.id;
}
```

### 5.5 Signer un message (sub-seconde)

```typescript
import { Hash, SignatureAlgorithm } from '@ika.xyz/sdk';

async function signMessage(
  message:  Uint8Array,
  dWalletId: string,
  presignId: string,
): Promise<Uint8Array> {
  const tx             = new Transaction();
  const ikaTransaction = new IkaTransaction({
    ikaClient,
    transaction: tx,
    userShareEncryptionKeys,
  });

  // Récupérer les objets nécessaires
  const dWallet      = await ikaClient.getDWallet(dWalletId);
  const presign      = await ikaClient.getPresign(presignId);
  const [ikaCoin, suiCoin] = await getIkaAndSuiCoins(suiClient, signerAddress);
  const encryptedUserSecretKeyShare = await ikaClient.getEncryptedUserSecretKeyShare(
    dWalletId,
    signerAddress,
  );

  // Demander la signature (Future Sign)
  const partialUserSig = await ikaTransaction.requestFutureSign({
    dWallet,
    encryptedUserSecretKeyShare,
    hashScheme:         Hash.KECCAK256,          // KECCAK256 pour Ethereum, SHA256 pour Bitcoin
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    ikaCoin,
    suiCoin,
    message,
    presign,
    verifiedPresignCap: presign.verifiedPresignCap,
  });

  tx.transferObjects([partialUserSig], signerAddress);

  const result = await suiClient.signAndExecuteTransaction({
    signer:      keypair,
    transaction: tx,
    options:     { showEffects: true },
  });

  // Attendre que le réseau Ika complète la signature
  const signatureId = result.objectChanges
    ?.find(c => c.type === 'created')
    ?.objectId;

  const completedSig = await ikaClient.getSignatureInParticularState(
    signatureId!,
    'Completed',
  );

  return completedSig.signature;
}
```

### 5.6 Future Transaction — Signature conditionnelle

```typescript
// Cas d'usage : pré-signer un ordre de fermeture d'urgence
// → Ika complète la signature UNIQUEMENT si la condition on-chain est remplie

async function createConditionalCloseOrder(
  poolId:    string,
  orderId:   string,
  dWalletId: string,
  presignId: string,
): Promise<void> {
  const tx             = new Transaction();
  const ikaTransaction = new IkaTransaction({
    ikaClient,
    transaction: tx,
    userShareEncryptionKeys,
  });

  // Construire la transaction de fermeture (non signée)
  const closeTx = buildCancelOrderTx(poolId, orderId); // votre logique actuelle

  // Encoder la transaction comme message à signer conditionnellement
  const txBytes = await closeTx.build({ client: suiClient });

  // La condition est définie dans un Move module :
  // "signer uniquement si margin_ratio < EMERGENCY_PCT"
  // → remplacer par l'ID de votre module Move de vérification de marge
  const conditionObjectId = '0x...your_margin_check_module...';

  await ikaTransaction.requestFutureSignWithCondition({
    dWallet:            await ikaClient.getDWallet(dWalletId),
    presign:            await ikaClient.getPresign(presignId),
    message:            txBytes,
    conditionObjectId,  // Move object définissant la condition
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme:         Hash.SHA256,
    encryptedUserSecretKeyShare: await ikaClient.getEncryptedUserSecretKeyShare(
      dWalletId, signerAddress
    ),
    ikaCoin:  (await getIkaAndSuiCoins(suiClient, signerAddress))[0],
    suiCoin:  (await getIkaAndSuiCoins(suiClient, signerAddress))[1],
  });

  await suiClient.signAndExecuteTransaction({
    signer:      keypair,
    transaction: tx,
    options:     { showEffects: true },
  });

  console.log('Ordre de fermeture conditionnel enregistré — déclenché automatiquement si marge critique');
}
```

---

## 6. Applications concrètes pour le bot

### 6.1 Remplacement du keystore local (v4)

**Problème actuel (v3) :**
Le mnémonique est déchiffré en mémoire au démarrage — une fenêtre de vulnérabilité.

**Solution Ika :**
Remplacer `src/utils/keystore.ts` et `src/utils/sui.ts` par un dWallet Ika.
La clé privée n'existe jamais en mémoire sur le serveur du bot.

```typescript
// Avant (v3) — clé en mémoire
export const keypair = Ed25519Keypair.deriveKeypair(mnemonic);
await client.signAndExecuteTransaction({ signer: keypair, ... });

// Après (v4) — signature MPC
const signature = await signWithDWallet(txBytes, dWalletId, presignId);
await client.executeTransactionBlock({ transactionBlock: txBytes, signature });
```

**Bénéfice sécurité :** Même si le serveur est entièrement compromis,
l'attaquant ne peut pas signer sans le réseau Ika.

### 6.2 Pool de presigns — Performance maintenue (v4)

Pour garder la performance sub-seconde, maintenir un pool de presigns pré-calculés :

```typescript
// src/utils/presign-pool.ts

const POOL_SIZE      = 10;  // Toujours 10 presigns disponibles
const REFILL_AT      = 3;   // Recharger quand il en reste 3

const pool: string[] = [];  // IDs des presigns disponibles

export async function getPresign(): Promise<string> {
  if (pool.length === 0) throw new Error('Pool de presigns vide');

  const presignId = pool.shift()!;

  // Recharger en arrière-plan si nécessaire
  if (pool.length <= REFILL_AT) {
    void refillPool();
  }

  return presignId;
}

async function refillPool(): Promise<void> {
  const needed = POOL_SIZE - pool.length;
  logger.info(`Rechargement du pool de presigns (${needed} manquants)`);

  const newPresigns = await Promise.all(
    Array.from({ length: needed }, () => createGlobalPresign())
  );
  pool.push(...newPresigns);
  logger.info(`Pool rechargé : ${pool.length} presigns disponibles`);
}

// Initialisation au démarrage
export async function initPresignPool(): Promise<void> {
  await refillPool();
}
```

### 6.3 Remplacement du circuit breaker local par une Future Transaction (v5)

**Problème actuel (v3) :**
Le circuit breaker est en mémoire — si le bot s'arrête brutalement avec des positions
ouvertes, personne ne ferme les positions automatiquement.

**Solution Ika (Future Transaction) :**
Pré-signer un ordre de fermeture d'urgence pour chaque position ouverte.
Ika le déclenche automatiquement on-chain si la condition de marge est remplie —
**même si le bot est hors ligne**.

```typescript
// src/core/liquidation-ika.ts  (v5)

export async function registerEmergencyClose(
  poolId:    string,
  orderId:   string,
  dWalletId: string,
): Promise<void> {
  // Récupérer un presign du pool
  const presignId = await getPresign();

  // Construire l'ordre de fermeture (transaction non signée)
  const tx       = new Transaction();
  ctx.db.cancelOrder({ poolKey: poolId, orderId: BigInt(orderId), isBid: true }, tx);
  const txBytes  = await tx.build({ client: suiClient });

  // Enregistrer la Future Transaction chez Ika
  // → sera déclenchée si margin_ratio < MARGIN_EMERGENCY_PCT
  await createConditionalCloseOrder(poolId, orderId, dWalletId, presignId);

  logger.info('Fermeture d\'urgence conditionnelle enregistrée', {
    pool:    poolId.slice(0, 8),
    orderId,
  });
}

// À appeler après chaque ordre passé par le bot
export async function onOrderPlaced(
  poolId:    string,
  orderId:   string,
): Promise<void> {
  await registerEmergencyClose(poolId, orderId, CONFIG.dWalletId);
}
```

### 6.4 Hedging multi-chain natif (v5)

Le même dWallet peut signer des transactions Ethereum ou Bitcoin sans bridge.
Permet d'hedger sur un DEX Ethereum (ex: Uniswap) si la liquidité DeepBook est insuffisante.

```typescript
// Signer une transaction Ethereum avec le même dWallet
const ethTx = buildEthereumHedgeTx(amount, direction);

const ethSignature = await signMessage(
  ethTx.hash,  // message = hash de la tx Ethereum
  dWalletId,
  await getPresign(),
  // Hash.KECCAK256 + SignatureAlgorithm.ECDSASecp256k1
);

// Broadcaster la tx Ethereum signée via Ethers.js ou Viem
```

---

## 7. Roadmap d'intégration suggérée

### v4 — Remplacement du keystore (sécurité)

**Objectif :** Éliminer la clé privée en mémoire.

Fichiers à modifier :
- `src/utils/keystore.ts` → créer/charger un dWallet au lieu d'un keypair
- `src/utils/sui.ts` → remplacer `signAndExecuteTransaction` par `executeTransactionBlock` + signature Ika
- `src/utils/presign-pool.ts` → nouveau module (pool de presigns)
- Ajouter `IKA_SEED_SECRET` et `IKA_DWALLET_ID` dans `.env`

Complexité estimée : **2–3 semaines**

### v5 — Circuit breaker décentralisé (résilience)

**Objectif :** Fermeture d'urgence même si le bot est hors ligne.

Fichiers à modifier :
- `src/core/liquidation.ts` → ajouter `registerEmergencyClose()` après chaque ordre
- `src/core/hedging.ts` → appeler `onOrderPlaced()` après chaque exécution réussie
- Développer un Move module de vérification de marge (condition on-chain)

Complexité estimée : **3–5 semaines** (inclut le développement Move)

---

## 8. Ressources

| Ressource | URL |
|---|---|
| Documentation officielle Ika | https://docs.ika.xyz/docs/sdk |
| Repository GitHub | https://github.com/dwallet-labs/ika |
| Setup localnet | https://docs.ika.xyz/docs/sdk/setup-localnet |
| Primitives cryptographiques | https://docs.ika.xyz/docs/sdk/cryptographic-primitives |
| User Share Encryption Keys | https://docs.ika.xyz/docs/sdk/user-share-encryption-keys |
| Fonctions cryptographiques | https://docs.ika.xyz/docs/sdk/cryptography |
| npm package | https://www.npmjs.com/package/@ika.xyz/sdk |

---

*Document créé lors du développement du DeepBook Hedging Bot v3 — à reprendre pour v4/v5.*
