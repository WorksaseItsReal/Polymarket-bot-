# AUDIT — `src/services/dip-arb-service.ts`

**Date** : 2026-09-27
**Fichier audité** : `src/services/dip-arb-service.ts` (2 563 lignes avant → 2 770 après assainissement)
**Périmètre d'écriture** : ce fichier uniquement (`.env`, `bot-with-dashboard.ts`, `package.json`, les autres fichiers de `src/` et `node_modules` n'ont pas été touchés).
**Compilation** : `npx tsc --noEmit` → **exit 0** (voir fin de document).

Historique pertinent rappelé : ce service a perdu son canal WebSocket `clob_market`
(mort, réponse serveur 400 « CLOB messages are not supported anymore ») et reçoit
désormais ses carnets par un **poller REST** ; le « price to beat » provient de
l'ouverture de la bougie Binance 1m au slot du round (plus du spot courant).

---

## 0. Synthèse

- **Problème critique corrigé** : le service émettait des signaux `Leg1` avec
  `estimatedProfitRate = 0` (cas normal d'un Leg1), ce que le consommateur
  traduisait en `stake * (0 - 1)` = **perte totale simulée à chaque signal**
  (2 514 occurrences mesurées côté bot). La source du `0` est corrigée :
  le service ne peut plus émettre un taux `0` / `NaN` / `∞` / non calculé.
- **Saturation de log corrigée** : le couple de messages
  `✅ Leg1 signal validated …` + `(Leg2 will check sumTarget …)` était logué à
  **chaque tick de carnet** (~2 s) — 3 867 occurrences mesurées dans les logs
  disponibles, jusqu'à 2 par seconde. Throttle + log unique par round appliqués.
- **Compteurs audités** : 2 incohérences réelles corrigées (`roundsCompleted`
  jamais incrémenté sur un round réussi via Leg2 ; `avgProfitRate` figé à 0) et
  1 compteur faussé corrigé (`Total profit` gonflé du principal à chaque
  redemption).
- **Robustesse** : 3 `emit('error')` supprimés (aucun listener dans le bot →
  « Unhandled 'error' event » = **crash du process**), 5 divisions par zéro
  potentielles gardées, erreurs loguées bornées via `errStr()` partout où c'est
  nécessaire.
- **Signalé sans correction** (hors zone ou décision de design) : voir §7.

---

## 1. Sémantique réelle de leg1 / leg2 / `sumTarget` / « Instant DIP detected »

_Le service produit un arbitrage à deux jambes sur les marchés Up/Down (payout
$1 par paire si les deux côtés sont détenus)._

### Leg1 — la jambe d'entrée (« acheter le creux »)
- **Rôle** : acheter le côté qui vient de **chuter** (dip) ou qui est
  **sous-évalué** (mispricing) — l'idée étant d'acquérir ce côté bon marché.
- **Producteur** : `detectLeg1Signal()` → `createLeg1Signal()`.
- **Condition d'émission** : `validateSignalProfitability()` ne vérifie QUE le
  prix (`0 < price < 1`) et l'amplitude (`dropPercent ≥ dipThreshold`).
  **Elle ne vérifie PAS la rentabilité du couple** — c'est pour ça qu'un Leg1
  est normalement *non rentable seul* : il attend que l'autre côté baisse.
- **Champs** : `estimatedTotalCost = targetPrice + oppositeAsk` (coût estimé du
  couple complet), `estimatedProfitRate` = taux de profit estimé du signal.

### Leg2 — la jambe de couverture
- **Rôle** : acheter le côté **opposé** une fois qu'il est assez bas pour que le
  coût TOTAL des deux jambes soit < $1 → profit verrouillé.
- **Condition d'émission** (`detectLeg2Signal()`) :
  `totalCost = leg1.price + targetPrice ≤ sumTarget`.
  `estimatedProfitRate` y est nommé `expectedProfitRate`.
- **Contrainte** : `shares` de Leg2 = `shares` de Leg1 (couverture équilibrée).

### `sumTarget` (défaut `0.92`)
- **Seuil de coût total maximum** des deux jambes pour déclencher Leg2.
  `0.92` ⇒ profit verrouillé ≥ `(1 - 0.92) / 0.92 ≈ +8,7 %` par paire.
- **N'est vérifié QUE dans Leg2** (commentaire explicite dans
  `validateSignalProfitability` : « not checked at Leg1 stage »).
- ⚠️ `minProfitRate` (0.03, `dip-arb-types.ts`) existe dans la config mais n'est
  **jamais utilisé** par ce service → voir §7.3.

### `estimatedProfitRate` / `expectedProfitRate`
- Définition d'origine (dans `dip-arb-types.ts`) :
  `calculateDipArbProfitRate(cost) = (1 - cost) / cost`, **mais** renvoie `0`
  si `cost >= 1` **ou** `cost <= 0` :

  ```ts
  export function calculateDipArbProfitRate(totalCost: number): number {
    if (totalCost >= 1 || totalCost <= 0) return 0;
    return (1 - totalCost) / totalCost;
  }
  ```

- **Cas où le taux ne peut PAS être calculé — donc valait 0 :**
  1. **Leg1** : `estimatedTotalCost ≥ 1` (l'autre côté est encore cher). C'est le
     **cas normal** d'un Leg1, d'où 2 514 signaux à `0`.
  2. **Leg2** : ne se produit pas avec `sumTarget = 0.92`, mais se produirait si
     `sumTarget` était configuré `≥ 1`.
  3. Prix corrompu / `targetPrice = 0` / `NaN` → `0` également.
- Le `0` était **ambigu** : « pas d'arbitrage verrouillable maintenant » a été
  interprété par le consommateur comme « taux = 0 » → `stake * (0 - 1)`.

### « Instant DIP detected »
- Log de la **détection d'un creux instantané** : baisse de l'ask d'un côté
  ≥ `dipThreshold` (0.15) sur la fenêtre glissante `slidingWindowMs` (3 000 ms,
  cœur de la stratégie). Déclenche un Leg1 « source: dip ». Le message est
  logué **avant** la validation (`validateSignalProfitability`).

---

## 2. CORRIGÉ — La source du taux de profit à 0

### 2.1 Preuve
Code d'origine (`createLeg1Signal`, ex-ligne 1617) :

```ts
const estimatedProfitRate = calculateDipArbProfitRate(estimatedTotalCost);
```
→ `0` dès que `targetPrice + oppositeAsk ≥ 1` (cas normal). Le signal était
ensuite retourné tel quel (la validation ne contrôlait pas le taux).

Côté consommateur (`bot-with-dashboard.ts`, hors zone) : `stake * (0 - 1)`
inscrit une **perte totale de la mise par signal** ; 2 514 occurrences mesurées
ont détruit le PnL en mémoire et déclenché une pause silencieuse de 7 jours.

### 2.2 Correctif (`createLeg1Signal`, ligne 1709)
Nouveau calcul via un helper dédié `leg1ProfitRate(targetPrice, oppositeAsk)` :

```ts
const estimatedProfitRate = this.leg1ProfitRate(targetPrice, oppositeAsk);
if (estimatedProfitRate === null) {
  // …log throttlé… puis on N'ÉMET PAS le signal
  return null;
}
```

`leg1ProfitRate()` (ligne 2724) renvoie, dans l'ordre :
1. le **vrai taux d'arbitrage 2-leg** `(1 - coût) / coût` **si** `coût < 1`
   (arbitrage déjà verrouillable) ;
2. sinon le **rendement intrinsèque du Leg1** `(1 - targetPrice) / targetPrice`
   (gain si ce côté gagne) — toujours `> 0` pour `0 < targetPrice < 1` ;
3. sinon **`null`** → signal rejeté (jamais émis).

Chiffres réels (calcul vérifié) :

| ask | opposite | cost | ANCIEN taux | NOUVEAU taux |
|----:|---------:|-----:|------------:|-------------:|
| 0.42 | 0.60 | 1.0284 | **0** | 1.3343 (rendement du leg) |
| 0.35 | 0.55 | 0.9070 | 0.1025 | 0.1025 (arb 2-leg) |
| 0.55 | 0.40 | 0.9610 | 0.0406 | 0.0406 (arb 2-leg) |
| 0.99 | 0.02 | 1.0298 | **0** | **rejet** (target ≥ 1) |

### 2.3 Correctif Leg2 (`detectLeg2Signal`, ligne 1777)
Garde explicite avant émission :

```ts
if (!Number.isFinite(totalCost) || totalCost <= 0 ||
    !Number.isFinite(expectedProfitRate) || expectedProfitRate <= 0) {
  // …log throttlé… + return null      → JAMAIS d'émission à 0/NaN/∞
}
```

### 2.4 Correctif ceinture+bretelles (`validateSignalProfitability`, ligne 1826)
Refus explicite de tout signal dont le taux n'est pas fini et `> 0` :

```ts
if (!Number.isFinite(signal.estimatedProfitRate) || signal.estimatedProfitRate <= 0) {
  return false;   // ✅ plus aucun `0` ne peut passer
}
```

### 2.5 Effet
Un consommateur qui reçoit un signal peut désormais **toujours** faire
`profitRate > 1` ou retomber sur son calcul de repli `1/prix - 1` : **plus
aucune perte totale fantôme**. Le contrat « jamais 0 / non calculé / NaN / ∞ »
est garanti par **trois** barrières indépendantes (calcul, validation, garde
Leg2).

---

## 3. CORRIGÉ — Cohérence des compteurs

### 3.1 `Rounds monitored`
- Incrémenté (ligne 1414) à la **création d'un nouveau round** dans
  `checkAndStartNewRound()`. ✅ Correct.
- ⚠️ `start()` réinitialise `this.stats = createDipArbInitialStats()` : les
  compteurs repartent de 0 à **chaque rotation de marché**. Comportement de
  design (stats « par marché »), **signalé sans correction** (§7.1).

### 3.2 `Rounds completed` — 🐞 CORRIGÉ
- **Avant** : incrémenté uniquement par (a) round `waiting` clos à la fin du
  marché (ligne 1353) et (b) timeout Leg1 → `expired` (ligne 1452). Un round
  **réussi** (Leg2 rempli → `phase = 'completed'`) n'incrémentait **jamais**
  `roundsCompleted` → sous-comptage permanent.
- **Correctif** (ligne 912, dans `executeLeg2` après remplissage) :
  ```ts
  this.stats.roundsCompleted++;
  ```
  Aucun double comptage : les deux autres chemins filtrent sur
  `phase === 'waiting'` / `'leg1_filled'`, or `executeLeg2` met `'completed'`.

### 3.3 `Rounds successful` (Leg2 filled)
- Incrémenté uniquement lors du remplissage effectif de Leg2 (`leg2Filled++`).
  ✅ Correct et distinct de `roundsCompleted`.

### 3.4 `Total profit` — 🐞 CORRIGÉ
- **Réel et correct** dans `executeLeg2` :
  `+= (1 - actualTotalCost) * totalSharesFilled` → profit verrouillé par part ×
  parts. ✅ Calculé sur quelque chose de réel.
- **Correct** aussi dans `emergencyExitLeg1` (perte réelle retirée).
- **Faux** dans `processPendingRedemptions` (`+= amountReceived`) : ce montant est
  le **BRUT reçu**, incluant le remboursement du principal → chaque redemption
  gonflait le profit du capital engagé.
  **Correctif** (ligne ~2323) : on n'ajoute que le **net**
  `amountReceived − (leg1.price×leg1.shares + leg2.price×leg2.shares)`, et
  **uniquement si la base de coût est connue** ; sinon le montant est logué mais
  non compté (position de récupération sans base).
- `avgProfitRate` **restait figé à 0** malgré sa présence dans `DipArbStats`.
  **Correctif** (ligne 918) : maintenu à `totalProfit / totalSpent` (0 si aucune
  dépense).

---

## 4. CORRIGÉ — Saturation CPU / logs (boucle à vide)

### 4.1 Preuve
```
$ wc -l paperbot.log paperbot__2026-09-2*.log   → 18 628 lignes
$ grep -c "Leg2 will check sumTarget when opposite price drops" …   → 3 867
```
Top des messages (tous logs confondus):
```
3867  [DipArb]    (Leg2 will check sumTarget when opposite price drops)
2445  [DipArb] ✅ Leg1 signal validated: DOWN @ N, drop N%
1422  [DipArb] ✅ Leg1 signal validated: UP @ N, drop N%
```
Occurrences horodatées jusqu'à **2 par seconde** (ex. `paperbot.log` lignes
268/273/275 : 10:30:25, 10:30:25, 10:30:27) pendant ~2 h (10:30 → 12:37).
La mention « 11 475 lignes » du brief est cohérente avec la cadence mesurée
(le service tourne en `debug: true`, cf. `bot-with-dashboard.ts:809`).

### 4.2 Cause racine
`detectLeg1Signal()` est appelé à **chaque `handleOrderbookUpdate()`** (poller
REST ~2 s), et `validateSignalProfitability()` loguait **2 lignes à chaque
validation**. Le flag `leg1SignalEmitted` existait (déclaré, réinitialisé) mais
n'était **jamais lu ni écrit** → aucune déduplication.

### 4.3 Correctif
- Nouveau helper `logThrottled()` (ligne 2745) : **≤ 1 ligne /
  `VALIDATION_LOG_INTERVAL_MS` (30 s)**, avec compteur de suppressions.
- `validateSignalProfitability()` : le message `(Leg2 will check sumTarget …)`
  n'est émis qu'**une fois par round** (via le flag `leg1SignalEmitted`
  désormais réellement utilisé) et la ligne `✅ Leg1 signal validated` est
  passée au throttle en indiquant le nombre de validations non loguées.
- Tous les rejets de signal passent aussi par `logThrottled()`.
- `checkAndStartNewRound()` : le `console.log('…Market has ended…')` non gaté
  (1 ligne / ~5 s tant qu'aucun round n'existe) est limité à **1 fois par
  épisode** (`loggedMarketEndedNoRound`).
- Le throttle est réarmé à chaque nouveau round et à chaque nouveau marché.

**Effet attendu** : ~1 ligne / 30 s au lieu de ~1–2 / s pour ces messages →
≈ 60× moins de lignes sur le même couple, sans perdre le comptage.

_NB : la charge CPU reste bornée par la cadence du poller (2 s) ; il n'y a pas
de boucle while/for non bornée. Le seul « vide » était la production de logs._

---

## 5. CORRIGÉ — Divisions par zéro, `Number.isFinite`, accès tableaux

| # | Lieu | Avant | Risque | Correctif |
|---|------|-------|--------|-----------|
| 1 | `executeLeg1` `MIN_TRADE_VALUE / signal.targetPrice` | division nue | `Infinity`/`NaN` si `targetPrice = 0` | garde `Number.isFinite && > 0` en tête de `try` |
| 2 | `executeLeg2` `1 / signal.targetPrice` | division nue | idem | idem |
| 3 | `executeLeg1` slippage `/ signal.currentPrice` | division nue | `∞` dans log | ternaire `currentPrice > 0 ? … : 0` |
| 4 | `executeLeg2` slippage `/ signal.currentPrice` | division nue | idem | idem |
| 5 | `logOrderbookContext` `/ first.upAsk`, `/ first.downAsk` | division nue | `0/0 = NaN` → « Change: UP NaN% » | ternaire `> 0 ? … : 'n/a'` |
| 6 | `Number.isFinite(0)` | — | piège : `Number.isFinite(0) === true` | tous les gardes de taux sont `Number.isFinite(x) && x > 0` (jamais `isFinite` seul) |

**Accès à des tableaux vides** — vérifiés et **déjà corrects** (aucune
correction nécessaire, mais contrôlés) :
- `this.upAsks[0]?.price ?? 1` / `downAsks[0]?.price ?? 1` dans `detectLeg2Signal`,
  suivi de `if (currentPrice >= 1) return null;` → carnet vide = pas de signal.
- `getPriceFromHistory()` renvoie `null` si l'historique est vide ; tous les
  appelants testent `!== null && > 0`.
- `merge()` : `Math.min(leg1?.shares || 0, leg2?.shares || 0)` puis
  `if (shares <= 0) return …`. ✅
- `logOrderbookContext` : `if (buffer.length === 0) return;` avant `first/last`.
  ✅

---

## 6. CORRIGÉ — Erreurs loguées bornées (`errStr()`)

`errStr()` (240 caractères) existait déjà mais plusieurs erreurs le
contournaient. Appliqué désormais :

| Lieu | Avant | Après |
|------|-------|-------|
| `merge()` catch (l. ~1049) | `String(error)` non borné (messages ethers de plusieurs Ko) | `this.errStr(error)` |
| `executeLeg1` catch (retour `error`) | `error.message` | `this.errStr(error)` |
| `executeLeg2` catch (retour `error`) | `error.message` | `this.errStr(error)` |
| `emergencyExitLeg1` (log + retours) | `result.errorMsg` brut | `this.errStr(result.errorMsg)` |
| `executeLeg1/2` ordres échoués | `result.errorMsg` brut | `this.errStr(result.errorMsg)` |
| `processPendingRedemptions` (`settled.error`) | `error.message` | `this.errStr(error)` |
| `scanUpcomingMarkets` (l. 282) | `emit('error')` | log borné |
| `handleOrderbookUpdate` → `checkAndStartNewRound` (l. 1104) | `emit('error')` | log borné |
| souscription carnet `onError` (l. 400) | `emit('error')` | log borné |

**Pourquoi les 3 `emit('error')` sont un bug** : `EventEmitter` lève
« **Unhandled 'error' event** » et **tue le process** s'il n'y a pas de
listener. Or `bot-with-dashboard.ts` (le bot réel) n'enregistre **aucun**
`.on('error')` sur `sdk.dipArb` (vérifié par `grep`). Chaque erreur de cette
liste était donc un crash potentiel — désormais loguée bornée.

---

## 7. SIGNALÉ (non corrigé dans cette passe)

### 7.1 Réinitialisation des stats à chaque rotation
`start()` fait `this.stats = createDipArbInitialStats()` : `Rounds monitored`,
`Total profit`, etc. repartent de zéro à chaque nouveau marché. C'est
probablement voulu (stats par marché) mais **empêche tout cumul global**.
À trancher côté design (le dashboard agrège-t-il déjà ?). Hors correction ici
car changer le comportement pourrait casser l'affichage.

### 7.2 Double comptage possible du profit (redemption après round 2-leg non mergé)
Si `autoMerge = false`, un round réussi (profit déjà ajouté par `executeLeg2`)
peut ensuite être **redeemé** → le net de redemption serait ajouté **en plus**.
Avec le correctif §3.4 le montant net est petit mais ce scénario reste à
surveiller. Non corrigé (nécessite un suivi « déjà comptée » par round, un champ
supplémentaire).

### 7.3 `minProfitRate` non utilisé
`config.minProfitRate` (0.03) n'est lu **nulle part** dans ce service : aucun
seuil de rentabilité minimum n'est appliqué à Leg1. Le choix actuel (émettre un
Leg1 dès qu'il y a un creux, en s'appuyant sur Leg2 pour la rentabilité) est
défendable mais la config est **trompeuse**. Signalé sans correction (changer le
comportement de détection sort du strict périmètre « taux non nul »).

### 7.4 `conditionId` non validé dans `start()`
`start()` valide `upTokenId`/`downTokenId` mais pas `conditionId`, utilisé via
`.slice(0, 20)` → crash si absent. Faible risque (toujours fourni par le scan).

### 7.5 `priceToBeat` inconnu = 0 (strike « n/a »)
Quand la bougie Binance 1m est indisponible, `priceToBeat = 0` : les blocs
*mispricing* et `btcInfo` sont alors **inactifs** pour le round (dégradation
gracieuse, log déjà honnête `n/a`). Pas un bug, mais à garder en tête : cela
réduit le nombre de sources de signaux.

---

## 8. Fichiers modifiés

- `src/services/dip-arb-service.ts` (seul fichier de code touché)
- `docs/rebuild/diparb/AUDIT.md` (ce document)

---

## 9. Vérification de compilation

```
$ cd /root/clawd/Polymarket-bot && npx tsc --noEmit
EXIT=0
```

Tests passants (non-régression du garde consommateur, inchangé) :

```
$ npx vitest run                       → Test Files 2 passed, Tests 37 passed
$ npx tsx --test tests/profit-ratio-guard.test.ts → # pass 6 / # fail 0
```

