# MONITORING.md — Surveillance statistique HONNÊTE du paperbot Polymarket

**Bot** : `polymarket-paperbot` (papier, `DRY_RUN=true`, Up/Down 5m, BTC/ETH/SOL/XRP/DOGE).
**Outil** : `tools/edge_monitor.py` (Python 3 stdlib uniquement, LECTURE SEULE).
**Source de données** : `/root/.polymarket/history.json` (trades individuels) + croisement avec
`cumulative.json` et `pnl.json` (agrégats officiels).
**Date de la mesure ci-dessous** : **2026-09-26T23:26:13Z**.
**Sortie brute intégrale** : `docs/rebuild/monitoring/edge_monitor_output.txt` (fichier joint, non retouché).

> ⚠️ `history.json` est un **fichier vivant** écrit en continu par le bot. Les chiffres ci-dessous
> sont un instantané : relancer le script donne des valeurs légèrement différentes à chaque
> résolution. Rien ici n'est fabriqué — tout vient de l'exécution réelle.

---

## 🔴 VERDICT EN GROS, SANS FLATTERIE

```
        ██  AUCUN EDGE N'EST DÉMONTRÉ.  ██  c'est du BRUIT.

  Global : n=66, t = +1.747  →  |t| < 1.96  →  NON SIGNIFICATIF.
           IC95 du PnL total = [−1.23 €, +21.52 €]  →  CONTIENT ZÉRO.
           p-value bilatérale = 0.081 → 8 % de chance d'observer ça par pur hasard.

  Aucun coin significatif. Aucune tranche de prix significative.
  Le seul |t|>2 (BTC, t=+2.12) est ATTENDU sous l'hypothèse « aucun edge » quand on
  teste 10 sous-groupes : à |t|>2 on attend ~0.46 faux positif par tirage — il en apparaît 1.
```

**Ce que ce document ne dit PAS** : il ne dit pas que le bot perd. Il dit qu'**on ne peut pas
distinguer son résultat d'un tirage légèrement chanceux**. C'est exactement la définition de
« non prouvé » — et c'est le seul verdict honnête que les données autorisent.

**Ce qu'il ne faut PAS faire** : augmenter les mises, resserrer une fenêtre, couper un coin, ou
« optimiser » sur la base de ces chiffres. Toute décision dans ce sens serait de l'**optimisation
sur du bruit**, l'erreur précisément que cet outil existe pour empêcher.

---

## 1. Ce que fait l'outil

`edge_monitor.py` lit `history.json`, **exclut les trades en attente**, et produit :

| Section | Contenu | Question à laquelle elle répond |
|---|---|---|
| **(a)** | n, WR, PnL moyen/trade, sd, se, t, IC95 du total, n requis pour \|t\|>2 | « Y a-t-il un edge, et si non, combien de données manque-t-il ? » |
| **(b)** | **verdict explicite** + seuil de Bonferroni + probabilité de faux positif | « Est-ce significatif, ou est-ce du bruit ? » |
| **(c)** | WR break-even réelle `1/(1+b)`, `b = gain moyen / \|perte moyenne\|` | « Le bot est-il au-dessus de son seuil de rentabilité ? » |
| **(d)** | comptage des `realized == 0` (EN ATTENTE, exclus) | « Ne pas compter un trade non résolu comme gagné ou perdu. » |
| **(e)** | kill-switch chiffré + alerte de drawdown max + séries de pertes | « Quand faut-il s'arrêter ? » |
| **(f)** | découpage par coin et par tranche de prix d'entrée | « Un sous-groupe se détache-t-il ? (non) » |

**Unité de PnL** : par défaut, le PnL est **normalisé par `stake`** (donc « pour une mise de 1 € »)
afin de rendre tous les trades comparables — cohérent avec le modèle de `EDGE.md`/`RISK.md`.
Le mode `--raw-stake` utilise le `realized` brut (mises réelles).

### (d) Le cas `realized == 0`

Un trade à `realized == 0` est **EN ATTENTE** : ni gagné, ni perdu (le round 5 min n'est pas encore
résolu). Le script **ne le compte jamais** dans `n`, ni comme gain, ni comme perte, ni dans le PnL.
Sur l'instantané ci-dessous : **2 trades en attente** (`btc-updown-5m-1790464500`, `sol-updown-5m-1790464500`),
tous deux à mise 5 €.

---

## 2. Sortie RÉELLE du script (sortie brute, non retouchée)

Commande :

```bash
cd /root/clawd/Polymarket-bot
python3 tools/edge_monitor.py
```

Sortie intégrale :

```
==============================================================================
EDGE_MONITOR — surveillance statistique du paperbot Polymarket Up/Down 5m
==============================================================================
Généré : 2026-09-26T23:26:13Z
Source trades : /root/.polymarket/history.json
Échantillon : 66 trades RÉSOLUS | 2 EN ATTENTE (realized==0, exclus) | 68 entrées totales
Unité de PnL : pour une mise de 1 € (realized/stake)

(a) STATISTIQUES GLOBALES
  n (résolus)          : 66  (48 gains / 18 pertes)
  Win rate observé     : 72.7%
  PnL moyen / trade    : +0.1537
  Écart-type (sd)      : 0.7144
  Erreur-type (se)     : 0.0879
  t-statistique        : +1.747
  PnL total observé    : +10.1410
  IC95 du PnL TOTAL    : [-1.23 €, +21.52 €]
  IC95 du PnL/trade    : [-0.0187, +0.3260]
  n requis pour |t|>2.00 (variance mesurée) : 87
  n requis pour |t|>2.81 (Bonferroni)        : 171

(b) VERDICT
  Tests effectués (m)      : 10  (global + 5 coins + 4 tranches testés)
  Seuil standard (95%%)    : |t| > 1.96
  Seuil Bonferroni (m=10) : |t| > 2.807
  p-value bilatérale       : 0.0806
  P(faux positif, 1 test)  : 8.06%
  P(≥1 faux positif sur m) : 56.83%  (correction family-wise)
  Faux positifs attendus à |t|>2 sous H0 : 0.46 sur 10 tests

  >>> VERDICT : NON SIGNIFICATIF (BRUIT) <<<
  |t|=1.747 ≤ 1.96 ET ≤ Bonferroni 2.807 : l'hypothèse « edge = zéro » N'EST PAS rejetée. P(faux positif à ce |t|, 1 test) = 8.1%.

(c) WR BREAK-EVEN RÉELLE  (1/(1+b), b = gain moyen / |perte moyenne|)
  gain moyen (gagnants) : +0.5842
  perte moyenne (perdants) : 0.9944
  b = gain/perte        : 0.5875
  WR break-even         : 63.0%
  WR observé            : 72.7%
  Marge (WR - BE)       : +9.73 points
  Verdict break-even    : AU-DESSUS du seuil MAIS non significatif (cf. (b))

(e) KILL-SWITCH & DRAWDOWN
  Drawdown max (courbe PnL) : 4.87 € (= 4.87 mises)
  Drawdown courant          : 0.00 €
  Plus longue série de pertes : 3
  PnL cumulé final          : +10.14 €
  Seuils : kill t ≤ -2.00 | warn t ≤ -1.00 | DD kill ≥ 25.0€ | DD warn ≥ 15.0€
  Séries : kill ≥ 8 pertes consécutives | warn ≥ 6
  ÉTAT KILL-SWITCH : OK (aucun seuil franchi)
      - aucun seuil franchi.

(f) DÉCOUPAGE

  (f1) PAR COIN
coin           n      WR   BE_WR     mean€       sd      se       t    total€          IC95 total  verdict
BTC           32   78.1%   62.3%   +0.2503   0.6695  0.1183   +2.12   +8.0107     [+0.59, +15.43]  NON significatif (bruit)
DOGE           5   60.0%   64.7%   -0.0723   0.8523  0.3812   -0.19   -0.3613      [-4.10, +3.37]  NON significatif (bruit)
ETH            7   57.1%   62.9%   -0.0910   0.8553  0.3233   -0.28   -0.6369      [-5.07, +3.80]  NON significatif (bruit)
SOL           17   76.5%   63.0%   +0.2131   0.7017  0.1702   +1.25   +3.6226      [-2.05, +9.29]  NON significatif (bruit)
XRP            5   60.0%   66.6%   -0.0988   0.8290  0.3707   -0.27   -0.4941      [-4.13, +3.14]  NON significatif (bruit)

  (f2) PAR TRANCHE DE PRIX D'ENTRÉE
tranche        n      WR   BE_WR     mean€       sd      se       t    total€          IC95 total  verdict
0.55-0.60     18   77.8%   59.2%   +0.3082   0.7125  0.1679   +1.84   +5.5468     [-0.38, +11.47]  NON significatif (bruit)
0.60-0.65     31   67.7%   62.1%   +0.0907   0.7636  0.1372   +0.66   +2.8119     [-5.52, +11.15]  NON significatif (bruit)
0.65-0.70      9   66.7%   66.0%   +0.0102   0.7579  0.2526   +0.04   +0.0916      [-4.36, +4.55]  NON significatif (bruit)
0.70-0.75      7   85.7%   71.8%   +0.1939   0.5275  0.1994   +0.97   +1.3574      [-1.38, +4.09]  NON significatif (bruit)
0.75+          1  100.0%     n/a   +0.3333   0.0000  0.0000     n/a   +0.3333                 n/a  n<5 (non testé)

(g) PROVENANCE & MISES EN GARDE
  - history.json est un fichier VIVANT écrit par le bot : n et chiffres bougent à chaque résolution.
  - Les trades `realized == 0` sont EN ATTENTE et exclus (2 ici) : ni gagnés ni perdus.
  - PnL normalisé par `stake` (mise de 1 €) pour rendre les trades comparables (4 trades avec stake≠1 dans l'échantillon).
  - Le champ `realized` a historiquement porté un bug de résolution (documenté dans cumulative.json / EDGE.md), corrigé le 2026-09-25. Les trades antérieurs restent à interpréter avec prudence.
  - Tester 9 sous-groupes gonfle le risque de faux positif : c'est pourquoi le seuil Bonferroni (m=10 -> |t|>2.807) est exigé en plus de 1.96.
  - cumulative.json (agrégat officiel du bot) : pnl=13.1855, resolved=129, total_trades=129, wins=89, losses=40 — échantillon cumulé PLUS LARGE que history.json.
  - pnl.json : trades=129 wins=89 losses=40 wr=69.0 pnl=13.19 pending=2.
==============================================================================
```

---

## 3. Lecture ligne par ligne — ce que dit vraiment cette sortie

### (a) Statistiques globales — le point estimé est positif, l'incertitude est énorme

- **n = 66** trades résolus (48 gains / 18 pertes), **WR = 72.7 %**.
- **PnL moyen/trade = +0.1537 €** (mise 1 €), **sd = 0.7144**, **se = 0.0879**.
- **t = +1.747** → **|t| < 1.96 → NON significatif.**
- **IC95 du PnL total = [−1.23 €, +21.52 €]** → **il contient zéro.** Traduction : on ne peut pas
  exclure que la vraie espérance du bot soit nulle (voire légèrement négative).
- **n requis pour |t|>2** à la variance mesurée : **87 trades** (on en a 66 → il manque ~21).
  Pour franchir **le seuil Bonferroni 2.81** : **171 trades** requis (il manque ~105).

> Le point estimé (+0.15 €/trade, WR 72.7 %) est **encourageant**. Mais « encourageant » n'est pas
> « démontré ». À n=66, un tirage à WR réelle nulle produit couramment ce genre de point estimé.

### (b) Verdict — pourquoi le seuil de Bonferroni, et pourquoi « bruit »

Le script **compte réellement** le nombre de tests effectués (global + sous-groupes avec assez
de données) : ici **m = 10** (1 global + 5 coins + 4 tranches). Le seuil corrigé est alors :

```
|t|_Bonferroni = Φ⁻¹(1 − 0.05/(2·10)) ≈ 2.807
```

Le verdict « SIGNIFICATIF » n'est prononcé que si **|t| dépasse À LA FOIS 1.96 ET 2.807**.
Ici `|t| = 1.747` → **double échec** → **« NON SIGNIFICATIF (BRUIT) »**.

**Probabilité de faux positif** :
- par test : **p = 0.081** → 8.1 % ;
- **corrigée family-wise (m=10) : 56.8 %** → sur 10 tests, on a plus d'une chance sur deux de
  voir *au moins un* faux positif de cette taille par pur hasard.
- **Faux positifs attendus à |t|>2 sous H0** : `10 × 2·(1−Φ(2)) = 0.46`. **On en observe 1 (BTC).**
  C'est **exactement** ce qu'un système sans edge produit → le t=2.12 de BTC **n'est pas une preuve**.

### (c) Break-even — le bot est au-dessus *en apparence*, mais l'écart n'est pas prouvé

- Gain moyen des gagnants : **+0.5842 €** ; perte moyenne des perdants : **0.9944 €**.
  (La perte n'est pas exactement −1 € car **17 trades sur 66 ont été clôturés en TP/SL** — leur
  `realized` est le prix de sortie réel, pas le −1 € théorique du hold-to-expiry.)
- `b = 0.5842 / 0.9944 = 0.5875` → **WR break-even = 1/(1+b) = 63.0 %**.
- **WR observé 72.7 % vs BE 63.0 % → marge de +9.7 points.**
- **MAIS** (et c'est le point) : cette marge **n'est pas statistiquement établie** (cf. (b)).
  Être « au-dessus du break-even » sur l'échantillon **ne prouve rien** tant que l'IC95 du PnL
  contient zéro. L'outil affiche volontairement : « AU-DESSUS du seuil **MAIS non significatif** ».

### (e) Kill-switch & drawdown — les garde-fous chiffrés

Sur cet instantané : **drawdown max = 4.87 mises**, **série de pertes max = 3**, **état : OK**.
Aucun seuil franchi — ce qui est normal : un bot vivant depuis peu avec WR 72.7 % n'a pas encore
subi de drawdown profond. **L'absence de drawdown n'est pas une preuve de solidité** (cf. RISK.md :
sous edge nulle, le DD Q95 d'une longue série est ~51 mises).

**Seuils par défaut (chiffrés et justifiés)** :

| Garde-fou | Seuil « alerte » | Seuil « KILL-SWITCH (arrêt) » | Justification |
|---|---|---|---|
| **t-statistique global** | `t ≤ −1.00` | **`t ≤ −2.00`** | `t ≤ −2` = edge **négative significative** → le bot perd de façon prouvée, il faut arrêter. `t ≤ −1` = zone de vigilance. |
| **Drawdown max de la courbe PnL** | `≥ 15 mises` | **`≥ 25 mises`** | RISK.md : sous edge nulle, DD Q95 ≈ **51 mises** ; 25 mises = moitié de ce seuil = arrêt précoce justifié sans edge prouvée. |
| **Pertes consécutives** | `≥ 6` | **`≥ 8`** | RISK.md : la plus longue série sous edge nulle est de 9–13 ; **8** est un signal précoce. |
| PnL total cumulé (§ RISK.md) | — | session < −15 mises | Cf. RISK.md §5.2 (non recalculé ici, faute de granularité de session). |

Tous les seuils sont **paramétrables** (`--kill-t`, `--warn-t`, `--dd-kill`, `--dd-warn`,
`--consec-loss-kill`, `--consec-loss-warn`).

**Interprétation d'un déclenchement** : sous edge nulle, 42 % des longues sessions finissent
négatives et des séries de 9–13 pertes arrivent (RISK.md). Un drawdown ou une série longue **n'est
pas** la preuve que la stratégie est cassée — c'est du bruit attendu. Le kill-switch existe pour
**borner le risque d'une edge non prouvée**, pas pour « optimiser ».

### (f) Découpage — rien ne se détache

- **Par coin** : BTC a le meilleur point estimé (**t=+2.12**), **mais** il est **sous** le seuil
  Bonferroni (2.807) et c'est **le seul faux positif attendu** sous H0 (cf. (b)). **NON significatif.**
  ETH (t=−0.28), DOGE (t=−0.19), XRP (t=−0.27) sont **légèrement négatifs mais indiscernables de zéro**.
  SOL (t=+1.25) positif non significatif. **Aucun coin n'est tranchable.**
- **Par tranche de prix** : 0.55–0.60 (t=+1.84) et 0.70–0.75 (t=+0.97) ont le meilleur point estimé,
  0.65–0.70 est **rigoureusement à break-even** (mean +0.0102 €, t=+0.04). **Aucune tranche
  significative.** Le 0.75+ (n=1) est **non testé** (n<5).

---

## 4. Utilisation en cron

Le script est conçu pour un lancement non interactif. Il **ne modifie rien**, sort en code 0
par défaut, et accepte `--json` pour un consommateur machine.

```bash
# Rapport humain (log)
*/30 * * * * cd /root/clawd/Polymarket-bot && python3 tools/edge_monitor.py >> docs/rebuild/monitoring/cron.log 2>&1

# Rapport machine + code de sortie 2 si kill-switch déclenché (utile pour alerting)
*/30 * * * * cd /root/clawd/Polymarket-bot && python3 tools/edge_monitor.py --json --exit-on-kill > /dev/null || echo "KILL-SWITCH edge_monitor" | wall
```

**Codes de sortie** :
- `0` : exécution normale (kill-switch non déclenché, ou non demandé) ;
- `1` : `history.json` introuvable/illisible ;
- `2` : kill-switch déclenché **et** `--exit-on-kill` passé.

**Options principales** : `--json`, `--raw-stake`, `--min-n`, `--alpha`, `--target-t`,
`--kill-t`, `--warn-t`, `--dd-warn`, `--dd-kill`, `--consec-loss-warn`, `--consec-loss-kill`,
`--exit-on-kill`, `--history`, `--cumulative`, `--pnl`.

> **Ne pas** relancer `pm2 restart` ni toucher au bot depuis ce monitoring : l'outil est
> strictement en **lecture seule** sur `/root/.polymarket/`.

---

## 5. Limites et mises en garde (honnêteté)

1. **`history.json` est vivant** : n et chiffres bougent à chaque résolution (le fichier a 68
   entrées aujourd'hui). Un instantané n'est vrai qu'à l'instant où il est pris.
2. **Écart avec les agrégats officiels** : `cumulative.json`/`pnl.json` comptent **129 trades**
   cumulés (pnl=13.19 €, WR=69.0 %), alors que `history.json` n'en contient que **68 (66 résolus)**.
   `history.json` est l'historique **courant** ; l'agrégat cumule aussi les archives. Les deux
   doivent être lus ensemble, pas confondus.
3. **Le champ `realized` a eu un bug historique** de résolution (tous les YES perdants / NO gagnants,
   documenté dans `cumulative.json` et `EDGE.md`), **corrigé le 2026-09-25**. L'instantané actuel
   ne montre plus le bug (YES : 29 gains / 9 pertes). Les trades antérieurs restent à interpréter
   avec prudence — l'audit indépendant d'`EDGE.md` avait dû re-résoudre 167 trades pour cette raison.
4. **`EDGE.md` a mesuré 167 trades (t=1.25) via re-résolution indépendante** ; ce monitoring mesure
   **66 trades (t=1.747)** depuis `history.json`. Les deux sont honnêtes et **convergent vers la
   même conclusion** : **non significatif**. Le t plus élevé ici reflète un échantillon plus récent
   (régime post-correctif), pas un edge prouvé.
5. **17/66 trades (26 %) ont un `realized` de sortie anticipée (TP/SL)**, pas le −1 € théorique :
   le PnL mesuré est le **as-executed réel**, pas un modèle hold-to-expiry. C'est le chiffre le
   plus honnête disponible, mais il mélange deux mécaniques.
6. **Multiple-comparaisons** : chaque découpage teste de nouveaux sous-groupes et gonfle le risque
   de faux positif. C'est pourquoi le seuil de Bonferroni est exigé. **Ne jamais** lire un
   sous-groupe (ex. BTC t=2.12) sans le comparer à ce seuil.
7. **Trades non indépendants** : plusieurs entrées d'une même fenêtre 5 min partagent le même
   régime de marché → la variance réelle est probablement **plus grande** que mesurée, donc les
   seuils ci-dessus sont **optimistes** (à resserrer, jamais à desserrer).
8. **Biais de sélection probable** : la fenêtre d'entrée et les filtres par coin ont été calibrés
   sur ces mêmes données → le point estimé est vraisemblablement surestimé.

---

## 6. Reproduire

```bash
cd /root/clawd/Polymarket-bot
python3 tools/edge_monitor.py                 # rapport humain
python3 tools/edge_monitor.py --json          # rapport machine
python3 tools/edge_monitor.py --raw-stake     # PnL brut (mises réelles) au lieu de /stake
```

*Note : en `--raw-stake` (mises réelles, 2 trades récents à 5 €), le t monte à **+2.123** —
au-dessus de 1.96 **mais toujours sous Bonferroni 2.807 → toujours NON significatif.***
*Toujours pas une preuve.*
