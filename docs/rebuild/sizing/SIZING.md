# SIZING.md — Dimensionnement ADAPTATIF de la mise (paperbot Polymarket Up/Down 5m)

**Module** : `src/services/stake-sizing.ts` — fonction PURE `computeStake(input): StakeSizingResult`.
**Tests** : `tests/stake-sizing.test.ts` — 23 cas, exécutés réellement (`npx tsx --test`).
**Objet** : remplacer la mise **fixe** `BET_STAKE=5` (10 % du capital à 50 €) par une mise
**calculée**, mesurable, explicable et **plafonnée**.
**Documents liés** : `docs/rebuild/risk/RISK.md`, `docs/rebuild/strategy/EDGE.md`,
`docs/rebuild/monitoring/MONITORING.md`.

---

## 🔴 À LIRE D'ABORD — l'honnêteté

> **Le sizing ne crée PAS d'edge. Il ne peut que répartir le risque d'une edge DÉJÀ
> présente. Si l'espérance par trade est nulle ou négative, aucune formule de mise ne rend
> le bot rentable — la meilleure mise est alors 0 €.**

Et l'edge **n'est pas prouvé** :

| Mesure (EDGE.md / MONITORING.md) | Valeur |
|---|---|
| t-statistique du PnL | **+1,25** (n=167) à **+1,75** (n=66) |
| Seuil usuel 95 % | \|t\| > 1,96 |
| **Seuil Bonferroni (10 tests)** | **\|t\| > 2,81** |
| Verdict | **NON SIGNIFICATIF — bruit** ; IC95 du PnL total contient zéro |
| n requis pour trancher | ≈ 427 trades (mesuré : 167) |

Ce module applique donc **trois protections** qui n'ont de sens que parce que l'edge est
non prouvée : un **shrinkage** de la probabilité vers le prix marché, une **fraction de
Kelly** (quart), et des **plafonds durs** calés sur l'hypothèse « edge = 0 ».

---

## 1. La règle retenue (formule exacte)

Sur un marché binaire réglé **tout-ou-rien** (le token saute de `prix` à 1 ou 0, aucune
dérive continue : RISK.md §1), la mise défendable repose sur **une seule** grandeur
mesurable — l'écart entre une probabilité de gain estimée et le seuil d'équilibre du
marché.

### 1.1 Modèle et identités

```
b   = gain_moyen / |perte_moyenne|        (observé sur la coin ; défaut = (1−e)/e)
BE  = 1 / (1 + b)                          probabilité d'équilibre   [= prix d'entrée]
E   = p̂ · (1 + b) − 1                      espérance par unité misée (> 0 ⟺ p̂ > BE)
f*  = p̂ − (1 − p̂)/b  =  ((1+b)·p̂ − 1)/b    fraction de Kelly (> 0 ⟺ p̂ > BE)
```

**Pourquoi `BE = prix d'entrée`** : c'est l'identité démontrée dans EDGE.md —
`WR_break-even = 1/(1+b) = p`. Un bot qui gagne exactement aussi souvent que le prix
qu'il paie ne gagne rien. **Le seul levier réel est le prix d'entrée face au win rate.**

### 1.2 Probabilité estimée `p̂` — le SHRINKAGE (cœur de l'honnêteté)

Le win rate empirique est bruité (t ≈ 1,5 ⇒ l'IC95 du PnL contient zéro). On ne peut donc
pas le prendre au pied de la lettre. On le **rétrécit vers le prix marché** avec une
crédibilité de Bühlmann :

```
signal   = win rate empirique  SI  n ≥ 5         (sinon : probabilité du carnet, sinon : rien)
λ        = n / (n + N0)          avec N0 = 20
p̂        = e + λ · (signal − e)
```

- `λ = 0` (n = 0) ⇒ `p̂ = e` ⇒ **edge = 0 ⇒ mise 0**. Sans données, on ne parie pas.
- `λ = 20/40 = 0,5` quand on n'a que le carnet (pseudo-comptage de 20 observations).
- `λ = 0,76` à n = 65 (échantillon actuel) ; `λ = 0,91` à n = 200 (seuil de re-décision de
  RISK.md) ; `λ = 0,96` à n = 500.
- Conséquence : **plus l'échantillon est mince, plus `p̂` est ramené vers le prix** — donc
  plus la mise est petite. C'est exactement le comportement que le manque de preuve exige.

> **Défendable parce que** : le shrinkage est l'estimateur qui minimise l'erreur quadratique
> attendue quand on dispose d'un a priori (ici le prix marché, sous H0 « edge = 0 ») et d'un
> échantillon bruité. Il ne peut **jamais inventer** un edge : si le carnet vaut exactement
> le prix, `p̂ = e` quel que soit λ (test 8).

### 1.3 Mise Kelly fractionnaire

```
mise_kelly_brute = capital × K × f*        avec K = KELLY_FRACTION = 0,25  (quart de Kelly)
```

**Pourquoi le quart et pas Kelly plein** : Kelly plein (`f*`) est optimal **si `p̂` est
CONNU**. Ici `p̂` est estimé sur un échantillon où l'edge n'est pas prouvé : le `f*` mesuré
(≈ 19 % du capital) suppose l'edge vraie, et n'offre aucune protection contre l'hypothèse
où elle serait nulle (RISK.md §3 : « Kelly est une fonction *discontinue* de la croyance en
l'edge »). Le **Kelly fractionnaire** est la réponse standard à l'incertitude de paramètre
(Thorp ; MacLean-Thorp-Ziemba) : il conserve ≈ 3/4 de la croissance asymptotique pour une
variance très inférieure. `f*` est en outre borné à `[0, 1]` (`KELLY_F_MAX`).

### 1.4 Modérateurs (adaptativité en cours de session)

| Situation | Facteur | Source |
|---|---|---|
| drawdown < 5 % | ×1 | RISK.md §5.3 |
| drawdown ≥ 5 % | ×0,75 | RISK.md §5.3 |
| drawdown ≥ 10 % | **×0,5** | RISK.md §5.3 (« réduire la mise de moitié ») |
| drawdown ≥ 20 % | **×0 (STOP)** | RISK.md §5.3 |
| pertes consécutives < 4 | ×1 | RISK.md §5.2 |
| pertes consécutives ≥ 4 | **×0,5** | RISK.md §5.2 (signal précoce) |
| pertes consécutives ≥ 8 | **×0 (STOP)** | RISK.md §5.2 (kill-switch à 8) |

### 1.5 PLAFONDS DURS (non contournables) — `mise = min(kelly_modérée, caps)`

| # | Plafond | Constante | Justification |
|---|---|---|---|
| 1 | **≤ 1 % du capital par trade** | `MAX_VARIANCE_PCT = 0.01` | RISK.md §3 : borne de variance sous l'**hypothèse edge ZÉRO** (`P(DD>50 %) ≤ 5 %`) — 0,97 % ≈ 1 %. C'est **le plafond qui mord en pratique**. |
| 2 | ≤ 2 % du capital par trade | `MAX_TRADE_PCT = 0.02` | RISK.md §5.1 (« ne jamais dépasser 2 % »), défense en profondeur |
| 3 | ≤ 5 % / 3 pertes = **1,667 %** | `DAILY_LOSS_PCT`, `MIN_LOSSES_TO_DAILY_LIMIT` | Le cadre existant (perte quotidienne = 5 % du capital) doit exiger **≥ 3 pertes consécutives** pour être atteint. **Une seule perte ne peut pas consommer la limite quotidienne.** |
| 4 | ≤ **10 % du capital exposé simultanément** | `MAX_EXPOSURE_PCT = 0.10` | **5 coins peuvent être ouverts en même temps** : le budget d'exposition `10 % − déjà exposé` est la limite du portefeuille |
| 5 | ≤ **25 €** absolu | `MAX_STAKE_EUR = 25` | Valve de sécurité anti-bug/décimale, indépendante du capital |
| 6 | ≤ 5 positions simultanées | `maxConcurrentPositions` (défaut 5) | Refus si toutes les coins sont déjà engagées |

**Pourquoi 5 plafonds redondants** : si une constante est un jour modifiée par erreur, les
autres continuent de borner. La hiérarchie est **volontairement** redondante —
défense en profondeur, jamais un plafond unique « qu'on peut lever ».

### 1.6 Mise PLANCHER et comportement à confiance faible

```
plancher = max(0,10 € , 0,2 % du capital)          (MIN_STAKE_EUR, MIN_STAKE_PCT)
```

- **Confiance faible / pas de signal** → `stake = 0` (ne pas miser), jamais une grosse mise
  déguisée. Cas explicites : historique vide ; n < 5 sans carnet ; edge ≤ 0.
- **Le plancher ne s'applique QU'À une mise Kelly INFÉRIEURE à lui** : il ne peut **jamais**
  relever une mise au-dessus d'un plafond, ni ressusciter un trade interdit par un STOP
  drawdown/série de pertes (test 16, 18, 20).
- Si le plancher dépasse le plafond autorisé (capital minuscule, ex. 3 €), **le module refuse
  de trader** plutôt que de violer le cadre de risque (test 20).

### 1.7 Cas dégénérés traités explicitement

| Cas | Comportement | Test |
|---|---|---|
| prix hors de ]0,1[ (0, 1, 1,5, <0, NaN) | `stake = 0`, rationale « hors de ]0,1[ » | 1 |
| capital ≤ 0 ou NaN | `stake = 0` | 2 |
| historique vide + carnet absent | `stake = 0`, « Aucun signal de probabilité » | 3 |
| n < 5, pas de carnet | win rate **ignoré** → `stake = 0` (un WR à 4 trades ne déclenche rien) | 4 |
| n < 5 + carnet fourni | signal **carnet seul**, λ = 0,5, rationale « Confiance faible » | 5 |
| edge nul (WR = BE) | `stake = 0` | 6 |
| edge négatif | `stake = 0` | 7 |
| carnet = prix | `p̂ = e`, edge ≈ 0 → `stake = 0` | 8 |
| win rate indisponible | repli sur le carnet, sinon refus | 3, 22 |
| b (gain/perte) indisponible | repli `b = (1−e)/e` (théorique), rationale « [théoriques] » | 22 |
| exposition 10 % atteinte | refus (`capped = true`) | 14 |
| 5 positions ouvertes | refus (`capped = true`) | 15 |

---

## 2. Pourquoi cette règle est DÉFENDABLE (et pas une constante déguisée)

1. **Chaque nombre a une source externe au module.** `0,01` vient de la borne de variance
   RISK.md ; `0,05 / 3` du cadre quotidien existant ; `0,10` de « 5 coins simultanés » ;
   `0,25` du Kelly fractionnaire ; `N0 = 20` d'une courbe de crédibilité **explicite** (λ
   affiché dans chaque rationale). Aucun n'a été calibré sur les données du bot.
2. **Les données ne peuvent pas « gonfler » la mise.** Le shrinkage ramène `p̂` vers le prix
   marché quand n est petit ; les plafonds sont indépendants du win rate. Un WR de 100 % sur
   4 trades ne produit rien (test 4) ; un WR de 75 % sur 65 trades produit **exactement** le
   même 1 % du capital qu'un WR de 65 % (test 11) — **on ne paie pas plus cher une
   incertitude**.
3. **La mise est reproduite par la table de RISK.md.** Le module sort **0,20 / 0,50 / 1,00 /
   2,00 / 5,00 €** pour 20 / 50 / 100 / 200 / 500 € — exactement la ligne « s_max (edge
   ZÉRO) » de RISK.md §3 (test 9b). Le sizing est donc *dérivé* du document de risque, pas
   concurrent de lui.
4. **Le coût de l'erreur est asymétrique** (RISK.md §6) : se tromper trop petit coûte une
   opportunité (récupérable) ; se tromper trop gros détruit le capital (non récupérable).
   Toute la conception penche du côté « trop petit ».
5. **Avec 50 € de capital, `BET_STAKE = 5 €` viole le cadre** : 1 perte = 10 % du capital =
   **200 % de la limite quotidienne**. Le sizing la ramène à 0,50 € (1 %), soit
   **1 perte = 20 % de la limite quotidienne**.

---

## 3. TABLEAUX DE MISES RÉSULTANTES (chiffres produits par le code, pas à la main)

> Sorties brutes du code exécuté : `npx tsx gen_sizing_table.ts` (script d'appel du module,
> sans effet de bord). Contexte : entrée 0,625 € ; `b = 0,60` (gain moyen 0,60 par perte de
> 1,00) ⇒ **BE = 62,50 %** ; n = 65 trades résolus ; aucun drawdown, aucune perte, aucune
> exposition.

### 3.1 Le tableau demandé — capital × win rate

**T1 : capital 50 / 100 / 500 € × WR (entrée 0,625 ; b = 0,60 ⇒ BE = 62,50 % ; n = 65)**

| capital | WR 55 % | WR 63,5 % | WR 65 % | WR 72 % | WR 75 % | WR = BE (edge 0) | plafond effectif |
|---|---|---|---|---|---|---|---|
| 50 | 0 € (skip) | 0.25 € (0.50 %) | 0.50 € (1.00 %) | 0.50 € (1.00 %) | 0.50 € (1.00 %) | 0 € (skip) | 0.50 |
| 100 | 0 € (skip) | 0.50 € (0.50 %) | 1.00 € (1.00 %) | 1.00 € (1.00 %) | 1.00 € (1.00 %) | 0 € (skip) | 1.00 |
| 500 | 0 € (skip) | 2.54 € (0.51 %) | 5.00 € (1.00 %) | 5.00 € (1.00 %) | 5.00 € (1.00 %) | 0 € (skip) | 5.00 |

**Lecture honnête** : dès que l'edge revendiqué dépasse ~1 %, **c'est le plafond de variance
qui détermine la mise, pas Kelly** — parce qu'on ne croit pas l'edge. Kelly sert à
**refuser de miser** (edge ≤ 0) et à fixer la mise quand l'edge est **faible** (WR 63,5 % →
0,50 € à capital 100, non plafonné). C'est le comportement correct : *on ne sur-dimensionne
pas une edge non prouvée.*

### 3.2 Détail par scénario (capital 100)

**T2 : détail (capital 100)**

```
WR 55.00 % -> p̂=56.76 % BE=62.50 % edge=-5.74 pt f*=n/a kelly_brut=0.00 € mise=0.00 € capped=false lien=aucune mise [SKIP]
WR 62.50 % -> p̂=62.50 % BE=62.50 % edge=0.00 pt f*=n/a kelly_brut=0.00 € mise=0.00 € capped=false lien=aucune mise [SKIP]
WR 63.00 % -> p̂=62.88 % BE=62.50 % edge=0.38 pt f*=0.0102 kelly_brut=0.25 € mise=0.25 € capped=false lien=Kelly fractionnaire
WR 63.50 % -> p̂=63.26 % BE=62.50 % edge=0.76 pt f*=0.0204 kelly_brut=0.51 € mise=0.50 € capped=false lien=Kelly fractionnaire
WR 65.00 % -> p̂=64.41 % BE=62.50 % edge=1.91 pt f*=0.0510 kelly_brut=1.27 € mise=1.00 € capped=true lien=borne de variance 1.00 % (edge nulle, RISK.md §5.1)
WR 72.00 % -> p̂=69.76 % BE=62.50 % edge=7.26 pt f*=0.1937 kelly_brut=4.84 € mise=1.00 € capped=true lien=borne de variance 1.00 % (edge nulle, RISK.md §5.1)
WR 75.00 % -> p̂=72.06 % BE=62.50 % edge=9.56 pt f*=0.2549 kelly_brut=6.37 € mise=1.00 € capped=true lien=borne de variance 1.00 % (edge nulle, RISK.md §5.1)
```

### 3.3 Confiance faible, carnet seul, n variable (capital 100)

**T3**

```
n=0, carnet 0,75               -> p̂=68.75 % edge=6.25 pt mise=1.00 € capped=true
n=0, carnet 0,70               -> p̂=66.25 % edge=3.75 pt mise=1.00 € capped=true
n=0, carnet = prix 0,625       -> p̂=62.50 % edge=0.00 pt mise=0.00 € capped=false [SKIP]
n=0, aucun signal              -> p̂=n/a edge=n/a mise=0.00 € capped=false [SKIP]
n=3, WR 100 % + carnet 0,70    -> p̂=66.25 % edge=3.75 pt mise=1.00 € capped=true
n=3, WR 100 %, pas de carnet   -> p̂=n/a edge=n/a mise=0.00 € capped=false [SKIP]
n=65, WR 72 %                  -> p̂=69.76 % edge=7.26 pt mise=1.00 € capped=true
n=200, WR 72 %                 -> p̂=71.14 % edge=8.64 pt mise=1.00 € capped=true
n=65, WR 0 % (tout perdant)    -> p̂=14.71 % edge=-47.79 pt mise=0.00 € capped=false [SKIP]
```

### 3.4 Modérateurs — drawdown et série de pertes

**T4 : edge FORT (WR 72 %) — le plafond masque les modérateurs**

```
rien                     -> kelly_brut=4.84 € mise=1.00 € capped=true lien=borne de variance 1.00 % (edge nulle, RISK.md §5.1)
DD 7 %                   -> kelly_brut=4.84 € mise=1.00 € capped=true lien=borne de variance 1.00 % (edge nulle, RISK.md §5.1)
DD 15 %                  -> kelly_brut=4.84 € mise=1.00 € capped=true lien=borne de variance 1.00 % (edge nulle, RISK.md §5.1)
DD 25 %                  -> kelly_brut=4.84 € mise=0.00 € capped=false lien=drawdown [SKIP]
4 pertes consécutives    -> kelly_brut=4.84 € mise=1.00 € capped=true lien=borne de variance 1.00 % (edge nulle, RISK.md §5.1)
8 pertes consécutives    -> kelly_brut=4.84 € mise=0.00 € capped=false lien=série de pertes [SKIP]
```

**T4b : edge FAIBLE (WR 63,5 %) — les modérateurs mordent réellement**

```
rien                     -> kelly_brut=0.51 € mise=0.50 € capped=false lien=Kelly fractionnaire
DD 7 %                   -> kelly_brut=0.51 € mise=0.38 € capped=false lien=Kelly fractionnaire
DD 15 %                  -> kelly_brut=0.51 € mise=0.25 € capped=false lien=Kelly fractionnaire
4 pertes consécutives    -> kelly_brut=0.51 € mise=0.25 € capped=false lien=Kelly fractionnaire
DD 15 % + 4 pertes       -> kelly_brut=0.51 € mise=0.20 € capped=false lien=mise plancher
```

> ⚠️ Note honnête : quand le plafond de variance mord (edge revendiqué ≥ ~1 %), les
> modérateurs de drawdown ne changent **rien** à la mise — elle était déjà au minimum autorisé
> par le cadrage. Ils ne redeviennent sensibles que pour une edge faible. C'est une
> conséquence directe du fait que le plafond est **bas** (1 %) : il n'y a plus de marge à
> réduire. Le STOP à 20 % de drawdown, lui, reste actif dans tous les cas.

### 3.5 Exposition simultanée — le cas des 5 coins (capital 100)

**T5**

```
0 position ouverte           -> mise=1.00 € plafond=1.00 € capped=true lien=borne de variance 1.00 % (edge nulle, RISK.md §5.1)
2 positions, 3 € exposés     -> mise=1.00 € plafond=1.00 € capped=true lien=borne de variance 1.00 % (edge nulle, RISK.md §5.1)
4 positions, 9 € exposés     -> mise=1.00 € plafond=1.00 € capped=true lien=borne de variance 1.00 % (edge nulle, RISK.md §5.1)
4 positions, 9,5 € exposés   -> mise=0.50 € plafond=0.50 € capped=true lien=exposition simultanée 10.00 % restante
5 positions (= max)          -> mise=0.00 € plafond=0.00 € capped=true lien=positions simultanées [SKIP]
10 € exposés (10 % atteint)  -> mise=0.00 € plafond=0.00 € capped=true lien=exposition simultanée [SKIP]
```

**Le point clé** : avec 5 coins ouvertes, 4 positions à 1 € + 1 nouvelle = 5 € cumulés =
5 % du capital, sous les 10 % — l'exposition n'est donc **pas** le facteur limitant à
capital 100 € avec un plafond de 1 % par trade (max théorique 5 × 1 % = 5 %). Le plafond
d'exposition protège le cas où la mise par trade serait plus élevée, ou le nombre de coins
plus grand.

### 3.6 Coins / prix différents (capital 100, WR 72 %, n = 65)

**T6**

```
entrée 0,58 — b obs 0,724    -> BE=58.00 % p̂=68.71 % edge=10.70 pt f*=0.2548 mise=1.00 € capped=true
entrée 0,625 — b obs 0,600   -> BE=62.50 % p̂=69.76 % edge=7.26 pt f*=0.1937 mise=1.00 € capped=true
entrée 0,70 — b obs 0,429    -> BE=69.98 % p̂=71.53 % edge=1.55 pt f*=0.0516 mise=1.00 € capped=true
entrée 0,70 — b théorique    -> BE=70.00 % p̂=71.53 % edge=1.53 pt f*=0.0510 mise=1.00 € capped=true
```

### 3.7 Mise fixe actuelle vs sizing adaptatif

**T7**

```
capital  50 € : 5 € fixe = 10.0 % du capital, 1 perte=200 % de la limite quotidienne || sizing = 0.50 € (1.00 %), 1 perte=20 % de la limite ; la mise fixe DÉPASSE la limite quotidienne en 1 perte
capital 100 € : 5 € fixe = 5.0 % du capital, 1 perte=100 % de la limite quotidienne || sizing = 1.00 € (1.00 %), 1 perte=20 % de la limite ; la mise fixe tient dans la limite
capital 500 € : 5 € fixe = 1.0 % du capital, 1 perte=20 % de la limite quotidienne || sizing = 5.00 € (1.00 %), 1 perte=20 % de la limite ; la mise fixe tient dans la limite
```

### 3.8 Où se situe l'optimum Kelly non plafonné (capital 100)

**T8**

```
WR 65.00 % -> f*=0.0510 = 1.27 % du capital en 1/4 Kelly, 5.10 % en Kelly plein ; retenu=1.00 €
WR 72.00 % -> f*=0.1937 = 4.84 % du capital en 1/4 Kelly, 19.37 % en Kelly plein ; retenu=1.00 €
WR 75.00 % -> f*=0.2549 = 6.37 % du capital en 1/4 Kelly, 25.49 % en Kelly plein ; retenu=1.00 €
WR 80.00 % -> f*=0.3569 = 8.92 % du capital en 1/4 Kelly, 35.69 % en Kelly plein ; retenu=1.00 €
```

**Pourquoi on ignore ces 4,84 à 8,92 %** : parce que le `f*` mesuré est calculé **sur les
mêmes données qui ont servi à calibrer la stratégie** (biais de sélection, RISK.md §7) et
que `t ≈ 1,5` ne permet pas de rejeter l'edge nulle. Sous edge nulle, Kelly veut 0 % — le
plafond de 1 % est la traduction opérationnelle de « on ne sait pas, donc on ne paie pas ».

---

## 4. Signature documentée

```ts
computeStake(input: StakeSizingInput): StakeSizingResult
```

**ENTRÉES** — obligatoires : `capital`, `entryPrice`. Tout autre champ absent ou `null` est
traité comme **information indisponible** (jamais « 0 par défaut »).

| Champ | Unité | Sens |
|---|---|---|
| `capital` | € | Capital disponible courant (> 0) |
| `entryPrice` | ]0,1[ | Prix d'entrée du côté acheté = probabilité implicite du marché |
| `bookProb` | [0,1] | Probabilité de gain estimée par le carnet (repli si n < 5) |
| `winRateRecent` | [0,1] | Win rate récent de la coin (trades RÉSOLUS) |
| `recentTrades` | ≥0 | Nombre de trades résolus supportant `winRateRecent` |
| `avgGainPerUnit` | >0 | Gain moyen observé par 1 € misé (trades gagnants) |
| `avgLossPerUnit` | >0 | Perte moyenne observée par 1 € misé (trades perdants) |
| `consecutiveLosses` | ≥0 | Pertes consécutives actuelles |
| `drawdownCurrent` | ≥0 | Drawdown depuis le pic, en fraction (0,12 = 12 %) |
| `openExposureEur` | ≥0 | € déjà engagés sur positions ouvertes |
| `openPositions` | ≥0 | Positions ouvertes |
| `maxConcurrentPositions` | ≥1 | Plafond de positions simultanées (défaut 5) |

**SORTIE**

| Champ | Sens |
|---|---|
| `stake` | **Mise recommandée en €, arrondie au centime INFÉRIEUR. `0` = ne pas trader.** |
| `rationale` | Justification lisible en français, chiffres inclus (p̂, λ, BE, edge, f*, plafond mordu) |
| `capped` | `true` si un plafond DUR a mordu, **ou** a refusé le trade |
| `skipped` | `true` si la recommandation est de ne pas trader |
| `effectiveProb` / `breakEvenProb` / `edgePp` | `p̂`, `BE`, `(p̂−BE)·100` (null si indéterminable) |
| `kellyFraction` / `rawKellyStake` | `f*` et la mise Kelly brute avant modérateurs/plafonds |
| `maxStakeAllowed` / `bindingConstraint` | Plafond effectif (le plus serré) et facteur qui a fixé la mise |

La fonction est **PURE** : aucune I/O, aucun `process.env`, aucune horloge, aucun effet de
bord ; mêmes entrées ⇒ mêmes sorties ; l'objet d'entrée n'est pas muté (test 22).

**Raccordement (à faire par le parent, PAS dans ce module)** : la mise fixe
`const stake = Number(process.env.BET_STAKE ?? '') || 1;` de `bot-with-dashboard.ts`
(≈ ligne 875) est remplacée par un appel à `computeStake({...})` alimenté par le capital
courant, `buyPrice`, la confiance du carnet, et les statistiques par coin déjà calculées par
`computeCoinLearning()` (WR, gain/perte moyens, n) plus `state.currentDrawdown`, les pertes
consécutives et l'exposition ouverte. **Si `stake === 0`, sauter le trade.**

---

## 5. Tests — sortie brute réelle

```
$ npx tsx --test tests/stake-sizing.test.ts
```

```
ok 1 - 1. prix hors de ]0,1[ → mise nulle, non contournable
ok 2 - 2. capital invalide (0, négatif, NaN) → mise nulle
ok 3 - 3. historique vide ET carnet indisponible → ne pas miser
ok 4 - 4. n<5 : le win rate empirique n'est PAS utilisé sans carnet
ok 5 - 5. n<5 mais carnet fourni → signal carnet seulement, mise prudente
ok 6 - 6. edge EXACTEMENT nul (WR = BE = prix) → mise nulle
ok 7 - 7. edge négatif (WR 55 % < BE 62,5 %) → mise nulle
ok 8 - 8. le shrinkage ne peut pas INVENTER un edge : entrée = carnet ⇒ p̂ ≈ entrée
ok 9 - 9. plafond dur : borne de variance 1 % du capital (capital 50 €)
ok 9b - 9b. la mise plafonnée reproduit la table de RISK.md §5.1 (1 % du capital)
ok 10 - 10. une SEULE perte ne peut pas consommer la limite quotidienne
ok 11 - 11. jamais plus de 2 % du capital par trade, quelle que soit la WR
ok 12 - 12. plafond absolu de sécurité : MAX_STAKE_EUR même avec un capital énorme
ok 13 - 13. exposition simultanée : budget restant = 10 % − exposition engagée
ok 14 - 14. exposition épuisée (10 % atteints) → refus par plafond dur
ok 15 - 15. 5 positions ouvertes simultanées → refus (5 coins max)
ok 16 - 16. drawdown ≥ 20 % → STOP (mise nulle)
ok 17 - 17. drawdown ≥ 10 % → mise exactement RÉDUITE DE MOITIÉ
ok 18 - 18. 8 pertes consécutives → STOP ; 4 pertes → moitié
ok 19 - 19. mise plancher : petite mise Kelly relevée au minimum (jamais au-dessus du plafond)
ok 20 - 20. capital minuscule : plancher > plafond → on ne trade PAS (pas de violation)
ok 21 - 21. la mise croît avec la WR (avant plafond) et reste au centime
ok 22 - 22. fonction PURE : entrée non mutée, résultat déterministe, odds théoriques
```

```
# tests 23
# pass 23
# fail 0
# skipped 0
# duration_ms ~280
```

---

## 6. Limites et mises en garde (honnêteté)

1. **Le sizing ne crée pas d'edge.** Aucun réglage de mise ne transformera une espérance
   nulle en espérance positive. Le module ne fait que **borner la perte**.
2. **L'edge n'est pas prouvé** (t ≈ 1,25–1,75 ≪ Bonferroni 2,81). Toutes les probabilités
   injectées sont des estimations bruitées ; c'est pourquoi elles sont systématiquement
   **shrinkées** et plafonnées.
3. **Le module ne remplace pas le kill-switch** : il faut toujours `edge_monitor.py`
   (MONITORING.md) et les pauses du cadre existant (quotidien 5 %, mensuel 15 %, drawdown
   25 %, perte totale 40 %).
4. **Trades supposés indépendants.** Plusieurs entrées de la même fenêtre 5 min partagent le
   même régime de marché ⇒ la variance réelle est **plus grande** que modélisée, donc les
   plafonds sont **optimistes** (à resserrer, jamais à desserrer).
5. **Le prix d'entrée n'est pas exactement la probabilité.** Frais, liquidité et
   bid/ask réduiraient l'edge net en réel ; en papier c'est acceptable.
6. **`f*` et le win rate récents sont sujets au biais de sélection** (la fenêtre et les
   filtres par coin ont été calibrés sur ces mêmes données) ⇒ le point estimé est
   vraisemblablement **surestimé**, ce qui plaide encore pour les plafonds.
7. **Les modérateurs de drawdown/série de pertes sont masqués** par le plafond de 1 % quand
   l'edge revendiqué est élevé (cf. §3.4) : c'est un effet du plafond bas, pas un défaut.

---

## 7. Reproduire

```bash
cd /root/clawd/Polymarket-bot
npx tsx --test tests/stake-sizing.test.ts      # 23 tests, sortie brute en §5
npx tsc --noEmit                               # typecheck du module (exit 0)
```

*Note : la mise par défaut du module est dérivée du cadre de risque existant, mais le
`.env` (`BET_STAKE=5`) reste en place tant que le raccordement n'est pas fait — ce module ne
modifie AUCUN fichier existant.*
