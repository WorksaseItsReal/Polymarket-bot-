# AUDIT — `src/services/smart-money-service.ts` (2 277 lignes)

**Verdict en une phrase : DORMANT mais UTILE — c'est du code sain et inerte au runtime tant que `SMARTMONEY_ENABLED=false` (0 socket, 0 requête, 0 timer), dont la moitié construit des rapports d'analyse de wallet réutilisables ; la seule partie dangereuse est le copy-trading, qui contenait une écriture non gardée (`dryRun = false` par défaut → ordre réel malgré `DRY_RUN=true`) — corrigée dans cet audit. À CONSERVER tel quel, sans jamais l'activer en mode copie.**

---

## (a) Instanciation et démarrage au runtime

**Instancié : OUI. Démarré : NON.**

| Étape | Preuve |
|---|---|
| Classe exportée | `export class SmartMoneyService` — `smart-money-service.ts:680` |
| Instanciée à **chaque** démarrage du SDK | `this.smartMoney = new SmartMoneyService(this.wallets, this.realtime, this.tradingService, {}, this.dataApi)` — `src/index.ts:446-452` |
| Le bot charge bien ce SDK | `bot-with-dashboard.ts:15` → `import { PolymarketSDK, ... } from './src/index.js'` ; `bot-with-dashboard.ts:1600` → `const sdk = await PolymarketSDK.create({...})` |
| Script PM2 réel | `ecosystem.config.cjs:4` → `script: 'bot-with-dashboard.ts'` (nom `polymarket-paperbot`) |
| Démarrage effectif du service | `setupSmartMoney(sdk)` — `bot-with-dashboard.ts:619-623` : `if (CONFIG.smartMoney.enabled) { initializeSmartMoney(sdk); }` |
| Flag | `bot-with-dashboard.ts:67` → `enabled: process.env.SMARTMONEY_ENABLED !== 'false'` ; `.env:8` → `SMARTMONEY_ENABLED=false` ⇒ **`false`** ⇒ `initializeSmartMoney` jamais appelé |

### Consommation de ressources quand désactivé : **ZÉRO**

Le constructeur (lignes 694-710) ne fait que de l'affectation de champs :

```ts
constructor(walletService, realtimeService, tradingService, config = {}, dataApi?) {
  this.walletService = walletService;
  this.realtimeService = realtimeService;
  this.tradingService = tradingService;
  this.dataApi = dataApi ?? null;
  this.config = { minPnl: config.minPnl ?? 1000, cacheTtl: config.cacheTtl ?? 300000 };
}
```

- **Aucun `setInterval` dans tout le fichier** (grep : 0 occurrence). Un seul `setTimeout` (ligne 997), utilisé comme délai ponctuel avant un ordre — pas un minuteur persistant.
- Aucun socket possédé : la souscription WS est créée *à la demande* dans `subscribeSmartMoneyTrades` (lignes 817-826), jamais dans le constructeur.
- Aucune requête HTTP au constructeur. Tous les appels réseau sont « pull » (méthodes de rapport) ou déclenchés par la souscription WS.
- Seul coût : allocation de 2 structures vides (`Map`, `Set`) + un `Set` de handlers.

Le WebSocket **est** connecté au démarrage (`PolymarketSDK.create` → `start()` → `connect()` → `realtime.connect()`, `src/index.ts:514-525`), mais **pas à cause de Smart Money** : il sert `DipArbService` (`DIPARB_ENABLED=true`). La souscription « activité globale » propre à Smart Money ne s'ajoute que dans `subscribeSmartMoneyTrades`.

### Preuve runtime (logs réels)

`grep -n "Smart Money:" paperbot.log | tail -3` :

```
11162:2026-09-27T12:27:07:     Smart Money:  0 trades | 0 wallets
11596:2026-09-27T12:32:07:     Smart Money:  0 trades | 0 wallets
12274:2026-09-27T12:37:07:     Smart Money:  0 trades | 0 wallets
```

Ligne produite par `bot-with-dashboard.ts:1873`. `paperbot.error.log` : **0** occurrence de `SmartMoney`. Aucune erreur, aucun signal, aucune activité.

### Deux réserves honnêtes

1. **Le défaut est fail-open** : `SMARTMONEY_ENABLED !== 'false'` (`bot-with-dashboard.ts:67`) ⇒ si la variable disparaît du `.env`, le service s'active **automatiquement** au prochain redémarrage, avec souscription au flux d'activité global. À surveiller (fichier interdit en écriture, donc non corrigé).
2. Le dashboard expose un toggle qui appelle `initializeSmartMoney(sdk)` (`bot-with-dashboard.ts:1741-1748`) : une activation manuelle depuis l'UI déclencherait la souscription firehose sans redémarrage.

---

## (b) Inventaire réel : ce que le service fait

### API appelées

| Appel | Cible | Fréquence |
|---|---|---|
| `walletService.getLeaderboard(0, limit)` / `fetchLeaderboardByPeriod(...)` | Polymarket Data API (classement hebdo) | à la 1ʳᵉ demande / au cache expiré |
| `walletService.getWalletProfile(addr)` | `dataApi.getPositions` + `dataApi.getActivity(limit:100)` | par wallet inspecté |
| `walletService.getWalletActivity(addr, 100)` et `({start,end,limit:500})` | Data API | par rapport |
| `walletService.getUserPeriodPnl(addr, 'day'\|'week'\|'month'\|'all')` | Data API | **×4 en parallèle** par `getWalletReport` (lignes 1145-1148) |
| `dataApi.getClosedPositions(...)` | Data API, paginé | voir bornage ci-dessous |
| `realtimeService.subscribeAllActivity()` | WebSocket `activity/trades` **+** `activity/orders_matched`, **sans filtre** | une seule souscription partagée |

### Fréquence et limite de débit

- **Aucune boucle périodique dans le fichier.** Le service est événementiel (push WS) ou à la demande (pull HTTP). Aucun `setInterval`, aucun polling.
- Tout le HTTP passe par les clients partagés (`DataApiClient`, `GammaApiClient`) construits avec **un `RateLimiter` unique** (`src/index.ts:422-429`) : le débit est borné par le SDK, pas par ce service. Pas de retry agressif, pas de `fetch` direct.
- `getWalletReport` fait **7 appels en `Promise.all`** (7 requêtes simultanées, pas séquentielles) — c'est le pire cas unitaire du fichier.
- Démarrage (`initializeSmartMoney`, `bot-with-dashboard.ts:643-665`) : ~2 appels HTTP par wallet candidat + `await 300 ms` entre chaque, plafonné à **10 wallets qualifiés** (`:647`) ⇒ ~20 requêtes étalées sur ~3 s.

### Bornage des requêtes (vérifié)

- `fetchAllClosedPositions` (`:1959-1987`) : `maxIterations = 200`, `limit = 50` ⇒ **plafond dur à 10 000 positions**, sortie anticipée si page incomplète.
- `getLeaderboard` : `limit = Math.min(..., 500)` (`:1081`), `offset = Math.min(..., 10000)` (`:1083`).
- `getDailyReport` : `limit: 500` sur l'activité, `limit: 50` sur les positions closes.
⇒ **aucune requête non bornée.**

### Cache (et un bug latent)

`cacheTtl = 300 000` ms (5 min) et :

```ts
private isCacheValid(): boolean {
  return Date.now() - this.cacheTimestamp < this.config.cacheTtl && this.smartMoneyCache.size > 0;
}
```

**BUG LATENT (`:2264-2266`)** : si aucun wallet du leaderboard ne dépasse `minPnl` ($1 000), `smartMoneyCache` reste vide ⇒ `isCacheValid()` renvoie **toujours `false`** ⇒ chaque appel à `getSmartMoneyList()`, `isSmartMoney()` ou `getSmartMoneyInfo()` **refait un appel leaderboard**, sans jamais cacher. Un appelant qui boucle sur `await isSmartMoney(adresse)` obtiendrait une requête par itération. **Non amplifié dans le cas présent** : le chemin chaud du WS (`handleActivityTrade`, `:840-885`) n'utilise que `this.smartMoneySet` en mémoire — **zéro appel réseau par trade**. Documenté, non corrigé (hors périmètre : ce n'est ni une fuite ni une écriture).

### Ce qu'il produirait si on l'activait

1. Souscription au **flux d'activité global de Polymarket** (trades + orders_matched de tous les marchés, sans filtre serveur) — filtrage local en JS.
2. Sélection de **≤ 10 wallets** du top hebdo, filtrés sur `winRate ≥ 0.60`, `pnl ≥ minPnl`, `trades ≥ minTrades`.
3. Un **signal par trade détecté** poussé au dashboard (50 max conservés, `bot-with-dashboard.ts:692-695`) ; en paper, un `simulateTrade()` (`:708`).
4. **Rien d'autre côté bot** : la branche d'exécution live du bot est un placeholder vide (`bot-with-dashboard.ts:710-712`).

---

## (c) Risques concrets

### 🔴 R1 — Écriture non gardée (le seul risque sévère **réel**) — **CORRIGÉ**

Avant correction, `startAutoCopyTrading` (`:953`) :

```ts
const dryRun = options.dryRun ?? false;   // ← défaut = ordres RÉELS
```

et le chemin non-paper (`:1026`) :

```ts
result = await this.tradingService.createMarketOrder({ tokenId, side: trade.side, amount: usdcAmount, price: slippagePrice, orderType });
```

Or **`TradingService.createMarketOrder` (`src/services/trading-service.ts:359`) n'a AUCUNE garde `DRY_RUN`** — grep de `DRY_RUN|dryRun` dans `trading-service.ts` : **0 résultat**. Il appelle directement `client.createAndPostMarketOrder(...)` (~`:379`). Le `DRY_RUN=true` du `.env` n'est donc respecté par aucun maillon de cette chaîne : la sécurité « paper » reposait entièrement sur la discipline de l'appelant.

Preuve aggravante : `scripts/smart-money/06-real-copy-test.ts:13` contient `const DRY_RUN = false;  // 真实交易！` — un chemin d'ordres réels immédiatement exécutable dans le repo, indépendant du `.env`.

**Correctif appliqué** (fichier autorisé, plus bas §Fix) : opt-in explicite requis.

### 🟠 R2 — Souscription firehose non démontée si activée

Pas de fuite en l'état (aucun intervalle, aucun timer). Mais `disconnect()` (`:2268-2276`) est le seul point de nettoyage, appelé par `sdk.stop()` (`src/index.ts:550`) — **et `bot-with-dashboard.ts` n'appelle jamais `sdk.stop()`**. Si Smart Money était activé, la souscription au flux global survivrait à tout rechargement de code sans `unsubscribe`. Risque conditionné à l'activation. Non corrigé (le correctif appartient à `bot-with-dashboard.ts`, interdit).

### 🟡 R3 — Pas de timeout propre au service

`getWalletReport` (`:1141-1149`) agrège 7 appels dans un `Promise.all` sans `AbortSignal` ni course de timeout : un client HTTP lent bloque le rapport indéfiniment. Mitigation : dépend entièrement de `DataApiClient`/`GammaApiClient` (hors périmètre de ce fichier).

### 🟡 R4 — Bug de cache (voir §b) : amplification potentielle des appels leaderboard. Non corrigé.

### 🟡 R5 — Fuite de filtre entre abonnés

`subscribeSmartMoneyTrades` (`:817-826`) crée **une** souscription partagée en capturant les `options` du **premier** abonné. Un second abonné avec ses propres `filterAddresses` :
- reçoit les trades **sans son filtre** (les options du 1er s'appliquent à tous) ;
- hérite inversement du filtre du 1er pour ses propres signaux.

Impact limité : `startAutoCopyTrading` refait son propre test `targetAddresses.includes(...)` (`:962`) avant toute action ⇒ pas de trade hors cible. Bug de correction, pas de sécurité. Non corrigé.

### 🟢 R6 — Écriture impossible sans `tradingService`

Le service n'a **aucun accès direct** au CLOB ni à la clé privée : tout passe par `this.tradingService`. C'est la seule barrière architecturale — et elle était poreuse (cf. R1).

### 🟢 R7 — Confirmations négatives

- Pas de `setInterval` : aucune fuite par minuteur.
- Pas de boucle non bornée : pagination plafonnée (200 itérations).
- Pas de donnée fantôme : `handleActivityTrade` retourne tôt si `trade.trader?.address` absent (`:844-845`) ; le chemin d'ordre sort si `tokenId` absent (`:1002`). `winRate` utilisé par le bot existe réellement (`wallet-service.ts:269`).
- `paperbot.error.log` : 0 occurrence liée à SmartMoney.

---

## (d) Qualité de la stratégie « smart money » — franc

**Ce que le code fait réellement** : prendre le top du leaderboard **hebdomadaire par PnL**, filtrer sur `winRate ≥ 60 %`, `pnl ≥ seuil`, `trades ≥ minTrades`, puis copier proportionnellement (`sizeScale`) avec slippage borné et plafond par trade.

**Critique : copie de wallets sans edge démontrable.**

1. **Le critère de sélection est le PnL passé, pas un edge identifiable.** Le PnL hebdomadaire d'un leaderboard est dominé par le bruit et le biais de survie. À 50 % de win rate, rendre un `winRate ≥ 60 %` statistiquement significatif à 95 % demande **≈ 1 300 trades** ; avec un `minTrades` de l'ordre de quelques dizaines, le filtre « qualité » sélectionne surtout des chanceux, pas des compétents.
2. **Le `winRate` utilisé est faux comme track record.** `wallet-service.ts:269` le calcule sur les **positions courantes non réalisées** (`positions.filter(p => p.cashPnl > 0).length / positions.length`) — snapshot instantané d'un portefeuille ouvert, sur une fenêtre arbitraire, et non performance historique. Décider de copier un wallet sur cette base n'a pas de sens économique.
3. **Le `smartScore` maison est un score de notoriété, pas de compétence** (`:746`) : `pnl/100000*50 + volume/1000000*50` — il récompense le volume autant que le résultat.
4. **Latence incompatible avec l'edge visé.** Sur des marchés Up/Down à 5 minutes, la fenêtre d'arbitrage informationnel est de quelques centaines de millisecondes. Ici : réception du flux global → filtrage local JS → `delay` optionnel (`:997`) → passage par le `RateLimiter` CLOB partagé → `createAndPostMarketOrder`. La latence cumulée dépasse largement l'edge : on achète le prix **post-mouvement**, structurellement négatif après slippage.
5. **Aucune preuve empirique** : pas de backtest, aucun PnL réalisé du module dans le repo, les stats (`AutoCopyTradingStats`) sont purement runtime et remises à zéro à chaque démarrage.

**Verdict stratégie : à ne pas activer.**

**Mais** la seconde moitié du fichier est d'une autre nature : de **l'analyse de wallet** (`getWalletReport`, `compareWallets`, `getDailyReport`, `getLifecycleReport`, `getWalletChartData`, `generateTextReport`, `analyzeTradingStyle`, `assessRisk`, lignes ~1079-2263, soit **~1 200 lignes / 53 %**) : bornée, sans écriture, informative. C'est un outil de recherche légitime — et c'est aussi **l'API publique** du package (`src/index.ts:153-200` réexporte la classe + 35 types sous `@catalyst-team/poly-sdk`).

---

## (e) Peut-il ÉCRIRE en mode paper ?

**Dans le runtime actuel : NON.** Aucun chemin n'atteint `createMarketOrder` :

- Le **seul** appelant de `startAutoCopyTrading` dans `src/` est… lui-même (l'interface). Les appelants réels sont `scripts/smart-money/{04,05,06}.ts` et `bot-config.ts` — **fichier mort** : `grep -rn "bot-config"` ne trouve que des commentaires, aucun `import`.
- Dans `bot-with-dashboard.ts`, le callback de `initializeSmartMoney` (`:676-714`) appelle `simulateTrade(0, 'smartMoney', ...)` (`:708`) et la branche live est un **placeholder vide** (`:710-712`).
- `initializeSmartMoney` n'est atteignable que si `SMARTMONEY_ENABLED` ≠ `false` — c'est `false`.

**MAIS la garantie était fragile** : `TradingService.createMarketOrder` n'a aucune garde `DRY_RUN` (vérifié : 0 occurrence dans `trading-service.ts`) ⇒ la sécurité paper n'était portée par personne dans la chaîne d'appel. Un appelant omettant `dryRun` envoyait un ordre réel malgré `DRY_RUN=true`.

---

## (f) Recommandation

> **CONSERVER TEL QUEL, sans jamais l'activer en mode copie.** Le neutraliser serait une perte nette ; le supprimer est bloqué par une dépendance dans un fichier que je n'ai pas le droit de modifier.

**Argumentaire**

| Option | Coût | Bénéfice | Verdict |
|---|---|---|---|
| **Garder tel quel** | 0 requête, 0 socket, 0 timer en l'état (mesuré) ; allocation de 2 structures vides | 1 200 lignes d'analyse de wallet maintenues ; API publique du package préservée | ✅ **retenu** |
| **Neutraliser complètement** | casserait `scripts/smart-money/{01,03,04,05,06}.ts` | gain de sécurité déjà obtenu par le correctif R1 (fail-safe `dryRun`) | ❌ disproportionné |
| **Supprimer** | **24 références externes** dont `src/index.ts` (interdit en écriture) : `src/index.ts:153-200` réexporte la classe + 35 types ⇒ casse la compilation du SDK et du bot | aucun — le service est dormant | ❌ **à ne pas faire par moi** |

**Coût/bénéfice chiffré** : garder = 0 coût runtime mesuré (logs + grep), 0 régression, 0 édition de fichier interdit. Supprimer = ≥ 24 points d'édition répartis sur `src/index.ts`, `scripts/smart-money/*`, `dashboard/src/types.ts`, `docs/*` — pour un bénéfice nul puisque le code ne s'exécute pas. Le vrai risque (R1) est déjà neutralisé à la source.

**Si une activation était un jour envisagée**, les prérequis non négociables seraient : corriger R4 (cache vide) et R2 (`sdk.stop()` jamais appelé), et surtout **ne pas activer la copie** — seule la partie rapports/analyse mérite d'être appelée.

### Détail de la suppression (si décidée plus tard)

Fichiers à reprendre, par ordre de blocage :
1. `src/index.ts:153-200` — réexport de `SmartMoneyService` + 35 types (**bloquant**, fichier interdit en écriture pour moi).
2. `src/index.ts:389, 413, 446-452, 550` — import, champ public, instanciation, `disconnect()`.
3. `scripts/smart-money/{01-e2e,03-test-service,04-auto-copy-trading,05-auto-copy-simple,06-real-copy-test}.ts`.
4. `dashboard/src/types.ts` (`SmartMoneySignal`), `dashboard/src/components/SmartMoneyPanel.tsx`.
5. `bot-config.ts` (fichier mort, mais référence `startAutoCopyTrading`) et docs/README.

---

## Fix appliqué (fichier autorisé uniquement)

**Fichier** : `src/services/smart-money-service.ts` — seule modification, ligne ~953.

**Avant** :

```ts
const dryRun = options.dryRun ?? false;
```

**Après** :

```ts
// Fail-safe: un ordre réel ne peut partir qu'en opt-in EXPLICITE.
// - options.dryRun fourni  -> respecté tel quel
// - sinon DRY_RUN présent  -> lu depuis l'environnement (défaut: paper)
// - sinon                  -> paper (défaut sûr)
const dryRun = options.dryRun ?? (process.env.DRY_RUN !== 'false');

if (!dryRun) {
  console.warn('[SmartMoneyService] ⚠️ LIVE COPY TRADING: dryRun=false, des ordres RÉELS seront envoyés.');
}
```

**Justification** : supprime le seul risque sévère réel (écriture non gardée, R1). Le défaut devient *paper*, aligné sur `DRY_RUN=true` du `.env`. Les scripts qui optent explicitement (`scripts/smart-money/06-real-copy-test.ts`, `dryRun: DRY_RUN` avec `DRY_RUN = false`) conservent leur comportement — mais désormais avec un avertissement explicite en console. Aucun autre comportement modifié.

**Vérification** : `npx tsc --noEmit` → **exit 0**, aucune sortie.

> Note de traçabilité : entre deux exécutions de `tsc`, `src/services/dip-arb-service.ts` et `src/clients/ctf-client.ts` ont été modifiés en parallèle par un autre écrivain (mtimes 12:41:13 et 12:41:19, soit pendant la vérification), produisant transitoirement 6 erreurs `TS2339` (`leg1ProfitRate`, `logThrottled` non définis) — sans aucun rapport avec ce fichier. Après stabilisation de ces écritures concurrentes, `tsc --noEmit` revient à **exit 0** et `grep -c "smart-money-service"` sur la sortie de `tsc` donne **0**. Ces fichiers n'ont pas été touchés par cet audit.

## Ce que je n'ai PAS corrigé (et pourquoi)

| Point | Raison |
|---|---|
| R2 — `sdk.stop()` jamais appelé par le bot | le correctif appartient à `bot-with-dashboard.ts` (interdit en écriture) |
| R4 — cache invalidé quand aucun wallet > `minPnl` | inefficacité réseau, ni fuite ni écriture : hors du mandat de correction |
| R5 — fuite de filtre entre abonnés | sans impact de sécurité (garde `targetAddresses.includes` en aval) |
| Défaut fail-open `SMARTMONEY_ENABLED !== 'false'` | `bot-with-dashboard.ts:67`, interdit en écriture — signalé |
| `bot-config.ts` (fichier mort, ~900 lignes, non importé) | hors périmètre — signalé pour un audit ultérieur |
