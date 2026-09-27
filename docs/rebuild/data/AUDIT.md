# AUDIT — COUCHE DONNÉES (Gamma / CLOB / Data API)

**Date des mesures :** 2026-09-27, 12:38–12:58 UTC (toutes les mesures de ce document viennent d'appels réseau réels exécutés à cet instant ; chaque tableau est reproductible avec les commandes données).
**Périmètre audité (fichiers modifiables) :** `src/services/arbitrage-service.ts`, `src/services/market-service.ts`, `src/clients/gamma-api.ts`, `src/clients/data-api.ts`.
**Marchés de test :** les 5 coins du bot (`BTC, ETH, SOL, XRP, DOGE`) sur les marchés `{coin}-updown-5m-{slot}` (round en cours, round précédent, round suivant).

---

## 1. Réponse à la question centrale

> **Ces services prennent-ils leurs décisions sur des données FIABLES et FRAÎCHES ?**

**Non, pas avant cet audit — et pas pour une seule raison, mais pour quatre, indépendantes :**

| # | Défaut | Nature | Gravité |
|---|--------|--------|---------|
| 1 | `bestAsk` / `bestBid` de Gamma sont **figés** sur la valeur d'ouverture du round pendant toute sa vie (mesuré : `0.49/0.50` constants alors que le carnet CLOB réel passait de `0.585` à `0.695`) | donnée périmée présentée comme une mesure | **critique** — un carnet figé à `0.48/0.49` fabrique un « arbitrage long » de **+3,6 %** qui n'existe pas |
| 2 | `outcomePrices` de Gamma **retarde de ~40–80 s** et est quantifié par paliers (mesuré : `0.495` maintenu 4 échantillons ≈ 1 min alors que le vrai mid passait de `0.585` à `0.675`, écart max **−0,18**) | donnée retardée | **critique** sur un round de 5 min |
| 3 | Le filtre Gamma `condition_id` (singulier) est **IGNORÉ** : il renvoie les 5 marchés les plus liquides de la plateforme. `getMarketByConditionId()` renvoyait donc un **marché totalement étranger** (mesuré : `xi-jinping-out-before-2027` pour un `btc-updown-5m`) | identifiant confondu → données d'un autre marché | **critique** |
| 4 | Les erreurs réseau/base devenaient des **valeurs par défaut silencieuses** : `outcomePrices` absent → `[0.5, 0.5]` ; carnet incomplet → `bid=0 / ask=1` ; réponse non-tableau → `[]` ; date de fin absente → `maintenant` | panne déguisée en mesure | **critique** |

**Après corrections**, les chemins de décision lisent le **carnet CLOB** (`/book?token_id=`), les valeurs Gamma ne sont plus utilisées comme source de prix mais comme métadonnée explicitement étiquetée, et **aucune panne ne produit plus une valeur numérique exploitable**.

---

## 2. Recensement (a) — toutes les lectures de prix/probabilité/état de marché

| Emplacement | Champ lu | Source | Verdict avant audit | Traitement |
|---|---|---|---|---|
| `gamma-api.ts:normalizeMarket` | `outcomePrices` | Gamma | **peut être absent → `[0.5,0.5]` fabriqué** ; retardé sinon | défaut inventé supprimé (`[]` + `pricesMissing`), documentation ⚠️ |
| `gamma-api.ts:normalizeMarket` | `bestBid` / `bestAsk` | Gamma | **figés au round ; non fiables** | documentés ⚠️ (jamais utilisés par un chemin de décision après audit) |
| `gamma-api.ts:normalizeMarket` | `lastTradePrice` | Gamma | figé/retardé | documenté ⚠️ |
| `gamma-api.ts:normalizeMarket` | `endDate` | Gamma | **absent → `Date.now()`** (marché « qui se termine maintenant ») | absent → epoch + `endDateMissing` |
| `gamma-api.ts:normalizeMarket` | `tags` | Gamma | cast en `string[]` sur des objets → `[object Object]` | extraction `slug/label` |
| `market-service.ts:mergeMarkets` | `t.price` (CLOB `/markets`) puis `gamma.outcomePrices[i]` puis **`0.5`** | CLOB + Gamma | **`0.5` fabriqué** ; le `price` CLOB vaut aussi ~`0.505` d'amorçage | plus de `0.5` : prix CLOB s'il existe, sinon Gamma, sinon **erreur** |
| `market-service.ts:fromGammaMarket` | `gamma.outcomePrices[i] \|\| 0.5` | Gamma | **`0.5` fabriqué** (et `0` légitime écrasé) | **erreur explicite** si absent |
| `market-service.ts:processOrderbooks` | `bids[0]?.price \|\| 0` / `asks[0]?.price \|\| 1` | CLOB | **`0`/`1` fabriqués** → alimentent `askSum`, `imbalanceRatio`, `effectiveSellX` | **erreur `INVALID_RESPONSE`** si un niveau manque |
| `market-service.ts:getTokenOrderbook` | `/book` | CLOB | erreur HTTP gérée, mais **carnet VIDE (0/0) passait** | carnet vide → `MARKET_NOT_FOUND` + filtrage NaN |
| `market-service.ts:getTokenOrderbooks` (pluriel) | `/books` | CLOB | **pas de garde-fou du tout** : carnet en erreur inséré sous la clé `undefined` | même garde-fou que la version singulière |
| `market-service.ts:getLiveMarkPrices` (**nouveau**) | `/book` | CLOB | — | expose les bid/ask/mid **réels** pour l'UI/récap |
| `arbitrage-service.ts:clearPositions` (dry-run) | `estimatedPrice = 0.5` | **constante codée en dur** | **prix inventé présenté comme montant récupéré** | meilleur bid CLOB, sinon `$0` + `estimated: true` |
| `arbitrage-service.ts:clearPositions` (exécution) | `sellAmount * 0.5` | **constante codée en dur** | idem | idem |
| `arbitrage-service.ts:scanMarkets` | carnet CLOB via `getProcessedOrderbook` | CLOB | ✅ correct (mais `volume24hr` Gamma pour le scoring — acceptable) | conservé |
| `arbitrage-service.ts:execute*Arb` | carnet temps réel (`RealtimeServiceV2`) | WS/REST | ⚠️ **signal non re-vérifié avant l'ordre** | **re-vérification CLOB obligatoire** ajoutée |
| `market-service.ts:analyzeHistoricalSpread` | `lastYes/lastNo = 0.5` initiaux | — | backtest uniquement, non exposé à une décision live | inchangé (documenté) |
| `market-service.ts:fromClobMarket` / `mergeMarkets` | `endDate: … : new Date()` | CLOB | **date de fin fabriquée = « maintenant »** | epoch si absente |

---

## 3. (a) Tableau comparatif — 15 lectures Gamma confrontées au VRAI carnet CLOB, au même instant

Commande : `python3 /root/.hermes/cache/scratch/cmp_final.py` (fetch Gamma puis `/book?token_id=` par marché, latence mesurée des deux côtés).
Instant : **2026-09-27T12:53:49Z**, slot `1790513400` ; latence Gamma p50 ≈ 58 ms, CLOB p50 ≈ 71 ms (donc < 100 ms d'écart entre les deux lectures d'une même ligne).

| # | phase | slug | Gamma `outcomePrices` | Gamma `bestBid`/`bestAsk` | carnet CLOB (Up) bid/ask/mid | écart mid(Gamma) ↔ mid(CLOB) | Gamma `lastTradePrice` | carnet (Down) bid/ask |
|---|---|---|---|---|---|---|---|---|
| 1 | round précédent | btc-updown-5m-1790513100 | 0.0005/0.9995 | *(absent)*/0.01 | *pas de carnet* | — | 0.01 | *pas de carnet* |
| 2 | round précédent | eth-updown-5m-1790513100 | 0.0005/0.9995 | 0.01/0.02 | *pas de carnet* | — | 0.05 | *pas de carnet* |
| 3 | round précédent | sol-updown-5m-1790513100 | 0.0005/0.9995 | 0.01/0.02 | *pas de carnet* | — | 0.07 | *pas de carnet* |
| 4 | round précédent | xrp-updown-5m-1790513100 | 0.005/0.995 | 0.31/0.33 | *pas de carnet* | — | 0.33 | *pas de carnet* |
| 5 | round précédent | doge-updown-5m-1790513100 | 0.995/0.005 | 0.79/0.81 | *pas de carnet* | — | 0.83 | *pas de carnet* |
| 6 | **round en cours** | btc-updown-5m-1790513400 | 0.605/0.395 | 0.47/0.48 | 0.01/0.02/**0.015** | **−0,47** | 0.48 | 0.98/0.99 |
| 7 | **round en cours** | eth-updown-5m-1790513400 | 0.515/0.485 | 0.48/0.49 | 0.01/0.02/**0.015** | **−0,475** | *(absent)* | 0.98/0.99 |
| 8 | **round en cours** | sol-updown-5m-1790513400 | 0.44/0.56 | 0.49/0.50 | 0.05/0.06/**0.055** | **−0,44** | *(absent)* | 0.94/0.95 |
| 9 | **round en cours** | xrp-updown-5m-1790513400 | 0.37/0.63 | 0.47/0.49 | *(bid absent)*/0.01 | — | *(absent)* | 0.99/*(ask absent)* |
| 10 | **round en cours** | doge-updown-5m-1790513400 | 0.585/0.415 | 0.48/0.52 | 0.12/0.13/**0.125** | **−0,375** | *(absent)* | 0.87/0.88 |
| 11 | round suivant | btc-updown-5m-1790513700 | 0.495/0.505 | 0.49/0.50 | 0.49/0.50/**0.495** | 0,000 | 0.50 | 0.50/0.51 |
| 12 | round suivant | eth-updown-5m-1790513700 | 0.50/0.50 | 0.49/0.51 | 0.49/0.50/**0.495** | −0,005 | 0.51 | 0.50/0.51 |
| 13 | round suivant | sol-updown-5m-1790513700 | 0.515/0.485 | 0.51/0.52 | 0.49/0.50/**0.495** | −0,020 | 0.51 | 0.50/0.51 |
| 14 | round suivant | xrp-updown-5m-1790513700 | 0.505/0.495 | 0.50/0.51 | 0.48/0.49/**0.485** | −0,020 | *(absent)* | 0.51/0.52 |
| 15 | round suivant | doge-updown-5m-1790513700 | 0.50/0.50 | 0.48/0.52 | 0.48/0.52/**0.500** | 0,000 | *(absent)* | 0.48/0.52 |

**Lecture du tableau — trois régimes distincts :**

1. **Round en cours (lignes 6-10) : divergence MASSIVE.** Gamma annonce `0.605` pour l'issue Up du BTC alors que le meilleur ask réel du carnet est `0.02` (écart **0,585** sur la première issue ; le « mid Gamma » vs « mid CLOB » donne −0,47). Sur ETH l'écart atteint **0,50** (`0.515` contre `0.015`). Ces lectures Gamma sont **inutilisables** pour décider.
   *Conséquence chiffrée du défaut #1 :* avec `bestAsk = 0.48` (btc) et `bestAsk = 0.49` (eth), la formule d'arbitrage long du bot (`1 − (askYes + askNo)`) aurait affiché un profit de **+3 %**, alors que le carnet réel affiche `askSum = 1.01` → **profit = −1 %**. L'ancien code aurait donc exécuté un « arbitrage » perdant de 1 % en croyant gagner 3 %.
2. **Round suivant (lignes 11-15) : accord correct** (écarts ≤ 0,02). Les marchés neufs affichent bien ~0,50 partout : c'est le seul cas où les champs Gamma sont honnêtes.
3. **Round précédent (lignes 1-5) : les tokens sont périmés, il n'y a PLUS de carnet** (`{"error":"No orderbook exists for the requested token id"}`), mais Gamma continue d'afficher des prix terminaux (`0.0005/0.9995`, `0.995/0.005`) et un `bestBid/bestAsk` (`0.31/0.33`, `0.79/0.81`). Un service qui lit Gamma sur un round fini « voit » un marché actif avec des prix, alors qu'il n'y a plus rien à trader.

**Exemple live supplémentaire — les champs Gamma se contredisent entre eux** (`npx tsx docs/rebuild/data/evidence/smoke.ts`, 12:59:11Z, `btc-updown-5m-1790513700`) :

```
Gamma outcomePrices = [0.035,0.965]   bestBid/Ask = 0.49 / 0.50   carnet CLOB = carnet unilatéral (yes.bid absent, no.ask absent)
```

Au même instant, Gamma affirme à la fois « l'issue Up vaut 0,035 » (`outcomePrices`, reflet tardif du carnet) **et** « on peut acheter Up à 0,50 » (`bestAsk`, figé au démarrage du round). Aucun des deux champs n'est une mesure du carnet ; les combiner dans un calcul d'arbitrage revient à mélanger deux époques du marché.

---

## 4. (a) Fraîcheur mesurée — `outcomePrices` retarde, `bestBid/bestAsk` sont figés

Série temporelle réelle (`python3 /root/.hermes/cache/scratch/fresh1.json`, 8 échantillons espacés de 20 s, marché BTC 5 min, Gamma puis carnet CLOB juste après) :

| t (UTC) | marché | Gamma `outcomePrices[0]` | Gamma `bestBid/Ask` | CLOB bid/ask (Up) | mid CLOB | écart Gamma ↔ mid CLOB |
|---|---|---|---|---|---|---|
| 12:39:39 | btc-updown-5m-1790512500 | 0.885 | 0.49/0.5 | 0.99/– | – | – |
| 12:39:39 | btc-updown-5m-1790512800 | 0.495 | 0.49/0.5 | 0.58/0.59 | 0.585 | **−0,090** |
| 12:39:59 | btc-updown-5m-1790512800 | 0.495 | 0.49/0.5 | 0.57/0.60 | 0.585 | **−0,090** |
| 12:40:19 | btc-updown-5m-1790512800 | 0.495 | 0.49/0.5 | 0.51/0.52 | 0.515 | −0,020 |
| 12:40:40 | btc-updown-5m-1790512800 | 0.495 | 0.49/0.5 | 0.62/0.63 | 0.625 | **−0,130** |
| 12:41:00 | btc-updown-5m-1790512800 | 0.495 | 0.49/0.5 | 0.56/0.57 | 0.565 | −0,070 |
| 12:41:20 | btc-updown-5m-1790512800 | 0.495 | 0.49/0.5 | 0.67/0.68 | 0.675 | **−0,180** |
| 12:41:41 | btc-updown-5m-1790512800 | 0.635 | 0.49/0.5 | 0.69/0.70 | 0.695 | −0,060 |

**Mesures :**

* `bestBid` / `bestAsk` **ne bougent JAMAIS** pendant la vie du round : `0.49/0.50` sur les 7 échantillons couvrant 2 min 02 s (12:39:39 → 12:41:41) alors que le carnet réel a parcouru `0.585 → 0.515 → 0.625 → 0.565 → 0.675 → 0.695`. Ce sont les valeurs d'amorçage du round, jamais rafraîchies.
* `outcomePrices` est **quantifié par paliers et retardé** : `0.495` figé sur 4 échantillons consécutifs (≈ 1 min) pendant que le mid réel montait à `0.675`, puis saut à `0.635` (encore 0,06 derrière le carnet).
* **Latence Gamma → décision : ~40 à 80 s** (≈ 20 % de la durée totale d'un round de 5 min), avec un écart instantané mesuré jusqu'à **0,18**.

À l'inverse, la fraîcheur du carnet CLOB est excellente : `timestamp` serveur du carnet vs horloge locale = **24 ms** (mesure du smoke-test §8).

---

## 5. (b) Corrections appliquées, écart par écart

### 5.1 Identifiants — `condition_id` ignoré par Gamma (**critique**)
Preuve A/B réelle (`npx tsx /root/.hermes/cache/scratch/smoke.ts`) :

```
slug demandé      : btc-updown-5m-1790513400
conditionId réel  : 0x0a465834f8aa18b5aa3e78471c638465f4fe1e6c9fe01682111b9c3965489c46
?condition_id  -> 5 items: ["xi-jinping-out-before-2027","will-gavin-newsom-win-2028…","will-alexandria-ocasio-cortez-win-2028…","will-pete-buttigieg-win-2028…","will-josh-shapiro-win-2028…"]
?condition_ids -> 1 items: ["btc-updown-5m-1790513400"]
getMarketByConditionId() (code corrigé) -> btc-updown-5m-1790513400
```

* **Avant :** `getMarkets()` envoyait `condition_id` → réponse non filtrée → `getMarketByConditionId()` retournait `markets[0]`, donc un **marché étranger** ; `mergeMarkets()` collait alors le carnet d'un marché sur le slug/volume/question d'un autre.
* **Après :** paramètre `condition_ids` + **filtre local de contrôle** (`m.conditionId === demandé`) dans `gamma-api.ts`, et **vérification d'identité** dans `market-service.ts` (`getMarketByConditionId` rejette un résultat non conforme ; `mergeMarkets` **refuse** la fusion si `conditionId` Gamma ≠ `conditionId` CLOB).

### 5.2 Le « 0,5 » fabriqué (chemins d'affichage/métadonnée)
* `fromGammaMarket` et `mergeMarkets` **ne fabriquent plus 0,5** : ils lèvent `INVALID_RESPONSE` (« refus de fabriquer 0.5. Utiliser le carnet CLOB. »).
* `arbitrage-service.clearPositions` : le `0.5` forfaitaire a été remplacé par la lecture du **meilleur bid CLOB** ; si le carnet est indisponible, l'action est marquée `estimated: true` avec `usdcResult = 0` et l'erreur explicite — on ne compte plus un montant inventé comme récupéré.

### 5.3 Carnets incomplets (`bid=0` / `ask=1`)
`processOrderbooks()` lève désormais `INVALID_RESPONSE` en nommant le côté manquant (`Carnet incomplet (yes.bid) — refus de calculer l'arbitrage sur des niveaux fabriqués (0/1)`). Deux gardes ajoutées en amont : `/book` en erreur **et** carnet totalement vide.

### 5.4 Re-vérification avant d'agir
`ArbitrageService` relit les **deux** carnets CLOB juste avant de placer un ordre (`confirmSignalStillValid`) :
* si le profit live est repassé sous `profitThreshold` → **annulation** (« signal périmé: profit long attendu 3.000% mais carnet CLOB live = −1.000% ») ;
* si la re-vérification est impossible (réseau) → avertissement explicite et exécution poursuivie sur le flux temps réel (**on bloque sur preuve, on avertit sur doute**) ;
* toute dérive > 0,2 point est loggée.

### 5.5 Dates de fin
`endDate` absent → **epoch + `endDateMissing: true`** au lieu de `Date.now()` (qui faisait passer un marché sans date pour un marché en train de se terminer, et le faisait entrer dans les filtres « se termine dans 5–60 min »).

### 5.6 `getMarket()` — aiguillage d'identifiants
`/^\d+$/` routait **toute** chaîne numérique vers le chemin `conditionId` ; or les identifiants numériques Polymarket sont des **token ids ERC-1155** ou des ids internes Gamma → requêtes silencieusement vides. Seul `^0x[0-9a-fA-F]{64}$` est routé vers `conditionId`, le reste vers `slug`.

---

## 6. (c) Gestion des erreurs réseau — « une panne ne doit jamais ressembler à une donnée »

**Avant :** quatre valeurs par défaut silencieuses existaient :
`outcomePrices` → `[0.5, 0.5]` · carnet incomplet → `0`/`1` · réponse non-tableau → `[]` · date de fin → `maintenant`.
Le cas le plus grave était `!Array.isArray(data) → return []` dans **les 6 normalisateurs** de `data-api.ts` : un corps d'erreur JSON (`{"error":"usage limit reached"}`) devenait « aucune position / aucun trade / pas de K-line » — exactement le scénario du RPC rate-limité déjà subi par le bot, mais côté REST.

**Après :** `assertArray()` lève `INVALID_RESPONSE` et les 6 appelants (positions, closed-positions, activity, trades, leaderboard, holders, value) remontent l'erreur au lieu de renvoyer du vide.

**Preuves réelles** (`npx tsx /root/.hermes/cache/scratch/smoke_errors.ts`, `fetch` stubé, code du projet inchangé) :

```
== A. 429 (rate limit) avec Retry-After: 1, puis 200 ==
  getMarkets -> OK (2029 ms)           fetch() appelé 3 fois
== B. 5xx persistant (retryable) ==
  getMarkets -> ERREUR NETWORK_ERROR "bad gateway" (1505 ms)   fetch() appelé 3 fois
== C. 404 (non retryable → échec immédiat, 1 seul appel) ==
  getMarkets -> ERREUR MARKET_NOT_FOUND "not found" (5 ms)     fetch() appelé 1 fois
== D. timeout réseau (réponse jamais envoyée) ==
  getMarkets -> ERREUR TIMEOUT "GET /markets?limit=1 : timeout après 10000 ms" (31509 ms)   fetch() appelé 3 fois
== E. Data API : réponse 200 non-tableau (panne déguisée en donnée) ==
  getTrades    -> ERREUR INVALID_RESPONSE "GET /trades : réponse non-tableau (object) — refus de la convertir en [] silencieux" (6 ms)
  getPositions -> ERREUR INVALID_RESPONSE "GET /positions : réponse non-tableau (object) — refus de la convertir en [] silencieux" (100 ms)
== F. Data API : panne réseau ==
  getTrades -> ERREUR NETWORK_ERROR "GET /trades?limit=5&market=0xbbbb…bbbb : ENOTFOUND" (1599 ms)
```

Et sur un round **terminé** (tokens périmés, `npx tsx /root/.hermes/cache/scratch/smoke_stale.ts`) :

```
--- btc-updown-5m-1790513100 (active=true closed=false) ---
Gamma outcomePrices = [0.0005,0.9995]  bestBid/Ask = undefined / 0.01  pricesMissing = false  endDateMissing = false
✅ getProcessedOrderbook refuse: Orderbook indisponible (token id périmé ou inconnu): 366100685781711268…
   getMarket -> source = merged  slug = btc-updown-5m-1790513100  prix = [0.475,0.525]  endDate = 2026-09-27T00:00:00.000Z
```

→ le carnet périmé est **refusé** (avant : carnet « vide » accepté → bid 0 / ask 1), tandis que le chemin `getMarket` (métadonnée) renvoie encore le `price` **d'amorçage** `0.475/0.525` de `CLOB /markets` (voir §10, risque résiduel).

---

## 7. (d) Timeouts, retries, rate limits

| Élément | Avant | Après |
|---|---|---|
| Timeout réseau | **aucun** (`fetch()` nu) — un serveur qui accepte la connexion sans répondre bloque l'appelant **indéfiniment** | `AbortController` + **10 s** ; dépassement ⇒ `PolymarketError(TIMEOUT)` |
| Retry | **aucun** | **3 tentatives** max, backoff exponentiel (0,5 s → 1 s) |
| `429` | traité comme une erreur générique immédiate (et, via `[]`, comme une absence de donnée) | **`Retry-After` honoré** (plafonné à 30 s), puis backoff — vérifié en A ci-dessus (2 retries, succès en 2,03 s) |
| `5xx` | erreur immédiate | retryable (`NETWORK_ERROR.retryable = status >= 500`) |
| `4xx` (hors 429) | erreur immédiate | identique — **1 seul appel** (vérifié en C) |
| User-Agent | absent → `403 Forbidden` observé sur `gamma-api` avec un client par défaut | UA explicite sur les deux clients |
| Rate limiter (`src/core/rate-limiter.ts` — **hors périmètre d'écriture**) | Gamma/CLOB : `reservoir: 10/1 s`, **aucun `minTime`, aucun `maxConcurrent`, aucun retry ni backoff 429** | **non modifié** — risque documenté, cf. §11 |

**Mesure de débit réelle** (burst parallèle, 6 workers) :

```
GAMMA /markets x40 : {'codes': {200: 40}, 'wall_s': 0.53, 'p50_ms': 58,  'max_ms': 99}
CLOB  /book    x40 : {'codes': {200: 40}, 'wall_s': 0.60, 'p50_ms': 71,  'max_ms': 103}
DATA  /trades  x20 : {'codes': {200: 20}, 'wall_s': 0.28, 'p50_ms': 65,  'max_ms': 74}
```

→ à ~8 req/s par hôte (sous la limite documentée de 10 req/s), **aucun 429 observé** en 100 requêtes. Le « usage limit reached » historique du bot provient du RPC Polygon, pas de ces trois REST. Le retry 429/`Retry-After` ajouté protège malgré tout la couche REST.

---

## 8. (e) Cohérence des identifiants

| Identifiant | Format | Où il vit | Erreur historique |
|---|---|---|---|
| `slug` | `btc-updown-5m-<ts>` | Gamma (`/markets?slug=`), **seul filtre réellement fiable** | — |
| `conditionId` | `0x` + 64 hexa | CLOB (`/markets/{id}`, `/book` via tokens), Data API (`?market=`), Gamma (`condition_ids`, **PAS** `condition_id`) | ✗ filtre singulier ignoré → marché étranger (corrigé) |
| `token_id` / `assetId` | entier décimal de 76 chiffres | CLOB `/book?token_id=` ; renvoyé dans `asset_id` (book) et `asset` (Data API `trades`) | ✗ carnet en erreur indexé sous `undefined` dans `getTokenOrderbooks` (corrigé) |
| id interne Gamma | entier | `id` | ✗ confondu avec `conditionId` par `getMarket('/^\d+$/')` (corrigé) |

Vérifié en réel : `GET /trades?market=<conditionId>` renvoie bien 5 trades (le paramètre `market` de la Data API est un `conditionId`), et `GET /trades?market=0xdeadbeef` renvoie `[]` (réponse légitime, pas une panne — d'où l'`assertArray` qui ne se déclenche que sur un **non-tableau**).

---

## 9. (f) Fraîcheur réelle entre la donnée et la décision

| Chemin de décision | Source de prix | Latence / fraîcheur mesurée | Verdict |
|---|---|---|---|
| `scanMarkets` → `getProcessedOrderbook` | carnet CLOB | **138 ms** de bout en bout (deux `/book` + market CLOB), `timestamp` serveur **24 ms** d'âge | ✅ frais |
| `execute*Arb` | flux `RealtimeServiceV2` (WS/REST) puis **re-vérification CLOB** | intervalle du flux + **1 aller-retour CLOB (~70 ms)** avant l'ordre | ✅ corrigé |
| Récap/UI historique (`outcomePrices` Gamma) | Gamma | **retard 40–80 s**, écart jusqu'à **0,585** | ❌ ⇒ passer par `getLiveMarkPrices()` |
| `UnifiedMarket.tokens[].price` | `CLOB /markets/{conditionId}` **caché 60 s** (`CACHE_TTL.MARKET_INFO`) | `0.505/0.495` **d'amorçage** pendant tout le round (mesuré sur les 5 coins) | ❌ métadonnée seulement |
| Cache marché CLOB | mémoire | TTL **60 s** = 20 % d'un round de 5 min | ⚠️ acceptable pour les `tokenId`, **pas** pour un prix |

Mesure de provenance des prix d'un round en cours (les 5 coins, même instant) :

```
btc-updown-5m-1790513400
  UnifiedMarket.tokens[].price (source=merged) = [0.505,0.495]
  CLOB /markets tokens[].price                  = [0.505,0.495]
  GAMMA outcomePrices                           = [0.605,0.395]
  CARNET CLOB réel bid/ask                      = ["undefined/0.01","0.99/undefined"]
doge-updown-5m-1790513400
  UnifiedMarket.tokens[].price (source=merged) = [0.5,0.5]
  GAMMA outcomePrices                           = [0.585,0.415]
  CARNET CLOB réel bid/ask                      = ["0.94/0.97","0.03/0.06"]
```

→ **trois valeurs différentes pour le même marché au même instant** : `0.505` (amorçage CLOB `/markets`), `0.605` (Gamma retardé), et un carnet réel à `0.01/0.02`. C'est cette confusion qui produit les « 0.50/0.50 » vus dans le récap Telegram.
**Correctif fourni aux autres consommateurs :** `MarketService.getLiveMarkPrices(conditionId)` renvoie les bid/ask/mid **du carnet CLOB** ou `null` — jamais 0,5.

---

## 10. Fichiers modifiés

| Fichier | Nature des changements |
|---|---|
| `src/clients/gamma-api.ts` | `fetchJsonWithRetry` (timeout 10 s + 3 tentatives + `Retry-After` + UA) ; `condition_ids` + contrôle local du `conditionId` ; plus de `[0.5,0.5]` ni de `Date.now()` par défaut (`pricesMissing`, `endDateMissing`, epoch) ; `tags` objets→slug ; typage documenté ⚠️ des 4 champs de prix |
| `src/clients/data-api.ts` | même `fetchJsonWithRetry` sur les 7 endpoints ; `assertArray()` (plus de `[]` silencieux, y compris `{user, value:0}` fabriqué) ; avertissement quand un filtre temporel client-side vide la réponse |
| `src/services/market-service.ts` | carnet vide/erroné refusé (singulier **et** pluriel) ; `processOrderbooks` sans `0`/`1` fabriqués ; `mergeMarkets`/`fromGammaMarket` sans `0.5` + contrôle d'identité Gamma↔CLOB ; `endDate` epoch au lieu de `maintenant` ; aiguillage `conditionId` strict ; **nouveau `getLiveMarkPrices()`** |
| `src/services/arbitrage-service.ts` | **re-vérification du carnet CLOB avant chaque ordre** (`confirmSignalStillValid`) ; plus de `0.5` forfaitaire dans `clearPositions` (bid CLOB réel, sinon `usdcResult = 0` + `estimated: true`) |
| `docs/rebuild/data/AUDIT.md` | ce document |

**Non modifiés (interdits en écriture) :** `src/core/rate-limiter.ts`, `src/core/types.ts`, `src/core/cache.ts`, `bot-with-dashboard.ts`, `package.json`.

---

## 11. Risques résiduels et hors périmètre

1. **`rate-limiter.ts` (interdit) reste sans retry/backoff 429** et les limiteurs Gamma/CLOB n'ont ni `minTime` ni `maxConcurrent` : un pic de concurrence peut dépasser les 10 req/s documentées. Mitigé partiellement au niveau `fetch` (retry `Retry-After`), mais pas au niveau du débit global.
2. **Le récap Telegram** lit une source périmée : il doit utiliser `getLiveMarkPrices()` / `getProcessedOrderbook()`. Le correctif de son code appartient à l'agent en charge du récap ; la source correcte est maintenant disponible.
3. `UnifiedMarket.tokens[].price` (chemin `getMarket`) reste le `price` d'amorçage de `CLOB /markets`, caché 60 s. Le rendre live coûterait 2 requêtes `/book` par appel de `getMarket` (utilisé en boucle par `scanMarkets`) : décision volontaire de **ne pas** dégrader le débit ; c'est désormais **documenté et contournable** via `getLiveMarkPrices()`.
4. `analyzeHistoricalSpread()` initialise `lastYes/lastNo = 0.5` : valeur de démarrage d'un backtest, jamais exposée à une décision live — laissée telle quelle et signalée.
5. Avec 3 tentatives et un timeout de 10 s, un hôte mort coûte **jusqu'à 30 s** avant l'échec (mesuré : 31,5 s en D). Si un appelant a besoin d'un échec plus rapide, il faut exposer `timeoutMs`/`maxAttempts` (non fait ici pour ne pas élargir l'API publique).

---

## 12. Vérifications finales

```
$ npx tsc --noEmit
TSC_EXIT=0

$ npx vitest run --reporter=dot
 ✓ src/core/types.test.ts (7 tests) 7ms
 ✓ src/utils/price-utils.test.ts (36 tests) 16ms
 Test Files  2 passed (2)
      Tests  43 passed (43)
```

Smoke-tests et données brutes (tous les chiffres de ce document en proviennent, copiés ici pour reproductibilité) :
`docs/rebuild/data/evidence/cmp_final.json` (tableau comparatif brut) · `fresh1.json` (série temporelle de fraîcheur) ·
`cmp_final.py` (générateur du tableau §3) · `smoke.ts` (A/B `condition_id`, carnet vs Gamma, panne simulée) ·
`smoke_stale.ts` (round terminé) · `smoke_price_src.ts` (provenance des prix) · `smoke_errors.ts` (retries/timeouts/non-tableau).

Rejouer le tableau comparatif :
```bash
python3 docs/rebuild/data/evidence/cmp_final.py        # écrit cmp_final.json (nécessite curl)
cd /root/clawd/Polymarket-bot && npx tsx docs/rebuild/data/evidence/smoke.ts
```
(les smoke-tests `tsx` importent les sources via `/root/clawd/Polymarket-bot/src/...`, à lancer depuis la racine du projet).
