# AUDIT GLOBAL — Polymarket-bot (Up/Down 5m, paper trading)

> Audit en lecture seule. Aucun fichier hors `docs/rebuild/audit-global/` n'a été modifié.
> Tous les chiffres proviennent de commandes réellement exécutées (citées au fil du texte).
> Aucune valeur de clé n'est affichée (`.env*` : lecture seule, secrets `[REDACTED]`).

---

## 0. Méthode et périmètre

- Dépôt : `/root/clawd/Polymarket-bot`, suivi git, **333 fichiers** (`git ls-files | wc -l`).
- Point d'entrée runtime réel : **`bot-with-dashboard.ts`**, confirmé par PM2 :
  `ecosystem.config.cjs` → `script: 'bot-with-dashboard.ts'`, `interpreter: .../tsx`, nom `polymarket-paperbot`.
- Trace des imports : graphe de dépendances construit programmatiquement à partir de `bot-with-dashboard.ts`
  (résolution des `import ... from './...js'` → `.ts`), puis analyse des instanciations `new X(...)`.
- Le runtime charge `./src/index.js` (barrel), qui **ré-exporte tout** ; un module est donc
  « chargé » dès que le barrel l'importe, même s'il n'est jamais instancié. On distingue donc
  **chargé** (module évalué) et **instancié/appelé** (réellement utilisé).

---

## (a) CARTOGRAPHIE

### a.1 — Périmètre `src/` (runtime bot + SDK)

`src/` = **25 283 lignes** au total, dont **22 663 lignes runtime** (hors tests) et **2 458 lignes de tests**
(`find src -name '*.test.ts' | xargs wc -l` = 2458 ; `src` hors tests = 22663).

Tableau trié par lignes décroissantes (colonne « runtime » : atteint depuis `bot-with-dashboard.ts`) :

| Fichier | Lignes | Rôle réel (déduit du code) | Chargé | Instancié/appelé au runtime |
|---|---:|---|---|---|
| `src/services/dip-arb-service.ts` | 2563 | Moteur de stratégie DipArb (leg1/leg2, round 5m, `extends EventEmitter`). Commentaires en chinois (`暴跌套利`). | oui | **OUI** — `sdk.dipArb`, cœur du bot |
| `src/services/smart-money-service.ts` | 2277 | Copy-trading : suivi de wallets, leaderboard, rapport. | oui | **OUI** — `sdk.smartMoney` |
| `src/services/arbitrage-service.ts` | 1882 | Arbitrage multi-marchés, internes `RealtimeServiceV2`/`TradingService`/`GammaApiClient`. | oui | **OUI** — `new ArbitrageService({...})` (bot) |
| `src/services/realtime-service-v2.ts` | 1687 | Client WebSocket (CLOB + `crypto_prices`/chainlink) via `@polymarket/real-time-data-client`. | oui | **OUI** — `sdk.realtime`, instancié par arb |
| `src/services/market-service.ts` | 1663 | Résolution marché/tokenIds, scan crypto court terme, klines. | oui | **OUI** — `sdk.markets` |
| `src/clients/ctf-client.ts` | 1219 | Client on-chain CTF (split/merge/redeem, ethers). | oui | **OUI** — `new CTFClient(...)` (bot + services) |
| `src/clients/data-api.ts` | 1120 | Client REST Data-API Polymarket (positions, activity, leaderboard). | oui | **OUI** — `sdk.dataApi` |
| `src/services/wallet-service.ts` | 1080 | Agrégation wallets : positions, activity, PnL, fills subgraph. | oui | **OUI** — `sdk.wallets` |
| `src/services/swap-service.ts` | 896 | Swap/quote QuickSwap sur Polygon (ethers). | oui | **OUI** — `new SwapService(signer)` (bot) |
| `src/clients/bridge-client.ts` | 841 | Client bridge USDC↔USDC.e. **Seul importeur = `src/index.ts` (ré-export SDK).** | oui | **NON** — jamais `new BridgeClient()` dans le chemin runtime (seul `bot-config.ts` + doctests) |
| `src/services/dip-arb-types.ts` | 720 | Types/événements DipArb (dont `暴跌套利` en commentaire). | oui | oui (types) |
| `src/index.ts` | 630 | Barrel SDK + classe `PolymarketSDK` (instancie **tout**). | oui | **OUI** — `PolymarketSDK` utilisé |
| `src/clients/gamma-api.ts` | 627 | Client REST Gamma (marchés, events, trending). | oui | **OUI** — `sdk.gammaApi` |
| `src/services/trading-service.ts` | 622 | Envoi d'ordres CLOB (`@polymarket/clob-client`), clé privée. | oui | **OUI** — `sdk.tradingService` |
| `src/services/onchain-service.ts` | 609 | Façade on-chain (CTF + auth + swap). | oui | **OUI** — `new OnchainService({...})` (bot) |
| `src/core/types.ts` | 591 | Types partagés (+ `getBinaryTokens` jamais appelé). | oui | oui (types) |
| `src/clients/subgraph.ts` | 542 | Client GraphQL (fills, splits, merges, redemptions). | oui | **OUI** — `sdk.subgraph` |
| `src/deepseek-analyzer.ts` | 413 | Analyse marché via LLM (OpenCode-go / DeepSeek), fonctions module. | oui | **OUI** — `analyzeMarket`, `isEnabled` |
| `src/services/binance-service.ts` | 408 | Klines Binance (`klines`) pour tendances. | oui | **OUI** — `sdk.binance` |
| `src/services/authorization-service.ts` | 357 | Approbations/allowances ERC-1155. | oui | **OUI** — instancié par `OnchainService` |
| `src/dashboard/session-history.ts` | 333 | Persistance sessions (`session-history.json`) — 3 fonctions mortes (cf. b). | oui | partiel |
| `src/utils/price-utils.ts` | 307 | `getEffectivePrices`, tick sizes. | oui | **OUI** — appelé par `ArbitrageService` |
| `src/services/spot-price-service.ts` | 223 | Feed prix spot REST (Binance→Coinbase→Kraken), cache ~1 s. 3 exports morts. | oui | partiel — `getSpotPrice/primeSpotPrice/formatSpotPrice/isSpotCoin` utilisés |
| `src/dashboard/server.ts` | 204 | Serveur HTTP + WS dashboard (fonction `startDashboard`). | oui | **OUI** |
| `src/dashboard/types.ts` | 193 | Types dashboard (BotState, BotConfig, signaux). | oui | oui (types) |
| `src/core/unified-cache.ts` | 153 | Cache unifié (wrapper legacy + `CacheAdapter`). | oui | **OUI** — `createUnifiedCache` dans le SDK |
| `src/core/errors.ts` | 120 | `PolymarketError`, `ErrorCode`, `withRetry`. | oui | **OUI** |
| `src/core/cache-adapter-bridge.ts` | **94** | Pont legacy `Cache` ↔ `CacheAdapter`. **Aucun importeur.** | **NON** | **NON** |
| `src/dashboard/state-emitter.ts` | 91 | Émetteur d'état (typage `as any` ×2). | oui | **OUI** |
| `src/core/cache.ts` | 90 | Cache synchrone legacy (`Cache`, `CACHE_TTL`). | oui | indirect (importé par `unified-cache` + `binance-service`) |
| `src/core/rate-limiter.ts` | 86 | Rate limiter (`bottleneck`). | oui | **OUI** |
| `src/dashboard/index.ts` | 14 | Ré-export dashboard. | oui | **OUI** — `startDashboard`, `dashboardEmitter` |
| `src/__tests__/integration/…` (8 fichiers) | 2 067 | Tests d'intégration Vitest. | **NON** | **NON** (jamais exécutés en CI, cf. c) |
| `src/__tests__/test-utils.ts` | 170 | Helpers de test (10 exports jamais référencés hors du dossier). | **NON** | **NON** |
| `src/core/types.test.ts` | 146 | Test unitaire Vitest. | **NON** | **NON** |
| `src/utils/price-utils.test.ts` | 245 | Test unitaire Vitest. | **NON** | **NON** |

Résultat de l'analyse de reachability : **31 fichiers `src/` chargés**, **12 non atteints**
(8 tests d'intégration + `test-utils.ts` + `types.test.ts` + `price-utils.test.ts` + `cache-adapter-bridge.ts`).

### a.2 — Racine du dépôt (fichiers `.ts` + configs)

| Fichier | Lignes | Rôle réel | Runtime PM2 |
|---|---:|---|---|
| `bot-with-dashboard.ts` | **1889** | **Entrée runtime réelle** : boucle bot + dashboard + DipArb + SmartMoney + Arbitrage + LLM. | **OUI** |
| `bot-config.ts` | **931** | **Doublon d'entrée** : même `CONFIG`, autre boucle bot. **Importé par personne** (`rg "bot-config"` ne trouve que des commentaires/doctests). | **NON** |
| `diag-live.ts` | 47 | Sonde jetable (`// TEMP diagnostic script - à supprimer après usage`), se termine par `process.exit(0)`. | NON |
| `diag-ws.ts` | 35 | Sonde WS jetable (`// TEMP WS probe - à supprimer`), 30 s puis exit. | NON |
| `diag-ws-raw.ts` | 26 | Sonde WS brute jetable (`// TEMP raw WS probe - à supprimer`), 25 s puis exit. | NON |
| `ws-probe-tmp.ts` | 19 | Sonde WS jetable, 15 s puis exit. | NON |
| `vitest.config.ts` | 19 | Config Vitest (unitaires `src/**/*.test.ts`). | NON |
| `vitest.integration.config.ts` | 18 | Config Vitest (intégration `src/__tests__/integration/**`). | NON |
| `ecosystem.config.cjs` | — | Config PM2 (définit le runtime). | configuration |
| `repoinfo.md` | **31 791** | Dump de code généré (1,0 Mo, versionné). Pollution documentaire. | NON |

**Total racine `.ts` = 2 976 lignes** (`wc -l *.ts`) : 1889 + 931 + 47 + 35 + 26 + 19 + 19 + 18.

### a.3 — Hors runtime (développement / non exécuté par PM2)

- `scripts/**` : **10 942 lignes** `.ts` (14 sous-dossiers : api-verification 1183, arb-tests 1410, archive 1410, benchmark 1270, dip-arb 1003, smart-money 937, rescue 881, approvals 818, arb 610, verify 414, wallet 390, trading 223, research 166, deposit 91).
- `examples/**` : **2 506 lignes** (13 exemples SDK).
- `docs/backtest/**` + `tools/**` : **2 330 lignes** de Python (harness, resolve, reconcile, `edge_monitor.py`).
- `docs/**` : **143 fichiers** versionnés.
- `dist/`, `node_modules/`, `poly-sdk/` (gitlink), logs, `.bak-*` : non versionnés (`.gitignore`).

---

## (b) CODE MORT

### b.1 — Fichiers entièrement morts

| Fichier | Lignes | Inoffensif ? | Ressources consommées ? |
|---|---:|---|---|
| `src/core/cache-adapter-bridge.ts` | 94 | **Oui** (jamais importé, sauf mention dans `docs/archive/architecture-deep-dive.md`) | Aucune (jamais évalué) |
| `diag-live.ts` | 47 | Oui **si non exécuté** ; s'il est lancé, il instancie le SDK, appelle Binance/Gamma et ouvre un WS pendant 20 s | Oui, **à la demande seulement** |
| `diag-ws.ts` | 35 | idem | Ouvre un **WebSocket** (`RealTimeDataClient`), tient **30 s**, puis `process.exit(0)` |
| `diag-ws-raw.ts` | 26 | idem | Ouvre un **WebSocket brut** vers `wss://ws-live-data.polymarket.com/`, **25 s** |
| `ws-probe-tmp.ts` | 19 | idem | Ouvre un **WebSocket**, **15 s** |
| `bot-config.ts` | 931 | Oui (aucun import) | Aucune en PM2. **S'il est lancé** (`npx tsx bot-config.ts`, cf. son propre en-tête), il démarre un **second bot complet** en parallèle du bot PM2 → risque réel (trades en double) |

> Ces sondes sont **versionnées** (`git ls-files` les liste) alors que d'autres sont ignorées
> (`bot-with-dashboard.ts.bak-20260926-095944`, `.env.bak-*` : voir `git status --ignored`).
> Les sondes ne sont **pas appelées au runtime** : elles ne consomment rien tant que PM2 ne les charge pas.

### b.2 — Fonctions/constantes exportées jamais appelées

Référence croisée sur tout le dépôt (hors `docs`, `node_modules`, `dist`) :

| Symbole | Fichier:ligne | Lignes (approx.) | Inoffensif |
|---|---|---:|---|
| `saveHistory` | `src/dashboard/session-history.ts:125` | 14 | oui |
| `deleteSession` | `src/dashboard/session-history.ts:302` | 23 | oui |
| `clearHistory` | `src/dashboard/session-history.ts:325` | 9 | oui |
| `getCachedSpotPrice` | `src/services/spot-price-service.ts:202` | 5 | oui |
| `getSpotAgeMs` | `src/services/spot-price-service.ts:207` | 6 | oui |
| `spotStats` | `src/services/spot-price-service.ts:67` | ~10 | oui |
| `getBinaryTokens` | `src/core/types.ts:494` | ~28 | oui |
| `isDipArbLeg2Signal` | `src/services/dip-arb-types.ts:718` | ~3 | oui |
| `LegacyCacheAdapter` | `src/core/cache-adapter-bridge.ts` | — | oui (fichier entier mort) |
| `LegacyCacheWrapper` | `src/core/unified-cache.ts` | ~15 | oui |
| `mockGammaMarket`, `MockCache`, `MockRateLimiter`, `waitFor`… (10) | `src/__tests__/test-utils.ts` | — | oui (utilitaire de test orphelin) |
| Types jamais référencés : `TokenUnderlyingCorrelationCoefficients`, `BaseTrade`, `MarketServiceConfig`, `PolymarketSDKConfig`, `DipArbServiceEvents`, `LLMRecommendation`, `SpotPrice`… | `src/core/types.ts`, `src/services/*` | — | oui (types, zéro coût runtime) |

> `CATEGORY_COLORS` / `CATEGORY_LABELS` (`smart-money-service.ts:363` et `:376`) sont exportés sans référence externe (22 lignes de tables couleur/libellé non utilisées).
>
> **Aucun de ces symboles morts ne consomme d'intervalle, de socket ni de requête** : ce sont des
> fonctions pures ou des constantes, jamais invoquées. Le seul « code mort qui consomme » serait
> l'exécution manuelle des sondes (b.1) ou `bot-config.ts`.

### b.3 — Poids total du code mort

Périmètre « TypeScript racine + `src/` » = **25 647 lignes**
(2 976 racine + 22 663 src runtime + 8 configs racine regroupées).

| Bloc mort | Lignes |
|---|---:|
| `bot-config.ts` (entrée dupliquée non importée) | 931 |
| Sondes racine (`diag-live`, `diag-ws`, `diag-ws-raw`, `ws-probe-tmp`) | 127 |
| `src/core/cache-adapter-bridge.ts` (fichier mort) | 94 |
| Fonctions mortes dans fichiers vivants (b.2, approx.) | ~87 |
| **Total** | **~1 239** |

→ **≈ 4,8 %** du périmètre TypeScript racine+src (1 239 / 25 647).

Autres gisements non comptés ci-dessus (hors runtime, mais dans le dépôt) :
`scripts/**` 10 942 + `examples/**` 2 506 + Python outillage 2 330 + `repoinfo.md` 31 791 lignes de dump.

---

## (c) DOUBLONS ET INCOHÉRENCES

### c.1 — Deux systèmes de test concurrents (majeur)

| Système | Fichiers | Runner | Réellement exécuté ? |
|---|---|---|---|
| **A** — `src/**/*.test.ts` + `src/__tests__/integration/**` | 11 fichiers, **2 458 lignes** | **Vitest** (`vitest.config.ts` + `vitest.integration.config.ts`) | **NON en CI** |
| **B** — `tests/*.test.ts` | 6 fichiers, **343 lignes** | **`node:test`** via `tsx` | **OUI en CI** |

Preuves :
- `package.json` → `"test": "vitest run"` (donc `npm test` lance **uniquement A**).
- `.github/workflows/ci.yml` → `npx tsx --test tests/*.test.ts` (donc la CI lance **uniquement B**).

**Conséquence : aucun des deux systèmes n'est complet.**
`npm test` n'exécute jamais `tests/` ; la CI n'exécute jamais les 2 458 lignes Vitest ni les
`src/__tests__/integration/**` (qui appellent de vraies APIs). Deux configs Vitest
(`vitest.config.ts` 19 l., `vitest.integration.config.ts` 18 l.) pour un runner que la CI ignore.

**Lequel est utilisé ?** En CI (l'arbitre réel) : **B (`node:test`)**. `package.json` pointe vers **A**,
qui n'est donc validé que manuellement. C'est une incohérence à trancher, pas un simple doublon.

### c.2 — Deux cartes de cache

- `src/core/cache.ts` (90 l., `Cache` + `CACHE_TTL`) : legacy synchrone.
- `src/core/unified-cache.ts` (153 l., `UnifiedCache` / `LegacyCacheWrapper`) : **enveloppe** `Cache`.
- `src/core/cache-adapter-bridge.ts` (94 l., `LegacyCacheAdapter`) : **troisième** pont, **mort**.

Incohérence fine : `src/services/binance-service.ts` importe `CACHE_TTL` depuis `core/cache.js`
alors que **tous les autres** (`data-api`, `gamma-api`, `subgraph`, `market-service`, `wallet-service`,
`trading-service`) l'importent depuis `core/unified-cache.js` (qui le ré-exporte). Deux chemins
d'import pour la même constante.

**Utilisé réellement** : `unified-cache.ts` (`createUnifiedCache` dans le SDK) ; `cache.ts` sert de
brique interne ; `cache-adapter-bridge.ts` n'est jamais utilisé.

### c.3 — Deux calculs de PnL

- **PnL interne TS** : `bot-with-dashboard.ts` (`state.totalPnL`, `state.usdcEBalance`,
  `estimatedPnL = (exitPrice - entryPrice) * size`, `usdcEBalance = (PAPER_CAPITAL || 10000) + totalPnL`).
  Le dernier commit (`0eaddc3`) documente d'ailleurs **« PnL interne detruit »**.
- **PnL externe Python** : `tests/pnl-resolution.test.ts` teste `paperbot-pnl.py` (via
  `tests/harness_recap.py`, `PAPERBOT_SCRIPTS_DIR`, hors dépôt — `/root/.hermes/scripts`), qui lit
  `/root/.polymarket/history.json` et **résout** le PnL réel (gain = `(1/prix − 1) × mise`, perte = `−mise`).
- Le bot **écrit** `history.json` (`readFileSync`/`writeFileSync` sur `~/.polymarket/history.json`) ;
  le résolveur Python le **relit**. Il y a donc deux autorités PnL : l'état interne du bot et le
  résolveur externe.

**Utilisé réellement** : la CI et les tests s'appuient sur le **résolveur Python** (source de vérité
documentée dans `tests/pnl-resolution.test.ts`) ; le PnL interne du bot sert à l'affichage dashboard
et aux limites de risque, mais a un historique de fiabilité mauvais (commit `0eaddc3`). **À unifier.**

### c.4 — Services de prix en double (trois sources pour la même donnée)

- `src/services/spot-price-service.ts` (223 l.) : **polling REST** Binance → binance.vision → Coinbase → Kraken, cache ~1 s. Utilisé par `dip-arb-service`.
- `src/services/binance-service.ts` (408 l.) : `BinanceService` (klines) via `sdk.binance`. Utilisé pour les tendances.
- `src/services/realtime-service-v2.ts` (1687 l.) : WS `crypto_prices` / `crypto_prices_chainlink`.

Le commentaire d'en-tête de `spot-price-service.ts` reconnaît explicitement que le WS est tombé
(« ne renvoie plus AUCUN message », erreur serveur `relation "__subscriptions" does not exist`) et que
le REST est devenu la source principale, le WS restant « branché en optionnel non bloquant ».

**Utilisé réellement** : `spot-price-service.ts` (REST) pour le prix d'exécution ; `binance-service.ts`
pour les klines de tendance ; le WS polymarket en secours. Trois implémentations, deux formats de
symbole (`BTCUSDT` vs `BTC/USD`), une frontière floue.

### c.5 — Deux clients pour la même donnée « wallet activity »

`src/services/wallet-service.ts` interroge **à la fois** `DataApiClient` (`getPositions`,
`getActivity`, `getAllActivity`, `getTrades`, `fetchLeaderboard`) **et** `SubgraphClient`
(`getMakerFills`, `getTakerFills`, `getSplits`, `getMerges`, `getRedemptions`, `getOrderFilledEvents`).
Deux sources réseau pour recouvrir les mêmes activités on-chain/REST. **Les deux sont utilisées**,
mais la redondance multiplie les points de panne et les divergences (format d'événement différent).

### c.6 — Deux entrées de bot

`bot-with-dashboard.ts` (1889 l.) vs `bot-config.ts` (931 l.). Le code source dit lui-même :
`// CONFIGURATION (same as bot-config.ts)`. `bot-config.ts` n'est importé nulle part
(`rg "bot-config"` → uniquement commentaires, doctests, `dashboard/src/components/*.tsx` qui
affichent « Add wallets in bot-config.ts » / « Configuration loaded from bot-config.ts » —
**le dashboard renvoie vers un fichier mort**).

**Utilisé réellement** : `bot-with-dashboard.ts` (PM2). `bot-config.ts` = **doublon mort**, mais
runnable et trompeusement référencé par l'UI.

---

## (d) COHÉRENCE DE CONFIGURATION

### d.1 — Variables lues via `process.env`

- Occurrences `process.env.*` dans le runtime (`bot-with-dashboard.ts` + `bot-config.ts` + `src/`) : **73** (dont 38 dans `bot-with-dashboard.ts` seul).
- Variables **distinctes lues au runtime** : **34**.

`ARBITRAGE_ENABLED, BET_STAKE, CAPITAL_USD, DAILY_MAX_LOSS_PCT, DEEPSEEK_ANALYZER_ENABLED, DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_BASE_URL, DEEPSEEK_MAX_CALLS_PER_DAY, DEEPSEEK_MAX_TOKENS, DEEPSEEK_MIN_CONF, DEEPSEEK_MIN_TOKENS, DEEPSEEK_MODEL, DEEPSEEK_SESSION_ID, DEEPSEEK_TIMEOUT_MS, DIPARB_ENABLED, DRY_RUN, EDGE_FILTER_ENABLED, HOME, LEARN_COOLDOWN_AGE_H, MAX_DRAWDOWN_PCT, MONTHLY_MAX_LOSS_PCT, OPENCODE_GO_API_KEY, PAPER_CAPITAL, POLYGON_RPC_URL, POLYMARKET_PRIVATE_KEY, P_MIN_PRICE, P_STOP_LOSS, P_STRONG_MAX, P_STRONG_MIN, P_TAKE_PROFIT, SMARTMONEY_ENABLED, TOTAL_MAX_LOSS_PCT, TREND_ANALYSIS_ENABLED`

Variables lues **uniquement par les scripts** (hors runtime) : `COMPROMISED_KEY, POLY_PRIVATE_KEY, POLY_PRIVKEY, PRIVATE_KEY, RPC_URL, SAFE_ADDRESS, SAFE_KEY, WALLET_ADDRESS`.
Lues **uniquement par les tests** : `PAPERBOT_SCRIPTS_DIR`.

### d.2 — `.env.example` (24 clés documentées, valeurs `[REDACTED]`/placeholders)

`ARBITRAGE_ENABLED, CAPITAL_USD, DAILY_MAX_LOSS_PCT, DEEPSEEK_ANALYZER_ENABLED, DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MAX_CALLS_PER_DAY, DEEPSEEK_MAX_TOKENS, DEEPSEEK_MIN_CONF, DEEPSEEK_MIN_TOKENS, DEEPSEEK_MODEL, DEEPSEEK_TIMEOUT_MS, DIPARB_ENABLED, DRY_RUN, MAX_DRAWDOWN_PCT, MONTHLY_MAX_LOSS_PCT, POLYGON_RPC_URL, POLYMARKET_PRIVATE_KEY, P_MIN_PRICE, P_STRONG_MIN, P_TAKE_PROFIT, SMARTMONEY_ENABLED, TOTAL_MAX_LOSS_PCT, TREND_ANALYSIS_ENABLED`

### d.3 — Différentiel

**(i) Lues mais NON documentées dans `.env.example`** — au runtime (10) :

| Variable | Défaut codé en dur | Risque |
|---|---|---|
| `BET_STAKE` | `Number(process.env.BET_STAKE ?? '') || 1` | mise par trade masquée si absente |
| `P_STRONG_MAX` | `|| 0.65` | borne haute de la zone « strong » invisible |
| `P_STOP_LOSS` | `(… || 40) / 100` | stop-loss 40 % non documenté |
| `PAPER_CAPITAL` | `|| 10000` | capital fantôme 10 000 si non configuré |
| `LEARN_COOLDOWN_AGE_H` | `|| 6` | cooldown d'apprentissage non documenté |
| `EDGE_FILTER_ENABLED` | `?? 'false'` | filtre d'edge désactivé par défaut, invisible |
| `DEEPSEEK_BASE_URL` | chaîne en dur | endpoint LLM alternatif non documenté |
| `DEEPSEEK_SESSION_ID` | `|| 'paperbot'` | identifiant de session LLM non documenté |
| `OPENCODE_GO_API_KEY` | — | **secret** lu sans être déclaré dans `.env.example` |
| `HOME` | `|| '/root'` | bricolage de chemin, pas une vraie variable d'app |

Hors runtime, **non documentées aussi** : `COMPROMISED_KEY, POLY_PRIVATE_KEY, POLY_PRIVKEY, PRIVATE_KEY, RPC_URL, SAFE_ADDRESS, SAFE_KEY, WALLET_ADDRESS` (scripts) et `PAPERBOT_SCRIPTS_DIR` (tests).

**(ii) Documentées mais jamais lues** : **aucune** (0 sur 24). Les 24 clés de `.env.example` sont toutes lues quelque part — cohérence correcte sur ce point.

**(iii) Défauts codés en dur masquant une absence de configuration** (les plus préoccupants) :
- `P_STRONG_MIN`/`P_STRONG_MAX` : `|| 0.58` / `|| 0.65` — **paramètres de stratégie principaux** masqués par un défaut (non documentés pour `P_STRONG_MAX`).
- `P_MIN_PRICE` : `|| 0.25` ; `P_TAKE_PROFIT` : `|| 100` ; `P_STOP_LOSS` : `|| 40`.
- `CAPITAL_USD` : `|| '250'` dans `bot-with-dashboard.ts` **et** `bot-config.ts` ; `PAPER_CAPITAL` : `|| 10000` → **deux notions de capital avec deux défauts** (250 vs 10 000).
- `POLYGON_RPC_URL` : défaut public `https://polygon.drpc.org` répété dans **6 fichiers** (`ctf-client`, `swap-service` ×3, `authorization-service`, `onchain-service`, `arbitrage-service`, `bridge-client`) → un RPC public partagé par défaut si l'env manque.
- Secrets avec défaut vide (`DEEPSEEK_API_KEY` / `OPENCODE_GO_API_KEY` : `|| ''` chaîné) → l'absence de clé est silencieuse, pas d'erreur au démarrage.
- Ratio de risque codé en dur (non env) : `DAILY_MAX_LOSS_PCT || '0.05'`, `MONTHLY_MAX_LOSS_PCT || '0.15'`, `MAX_DRAWDOWN_PCT || '0.25'`, `TOTAL_MAX_LOSS_PCT || '0.40'` (documentés mais avec défauts implicites).

---

## (e) DETTES TECHNIQUES

| Catégorie | Nombre | Localisation |
|---|---:|---|
| `as any` (runtime `src/` + bot) | **11** | `bot-with-dashboard.ts` ×5 (`:winRate`, `estimatedProfitRate`, `curPrice`, `CONFIG[strategyName].enabled` ×2) ; `src/services/trading-service.ts` ×2 (`asset_type`) ; `src/core/unified-cache.ts` ×2 (`(this.adapter as any).set`) ; `src/dashboard/state-emitter.ts` ×2 (`status as any`) |
| `as any` (scripts) | 6 | `scripts/benchmark/run-all.ts` ×3, `ws-latency.ts` ×1, `order-latency.ts` ×1, `arb-tests/02-integration-tests.ts` ×1 |
| `as any` (sonde) | 1 | `diag-live.ts` ×1 |
| `@ts-ignore` / `@ts-expect-error` | **0** | — |
| `TODO`/`FIXME`/`XXX`/`HACK` | **1** | `src/services/spot-price-service.ts` (1 occurrence) — **dette de suppression quasi nulle, mais aussi faible traçabilité** |
| `catch` total (runtime) | 132 lignes | — |
| `catch` **silencieux** (corps = commentaire seulement) | **36** | surtout `bot-with-dashboard.ts` (ex. `} catch (err) { // Silent fail on interval to avoid log spam }`) ; `catch (e) { // Ignore market fetch errors… }` |
| `catch {}` totalement vide | **0** | — |
| `console.log/error/warn` exécutables (hors commentaires), `bot-with-dashboard.ts` + `bot-config.ts` + `src/` | **96** | dont `bot-config.ts` 47, `bot-with-dashboard.ts` 26, `src/**` ~23 |
| `console.*` exécutables (total avec tests) | **282** | les tests Vitest en concentrent 186 (sortie de debug d'appels réels d'API) |
| Fonctions de premier niveau dans `bot-with-dashboard.ts` | 22 | fichier monolithique de 1889 lignes |
| Valeurs magiques (heuristique littéraux numériques `bot-with-dashboard.ts`) | **94** | ex. `setInterval(updateBalances, 30000)`, `5 * 60 * 1000` (×5), seuils `0.58`, `0.65`, `0.25`, `100`, `40`, `6`, `10000`, plus ~17 grands littéraux/hex |

Nuance importante et honnête : dans `bot-with-dashboard.ts`, `console.log` est le **mécanisme de
sortie légitime** (bot console + fonction `log()`), ce ne sont pas tous des résidus. Les suspects
sont :
1. les 47 `console.log` de **`bot-config.ts`** (fichier mort) ;
2. les `console.*` restants dans les **fichiers bibliothèque** (`src/dashboard/server.ts` 7,
   `smart-money-service.ts` 4, `session-history.ts` 3, `dip-arb-service.ts` 3, `realtime-service-v2.ts` 2,
   `unified-cache.ts` 1, `data-api.ts` 1, `arbitrage-service.ts` 1) — **~22 logs sans logger structuré**.
   À noter : les gros comptes de `src/clients/*.ts` (8, 8, 6, 4) relevés par `rg -c` sont en réalité
   **dans les commentaires JSDoc** (`* console.log(...)`) et ne sont pas exécutables.

---

## (f) PLAN DE NETTOYAGE

Ordre du plus sûr au plus risqué. Gain = lignes retirées de la surface active.

### Étape 1 — Sondes racine jetables (risque : quasi nul)
- **Action** : supprimer `diag-live.ts`, `diag-ws.ts`, `diag-ws-raw.ts`, `ws-probe-tmp.ts`
  (les en-têtes disent eux-mêmes « à supprimer »).
- **Gain** : **127 lignes** ; supprime 4 lieux qui ouvrent des WebSockets/requêtes s'ils sont lancés.
- **Risque de régression** : ~0 (aucun importeur, aucun script `package.json`, absentes de la CI).

### Étape 2 — Fichier de cache mort (risque : quasi nul)
- **Action** : supprimer `src/core/cache-adapter-bridge.ts` ; vérifier que plus rien n'importe `cache-adapter-bridge`.
- **Gain** : **94 lignes** + une 3e implémentation de cache en moins.
- **Risque** : nul (`rg` ne trouve aucun importeur ; seul un doc d'archive le mentionne).

### Étape 3 — Fonctions et constantes mortes (risque : faible)
- **Action** : retirer `saveHistory`/`deleteSession`/`clearHistory` (`session-history.ts`),
  `getCachedSpotPrice`/`getSpotAgeMs`/`spotStats` (`spot-price-service.ts`),
  `getBinaryTokens` (`core/types.ts`), `isDipArbLeg2Signal` (`dip-arb-types.ts`),
  `LegacyCacheWrapper` (`unified-cache.ts`), les exports orphelins de `src/__tests__/test-utils.ts`.
- **Gain** : **~87 lignes** de code + `CATEGORY_COLORS`/`CATEGORY_LABELS` (~150 l. de données décorative non référencées).
- **Risque** : faible — à confirmer par `npx tsc --noEmit` après retrait (certains sont des exports publics du SDK ; ne retirer que si l'on assume la rupture d'API).

### Étape 4 — Documentation de configuration (risque : faible, mais impact comportemental)
- **Action** : ajouter à `.env.example` les 10 variables runtime non documentées
  (`BET_STAKE`, `P_STRONG_MAX`, `P_STOP_LOSS`, `PAPER_CAPITAL`, `LEARN_COOLDOWN_AGE_H`,
  `EDGE_FILTER_ENABLED`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_SESSION_ID`, `OPENCODE_GO_API_KEY` `[REDACTED]`,
  + `POLYMARKET_PRIVATE_KEY` déjà présente). Documenter explicitement les défauts codés en dur.
- **Gain** : fin du masquage de configuration ; **0 ligne de code retirée**, mais corrige la
  principale dette de cohérence (25 % des variables runtime sont invisibles).
- **Risque** : faible ; itérer un `.env` en activant un défaut caché (ex. `EDGE_FILTER_ENABLED`) change le comportement → déployer en `DRY_RUN` d'abord.

### Étape 5 — Unification des systèmes de test (risque : moyen)
- **Action** : trancher entre Vitest (A) et `node:test` (B). Aligner `package.json` (`"test"`) et
  `.github/workflows/ci.yml` sur le **même** runner ; soit migrer `src/**/*.test.ts` vers `node:test`,
  soit rétablir Vitest en CI et supprimer le doublon de config.
- **Gain** : élimine l'incohérence « CI ≠ `npm test` » (2 458 lignes de tests Vitest aujourd'hui non
  validées en CI) ; consolidation des 2 configs Vitest (37 lignes).
- **Risque** : moyen — les tests `src/__tests__/integration/**` appellent de **vraies APIs** (timeouts 60 s) ; à garder hors du job CI rapide ou à gater explicitement.

### Étape 6 — Unification du PnL (risque : élevé)
- **Action** : désigner **une** autorité PnL. Le résolveur Python (`paperbot-pnl.py` via
  `history.json`) est déjà la référence testée → faire du PnL interne du bot un simple
  affichage dérivé, ou le supprimer. Aligner `state.totalPnL`, `state.usdcEBalance`,
  `estimatedPnL`.
- **Gain** : supprime la 2e implémentation de PnL ; adresse le commit `0eaddc3` (« PnL interne detruit »).
- **Risque** : **élevé** — touche le risque (limites de perte) et le dashboard. À faire sous tests
  `tests/pnl-resolution.test.ts` verts + `DRY_RUN`.

### Étape 7 — Unification des prix (risque : élevé)
- **Action** : fondre `spot-price-service` (REST) et `binance-service` (klines) derrière une seule
  interface, un seul format de symbole ; statuer sur le WS `realtime-service-v2` (secours ou retrait).
- **Gain** : supprime la duplication de sources et les deux conventions `BTCUSDT` / `BTC/USD`.
- **Risque** : élevé — c'est le chemin chaud du DipArb (prix d'exécution). À faire avec
  un test de non-régression sur `getSpotPrice`/`primeSpotPrice`.

### Étape 8 — Retrait de `bot-config.ts` (risque : moyen)
- **Action** : supprimer `bot-config.ts` (931 l.) **et** corriger les 2 composants du dashboard qui
  affichent encore « Add wallets in bot-config.ts » / « Configuration loaded from bot-config.ts ».
- **Gain** : **931 lignes** + suppression d'un 2e bot runnable pouvant créer des trades en double.
- **Risque** : moyen — vérifier qu'aucun cron/script externe ne lance `npx tsx bot-config.ts`
  (non versionné dans le dépôt → **à confirmer côté exploitation**).

### Étape 9 — Hygiène logs et magie (risque : faible, mais transversal)
- **Action** : introduire un logger unique et migrer les ~22 `console.*` des modules `src/**` ;
  nommer les 94 valeurs magiques (`INTERVAL_*`, `THRESHOLD_*`) ; documenter les 36 `catch` silencieux
  (au minimum un compteur/log debug en `debug`).
- **Gain** : lisibilité, observabilité ; pas de ligne retirée mais forte réduction de dette.
- **Risque** : faible mais diffus — à découper par fichier.

### Étape 10 — Nettoyage documentaire / dépôt (risque : faible)
- **Action** : sortir `repoinfo.md` (31 791 l., 1,0 Mo de dump) du versionnement ou l'ignorer ;
  auditer les 143 fichiers `docs/**` et les dossiers `scripts/archive/**` (1 410 l.).
- **Gain** : dépôt plus léger, moins de distractions ; **~31 791 lignes** hors périmètre code.
- **Risque** : faible (documentaire uniquement).

---

## Synthèse chiffrée

- Périmètre TypeScript racine+`src/` : **25 647 lignes** ; `src/` runtime seul : **22 663**.
- Code mort identifié : **~1 239 lignes (~4,8 %)** — concentré sur `bot-config.ts` (931), les sondes (127) et un fichier de cache (94).
- **31/43** fichiers `src/` atteints au runtime ; **12 non atteints** (dont 11 fichiers de tests + 1 fichier de cache mort).
- **2 systèmes de test** mutuellement exclusifs CI (`node:test`, 343 l.) vs `npm test` (Vitest, 2 458 l.) : **incohérence majeure**.
- **2 calculs de PnL**, **3 sources de prix**, **3 implémentations de cache**, **2 clients wallet-activity**, **2 entrées de bot**.
- Config : **34** variables runtime lues vs **24** documentées ; **10 lues non documentées** (dont un secret, `OPENCODE_GO_API_KEY`) ; **0 documentées non lues** ; nombreux défauts codés en dur (`P_STRONG_MIN/MAX`, `P_MIN_PRICE`, `PAPER_CAPITAL`, `POLYGON_RPC_URL`).
- Dettes : **11 `as any`** runtime, **0 `TODO`**, **36 `catch` silencieux**, **~96 `console.*`** exécutables runtime, **94 valeurs magiques** dans le seul `bot-with-dashboard.ts`.
