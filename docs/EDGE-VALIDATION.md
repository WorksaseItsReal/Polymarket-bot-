# Validation d'edge — Polymarket Up/Down 5 min (paper bot)

**Analyse : 2026-09-26** · périmètre : lecture seule sur `/root/clawd/Polymarket-bot` et `~/.polymarket/`
**Code du harnais : [`docs/backtest/`](backtest/README.md)** · **Résultats bruts : `docs/backtest/validation_results.json`, `nulltest_results.json`**
Méthode : **1 412 décisions** extraites du log + **101 trades comptés** par le bot, chaque round
re-résolu sur l'issue réelle via `gamma-api.polymarket.com/events?slug=<coin>-updown-5m-<slot>`
(1 424 / 1 425 rounds résolus, chemin buggé `markets?condition_id=` jamais utilisé).

> **État figé** : les chiffres portent sur le snapshot du **2026-09-26T10:00:45 UTC** de
> `~/.polymarket/` (hashes SHA-256 dans `backtest/data/manifest.json`). Le bot tourne pendant
> l'analyse : relancer `snapshot_inputs.py` plus tard analysera **un autre état** et les
> compteurs (n, PnL) bougeront. Pour reproduire **ces** chiffres, ne pas re-snapshoter.

---

## 0. VERDICT — à lire avant tout le reste

> **L'edge n'est pas démontré. La meilleure estimation disponible de l'EV par trade est
> NÉGATIVE : −0,025 €.** Sur 1 411 décisions réparties sur 10 jours, le win rate réel
> (63,22 %) est **inférieur** au prix moyen payé (64,88 %), c'est-à-dire au taux de réussite
> d'équilibre. L'intervalle de confiance du PnL contient zéro : on ne peut ni affirmer un
> gain, ni affirmer une perte. Ce qui est sûr, c'est qu'**aucune preuve de gain n'existe**,
> et que le PnL affiché par le bot (+3,03 €) est **à la fois inexact** (sous-estimé de
> 2,69 €, §3) **et non significatif** (8 jours, n=100).

| Question | Réponse | Où |
|---|---|---|
| L'EV par trade est-elle positive ? | **Non établi.** Point central **−0,025 €** (n=1 411, IC95 PnL −0,065…+0,014, t=−1,27). Sur les 100 trades comptés : **+0,057 €** (n=100, IC95 −0,081…+0,195, t=0,82, p=0,42). | §4, §8 |
| Le marché est-il battable par le niveau de prix ? | **Non.** WR réel 63,22 % vs break-even 64,88 % → **−1,67 pt**. Tranche par tranche : −2,7 / −0,0 / −1,9 / −3,5 / +5,0 pts. | §5 |
| La fenêtre 0,58–0,65 est-elle un edge ? | **Non concluant, et probablement non.** +9,08 € sur 39 trades (p brut 0,049) mais **−19,01 € sur les 745 décisions de la même fenêtre**, p corrigée de la multiplicité = **1,0**, et le placebo dit qu'un marché parfaitement prixé ferait **mieux** par hasard. | §6, §9 |
| Une règle « gagnante » tient-elle hors échantillon ? | **Non.** La meilleure fenêtre in-sample (0,65–0,70, EV +0,025) donne **EV −0,084** hors échantillon. | §7 |
| Peut-on déclarer un coin bon ou mauvais ? | **Non.** Les 5 IC95 de l'EV par coin contiennent tous zéro. | §10 |
| Le stop-loss sert-il à quelque chose ? | **Non sur un binaire.** 30/30 pertes à −1,0000 (base round) : un round perdu perd 100 % de la mise. | §11 |
| Le take-profit coûte-t-il de l'argent ? | **Oui, probablement.** Comparaison appariée : **+0,5447 €** si tout avait été tenu au round (+9,5 % du PnL), t=1,92, p=0,055. Suggestif, non prouvé. | §11 |
| Le PnL affiché est-il juste ? | **Non.** Officiel 3,0276 € ; recalculé sur les mêmes trades **5,7202 €** → **sous-estimé de 2,69 €**. | §3 |
| Combien de trades pour conclure ? | **~601** à l'EV observée, soit **≈47 jours** à la cadence mesurée (12,8 trades/jour). | §8 |

**Ce qu'il ne faut pas faire** : coder en dur la fenêtre 0,58–0,65, un filtre par coin, ou
un cooldown « après 2 pertes ». Toutes ces « améliorations » mesurées sur 63 ou 100 trades
sont du bruit reproductible — la preuve est au §9.

---

## 1. Ce qui a été analysé (et ce qui manque)

Deux jeux de données, construits et figés par `snapshot_inputs.py` + `build_dataset.py` :

| | A. `data/executed.csv` | B. `data/decisions.csv` |
|---|---|---|
| contenu | les trades que le bot a **comptabilisés** (`cumulative.json`) | **toutes** les décisions `Décision YES/NO @` du log |
| n résolus | **100** (101 lignes, 1 round non encore clos) | **1 411** (1 412 lignes) |
| période | 2026-09-18T13:41 → 2026-09-26T09:59 (7,8 j) | 2026-09-12T20:12 → 2026-09-26T09:59 (**10 jours**) |
| ce qu'il mesure | la performance réellement enregistrée | le pouvoir prédictif du signal d'entrée, sans filtre ni sizing |
| limite | petit n, période courte, toutes les règles du bot appliquées | modèle « on prend tout », pas de budget ni de filtre |

**Contrôle d'intégrité de A :** les 100 lignes résolues couvrent **exactement** les 100 clés
`conditionId|SIDE|price` de `cumulative.json` (0 manquante, 1 en plus = le trade encore
ouvert). Le côté et le prix correspondent au log pour 87/100 (les 13 autres viennent du log
de 622 Mo purgé, non relisible). Détail : `data/dataset_report.json`,
`data/audit_decision_vs_trade.json`.

**Pourquoi 1 411 décisions et seulement 100 trades comptés ?** Le store cumulatif a été
remis à zéro à **2026-09-18T13:41:17** : le ratio « décisions comptées / décisions » passe
de **0 % → 100 %** à cet instant (`2026-09-18` : 52/405, `2026-09-19` : 6/6, `2026-09-20` :
5/5, `2026-09-26` : 24/25). La coupure est **temporelle, pas dépendante du résultat** — c'est
ce qui autorise à utiliser le jeu B comme échantillon propre de la règle d'entrée.
(Test à deux échantillons comptées vs non comptées : t=1,40 ; rien de significatif.)

**Ce qui manque, et qui limite tout le reste :**
- la période 2026-09-20T14:29 → 2026-09-25T21:30 : **0 trade, 0 donnée** (bot arrêté) ;
- pas de données tick → un take-profit à un prix *jamais observé* n'est pas simulable ;
- pas de spread ni de frais modélisés (un spread réel ne peut que **dégrader** l'EV) ;
- le log de 622 Mo a été purgé : les décisions avant 09-12 sont perdues.

---

## 2. Le harnais (livrable 1)

`docs/backtest/harness.py` — moteur en **Python stdlib**, aucune dépendance.

```bash
python3 harness.py --dataset decisions --basis round --price-min 0.60 --price-max 0.68
python3 harness.py --dataset executed  --basis tp --print-buckets --json /tmp/m.json
```

Il prend un jeu de trades (avec l'issue réelle du round) et un dict de règles :
`price_min/price_max`, `coins`, `sides`, `after/before`, `stake`, `stake_by_price` (sizing),
`skip_after_losses` et `min_wr_recent` (règles causales, n'utilisent que le passé), plus
`basis='round'` (tenu jusqu'à la résolution) ou `'tp'` (sortie réellement exécutée).
Il renvoie : `n, wins, losses, win_rate + IC95 Wilson, pnl, ev, sd, se, IC95 PnL (Student),
IC95 bootstrap (2000 rééchantillonnages), t, p_value, max_drawdown (pic→creux sur la courbe
cumulée chronologique), profit_factor, gain_moyen, perte_moyenne, break_even_wr,
marge_wr_pts, n_requis_t2`, plus `par_coin` et `par_bucket`.

Les 5 autres scripts (`snapshot_inputs`, `resolve`, `build_dataset`, `validate`, `nulltest`,
`reconcile`, `audit_decision_vs_trade`) et l'ordre d'exécution sont décrits dans
[`backtest/README.md`](backtest/README.md).

---

## 3. Réconciliation comptable — le PnL affiché est faux

| Source | n | W/L | PnL |
|---|---|---|---|
| `cumulative.json` (officiel) | 100 | 68 / 32 | **+3,0276 €** |
| somme des `realized` stockés, trade par trade | 100 | — | **+5,7202 €** |
| recalcul indépendant, sorties réelles du bot | 100 | 70 / 30 | **+5,7201 €** |
| recalcul indépendant, achat tenu jusqu'au round | 100 | 70 / 30 | **+6,2649 €** |

**Décomposition exacte de l'écart de 2,69 €** (`reconcile.py`) :

```
cumulative.pnl officiel                   +3,0276
 = valeur du repair du 2026-09-25 (63 tr.) -2,0737   (wins 41 / losses 22)
 + realized stockés des 37 trades suivants +5,1013
 = +3,0276   (écart -0,0000)
```

Autrement dit : le total officiel transporte encore un chiffre du repair du 25/09
(**−2,0737 €** pour les 63 premiers trades) qui **ne correspond ni** à la somme des
`realized` stockés (**+0,6191 €**), **ni** au propre calcul du repair en base « issue du
round » (**+0,7435 €**, qu'il avait lui-même enregistré sous `after_round_only`). Les
37 trades suivants, eux, sont cohérents (5,1013 €).

Deux corrections à retenir : **le PnL cumulé affiché est sous-estimé de 2,69 €**, et il est
**impossible d'auditer ce total** — `cumulative.json` ne stocke qu'un ensemble de clés, pas
le PnL par trade. C'est un défaut à corriger (écrire `pnl` par clé), pas seulement un chiffre
à corriger.

---

## 4. Chiffres de base reproductibles

**A. Les 100 trades comptés** (`executed`, mise 1 €) :

| base | n | W/L | WR | IC95 WR | PnL | EV/trade | IC95 EV | t | p | DD max | break-even WR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| round | 100 | 70/30 | 70,0 % | 60,4–78,1 | **+6,2649** | +0,0626 | −0,077…+0,202 | 0,89 | 0,38 | 4,85 | 65,9 % |
| tp (sorties réelles) | 100 | 70/30 | 70,0 % | 60,4–78,1 | **+5,7201** | +0,0572 | −0,081…+0,195 | 0,82 | 0,42 | 4,87 | 65,9 % |

**B. Toutes les décisions du log** (`decisions`, base round) :

| n | W/L | WR | IC95 WR | PnL | EV/trade | IC95 EV | t | p | DD max | break-even WR | marge |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **1 411** | 892/519 | **63,2 %** | 60,7–65,7 | **−35,71** | **−0,0253** | −0,065…+0,014 | −1,27 | 0,21 | 79,9 | 64,9 % | **−1,64 pt** |

Lecture honnête : avec 20× plus de données, le signe de l'EV **s'inverse** par rapport aux
100 trades comptés. C'est exactement ce à quoi ressemble une absence d'edge : le sous-échantillon
le plus récent et le plus court est le plus flatteur.

Le DD max de 79,9 € sur 1 411 trades à 1 € de mise est à comparer au capital configuré
(`CAPITAL_USD=50`) : une perte cumulée de 79,9 € dépasse le capital initial, autrement dit
**le bot aurait été à sec avant d'atteindre la fin de l'échantillon**. Ce chiffre est aussi
un rappel que la série de pertes de 63−100 trades ne se lit pas isolément.

---

## 5. Le mur : le marché est correctement prixé

Test le plus dur, sur 1 411 décisions. Sur un binaire tout-ou-rien, le taux de réussite
d'équilibre est **exactement le prix payé** (`WR·(1/p−1) = (1−WR) ⟺ WR = p`).

| tranche de prix | n | prix moyen payé | WR réel | IC95 WR | break-even | marge |
|---|---|---|---|---|---|---|
| 0,55–0,60 | 402 | 0,5892 | 56,2 % | 51,3–61,0 | 58,9 % | **−2,70 pt** |
| 0,60–0,65 | 464 | 0,6186 | 61,9 % | 57,4–66,2 | 61,9 % | **−0,00 pt** |
| 0,65–0,70 | 401 | 0,6754 | 65,6 % | 60,8–70,1 | 67,5 % | **−1,95 pt** |
| 0,70–0,75 | 300 | 0,7181 | 68,3 % | 62,9–73,3 | 71,8 % | **−3,47 pt** |
| 0,75–0,80 | 50 | 0,7500 | 80,0 % | 67,0–88,8 | 75,0 % | +5,00 pt |

**Conclusion : il n'y a pas d'edge dans le niveau de prix.** Le marché donne à chaque prix
la probabilité qui correspond, à ±3 pts. Acheter le favori à 0,62 est un pari à espérance
nulle **avant coûts** ; après spread et friction, il est négatif.

C'est le résultat structurant de tout ce rapport : sur un marché calibré, **aucune règle
basée sur le prix d'entrée ne peut créer un edge**. Seul un prédicteur meilleur que le prix
du marché, ou une capture de spread (market making), le pourrait. Ni l'un ni l'autre n'est
démontré ici.

---

## 6. Hypothèse « ne miser QUE dans 0,58–0,65 » (livrable 4)

Même question, deux échantillons, réponses opposées :

| échantillon | n | W/L | WR | IC95 WR | PnL | EV/trade | IC95 EV | t | p | DD max |
|---|---|---|---|---|---|---|---|---|---|---|
| **100 trades comptés** (base round) | **39** | 29/10 | 74,4 % | 58,9–85,4 | **+9,0753** | +0,2327 | −0,004…+0,470 | 1,98 | 0,048 | 3,85 |
| 100 trades comptés (base tp) | 39 | 29/10 | 74,4 % | 58,9–85,4 | +8,6473 | +0,2217 | −0,011…+0,455 | 1,92 | 0,056 | 3,87 |
| **745 décisions du log** (base round) | **745** | 440/305 | 59,1 % | 55,5–62,5 | **−19,0145** | **−0,0255** | −0,084…+0,033 | −0,86 | 0,39 | 46,9 |

- En base round, l'IC95 bootstrap de l'EV sur les 39 trades est **[−0,0118 ; +0,4509]** : il
  **contient zéro**. Même le « résultat spectaculaire » n'est pas significatif à 39 trades.
- Dans la même fenêtre, la mesure à 745 trades donne une EV **négative** et un WR (59,1 %)
  **sous** son break-even (60,6 %) : marge −1,55 pt.
- Test binomial exact : « 29 gagnants sur 39 à un prix implicite de 0,60 » → P(X ≥ 29) =
  **0,0491**, mais **29 fenêtres de prix ont été balayées** → p corrigée (Bonferroni) = **1,0**.
  Sur les 745 décisions : P(X ≥ 440) = **0,81** — aucune anomalie.
- `n_requis_t2` = **40** dans le sous-échantillon de 39… ce qui signifie que le hasard peut
  fabriquer ce résultat, et que ce chiffre n'est pas un plan de trading.

**Verdict sur cette hypothèse, sans détour : NON CONCLUANT.** Le signal positif existe
uniquement dans le plus petit échantillon, il disparaît (et change de signe) dans le plus
grand, il n'est pas significatif même sur 39 trades, et il ne survit pas à la correction de
multiplicité. La recommandation C2 du `STRATEGY-REVIEW.md` (baisser `P_STRONG_MAX` à 0,65)
**n'est pas soutenue par les données** : au mieux c'est neutre, et la marge de 20 pts affichée
dans la revue précédente venait d'un échantillon de 16 trades.

---

## 7. Walk-forward / split temporel (livrable 2)

### 7.1 Trois périodes chronologiques (jeu des décisions)

| période | n | WR | PnL | EV | t | **0,58–0,65** : n / EV | **0,65–0,75** : n / EV |
|---|---|---|---|---|---|---|---|
| P1 09-12 → 09-14 | 330 | 68,5 % | +8,07 | +0,0245 | 0,63 | 122 / **−0,0444** | 191 / **+0,0689** |
| P2 09-15 → 09-18 | 641 | 61,5 % | −15,51 | −0,0242 | −0,79 | 442 / **−0,0140** | 188 / −0,0691 |
| P3 09-18 → 09-21 | 416 | 60,8 % | −34,15 | −0,0821 | −2,25 | 165 / −0,0591 | 230 / −0,1017 |
| P4 09-25 → 09-26 (trades comptés, base tp) | 37 | 73,0 % | +5,10 | +0,1379 | 1,19 | 23 / +0,1477 | 13 / +0,1055 |

**Rien n'est stable.** La fenêtre 0,58–0,65 est négative en P1, P2 et P3. La fenêtre
0,65–0,75 est positive en P1 et négative ensuite. Le signe change de période en période,
y compris pour la période qui contient les 63 trades de la revue précédente.

### 7.2 Sélection in-sample puis test hors échantillon (le vrai test anti-sur-apprentissage)

Coupure à `2026-09-17T22:40` (66 % / 34 %). On balaie 29 fenêtres de prix, on garde la
meilleure **en in-sample**, on mesure son EV **hors échantillon** :

| fenêtre | EV in-sample | EV hors échantillon | WR OOS | break-even OOS | t OOS |
|---|---|---|---|---|---|
| 0,60–0,65 | +0,0057 | −0,0124 | 61,3 % | 62,1 % | −0,18 |
| 0,60–0,70 | +0,0130 | −0,0464 | 61,2 % | 64,1 % | −0,98 |
| 0,65–0,70 *(meilleure IS)* | **+0,0252** | **−0,0842** | 61,0 % | 66,6 % | −1,27 |
| 0,65–0,80 | +0,0243 | −0,0931 | 63,2 % | 69,7 % | −2,24 |
| 0,70–0,80 | +0,0233 | −0,1000 | 65,0 % | 72,2 % | −1,89 |

**La meilleure fenêtre in-sample (0,65–0,70, EV +0,0252) donne −0,0842 hors échantillon.**
Aucune des fenêtres positives in-sample ne reste positive hors échantillon. Le motif est même
systématique : toutes les fenêtres hautes (plancher ≥ 0,65) sont **négatives** hors échantillon
(t de −1,3 à −2,3 selon la fenêtre), ce qui est la signature d'un prix d'entrée trop élevé,
pas d'un edge manqué.

### 7.3 Granularité par jour (10 jours)

| jour | n | WR | PnL | EV | t | 0,58–0,65 : n / EV |
|---|---|---|---|---|---|---|
| 09-12 | 70 | 68,6 % | +2,79 | +0,0398 | 0,47 | 28 / +0,0547 |
| 09-13 | 213 | 67,6 % | +2,22 | +0,0104 | 0,21 | 78 / **−0,1127** |
| 09-14 | 47 | 72,3 % | +3,07 | +0,0652 | 0,66 | 16 / +0,1148 |
| 09-15 | 49 | 63,3 % | −1,22 | −0,0250 | −0,23 | 25 / −0,0581 |
| 09-16 | 116 | 66,4 % | +10,52 | +0,0907 | 1,25 | 104 / +0,0934 |
| 09-17 | 476 | 60,1 % | −24,81 | −0,0521 | −1,46 | 313 / **−0,0462** |
| 09-18 | 405 | 60,2 % | −35,85 | −0,0885 | −2,39 | 165 / **−0,0591** |
| 09-19 | 6 | 83,3 % | +1,06 | +0,1772 | 0,75 | 0 / n/a |
| 09-20 | 5 | 80,0 % | +0,64 | +0,1274 | 0,45 | 0 / n/a |
| 09-26 | 24 | 79,2 % | +5,88 | +0,2449 | 1,81 | 16 / +0,1475 |

Les **trois journées à ≥200 décisions** (09-13, 09-17, 09-18) donnent EV = +0,010 /
−0,052 / −0,089 : les plus gros échantillons sont les moins favorables. Les journées les
plus « rentables » sont celles qui ont 5 à 24 trades. C'est le contraire d'un edge.

*(Prudence symétrique : le P3 ressort à t = −2,25, « significativement négatif ». Sur 3
périodes testées, c'est du même ordre de bruit — je ne conclus pas non plus que le bot perd
de l'argent de façon certaine.)*

---

## 8. Significativité honnête et taille d'échantillon (livrable 3)

| mesure | n | EV (€/trade) | IC95 de l'EV (Student) | IC95 bootstrap | t | p |
|---|---|---|---|---|---|---|
| 100 trades comptés, base tp | 100 | +0,0572 | −0,0809 … +0,1953 | −0,0850 … +0,1932 | 0,82 | 0,42 |
| 100 trades comptés, base round | 100 | +0,0626 | −0,0767 … +0,2020 | −0,0821 … +0,1991 | 0,89 | 0,38 |
| 1 411 décisions, base round | 1 411 | **−0,0253** | −0,0645 … +0,0138 | −0,0631 … +0,0130 | −1,27 | 0,21 |

**Robustesse au clustering** (`nulltest.py`, section C). Il n'y a **pas** de grappe
intra-round (1 412 rounds pour 1 412 décisions : le bot ne tient qu'une position à la fois).
La grappe réelle est le **jour** (mouvements de marché communs) :

| jeu | SE i.i.d. | SE par jour | t par jour |
|---|---|---|---|
| 1 411 décisions | 0,0200 | 0,0330 | **−0,77** |
| 100 trades comptés | 0,0708 | 0,0538 | 1,16 |

En tenant compte de la dépendance quotidienne, la significativité **diminue encore**. Et les
5 coins bougent ensemble pendant un même mouvement de marché : la dépendance inter-coins
n'est pas modélisée, donc les IC ci-dessus sont **optimistes** (les vraies bornes sont plus
larges, pas plus étroites).

**Nombre de trades nécessaires pour t = 2** (`n = (2·σ/EV)²`, en supposant l'EV mesurée vraie) :

| base de calcul | EV | σ | n requis (t=2) | délai à 12,8 trades/jour |
|---|---|---|---|---|
| 100 trades comptés (tp) | +0,0572 | 0,70 | **601** | **≈ 47 jours** |
| 63 trades de la revue précédente | +0,0098 | 0,70 | **20 379** | ≈ 4,4 ans |
| 1 411 décisions | −0,0253 | 0,75 | **jamais (EV ≤ 0)** | — |
| fenêtre 0,58–0,65 sur 39 trades | +0,2327 | 0,69 | 43 | ≈ 3,4 jours |

Le dernier chiffre est le piège : il dit « à cette EV-là, 43 trades suffisent » — mais l'EV
de 0,2327 est justement celle qui n'est pas confirmée par les 745 autres mesures. Un plan
bâti dessus est un plan bâti sur du bruit.

**Avec n=100, le test est vide de puissance** : l'IC95 du PnL (−0,081 … +0,195) est
compatible avec une perte de 8 cents par trade **comme** avec un gain de 20 cents. Le
`STRATEGY-REVIEW.md` disait déjà cela ; la présente analyse le confirme avec 3× plus de
données et le chiffre change de signe.

---

## 9. Test de placebo et multiplicité — la preuve que 0,58–0,65 est du bruit

Question posée : *« la fenêtre gagnante trouvée par balayage est-elle mieux que ce que le
hasard produit sur un marché parfaitement prixé ? »*

**Procédure** : 2 000 simulations où chaque décision gagne avec probabilité = son prix
(marché parfaitement calibré — c'est précisément l'hypothèse nulle du §5). Sur chaque
simulation, on rejoue **exactement la même** procédure : balayage des 29 fenêtres,
sélection de la meilleure en in-sample sur les 66 % premiers, mesure de son EV hors
échantillon.

| statistique | valeur |
|---|---|
| meilleure EV in-sample trouvée **par pur hasard** — médiane | **+0,0495** |
| idem — 95ᵉ percentile | +0,1118 |
| idem — maximum sur 2 000 simulations | +0,1833 |
| **EV in-sample observée** (fenêtre 0,65–0,70) | **+0,0252** (22ᵉ percentile) |
| P(hasard ≥ observé) | **0,776** |
| probabilité que l'EV hors échantillon de la fenêtre « gagnante » soit négative | 51,5 % (observé : négative, −0,084) |

**Lecture :** le meilleur résultat que le balayage ait trouvé (+0,0252) est **inférieur à la
médiane** de ce qu'un marché sans edge produit par hasard (+0,0495) ; dans 78 % des
simulations sans edge, le hasard fait mieux. Et hors échantillon, le signe est une pièce
lancée.

**Conclusion : la fenêtre 0,58–0,65 (comme les autres) n'est pas distinguable de zéro. Elle
ne doit pas être codée en dur.**

---

## 10. EV par coin — peut-on déclarer un coin bon ou mauvais ? (livrable 5)

### Sur les 1 411 décisions (base round) — l'échantillon le plus large disponible

| coin | n | WR | IC95 WR | PnL | EV | **IC95 de l'EV** | t | verdict |
|---|---|---|---|---|---|---|---|---|
| BTC | 341 | 65,1 % | 59,9–70,0 | +2,38 | +0,0070 | −0,072 … +0,086 | 0,17 | indéterminé |
| SOL | 323 | 65,6 % | 60,3–70,6 | +6,73 | +0,0208 | −0,061 … +0,102 | 0,50 | indéterminé |
| XRP | 198 | 63,1 % | 56,2–69,5 | −8,95 | −0,0452 | −0,148 … +0,058 | −0,86 | indéterminé |
| ETH | 366 | 60,7 % | 55,6–65,5 | −21,67 | −0,0592 | −0,138 … +0,019 | −1,48 | indéterminé |
| DOGE | 183 | 60,7 % | 53,4–67,4 | −14,20 | −0,0776 | −0,186 … +0,031 | −1,40 | indéterminé |

### Sur les 100 trades comptés (base tp)

| coin | n | WR | IC95 WR | PnL | EV | IC95 de l'EV | t | verdict |
|---|---|---|---|---|---|---|---|---|
| BTC | 28 | 78,6 % | 60,5–89,8 | +6,42 | +0,2293 | −0,024 … +0,483 | 1,86 | indéterminé |
| XRP | 13 | 84,6 % | 57,8–95,7 | +3,30 | +0,2540 | −0,089 … +0,597 | 1,61 | indéterminé |
| ETH | 26 | 57,7 % | 38,9–74,5 | −3,09 | −0,1188 | −0,433 … +0,195 | −0,78 | indéterminé |
| SOL | 22 | 68,2 % | 47,3–83,6 | −0,09 | −0,0040 | −0,316 … +0,308 | −0,03 | indéterminé |
| DOGE | 11 | 63,6 % | 35,4–84,8 | −0,83 | −0,0751 | −0,571 … +0,421 | −0,34 | indéterminé |

**Verdict explicite : AUCUN coin ne peut être déclaré bon ou mauvais.** Les 10 intervalles
de confiance (20/20 sur les deux tableaux) contiennent tous zéro. Les rangs changent
complètement d'un tableau à l'autre : BTC est 1ᵉʳ sur les 100 trades, 4ᵉ sur les 1 411
décisions ; XRP est 3ᵉ sur 198 décisions et 2ᵉ sur 13 trades. Le « filtre d'edge par coin »
du bot ne peut pas fonctionner sur ces données — il re-tirerait du bruit à chaque mise à jour.
Le seul constat semi-solide est ETH/DOGE légèrement négatifs sur le gros échantillon
(t = −1,5 et −1,4), ce qui reste **insuffisant** pour exclure un coin.

---

## 11. Le seul levier mesurable : le take-profit

Comparaison **appariée** sur les mêmes 100 trades (seule la sortie change) — c'est un test
propre, contrairement à la comparaison de buckets :

| | valeur |
|---|---|
| PnL si toutes les positions étaient tenues jusqu'à la résolution du round | **+6,2649 €** |
| PnL avec les sorties réellement exécutées par le bot (ventes à 0,99/0,999 + stop) | **+5,7201 €** |
| delta | **+0,5447 €** (+9,5 % du PnL), **+0,0054 €/trade** |
| IC95 du delta | −0,0001 … +0,0110 (**contient zéro de justesse**) |
| t | 1,921 · p = 0,055 · sur **34 trades affectés** |

Le mécanisme est structurel et non discutable : vendre à 0,99 quand la résolution vaut 1,00
abandonne **1 % de la mise** sur chaque gagnant. Sur 34 sorties, ça coûte 0,54 € pour 100
trades. C'est le **seul** changement qui a une justification à la fois mécanique et
statistique (p=0,055, proche du seuil, mais non franchi).

**Ce qu'il ne faut PAS en déduire** : que désactiver le TP « rapporte » 0,54 € garantis.
Le résultat est au seuil de significativité, la décision repose sur 34 observations, et si
l'EV globale est nulle, retirer 1 % de coût ramène l'EV de 0 à −0,005 € : **toujours pas un
gain**. C'est un gain *relatif*, pas un edge.

**Stop-loss** : sur les 100 trades comptés, en base round, **30/30 pertes sont exactement à
−1,0000 €**. Sur un round binaire, un perdant perd 100 % de la mise : le stop à 25 % de
`P_STOP_LOSS` **ne peut pas** couper une perte de round. Sur les 34 sorties anticipées
enregistrées, **2 seulement** sont en perte (−0,9677 et −0,9322 : elles ont économisé 3,2 %
et 6,8 % de mise) — l'effet total du stop est donc marginal et ne peut pas être présenté
comme un contrôle du risque. Le seul levier de perte réel est **le prix d'entrée**.

---

## 12. Limites de cette validation (à lire avant d'agir)

1. **Taille.** 100 trades comptés, 1 411 décisions, 10 jours. À cette échelle, l'IC95 du
   PnL couvre ±14 cents par trade sur 1 € de mise.
2. **Un seul régime de marché.** 10 jours de septembre 2026, un seul marché (crypto calme).
   Rien ne dit ce qui se passe en marché directionnel.
3. **Pas de données tick.** Le balayage du take-profit est impossible (seuls « tenu au
   round » vs « sortie réellement exécutée » sont comparables). Idem pour un stop à un autre
   seuil, ou pour l'exécution réelle (glissement).
4. **Pas de spread ni de frais** dans l'EV. Le prix utilisé est celui de la décision. Tout
   coût réel **dégrade** l'EV mesurée : le point central −0,025 € deviendrait plus négatif.
5. **Le jeu des décisions suppose qu'on peut prendre chaque décision** sans contrainte de
   budget ni de position. Le bot, lui, ne tient qu'une position à la fois : le vrai
   portefeuille aurait pris moins de trades.
6. **Le log de 622 Mo a été purgé** : impossible de remonter avant le 2026-09-12 et 13 des
   100 trades comptés n'ont pas de décision correspondante dans le log actuel.
7. **Le store `cumulative.json` n'est pas auditable** (pas de PnL par clé) et son total est
   faux de 2,69 € : à corriger avant de tirer la moindre conclusion du dashboard.
8. **La période 09-20 → 09-25 est vide** (bot arrêté) : 5,3 jours sans donnée sur 14.

---

## 13. Ce qu'il faudrait pour qu'un edge existe (et soit démontrable)

Rien dans les données actuelles ne suggère un edge dans le **niveau de prix** : le marché
est calibré (§5). Les seules pistes qui restent théoriquement ouvertes, et ce qu'il faudrait
pour les trancher :

1. **Pouvoir prédire mieux que le prix** — or le prix *est* la prédiction du marché. Il
   faudrait un signal exogène (flux d'ordres, déséquilibre du carnet, microstructure) mesuré
   *avant* le prix. Aucun n'est présent dans le bot aujourd'hui (LLM désactivé, smartmoney
   désactivé).
2. **Capturer le spread** (market making) au lieu de le payer — autre métier, autres
   données, et ça se mesure sur les carnets, pas sur des rounds.
3. **Éviter la friction** : c'est le seul gain démontré ici (§11, −1 % sur les gagnants
   vendus trop tôt). Gain relatif, pas edge.
4. **Une preuve nécessite ~600 trades** à l'EV actuelle, ou **~200 trades par coin** pour
   juger un coin. À 12,8 trades/jour, c'est 47 jours d'exécution continue, et il faut que le
   bot tourne sans interruption (ce qu'il n'a pas fait : 5,3 jours d'arrêt sur 14).

**Recommandation opérationnelle honnête** : garder le bot **en observation** (paper)
jusqu'à ~600 trades comptés, corriger d'abord l'auditabilité du PnL (`pnl` par clé dans
`cumulative.json`), ne coder **aucun** filtre de prix / de coin / de cooldown issu de ces
données, et ne pas augmenter le sizing. Toute décision d'argent réel sur la base de 63 ou
100 trades serait une décision sur du bruit.

---

## 14. Comment reproduire (sorties réelles)

```bash
cd /root/clawd/Polymarket-bot/docs/backtest
python3 snapshot_inputs.py                                  # fige les entrées dans data/ (sha256 + mtime)
python3 build_dataset.py                                    # data/decisions.csv, data/executed.csv, data/slugs.txt
python3 resolve.py data/slugs.txt outcomes_cache.json --batch 20 --workers 4
python3 build_dataset.py --resolved outcomes_cache.json      # enrichit avec l'issue réelle
python3 validate.py                                          # 8 sections -> validation_results.json
python3 nulltest.py --iters 2000                             # -> nulltest_results.json
python3 reconcile.py                                         # -> data/reconciliation.json
python3 audit_decision_vs_trade.py                           # -> data/audit_decision_vs_trade.json
python3 selftest_harness.py                                  # -> 21 tests, "0 test(s) en échec", exit 0
```

### Sortie réelle — résolution des issues

```
$ python3 resolve.py data/slugs.txt outcomes_cache.json --batch 20 --workers 4
slugs demandés: 1425 | déjà en cache: 0 | à résoudre: 1425
  lots traités: 10/72
  ...
résolus: 1424/1425 (closed=1424, non résolus=1) -> outcomes_cache.json
UP gagnants: 736 (51.7%)
```

### Sortie réelle — moteur de backtest (livrable 1)

```
$ python3 harness.py --dataset decisions --basis round
### dataset=decisions base=round regles={'stake': 1.0}
  n=1411  W=892 L=519  WR=63.2% (IC95 60.7-65.7)  PnL=-35.7136  EV=-0.0253  t=-1.267  p=0.205
     IC95 PnL/trade=[-0.0645, 0.0138]  IC95 bootstrap=[-0.0631, 0.013]  DDmax=79.9092  PF=0.931  break-even WR=64.9%  marge=-1.64 pt
     gain moyen=0.5418  perte moyenne=1.0  n requis pour t=2=None

$ python3 harness.py --dataset executed --basis tp --price-min 0.58 --price-max 0.65
### dataset=executed base=tp regles={'price_min': 0.58, 'price_max': 0.65, 'stake': 1.0}
  n=39  W=29 L=10  WR=74.4% (IC95 58.9-85.4)  PnL=+8.6473  EV=+0.2217  t=1.915  p=0.0555
     IC95 PnL/trade=[-0.0112, 0.4546]  IC95 bootstrap=[-0.0233, 0.4333]  DDmax=3.8658  PF=1.49  break-even WR=60.3%  marge=14.04 pt

$ python3 harness.py --dataset decisions --basis round --price-min 0.58 --price-max 0.65
  n=745  W=440 L=305  WR=59.1% (IC95 55.5-62.5)  PnL=-19.0145  EV=-0.0255  t=-0.857  p=0.3915
     IC95 PnL/trade=[-0.0839, 0.0329]  IC95 bootstrap=[-0.0822, 0.0308]  DDmax=46.9038  PF=0.938  break-even WR=60.6%  marge=-1.55 pt
```

### Sortie réelle — calibration, walk-forward, TP (extraits de `validate.py`)

```
2. CALIBRATION DU MARCHÉ (prix payé vs WR réel)
  0.55-0.60  n=402   prix=0.589  WR réel= 56.2% (IC95  51.3- 61.0)  break-even=58.9%  marge=-2.70 pt
  0.60-0.65  n=464   prix=0.619  WR réel= 61.9% (IC95  57.4- 66.2)  break-even=61.9%  marge=-0.00 pt
  0.65-0.70  n=401   prix=0.675  WR réel= 65.6% (IC95  60.8- 70.1)  break-even=67.5%  marge=-1.95 pt
  0.70-0.75  n=300   prix=0.718  WR réel= 68.3% (IC95  62.9- 73.3)  break-even=71.8%  marge=-3.47 pt
  0.75-0.80  n=50    prix=0.750  WR réel= 80.0% (IC95  67.0- 88.8)  break-even=75.0%  marge=+5.00 pt

3. BALAYAGE DE FENÊTRES + SÉLECTION IN-SAMPLE / TEST HORS ÉCHANTILLON
  coupure temporelle (66 % in-sample / 34 % OOS) à 2026-09-17T22:40:28
  fenêtre            IS: n / EV      |  OOS: n / EV      WR / break-even / t
  0.65-0.70   IS n=193   EV=+0.0252 | OOS n=123   EV=-0.0842  WR=61.0% BE=66.6% t=-1.269  <-- EV IS la plus haute
  0.65-0.75   IS n=359   EV=+0.0159 | OOS n=257   EV=-0.1001  WR=62.3% BE=69.2% t=-2.281
  MEILLEURE FENÊTRE EN IN-SAMPLE : 0.65-0.70 → OOS EV=-0.0842 (n=123, t=-1.269)

8. CALIBRATION EN UN CHIFFRE + EFFET DU TAKE-PROFIT (test apparié)
  décisions : n=1411  prix moyen payé=0.6488  WR réel=63.22%  break-even=64.88%  marge=-1.67 pt  EV mesurée=-0.0253 €/trade
  take-profit (100 trades comptés, comparaison appariée) :
    PnL si tout tenu au round : +6.2649
    PnL avec les sorties réelles du bot : +5.7201
    delta = +0.5447 € au total, +0.0054 €/trade (IC95 [-0.0001, 0.011], t=1.921, p=0.0548) sur 34 trades affectés
```

### Sortie réelle — placebo, binomial, clustering (`nulltest.py`)

```
A) TEST EXACT (binomial) SUR LA FENÊTRE 0,58-0,65
  décisions du log (n=745)     n=745  gagnants=440 prix implicite=0.606  WR= 59.1%  P(X>=440)=0.8112
  100 trades comptés (n=39)    n=39   gagnants=29  prix implicite=0.603  WR= 74.4%  P(X>=29)=0.0491
  NB : 29 fenêtres de prix ont été balayées -> p corrigée (Bonferroni) ≈ 1.0000 pour la meilleure.

B) TEST DE PLACEBO — marchés parfaitement prixés, même procédure de sélection
  2000 simulations d'un marché PARFAITEMENT prixé (Bernoulli(prix)).
  Meilleure EV in-sample trouvée par hasard : médiane +0.0495, 95e % +0.1118, max +0.1833
  EV in-sample OBSERVÉE (fenêtre 0,65-0,70) : +0.0252  -> percentile 22.4 %
  P(meilleure EV in-sample >= observée par pur hasard) = 0.776
  Hors échantillon, l'EV de la fenêtre « gagnante » est négative dans 51.5 % des simulations (observé : négative, -0.0842)

C) ERREURS STANDARD ROBUSTES AU CLUSTERING
  décisions (n=1411)           par jour  n=1411  grappes=10    EV=-0.0253  SE(cluster)=0.0330  t=-0.77
  trades comptés (base round)  par jour  n=100   grappes=5     EV=+0.0626  SE(cluster)=0.0538  t=1.16
```

### Sortie réelle — réconciliation du PnL (`reconcile.py`)

```
cumulative.pnl officiel                  : +3.0276
  = valeur du repair 2026-09-25 (63 tr.) : -2.0737  (wins 41 / losses 22)
  + realized stockés des 37 trades suiv. : +5.1013
  = +3.0276   (écart avec l'officiel : -0.0000)

recalcul indépendant sur l'issue réelle :
  les 63 premiers, base sorties réelles  : +0.6191
  les 37 suivants, sorties TP du bot     : +5.1010
  total 100 trades, base sorties réelles : +5.7201
  total 100 trades, tenu au round        : +6.2649
wins/losses : officiel 68/32 | recalculé (round) 70/30
```

### Sortie réelle — auto-test du moteur (`selftest_harness.py`)

```
$ python3 selftest_harness.py; echo "exit=$?"
OK   datasets chargés                                     decisions=1412 executed=101
OK   mean/sd corrigé (ddof=1)                             mean=0.0000 sd=1.1547
OK   IC Wilson 8/10 ~ [0.49, 0.94]                        [0.490, 0.943]
OK   t975(4)=2.776, t975(30)=2.042, t975(1000)->1.96
OK   break_even_wr([0.5]) = 2/3
OK   required_n(0.1, 0.5, 2) = 100
OK   required_n(EV<=0) = None
OK   max_drawdown([1,-1,-1,2]) = 2
OK   bootstrap IC encadre la moyenne                      [-0.200, 0.200]
OK   pas de règle -> tout l'échantillon                   n=1411
OK   filtre de prix                                       n=464
OK   filtre de coin                                       n=341
OK   filtre de côté                                       n=661
OK   bornes temporelles                                   n=405
OK   mise fixe x2.5                                       -89.2841 vs -89.2840
OK   sizing par prix (callable)                           -46.9174
OK   cooldown après 2 pertes                              n=56 sautés=1355
OK   filtre WR récent                                     n=42
OK   base tp vs round diffèrent                           tp=+8.6473 round=+9.0753
OK   IC95 PnL encadre l'EV                                [-0.0041, 0.4695] autour de +0.2327
OK   règles causales (aucun look-ahead)                   9 décisions identiques sur le préfixe

0 test(s) en échec
exit=0
```

### Fichiers produits

| fichier | contenu |
|---|---|
| `backtest/harness.py` | moteur de backtest (règles → métriques) |
| `backtest/{snapshot_inputs,resolve,build_dataset,validate,nulltest,reconcile,audit_decision_vs_trade,selftest_harness,probe_api}.py` | chaîne complète, rejouable |
| `backtest/outcomes_cache.json` | issue réelle des 1 424 rounds (1 425 demandés) |
| `backtest/validation_results.json` | toutes les métriques du §3 à §8, §10, §11 |
| `backtest/nulltest_results.json` | binomial, placebo 2 000 tirages, clustering |
| `backtest/data/*.csv` | jeux de données figés + rapport de couverture |
| `backtest/README.md` | mode d'emploi du harnais |

Aucun fichier hors de `docs/backtest/` et `docs/EDGE-VALIDATION.md` n'a été créé ni modifié.
`bot-with-dashboard.ts`, `.env` et `~/.polymarket/*` sont restés en lecture seule (seules des
copies dans `docs/backtest/data/` ont été faites).
