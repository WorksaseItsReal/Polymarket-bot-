# AUDIT — Trading, Autorisation, Dashboard

- **Périmètre** : `src/services/trading-service.ts`, `src/services/authorization-service.ts`,
  `src/services/realtime-service-v2.ts`, `src/dashboard/**`, `src/utils/**`.
- **Date** : 2026-09-27
- **Mode d'exécution constaté** : `DRY_RUN=true` (`.env` ligne 2), `PAPER_CAPITAL=50` (ligne 51).
- **Méthode** : lecture du code + sondes d'exécution réelles (`tsx`) + `tsc --noEmit` + `vitest`.
  Aucune écriture hors des fichiers autorisés. Aucun `pm2 restart`.
- **Note sur les numéros de ligne** : ceux des fichiers que je modifie sont valides sur l'état
  livré. Ceux des fichiers **hors périmètre** (`bot-with-dashboard.ts`, `arbitrage-service.ts`,
  `dip-arb-service.ts`, `onchain-service.ts`, `smart-money-service.ts`, `dashboard/src/**`) ont été
  relevés pendant l'audit ; d'autres travaux en cours dans le dépôt peuvent les décaler.
- **Verdict** : 1 chemin d'envoi d'ordre non gardé au niveau du service (corrigé, §0/§1),
  1 fail-open latent d'autorisation (corrigé, §2), 1 jeu de risques de poller (corrigés, §3),
  2 chiffres faux côté dashboard non corrigeables dans mon périmètre (§4).

---

## ⚠️ 0. En TÊTE DE RAPPORT — chemins d'envoi d'ordre NON GARDÉS au niveau du service

**Constat principal (corrigé) : `TradingService` n'avait AUCUNE notion de mode paper.**
`src/services/trading-service.ts` (avant correctif) appelait directement
`client.createAndPostOrder(...)` (ligne 318 avant ; envoi désormais ligne 370) et
`client.createAndPostMarketOrder(...)` (ligne 379 avant ; envoi désormais ligne 434)
sans jamais consulter `DRY_RUN`, l'environnement, ni un verrou quelconque. Le fichier ne contenait
aucune occurrence de `paper` / `dryRun` / `PAPER` :

```
$ grep -n "PAPER\|paper\|isPaper\|DRY_RUN\|dryRun\|LIVE_TRADING" src/services/trading-service.ts
(aucun résultat)
```

Le blocage en paper reposait **entièrement sur les appelants**, via deux booléens :

| Appelant | Garde | Ligne (avant audit) |
|---|---|---|
| `bot-with-dashboard.ts` | `autoExecute: !CONFIG.dryRun && …` | 735 |
| `bot-with-dashboard.ts` | `enableRebalancer: !CONFIG.dryRun && …` | 736 |
| `bot-with-dashboard.ts` | `sdk.dipArb.updateConfig({ autoExecute: !CONFIG.dryRun })` | 808 |

Ces gardes protègent les boucles automatiques, **pas les méthodes publiques**. Les chemins suivants
envoient des ordres réels et ne sont pas gardés de façon interne :

1. `arbitrage-service.ts:716` — `async rebalance(...)` est **public** et appelle
   `createMarketOrder()` (lignes 758 et 771). La garde `enableRebalancer` n'agit qu'au niveau du
   `setInterval` (lignes 393-395) : un appel direct à `rebalance()` envoie un ordre réel.
2. `dip-arb-service.ts:645 / :810` — `executeLeg1()` / `executeLeg2()` sont **publics** et appellent
   `createMarketOrder()` (lignes 725 et 870). La garde `autoExecute` n'existe que dans
   `handleSignal()` (ligne 1882), **pas** dans ces méthodes.
3. `dip-arb-service.ts:1472` — `emergencyExitLeg1()` (`createMarketOrder` SELL, ligne 1504).
4. `dip-arb-service.ts:2547` — `settleBySell()` (`createMarketOrder` SELL, lignes 2565 et 2581).
5. `smart-money-service.ts:1034` — `createMarketOrder()`.

**Deuxième constat : le SDK est construit avec une clé privée MÊME en DRY_RUN.**

```
$ grep -n "PolymarketSDK.create" -A2 bot-with-dashboard.ts
1600:  const sdk = await PolymarketSDK.create({
1601:    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
```

`src/index.ts:433-437` câble ce `TradingService` dans `sdk.dipArb` (`src/index.ts:455-461`). Autrement
dit : si un opérateur place une **vraie** clé dans `.env` en laissant `DRY_RUN=true`, la seule chose
qui empêche un ordre réel est le booléen `autoExecute=false`. La protection actuelle de cette
configuration repose donc sur un unique booléen côté appelant — et, accidentellement, sur le fait que
la clé `0x0000…` de `.env` n'est pas enregistrée auprès du CLOB (l'`initialize()` échouerait), ce qui
est une protection **fortuite, pas conçue**.

**Correctif appliqué** : verrou paper ajouté *dans* `TradingService`, fail-closed, en tête de chaque
chemin d'écriture (§1).

**Reste hors périmètre de ce correctif** (fichiers non modifiables) : les 5 méthodes publiques listées
ci-dessus ne consultent toujours pas ce verrou pour l'exécution — mais elles passent désormais
obligatoirement par `TradingService`, qui refusera l'ordre en paper. La défense est donc descendue au
bon niveau, même si les gardes d'appelant restent souhaitables.

---

## 1. `trading-service.ts` — un ordre RÉEL peut-il partir ?

### 1.1 Chemins d'envoi d'ordre recensés

| # | Méthode | Ligne (après correctif) | Appel réseau réel |
|---|---|---|---|
| 1 | `createLimitOrder` | 340-341 (garde) | `createAndPostOrder` |
| 2 | `createMarketOrder` | 412-413 (garde) | `createAndPostMarketOrder` |
| 3 | `cancelOrder` | 471-472 | `cancelOrder` |
| 4 | `cancelOrders` | 490-491 | `cancelOrders` |
| 5 | `cancelAllOrders` | 509-510 | `cancelAll` |
| 6 | `updateBalanceAllowance` | 653-654 | `updateBalanceAllowance` (écriture) |

Méthodes **lecture seule** (non gardées, volontairement) : `getTickSize`, `isNegRisk`,
`getOpenOrders`, `getTrades`, `isOrderScoring`, `areOrdersScoring`, `getEarningsForDay`,
`getCurrentRewards`, `getBalanceAllowance`, `getAddress`, `getWallet`, `getCredentials`.

### 1.2 Garde ajoutée (fail-closed)

```ts
// lignes 179-180 et 190
private paperMode: boolean;
…
this.paperMode = config.paperMode ?? (process.env.DRY_RUN !== 'false');
```

Le défaut est **fermé** : toute valeur de `DRY_RUN` autre que la chaîne exacte `'false'` — absente,
vide, `'true'`, `'TRUE'`, `'0'` (faute de frappe) — maintient le service en paper. C'est le même
prédicat que le bot (`bot-with-dashboard.ts:142 : dryRun: process.env.DRY_RUN !== 'false'`), donc pas
de divergence de sémantique.

La garde est placée **avant** les validations métier et avant tout `ensureInitialized()`, donc avant
toute authentification réseau :

```ts
async createLimitOrder(params: LimitOrderParams): Promise<OrderResult> {
  if (this.paperMode) return this.paperBlock('createLimitOrder');   // ligne 341
  if (params.size < MIN_ORDER_SIZE_SHARES) { … }
```

```ts
async createMarketOrder(params: MarketOrderParams): Promise<OrderResult> {
  if (this.paperMode) return this.paperBlock('createMarketOrder');  // ligne 413
```

Le contrat `OrderResult` est respecté (pas de changement de signature pour les consommateurs) :
`{ success: false, errorMsg: '[PAPER MODE] …' }`.

### 1.3 Preuve d'exécution (sonde réelle)

```
=== (a) TradingService : garde paper ===
process.env.DRY_RUN = undefined
isPaperMode() = true
✅ createLimitOrder refusé — [PAPER MODE] createLimitOrder refusé — exécution réelle désactivée. Aucun ordre n'a été envoyé au CLOB (DRY_RUN != 'false').
✅ createMarketOrder refusé — [PAPER MODE] createMarketOrder refusé — exécution réelle désactivée. Aucun ordre n'a été envoyé au CLOB (DRY_RUN != 'false').
✅ aucune initialisation réseau déclenchée
✅ paperMode:false lève bien la garde (validation atteinte)
✅ garde = SEUL obstacle : en live on atteint la validation métier — Order size (1) is below Polymarket minimum (5 shares)
```

Lecture : `DRY_RUN` **absent** ⇒ `isPaperMode()===true` (fail-closed démontré). `isInitialized()===false`
après les deux appels ⇒ **aucune** dérivation/clé API, donc aucun chemin réseau déclenché. Enfin, avec
`paperMode:false`, le service atteint bien la validation métier — ce qui prouve que le verrou est le
**seul** obstacle en paper et qu'il ne masque pas un autre refus.

---

## 2. `authorization-service.ts` — que protège-t-il, et que se passe-t-il si c'est absent/corrompu ?

### 2.1 Ce que le service protège réellement

Ce n'est **pas** un garde-fou de trading. C'est un service d'**approbations on-chain** :

- `checkAllowances()` (ligne 128) : lecture seule. Interroge le solde USDC et les allowances ERC20
  (4 dépensiers : CTF Exchange, Neg Risk CTF Exchange, Neg Risk Adapter, Conditional Tokens) puis les
  approbations ERC1155 (3 opérateurs). Retourne `tradingReady` et `issues`.
- `approveAll()` (ligne 243) : **écriture on-chain réelle** — 4 `approve(MaxUint256)` + 3
  `setApprovalForAll(true)`, `tx.wait()`.

Il n'existe **aucun état persistant** : chaque appel relit la chaîne. Le mode d'échec « état local
corrompu » est donc structurellement impossible ici. En revanche deux modes d'échec existent.

### 2.2 Échec n°1 — un `tradingReady` FAUX-POSITIF si les listes de contrôle sont vides

Avant correctif :

```ts
const tradingReady = issues.length === 0;   // ancienne ligne 178
```

`issues` est alimenté par deux boucles sur `ERC20_SPENDERS` / `ERC1155_OPERATORS`. Si une liste est
vide (constante vidée par erreur, refactor, injection), les boucles ne font rien, `issues` reste vide
et `tradingReady` vaut **`true` alors que RIEN n'a été vérifié**. C'est exactement le mode d'échec
« autorisation absente = autorisation ouverte ». Non déclenché aujourd'hui (les constantes sont
non vides), mais latent.

Idem pour `approveAll()` : `allApproved` utilisait `every()` sur deux tableaux — `[].every(...)`
renvoie `true`. Sur listes vides, `allApproved === true` avec zéro approbation posée.

### 2.3 Échec n°2 — l'exception, et ce qu'en font les consommateurs

Avant correctif, toute erreur provider faisait **lever** `checkAllowances()`. Les consommateurs
n'en font rien de bloquant :

```
bot-with-dashboard.ts
1082:      const status = await onchain.checkAllowances();
1083:      if (!status.tradingReady) {
1084:        log('WARN', 'Missing approvals:', status.issues);
1085:        log('WARN', 'Enable onchain.autoApprove=true to fix automatically');
1090:  } catch (err) {
1091:    log('WARN', `Onchain setup error: ${(err as Error).message}`);
```

Un échec de vérification produisait donc un simple `WARN` puis le bot **continuait**. Le service doit
donc rendre le refus explicite dans sa *valeur de retour*, pas dans une exception.

### 2.4 Correctifs (fail-closed)

- Chaque sonde est encapsulée dans un `try/catch`. Un échec ⇒ entrée `approved: false` **et** une
  issue explicite (`ERC20: vérification <nom> impossible — <cause>`, lignes 171 et 191). Jamais
  « approved par défaut ».
- `tradingReady` reste `issues.length === 0` mais `issues` ne peut plus être vide par accident :
  garde anti-état vide/incomplet (lignes 195-207) qui compare le nombre d'entrées produites au nombre
  de cibles attendues.
- `checkAllowances()` ne lève plus : l'appelant reçoit toujours un objet exploitable, donc son
  `if (!status.tradingReady)` existant devient effectivement actif.
- `approveAll()` (lignes 326-332) : `allApproved` exige désormais des listes non vides et de longueur
  complète.
- Messages d'erreur bornés (`errMsg`, 200 car.) pour éviter les dumps ethers de plusieurs Ko.

### 2.5 Preuve d'exécution (RPC injoignable, `127.0.0.1:9`)

```
=== (b) AuthorizationService : fail-closed ===
✅ checkAllowances ne lève pas (résultat exploitable)
✅ tradingReady = false quand tout échoue
✅ issues documentent l’échec — n=15
✅ aucune allowance marquée "approved" par défaut
✅ chaque sonde en échec est tracée explicitement
  exemple issue: ERC20: lecture du solde USDC impossible — could not detect network (event="noNetwork", code=NETWORK_ERROR, version=providers/5.8.0)
```

Pan complet : `tradingReady === false` et 15 issues. **Fermé sur échec : confirmé.**

### 2.6 Limites (non corrigées, hors périmètre)

- `onchain-service.ts:374` appelle `ctfClient.checkReadyForCTF(amount)` **avant** l'auth (ligne 377) :
  si cet appel lève, la branche fail-closed de l'auth n'est jamais atteinte. À corriger par le
  propriétaire de `onchain-service.ts`.
- `approveAll()` reste une écriture on-chain réelle ; elle n'est heureusement jamais atteinte en
  DRY_RUN car `bot-with-dashboard.ts:1054` fait `if (!CONFIG.onchain.enabled || CONFIG.dryRun) return;`.
  À noter explicitement dans la doc opérateur.
- `checkAllowances` ne vérifie pas les **tokens conditionnels par marché** (une allowance ERC1155 est
  globale, donc c'est correct), mais ne vérifie pas non plus la version du contrat CTF (`CTF_CONTRACT`
  importé de `ctf-client.ts`) — dépendance externe non auditée ici.

---

## 3. `realtime-service-v2.ts` — contrat `emit('orderbook')` et poller REST

### 3.1 Contrat — comparé à ce que lisent les consommateurs (lecture seule)

**Forme émise** (définie par `OrderbookSnapshot extends Orderbook`, lignes 66-79 ; produite par
`fetchRestBook()` l. 1590-1640 puis `emitOrderbook()` l. 1379) :

`{ tokenId, assetId, market, bids, asks, timestamp, tickSize, minOrderSize, hash }`
avec `bids`/`asks` = `Array<{price:number, size:number}>`, `timestamp` en **millisecondes**.

**Ce que lisent les consommateurs** :

| Consommateur | Champs lus | Ligne |
|---|---|---|
| `dip-arb-service.ts` `handleOrderbookUpdate` | `book.tokenId`, `book.asks[].price/.size`, `asks[0]` = meilleur ask | 1081, 1087-1089, 1096-1097 |
| `arbitrage-service.ts` `onOrderbook` | `book.assetId`, `book.bids`, `book.asks`, `book.timestamp` | 413-421 |
| `arbitrage-service.ts` `handleBookUpdate` | trie lui-même les asks croissant / bids décroissant | 1331-1340 |

**Vérification par exécution réelle** (abonnement REST sur un vrai marché, capture du premier
`emit('orderbook')`) :

```
tokenId      : 104234691144658675233239154305042378989162815575068315543558965041885492668312
RAW asks[0..2]  : [{"price":"0.99","size":"28030"},{"price":"0.98","size":"24025"},{"price":"0.97","size":"1000"}]
RAW bids[0..2]  : [{"price":"0.01","size":"29640.37"},{"price":"0.02","size":"11500"},{"price":"0.03","size":"1025"}]

--- emit('orderbook') ---
keys         : asks,assetId,bids,hash,market,minOrderSize,tickSize,timestamp,tokenId
tokenId      : 104234691144658675233239154305042378989162815575068315543558965041885492668312
assetId      : 104234691144658675233239154305042378989162815575068315543558965041885492668312 | identical: true
market       : 0xf44ade6df83c8d227bfa92d193f9ea6c820d5377ace87b0f01b836ad3d6c7bb2
tickSize     : 0.01 | minOrderSize: 5
timestamp ms : 1790512803681 | plausible: true
typeof price : number number
asks ascending (asks[0]=meilleur ask) : true
bids descending(bids[0]=meilleur bid): true
normalized asks[0..2]: [{"price":0.49,"size":42389.33},{"price":0.5,"size":102203.94},{"price":0.51,"size":6381}]

champs requis par dip-arb (book.tokenId, book.asks[].price/size) + arbitrage (book.assetId,bids,asks,timestamp):
manquants : AUCUN ✅
```

Conclusions chiffrées :

- **L'API REST renvoie les asks du PLUS CHER au moins cher** (`0.99, 0.98, 0.97`) — c'est le piège
  classique. Le poller trie correctement (`bids` décroissant l. 1620, `asks` croissant l. 1623),
  donc **`asks[0]` est bien le meilleur ask**, ce dont `dip-arb-service.ts:1096` dépend directement.
- `tokenId` **et** `assetId` sont renseignés et identiques (l. 1630-1631), donc les deux
  consommateurs qui utilisent des noms de champ différents sont servis.
- `timestamp` normalisé en ms (`normalizeTimestamp`, l. 1692) — cohérent avec `arbitrage-service` qui
  stocke `orderbook.lastUpdate = Date.now()`.
- Pas de changement de forme par rapport à l'ancien chemin WS : `parseOrderbook()` (l. 1287) et
  `fetchRestBook()` produisent la même structure, `emitOrderbook()` est **le seul point d'émission**
  (l. 1379 ; 1370 avant édition).

**Où le contrat pourrait se casser silencieusement** (à surveiller, non corrigé car hors de ma portée) :
`emitOrderbook` déduplique sur `hash`. Si l'API renvoyait un `hash` **constant** par token alors que
le carnet bouge, plus aucune frame ne serait émise et les consommateurs verraient une donnée figée.
Testé ici : le champ `hash` est bien présent et distinct par carnet observé. À noter que si `hash`
**manquait**, la dédup est désactivée (émission à chaque poll) — comportement sûr.

### 3.2 Le poller REST peut-il s'emballer ? (avant / après)

| Risque demandé | État initial | Verdict |
|---|---|---|
| **Intervalles empilés** | Non : `scheduleRestPoll()` (l. 1483) n'est appelé qu'à la **fin** d'une passe (`restPollOnce`), et `ensureRestPoller()` (l. 1476) sort si `restPollTimer` non nul. Un seul `setTimeout` vit à la fois. | ✅ sain |
| **Requêtes concurrentes non bornées** | **Oui.** `await Promise.all(tokens.map(...))` lançait 1 requête **par token, en parallèle**, sans plafond. | ❌ → corrigé |
| **Fuite mémoire** | **Oui.** `bookCache`, `priceCache`, `lastTradeCache` n'étaient jamais purgés : `unsubscribeAll()` vidait `restTokens`/`orderbookLastHash` mais pas ces 3 caches ; `removeRestTokens()` non plus. À chaque rotation de marché (5-15 min), 2 entrées s'ajoutaient définitivement. | ❌ → corrigé |
| **Arrêt propre du process** | Partiellement : le timer est `unref()` (l. 1492) donc il ne bloque pas la sortie du process ; `disconnect()` appelait `stopRestPoller()`. **Mais** le `setTimeout` de la sonde WS n'était pas annulé dans `disconnect()`. | ⚠️ → corrigé |
| **Arrêt du poller sur exception** | `void this.restPollOnce()` (l. 1489) sans `.catch` : une exception **hors** du `try/catch` par token ferait que `scheduleRestPoll()` ne serait jamais rappelé ⇒ poller mort **définitivement et silencieusement**. | ❌ → corrigé |

Correctifs :

1. **Concurrence bornée** (l. 1518-1548) — pool de `restMaxConcurrency` travailleurs (défaut 8, nouveau
   réglage `RealtimeServiceConfig.restMaxConcurrency`, l. 58-63 / 292 / 353) sur une file partagée.
   Les passes ne s'empilent toujours pas : la suivante est planifiée à la fin de celle en cours.
2. **Réordonnancement garanti** (l. 1552) — toute la fin de passe (backoff + `scheduleRestPoll`) est
   passée dans un `finally`.
3. **Purge mémoire** (l. 1465-1469 et 1026-1029) — suppression des entrées `bookCache`/`priceCache`/
   `lastTradeCache` quand un token n'est plus référencé, purge complète dans `unsubscribeAll()`.
4. **Arrêt propre** (l. 386-392) — `disconnect()` annule aussi `wsProbeTimer`.
5. **Observabilité** (l. 1659-1673) — `getDataFeedStats()` expose désormais `bookCacheSize` et
   `priceCacheSize` pour détecter une fuite en production.

### 3.3 Preuve d'exécution

```
=== (c) Poller REST : concurrence bornée + arrêt propre ===
tokens abonnés: 4
✅ concurrence bornée à 2 (jamais dépassée) — maxInFlight=2
✅ le poller a réellement tourné — requêtes=16
✅ pas d’empilement : un seul timer
✅ caches peuplés puis purgés — bookCache=4
✅ unsubscribeAll purge les caches
✅ unsubscribeAll stoppe le poller
✅ disconnect() stoppe toute requête ultérieure — +0
timer actif après disconnect: false
🎉 TOUTES LES VÉRIFICATIONS PASSENT
```

La concurrence est mesurée en instrumentant `globalThis.fetch` (compteur en vol, max observé) :
avec 4 tokens abonnés et `restMaxConcurrency: 2`, le maximum de requêtes simultanées reste **2**
(avant correctif il aurait été **4**). Après `disconnect()`, aucune requête supplémentaire en 2,5 s.

### 3.4 Point d'hygiène observé mais NON corrigé

Pendant la sonde, `disconnect()` alors qu'une connexion WS était encore en cours a produit un
`error ErrorEvent … 'WebSocket was closed before the connection was established'` émis par
`@polymarket/real-time-data-client` (`client.disconnect()` → `ws.close()`). Le process n'est **pas**
tué (aucun `Unhandled 'error' event` fatal ici), mais le bruit est réel. Correctif possible côté
client (`_closeCode 1006`) — hors de ce service et hors de mon périmètre d'écriture.

---

## 4. `src/dashboard/**` — le dashboard affiche-t-il des chiffres qui existent ?

### 4.1 Constat majeur : l'historique de session n'est JAMAIS écrit

```
$ grep -rn "createSessionFromState|addSession" bot-with-dashboard.ts
24:import { addSession, createSessionFromState, type TradeRecord } from './src/dashboard/session-history.js';
```

`addSession` et `createSessionFromState` sont **importés mais jamais appelés**. Conséquence :

- `data/session-history.json` n'est jamais créé ⇒ `GET /api/history` (`src/dashboard/server.ts:83-86`)
  renvoie toujours `{sessions: [], totalSessions: 0, totalProfit: 0, totalTrades: 0, overallWinRate: 0}`.
- La page **Session History** affiche donc systématiquement l'état vide « No Sessions Yet ».
- `dashboard/dist/` **n'existe pas** ⇒ `startDashboard()` retombe sur le SPA-fallback
  (`server.ts:131-137`) et renvoie **404** pour `/` (le fichier `index.html` est absent). Vérifié :

```
$ ls -la dashboard/dist
ls: cannot access 'dashboard/dist': No such file or directory
```

Le dashboard n'est donc pas buildé : seules les routes `/api/*` et `/health` répondent. Ce n'est pas
une régression introduite ici, mais l'état actuel mérite d'être signalé (un « dashboard » qui ne sert
que du JSON).

### 4.2 Chiffres affichés mais jamais calculés — **faux-PnL / fausses stats côté frontend**

⚠️ Ces fichiers sont dans `dashboard/src/**`, **hors de la liste de fichiers modifiables**
(`src/dashboard/**`). Je ne les ai **pas** modifiés ; correctifs proposés ci-dessous.

**a. Taux de victoire inventé** — `dashboard/src/components/QuickStats.tsx:23`

```ts
const winRate = trades > 0 ? Math.min(100, Math.max(0, 50 + (realizedPnL / (trades * 2)))) : 0;
```

Il n'existe **aucun** calcul de win-rate dans le projet (pas de compteur de gains/pertes total dans
`BotState`). Cette formule fabrique `50 % + PnL/(2·trades)` et l'affiche sous le libellé **« Win Rate »**.
Un bot à 100 % de défaites affichera > 50 % dès que le PnL cumulé est positif. **C'est un chiffre
faux**, et c'est exactement le « dashboard qui montre un PnL faux » qui est pire que pas de dashboard.

**b. Win-rate à 0 %** — `dashboard/src/components/HistoryPage.tsx:202-205` et `409-411`

`session.winRate` est calculé dans `session-history.ts:220` à partir du paramètre `trades`. Or
`recordTrade()` (`bot-with-dashboard.ts:334`) **ne construit aucun `TradeRecord`** : il n'incrémente
que des compteurs. Même si `addSession()` était câblé, on obtiendrait `wins=0`, `losses=0`,
`winRate=0 %` **à côté de** `totalTrades > 0`. Affichage incohérent (0 % de réussite sur N trades).

**c. Libellés d'unités inversés** — `dashboard/src/components/BalanceCards.tsx:60-75`

La carte porte `label="USDC" subLabel="Bridged"` et `label="USDC.e" subLabel="Native"`. Or **USDC.e
EST l'USDC bridgé** (Bridged USDC) et l'USDC « natif » est le token Cercle. Les sous-libellés sont
**inversés** l'un par rapport à l'autre : l'opérateur lit la mauvaise nature de solde. Le bot,
lui, est sans ambiguïté (`bot-with-dashboard.ts:1040` exige de l'USDC.e « Bridged USDC »).

**d. `PnLPanel` / `QuickStats` — total = réalisé + non réalisé**

`PnLPanel.tsx:19` (`total = realized + unrealized`) et `QuickStats.tsx:12` sont **corrects** : la
soustraction est explicite et `unrealizedPnL` est bien calculé (`bot-with-dashboard.ts:1452-1463`,
boucle sur les positions avec prix courant). Non-régression confirmée. En revanche `unrealizedPnL`
n'est mis à jour que dans le sync portefeuille (`setInterval` 30 s, l. 1475) et reste à **0** tant
qu'aucune position n'existe : ce n'est pas un faux chiffre, juste une valeur nulle légitime.

**e. `state.dipArbTrades` / `state.arbProfit`** — calculés, pas figés :
`state.dipArbTrades++` (`bot-with-dashboard.ts:351`), `state.arbProfit += result.profit` (l. 764).
✅ cohérents.

### 4.3 Correctifs appliqués dans `src/dashboard/**` (périmètre autorisé)

1. **Un bug du dashboard ne doit jamais casser le bot** — `server.ts:23-44`.
   `client.send()` peut lever si la socket se ferme entre le test `readyState === OPEN` et l'appel.
   L'exception remontait dans le handler **synchrone** de `dashboardEmitter.emit('state', …)`, donc
   dans le chemin d'appel de `updateState()` **côté bot** — risque d'interrompre une itération de la
   boucle de trading. Désormais encapsulé dans un `try/catch`.
2. **Alias de références** — `state-emitter.ts:23-33`. `updateState()` faisait une copie
   **superficielle** : `updateStrategyStatus()` mutait alors `this.state.dipArb.status`, c'est-à-dire
   l'objet `state` **vivant** du bot. Copie à un niveau de `dipArb` et `arbitrage` ajoutée.
3. **Exposition du buffer interne** — `state-emitter.ts:86-92`. `getFullData()` renvoyait le tableau
   `logs` **par référence** ; il est maintenant copié.
4. **Historique corrompu** — `session-history.ts:94-140`. `loadHistory()` faisait
   `JSON.parse(data) as HistoryData` sans contrôle. Un fichier tronqué ou ancien (sans `sessions`)
   faisait lever `history.sessions.reduce(...)` dans `addSession()`, ce qui aurait **empêché
   définitivement** tout enregistrement de session. Ajout de `normalizeHistory()` / `emptyHistory()`
   qui forcent la forme et recalculent les totaux.
5. **P&L moyen par trade** — `session-history.ts:224-225`. `avgProfitPerTrade` utilisait
   `trades.length` (souvent 0) et affichait donc 0 ; repli sur `state.tradesExecuted`.

### 4.4 Ce que je recommande au propriétaire du frontend (non appliqué)

- `QuickStats.tsx:23` : supprimer la formule inventée. Soit afficher un vrai ratio
  `gains/(gains+pertes)` après avoir ajouté les compteurs `wins`/`losses` à `BotState`, soit retirer
  la carte « Win Rate » tant que la donnée n'existe pas. **Ne pas laisser `50 + PnL/(2·trades)`.**
- `BalanceCards.tsx:60-75` : corriger les `subLabel` (USDC.e → « Bridged », USDC → « Native ») ou
  retirer les sous-libellés.
- `bot-with-dashboard.ts` : câbler réellement `createSessionFromState(...)` + `addSession(...)` à
  l'arrêt, et faire écrire par `recordTrade()` de vrais `TradeRecord` — sinon `wins`/`losses`/
  `winRate`/`largestWin`/`largestLoss`/`tradeList` de la page History resteront vides.
- Builder `dashboard/dist` (`npm run build` dans `dashboard/`) sinon `/` renvoie 404.

---

## 5. `src/utils/**` — robustesse des helpers

`src/utils/` ne contient que `price-utils.ts` (+ ses tests). **Il n'existe aucun helper de `retry`**
dans le projet : la seule logique de réessai/backoff est **inline** dans
`realtime-service-v2.ts` (`restBackoffMs`, plafond 60 s, §3.2). Recommandation : extraire un
`src/utils/retry.ts` si d'autres appelants en ont besoin — non fait ici pour ne pas ajouter de code
mort.

### 5.1 Cas limites corrigés

| Fonction | Problème | Correctif |
|---|---|---|
| `calculateSharesForAmount(amount, price)` | `price = 0` ⇒ `Infinity` ; `NaN` ⇒ `NaN` ; ces valeurs pouvaient alimenter un ordre | garde `!Number.isFinite(...) \|\| price <= 0 \|\| amount <= 0` ⇒ renvoie **0** (l. 155-157) |
| `calculatePnL(entry, cur, size)` | `entryPrice = 0` ⇒ `pnlPercent = ±Infinity` qui contamine l'agrégat de PnL affiché | garde ⇒ `pnlPercent: 0` (l. 313-314) |
| `formatPrice` / `formatUSDC` | `NaN`/`Infinity` imprimés tels quels (`"NaN"`, `"$NaN"`) | non-fini ⇒ `'—'` / `'$—'` (l. 278, 287) |

### 5.2 Cas limites **laissés en l'état** (volontairement, pour ne pas casser la spec testée)

`roundPrice()` clampe à `[0.001, 0.999]` (l. 57). Sur un marché à tick `0.1`, un prix extrême devient
`0.999`, qui n'est **pas** aligné sur le tick. `src/utils/price-utils.test.ts:49-52` **teste et
verrouille** ce comportement (`roundPrice(0.0001,'0.01','floor') === 0.001`,
`roundPrice(0.9999,'0.01','ceil') === 0.999`). Modifier la fonction casserait un contrat de test
existant ; je le signale comme dette à trancher explicitement (la borne basse alignée serait `tick`,
pas `0.001`).

Autres limites signalées, non bloquantes : `checkArbitrage()` ignore frais et slippage (sur-évalue
l'opportunité) ; `validatePrice()` refuse `price < 0.001` alors que `roundPrice` peut produire
`0.001` pour tout tick — cohérent entre eux, mais `0.001` n'est valide que pour le tick `0.001`.

---

## 6. Vérifications exécutées (sorties réelles)

### 6.1 Tests unitaires

```
$ ./node_modules/.bin/vitest run
RUN  v2.1.9 /root/clawd/Polymarket-bot

 ✓ src/core/types.test.ts (7 tests) 11ms
 ✓ src/utils/price-utils.test.ts (36 tests) 86ms

 Test Files  2 passed (2)
      Tests  43 passed (43)
   Duration  891ms
```

Les 6 tests ajoutés couvrent les nouveaux cas limites de §5.1.

### 6.2 Typecheck

```
$ ./node_modules/.bin/tsc --noEmit
(exit 0, aucune sortie)
```

### 6.3 Sondes d'exécution

- `tmp-audit-probe.mts` → contrat `emit('orderbook')` (§3.1). **Probe supprimée après usage.**
- `tmp-audit-probe2.mts` → garde paper, fail-closed auth, poller (§1.3, §2.5, §3.3).
  **Probe supprimée après usage.**

---

## 7. Fichiers modifiés

| Fichier | Nature |
|---|---|
| `src/services/trading-service.ts` | verrou paper fail-closed sur les 6 chemins d'écriture |
| `src/services/authorization-service.ts` | fail-closed par sonde + garde anti-état vide + `approveAll` |
| `src/services/realtime-service-v2.ts` | concurrence bornée, réordonnancement garanti, purge cache, arrêt propre, observabilité |
| `src/dashboard/server.ts` | `send()` protégé, import mort retiré |
| `src/dashboard/state-emitter.ts` | copie des sous-objets, copie des logs |
| `src/dashboard/session-history.ts` | normalisation de l'historique, P&L moyen |
| `src/utils/price-utils.ts` | gardes division par zéro / non-fini |
| `src/utils/price-utils.test.ts` | +6 tests de cas limites |

Fichiers **volontairement non touchés** (règle absolue) : `.env`, `bot-with-dashboard.ts`,
`package.json`, `node_modules`, `/root/.polymarket/**`, les autres fichiers de `src/services/`,
`dashboard/src/**` (frontend), `dashboard/dist`.

---

## 8. Synthèse

| Question | Réponse |
|---|---|
| (a) Un ordre réel peut-il partir ? | **Pas via `TradingService`** (verrou ajouté, prouvé). Il pouvait, avant l'audit, via 5 méthodes publiques d'arbitrage/dip-arb non gardées en interne ; elles passent toutes par `TradingService`, donc elles sont désormais bloquées — mais les gardes d'appelant restent à consolider par leur propriétaire. |
| (b) Une autorisation qui échoue refuse-t-elle ? | **Oui, démontré** : RPC injoignable ⇒ `tradingReady === false`, 15 issues, aucune allowance « approved » par défaut, aucune exception. Le fail-open latent (listes vides ⇒ `tradingReady === true`) est corrigé. |
| (c) Le contrat `orderbook` est-il identique ? | **Oui, vérifié en exécution** : 9 champs présents, `tokenId === assetId`, `asks[0]` = meilleur ask (l'API REST renvoie les asks décroissants, le poller trie), prix en `number`, timestamp en ms. Aucun champ manquant pour `dip-arb-service` ni `arbitrage-service`. |
| (d) Le dashboard affiche-t-il de vrais chiffres ? | **Non, en partie.** `Priorité haute` : le win-rate de `QuickStats.tsx:23` est **inventé**, l'historique de sessions n'est **jamais écrit**, `dashboard/dist` est absent. Deux erreurs de libellé d'unité (`USDC`/`USDC.e` bridgé/natif inversés). Correctifs frontend fournis mais non appliqués (hors périmètre d'écriture). |
| (e) Les helpers sont-ils robustes ? | Division par zéro et non-fini neutralisés. Aucun helper `retry` n'existe. Le clamp de `roundPrice` est une dette verrouillée par test. |
