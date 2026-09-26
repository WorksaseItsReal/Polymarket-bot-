# docs/backtest — harnais de backtest du bot Polymarket Up/Down 5m

Tout est en **Python 3 stdlib** (aucune dépendance à installer). Lecture seule sur le
code du bot et sur `~/.polymarket/` : les données sont **copiées** dans `data/` avant
analyse (le bot écrit en continu et un autre agent peut modifier les fichiers).

Le rapport qui utilise ces chiffres : [`../EDGE-VALIDATION.md`](../EDGE-VALIDATION.md).

## Ordre d'exécution (5 commandes, ~1 min au total)

```bash
cd /root/clawd/Polymarket-bot/docs/backtest

python3 snapshot_inputs.py                    # 1. fige ~/.polymarket/ + recon_trades.csv dans data/
python3 build_dataset.py                      # 2a. construit decisions.csv, executed.csv, slugs.txt
python3 resolve.py data/slugs.txt outcomes_cache.json --batch 20 --workers 4   # 2b. issues réelles
python3 build_dataset.py --resolved outcomes_cache.json                        # 2c. enrichit
python3 validate.py                           # 3. réconciliation, calibration, balayage, walk-forward
python3 nulltest.py --iters 2000              # 4. tests exacts, placebo, clustering
python3 reconcile.py                          # 5. décomposition du PnL officiel
python3 audit_decision_vs_trade.py            # 6. décisions du log vs trades comptés
python3 selftest_harness.py                   # 7. auto-test du moteur (21 tests, exit 0)
```

L'étape 2b interroge l'API Gamma (~72 requêtes, quelques secondes) et **met le résultat
en cache** dans `outcomes_cache.json` : les relances ne rappellent pas l'API.

## Rôle de chaque fichier

| fichier | rôle |
|---|---|
| `snapshot_inputs.py` | copie `~/.polymarket/*` + les données reconstruites dans `data/`, avec manifeste (sha256, mtime) |
| `probe_api.py` | prouve quel filtre d'API marche (`?slug=` répété) et lequel est ignoré (`slug__in=`, `markets?condition_id=`) |
| `resolve.py` | résout l'issue réelle de chaque round (`events?slug=`), avec garde-fou : un slug non demandé est rejeté |
| `build_dataset.py` | construit `data/decisions.csv` (toutes les décisions du log) et `data/executed.csv` (trades comptés) |
| `audit_decision_vs_trade.py` | décisions du log vs trades comptés : où est la coupure, est-elle biaisée ? |
| `harness.py` | **moteur réutilisable** : trades + règles → PnL, WR, IC95, t, drawdown |
| `selftest_harness.py` | auto-test du moteur : 21 vérifications (stats, chaque règle, causalité) |
| `validate.py` | les 8 sections d'analyse principales |
| `nulltest.py` | test binomial exact, placebo Monte-Carlo, IC robustes au clustering |
| `reconcile.py` | explique l'écart entre le PnL officiel et la somme des gains par trade |

## Utiliser le harnais sur un autre jeu de règles

```bash
# PnL, WR, IC95, t, drawdown pour n'importe quelle fenêtre de prix
python3 harness.py --dataset decisions --basis round --price-min 0.60 --price-max 0.68

# avec le détail par tranche de prix, en JSON complet
python3 harness.py --dataset executed --basis tp --print-buckets --json /tmp/out.json
```

Règles acceptées (dict Python dans `evaluate()`, ou options CLI) :

| règle | effet |
|---|---|
| `price_min`, `price_max` | fenêtre de prix d'entrée |
| `coins` | liste blanche de coins (`BTC,ETH`) |
| `sides` | `YES` / `NO` uniquement |
| `after`, `before` | bornes temporelles ISO |
| `stake` | mise fixe par trade |
| `stake_by_price` | fonction prix → multiplicateur de mise (sizing) |
| `skip_after_losses` | N pertes consécutives par coin → saute le trade suivant (causal) |
| `min_wr_recent` | saute si le WR des N derniers trades du coin passe sous un seuil (causal) |
| `basis='round'` | achat tenu jusqu'à la résolution du round |
| `basis='tp'` | reproduit les sorties réellement exécutées par le bot (TP/stop) |

Métriques renvoyées : `n, wins, losses, win_rate + IC95 Wilson, pnl, ev, sd, se,
IC95 du PnL (Student), IC95 bootstrap, t, p_value, max_drawdown, profit_factor,
gain_moyen, perte_moyenne, break_even_wr, marge_wr_pts, n_requis_t2`, plus les
décompositions `par_coin` et `par_bucket`.

## Deux jeux de données, deux questions

| | `data/executed.csv` | `data/decisions.csv` |
|---|---|---|
| contenu | les trades que le bot a **comptabilisés** (`cumulative.json`) | **toutes** les décisions `Décision YES/NO @` du log |
| n | 101 (100 résolus) | 1412 (1411 résolus) |
| période | 2026-09-18T13:41 → 09-26 | 2026-09-12 → 09-26 |
| répond à | « qu'a fait le bot, réellement ? » | « le signal d'entrée a-t-il un edge ? » |
| limite | petit n, période courte | ne modélise ni filtre, ni sizing, ni budget |

`executed` couvre **exactement** les 100 clés `conditionId|SIDE|price` du store
cumulatif (0 manquante) : vérifié dans `data/dataset_report.json`.

## Limites assumées du harnais

- **Pas de données tick.** Un take-profit à un prix *jamais observé* n'est pas
  simulable. On ne peut comparer que « tenu au round » vs « sortie réellement
  exécutée par le bot ». Le paramètre `.env P_TAKE_PROFIT` ne peut donc pas être
  balayé : seulement opposé à « aucune vente ».
- **Pas de spread ni de frais** modélisés. Le prix retenu est celui de la décision ;
  un spread réel dégraderait l'EV (jamais l'inverse).
- **Pas de carnet d'ordres / profondeur** : on suppose la mise systématiquement
  exécutable.
- Les décisions du log s'arrêtent le 2026-09-20 (le log de 622 Mo a été purgé) ;
  les trades du 09-25/26 ne sont disponibles que via `history.json`.
