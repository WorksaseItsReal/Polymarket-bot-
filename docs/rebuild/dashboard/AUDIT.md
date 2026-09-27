# Audit de cohérence des chiffres affichés — Dashboard Polymarket paper bot

Date : 2026-09-27, mesures prises entre 12:37 et 12:42 UTC.
Périmètre lecture : `bot-with-dashboard.ts`, `bot-config.ts`, `src/dashboard/**`,
`dashboard/src/**`, `/root/.hermes/scripts/paperbot-pnl.py`, JSON sous `/root/.polymarket/`.
Mode lecture seule sur le code — **aucun fichier de code modifié** (voir §6).

Toutes les valeurs citées proviennent d'appels réels exécutés pendant l'audit (les sorties
brutes sont reproduites). Aucun chiffre n'est reconstitué à la main.

---

## 0. État du service au moment de l'audit

```
$ curl -s -o /tmp/root.html -w "HTTP %{http_code} size=%{size_download}\n" http://localhost:3001/
HTTP 404 size=21
{"error":"Not found"}

$ ss -ltnp | grep 3001
LISTEN 0 511 *:3001 *:* users:(("node",pid=2106954,fd=33))

$ pm2 list   (extrait)
│ 2 │ polymarket-paperbot  │ 0.4.3 │ fork │ 2106942 │ 2h │ ↺ 14 │ online │
```

⚠️ **Constat préalable** : `dashboard/dist/` **n'existe pas** (aucun build Vite). Le serveur
`src/dashboard/server.ts` sert les statiques depuis `../../dashboard/dist` puis retombe sur
`index.html` — les deux absents → `GET /` répond **404**. La page React n'est donc **pas
servie** sur le port 3001 en l'état ; ce qui est effectivement consommable est l'API JSON
(`/api/state`, `/api/config`, `/api/history`). L'audit des libellés porte donc sur **le code
source React qui constitue la page principale** (`dashboard/src/components/*`), et l'audit des
valeurs sur **l'état réellement diffusé par l'API**.

---

## 1. Toutes les valeurs affichées, leur source, leur verdict

Méthode : valeur lue sur `/api/state` (et `/api/config`, `/api/history`) → remontée au
`setter` dans le code → verdict.

Légende — **RÉELLE** : calculée depuis des données de marché/des faits · **ESTIMÉE** :
projection, gain espéré, jamais confrontée au résultat · **FICTIVE** : jamais mise à jour
après l'init, valeur par défaut, ou formule décorative.

| Valeur affichée | Valeur mesurée (12:37 UTC) | Source dans le code | Verdict |
|---|---|---|---|
| Total P&L (QuickStats, PnLPanel) | `+$12 745.74` | `state.totalPnL` via `recordTrade()` (`bot-with-dashboard.ts:334-355`), alimenté par `simulateTrade()` (`:516-527`) | **ESTIMÉE** — gain espéré crédité à la décision |
| « Today » / Daily P&L | `+$12 745.74` | `state.dailyPnL`, reset seulement dans `canTrade()` si `daysSinceReset>=1` (`:246-251`). `lastDailyReset == startTime` (10:16:53 UTC) → **jamais reseté** | **FICTIVE** — c'est le cumul total, pas un P&L du jour |
| Monthly P&L | `+$12 745.74` | `state.monthlyPnL`, reset si `>=30 j` (`:254-259`) → jamais | **FICTIVE** — égal au cumul total |
| Peak capital | `$12 487.41` | `state.peakCapital`, mis à jour dans `canTrade()` (`:263-265`) | **ESTIMÉE** — max d'une courbe elle-même estimée (et non monotone croissante) |
| Current capital | `$12 487.41` | `state.currentCapital = CAPITAL_USD + totalPnL` (`:262`), seulement appelé dans `canTrade()` (`:679,1101,1335`) | **ESTIMÉE + INCOHÉRENTE** — voir §3 : `capital affiché ≠ CAPITAL_USD + totalPnL` au même instant |
| Current drawdown | `0 %` | `(peakCapital - currentCapital)/peakCapital` (`:266`) | **FICTIVE** — vaut 0 par construction (voir §4) |
| Consecutive wins | `569` | `recordTrade()` (`:344-347`) | **FICTIVE** — compte des `profit >= 0` donc des estimations positives |
| Consecutive losses | `0` | idem | **FICTIVE** — ne peut pas s'incrémenter (aucun `profit < 0` en pratique) |
| PnL Panel « Arbitrage Profit » | `$0.00` | `state.arbProfit` — initialisé `:172`, **jamais réassigné** | **FICTIVE** (constante 0) |
| Trades executed | `569` | `state.tradesExecuted++` dans `recordTrade()` | **RÉELLE au comptage** mais **mal nommée** : compte des *décisions* + des *exécutions* simulées, pas des trades résolus (résolveur : 159) |
| Trades par stratégie | DipArb 569 · SmartMoney 0 · Arb 0 · Direct 0 | `recordTrade()` (`:349-352`) | **ESTIMÉE** (mélange décisions/exécutions) ; les 3 autres à 0 = **FICTIVES** (stratégies désactivées, `config.enabled=false`) |
| SessionSummary Wins / Losses | `569 / 0` | `estimatedWins = round(trades*0.5 + totalPnL/10)` puis clamp `[0,trades]` (`SessionSummary.tsx:13-15`) | **FICTIVE** — inventée à partir du PnL, sans aucune donnée de résultat |
| SessionSummary Win Rate | `100 %` | `wins/trades` (formule ci-dessus) | **FICTIVE** |
| QuickStats Win Rate | `61 %` | `50 + totalPnL/(2*trades)` clampé `[0,100]` (`QuickStats.tsx:23`) | **FICTIVE** — formule décorative |
| Avg / Trade | `$22.40` | `totalPnL / tradesExecuted` (`SessionSummary.tsx:10`) | **ESTIMÉE** (dénommée faussement « réalisée ») |
| USDC.e balance | `$12 795.74` | `dryRun`: `PAPER_CAPITAL + totalPnL` (`:977`), `PAPER_CAPITAL=50` | **FICTIVE** — « solde » fabriqué = 50 + cumul estimé |
| USDC balance | `$0.00` | `:999-1002`, jamais atteint en `dryRun` | **FICTIVE** (constante 0) |
| MATIC balance | `100` | `state.maticBalance = 100` en `dryRun` (`:978`) | **FICTIVE** — constante codée en dur |
| BalanceCards « Total / Capital » | `$12 795.74` | `usdc + usdcEBalance` (`BalanceCards.tsx:41`) | **FICTIVE** |
| Unrealized PnL | `$0.00` | boucle `(curPrice-entry)*size` (`:1452-1463`) | **RÉELLE par formule** mais **FICTIVE à l'affichage** : `positions: []` (sync portefeuille inopérant) → toujours 0 |
| Splits / Merges / Redeems / Swaps | `0/0/0/0` | `state.splits`… initialisés `:177-180`, jamais réassignés | **FICTIVES** (constantes 0) |
| Positions ouvertes | `[]` | `state.positions` (`:1470`) | **RÉELLE** (réellement vide) ; le P&L par position (`pos.cashPnl`, `pos.percentPnl`, `PositionsPage.tsx:99-100`) n'est **jamais renseigné** par le bot → **FICTIF ($0.00 / 0 %)** |
| Activité / signaux DipArb (prix up/down, sum, change %) | ex. up 0.88 / down 0.13 / sum 1.01 | flux SDK `dipArb` (`:870-897`) | **RÉELLE** (prix de carnet) |
| Signals count, Found, marketsScanned | 20 / 0 / 0 | `state.dipArb.signals`, `state.arbitrage.opportunitiesFound` | **RÉELLE** (0 = réellement 0, stratégie arb désactivée) |
| Runtime | `2h 25m` | `Date.now() - state.startTime` (`Header.tsx:22`) | **RÉELLE** |
| Gas / Block / Latency (NetworkStatus) | ~25-45 gwei, n° variable, 50-150 ms | `Math.random()` (`NetworkStatus.tsx:14-21`) | **FICTIVE** — chiffres aléatoires affichés comme des mesures réseau |
| Adresse wallet (Header) | `0xaF98…10de` | constante codée en dur, commentaire `// Mock wallet address` (`Header.tsx:44-45`) | **FICTIVE** |
| History (page) | sessions 0, profit 0 | `/api/history` → `session-history.json` **absent** | **FICTIVE** — page vide, aucun historique enregistré |
| Capital / risk limits (ConfigPanel) | `totalUsd 50`, daily 5 %, DD 25 %, total 40 % | `/api/config` ← `.env` | **RÉELLE** (configuration) |

---

## 2. Le point clé : `state.totalPnL` (mémoire) vs `pnl.json` (résolveur)

Mesure **simultanée** des deux sources (une seule commande, pas de décalage temporel) :

```
$ T=$(curl -s http://localhost:3001/api/state | python3 -c "import json,sys;print(json.load(sys.stdin)['totalPnL'])")
state.totalPnL (mémoire décision) = 12745.743682914375
pnl.json pnl (résolveur)          = 40.28
cumulative.json pnl               = 40.2842

ÉCART totalPnL - pnl.json         = 12705.46
RATIO totalPnL / pnl.json         = 316.4x
ÉCART en % du capital (50 USD)    = 25411%
totalPnL / capital 50             = 254.9x

$ cat /root/.polymarket/pnl.json
{"trades": 159, "wins": 111, "losses": 48, "win_rate": 69.8, "pnl": 40.28, "pending": 1, "window_pnl": 42.36, "cumulative": true}
```

**Les deux chiffres et l'écart :**

| Source | Valeur | Nature |
|---|---|---|
| `state.totalPnL` (mémoire du bot, affichée par le dashboard) | **+12 745.74 $** | gain **espéré**, crédité à la décision |
| `pnl.json` / `cumulative.json` (résolveur `paperbot-pnl.py`) | **+40.28 $** | gain **réalisé**, après résolution du round |
| **Écart** | **+12 705.46 $** (×316) | 254 fois le capital configuré (50 $) |

**Contre-épreuve décisive (re-mesure à 12:43 UTC, ~6 min plus tard)** :

```
state.totalPnL = 12923.154728436783   (↑ 12745.74 → 12923.15, +177.41)
pnl.json       = 35.28                (↓ 40.28 → 35.28, −5.00)
```

Sur le même intervalle, le chiffre **réel** du résolveur **baisse** (−5,00 $ : un round perdu a
été soldé), tandis que le chiffre affiché par le dashboard **monte encore** (+177,41 $). Un P&L
qui ne peut pas baisser n'est pas un P&L : l'écart à cet instant est de **+12 887,87 $** (×366).
C'est la démonstration directe du §2.

### Origine exacte de l'écart

1. **Le gain estimé est crédité à la décision, immédiatement et intégralement.**
   `bot-with-dashboard.ts:874-893` : à chaque signal retenu, `estProfit` est calculé comme
   `stake × (1/prix − 1)` (`:887-891`, ici `stake = BET_STAKE = 5`), puis passé à
   `simulateTrade(estProfit, 'dipArb', …)` (`:893`) qui appelle `recordTrade(profit, …)`
   (`:526`). `recordTrade` fait `state.totalPnL += profit` (`:338`) — c'est-à-dire qu'on
   empoche **le gain maximum théorique « si le bon côté gagne »**, sans attendre le résultat.
   Le libellé du log le dit lui-même : « gain est. $X **si** DOWN gagne ».
2. **La perte réelle n'est jamais débitée.**
   Le seul chemin `recordTrade` du flux DipArb réel — l'événement `execution` (`:899-925`) —
   appelle `recordTrade(0, 'dipArb')` (`:921`) : **profit 0**, jamais la perte. Seul le
   `closePosition` manuel (`:1661`) peut passer un montant négatif, mais il est inatteignable
   en `dryRun` (`:1632-1635` `return`), et `positions` est vide. Aucun chemin de résolution
   (round perdu) ne débite donc quoi que ce soit.
3. **Résultat : le compteur est un accumulateur à sens unique.** Preuve live sur 45 s :

```
12:41:13 totalPnL= 12769.6861 trades= 572 consecWins= 572
12:41:28 totalPnL= 12810.7657 trades= 576 consecWins= 576
12:41:43 totalPnL= 12854.7778 trades= 580 consecWins= 580
12:41:58 totalPnL= 12887.817  trades= 583 consecWins= 583
→ +118.13 $ en 45 s ≈ +157 $/min, 100 % de « wins », 0 perte.
```

4. **C'est un compteur de décisions, pas de trades.** `tradesExecuted` (569 → 583) compte les
   signaux, y compris les rounds non résolus ; le résolveur, lui, ne compte que les rounds
   **résolus** : 159 trades, 111 gagnés, 48 perdus (win rate réel 69,8 %).

**Conséquence de bord (à signaler)** : comme `totalPnL` ne monte jamais, les 4 couches de
risque de `canTrade()` sont **toutes inertes** : daily (`50×0.05 = 2.50 $`), monthly
(`50×0.15 = 7.50 $`), total (`50×0.40 = 20 $`) ne seront jamais atteints par un compteur
positif, et le drawdown est nul par construction (§4). `permanentlyHalted=false`,
`isPaused=false` : le bot ne s'auto-protégera **jamais** sur la base de ces chiffres.

---

## 3. Incohérence interne mesurée dans un **même** instantané

```
state.currentCapital        = 12487.410349581041
PAPER_CAPITAL + totalPnL    = 50 + 12745.743682914375 = 12795.743682914375  (= state.usdcEBalance)
écart interne               = 308.33 $
```

Le même objet `state` renvoyé par `/api/state` affiche **deux « capitaux » différents** :
`currentCapital` (recalculé uniquement dans `canTrade()`, `:262`) et `usdcEBalance`
(recalculé toutes les 30 s, `:977`). Le premier est **périmé** : il correspond au `totalPnL`
d'il y a plusieurs minutes (`12487.41 − 50 = 12437.41`). Deux champs dérivés de la même
grandeur, mis à jour par deux horloges différentes, sans source unique → contradiction
visible à l'écran.

---

## 4. Valeurs qui ne peuvent QUE monter, ou QUE descendre (signaux d'alarme)

Ce sont exactement les marqueurs d'une comptabilité qui ne mesure plus rien.

**Ne peuvent QUE monter** (monotones croissantes par construction) :

| Valeur | Preuve de monotonie |
|---|---|
| `totalPnL` | `+= profit` avec `profit >= 0` sur tous les chemins atteints — 569/569 « wins », 0 perte |
| `dailyPnL` | même flux, jamais reseté (`lastDailyReset == startTime`) |
| `monthlyPnL` | même flux, reset à 30 j jamais atteint |
| `peakCapital` | `if (currentCapital > peakCapital) peakCapital = currentCapital` (`:263`) |
| `currentCapital` | `= CAPITAL_USD + totalPnL`, donc suit la borne supérieure |
| `consecutiveWins` | incrémenté à chaque `profit >= 0` (`:346`) — 583 d'affilée |
| `tradesExecuted`, `dipArbTrades` | compteurs de signaux, jamais décrémentés |
| `usdcEBalance` | `PAPER_CAPITAL + totalPnL` (`:977`) |
| Wins « estimés » du SessionSummary | `round(trades*0.5 + totalPnL/10)` → croît avec le PnL, saturé à `trades` → **affiche 100 % de victoires dès que PnL > 5·trades** |
| QuickStats Win Rate | `50 + totalPnL/(2·trades)` → croît, saturé à 100 % |
| Avg/Trade | `totalPnL/tradesExecuted` → croît |

**Valeurs qui ne peuvent QUE descendre / rester bloquées (jamais réalimentées) :**

| Valeur | Preuve |
|---|---|
| `currentDrawdown` | `(peak − current)/peak` avec `current >= peak` toujours vrai → **0 à vie** |
| `consecutiveLosses` | jamais incrémenté (aucun `profit < 0`) → **0 à vie** |
| `usdcBalance`, `splits`, `merges`, `redeems`, `swaps`, `arbProfit`, `positions`, `unrealizedPnL` | jamais réassignés ou flux vide en `dryRun` → **constantes** (0 / 0 $ / []) — ne descendent pas, **ne bougent plus** |
| History (sessions, totalProfit, totalTrades, winRate) | `session-history.json` absent → **0 figé** |

Signal d'alarme synthétique : **« 569 wins d'affilée, 0 perte, drawdown 0 %, win rate 100 %,
+12 745 $ sur un capital de 50 $ »** — aucune de ces cinq affirmations ne peut être vraie dans
un système qui enregistre réellement des résultats. La cohérence interne de l'écran est rompue.

---

## 5. Correction concrète et chiffrée

### 5.1 Source unique de vérité par valeur

Principe : **une seule source par valeur**, et jamais une valeur dérivée d'une autre valeur
déjà estimée. Les fichiers du résolveur (`pnl.json` / `cumulative.json` / `history.json`) sont
la seule référence de résultat (ils sont déjà audités : cf. `docs/rebuild/pnl/REPORT.md`).

| Valeur | Source unique à adopter | Calcul |
|---|---|---|
| P&L réalisé | `~/.polymarket/pnl.json` | `pnl` (résolu) + `window_pnl` ; affiché sous le libellé **« Réalisé »** |
| Capital réel simulé | `PAPER_CAPITAL + pnl.json.pnl` | `50 + 40.28 = 90.28 $` (et non 12 795.74 $) |
| Trades / Wins / Losses / Win rate | `pnl.json` | `159 / 111 / 48 / 69.8 %` |
| En attente | `pnl.json.pending` | `1` |
| P&L non réalisé | exposition ouverte × (prix courant − prix d'entrée) | 0 $ ici (aucune position) — ne pas additionner au réalisé sans l'étiqueter |
| Peak / Drawdown | reconstruits sur la série `cumulative.json` (ledger daté) | boucle sur les résolutions, pas sur un compteur en RAM |
| Décisions émises (signaux) | `state.dipArb.signals` / compteur de signaux | à afficher sous **« Signaux émis »**, jamais sous « Trades » |
| Daily / Monthly P&L | ledger `cumulative.json` filtré par `ts` | somme des `realized` du jour / du mois, et **pas** un compteur avec un reset conditionnel dans `canTrade()` |
| Couches de risque | calculées sur le **réalisé** du jour/mois/cumul (`pnl.json`) | réduit les limites actuelles : daily 2.50 $, monthly 7.50 $, total 20 $ — redeviennent actives |
| Gas / Block / Latency | RPC Polygon réel **ou** suppression | ne jamais afficher `Math.random()` |
| Wallet affiché | adresse issue de la config (`POLYMARKET_ADDRESS`) ou libellé « démo » | retirer la constante en dur |
| History | `session-history.json` (à enregistrer réellement) **ou** retirer la page | 0 session ⇒ ne pas afficher « 0 $ de profit » comme un résultat |

### 5.2 Étiquetage honnête (sans changer la logique de calcul)

Renommages proposés, purement cosmétiques, à appliquer côté composants React :

| Actuel | Renommage proposé | Fichier |
|---|---|---|
| `Total P&L` / `Total P&L (Live)` | `P&L estimé (décisions)` | `QuickStats.tsx:42`, `PnLPanel.tsx:54` |
| (à ajouter) | `P&L réalisé (résolveur)` = `pnl.json.pnl` | `QuickStats`/`PnLPanel` |
| `Today` / Daily | `Session (depuis démarrage)` | `QuickStats.tsx:62`, `PnLPanel.tsx:71` |
| `USDC.e` | `USDC.e simulé (PAPER_CAPITAL + estimé)` | `BalanceCards.tsx:70` |
| `Total / Capital` | `Capital simulé (estimé)` | `BalanceCards.tsx:78` |
| `Wins` / `Losses` / `Win Rate` (Session Summary) | `Victoires est. (dérivé du P&L)` + affichage du réel `111 / 48 / 69.8 %` | `SessionSummary.tsx:37-53` |
| `Win Rate` (QuickStats) | supprimer la formule, reprendre `pnl.json.win_rate` | `QuickStats.tsx:23,77` |
| `Trades` | `Signaux émis` + `Trades résolus : 159` | `QuickStats.tsx:88` |
| `Arbitrage Profit` | `Arbitrage (stratégie désactivée)` | `PnLPanel.tsx:103` |
| `Consecutive Losses` | `Pertes consécutives (estimation)` | `PnLPanel.tsx:119` |
| Gas/Block/Latency | `(données simulées)` **ou** branchement RPC | `NetworkStatus.tsx` |
| Wallet | retirer ou suffixer `(démo)` | `Header.tsx:45` |
| `Capital / Peak / DD` (ConfigPanel) | `config (réelle)` + `capital réalisé = 90.28 $` | `ConfigPanel.tsx` |

### 5.3 Correction de fond (logique, hors de mon périmètre)

- Dans `simulateTrade()` : **ne plus** appeler `recordTrade(estProfit, …)`. Scinder en
  « décision émise » (compteur non monétaire) + « résultat réalisé » crédité uniquement à la
  résolution, depuis le ledger du résolveur. C'est la seule façon d'obtenir un P&L borné par
  la mise réelle (`BET_STAKE = 5` ⇒ gain max théorique par round ≈ `5 × (1/p − 1)`).
- Supprimer `state.totalPnL` / `dailyPnL` / `monthlyPnL` comme sources d'affichage, ou les
  étiqueter explicitement `estimated` dans `/api/state` (champ `pnlSource: "estimated"`,
  `realizedPnl` lu depuis `pnl.json`).
- Recalculer `currentCapital` **à la lecture** (dans `getState()`), pas dans `canTrade()`,
  pour supprimer l'écart interne de 308.33 $ mesuré en §3.

---

## 6. Actions réalisées / non réalisées

- **Réalisé** : ce document (`docs/rebuild/dashboard/AUDIT.md`). Aucune modification de logique.
- **Non réalisé (périmètre refusé)** : l'étiquetage du §5.2 nécessite d'éditer
  `dashboard/src/components/*.tsx`, **hors** de mon périmètre d'écriture (`src/dashboard/**`
  uniquement, qui ne contient que du serveur : `server.ts`, `types.ts`, `state-emitter.ts`,
  `session-history.ts`). Les patchs sont donc livrés **en texte** ci-dessus, prêts à appliquer.
- Aucun `pm2 restart`, aucun fichier protégé (`.env`, `bot-with-dashboard.ts`, `package.json`,
  `~/.polymarket/**`, `src/services/**`) touché.

---

## 7. Réponse en une ligne

Le dashboard affiche **+12 745,74 $** là où le P&L réellement résolu est **+40,28 $**
(écart **+12 705,46 $**, ×316) : le premier est un cumul de **gains espérés** crédités à la
décision, jamais débités d'une perte, donc un compteur à sens unique qui rend en outre inertes
les quatre protections de risque du bot. Seul `pnl.json` (résolveur) est traçable ; tout le
reste de l'écran doit soit en dériver, soit porter la mention « estimé ».
