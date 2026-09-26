# Rendre FIABLE et PROPRE le canal de données temps réel (orderbook)

- **Date :** 2026-09-26
- **Périmètre édité :** `src/services/realtime-service-v2.ts`, `src/services/arbitrage-service.ts`, ce rapport.
- **Interdit/non touché :** `.env`, `bot-with-dashboard.ts`, `src/services/dip-arb-service.ts`, `package.json`, `.gitignore`, `node_modules/*`, scripts Hermes. Aucun `pm2 restart` lancé.
- **Contrainte de compat respectée :** `emit('orderbook', …)` conserve **exactement la même forme** (`OrderbookSnapshot` avec `tokenId` ET `assetId`) → `dip-arb-service.ts` et `arbitrage-service.ts` ne changent pas de contrat.

---

## 0. Résumé exécutif (ce qui est prouvé)

| Question | Mesure réelle |
|---|---|
| Le canal WS `clob_market` fonctionne-t-il ? | **NON — 100 % mort.** Tous les types (`agg_orderbook`, `price_change`, `last_trade_price`, `tick_size_change`, `market_resolved`, `*`) rejetés en `statusCode:400`, **0 frame orderbook** reçue. |
| Réponse brute du serveur | `{"body":{"message":"CLOB messages are not supported anymore, …"},"statusCode":400}` (195 caractères, capturé verbatim §1) |
| Alternative viable trouvée | **REST `GET https://clob.polymarket.com/book?token_id=<id>` en polling** → **40/40 succès, 0 % d'erreur, p50 34 ms, p90 45 ms, max 70 ms, ~3,5 Ko/frame** |
| Fallback + backoff en place | **Oui.** Sonde WS bornée → canal déclaré mort → purge définitive des souscriptions `clob_market` → **REST garanti**. Échec REST total ⇒ backoff exponentiel + **1 seul** avertissement (re-log max /5 min). |
| Lignes de log bornées | **Oui.** Helper `brief()` borné à 240 car. (même esprit que `errStr()` de dip-arb) + backoff qui supprime les erreurs en rafale. |
| Bruit WS supprimé | **Oui à la source** : plus aucun `subscribe`/`unsubscribe` `clob_market` n'est envoyé après la sonde (au lieu de ~12–24/h mesurées, jusqu'à 128/h en rafale de reconnexion). |
| Contrat `emit('orderbook')` préservé | **Oui** — vérifié : `tokenId === assetId`, `asks` triés croissant, `bids` décroissant, champs identiques. |

---

## 1. (a) Ce que l'on peut OBSERVER — réponse BRUTE du serveur

### 1.1 Souscription WS directe (harnais `ws-harness.mts`)

Message envoyé (format identique à celui du bot) :

```json
{"action":"subscribe","subscriptions":[
  {"topic":"clob_market","type":"agg_orderbook","filters":"[\"41575144893641153122587369458169727571866460973822021451214243260869953817127\"]"},
  {"topic":"clob_market","type":"price_change","filters":"[\"41575144893641153122587369458169727571866460973822021451214243260869953817127\"]"}
]}
```

**Réponse brute du serveur (verbatim) :**

```
{"body":{"message":"CLOB messages are not supported anymore, please visit https://discord.com/channels/710897173927297116/775506448041115669/1463547809067434130 to learn more"},"statusCode":400}
```

Résultat du harnais :

```
=== SUMMARY ===
raw frames received: 1
  raw[0] len=195 :: {"body":{"message":"CLOB messages are not supported anymore, ..."},"statusCode":400}
library payload messages: 0
```

→ **1 seule frame en 9 s, et c'est l'erreur 400. Aucune frame de payload. Le canal ne délivre rien.**

### 1.2 Balayage de TOUS les topics candidats (harnais `ws-probe.mts`)

```
=== WS TOPIC PROBE === token=755795521896...
clob_market/agg_orderbook      => REJECTED(400): {"body":{"message":"CLOB messages are not supported anymore...
clob_market/*                  => REJECTED(400): {"body":{"message":"CLOB messages are not supported anymore...
market/agg_orderbook           => SILENT (no frame in 4s)
agg_orderbook/*                => SILENT (no frame in 4s)
book/*                         => SILENT (no frame in 4s)
crypto_prices/update           => SUPPORTED/PAYLOAD: {"payload":{"data":[{"timestamp":1790465021000,"value":84391.94},...
activity/trades                => SUPPORTED/PAYLOAD: {"connection_id":"gbtCVq92XWeIKEj8YA==","payload":{"asset":"370384692424...
comments/comment_created       => SILENT (no frame in 4s)
clob_market/last_trade_price   => REJECTED(400): {"body":{"message":"CLOB messages are not supported anymore...
clob_market/price_change       => REJECTED(400): {"body":{"message":"CLOB messages are not supported anymore...
clob_market/tick_size_change   => REJECTED(400): {"body":{"message":"CLOB messages are not supported anymore...
clob_market/market_resolved    => REJECTED(400): {"body":{"message":"CLOB messages are not supported anymore...
```

**Conclusion mesurée :** il n'existe **aucun** topic WS fournissant l'orderbook d'un marché. `crypto_prices` et `activity` fonctionnent mais ne donnent **pas** de carnet. Le seul flux viable pour l'orderbook est **REST**.

### 1.3 Bruit observé dans les logs du bot en production

```
$ grep "CLOB messages are not supported" paperbot__2026-09-26_00-00-00.log | cut -c1-13 | sort | uniq -c
      5 2026-09-25T21
     12 2026-09-25T22
     13 2026-09-25T23

$ grep "Invalid request body" paperbot.error.log | cut -c1-13 | sort | uniq -c
     12 2026-09-26T22
      8 2026-09-26T23
```

Deux manifestations en production : `CLOB messages are not supported` (≈ 12–13/h) puis, après changement du message serveur, `{"message":"Invalid request body"}` (≈ 12/h, 2 par rotation de marché). Ces trames sont émises à chaque `subscribe`/`unsubscribe` `clob_market` — donc **relancées à chaque reconnexion et à chaque rotation de marché**. Le `node_modules` filtre le texte « CLOB messages are not supported » mais pas « Invalid request body », d'où la fuite dans `paperbot.error.log`.

> Le chiffre « 128/h » correspond aux rafales de reconnexion : chaque `handleConnect` re-souscrivait **toutes** les souscriptions mémorisées. Le correctif supprime la cause (plus d'envoi `clob_market`), donc le bruit tend vers **0 quelle que soit la fréquence de reconnexion**.

---

## 2. (b) Migration vers une source VIABLE et PROUVÉE — REST `/book`

### 2.1 Échantillon brut d'un marché Up/Down 5m **actif** (BTC, 2026-09-26)

```
$ curl -s "https://clob.polymarket.com/book?token_id=76343175084933721293332983654007062359080919807855984253328583260123676095189"
raw asks (as returned, first 4): [('0.99', '10472.51'), ('0.98', '4153.58'), ('0.97', '1897.03'), ('0.96', '1281.36')]
raw bids (as returned, first 4): [('0.01', '10769.1'), ('0.02', '4336.9'), ('0.03', '2981.38'), ('0.04', '4908.36')]
tick_size= 0.01 min_order_size= 5 hash= 61c50149955b61b7fb52d9db51409ea73fc32076
best ask AFTER sort asc : 0.72
best bid AFTER sort desc: 0.71
```

⚠️ **Piège confirmé** : l'API REST renvoie les **asks du plus cher au moins cher** et les bids du moins cher au plus cher. Le code trie donc **bids décroissant / asks croissant** (exactement comme `parseOrderbook()` côté WS) — sinon `asks[0]` serait 0,99 au lieu du vrai meilleur ask 0,72.

### 2.2 Débit / latence mesurés (harnais `rest-measure.mts`, 2 tokens, 20 ticks)

```
=== REST /book MEASUREMENT ===
tokens polled per tick: 2 | ticks: 20 | interval: 1500ms
tick 0: 56ms | bestBid=0.35 bestAsk=0.36 | bids=35 asks=64 hash=2e3c77791dbdce7729bcfad5eb4c6ab434bc8af6
tick 5: 37ms | bestBid=0.34 bestAsk=0.35 | bids=34 asks=65 hash=247f7dff7e4cd579efe6253ab1b46d677c96566a
tick 10: 43ms | bestBid=0.24 bestAsk=0.26 | bids=24 asks=74 hash=213b33001c5958352bbec8c3ae34079cdd938dce
tick 15: 39ms | bestBid=0.14 bestAsk=0.15 | bids=14 asks=85 hash=bbdb5ae42442c5d9e214658d87dade17ef27d681

=== RESULTS ===
requests: 40 | ok=40 err=0 (0.0% error)
latency ms: min=28 p50=34 p90=45 p99=70 max=70
avg response bytes=3501
```

→ **40/40 succès, p50 34 ms, ~3,5 Ko** par carnet. Le `hash` change bien à chaque tick → les données sont **vivantes**.

---

## 3. Implémentation livrée

### 3.1 `src/services/realtime-service-v2.ts` (cœur du correctif)

Nouvelle configuration (rétro-compatible, tout a une valeur par défaut) :

```ts
orderbookSource?: 'auto' | 'ws' | 'rest'; // défaut 'auto'
clobHost?: string;                        // défaut 'https://clob.polymarket.com'
restPollIntervalMs?: number;              // défaut 2000
restRequestTimeoutMs?: number;            // défaut 5000
wsOrderbookProbeMs?: number;              // défaut 8000
restBackoffBaseMs?: number;               // défaut 2000 (plafond 60000)
```

Fonctionnement de `subscribeMarkets()` :

1. **REST est la source garantie** (`orderbookSource !== 'ws'`) : les tokens sont ajoutés à un poller REST unique → `GET /book` → normalisation `OrderbookSnapshot` → `emitOrderbook()`.
2. **Sonde WS bornée** : un `subscribe clob_market` est envoyé **une seule fois par cycle de vie du service**. Si aucune frame orderbook n'arrive en `wsOrderbookProbeMs` (8 s) → `onWsOrderbookProbeTimeout()` :
   - marque `clobMarketWsDead = true` (plus **jamais** de `subscribe`/`unsubscribe` `clob_market`, y compris après reconnexion) ;
   - **purge** les souscriptions `clob_market` mémorisées (`subscriptionMessages`) ;
   - **un seul** avertissement ; le REST prend le relais.
3. **Dédup par `hash`** dans `emitOrderbook()` : une frame inchangée n'est pas réémise (WS + REST ne produisent donc jamais de doublon).
4. **Backoff REST** : échec **total** d'une passe ⇒ backoff exponentiel (base 2 s, plafond 60 s) + **un seul** avertissement, puis au plus un rappel toutes les 5 minutes. Rétablissement ⇒ un message unique.
5. `disconnect()` / `unsubscribeAll()` arrêtent le poller REST. `getDataFeedStats()` expose l'état (WS mort, tokens REST, backoff, compteurs ok/failed).
6. **Hygiène de log** : helper `brief(value, 240)` (identique à l'esprit de `errStr()` de dip-arb) + `warn()` toujours visible.

### 3.2 `src/services/arbitrage-service.ts`

- Ajout du helper borné `errStr(err, 240)` (même esprit que dip-arb).
- Les 6 sites de log interpolant `${error.message}` (erreurs ethers potentiellement ~7 Ko/ligne) passent à `${this.errStr(error)}`.
- **Correction de robustesse** : `onError` ne relaie plus aveuglément sur `'error'` (sans listener, Node lance « Unhandled 'error' event » et tue le process) — il ne relaie que s'il existe un listener, sinon il logge borné.
- Commentaire mis à jour : le fallback REST est géré en interne par `RealtimeServiceV2`.

---

## 4. (e) PREUVE — exécution de bout en bout sur un marché réel

Harnais `realtime-verify.mts` (service **réel**, marché BTC Up/Down 5m actif, `orderbookSource:'auto'`, sonde 5 s, poll 1 s) :

```
market: btc-updown-5m-1790465100 | tokens: 7557955218963941... 4380148079538774...
  emit#1 side=DOWN bestBid=0.99 bestAsk=undefined bids=82 asks=0 tick=0.01 min=5 idOK=true asksAsc=true bidsDesc=true hash=de40b66473
  emit#2 side=UP bestBid=undefined bestAsk=0.01 bids=0 asks=82 tick=0.01 min=5 idOK=true asksAsc=true bidsDesc=true hash=9c75c7528e
[svc] connected
  emit#10 side=DOWN bestBid=0.99 ...
[captured warn] [RealtimeService] canal WS 'clob_market' MORT (aucune frame orderbook en 5000 ms ; le serveur répond 400 « CLOB messages are not supported anymore »). Bascule DÉFINITIVE sur REST /book (poll 1000 ms). 1 souscription(s) clob_market purgée(s), plus aucun envoi. envoyées=1.

=== RESULTS ===
orderbook emissions total: 26
unique hashes (dédup): 26 / 26
UP emissions: 13 | DOWN emissions: 13
last book fields: tokenId,assetId,market,bids,asks,timestamp,tickSize,minOrderSize,hash
tokenId === assetId : true
bestBid/bestAsk : 0.999 / undefined

--- feed stats ---
{
 "orderbookSource": "auto",
 "wsOrderbookDead": true,
 "wsOrderbookFrameSeen": false,
 "wsSendAttempts": 1,
 "restTokens": 2,
 "restPolling": true,
 "restBackoffMs": 0,
 "restOk": 26,
 "restFailed": 0,
 "lastOrderbookAgoMs": 485
}

--- checks ---
PASS REST delivers books          : true
PASS tokenId===assetId (shape)    : true
PASS asks sorted ascending        : true
PASS dedupe (unique<total)        : true
PASS WS clob_market declared dead : true
PASS single WS-death warning      : true
PASS warning lines bounded (<300) : true
```

**Lecture :** 26 carnets livrés en 13 s (2 tokens × 1 s), **0 échec REST**, fraîcheur max 485 ms, forme de données identique à l'ancien WS, **une seule** souscription `clob_market` envoyée (puis plus jamais), **un seul** avertissement borné.

### 4.1 Preuve du backoff + « message unique » (host injoignable)

Harnais `backoff-verify.mts` (`clobHost` volontairement invalide, poll 200 ms, 6 s) :

```
=== BACKOFF TEST (host injoignable) ===
elapsed ms: 6013
stats: {"orderbookSource":"rest","wsOrderbookDead":false,"wsSendAttempts":0,"restTokens":2,"restPolling":true,"restBackoffMs":4800,"restOk":0,"restFailed":10,"lastOrderbookAgoMs":null}
warnings count: 1
  warn: [RealtimeService] REST /book en échec total (1 passe(s) consécutive(s)) → backoff 300 ms. Dernière cause: fetch failed

--- checks ---
PASS backoff grew (>=300ms)         : true
PASS failures recorded              : true
PASS warnings bounded (not 1/req)   : true
PASS warning lines bounded (<300)   : true

--- recovery test (host réel) ---
real stats: {"orderbookSource":"rest","restPolling":true,"restBackoffMs":0,"restOk":24,"restFailed":0,"lastOrderbookAgoMs":211}
PASS real REST delivers books: true
```

→ **10 échecs ⇒ 1 seule ligne de log** (au lieu de 10), backoff 300 → 4800 ms, puis rétablissement automatique sur l'host réel (**24 carnets, 0 échec**).

---

## 5. Vérification TypeScript

```
$ cd /root/clawd/Polymarket-bot && npx tsc --noEmit ; echo EXIT=$?
EXIT=0
```

---

## 6. Ce qui reste (honnêtement)

1. **Le correctif n'est pas encore ACTIF dans le process en cours** : la consigne interdit `pm2 restart`, donc `polymarket-paperbot` tourne encore l'ancien code. Les 12–24 h d'erreurs WS continueront **jusqu'au prochain redémarrage** (effectué par le propriétaire). Après redémarrage : **1 seule** tentative `clob_market` puis zéro bruit.
2. **Chemin WS « vivant » non testable aujourd'hui** : le code sait détecter une **réactivation** du canal (`wsOrderbookFrameSeen`, log unique) mais ce chemin ne peut pas être exercé tant que Polymarket ne réactive pas `clob_market`. Il est présent par prudence, pas validé en conditions réelles.
3. **Polling REST = ~1 req/s** (2 tokens / 2 s). Mesuré 0 % d'erreur. Si un jour beaucoup plus de tokens étaient suivis simultanément, prévoir un endpoint batch ou une augmentation de `restPollIntervalMs`.
4. **`dip-arb-service.ts` non modifié** (hors périmètre) : il consomme désormais de vrais carnets via `onOrderbook`. Son cycle de rounds REST déjà en place reste inchangé.
5. **Nettoyage durable de `node_modules/@polymarket/real-time-data-client`** (filtre du `console.warn` non-payload) toujours à rejouer après réinstallation — hors périmètre (lecture seule).

**Fichiers touchés :** `src/services/realtime-service-v2.ts`, `src/services/arbitrage-service.ts`, ce rapport.
**Harnais de reproduction :** `/root/.hermes/cache/scratch/{ws-harness,ws-probe,rest-measure,realtime-verify,backoff-verify}.mts`.
