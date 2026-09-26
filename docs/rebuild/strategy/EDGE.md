# EDGE.md — Edge réel mesuré du paperbot « Up or Down 5m »

**Date de mesure :** 2026-09-26T22:55Z
**Bot mesuré :** `polymarket-paperbot` (PM2, `tsx`, paper 1 €/mise, IA désactivée)
**Script :** `measure_edge.py` (+ `extra_checks.py`), sorties brutes dans `edge_output.txt` / `extra_output.txt`

---

## Résumé exécutif — à lire d'abord

| Question | Réponse mesurée | Verdict |
|---|---|---|
| Le bot a-t-il un edge global prouvé ? | n=167, PnL/trade **+0.0696 €**, **t = +1.25**, IC95 du total **[-6.59 €, +29.84 €]** | **NON.** L'IC95 contient 0. |
| Une tranche de prix est-elle significative ? | Aucune. Max \|t\| = 1.00 (tranche 0.75+, n=8) | **NON.** Zéro tranche prouvée. |
| Un coin est-il significatif ? | BTC : t = +2.15 (n=51) — le seul au-delà de 2 | **NON PROUVÉ** (multiple-comparaisons, cf. §3) |
| Combien de trades pour trancher ? | **≈427 trades** requis pour \|t\|>2 au bruit mesuré (actuel 167) | Il manque ~2,5× la donnée. |

**La phrase honnête : aucun edge n'est démontré, ni globalement, ni par coin, ni par tranche de prix.** Tous les points positifs sont dans le bruit. Le seul signal compatible avec un vrai edge (coin BTC) est exactement ce qu'un tirage aléatoire produit quand on teste 10 sous-groupes.

---

## Provenance des données et pourquoi ce n'est PAS du `realized` brut

Le champ `realized` de `history.json` est **corrompu historiquement**. L'audit embarqué dans
`cumulative.json` (2026-09-25T21:31:54) documente le bug :

> `gamma-api.polymarket.com/markets?condition_id=<cid>` ignore le filtre → `data[0]` = marché
> `xi-jinping-out-before-2027` ; tous les YES enregistrés perdants, tous les NO gagnants.

De plus, `cumulative.json` stocke 63 des 126 issues sous forme de booléen `true` : la valeur
numérique du PnL y est **perdue**.

Conséquence : ce rapport **re-résout chaque round indépendamment** à partir de la source
officielle `https://gamma-api.polymarket.com/events?slug=<coin>-updown-5m-<slot>`, avec
`slot = int(ts//300)*300`, et **vérifie systématiquement que le slug retourné == le slug demandé**
(aucun mismatch observé). Les décisions `HOLD` sont exclues (aucune information de PnL).

Le ledger de trades est l'**union** de 3 sources, dédupliquée par `roundId` :

```
==============================================================================
SOURCES DU LEDGER DE TRADES
==============================================================================
  /root/.polymarket/history.json
      -> 65 entrées, 65 nouveaux trades YES/NO
  /root/.polymarket/archive/2026-09-18/history.json
      -> 300 entrées, 101 nouveaux trades YES/NO
  /root/.polymarket/archive/2026-09-25/history.json
      -> 300 entrées, 2 nouveaux trades YES/NO
  TOTAL trades YES/NO uniques (par roundId) : 168

==============================================================================
RÉSOLUTION (re-résolution indépendante via Gamma events?slug=)
==============================================================================
  resolved             : 167
  unresolved           : 1
  TRADES RÉSOLUS RETENUS : 167
  Validation croisée vs realized enregistré (non nul) : 167 comparables, 165 concordants, 2 discordants
```

**Modèle de PnL (mise 1 €) :** gain si le côté acheté gagne = `(1-p)/p` ; perte = `-1`.
(Identité utile : `b = gain_moyen/|perte_moyenne| = (1-p)/p`, donc `WR_break-even = 1/(1+b) = p`
— le **seuil de rentabilité d'une tranche est exactement son prix d'entrée**.)

> Note : ces 167 trades couvrent **deux régimes** (avant/après le correctif du 25/09 — cf. §3).
> Les chiffres du contexte initial (WR ~72 %, t=1.44) correspondaient au **sous-échantillon « après
> correctif »** (n≈61). Élargir aux 167 trades disponibles *abaisse* le t à 1.25 : c'est le signe
> que le point estimé élevé récent n'est pas encore stabilisé.

---

## (a) Edge par coin

```
(a) EDGE PAR COIN  (mise 1€, re-résolution indépendante)
coin      n      WR   BE_WR    mean€      sd      se       t   total€
BTC      51   76.5%   63.5%  +0.2051  0.6814  0.0954   +2.15 +10.4611
ETH      29   69.0%   64.5%  +0.0685  0.7385  0.1371   +0.50  +1.9865
SOL      38   63.2%   65.1%  -0.0301  0.7584  0.1230   -0.24  -1.1447
XRP      24   75.0%   67.7%  +0.1077  0.6611  0.1349   +0.80  +2.5845
DOGE     25   60.0%   66.0%  -0.0905  0.7641  0.1528   -0.59  -2.2613
```

Lecture : `mean€` = PnL moyen par trade, `sd` = écart-type, `se` = erreur-type (`sd/√n`),
`t = mean/se`. Seul **BTC** dépasse \|t\|>2. **SOL et DOGE** ont un point estimé négatif
(WR sous leur seuil d'équilibre) mais \|t\| < 1 → bruit.

---

## (b) Edge par tranche de prix d'entrée

```
(b) EDGE PAR TRANCHE DE PRIX D'ENTRÉE
tranche       n      WR  BE_WR=1/(1+b)      b    mean€      sd       t   total€             IC95 total
<0.55         0   (aucun trade)
0.55-0.60    32   62.5%          58.3%  0.714  +0.0712  0.8431   +0.48  +2.2782   [  -7.07, +11.63]
0.60-0.65    55   67.3%          62.0%  0.612  +0.0847  0.7643   +0.82  +4.6606   [  -6.45, +15.77]
0.65-0.70    39   66.7%          66.3%  0.509  +0.0063  0.7212   +0.05  +0.2452   [  -8.58,  +9.07]
0.70-0.75    33   78.8%          72.0%  0.389  +0.0942  0.5772   +0.94  +3.1087   [  -3.39,  +9.61]
0.75+         8   87.5%          75.0%  0.333  +0.1667  0.4714   +1.00  +1.3333   [  -1.28,  +3.95]
```

**Aucune tranche n'est significative.** Tous les IC95 du PnL total traversent 0.
Point important : la tranche **0.65–0.70 est exactement à break-even** (WR 66.7 % vs seuil 66.3 %,
mean +0.006 €, t=+0.05) — c'est la bande **sans edge** de l'échantillon.

Couverture (n par coin × tranche) — ce qui explique pourquoi rien n'est tranchable :

```
(b2) n PAR COIN × TRANCHE
coin        <0.55  0.55-0.60  0.60-0.65  0.65-0.70  0.70-0.75      0.75+
BTC             0         11         24         10          6          0
ETH             0         10          5          6          8          0
SOL             0          6         13          9          7          3
XRP             0          3          6          8          4          3
DOGE            0          2          7          6          8          2
```

---

## (c) Puissance statistique

```
(c) PUISSANCE STATISTIQUE
  Global : n=167  mean=+0.0696€  sd=0.7190€  se=0.0556€  t=+1.251
  IC95 du PnL TOTAL observé : [-6.59€, +29.84€]  (total point = +11.63€)
  WR break-even global (b=0.540) = 64.9%  | WR observé = 69.5%
  n requis pour |t|>2 aux mu/sigma mesurés : 427 (actuel 167)  -> PAS ENCORE ATTEINT

  Détail par coin (t et n requis) :
    BTC   n= 51 t= +2.15 n_requis=     44  SIGNIFICATIF
    ETH   n= 29 t= +0.50 n_requis=    465  non significatif
    SOL   n= 38 t= -0.24 n_requis=   2535  non significatif
    XRP   n= 24 t= +0.80 n_requis=    151  non significatif
    DOGE  n= 25 t= -0.59 n_requis=    285  non significatif

  Détail par tranche (t et n requis) :
    0.55-0.60  n= 32 t= +0.48 n_requis=    561  non significatif
    0.60-0.65  n= 55 t= +0.82 n_requis=    325  non significatif
    0.65-0.70  n= 39 t= +0.05 n_requis=  52616  non significatif
    0.70-0.75  n= 33 t= +0.94 n_requis=    150  non significatif
    0.75+      n=  8 t= +1.00 n_requis=     32  non significatif
```

`n_requis = (2·σ/μ)²` : nombre de trades nécessaire pour que le point estimé atteigne \|t\|=2
*si μ et σ restent ceux mesurés*. Globalement il faut **≈427 trades** (on en a 167).
Attention : `n_requis = 52616` pour la tranche 0.65–0.70 reflète un μ ≈ 0 — c'est mathématiquement
« il faudrait une infinité de trades pour prouver un edge qui n'existe probablement pas ».

---

## Contrôles complémentaires (extra_checks.py)

```
1. VALIDATION CROISÉE (re-résolution vs realized enregistré)
  DISCORDANT eth-updown-5m-1789743600 ETH NO p=0.63 bot=-0.8984 hold-to-expiry_win=True soldTp=True sl=True
  DISCORDANT xrp-updown-5m-1789748700 XRP NO p=0.75 bot=-0.9733 hold-to-expiry_win=True soldTp=True sl=True
  167 comparables | 165 concordants | 2 discordants (1.2%)

2. SPLIT DE RÉGIME TEMPOREL (correctif de résolution 2026-09-25T21:31)
  AVANT correctif  n=106 WR= 67.9% mean=+0.0233€ sd=0.7136 t=+0.34 total=+2.468€
  APRÈS correctif  n= 61 WR= 72.1% mean=+0.1501€ sd=0.7272 t=+1.61 total=+9.158€

3. MULTIPLE-COMPARAISONS (faux positifs attendus à |t|>2)
  5 coins                  : P(>=1 faux positif à |t|>2) = 20.8%
  5 tranches               : P(>=1 faux positif à |t|>2) = 20.8%
  5 coins + 5 tranches     : P(>=1 faux positif à |t|>2) = 37.2%

4. COHÉRENCE AVEC pnl.json (chiffre revendiqué par le bot)
  pnl.json : trades=127 wins=87 losses=40 win_rate=68.5% pnl=6.79€ pending=0
  hold-to-expiry recalculé : n=167 pnl_total=+11.626€ t=+1.25
  as-executed recalculé    : n=167 pnl_total=+8.194€
  Écart pnl.json(total) vs hold-to-expiry : -4.836€
```

**Interprétation :**

1. **La re-résolution est fiable** : 165/167 (98.8 %) de concordance avec le `realized` du bot.
   Les 2 discordants sont deux **stop-loss** (le bot a coupé en perte un round qui aurait fini
   gagnant) — un effet de stratégie, pas une erreur de mesure.
2. **Split de régime** : avant le correctif, l'edge est **~nul** (+0.023 €/trade, t=+0.34).
   Après le correctif, +0.150 €/trade mais **t=+1.61, toujours < 2**. Le régime récent est
   *encourageant*, pas *démontré*.
3. **Multiple-comparaisons** : tester 5 coins + 5 tranches = 10 tests → **37 % de chance de
   trouver au moins un \|t\|>2 par pur hasard**. Le t=2.15 de BTC est **entièrement attendu**
   sous l'hypothèse « aucun edge ». Ce n'est PAS une preuve.
4. **Cohérence comptable** : le PnL revendiqué par `pnl.json` (≈6.8 €) est de même ordre que le
   PnL « as-executed » recalculé (+8.19 €). L'écart avec le hold-to-expiry (+11.63 €) vient des
   **sorties anticipées TP/SL** (67 trades sur 167 ont `soldTp=true`).

---

## (d) Recommandation de paramètres

```
(d) RECOMMANDATION (dérivée des mesures ci-dessus)
tranche       n      WR    BE=p  edge(pp)       t  verdict
0.55-0.60    32   62.5%   58.5%     +4.0   +0.48  indice positif (NON significatif)
0.60-0.65    55   67.3%   61.9%     +5.4   +0.82  indice positif (NON significatif)
0.65-0.70    39   66.7%   66.4%     +0.3   +0.05  neutre / break-even
0.70-0.75    33   78.8%   71.9%     +6.9   +0.94  indice positif (NON significatif)
0.75+         8   87.5%   75.0%    +12.5   +1.00  indice positif (NON significatif)

coin      n      WR    BE=p  edge(pp)       t  verdict
BTC      51   76.5%   63.2%    +13.2   +2.15  PROUVÉ positif (MAIS multiple-comparaisons)
ETH      29   69.0%   64.6%     +4.4   +0.50  indice positif (NON significatif)
SOL      38   63.2%   65.2%     -2.0   -0.24  neutre / break-even
XRP      24   75.0%   66.8%     +8.2   +0.80  indice positif (NON significatif)
DOGE     25   60.0%   66.4%     -6.4   -0.59  indice négatif (NON significatif)

  Fenêtres candidates (hold-to-expiry) :
    [0.58,0.70)                n=126 WR= 65.9% BE= 62.4% edge= +3.4pp t=+0.83 total= +7.184
    [0.70,0.75)                n= 33 WR= 78.8% BE= 71.9% edge= +6.9pp t=+0.94 total= +3.109
    [0.75,1.01)                n=  8 WR= 87.5% BE= 75.0% edge=+12.5pp t=+1.00 total= +1.333
    [0.60,0.75)                n=127 WR= 70.1% BE= 65.9% edge= +4.2pp t=+1.01 total= +8.015
    [0.58,1.01) drop[0.65,0.70) n=128 WR= 70.3% BE= 64.4% edge= +5.9pp t=+1.40 total=+11.381
```

### Ce qui est PROUVÉ vs ce qui est du BRUIT

**PROUVÉ (statistiquement, \|t\|>2, robuste) :**
- **Rien.** Aucun coin, aucune tranche, aucun agrégat ne franchit un seuil corrigé pour les
  multiple-comparaisons (seuil de Bonferroni pour 10 tests ≈ \|t\|>2.81).

**FORTEMENT SUGGÉRÉ par le point estimé (mais NON prouvé) :**
- Le prix d'entrée le plus élevé (0.70+) porte le meilleur edge point estimé
  (WR 78.8 % pour un seuil d'équilibre de 71.9 %) — mais n=33 et t=0.94.
- La bande **0.65–0.70 n'a aucun edge** (edge +0.3 pp, t=+0.05, n=39). C'est le seul endroit où
  le point estimé dit clairement « pas d'avantage ».
- BTC est le seul coin à point estimé fort (+13.2 pp) ; SOL (−2.0 pp) et DOGE (−6.4 pp) sont
  négatifs.

**BRUIT PUR (à ne surtout pas optimiser dessus) :**
- Le t=+2.15 de BTC : 37 % de chance d'apparaître par hasard.
- Les \|t\|>25 fantômes (BTC/XRP dans 0.70+) sur n=6/7 : variance explosive, purement décoratif.
- Les n_requis astronomiques (SOL 2535, tranche 0.65–0.70 → 52616) : μ≈0 ou négatif.

### Recommandation de paramètres (défendable, pas optimiste)

| Paramètre | Valeur recommandée | Justification |
|---|---|---|
| **Fenêtre d'entrée [MIN, MAX]** | **[0.58, 0.75)** — conserver, ne PAS resserrer agressivement | edge point estimé positif sur 0.55–0.65 (+4 à +5 pp) et 0.70–0.75 (+6.9 pp) ; aucune preuve qu'une sous-fenêtre est meilleure |
| **Bande 0.65–0.70** | **Surveiller** (seule bande à edge ≈ 0) ; ne pas la couper sur la foi de t=+0.05 | edge +0.3 pp, n=39 : tirer une conclusion serait du bruit-chasing |
| **Coins à GARDER** | BTC, ETH, XRP (point estimé positif) | +13.2 pp / +4.4 pp / +8.2 pp, mais seuls BTC dépasse \|t\|=2 → **à confirmer** |
| **Coins à COUPER (candidats)** | **SOL, DOGE** (point estimé négatif) | −2.0 pp et −6.4 pp ; \|t\| < 1 → **pas prouvé**, mais ce sont les seuls candidats rationnels à la réduction |
| **Taille de mise** | ne PAS augmenter (Kelly plafonné à 0.05 est correct) | n=167 < n_requis=427 : l'incertitude sur μ est encore énorme |
| **Critère de re-décision** | réévaluer à **n ≥ 427 trades résolus** (ou après un cycle BTC≥XRP≥ETH confirmé) | au bruit actuel, c'est le minimum pour \|t\|>2 |

**La recommandation honnête et défendable est conservatrice : garder la fenêtre [0.58, 0.75],
ne rien couper sur la base de cette mesure, mais SUSPENDRE toute augmentation de mise et
re-mesurer sous 200 trades supplémentaires.** Couper SOL/DOGE ou élargir vers 0.70+ maintenant
serait optimiser sur du bruit — exactement l'erreur que ce rapport cherche à éviter.

### Limites explicites de cette mesure

- **n = 167 < 427 requis** → toutes les conclusions par sous-groupe sont sous-alimentées.
- **Fusion de deux régimes** (avant/après correctif de résolution) : le régime « avant » a un edge
  ~nul. Si la stratégie a réellement changé, l'agrégat mélange deux populations.
- **Modèle hold-to-expiry** : 67/167 trades (40 %) ont en réalité été clôturés en TP/SL avant
  l'expiration ; le PnL as-executed (+8.19 €) diffère du PnL hold-to-expiry (+11.63 €).
- **Resolution source Polymarket/Chainlink** : hypothèse que le round résout bien Up/Down ; validée
  à 98.8 % contre le bot, mais le bot lui-même a déjà eu un bug de résolution.
