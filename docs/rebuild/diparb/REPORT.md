# Correctif `priceToBeat` — DipArbService

**Date :** 2026-09-26
**Fichier corrigé :** `src/services/dip-arb-service.ts`
**Statut :** `npx tsc --noEmit` → **exit 0**

---

## 1. Symptôme observé (AVANT)

Extrait réel de `/root/clawd/Polymarket-bot/paperbot.log` :

```
47:2026-09-26T23:09:49: [2026-09-26T23:09:49.183Z] 🔄 New round: btc-updown-5m-1790464500-1790464189183, Price to Beat: 0
48:2026-09-26T23:09:49: [DipArb] New round: btc-updown-5m-1790464500-1790464189183, Price to Beat: 0.00
184:2026-09-26T23:20:09: [2026-09-26T23:20:09.185Z] 🔄 New round: btc-updown-5m-1790464800-1790464809185, Price to Beat: 84387.67
185:2026-09-26T23:20:09: [DipArb] New round: btc-updown-5m-1790464800-1790464809185, Price to Beat: 84387.67
247:2026-09-26T23:25:09: [2026-09-26T23:25:09.295Z] 🔄 New round: btc-updown-5m-1790465100-1790465109295, Price to Beat: 84388.96
248:2026-09-26T23:25:09: [DipArb] New round: btc-updown-5m-1790465100-1790465109295, Price to Beat: 84388.96
```

Deux problèmes distincts visibles :

1. **Ligne 48 : `Price to Beat: 0.00`** — quand le flux de prix n'était pas prêt, on loggait un faux `0.00` comme si c'était une valeur valide.
2. **Lignes 184/185 et 247/248 : la valeur affichée est le SPOT au moment de la rotation, PAS le prix d'ouverture du round.** Preuve : le round `btc-updown-5m-1790465100` (fenêtre 7:25PM→7:30PM ET) a son vrai prix d'ouverture à **84374.02** (voir §3) alors que le log affiche **84388.96** — soit ~15 $ d'écart. La rotation démarre ~9 s **après** le slot, donc le spot est déjà post-ouverture.

**Cause (ligne 1221 historique) :**
```ts
const priceToBeat = this.currentUnderlyingPrice || 0;   // ← spot COURANT, ou 0
```

---

## 2. D'où DOIT venir le vrai strike

Investigation menée en interrogeant réellement l'API Gamma :

```
=== Champs Gamma pour le slug d'un round actif ===
MARKET KEYS (extrait) : acceptingOrders, bestAsk, bestBid, clobTokenIds,
  conditionId, cryptoMarketConfig, endDate, eventStartTime, outcomePrices, ...
Champs contenant 'strike' ou 'beat' : AUCUN
```

- **L'API Gamma (`events?slug=`) n'expose AUCUN champ de strike / priceToBeat.**
- Le marché résout sur un flux **Chainlink TWAP 60 s** :
  - `resolutionSource = https://data.chain.link/streams/btc-usd-twap-60s-streams`
  - `cryptoMarketConfigId = "btc-5m-twap-60"` (`twapEnabled: true`, `twapLookbackSeconds: 60`)
  - description Gamma : *« resolve to "Up" if the TWAP of Bitcoin … is greater than or equal to the price at the beginning of that range »*.

Le strike est donc « le prix au DÉBUT de la fenêtre » selon le TWAP Chainlink. **Ce flux n'est pas récupérable de façon fiable via HTTP public** (Chainlink Data Streams exige des credentials signés). Il n'existe pas de champ équivalent dans Gamma (plusieurs endpoints testés → 404 : `crypto-prices`, `prices`, `polymarket.com/api/crypto/prices`).

**Option retenue (recommandée par la consigne, déjà en prod dans `paperbot-recap.py`) :** l'**ouverture de la bougie Binance 1m au slot du round**, obtenu par `GET /api/v3/klines?interval=1m&startTime=<slot_ms>&limit=1`. C'est un proxy fidèle du prix d'ouverture, avec un repli `data-api.binance.vision` si `api.binance.com` est bloqué.

---

## 3. Preuve : le strike récupéré correspond bien au marché

Comparaison, pour le **même slug**, entre métadonnées Gamma et l'ouverture de la bougie 1m au slot :

```
=== Comparaison VRAI strike (kline 1m) vs métadonnées Gamma pour le MÊME slug ===

slug            = btc-updown-5m-1790464800
slot (slug)     = 1790464800  ->  2026-09-26T23:20:00Z (UTC)
titre Gamma     = Bitcoin Up or Down - September 26, 7:20PM-7:25PM ET
eventStartTime  = 2026-09-26T23:20:00Z
endDate         = 2026-09-26T23:25:00Z
cryptoMarketCfg = btc-5m-twap-60   (résolution: TWAP Chainlink 60s)
champs 'strike/priceToBeat' dans le JSON Gamma = AUCUN
OUVERTURE bougie 1m au slot = 84387.67000000   (open_time=1790464800000)

slug            = btc-updown-5m-1790465100
slot (slug)     = 1790465100  ->  2026-09-26T23:25:00Z (UTC)
titre Gamma     = Bitcoin Up or Down - September 26, 7:25PM-7:30PM ET
eventStartTime  = 2026-09-26T23:25:00Z
endDate         = 2026-09-26T23:30:00Z
cryptoMarketCfg = btc-5m-twap-60   (résolution: TWAP Chainlink 60s)
champs 'strike/priceToBeat' dans le JSON Gamma = AUCUN
OUVERTURE bougie 1m au slot = 84374.02000000   (open_time=1790465100000)
```

**Alignement prouvé :** le timestamp extrait du slug (`1790464800` / `1790465100`) **égale exactement** `eventStartTime` de Gamma et le début affiché dans le titre du marché (7:20PM / 7:25PM ET). Le slot du slug EST bien le début de la fenêtre du round → l'ouverture de la bougie 1m à ce slot EST le prix d'ouverture (« price to beat »).

---

## 4. Correctif appliqué

### (a) Extraction du slot depuis le slug
`parseSlotFromSlug('btc-updown-5m-1790465100') → 1790465100`.

### (b) Vrai strike d'ouverture (remplace le spot courant)
Nouvelle méthode `fetchRoundOpenPrice(slotSec)` : bougie Binance 1m (`api.binance.com` puis `data-api.binance.vision`), `open` de la bougie au slot. **Utilisée à la création du round** à la place de `this.currentUnderlyingPrice || 0`.
Aucun repli sur le spot courant : si la bougie est indisponible, le strike reste **inconnu** (`0`) — jamais une valeur inventée.

### (c) Division par zéro neutralisée
Les trois divisions par `priceToBeat` étaient déjà gardées par `priceToBeat > 0` (lignes 1120, 1176, 1640) ; la garde reste explicite et `estimateUpWinRate()` renvoie `0.5` si `priceToBeat <= 0`. Le cas `0` n'est donc plus jamais propagé en `Infinity/NaN` (il ne peut plus arriver en pratique, le strike étant désormais connu).

### (d) Log honnête
```ts
const ptbLabel = priceToBeat > 0
  ? `${priceToBeat.toFixed(2)} (source: ${this.priceToBeatSource})`
  : 'n/a (strike d\'ouverture indisponible — bougie Binance 1m absente)';
this.log(`New round: ${roundId}, Price to Beat: ${ptbLabel}`);
```
→ **`n/a`** au lieu d'un faux `0.00` ; la source est affichée.

### (e) Rattrapage best-effort
Le heartbeat (≤ 1×/min) retente le strike si `priceToBeat <= 0` (panne réseau transitoire), avec log `Price to Beat backfill: …`.

---

## 5. Preuve d'exécution du code corrigé (méthode réelle, via tsx)

Sonde temporaire hors-projet exécutant **la vraie méthode privée** `fetchRoundOpenPrice()` et **le vrai chemin** `checkAndStartNewRound()` (+ vrai `logHandler`) :

```
$ npx tsx /root/.hermes/cache/scratch/probe-diparb.ts
{"slug":"btc-updown-5m-1790464800","underlying":"BTC","slot":1790464800,"open":84387.67}
{"slug":"btc-updown-5m-1790465100","underlying":"BTC","slot":1790465100,"open":84374.02}
{"slug":"eth-updown-5m-1790465100","underlying":"ETH","slot":1790465100,"open":2694.12}
{"real_round_priceToBeat":84374.02,"log":"[DipArb] New round: btc-updown-5m-1790465100-1790465244464, Price to Beat: 84374.02 (source: binance-1m-open)"}
{"unknown_round_priceToBeat":0,"log":"[DipArb] New round: foo-updown-5m-1790465100-1790465244465, Price to Beat: n/a (strike d'ouverture indisponible — bougie Binance 1m absente)"}
EXIT=0
```

- Cas nominal → `Price to Beat: 84374.02 (source: binance-1m-open)` = **exactement** l'ouverture de la bougie 1m du §3 (84374.02), et **corrige** le `84388.96` erroné du log (ligne 248).
- Cas strike indisponible → `Price to Beat: n/a` (plus de `0.00` trompeur) ; le round est créé normalement (phase `waiting`), aucune exception, les décisions dépendant du strike sont simplement ignorées (gardes `> 0`).

### Vérification TypeScript finale

```
$ npx tsc --noEmit
EXIT=0
```

---

## 6. Ce qui change concrètement dans le log

| | AVANT | APRÈS |
|---|---|---|
| Flux prêt, spot ≠ ouverture | `Price to Beat: 84388.96` (faux, = spot T+9 s) | `Price to Beat: 84374.02 (source: binance-1m-open)` (vrai strike) |
| Flux pas prêt | `Price to Beat: 0.00` (paraît cassé) | `Price to Beat: 84374.02 (source: binance-1m-open)` — ou `n/a` si bougie indisponible |
| Division par zéro | possible (`0`) | impossible (strike > 0, sinon gardes) |

---

## 7. Réserve / limite explicite

- **Le vrai flux de résolution est le TWAP Chainlink 60 s, pas Binance.** La bougie Binance 1m au slot en est le **meilleur proxy public disponible** (le strike Chainlink n'est pas exposé publiquement, cf. §2) ; c'est déjà la méthode utilisée par `paperbot-recap.py`. Suppose une micro-divergence possible Binance↔Chainlink (normalement < quelques bps).
- **Second log, hors périmètre d'écriture :** `bot-with-dashboard.ts` (lignes 825-827) réaffiche `round.priceToBeat` en nombre brut (`0` si inconnu, jamais `0.00`). Le fix service garantit qu'en fonctionnement normal cette valeur est désormais le vrai strike ; le cas `inconnu` y afficherait `0`. Ce fichier n'est pas modifiable dans le périmètre de cette tâche.
- Le bot en cours d'exécution (`PM2 polymarket-paperbot`) tourne toujours l'ancien code : un redémarrage (géré par le parent) est nécessaire pour charger ce correctif.
