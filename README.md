# Deepbook Hedging Bot v3

Bot de hedging **delta-neutral** sur [DeepBook V3](https://docs.deepbook.sui.io/) (réseau Sui).

## Nouveautés v2

| Amélioration             | Détail                                                                       |
|--------------------------|------------------------------------------------------------------------------|
| 🔐 Sécurité des clés     | Keystore chiffré AES-256-GCM (scrypt KDF) — plus de mnémonique en clair     |
| ✅ Simulation pre-envoi   | `dryRunTransactionBlock` avant chaque transaction réelle                     |
| 📊 Métriques Prometheus  | Endpoint `/metrics` + `/health` sur le port configurable                     |
| 🔔 Alertes               | Telegram & Discord (démarrage, erreurs, hedge exécuté, solde faible)         |
| 🧮 Delta précis          | Position + ordres ouverts + prix mid + vérification slippage                 |
| 🛡️ Gestion liquidation   | Circuit breaker, fermeture d'urgence, machine à états SAFE→WARN→CRITICAL→EMERGENCY |
| 🧪 Tests automatisés     | 60+ assertions Vitest sur hedging, config, delta, keystore, alertes, liquidation |

## Architecture

```
src/
├── index.ts              # Point d'entrée, orchestration, WebSocket, polling
├── config.ts             # Chargement et validation de la config .env
├── types.ts              # Types TypeScript & HedgingError
├── scripts/
│   └── create-keystore.ts  # CLI : création du keystore chiffré
├── core/
│   ├── hedging.ts        # Logique de hedging + vérif circuit breaker
│   ├── liquidation.ts    # Machine à états, circuit breaker, fermeture d'urgence
│   └── delta.ts          # Calcul précis du delta (position + ordres + prix)
└── utils/
    ├── sui.ts            # Clients Sui/DeepBook, initClients(), executeSafe(), dryRun
    ├── keystore.ts       # Chiffrement AES-256-GCM du mnémonique
    ├── pools.ts          # Chargement et résolution des pools DeepBook
    ├── metrics.ts        # Serveur HTTP Prometheus
    ├── alerts.ts         # Alertes Telegram & Discord
    └── logger.ts         # Logger structuré avec timestamp

tests/
├── hedging.test.ts       # Tests de la logique de décision
├── config.test.ts        # Tests du parsing de configuration
├── delta.test.ts         # Tests du calcul delta et slippage
├── keystore.test.ts      # Tests chiffrement/déchiffrement
└── alerts.test.ts        # Tests du système d'alertes
    └── liquidation.test.ts   # Tests de la gestion de liquidation
```

## Installation

```bash
git clone <repo>
cd deepbook-hedging-bot
npm install
cp .env.example .env
# Éditez .env avec vos valeurs
```

## Configuration de la sécurité (recommandé)

### Keystore chiffré (production)

```bash
# Crée un keystore.enc chiffré avec votre mnémonique
npm run keystore:create

# Supprimez ensuite MNEMONIC de votre .env
# Ajoutez KEYSTORE_PASSWORD dans .env (ou laissez vide pour invite interactive)
```

### Variables d'environnement clés

| Variable               | Défaut        | Description                                         |
|------------------------|---------------|-----------------------------------------------------|
| `KEYSTORE_PATH`        | `./keystore.enc` | Chemin du keystore chiffré                       |
| `KEYSTORE_PASSWORD`    | _(invite)_    | Mot de passe (vide = invite au démarrage)           |
| `MNEMONIC`             | —             | Fallback dev (⚠️ pas pour la production)            |
| `DELTA_THRESHOLD`      | `10`          | Seuil de delta pour déclencher un hedge             |
| `MAX_SLIPPAGE_PCT`     | `1.0`         | Slippage maximum accepté en %                       |
| `METRICS_ENABLED`      | `true`        | Active le serveur Prometheus                        |
| `METRICS_PORT`         | `9090`        | Port du serveur de métriques                        |
| `ALERT_TELEGRAM_TOKEN` | —             | Token du bot Telegram                               |
| `ALERT_DISCORD_WEBHOOK`| —             | URL du webhook Discord                              |
| `ALERT_MIN_SEVERITY`   | `warn`        | Niveau minimum d'alerte (`info`/`warn`/`critical`)  |
| `MARGIN_WARN_PCT`      | `30`          | Seuil d'avertissement de marge (%)                  |
| `MARGIN_CRITICAL_PCT`  | `20`          | Seuil d'activation du circuit breaker (%)           |
| `MARGIN_EMERGENCY_PCT` | `10`          | Seuil de fermeture d'urgence (%)                    |
| `CIRCUIT_BREAKER_ENABLED` | `true`    | Active le blocage des hedges en marge critique      |
| `EMERGENCY_CLOSE_ENABLED` | `true`    | Active la fermeture automatique d'urgence           |
| `CIRCUIT_BREAKER_RESET_PCT` | `40`    | Seuil de réarmement du circuit breaker (hysteresis) |

## Utilisation

```bash
# Compiler
npm run build

# Démarrer (production)
npm start

# Mode développement
npm run dev

# Lancer les tests
npm test

# Tests avec couverture
npm run test:coverage

# Vérification TypeScript
npm run typecheck
```

## Métriques Prometheus

Une fois le bot démarré, accédez aux métriques :

```
http://localhost:9090/metrics   # Prometheus scrape
http://localhost:9090/health    # Health check JSON
```

Métriques disponibles :

| Métrique                       | Type    | Description                            |
|--------------------------------|---------|----------------------------------------|
| `hedge_delta_current`          | gauge   | Delta courant par pool (unités base)   |
| `hedge_delta_priced_usd`       | gauge   | Delta valorisé en USD                  |
| `hedge_orders_total`           | counter | Ordres passés (labels: pool, action)   |
| `hedge_errors_total`           | counter | Erreurs (labels: pool, code)           |
| `hedge_consecutive_failures`   | gauge   | Échecs consécutifs courants            |
| `hedge_tx_duration_ms`         | gauge   | Durée de la dernière transaction       |
| `hedge_wallet_balance_sui`     | gauge   | Solde SUI du wallet                    |
| `hedge_cycle_last_timestamp`   | gauge   | Timestamp du dernier cycle réussi      |
| `hedge_margin_ratio`           | gauge   | Ratio de marge courant par pool        |
| `hedge_collateral_usd`         | gauge   | Collatéral disponible en USD           |
| `hedge_position_value_usd`     | gauge   | Valeur notionnelle de la position      |
| `hedge_emergency_closes_total` | counter | Fermetures forcées d'urgence           |
| `hedge_blocked_by_circuit_breaker` | counter | Cycles bloqués par le circuit breaker |

## ⚠️ Avertissements

- Tester **impérativement sur testnet** avant le mainnet (`SUI_ENV=testnet`)
- Le keystore chiffré doit être sauvegardé en lieu sûr (perte = perte d'accès au wallet)
- Ne jamais commiter `.env`, `*.enc`, ou tout fichier contenant des secrets
- Ce bot ne gère pas encore la liquidation — configurer le levier avec prudence
