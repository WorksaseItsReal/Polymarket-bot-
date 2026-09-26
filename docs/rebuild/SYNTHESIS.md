# SYNTHESIS.md — Synthèse chiffrée des audits du paperbot Polymarket « Up/Down 5 min »

**Objet :** agréger, sans enjolivement, les conclusions des rapports d'audit déjà écrits, avec
pour **chaque affirmation un renvoi vers le fichier source**.
**Bot :** `polymarket-paperbot` (PM2, `tsx`), **PAPER** (`DRY_RUN=true`), stratégie 100 %
déterministe (LLM off), 5 coins (BTC/ETH/SOL/XRP/DOGE).
**Rédaction :** 2026-09-26. Les valeurs « live » citées en §7 sont horodatées ; les rapports de
`docs/rebuild/` sont figés à une date antérieure du même jour → les compteurs (n, PnL) ont
**bougé** depuis.

---

## 0. Périmètre réel de la synthèse

`docs/rebuild/` contient **sept** sous-dossiers, tous audités :

| Dossier | Rapport | Sujet |
|---|---|---|
| `strategy/` | `EDGE.md` | Edge réel mesuré (n=167, t=+1,25) |
| `risk/` | `RISK.md` | Gestion du risque pour une edge non prouvée (Monte-Carlo) |
| `execution/` | `COSTS.md` | Tick, taille min, profondeur, frais, non-transposabilité |
| `pnl/` | `REPORT.md` | Audit d'intégrité comptable |
| `recap/` | `REPORT.md` | Audit du recap Telegram |
| `code/` | `REPORT.md` | Audit temps réel (`realtime-service-v2.ts`) **et** DipArb |
| `monitoring/` | `MONITORING.md` | Outil de surveillance statistique honnête (`tools/edge_monitor.py`) |

Les tests de non-régression des bugs corrigés vivent dans **`tests/`** (racine du dépôt) :
`pnl-resolution.test.ts`, `recap-dedup.test.ts`, `prob-normalization.test.ts`, `bet-scaling.test.ts`,
`round-format.test.ts`, `harness.ts`.

> **Note d'exhaustivité :** les dossiers `diparb/`, `tests/` et `realtime/` **n'existent pas** sous
> `docs/rebuild/` (vérifié par `find docs/rebuild -type d`) ; en revanche `tests/` existe à la
> **racine** du dépôt. Les sujets « temps réel » et « dip-arb » sont **traités dans
> `code/REPORT.md`**, qui constitue l'audit agrégé de ces deux services.

Rapports connexes hors `rebuild/` utilisés ici : `docs/STRATEGY-REVIEW.md` (revue 2026-09-25),
`docs/EDGE-VALIDATION.md` (1 411 décisions), `docs/CHANGES-APPLIED.md` (correctifs C2…C9).

---

## 1. Verdict global (une phrase)

> **Aucun edge prouvé ; en exécution réelle le bot ne pourrait ni passer ses ordres utiles ni
> conserver son PnL paper. Le sizing actuel est prudent, mais rien ne justifie de l'augmenter.**

Détail, chiffre par chiffre, ci-dessous.

---

## 2. Edge — NON PROUVÉ statistiquement 📌

Sources : [`strategy/EDGE.md`](strategy/EDGE.md), [`risk/RISK.md`](risk/RISK.md),
[`recap/REPORT.md`](recap/REPORT.md), `docs/EDGE-VALIDATION.md`.

| Affirmation | Chiffre | Source |
|---|---|---|
| PnL moyen / trade (échantillon élargi) | **+0,0696 €** | `EDGE.md` §0, §(c) |
| t-statistique du PnL total | **t = +1,25** (n=167) | `EDGE.md` §(c) |
| IC95 du PnL total | **[−6,59 € ; +29,84 €]** — contient 0 | `EDGE.md` §0, §(c) |
| n requis pour \|t\|>2 | **≈ 427 trades** (mesuré : 167) | `EDGE.md` §0, §(c) |
| Seuil corrigé (10 tests) | **Bonferroni ≈ \|t\|>2,81** | `EDGE.md` §(d) |
| Coin le plus fort | **BTC t=+2,15**, mais **37 %** de chance de faux positif par hasard (5 coins + 5 tranches) | `EDGE.md` §(a), extra_checks §3 |
| Meilleure tranche de prix | toutes NON significatives ; tranche 0,65–0,70 = **break-even** (edge +0,3 pp, t=+0,05) | `EDGE.md` §(b), §(d) |
| Split de régime | AVANT correctif : +0,023 €/trade (t=+0,34) · APRÈS : +0,150 €/trade (t=+1,61, encore < 2) | `EDGE.md` extra_checks §2 |
| Vue alternative (1 411 décisions) | EV point central **−0,025 €/trade**, t=−1,27 ; WR réel **63,22 %** < break-even **64,88 %** | `EDGE-VALIDATION.md` §0, §5 |
| t affiché par le recap | **t = +0,84** (n=127) → « non significatif (bruit) » | `recap/REPORT.md` §3 |
| Monitoring `history.json` (instantané 23:26Z) | **n=66, t=+1,747**, IC95 total **[−1,23 €; +21,52 €]**, p bilatérale **0,081** → « NON SIGNIFICATIF (BRUIT) » | `monitoring/MONITORING.md` §2 |

> **Trois mesures honnêtes, une seule conclusion.** `EDGE.md` (n=167, t=+1,25, re-résolution
> indépendante), `recap` (n=127, t=+0,84) et `MONITORING.md` (n=66, t=+1,75) **convergent toutes
> vers « non significatif »**. Le t plus élevé du monitoring reflète un échantillon plus récent
> (régime post-correctif), pas un edge prouvé (`MONITORING.md` §5.4).

**Lectures non négociables :**
- Un **t de 1,25** (ou 1,61) est **sous 1,96** → rien ne distingue le bot d'un tirage chanceux.
- **Toute hausse de mise aujourd'hui est un pari non étayé** : `EDGE.md` §(d) recommande
  explicitement de **suspendre** toute augmentation et de re-mesurer sous ~200 trades de plus.
- Le `n_requis = 52 616` de la tranche 0,65–0,70 signifie « il faudrait une infinité de trades
  pour prouver un edge qui n'existe probablement pas » (`EDGE.md` §(c)).

---

## 3. Risque — augmenter la mise est un mauvais pari 💰

Source : [`risk/RISK.md`](risk/RISK.md) (Monte-Carlo, 20 000 trajectoires × 1 000 trades).

| Affirmation | Chiffre | Source |
|---|---|---|
| Si edge **nulle** (WR = break-even), mise 1 € | **P(PnL total < 0) = 42,1 %** après 1 000 trades ; IC P5–P95 = [−36 € ; +45 €] | `RISK.md` §2 (ligne B) |
| Mise ×5 sur edge nulle, capital 100 € | **P(ruine) = 15,6 %** (vs 0,01 % à mise ×1) | `RISK.md` §6 |
| Mise ×2 sur edge nulle | P(DD>50 %) = 53,6 % · P(ruine) = 1,3 % | `RISK.md` §6 |
| Borne de variance (règle du 1 %) | mise ≤ **1 % du capital** sous hypothèse edge nulle | `RISK.md` §3, §5.1 |
| Sizing actuel | `kellyCeil=0.05` → mise bornée, **raisonnable/prudent** ; ne pas lever le plafond | `RISK.md` §4 |
| Critère de re-jugement | ne rien changer avant **n ≥ 200** ; re-juger sérieusement à **n = 400–850** | `RISK.md` §5.4 |

> **Le coût de l'erreur est asymétrique :** se tromper en restant petit coûte une opportunité ;
> se tromper en jouant gros détruit le capital (`RISK.md` §6). Le sizing doit être dimensionné
> pour **survivre à l'hypothèse où l'edge est nulle** — c'est ce que fait `kellyCeil=0.05`.

---

## 4. Exécution réelle — le bot ne pourrait pas passer ses ordres 🚫

Source : [`execution/COSTS.md`](execution/COSTS.md) (mesures lecture seule, 59 snapshots).

| Affirmation | Chiffre | Source |
|---|---|---|
| Tick réel | **0,01** (99 % des lectures), pas 0,001 | `COSTS.md` §1.1, §6 |
| Taille **minimum live** | **5 USDC notionnels** | `COSTS.md` §0, §1.1 |
| Mise paper (base 1 €) | **0,65–1,30 €** → **4 à 8× sous le minimum live** | `COSTS.md` §0, §6 |
| Profondeur au meilleur ask (médiane) | **~12–18 $** selon le coin (p10 ≈ 3 $) | `COSTS.md` §2.2, §6 |
| Profondeur au top < 5 $ | **21,3 %** de tous les côtés · **17,7 %** en zone bot | `COSTS.md` §0, §6 |
| Coût d'entrée total (zone bot) | **3,2–3,8 % de la mise** (~2,5–2,9 % frais + 0,7–0,9 % demi-spread) | `COSTS.md` §4.1 |
| WR break-even réel @p=0,6488 | **66,48 %** (paper 64,88 %) → **+1,60 pt** ; @100 € : **68,92 %** (**+4,04 pt**) | `COSTS.md` §4.1, §6 |
| **Part du PnL paper qui survivrait au réel** | **≈ 0 %** (paper déjà EV −0,0256 €/trade ; réel ≈ −0,050 €/trade) | `COSTS.md` §5, §6 |
| Le bot regarde-t-il la profondeur ? | **Jamais** — fixe son prix sur `…ask` sans contrôler `askDepth` | `COSTS.md` §0, §6 |

> **Cause racine :** sur ces carnets 5 min, le premier ask ne contient souvent que **5–25 parts
> (~3–15 $)**, et le côté favori acheté par le bot est souvent **le côté mince**. Le prix du bot
> n'est réaliste que pour **quelques euros**, jamais pour le minimum live ni pour 100 €.

---

## 5. PnL & comptabilité — fiabilisé ✅, avec une réserve

Source : [`pnl/REPORT.md`](pnl/REPORT.md).

| Affirmation | Résultat | Source |
|---|---|---|
| Résolution **par marché** (filtre corrigé) | ✅ PASS — 5 cids → 5 slugs distincts (avant : 1 seul, `xi-jinping-out-before-2027`) | `pnl/REPORT.md` (a) |
| Double comptage | ✅ PASS — **0** clé dupliquée | `pnl/REPORT.md` (b) |
| `realized:0` = PENDING | ✅ PASS — jamais compté win/loss | `pnl/REPORT.md` (c) |
| Re-résolution indépendante | ✅ **0 incohérence** sur 127 entrées | `pnl/REPORT.md` (d) |
| Total reconstructible du ledger | ⚠️ **ÉCHEC INITIAL → CORRIGÉ** : 64 entrées stockaient `true` ; `sum(ledger)=−2,0737` vs `pnl=+6,7877` (écart = 63 entrées booléennes) | `pnl/REPORT.md` (b), (e) |
| Après correctif | `sum(ledger)=6,7877 = pnl` → **total auditable** ; ledger = **source de vérité** | `pnl/REPORT.md` (e) |

**Risques résiduels** (`pnl/REPORT.md` §« Risques résiduels ») :
1. Clé d'identité `conditionId|side|price` fragile si le prix variait d'un log à l'autre.
2. Les sorties TP/SL ne sont pas re-dérivables par API → dépend du montant stocké au ledger.
3. `window_pnl` ≠ `pnl` (fenêtre vs cumulé) → **ne jamais sommer**.

---

## 6. Recap Telegram, monitoring & code — corrigés, avec réserves

Sources : [`recap/REPORT.md`](recap/REPORT.md), [`code/REPORT.md`](code/REPORT.md),
[`monitoring/MONITORING.md`](monitoring/MONITORING.md).

**Recap** (`recap/REPORT.md` §1–§4) :
- Prix « à battre » et « live » désormais **distincts** (précision adaptative) ; epoch brut
  remplacé par fenêtre lisible (`22:50→22:55`) ; libellé « cycle 5 min ».
- **Ligne `📐 Edge` ajoutée** : affiche t-stat + verdict « significatif / non significatif (bruit) »
  → **l'outil refuse de présenter un PnL positif comme une preuve**.
- Clé de dédup rendue **stable** (marqueur `VOL` excluant prix/probas) — prouvé sur 2 appels.
- ⚠️ **Limite connue** : l'échantillon de la t-stat ne grandit plus quand les trades sortent de
  `history.json` (correctif de stockage à prévoir).

**Code / temps réel / DipArb** (`code/REPORT.md` §Synthèse) :

| Sujet | Verdict |
|---|---|
| WS `clob_market` déprécié | **Consommé** (DipArb + Arbitrage) → **non coupé**, commentaire d'audit ajouté |
| Compteurs DipArb figés à 0 | Cause = cycle des rounds déclenché uniquement par le WS mort → **corrigé** (pilotage REST, clôture fin de marché, bon libellé) |
| Code mort `analyzeMarket` | **Pas supprimable en sécurité** → aucun patch |
| Hygiène de log | Dump ethers 7,3 Ko → **helper `errStr` borné à 240 car.** sur 10 sites |
| Vérifs | `npx tsc --noEmit` → exit 0 ; smoke test DipArb → ALL PASS |

**Monitoring** (`monitoring/MONITORING.md`) :
- Outil **lecture seule** `tools/edge_monitor.py` (Python stdlib) qui lit `history.json`,
  **exclut les trades `realized==0`**, et sort un verdict explicite + seuil de Bonferroni.
- **Kill-switch chiffré** : arrêt si `t ≤ −2`, drawdown `≥ 25 mises`, ou **8 pertes consécutives**
  (justifié par `RISK.md` §5.2). Code de sortie `2` avec `--exit-on-kill` (prêt pour l'alerting).
- Sortie brute non retouchée : `monitoring/edge_monitor_output.txt`.

---

## 7. Bugs déjà corrigés (liste noire → liste de correctifs)

| Bug | Correctif | Source |
|---|---|---|
| **Résolveur PnL faux** (`markets?condition_id=` ignorait son filtre → toujours `xi-jinping-out-before-2027` ; écart mesuré **21,69 €** ; WR affiché 44,4 % vs réel 68,3 %) | Passage à `events?slug=<coin>-updown-5m-<slot>` + garde-fou de slug | `STRATEGY-REVIEW.md` §1.2 · `pnl/REPORT.md` (a) |
| **Registre PnL stockant `true`** (64 entrées) | Stocke le **montant** ; ledger = source de vérité | `pnl/REPORT.md` (e) |
| **RPC mort** (`polygon-rpc.com` → `API key disabled`) | Endpoint fiable (`1rpc.io/matic`) | commit `d3780ca` |
| **WS `clob_market` déprécié** (400, 128–274×/h, aucun message) | Non coupé (consommateurs réels) ; DipArb re-piloté par REST | `code/REPORT.md` points 1–2 |
| **Cooldown éternel** bloquant des coins (résultats vieux de 7–25 h) | Bornage par âge (`LEARN_COOLDOWN_AGE_H`) | code `bot-with-dashboard.ts` ~l.410–424 |
| **Probabilités UP/DOWN ≠ 100 %** (somme des `ask` bruts ≈ 1 + spread → recap à **103 %**, ex. 0,56 + 0,47) | Chaque côté divisé par `_totImp = (yes + no) \|\| 1` → somme exactement 100 % ; protégé contre 0/0 | `tests/prob-normalization.test.ts` (décrit le bug et le correctif dans `bot-with-dashboard.ts`) |
| **Clé de dédup du recap instable** | Marqueur `VOL` | `recap/REPORT.md` §4 |
| **`history.json` saturé de HOLD** (298/300 → fenêtre ~4 h) | HOLD non écrits + purge (38 entrées, 0 HOLD) | `CHANGES-APPLIED.md` §4 |
| **Fenêtre apprise écrasait `.env`** (`P_STRONG_MAX` sans effet) | Fenêtre bornée `[P_STRONG_MIN ; P_STRONG_MAX]` | `CHANGES-APPLIED.md` §5 |
| **Dump ethers 7,3 Ko/ligne** | `errStr()` borné à 240 car. | `code/REPORT.md` point 4 |

---

## 8. Ce qui reste OUVERT

- **Preuve d'edge** : manque **≈ 260 trades** (167 mesurés / 427 requis) — `EDGE.md` §0.
- **Transposabilité au réel** : ≈ **0 %** du PnL paper ne survit ; minimum live 5 $ non couvert
  en zone bot dans **17,7 %** des cas — `COSTS.md` §0, §6.
- **Paramètres provisoires** : `EDGE_FILTER_ENABLED=false` et `kellyCeil=0.05` à ré-évaluer à
  `n ≥ 200` et `realized` fiables — `CHANGES-APPLIED.md` §7.
- **WS `clob_market`** à retirer proprement après migration DipArb/Arbitrage vers REST — `code/REPORT.md`.
- **Import orphelin** `analyzeMarket` dans `bot-with-dashboard.ts` — `code/REPORT.md` point 3.
- **Échantillon t-stat du recap** ne grandit plus hors fenêtre — `recap/REPORT.md` §6.
- **Clé d'identité** `conditionId|side|price` fragile — `pnl/REPORT.md` risques résiduels.
- **Rapports restants cités par la commande mais absents** : `diparb/`, `monitoring/`, `tests/`,
  `realtime/` (couverts par `code/REPORT.md`).

---

## 9. Comment ne pas se mentir à soi-même 🪞

**Trois chiffres à surveiller — et à ne jamais présenter l'un sans les autres.**

### 1️⃣ Le **t-statistique** du PnL total (pas le PnL brut)
- **Seuil** : \|t\| ≥ 1,96 (naïf) — **≥ 2,81** si l'on teste plusieurs sous-groupes (Bonferroni, 10 tests).
- **Actuel** : **+1,25** (n=167, `EDGE.md`) · **+0,84** au recap (n=127, `recap/REPORT.md`) ·
  **+1,75** au monitoring (n=66, `monitoring/MONITORING.md`).
- **Règle** : tant que \|t\| < 1,96, **un PnL positif est du bruit**. Ne jamais lire `pnl.json`
  seul.

### 2️⃣ Le **nombre de trades résolus `n`**
- **Besoin** : **≈ 427** pour trancher au bruit mesuré ; **200** est le minimum pour re-juger sérieusement.
- **Actuel** : **167** (au moment de `EDGE.md`) ; `cumulative.json` comptait **129** résolus au 2026-09-26T23:22 (§10).
- **Règle** : ne **rien** décider (surtout pas une hausse de mise) avant `n ≥ 200` **et** `t ≥ 2`.

### 3️⃣ La **marge WR observée − break-even** (= prix d'entrée moyen)
- **Break-even d'une tranche = son prix d'entrée** : `WR_break-even = p` (`EDGE.md` §« Modèle de PnL »).
- **Actuel** : WR réel **63,22 %** vs prix moyen payé **64,88 %** → **marge −1,67 pt** (`EDGE-VALIDATION.md` §0).
  Au recap : WR **68,5 %**, prix payés ~0,62–0,65 → marge ≈ +4 pt, mais **non significative**.
- **Règle** : si `WR ≤ prix payé`, l'espérance est **négative** quel que soit le PnL affiché. C'est
  le seul levier réel du bot (le stop-loss est inerte sur un binaire).

> **Le réflexe à s'interdire** : lire `pnl.json` (+13,19 au 2026-09-26T23:22) et en conclure
> « ça marche ». Un PnL cumulé **positif** est **compatible avec une edge nulle** (`RISK.md` §2 :
> 42 % des trajectoires finissent négatives, mais la médiane reste ≈ +5 €). Le PnL affiché est un
> **résultat**, pas une **preuve**.

---

## 10. Vérifications live (commandes exécutées le 2026-09-26 ~23:25 UTC)

```text
$ pm2 describe polymarket-paperbot
  status: online · restarts: 11 · uptime: 16m · created: 2026-09-26T23:09:37Z
  script: /root/clawd/Polymarket-bot/bot-with-dashboard.ts · interpreter: node_modules/.bin/tsx

$ cat ~/.polymarket/pnl.json
  {"trades": 129, "wins": 89, "losses": 40, "win_rate": 69.0, "pnl": 13.19,
   "pending": 2, "window_pnl": 15.26, "cumulative": true}

$ cumulative.json → pnl = 13.1855 · resolved = 129 · audit_ledger.fixed_at = 2026-09-26T22:53:18

$ find docs/rebuild -maxdepth 1 -type d
  docs/rebuild/{code,execution,pnl,recap,risk,strategy}   (ni diparb, ni monitoring, ni tests, ni realtime)
```

> Ces chiffres **dérivent** (le bot tourne) : les rapports `docs/rebuild/` figeaient un `pnl`
> plus bas (~6,79 €, 127 trades) le même jour. **Comparer des `n` différents est un piège** :
> ne jamais comparer un PnL de 129 trades avec un t calculé sur 167.

---

## 11. Index des sources

- [`strategy/EDGE.md`](strategy/EDGE.md) — edge mesuré (167 trades, t=+1,25, n_requis≈427).
- [`risk/RISK.md`](risk/RISK.md) — Monte-Carlo (P(négatif)=42 % sous edge nulle, ruine ×5=15,6 %).
- [`execution/COSTS.md`](execution/COSTS.md) — tick 0,01, min 5 $, profondeur ~12 $, survivance ≈0 %.
- [`pnl/REPORT.md`](pnl/REPORT.md) — intégrité comptable (bug `true` corrigé).
- [`recap/REPORT.md`](recap/REPORT.md) — recap Telegram (edge line, dédup).
- [`code/REPORT.md`](code/REPORT.md) — temps réel + DipArb.
- [`monitoring/MONITORING.md`](monitoring/MONITORING.md) — surveillance statistique honnête (t=+1,747, kill-switch).
- `tests/` — tests de non-régression des bugs corrigés (racine du dépôt).
- `docs/STRATEGY-REVIEW.md`, `docs/EDGE-VALIDATION.md`, `docs/CHANGES-APPLIED.md` — contextes complémentaires.
