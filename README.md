# Deepbook Hedging Bot

Bot de hedging **delta-neutral** sur [DeepBook V3](https://docs.deepbook.sui.io/) (réseau Sui).

## Fonctionnement

Le bot surveille en continu les positions ouvertes sur un ou plusieurs pools DeepBook. Lorsque le **delta** (position nette en base) dépasse un seuil configurable, il place automatiquement un ordre de marché dans le sens opposé pour neutraliser l'exposition.

```
Delta > +threshold  →  ordre SELL
Delta < -threshold  →  ordre BUY
|Delta| ≤ threshold →  rien
```

## Architecture

```
src/
├── index.ts          # Point d'entrée, boucle principale, WebSocket
├── config.ts         # Chargement et validation de la config .env
├── types.ts          # Types TypeScript & classe HedgingError
├── core/
│   └── hedging.ts    # Logique de hedging, cache delta, décision
└── utils/
    ├── sui.ts        # Client Sui, keypair, executeSafe() avec retry
    ├── pools.ts      # Chargement et résolution des pools DeepBook
    └── logger.ts     # Logger structuré avec timestamp
```

## Installation

```bash
git clone <repo>
cd deepbook-hedging-bot
npm install
cp .env.example .env
# Éditez .env avec vos valeurs (MNEMONIC, POOLS, etc.)
```

## Configuration

Voir `.env.example` pour toutes les options disponibles.

| Variable             | Défaut     | Description                                      |
|----------------------|-----------|--------------------------------------------------|
| `RPC_URL`            | mainnet   | URL du nœud Sui                                  |
| `MNEMONIC`           | —         | Phrase de 12 mots du wallet (⚠️ secret)          |
| `POOLS`              | —         | IDs ou paires symboliques des pools              |
| `DELTA_THRESHOLD`    | `10`      | Seuil de delta pour déclencher un hedge          |
| `ORDER_SIZE_BASE`    | `5`       | Taille de base d'un ordre                        |
| `LEVERAGE`           | `5`       | Multiplicateur de la taille d'ordre              |
| `CHECK_INTERVAL_MS`  | `30000`   | Fréquence du polling de secours (ms)             |
| `MAX_RETRIES`        | `3`       | Nombre de tentatives par transaction             |

## Utilisation

```bash
# Compiler
npm run build

# Démarrer
npm start

# Mode développement (sans compilation)
npm run dev

# Vérification TypeScript uniquement
npm run typecheck
```

## ⚠️ Avertissements

- Ne jamais commiter le fichier `.env` contenant votre mnémonique
- Tester **impérativement sur testnet** avant le mainnet
- Le levier amplifie les pertes — configurer avec prudence
- Ce bot ne gère pas (encore) le risque de liquidation
