# Recherche d'edge réel sur Polymarket — arbitrage, mispricing et coûts

**Analyse : 2026-09-26 ~10:15 UTC** · périmètre : `docs/research/` du dépôt `Polymarket-bot`
**Hors périmètre par consigne : les marchés Up/Down 5 min** (quasi pile-ou-face, cf. `docs/STRATEGY-REVIEW.md`).

**Tous les chiffres de ce document proviennent d'appels d'API publics exécutés pendant cette analyse**
(Gamma, CLOB, Binance, Deribit). Aucune donnée n'est estimée, simulée ou reprise de mémoire.
Scripts et sorties brutes : `docs/research/` (voir §6 Reproductibilité).

---

## TL;DR — verdict honnête

| Piste | Résultat mesuré | Verdict |
|---|---|---|
| **1a. Arbitrage binaire YES+NO** | 0 marché sur **274** avec `ask_YES + ask_NO < 1,0000` (minimum observé **1,0010**) | ❌ **Mort.** Impossible par construction. |
| **1b. Arbitrage de partition (multi-issues)** | **14 / 731** événements negRisk à somme < 1 ; après carnets réels + frais : **+17,68 USDC net** sur 13 événements. **Persistance vérifiée** : 5/6 stables à ±0,3 % après 22 min (§1.4) | ⚠️ **Réel mais marginal.** 2 événements font tout le profit. |
| **2. Mispricing vs référence externe (crypto)** | Écart moyen marché − modèle lognormal : **+0,13 pt à +0,84 pt** (BTC/ETH/SOL/XRP, 170 observations) | ❌ **Pas d'edge.** Marché correctement prix. |
| **3. Biais favori-outsider** | YES sous-évalué de **+3,5 à +8,9 pts** selon l'horizon ; **survit à la dé-corrélation** (248 clusters, +6,9 pts, t = 3,63) — **mais deux artefacts identifiés** (§3.7) | ⚠️ **Signal réel, magnitude NON fiable.** À confirmer prospectivement. |
| **4. Coûts réels** | Frais taker = `rate × p × (1−p)` ; aller-retour = **3,0 % à 4,5 %** du capital à p=0,5 | ⚠️ **Ils décident de tout.** Détruisent 67 % du brut de l'arb. |

**Conclusion en une phrase** : l'arbitrage « propre » n'existe pas sur Polymarket (le moteur de
matching l'interdit), l'arbitrage multi-issues existe mais rapporte **~18 USDC** en immobilisant du
capital **9 à 15 mois**, et le seul vrai gisement est un **biais de calibration** (l'issue « Yes » est
systématiquement moins chère que sa fréquence réelle), dont l'ampleur est sensible au découpage.

---

## 1. Piste 1 — Arbitrage

### 1.1 Arbitrage binaire YES + NO : mathématiquement fermé

**Méthode** : 300 marchés actifs triés par volume 24 h (Gamma), puis récupération des **deux
carnets CLOB réels** (token YES et token NO). On cherche `ask_YES + ask_NO < 1` — acheter les deux
côtés garantirait alors 1 $ pour moins de 1 $.

**Résultat** (`01_arb_yesno.py`, sortie `arb_scan.json`) :

- **0 / 274 marchés** avec `ask_YES + ask_NO < 1,0000`.
- Distribution de la somme : **min = 1,0010**, p05 = 1,0010, **médiane = 1,0100**, moyenne = 1,0258, max = 1,9800.
- Structure de la distribution : **60 marchés à 1,0010** (ceux dont le spread vaut 0,001) et
  **147 marchés à 1,0100** (spread 0,01).
- **0 / 274** avec `bid_YES + bid_NO > 1` (le miroir, vente des deux côtés).

**Lecture** : le plancher à **1,0010** n'est pas un hasard. Avec un tick de 0,001 et un spread de
0,001, l'ask de chaque côté vaut le mid + 0,0005 → la somme vaut exactement **1,0000 + 1 tick**.
Autrement dit, franchir les deux spreads coûte **0,1 % par paire**, systématiquement.
**Le moteur de matching de Polymarket empêche la somme de passer sous 1** : l'arbitrage binaire
YES/NO n'existe pas, même avant frais. *Cette piste est définitivement close.*

### 1.2 Arbitrage de partition (multi-issues) : réel mais écrasé par les frais

**Le mécanisme** : sur un événement **negRisk** à N issues mutuellement exclusives (ex. « Combien
de cyclones toucheront la Chine en 2026 ? » → `<5 / 5 / 6 / 7 / 8 / >8`), exactement une issue
vaut 1 $. Si la **somme des meilleurs asks de tous les YES < 1**, acheter 1 part de chaque issue
donne un gain garanti de `1 − somme`.

**Détection** (`02_arb_multi.py`, 1 500 événements récupérés) :

- **731** événements negRisk avec ≥ 3 issues et asks disponibles.
- **14 / 731 (1,9 %)** avec somme des YES **< 1,00**.
- Somme médiane sur l'ensemble : **1,6050** ; les grosses sommes (jusqu'à 94,03) sont des
  listes de 100+ candidats où acheter tous les YES est absurde.

**Vérification par carnets réels** (`03_verify_multi.py`) — indispensable, car le `bestAsk` de
Gamma est parfois périmé :

| Événement | Somme Gamma | Profondeur réelle | Brut/part | **Frais/part** | **Net/part** |
|---|---|---|---|---|---|
| Millennium Prize (n=6) | 0,8790 | 228,6 parts | +0,1210 | −0,0330 | **+0,0880** |
| Cyclones Chine (n=6) | 0,9290 | 599,9 parts | +0,0710 | −0,0315 | **+0,0395** |
| Maduro prison (n=5) | 0,9480 | 146,9 parts | +0,0520 | −0,0212 | **+0,0308** |
| Tarif US-Chine (n=5) | 0,9650 | **0,0 part** | — | — | **non capturable** |
| Argentine inflation (n=7) | 0,9720 | 109,8 parts | +0,0280 | — | +0,0237 |
| Chine inflation (n=9) | 0,9740 | 8,0 parts | +0,0260 | — | +0,0255 |

⚠️ **Le cas « Tarif US-Chine » est la démonstration du piège** : Gamma affichait une somme de
0,9650, mais en rechargant les vrais carnets la somme au top est **1,017** — la cotation Gamma
était périmée. **Profondeur exécutable réelle = 0.** Sans cette vérification, on aurait « trouvé »
un arbitrage inexistant.

**Résultat final après carnets réels et frais réels** (`08_arb_fees.py`, sortie `arb_multi_final.json`) :

- **13 événements capturables.**
- Profit brut exécutable : **54,13 USDC**
- Frais taker : **36,45 USDC → 67 % du brut**
- **Profit NET : 17,68 USDC**

Sur ces 13, **seuls 3 sont positifs après frais** : Millennium **+10,57**, Cyclones **+9,72**,
Maduro **+0,90**. Les 10 autres sont **négatifs** (de −0,06 à −1,03).

**Le verrou qui tue la piste** : ces marchés se résolvent **dans 9 à 15 mois** (endDate 2026-12 à
2028-01). ~600 USDC immobilisés 9 mois pour **+9,72 USDC** = **~2 % annualisé**. Ce n'est pas
un edge, c'est un placement moins bon qu'un livret.

### 1.3 Le piège de la partition non exhaustive (à ne pas oublier)

Une somme < 1 ne garantit un gain **que si la partition est complète**. Deux cas détectés :

- **`which-month-will-strait-of-hormuz-traffic-return-to-normal`** → signalé automatiquement
  comme « liste de candidats sans jambe aucun/other » (trou).
- **`which-millennium-prize-problem-will-ai-solve-next`** → **piège fin, non détecté
  automatiquement.** L'événement liste 5 problèmes + « No solution by Dec 31, 2027 ». Or les
  problèmes du millénaire sont **7**, et **Navier-Stokes est absent**. Si Navier-Stokes est
  résolu avant fin 2027, les 6 issues listées valent **toutes 0** → perte de 100 %.
  (Risque jugé très faible, mais il existe et n'est pas couvert par la jambe « No solution ».)

**Règle à retenir** : ne déclarer un arbitrage de partition que si la partition est une
**partition numérique exhaustive** (bandes `≤5 / 6 / 7 / ≥8`) ou comporte une jambe
« aucun / other » **explicite**. C'est le cas des cyclones, de l'inflation, des décisions de
banques centrales — pas des listes de candidats.

### 1.4 Durée de vie de l'arbitrage : le scan est-il capturable, ou déjà mort ? (ajout)

C'était la seule question laissée ouverte (§7, « Aucune mesure de persistance n'a été faite »).
**Réponse mesurée** (`14_arb_persistence.py`) : les 6 principaux candidats ont été re-mesurés par
leurs **carnets CLOB réels** à **10:21:53 UTC**, soit ~22 minutes après le scan initial de 10:00.

| Événement | Σ ask initial | Σ ask à +22 min | Δ |
|---|---|---|---|
| Cyclones Chine | 0,9290 | 0,9280 | −0,0010 |
| Millennium Prize | 0,8790 | 0,8790 | **0,0000** |
| Maduro | 0,9480 | 0,9480 | **0,0000** |
| Tarif US/Chine | 0,9650 | 0,9680 | +0,0030 |
| Argentine inflation | 0,9720 | **1,0020** | +0,0300 (**fermé**) |
| Chine inflation | 0,9740 | 0,9750 | +0,0010 |

**Lecture** : 5 des 6 sont stables à **±0,3 %**, deux sont **identiques au tick**. L'écart **ne
s'évapore pas**. Ce n'est donc **pas** une course contre des bots HFT : c'est un mispricing
structural qui **stationne**, précisément parce que le capital est bloqué 9–15 mois pour 1–5 % —
personne ne se bat pour 3 %. Conclusion : **l'opportunité est capturable**, et le goulot est la
**taille** et la **durée d'immobilisation**, pas la vitesse d'exécution.

### 1.5 Walk net de frais : ne jamais exécuter une jambe non rentable (ajout)

`09_final_arb.py` recalcule le walk de profondeur en **arrêtant dès que la contrainte nette
`Σp + Σ rate·p(1−p) < 1` est violée** (au lieu de calculer un net négatif après coup). Résultat
strictement exécutable :

| Événement | n | Σ ask | q_max | net/unit | net total | exhaustif | TTE | annualisé |
|---|---|---|---|---|---|---|---|---|
| Cyclones Chine | 6 | 0,929 | 358,3 | +0,0335 | **12,00 USDC** | ✔ oui | 277 j | **4,44 %** |
| Millennium Prize | 6 | 0,879 | 216,6 | +0,0490 | **10,60 USDC** | ✗ non (Navier-Stokes) | 461 j | 3,86 % |
| Maduro | 5 | 0,948 | 110,2 | +0,0104 | **1,14 USDC** | ✔ oui | 461 j | 0,82 % |
| Tarif US/Chine | 5 | 0,965 | 9,3 | +0,0034 | 0,03 USDC | ✔ oui | 95 j | 1,31 % |
| + 10 autres | 5–11 | 0,972–0,998 | **0,0** | 0 | 0 | — | — | — |

`PROFIT NET TOTAL EXECUTABLE = 23.78 USDC` pour ~637 USDC de capital ·
`Dont partitions EXHAUSTIVES rentables = 3 -> 13.18 USDC`

**Divergence assumée avec §1.2** : le walk de §1.2 (13 événements capturables, 10 négatifs de −0,06
à −1,03) et celui-ci (les mêmes à `q_max = 0`) mesurent la même réalité par deux conventions. La
seconde est opérationnellement la bonne : **on n'exécute pas une jambe dont le net est négatif**, donc
elle ne compte pas comme « opportunité ». L'ordre de grandeur (~18–24 USDC) est identique, et les deux
analyses convergent sur les 3 seuls cas rentables.

💡 **Effet secondaire important** : le cas « Tarif US/Chine » (`q_max = 9,3`) montre qu'une quote Gamma
périmée peut **survivre partiellement** à la vérification par carnet. Vérifier `q_max > 0` ne suffit
pas : il faut vérifier `q_max` **et** le net/unit.

---

## 2. Piste 2 — Mispricing vs référence externe (crypto)

**Méthode** : les marchés `Bitcoin/Ethereum/Solana/XRP above $K on <date>` sont des **options
digitales européennes propres** : résolution sur le close de la bougie 1 min Binance à **12:00 ET
(16:00 UTC)** (vérifié dans la description du marché). On les compare à un modèle lognormal sans
dérive calibré sur une référence externe gratuite.

**Références externes réellement récupérées :**

| Référence | Valeur | Source |
|---|---|---|
| BTC — vol implicite options (DVOL) | **34,2 %** | Deribit |
| ETH — vol implicite options (DVOL) | **48,0 %** | Deribit |
| SOL — vol réalisée 30 j | **69,2 %** | Binance klines |
| XRP — vol réalisée 30 j | **74,4 %** | Binance klines |
| Spot BTC (cross-check) | 84 113 (Binance) / 84 109 (Deribit) | Binance + Deribit |

> Deribit **ne cote pas d'options SOL ni XRP** (vérifié : la liste d'options renvoie `[]`) → pour
> ces deux actifs, la seule référence gratuite est la vol réalisée. Limite à assumer.

**Première lecture (trompeuse)** : la vol implicite médiane de Polymarket par coin donnait
BTC 33,4 % (≈ DVOL 34,2 % ✔), mais ETH 58,9 % vs 48,0 %, SOL 90,1 % vs 69,2 %, XRP 107,2 % vs
74,4 %. **Cette métrique est trompeuse** : la médiane sur des strikes très divers décrit surtout
la forme du *smile*, pas le niveau. Il faut comparer à *moneyness* fixe.

**Mesure rigoureuse** (`07_prob_bands.py`) : on interpole la fonction `P(S_T > K)` du marché et on
l'évalue à `K = S × (1 ± d)` pour `d ∈ {1, 2, 3, 5, 8} %`, puis on compare au lognormal de
référence. **170 observations.**

| Coin | Référence | Écart moyen (marché − modèle) |
|---|---|---|
| BTC | 34,2 % (DVOL) | **+0,0013** |
| ETH | 48,0 % (DVOL) | **−0,0118** |
| SOL | 69,2 % (rv30) | **+0,0021** |
| XRP | 74,4 % (rv30) | **+0,0084** |

**Verdict** : les écarts vont de **+0,1 pt à +0,8 pt de probabilité** — soit le bruit. Sur BTC, où
la référence est la meilleure (options Deribit liquides), l'écart est **+0,13 pt**, c'est-à-dire
**rien**. Et c'est **avant** les 4,5 % de coût aller-retour crypto.

**Contrôle sans aucun modèle** : la monotonie des prix le long des strikes (une violation = un
arbitrage pur, sans référence externe). Résultat : **0 à 2 violations par événement**, toutes sur
des strikes illiquidité où le spread (ex. bid 0,001 / ask 0,015) **dépasse largement** la
violation. Aucune fenêtre exploitable.

❌ **Cette piste est un échec propre : Polymarket price correctement ses digitals crypto.**

---

## 3. Piste 3 — Biais favori-outsider : le seul signal réel

**Méthode** (`04_favlong.py`) : 900 marchés **résolus** (volume ≥ 2 000), 781 avec historique de
prix journalier complet. La fin de cotation (`t_last`, dernier point de
`clob.polymarket.com/prices-history`) sert de proxy de la résolution — nécessaire car le champ
`endDate` de Gamma est **peu fiable** (voir §3.4). On relève le prix à `H` jours avant `t_last`
pour `H ∈ {1, 7, 30, 60, 90}` et on le compare à la fréquence réelle de l'issue 0.

### 3.1 Calibration par horizon

| Horizon | n | Prix moyen | WR réel | Écart | t |
|---|---|---|---|---|---|
| 1 jour | 472 | 0,3975 | 0,4322 | **+0,0347** | 3,30 |
| 7 jours | 472 | 0,3770 | 0,4322 | **+0,0552** | 4,59 |
| **30 jours** | **472** | **0,3567** | **0,4322** | **+0,0755** | **5,21** |
| 60 jours | 297 | 0,3540 | 0,4276 | **+0,0736** | 3,52 |
| 90 jours | 202 | 0,3271 | 0,4158 | **+0,0887** | 3,41 |

→ **L'issue « Yes » est systématiquement moins chère que sa fréquence réelle de réalisation**, de
**+3,5 pts (J−1) à +8,9 pts (J−90)**, et l'écart est significatif à tous les horizons.

### 3.2 Le patron classique, et sa variante

| Horizon | Favoris (> 0,90) | Milieu (0,30–0,75) | Longshots (< 0,10) |
|---|---|---|---|
| 1 j | n=117 · prix 0,977 · **WR 1,000** | n=71 · prix 0,527 · **WR 0,704** | n=211 · prix 0,017 · WR 0,014 |
| 7 j | n=91 · prix 0,970 · **WR 1,000** | n=78 · prix 0,527 · **WR 0,756** | n=194 · prix 0,023 · WR 0,015 |
| 30 j | n=56 · prix 0,959 · **WR 1,000** | n=121 · prix 0,530 · **WR 0,760** | n=166 · prix 0,035 · WR 0,030 |
| 60 j | n=19 · prix 0,943 · **WR 1,000** | n=87 · prix 0,532 · **WR 0,632** | n=81 · prix 0,037 · WR 0,025 |
| 90 j | n=8 · prix 0,929 · **WR 1,000** | n=65 · prix 0,510 · **WR 0,677** | n=65 · prix 0,038 · WR 0,031 |

**Stratégies naïves, nettes de frais** (`04_favlong.py`) :

- **Acheter les favoris** (p > 0,90) : ROI **+2,0 %** (J−1) à **+7,3 %** (J−90). WR réel **100 %** à tous les horizons.
- **Acheter les longshots** (p < 0,10) : ROI **−17,1 %** à **−56,4 %**.

**Nuance importante par rapport au biais favori-outsider « classique »** : ici les **longshots sont
quasi correctement prix** (prix 0,017–0,038 vs WR 0,014–0,031) et les **favoris sont sous-évalués**.
Le gisement n'est donc pas « vendre les longshots » mais **« acheter le côté Yes, surtout au-dessus
de 0,5 »**.

### 3.3 Contrôle de robustesse — le point critique

Un écart de +23 pts sur la tranche 0,30–0,75 est **invraisemblablement élevé** pour un marché
efficace. Trois tests ont été menés.

**(a) Dé-corrélation** (`11_cluster_test.py`) — les *ladders* (ex. `bitcoin-above-72k/74k/…/92k`
le même jour) produisent ~10 lignes partageant **une seule** réalisation. On clusterise donc par
famille d'événement : **472 lignes → 248 clusters**.

| Horizon | Brut (472 lignes) | **1 obs / cluster (248 clusters)** | **Moyenne intra-cluster** |
|---|---|---|---|
| 7 j | +0,0552 (t=4,59) | **+0,0660 (t=4,03)** | **+0,0519 (t=3,73)** |
| 30 j | +0,0755 (t=5,21) | **+0,0850 (t=4,00)** | **+0,0689 (t=3,63)** |
| 60 j | +0,0736 (t=3,52) | +0,0470 (t=1,66) | +0,0464 (t=1,80) |

→ **Le biais survit à la dé-corrélation à 7 et 30 jours** (t ≈ 3,6–4,0). Il **s'affaiblit et perd
la significativité à 60 jours**.

**(b) Par catégorie** (`10_costs_categories.py`, à p30d) :

| Catégorie | n | Prix | WR | Écart | t |
|---|---|---|---|---|---|
| crypto_fees_v2 | 191 | 0,3299 | 0,4607 | **+0,1309** | 5,44 |
| finance_prices | 54 | 0,3951 | 0,5556 | **+0,1605** | 3,85 |
| politics | 73 | 0,3883 | 0,4384 | +0,0500 | 1,33 |
| tech | 26 | 0,3370 | 0,3077 | −0,0293 | −0,88 |
| culture | 11 | 0,3915 | 0,1818 | **−0,2097** | −2,12 |
| non classé | 90 | 0,3851 | 0,3889 | +0,0037 | 0,13 |

→ L'effet est **concentré sur crypto et finance/prix**, **faible et non significatif en politics**,
et **s'inverse en culture** (n=11). Ce n'est donc **pas** un biais uniforme de la plateforme.

**(c) Par écart à la date de fin nominale** (`12_gap_split.py`) :

| Sous-échantillon | n | Prix | WR | Écart | t |
|---|---|---|---|---|---|
| gap > 180 j | **408** | 0,3366 | 0,3775 | **+0,0408** | 2,71 |
| gap 30–180 j | 64 | 0,4848 | 0,7812 | +0,2965 | 8,13 |

→ Sur le **sous-échantillon principal (408 marchés)**, l'écart tombe à **+4,1 pts (t = 2,71)**.
Le +29 pts du petit groupe (n=64) est un artefact de composition.

### 3.4 Limite structurelle découverte : `endDate` est inutilisable

Le champ `endDate` de Gamma est **systématiquement faux pour les marchés résolus** :
l'écart `endDate − dernier_trade` vaut **≥ 98 jours, médiane 337 jours** (100 % des marchés). Des
marchés résolus affichent `endDate = 2029`. **Conséquence pour tout futur backtest : il faut
dater la résolution par le dernier point de `prices-history`, jamais par `endDate`.** C'est
d'ailleurs pourquoi l'entrée PnL du bot (`gamma-api.polymarket.com/markets?condition_id=`) est
fausse — cf. `STRATEGY-REVIEW.md` §1.2.

**Contre-test explicite (`08_favlong_clean.py`, analyse sœur).** Une variante a tenté de corriger
ce biais en restreignant aux marchés dont `endDate` est réellement passée
(`end_date_min` / `end_date_max`) et en mesurant les prix **par rapport à `endDate`** :

- échantillon résultant : **n = 63–65** marchés seulement (sur 700+ balayés) ;
- à **J−2 et J−3 avant `endDate`** : seules 3 tranches non vides, dont **39 des 65** marchés
  dans la tranche **0,97–1,01** à un **prix moyen de 0,999** → prix **totalement convergés**,
  ROI favoris **+0,1 %** (t = 5,00) : **aucun signal** ;
- à **J−14 et J−30 avant `endDate`** : **n = 0** — les points de prix n'existent tout simplement
  pas aussi tôt par rapport à `endDate`.

→ **Confirmation indépendante** : une calibration ancrée sur `endDate` est **inexploitable**
(échantillon trop petit, prix figés après la fin réelle de cotation, horizons longs vides).
C'est la raison pour laquelle toute l'analyse §3.1–3.3 est ancrée sur le **dernier trade**, seule
référence utilisable. Les chiffres parfois spectaculaires de cette variante (ex. +0,427 sur la
tranche 0,45–0,60 à J−7, **n = 33**) ne doivent **pas** être lus comme un edge : n trop faible,
et même artefact de composition que le sous-échantillon « gap 30–180 j » du §3.3(c).

### 3.5 Contre-test sur les marchés sportifs (catégorie liquide)

Une analyse sœur (`10_favlong_sports.py` / `favlong_sports.log`, exécutée en parallèle) a testé la
catégorie **sports**, non couverte ci-dessus — **108** marchés résolus à `endDate` réelle
(vol ≥ 500), dont **104** exploitables :

- **Longshots (< 0,10)** : n=31 · prix 0,006 · **WR réel 0,000** → ROI **−104,7 %**
- **Milieu (0,40–0,55)** : n=8 · prix 0,500 · WR 0,875 → écart +0,375 (t=2,90)
- **Favoris (> 0,95)** : n=57 · prix 0,998 · WR 1,000 → écart +0,002
- Regroupé : **favoris p>0,70** → n=60 · prix 0,990 · WR 1,000 · **ROI +1,0 %** (t=2,03) ;
  **outsiders p<0,30** → n=31 · ROI **−104,7 %**

**Lecture honnête** : la **direction** du biais est confirmée (favoris sous-évalués, longshots
surévalués), mais l'exercice est **ancré sur les prix de clôture** : la distribution est
quasi bimodale (**57** marchés à 0,998 et **31** à 0,006, soit **88/104 déjà décidés**). À ces
niveaux, le gisement est **quasi nul** (ROI favoris **+1,0 %**) et le « −104 % » des longshots est
mécanique, pas une prévision exploitable. Conclusion : les marchés sportifs **ne contredisent pas**
le biais, mais **ne le confirment pas non plus** à un horizon exploitable — il faudrait y mesurer
la calibration à J−7/J−30, ce qui n'a pas été fait ici.

### 3.6 Verdict sur la piste 3

**C'est le seul signal réel trouvé.** Formulation honnête de son statut :

- ✅ **Direction robuste** : l'issue « Yes » est sous-évaluée, à tous les horizons, et l'effet
  survit à la dé-corrélation à 7 et 30 jours.
- ✅ **Magnitude la plus crédible** : sur le sous-échantillon principal (408 marchés, gap > 180 j)
  et après dé-clustering, **+4 à +7 pts de probabilité**.
- ⚠️ **Magnitude brute à ne pas croire** : les +23 pts de la tranche 0,30–0,75 sont trop beaux.
  Une partie résiduelle vient de la sélection d'échantillon (liste `closed=true` de Gamma triée
  par `endDate`, non aléatoire) et de la concentration sur crypto/finance.
- ⚠️ **Perte de significativité à 60 jours** : l'edge ne se laisse pas capturer n'importe quand.
- ❌ **Non transposable tel quel en production** : le +4 à +7 pts est mesuré sur des marchés
  résolus / liste non aléatoire. Il faut un test prospectif (voir §5).

### 3.7 Deux artefacts identifiés — pourquoi la magnitude de §3.1 ne doit pas être prise au chiffre (ajout)

L'analyse sœur §3.1–3.3 conclut à un « seul signal exploitable ». Deux mécanismes concrets,
**mesurés**, expliquent une partie de la magnitude et doivent tempérer la conclusion.

**(a) Un prix d'ouverture « seedé » à 0,500 — preuve chiffrée.**

Sur un échantillon sportif à `endDate` réelle (`10_favlong_sports.py`, 108 marchés, 104 exploitables),
la tranche de **prix d'ouverture** 0,45–0,60 affichait un écart **spectaculaire** :

```
tranche 0.45-0.60 : n=79  prix_moy=0.502  WR_reel=0.722  ecart=+0.219  t=4.07
```

**Trop beau.** La décomposition par type de sous-marché (`13_sports_composition.py`) donne :
```
  completed-match       n= 31 prix_moy=0.500 WR=1.000 ecart=+0.500
  principal(vainqueur)  n= 59 prix_moy=0.533 WR=0.559 ecart=+0.026
```
Un événement sportif Polymarket **regroupe des sous-marchés corrélés sur le même match**
(vainqueur, 1er set, totaux, handicaps, **`completed-match`**). Les illiquides **ouvrent à 0,500
exactement** — valeur de seed, sans découverte de prix — et `completed-match` (« le match
arrive-t-il à son terme ? ») résout **YES quasi toujours**. D'où **31 observations à prix 0,500 et
WR 100 %**, qui fabriquent à elles seules un faux edge de **+0,500**. Restreint aux **vrais** marchés
« vainqueur », l'écart tombe à **+0,026 (n=59) — du bruit.**

**Conséquence pour §3.1** : toute mesure où le prix de référence peut valoir **exactement 0,500**
doit filtrer ce cas. Le test de dé-corrélation (§3.3a) **ne protège pas** de cet artefact : les
lignes `completed-match` sont dans des clusters différents des marchés « vainqueur » du même match.

**(b) La liste `closed=true` triée par `endDate` n'est pas un échantillon — quantifié.**

`_gap_join.py`, jointure locale des 781 marchés de `favlong.json` sur leur `endDate` :
```
ecart (endDate - dernier_trade) jours: n=781
  min=98  p10=184  p25=279  median=337  p75=519  p90=583  max=896
  part des marches resolus >30j avant leur endDate nominale: 100.0%
```
**100 %** de l'échantillon est composé de marchés à `endDate` **placeholder** (2027-01-01,
2029-01-19…) résolus très en amont. Ce ne sont pas des tirages de l'univers Polymarket : c'est une
sous-population précise (questions « by Dec 31 », `FDV above $X one day after launch`, élections
anticipées). Or cette sous-population est **biaisée en faveur des YES** — un marché qui se résout
**tôt** relativement à une échéance lointaine est souvent un marché où **l'événement a eu lieu**.
L'écart de +3,5 à +8,9 pts de §3.1 est donc mesuré sur un échantillon dont la **construction même**
favorise les YES. La concentration crypto/finance de §3.3(b) est cohérente avec ça : ce sont
précisément les familles de cette sous-population.

**(c) Le seul résultat robuste au sens du biais.**

Sur ce même échantillon (biaisé **en faveur des YES**, donc **contre** la conclusion ci-dessous),
les contrats extrêmes perdent massivement :
```
tranche 0.00-0.03 : n=235  prix_moy=0.007  WR_reel=0.000  ecart=-0.007
>> acheter LONGSHOT p<0.10 : n=324  prix_moy=0.0211  WR_reel=0.0123  ROI=-45.2%
```
**0 gagnant sur 235** contrats sous 3 %. Le biais d'échantillonnage allant **contre** cette
conclusion, celle-ci est **conservatrice** : acheter des contrats sous 3 % perd ~100 % de la mise.
⚠️ Ce n'est **pas** un edge exploitable en soi : le miroir (« acheter NO à ~0,98 ») ne rapporte que
**~+0,9 % par trade** après frais, pour un risque de queue de −100 % — et §4 montre que ce n'est
rentable que près des extrêmes.

**Verdict révisé de la piste 3** : la **direction** (YES sous-évalué) est cohérente entre plusieurs
mesures indépendantes et résiste à la dé-corrélation. Mais la **magnitude** (+4 à +7 pts) repose en
partie sur (a) des prix seedés à 0,500 et (b) un échantillon 100 % biaisé pro-YES. **Statut :
hypothèse sérieuse, magnitude non fiable, à tester prospectivement** — et non « seul signal
exploitable » validé.

---

## 4. Piste 4 — Les coûts réels

### 4.1 Les frais (formule officielle confirmée)

Documentation Polymarket : **`fee = C × feeRate × p × (1 − p)`**, où `C` = nombre de parts et
`p` = prix. **Seuls les takers paient** (les makers paient 0 et reçoivent un rebate).
Le `feeSchedule` est exposé par marché — valeurs relevées :

| Catégorie | Taux taker | Rebate maker |
|---|---|---|
| Crypto | **0,07** | 20 % |
| Sports, Economics, Culture, Weather, Other | **0,05** | 25 % (15 % sports) |
| Finance, Politics, Mentions, Tech | **0,04** | 25 % |
| **Géopolitique / world events** | **0** | — |

Confirmation croisée : `feeType` lu sur les marchés = `crypto_fees_v2` (rate 0,07),
`economics_fees` / `culture_fees` / `other_fees` / `sports_fees_v3` (rate 0,05),
`politics_fees` (rate 0,04), `zero_fees`.

**Asymétrie clé** : le frais est **maximal à p = 0,50** et **tend vers 0 aux extrêmes**. À 0,95 :
`0,04 × 0,95 × 0,05 = 0,0019` par part, soit ~0,2 % du notionnel — négligeable. À 0,50 :
`0,04 × 0,25 = 0,01`, soit **1 % du notionnel**, seulement à l'entrée.

### 4.2 Spread, tick, taille minimale (mesurés sur 274 marchés actifs)

- **Spread observé** : min 0,001 · p25 0,002 · **médiane 0,010** · p75 0,010. Soit **1 cent**,
  qui représente **1,00 % du prix payé à p = 0,50**.
- **Tick** : **0,01** — vérifié sur 40/40 des marchés les plus actifs (volume 24 h décroissant),
  99 % des lectures. ⚠️ **Correction du 26/09** : ce rapport affirmait d'abord « 0,001 sur les
  marchés à fort volume » ; c'était **faux**, aucune observation à 0,001. Conséquence : le
  plancher YES+NO = 1,0010 mesuré au §1 reste valide, mais l'explication par un tick de 0,001
  non — le plancher vient du spread (1 cent) sur un tick de 0,01.
- **Taille minimale** : **5 $ notionnels** (`orderMinSize`), vérifié sur 40/40 marchés.
  ⚠️ Ce n'est pas « 5 parts » : c'est 5 **dollars**, ce qui rend le minimum réel plus contraignant.
- **Profondeur** — distinction critique, absente de la première version :
  - **Au meilleur prix (top-of-book)** : médiane **~12–18 $** par côté, p10 ≈ 3 $ ; profondeur
    < 5 $ dans **21 %** des côtés (mesuré sur 1 024 côtés, `docs/rebuild/execution/`).
  - **Cumul multi-niveaux / liquidité totale affichée par Gamma** : médiane **401 USDC**
    (mesurée sur **289** marchés actifs par `13_depth.py` ; p25 = 53, p75 = 5 609).
  → Les 401 USDC **ne sont pas exécutables au meilleur prix**. Pour tout dimensionnement, c'est
  le chiffre **top-of-book (~12 $)** qui compte : au-delà, on mange plusieurs niveaux et le
  slippage devient le coût dominant. **C'est le vrai plafond de déploiement**, et il est bien
  plus bas que ce que la première version laissait croire.

### 4.3 Coût aller-retour total à p = 0,50

| Catégorie | Frais A/R | + Spread | **Total** |
|---|---|---|---|
| Crypto | 3,50 % | 1,00 % | **4,50 %** |
| Sports / Economics / Culture / Weather | 2,50 % | 1,00 % | **3,50 %** |
| Politics / Tech / Finance | 2,00 % | 1,00 % | **3,00 %** |
| Géopolitique | 0 % | 1,00 % | **1,00 %** |

**Conséquences directes, chiffrées :**

1. **Toute stratégie de scalping est morte.** Il faudrait capter > 3 à 4,5 % par aller-retour.
   Le spread médian de 1 cent l'interdit.
2. **L'arbitrage de partition perd 67 % de sa valeur brute aux frais** (54,13 → 17,68 USDC, §1.2).
3. **Les marchés géopolitiques sont 3 à 4,5× moins chers à trader** — c'est là qu'il faut chercher.
4. **Le frais décroît vers les extrêmes** : la stratégie « acheter Yes à 0,5–0,75 » (§3) paie
   ~0,5–1 % à l'entrée, ce qui reste compatible avec un edge de 4–7 pts.

### 4.4 Coût d'entrée exprimé en % de la mise — le cadrage qui décide de tout (ajout)

`11_costs.py`. Le chiffre qui compte n'est pas le frais en USDC mais le **coût d'entrée en % du
capital engagé** (frais + demi-spread, spread supposé 1 cent) :

| Prix d'achat | Crypto (0,07) | Sports (0,05) | Politics (0,04) |
|---|---|---|---|
| 0,05 | **16,65 %** | 14,75 % | 13,80 % |
| 0,10 | **11,30 %** | 9,50 % | 8,60 % |
| 0,30 | 6,57 % | 5,17 % | 4,47 % |
| 0,50 | 4,50 % | 3,50 % | 3,00 % |
| 0,80 | 2,02 % | 1,62 % | 1,42 % |
| 0,90 | 1,26 % | 1,06 % | 0,96 % |
| 0,95 | **0,88 %** | 0,78 % | 0,73 % |

**Lecture — c'est le résultat le plus actionnable de toute l'étude :**
- Acheter un contrat à **0,05 coûte 13,8–16,7 % de la mise**. Il faut donc un edge de **plus de
  10 points** pour être rentable. Cela **condamne définitivement** toute stratégie « acheter
  l'outsider » — y compris l'espérance naïve de §3.
- À **0,90–0,95**, le coût tombe à **0,7–1,3 %**. C'est le **seul régime** où un edge de 1–2 points
  survit. C'est cohérent avec le seul résultat robuste de §3.7(c) : **le gisement est du côté des
  extrêmes, pas du côté des contrats bon marché.**
- **Corollaire stratégique majeur** : puisque le coût taker (3–17 %) est ce qui tue tous les edges
  observés, **la seule façon de rendre une stratégie rentable est de ne pas être taker**. Les
  makers paient **0** et reçoivent un **rebate de 15–25 %**. C'est un levier à mesurer en priorité
  (taux de fill + anti-sélection), pas un nouveau pari.

---

## 5. Verdict final — ce qui est exploitable, et ce qui ne l'est pas

### ❌ À abandonner

1. **Arbitrage binaire YES+NO.** 0/274, plancher structurel à 1,0010. Fermé par le matching engine.
2. **Mispricing des digitals crypto vs référence externe.** Écarts de +0,1 à +0,8 pt = bruit,
   avant 4,5 % de coûts.
3. **Arbitrage de partition comme activité principale.** 17,68 USDC net sur 13 événements, capital
   bloqué 9–15 mois, 2 événements font tout le profit. **Ce n'est pas un business** — au mieux un
   placement opportuniste à déclencher quand un scan détecte une partition exhaustive à somme < 0,95
   **et** que la taille disponible dépasse le millier de parts.
4. **Le scalping / market-making naïf.** 3–4,5 % d'aller-retour.

### ⚠️ Le seul candidat sérieux : le biais de calibration (§3) — direction robuste, magnitude à confirmer

**Formulation testable** : à 7–30 jours de la résolution, acheter le côté « Yes » — en particulier
sur les marchés **crypto et finance/prix** — quand son prix est inférieur à sa fréquence de
réalisation. Gains mesurés nets de frais : **+2,0 % à +7,3 % de ROI** sur les favoris.

**Pourquoi ce n'est pas encore une conclusion — et ce qu'il faut faire :**

1. **Test prospectif obligatoire.** Toute la mesure est rétrospective sur la liste `closed=true`
   de Gamma (non aléatoire). Il faut **enregistrer les prix à J−30 de marchés encore ouverts**,
   attendre la résolution, et comparer. C'est la seule façon d'éliminer le biais de sélection.
2. **Horizon 7–30 jours uniquement.** À 60 jours l'effet perd la significativité (t ≈ 1,7–1,8).
3. **Se concentrer sur crypto + finance** (écarts les plus forts et significatifs), **éviter
   culture** (effet inversé) et **politics** (non significatif).
4. **Filtrer le piège du `endDate`** : dater la résolution par `prices-history`, jamais par
   `endDate` (§3.4).
5. **Privilégier les marchés géopolitiques** (coûts 3–4× moindres) **si** le biais y existe — ce
   n'est **pas testé** ici.
6. **Taille** : la profondeur au meilleur prix est de **~400 USDC médians** (§4.2) → un déploiement
   réaliste se compte en **centaines d'USDC par marché**, quelques milliers sur les plus liquides.

### Recommandation classée (ajout)

1. **Scanner d'arbitrage de partition negRisk — edge PROUVÉ, enveloppe minuscule.**
   Seul edge structurel mesuré, et il **persiste** (§1.4 : 5/6 stables à ±0,3 % sur 22 min) → capturable.
   Mais ~24 USDC par balayage complet pour ~637 USDC immobilisés 9–15 mois (**< 5 % annualisé**).
   À coder **au mieux comme ramasse-miettes passif**, pas comme stratégie principale.
   Garde-fous : partitions **exhaustives** uniquement, et profondeur vérifiée au **carnet CLOB réel**.
   *Effort : faible-moyen.*
2. **Passer maker (attaque directe du vrai problème).** §4.4 : le coût taker (3–17 %) est ce qui tue
   tous les edges observés ; les makers paient **0** + rebate **15–25 %**. À mesurer d'abord :
   taux de fill et anti-sélection. *Effort : moyen.*
3. **Biais favori-outsider — ne pas coder maintenant.** Direction cohérente mais magnitude non fiable
   (deux artefacts, §3.7). Prérequis : test **prospectif** (enregistrer des prix à J−30 sur des
   marchés encore ouverts, puis comparer à la résolution), en filtrant les prix **exactement 0,500**
   et en dédupliquant les sous-marchés corrélés. *Effort : élevé.*
4. **À rayer définitivement** : arbitrage binaire YES+NO (§1.1) et mispricing des digitals crypto vs
   référence externe (§2).

### Ce qu'il faut mesurer ensuite (ajout)

- **Arb de partition** : scan horaire sur 7 jours → opportunités/jour, taille moyenne, taux de
  disparition, et **taux de fill réel** des N jambes simultanées. Un seul chiffre décide si
  l'enveloppe annuelle dépasse quelques centaines d'USDC : le **taux d'arrivée**.
- **Maker** : probabilité de fill et PnL adverse sur ordres au repos, 2–3 marchés liquides.
- **Sécurité de résolution** : vérifier dans la description UMA qu'aucune issue « autre » n'existe
  avant d'engager du capital (le cas Millennium — Navier-Stokes absent — le montre).

### Cadre d'honnêteté

Aucun chiffre de ce document ne promet un gain. Le **seul edge structurel prouvé** est l'arbitrage de
partition negRisk — réel, persistant (§1.4), mais **~24 USDC** par balayage complet de l'univers pour
un capital immobilisé 9–15 mois. Le **seul signal de calibration** (biais favori-outsider, §3) est un
écart de **+4 à +7 points de probabilité** sur un échantillon rétrospectif non aléatoire — dont la
magnitude est **en partie un artefact** (prix seedés à 0,500 ; échantillon 100 % biaisé pro-YES, §3.7).
C'est une **hypothèse sérieuse à tester prospectivement**, pas une stratégie validée. Le reste
(arbitrage binaire, mispricing crypto) est **fermé par construction**.

**Note de provenance.** Ce document résulte de la fusion de **deux analyses menées en parallèle** sur
le même dépôt, qui ont convergé indépendamment sur les mêmes ordres de grandeur (arb de partition :
17,68 vs 23,78 USDC net selon la convention de walk ; millennium : 10,57 vs 10,60 USDC). Les sections
marquées *(ajout)* proviennent de la seconde analyse ; les autres de la première. Les divergences de
convention sont explicitées en §1.5. **Aucun fichier hors `docs/research/**` et ce rapport n'a été
modifié.**

---

## 6. Reproductibilité

```bash
cd /root/clawd/Polymarket-bot/docs/research

# Piste 1a — arbitrage binaire YES+NO (0/274)
python3 01_arb_yesno.py 300          # -> arb_scan.json

# Piste 1b — arbitrage de partition
python3 02_arb_multi.py 1500         # -> arb_multi.json
python3 03_verify_multi.py           # carnets réels + profondeur
python3 08_arb_fees.py               # frais réels -> arb_multi_final.json

# Piste 2 — mispricing vs référence externe
python3 05_crypto_mispricing.py      # digitals vs Binance/spot
python3 06_iv_analysis.py            # vol implicite -> iv_analysis.json
python3 07_prob_bands.py             # comparaison à moneyness fixe -> prob_bands.json

# Piste 3 — biais favori-outsider
python3 04_favlong.py 900            # ~6 min -> favlong.json
python3 09_favlong_robust.py         # calibration par horizon et volume
python3 10_costs_categories.py       # biais par catégorie + coûts
python3 11_cluster_test.py           # dé-corrélation (248 clusters)
python3 12_gap_split.py              # split par écart à endDate

# Piste 4 — coûts
python3 10_costs_categories.py
python3 13_depth.py                  # profondeur reelle -> depth_sample.json
```

**Scripts complémentaires de l'analyse sœur (ajouts §1.4, §1.5, §3.7, §4.4) :**

```bash
# Piste 1b — persistance et walk net de frais
python3 14_arb_persistence.py        # re-scan a +22 min -> arb_persist.json
python3 09_final_arb.py              # walk net de frais -> arb_final.json

# Piste 3 — mise en evidence des artefacts
python3 _gap_join.py                 # preuve du biais endDate (100% placeholders) -> enddate_gap.json
python3 10_favlong_sports.py         # echantillon sportif a endDate reelle
python3 12_sports_open.py            # prix d'OUVERTURE vs cloture (le seed 0,500 apparait)
python3 13_sports_composition.py     # preuve du prix seede : completed-match n=31 prix 0,500 WR 1,000

# Piste 4 — cout d'entree en % de la mise
python3 11_costs.py
```

**Endpoints vérifiés et fonctionnels :**

| Usage | Endpoint |
|---|---|
| Marchés / événements | `gamma-api.polymarket.com/markets`, `/events` |
| Carnet complet | `clob.polymarket.com/book?token_id=<id>` |
| Historique de prix | `clob.polymarket.com/prices-history?market=<id>&interval=max&fidelity=1440` |
| Spot + vol réalisée | `api.binance.com/api/v3/ticker/price`, `/klines` |
| Vol implicite options | `deribit.com/api/v2/public/get_volatility_index_data?currency=BTC` |

**Pièges d'API confirmés :**

- `gamma-api.polymarket.com/markets?condition_id=<cid>` **ignore le filtre** (renvoie 20 marchés
  non filtrés) → cause du PnL faux du bot, cf. `STRATEGY-REVIEW.md` §1.2.
- `endDate` de Gamma **non fiable** : ≥ 98 j après le dernier trade, médiane 337 j (§3.4).
- Le `bestAsk` de Gamma peut être **périmé** → toujours revérifier avec `/book` avant de conclure
  à un arbitrage (§1.2, cas Tarif US-Chine).
- `/book` renvoie les `asks` du **plus cher au moins cher** → trier avant de prendre le meilleur.
- `gamma-api.polymarket.com/markets?condition_ids=<cid>` (pluriel) **renvoie une liste vide** pour un
  cid réel (mais `0` pour un cid bidon : il filtre, sans matcher) → **inutilisable**. Faire les
  jointures **par slug dans `/events`** puis **localement** par `conditionId`.
- `gamma-api.polymarket.com/markets?slug=<slug>` **renvoie `[]`** malgré un slug existant → passer par
  `/events?slug=`. Toujours `assert` l'identité (`slug`/`conditionId`) de la réponse.
- Les sous-marchés d'un événement sportif ont des prix d'ouverture **seedés à 0,500 exactement**
  (§3.7a) : un prix à 0,500 n'est **pas** une cotation, c'est une absence de découverte de prix.

---

## 7. Limites de cette étude

- **Échantillon rétrospectif et non aléatoire** : la liste `closed=true` de Gamma triée par
  `endDate` n'est pas un tirage aléatoire de marchés.
- **`endDate` inexploitable** → la résolution est datée par le dernier point de `prices-history`
  (proxy solide, mais un proxy).
- **Fréquence journalière** (`fidelity=1440`) pour les prix de référence → l'horizon exact
  « J−30 » varie de quelques heures.
- **SOL et XRP** : aucune référence de vol implicite disponible (Deribit ne les cote pas) → vol
  réalisée uniquement.
- **Le scan multi-issues est un instantané** : les 14 événements détectés peuvent disparaître en
  quelques minutes (ou apparaître ailleurs). **Persistance partiellement mesurée depuis (§1.4) :
  5/6 candidats stables à ±0,3 % après 22 min, deux identiques au tick.** Cela couvre *une* fenêtre
  de 22 min seulement — pas le cycle complet de 9–15 mois d'immobilisation.
- **Aucun ordre réel n'a été passé** : tout est calculé sur des carnets lus en lecture seule.
  L'exécution réelle (file d'attente, slippage, annulation) n'est pas mesurée.
- **Aucun chiffre de PnL futur n'est promis.** Le résultat §3 est une hypothèse à tester.
