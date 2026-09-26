# Polymarket-paperbot — bot PAPER « Up / Down 5 min » (documentation de référence)

> **Ce document décrit le bot qui tourne réellement sur cette machine** :
> `polymarket-paperbot` sous PM2, en **PAPER TRADING** (`DRY_RUN=true`, aucun ordre réel),
> stratégie **100 % déterministe** (aucun appel LLM), 5 coins (BTC / ETH / SOL / XRP / DOGE).
> Il remplace l'ancien README générique du dépôt amont (v3.1).

---

## ⚠️ Statut réel — à lire avant tout le reste

**L'edge n'est pas prouvé.** Sur les données disponibles (n = 167 trades résolus re-mesurés),
le PnL moyen par trade est **+0,0696 €** avec **t = +1,25** et un intervalle de confiance à 95 %
du PnL total de **[-6,59 €; +29,84 €]** — qui **contient zéro**. Aucun coin, aucune tranche de
prix n'est significatif après correction pour comparaisons multiples (seuil de Bonferroni ≈ 2,81) ;
le t = +2,15 de BTC est exactement ce qu'un tirage au sort produits en testant 10 sous-groupes.

Détail complet et sources : [`docs/rebuild/strategy/EDGE.md`](docs/rebuild/strategy/EDGE.md) et
[`docs/rebuild/SYNTHESIS.md`](docs/rebuild/SYNTHESIS.md).

**Conséquence pratique :** toute hausse de mise serait un pari **non étayé par les données**.

---

## 1. Ce que fait le bot

- **Marchés** : les marchés binaires **« Up or Down 5 minutes »** de Polymarket (résolution
  toutes les 5 min sur le prix crypto). Le bot lit le carnet d'ordres CLOB (côté `YES`/`NO`).
- **Décision** : 100 % **déterministe**. Il ne mise que si la probabilité implicite du côté
  favori tombe dans une **fenêtre dite « sweet spot »** (bornes `.env` `P_STRONG_MIN` /
  `P_STRONG_MAX`, ~[0,58 ; 0,65]) et si le prix est ≥ `P_MIN_PRICE`. Sinon → **HOLD**
  (aucune mise).
- **Mode** : **PAPER** (`DRY_RUN=true`). Aucune transaction, aucune clé privée utilisée ;
  chaque décision gagnante/perdante est simulée et enregistrée.
- **Coins** : BTC, ETH, SOL, XRP, DOGE.
- **IA / LLM** : **désactivé** (`DEEPSEEK_ANALYZER_ENABLED=false`, module en mode `DEGRADED
  (local HOLD)`) → **zéro token consommé** (`/root/.polymarket/llm-calls.json`).
- **Smart Money / Arbitrage / Trend** : désactivés.

---

## 2. Comment il démarre

### 2.1 PM2

Le process est géré par **PM2** sous le nom d'application **`polymarket-paperbot`**,
défini dans [`ecosystem.config.cjs`](ecosystem.config.cjs) :

| Champ PM2 | Valeur |
|---|---|
| `name` | `polymarket-paperbot` |
| `script` | `bot-with-dashboard.ts` |
| `cwd` | `/root/clawd/Polymarket-bot` |
| `interpreter` | `node_modules/.bin/tsx` (exécution TypeScript directe, sans build) |
| `autorestart` | `true`, `max_restarts: 20`, `restart_delay: 5000` |
| `out_file` / `error_file` | `paperbot.log` / `paperbot.error.log` |

Commandes utiles (lecture seule) :

```bash
pm2 list | grep polymarket          # état, restarts, uptime
pm2 describe polymarket-paperbot    # détail (script, interpreter, cwd, created_at)
```

> ⚠️ **Ne pas relancer le bot à la légère** : un `pm2 restart` réinitialise le contexte
> d'apprentissage en mémoire et coupe le cycle en cours. Aucun redémarrage n'est nécessaire
> pour lire les données.

### 2.2 Lancement manuel (sans PM2)

```bash
cd /root/clawd/Polymarket-bot
npx tsx bot-with-dashboard.ts
```

### 2.3 Configuration : `.env`

Toute la configuration runtime vit dans **`.env`** (versionné **jamais** — voir `.gitignore` ;
tout `.env`, `.env.*` et `.env.bak-*` est ignoré). Le modèle documenté est
[`.env.example`](.env.example). **Aucune valeur de clé/secret n'est reproduite ici.**

Variables (nom → rôle) :

**Mode & capital**

| Variable | Rôle |
|---|---|
| `DRY_RUN` | `true` = 100 % paper (aucun ordre) · `false` = réel. **Le bot est en paper.** |
| `CAPITAL_USD` | Capital de référence (dimensionne les limites de risque). |
| `PAPER_CAPITAL` | Capital virtuel de départ pour la simulation paper. |
| `BET_STAKE` | **Mise de base paper** (défaut code : 1). La mise effective par trade = `BET_STAKE × sizeFactor` (voir §7). |

**Accès réseau / secrets — [REDACTED]**

| Variable | Rôle |
|---|---|
| `POLYMARKET_PRIVATE_KEY` | Clé du wallet Polymarket (Polygon). **Placeholder en DRY_RUN.** Valeur : `[REDACTED]`. |
| `POLYGON_RPC_URL` | Endpoint RPC Polygon. Valeur : `[REDACTED]`. |
| `OPENCODE_GO_API_KEY` | Clé du provider LLM (opencode-go/zen). Valeur : `[REDACTED]`. |

**Module LLM (désactivé en pratique)**

`DEEPSEEK_ANALYZER_ENABLED`, `DEEPSEEK_MODEL`, `DEEPSEEK_API_URL`, `DEEPSEEK_MAX_CALLS_PER_DAY`,
`DEEPSEEK_MAX_TOKENS`, `DEEPSEEK_MIN_TOKENS`, `DEEPSEEK_MIN_CONF`, `DEEPSEEK_TIMEOUT_MS`.

**Stratégie (`P_*`)**

| Variable | Rôle |
|---|---|
| `P_STRONG_MIN` | Borne **basse** de la fenêtre d'entrée (favori net minimal). |
| `P_STRONG_MAX` | Borne **haute** de la fenêtre d'entrée (au-delà, gain insuffisant → HOLD). |
| `P_MIN_PRICE` | Prix d'achat minimal (rejette les cotes extrêmes type 0,01). |
| `P_TAKE_PROFIT` | % de gain projeté déclenchant la vente paper anticipée (100 = ne pas vendre avant la résolution). |
| `P_STOP_LOSS` | Seuil de stop-loss. **Inerte sur un round binaire** (voir §7). |
| `EDGE_FILTER_ENABLED` | Filtre d'edge par coin. **Désactivé** tant que les `realized` ne sont pas fiables. |

**Feature flags** : `DIPARB_ENABLED`, `SMARTMONEY_ENABLED`.

---

## 3. Où sont les données

Tout vit dans **`~/.polymarket/`** (`/root/.polymarket/`) :

| Fichier | Contenu | Statut |
|---|---|---|
| `history.json` | Fenêtre glissante des décisions/mises récentes (avec `roundId`, `side`, `price`, `realized`, `stake`…). Les HOLD ne sont **plus** écrits. | **Fenêtre** (300 max), pas un historique complet |
| `cumulative.json` | **Registre PnL cumulé — SOURCE DE VÉRITÉ.** Contient `pnl`, `resolved` (par clé), `total_trades`, `wins`, `losses`, `audit_ledger`. | **Autorité** |
| `pnl.json` | Instantané de sortie (ce que lit le recap) : `trades`, `wins`, `losses`, `win_rate`, `pnl`, `pending`, `window_pnl`. | Dérivé du registre |
| `llm-calls.json` | Compteur d'appels LLM par jour (`calls: 0`). | — |
| `archive/AAAA-MM-JJ/` | Archives quotidiennes (`resume.json`). | — |
| `audit-*.json` | Journaux de l'audit d'intégrité comptable. | — |
| `*.bak-*` | Sauvegardes horodatées (créées avant chaque correction). | — |

> **Clé d'identité d'un trade dans le registre** : `conditionId|side|price`. C'est elle qui
> garantit l'absence de double comptage (voir [`docs/rebuild/pnl/REPORT.md`](docs/rebuild/pnl/REPORT.md)).

---

## 4. Comment lire son PnL (sans se tromper)

### 4.1 Le chiffre officiel

```bash
cat ~/.polymarket/pnl.json
```

Champs et **pièges** :

| Champ | Signification |
|---|---|
| `pnl` | **PnL cumulé réalisé** (source : le registre `cumulative.json`). **Le chiffre de référence.** |
| `trades` / `wins` / `losses` | Compteurs du **registre** (pas de la fenêtre). |
| `win_rate` | `wins / trades` en %. |
| `pending` | Trades ouverts, non encore résolus. |
| `window_pnl` | Somme de la **fenêtre courante** de `history.json`. **Périmètre différent** → **ne JAMAIS additionner à `pnl`**. |

**Règle de lecture :**
- **Un trade `realized: 0` = PENDING**, jamais compté gagnant ni perdant.
- `pnl.json` **n'est pas une seconde comptabilité** : il est recalculé à partir de
  `cumulative.json` (ledger = source de vérité depuis le correctif du 2026-09-26).
- Pour auditer : `python3 /root/.hermes/scripts/paperbot-pnl-audit.py` (auto-test a–e,
  échoue si un doublon ou un `realized:0` entre dans le ledger).

### 4.2 Le recap Telegram

Un **cron Hermes** (`paperbot-recap-telegram`, toutes les 5 min) exécute
`/root/.hermes/scripts/paperbot-recap.py`, qui envoie sur Telegram : prix live, probabilités
UP/DOWN du round, PnL réalisé, win rate et une ligne **📐 Edge** (moyenne/mise, t-stat, verdict
« significatif » / « non significatif (bruit) »).

> La ligne « Edge » affiche **volontairement** le **n** et le **t** pour empêcher de lire un
> PnL positif comme une preuve. Voir [`docs/rebuild/recap/REPORT.md`](docs/rebuild/recap/REPORT.md).

---

## 5. Stratégie en clair (déterministe)

1. À chaque round, le bot lit le meilleur ask du côté favori (`orderbook.yes.ask` / `no.ask`).
2. Il retient le côté si son prix est dans `[P_STRONG_MIN ; P_STRONG_MAX]` **et** ≥ `P_MIN_PRICE`,
   **et** hors cooldown santé du coin (voir §6).
3. **Sizing** : `f* = p − (1−p)/b`, `kelly = clamp(f*, 0, kellyCeil)`,
   `sizeFactor = clamp(1 + 2·kelly, 0.65, 2)`, plafonné à 1,2 si `n < 10`.
   Avec `kellyCeil = 0.05`, la mise effective est **bornée** (voir `RISK.md`).
4. Sinon → **HOLD**, rien n'est misé et rien n'est écrit.

**Deux points d'honnêteté du code :**
- **Le bot ne regarde jamais la profondeur** du carnet avant de miser (il fixe son prix sur
  `…ask` sans contrôler `askDepth`) → voir §8.
- **Le stop-loss est inerte** sur un round binaire tout-ou-rien : mesuré 20/20 pertes à
  −1,00 exactement, 0 perte coupée. Ce n'est pas un contrôle de risque. Le seul levier réel est
  **le prix d'entrée face à la win rate**.

---

## 6. Apprentissage & cooldown (déterministe, sans IA)

- Le bot suit par coin : win rate récent, taille de fenêtre, et un **cooldown santé** (skip si
  espérance ≤ 0).
- **Correctif anti-blocage (2026-09-26)** : un cooldown ne doit **jamais** être éternel. Une
  ancienne version réappliquait le cooldown sur des résultats vieux de 7 à 25 h → des coins
  restaient bloqués **pour toujours** (`LEARN_COOLDOWN_AGE_H`, défaut 6 h). Corrigé dans
  `bot-with-dashboard.ts` (~l.410–424).

---

## 7. Bugs déjà corrigés (et vérifiés)

| # | Bug | Correctif | Source |
|---|---|---|---|
| 1 | **Résolveur PnL faux** : endpoint `markets?condition_id=` ignorait son filtre → renvoyait toujours `xi-jinping-out-before-2027` → tous les YES perdants, tous les NO gagnants. Écart mesuré **21,69 €**. | Passage à `events?slug=<coin>-updown-5m-<slot>` + rejet si le slug ne correspond pas. Auto-test : 5 cids → 5 slugs distincts. | `docs/STRATEGY-REVIEW.md` §1.2, `docs/rebuild/pnl/REPORT.md` (a) |
| 2 | **Registre PnL stockait `true`** au lieu du montant réalisé (64 entrées) → total non reconstructible (`sum(ledger)=−2,07` vs `pnl=+6,79`). | Le ledger stocke désormais le **montant** ; il est **source de vérité** ; `pnl` recalculé par `sum(ledger)`. | `docs/rebuild/pnl/REPORT.md` (e) |
| 3 | **RPC Polygon mort** (`polygon-rpc.com` → `API key disabled`). | Remplacement par un endpoint fiable (`1rpc.io/matic`). | commit `d3780ca` (« RPC fiable ») |
| 4 | **Canal WS `clob_market` déprécié** : le serveur rejette les souscriptions (400, 128–274×/h) → `emit('orderbook')` ne se déclenche jamais. | **Non coupé** (des consommateurs réels l'écoutent) ; commentaire d'audit ajouté. Le cycle des rounds DipArb a été **re-piloté par le flux REST vivant**. | `docs/rebuild/code/REPORT.md` (points 1–2) |
| 5 | **Cooldown éternel** bloquant des coins (résultats périmés de 7–25 h réappliqués). | Bornage par âge (`LEARN_COOLDOWN_AGE_H`). | code `bot-with-dashboard.ts` (~l.410–424) |
| 6 | **Probabilités UP/DOWN ≠ 100 %** : les `ask` bruts sommaient ≈ 1 + spread (ex. 0,56 + 0,47 → recap à **103 %**). | Chaque côté divisé par `(yes + no) \|\| 1` → somme exactement 100 %. | `tests/prob-normalization.test.ts`, `docs/rebuild/recap/REPORT.md` |
| 7 | **Clé de dédup du recap instable** : les prix live/probas changeaient la clé → le recap repartait toutes les 5 min. | Marqueur `VOL` (`\x00`) excluant les lignes volatiles de la clé ; dédup stable prouvée sur 2 appels. | `docs/rebuild/recap/REPORT.md` §4 |
| 8 | **`history.json` saturé de HOLD** (298/300 → fenêtre de ~4 h). | Les HOLD ne sont plus écrits ; purge → fenêtre couvre plusieurs jours. | `docs/CHANGES-APPLIED.md` §4 |
| 9 | **Fenêtre apprise écrasait `.env`** : `P_STRONG_MAX` sans effet (log `[0.55 - 0.75]`). | Fenêtre apprise bornée par `[P_STRONG_MIN ; P_STRONG_MAX]`. | `docs/CHANGES-APPLIED.md` §5 |
| 10 | **Dump d'objet ethers ~7,3 Ko/ligne** dans les logs. | Helper `errStr()` borné à 240 caractères sur 10 sites. | `docs/rebuild/code/REPORT.md` (point 4) |

---

## 8. Ce qui reste ouvert (honnêtement)

- **L'edge reste non prouvé** : il faut **≈ 427 trades** résolus pour trancher au bruit mesuré
  (`EDGE.md`), la dernière mesure comptait 167 trades.
- **Non transposable au réel** : la mise paper historique (base 1 € → **0,65–1,30 €**/trade)
  était **4 à 8× sous le minimum live (5 USDC)** ; la profondeur au meilleur prix (~12 $ médiane)
  est insuffisante dans **17,7 %** des cas en zone de mise ; la part du PnL paper qui survivrait
  au réel est **≈ 0 %** (le paper a déjà une EV négative, le réel ≈ double la perte).
  → `docs/rebuild/execution/COSTS.md`.
- **Filtre d'edge par coin** (`EDGE_FILTER_ENABLED`) et `kellyCeil=0.05` sont **provisoires** :
  à ré-évaluer quand `n ≥ 200` et `realized` fiables (`docs/CHANGES-APPLIED.md` §7).
- **Topics WS `clob_market`** à retirer proprement une fois DipArb/Arbitrage migrés vers REST
  (`docs/rebuild/code/REPORT.md`).
- **Import orphelin** `analyzeMarket` dans `bot-with-dashboard.ts` (non supprimable en sécurité).
- **Dérive live à réconcilier** : les rapports mesurent la mise sur une base de 1 €, tandis que
  les entrées récentes de `history.json` enregistrent un champ `stake` (voir §9). La valeur de
  base**actuelle** est `BET_STAKE` dans `.env` — à lire sur place.

---

## 9. Vérification live (commandes exécutées le 2026-09-26 ~23:25 UTC)

```text
$ pm2 describe polymarket-paperbot
  status : online   ·   restarts : 11   ·   uptime : 16m   ·   created : 2026-09-26T23:09:37Z
  script : /root/clawd/Polymarket-bot/bot-with-dashboard.ts   ·   interpreter : node_modules/.bin/tsx

$ cat ~/.polymarket/pnl.json
  {"trades": 129, "wins": 89, "losses": 40, "win_rate": 69.0, "pnl": 13.19, "pending": 2,
   "window_pnl": 15.26, "cumulative": true}

$ cumulative.json
  pnl = 13.1855 · resolved = 129 · audit_ledger.fixed_at = 2026-09-26T22:53:18

$ history.json
  68 entrées (40 YES / 28 NO)   ·   4 entrées récentes portent un champ "stake"
```

> Ces chiffres **bougent** : le bot tourne et résout des rounds en continu (les rapports de
> `docs/rebuild/` ont été figés plus tôt le 2026-09-26, avec des `n` plus petits et un `pnl`
> plus bas). Le **PnL brut affiché n'est PAS une preuve d'edge** : lire §4 et
> [`docs/rebuild/SYNTHESIS.md`](docs/rebuild/SYNTHESIS.md).

---

## 10. Carte de la documentation

- [`docs/rebuild/SYNTHESIS.md`](docs/rebuild/SYNTHESIS.md) — **synthèse chiffrée de tous les
  rapports d'audit** (edge, risque, exécution, PnL, recap, code) + « comment ne pas se mentir ».
- [`docs/rebuild/strategy/EDGE.md`](docs/rebuild/strategy/EDGE.md) — mesure de l'edge (167 trades, t=+1,25).
- [`docs/rebuild/risk/RISK.md`](docs/rebuild/risk/RISK.md) — gestion du risque pour une edge non prouvée (Monte-Carlo).
- [`docs/rebuild/execution/COSTS.md`](docs/rebuild/execution/COSTS.md) — tick, taille min, profondeur, frais, non-transposabilité paper→réel.
- [`docs/rebuild/pnl/REPORT.md`](docs/rebuild/pnl/REPORT.md) — audit d'intégrité comptable.
- [`docs/rebuild/recap/REPORT.md`](docs/rebuild/recap/REPORT.md) — audit du recap Telegram.
- [`docs/rebuild/code/REPORT.md`](docs/rebuild/code/REPORT.md) — audit temps réel / DipArb.
- [`docs/rebuild/monitoring/MONITORING.md`](docs/rebuild/monitoring/MONITORING.md) — surveillance statistique honnête (`tools/edge_monitor.py`, kill-switch).
- [`docs/STRATEGY-REVIEW.md`](docs/STRATEGY-REVIEW.md) — revue de stratégie (2026-09-25).
- [`docs/EDGE-VALIDATION.md`](docs/EDGE-VALIDATION.md) — validation d'edge sur 1 411 décisions.
- [`docs/CHANGES-APPLIED.md`](docs/CHANGES-APPLIED.md) — correctifs C2/C3/C5/C6/C7/C9.
- [`.env.example`](.env.example) — modèle de configuration (sans secrets).