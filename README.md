# Polymarket-paperbot — bot PAPER « Up / Down 5 min » (documentation de référence)

> **Ce document décrit le bot qui tourne réellement sur cette machine** :
> `polymarket-paperbot` sous PM2, en **PAPER TRADING** (`DRY_RUN=true`, aucun ordre réel),
> stratégie **100 % déterministe** (aucun appel LLM), 5 coins (BTC / ETH / SOL / XRP / DOGE).
> Il remplace l'ancien README générique du dépôt amont (v3.1).

---

## ⚠️ Statut réel — à lire avant tout le reste

**L'edge n'est pas prouvé.** La stratégie actuelle (juste valeur, §5) est mesurée en continu :
le bilan Telegram dit si le modèle prédit mieux que les prix Polymarket (« Modèle vs carnet ») et
où en sont les critères à remplir avant d'envisager de l'argent réel (« Avant le réel » :
⏳ / ✅ / ❌). Le rapport `scripts/analysis/fv-report.ts` donne le détail. Tant que ces
mesures ne sont pas favorables, **aucune hausse de mise ni passage en réel n'est justifié**.

> L'**ancienne** règle « favori dans [0,58 ; 0,65] », retirée, n'avait pas d'edge : 167 trades,
> PnL moyen +0,07 € par trade, t = +1,25, IC 95 % du PnL total [−6,59 € ; +29,84 €] (contient
> zéro). Détail : [`docs/rebuild/strategy/EDGE.md`](docs/rebuild/strategy/EDGE.md).

---

## Mise en route (version juste valeur)

Sur le serveur, dans le dossier du bot :

```bash
git fetch origin && git checkout feat/fair-value-strategy && git pull
npm install
npm run check                              # types + tests (sans réseau) : doit finir sans échec
npm run doctor                             # diagnostic : capital, .env, registre, réseau, horloge, Telegram (❌ = à corriger)
# (facultatif) npm run demo → le vrai bot sur un marché SIMULÉ, hors ligne, dashboard sur :3002 (résultats fictifs)
(cd dashboard && npm install && npm run build)   # interface web du dashboard (à refaire après chaque mise à jour)
# .env : partir de .env.example (FV_*, TELEGRAM_*, DASHBOARD_*), garder DRY_RUN=true
npx tsx scripts/telegram/check.ts          # doit afficher « ✅ … Message de test envoyé »
pm2 delete polymarket-paperbot; pm2 start ecosystem.config.cjs && pm2 logs polymarket-paperbot --lines 50
# (delete + start : un simple restart ne relit pas ecosystem.config.cjs, ex. kill_timeout)
```

Recommandé une fois pour toutes (les logs PM2 grossissent sans fin sinon) :

```bash
pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 50M && pm2 set pm2-logrotate:retain 7
```

Puis :
0. **Vérifier le `.env`** : `PAPER_CAPITAL=250` (sous ~100 $, aucune mise n'atteint le minimum
   Polymarket de 1 $ → aucun pari) et `DIPARB_ENABLED=false` (l'ancien `.env.example` l'activait).
1. **Désactiver l'ancien recap Hermes** (`paperbot-recap-telegram`) : il décrit l'ancienne règle.
2. Vérifier dans les logs : `Flux spot temps réel connecté`, `Telegram connecté`, puis des
   lignes `HOLD : edge … < 4.0pt` (le bot évalue, et s'abstient tant que le carnet est juste).
3. Après 2–3 jours : `npx tsx scripts/analysis/fv-report.ts --days 3`. Si le modèle ne bat
   pas le carnet (Brier), la stratégie ne gagnera pas, quel que soit le réglage.
4. Ne **jamais** passer en LIVE avant : rapport favorable sur les deux moitiés, ≥ 200 trades
   réglés avec t ≥ 2, et un capital permettant des mises ≥ 5 $ (minimum Polymarket).

---

## 1. Ce que fait le bot

- **Marchés** : les marchés binaires **« Up or Down 5 minutes »** de Polymarket (résolution
  toutes les 5 min sur le prix crypto). Le bot lit le carnet d'ordres CLOB (côté `YES`/`NO`).
- **Décision** : 100 % **déterministe**, par **juste valeur** (`src/services/fair-value.ts`) :
  P(Up) est calculée depuis le spot, le strike (ouverture du round), la volatilité réalisée et
  le temps restant ; le bot n'achète un côté que si cette probabilité dépasse son **coût réel**
  (VWAP du carnet + frais taker) d'au moins `FV_MIN_EDGE`. Sinon → **HOLD** (aucune mise).
  L'ancienne règle « favori dans [0,58 ; 0,65] » a été retirée : mesurée sans edge (§5).
- **Mode** : **PAPER** (`DRY_RUN=true`). Aucune transaction ni aucun ordre ; chaque pari est
  simulé sur le vrai carnet (latence, frais, profondeur) et réglé sur le vrai résultat.
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
| `BET_STAKE` | **Plus lue.** La mise est calculée par `computeStake` (`src/services/stake-sizing.ts`) à partir de `PAPER_CAPITAL`, de l'edge du modèle et de l'état de risque (§5). |

**Accès réseau / secrets — [REDACTED]**

| Variable | Rôle |
|---|---|
| `POLYMARKET_PRIVATE_KEY` | Clé du wallet Polymarket (Polygon). **Facultative en DRY_RUN** (absente ou factice → clé éphémère sans fonds, lecture seule) ; obligatoire et valide en réel. Valeur : `[REDACTED]`. |
| `POLYGON_RPC_URL` | Endpoint RPC Polygon. Valeur : `[REDACTED]`. |
| `OPENCODE_GO_API_KEY` | Clé du provider LLM (opencode-go/zen). Valeur : `[REDACTED]`. |

**Module LLM (désactivé en pratique)**

`DEEPSEEK_ANALYZER_ENABLED`, `DEEPSEEK_MODEL`, `DEEPSEEK_API_URL`, `DEEPSEEK_MAX_CALLS_PER_DAY`,
`DEEPSEEK_MAX_TOKENS`, `DEEPSEEK_MIN_TOKENS`, `DEEPSEEK_MIN_CONF`, `DEEPSEEK_TIMEOUT_MS`.

**Stratégie juste valeur (`FV_*`, toutes optionnelles)**

| Variable | Défaut | Rôle |
|---|---|---|
| `FV_MIN_EDGE` | `0.04` | Edge minimal exigé (probabilité modèle − coût réel par part), **après frais**. |
| `FV_MIN_PROB` | `0.60` | Probabilité modèle minimale du côté acheté : ne parie que sur le côté probable → **win rate attendu ≥ 60 %** (au prix de quelques paris +EV sur l'outsider). |
| `FV_EXIT_EDGE` | = `FV_MIN_EDGE` | Vente anticipée si `bid − frais` dépasse `p_modèle` d'au moins cette marge. |
| `FV_MIN_TAU_SEC` / `FV_MAX_TAU_SEC` | `45` / `270` | Fenêtre de temps restant où l'on peut entrer (en toute fin de round, latence et écart d'oracle dominent). |
| `FV_MIN_ASK` / `FV_MAX_ASK` | `0.08` / `0.92` | Bornes d'ask achetable (au-delà, gain minuscule et erreur de modèle dominante). |
| `FV_TAKER_FEE_RATE` | `0.07` | Taux officiel `crypto_fees_v2` : frais = parts · taux · p · (1−p) (1,75 $ pour 100 parts à 0,50 $ ; makers non facturés). |
| `FV_BASIS_BPS` | `2` | Écart de flux Binance/Coinbase vs Chainlink (bps), ajouté à l'incertitude. |
| `FV_STRIKE_NOISE_SEC` | `10` | Incertitude du strike (open de bougie 1 min ≠ point Chainlink), en secondes de variance. |
| `FV_TWAP_WINDOW_SEC` | `0` | Résolution ponctuelle (règle officielle : prix Chainlink à la fin vs au début). |
| `FV_Z_SCALE` | `1` | Calibration à un paramètre de la confiance du modèle (< 1 : moins confiant). **Ne le changer que sur la suggestion du rapport** (`fv-report.ts`, section 2b, avec intervalle de confiance). |
| `FV_BLEND_MODEL` / `FV_BLEND_MARKET` | `1` / `0` | Mélange avec le carnet : `logit(p) = a·logit(p_modèle) + b·logit(p_carnet)`. `1 / 0` = modèle seul. **Ne le changer que si le rapport le valide hors échantillon** (section 1b). Si le carnet sait déjà tout, le mélange tend vers lui et le bot cesse de parier — c'est voulu. |
| `FV_TAILS` | `normal` | Loi des rendements. `t4` est **plus** confiante pour \|z\| < 2 (pas plus prudente). |
| `FV_POLL_SEC` | `10` | Période de scrutation de fond (bornée à [5 ; 300] s). |
| `FV_MIN_ORDER_USD` | `1` | Minimum d'un achat au marché sur Polymarket : un pari papier plus petit n'est pas pris (il ne serait pas reproductible en réel). Avec le plafond de 1 %, il faut `PAPER_CAPITAL` ≥ 100 $ (250 $ recommandé). |
| `FV_FILL_DELAY_MS` | `1000` | Latence d'exécution simulée : le carnet est relu après ce délai et le pari n'est « exécuté » que si l'avantage existe encore (papier plus réaliste). |
| `FV_COINS` | les 5 | Coins tradés, ex. `BTC,ETH` (à décider avec `fv-report.ts`, section 3b). |
| `FV_SPOT_STREAM` | `true` | Prix spot temps réel par WebSocket Binance (`false` = REST seul). |
| `FV_MOVE_BPS` | `3` | Mouvement du spot (points de base) qui déclenche une évaluation immédiate du coin. |

Les anciennes variables `P_STRONG_MIN`, `P_STRONG_MAX`, `P_MIN_PRICE`, `P_TAKE_PROFIT`,
`P_STOP_LOSS`, `EDGE_FILTER_ENABLED`, `LEARN_COOLDOWN_AGE_H` ne sont **plus lues** par la
stratégie principale.

**Feature flags** : `DIPARB_ENABLED`, `SMARTMONEY_ENABLED` (désactivé par défaut).

**Dashboard (sécurité)**

| Variable | Défaut | Rôle |
|---|---|---|
| `DASHBOARD_PORT` | `3001` | Port HTTP/WebSocket. |
| `DASHBOARD_HOST` | `127.0.0.1` | Interface d'écoute. Local uniquement par défaut ; à distance, préférer un tunnel SSH (`ssh -L 3001:127.0.0.1:3001 serveur`). |
| `DASHBOARD_TOKEN` | — | Jeton exigé pour l'API et le WebSocket (`http://serveur:3001/?token=…`). **Obligatoire** si `DASHBOARD_HOST` n'est pas local (sinon le dashboard se replie sur 127.0.0.1). Sans jeton, seuls les en-têtes Host locaux sont acceptés (protection DNS rebinding). Après une mise à jour : `cd dashboard && npm run build`. |

Le dashboard **ne peut jamais faire passer en LIVE** un bot démarré en papier : il faut le
redémarrer avec `DRY_RUN=false`. `DRY_RUN` suit une règle unique dans tout le code : LIVE
**uniquement** si `DRY_RUN=false` (`0`, `no`, `off`… = papier).

---

## 3. Où sont les données

Tout vit dans **`~/.polymarket/`** (`/root/.polymarket/`) :

| Fichier | Contenu | Statut |
|---|---|---|
| `fv-ledger.json` | **Registre de la stratégie juste valeur — SOURCE DE VÉRITÉ du bot.** Un trade par round : mise, coût par part, `modelProb`, statut (`open`/`won`/`lost`/`sold`), PnL. Le bot y lit son PnL, son drawdown, sa série de pertes et ses positions ouvertes ; il résout lui-même les rounds (Gamma `events?slug=`). Écriture atomique, jamais écrasé s'il est illisible. | **Autorité (stratégie)** |
| `journal/decisions-*.jsonl(.gz)` | Toutes les évaluations (pari ou abstention), 30 jours (jours révolus compressés), pour `fv-report.ts`. | Analyse |
| `session-history.json` | Bilan de chaque session (page « History » du dashboard), écrit à l'arrêt. | Affichage |
| `fv-shadow.json` | Agrégats « modèle vs carnet » (bilan Telegram). | Mesure continue |
| `fv-guard.json` | Présent = **arrêt de sécurité actif** (perte significative). Le supprimer pour reprendre. | Garde-fou |
| `outcomes-cache.json` | Résultats des rounds déjà réglés (cache du rapport). | Cache |
| `history.json` | Fenêtre glissante des décisions/mises récentes (avec `roundId`, `side`, `price`, `realized`, `stake`…). Les HOLD ne sont **plus** écrits. | **Fenêtre** (300 max), pas un historique complet |
| `cumulative.json` | Registre PnL des scripts externes Hermes (ancienne chaîne). Contient `pnl`, `resolved` (par clé), `total_trades`, `wins`, `losses`, `audit_ledger`. | **Autorité** |
| `pnl.json` | Instantané de sortie (ce que lit le recap) : `trades`, `wins`, `losses`, `win_rate`, `pnl`, `pending`, `window_pnl`. | Dérivé du registre |
| `llm-calls.json` | Compteur d'appels LLM par jour (`calls: 0`). | — |
| `archive/AAAA-MM-JJ/` | Archives quotidiennes (`resume.json`). | — |
| `audit-*.json` | Journaux de l'audit d'intégrité comptable. | — |
| `*.bak-*` | Sauvegardes horodatées (créées avant chaque correction). | — |

> **Clé d'identité d'un trade dans le registre** : `conditionId|side|price`. C'est elle qui
> garantit l'absence de double comptage (voir [`docs/rebuild/pnl/REPORT.md`](docs/rebuild/pnl/REPORT.md)).

---

## 4. Comment lire son PnL (sans se tromper)

### 4.0 Le PnL de la stratégie actuelle (registre du bot)

```bash
npx tsx scripts/analysis/ledger.ts          # bilan + derniers trades
npx tsx scripts/analysis/fv-report.ts --days 7   # le modèle a-t-il un edge ?
```

`~/.polymarket/fv-ledger.json` est la source de vérité : le bot y résout lui-même ses
rounds. Les fichiers `pnl.json` / `cumulative.json` ci-dessous viennent des scripts Hermes
externes (ancienne chaîne) et ne pilotent plus la stratégie.

### 4.1 Le chiffre officiel (ancienne chaîne Hermes)

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

### 4.2 Telegram (intégré au bot)

Le bot envoie lui-même ses notifications (`src/services/telegram.ts`,
`src/services/telegram-messages.ts`). Configuration dans `.env` :

| Variable | Rôle |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token donné par **@BotFather** (`123456789:ABC…`). |
| `TELEGRAM_CHAT_ID` | Ton chat (nombre) ou un groupe (`-100…`). Trouvable via **@userinfobot**. |
| `TELEGRAM_ENABLED` | `false` pour couper sans retirer le token. |
| `TELEGRAM_SUMMARY_MIN` | Période du bilan (défaut 60, bornée 15–1440). Envoyé seulement s'il y a de nouveaux trades ; sinon (seule la mesure « modèle vs carnet » a avancé) au plus toutes les 6 h. |
| `TELEGRAM_TZ` | Fuseau des heures de round (défaut `Europe/Paris`). |

**Au démarrage**, la connexion est vérifiée (`getMe` + `getChat`) et le log dit exactement quoi
faire si elle échoue : token refusé → le régénérer chez @BotFather ; « chat introuvable » →
envoyer **/start** au bot (ou l'ajouter au groupe) ; bot bloqué → le débloquer. Une panne
Telegram n'arrête jamais le bot. Les envois sont en file (≥ 1,1 s d'écart, respect des 429,
4 essais réseau, repli texte brut si le HTML est refusé) et le token n'apparaît jamais dans
les logs.

**Messages envoyés :**

```
🎯 NOUVEAU PARI — BTC ⬆️ HAUSSE
Round 16:15 → 16:20 · fin dans 2 min 10 s
Prix à battre : 62 345,10 $ · actuel : 62 401,50 $ (+0,090 %)
Chance de gagner (modèle) : 78 % · prix payé : 0,661 $ par part (frais inclus)
Avantage : +11,9 pts · mise : 0,50 $
Si gagné : +0,26 $ · si perdu : −0,50 $

✅ GAGNÉ — BTC ⬆️ HAUSSE · +0,26 $
Round 16:15 → 16:20
Bilan : 12 trades · 9 ✅ / 3 ❌ (75 %) · PnL +1,84 $
```

plus un message de démarrage, un **📊 BILAN** périodique (taux de réussite réel vs attendu par
le modèle, PnL, pire baisse, fiabilité statistique, et **« modèle vs carnet »** : sur tous les
rounds observés, le modèle prédit-il mieux que les prix Polymarket ? — la condition pour gagner,
et **« Avant le réel »** : les 3 critères à remplir avant d'envisager de l'argent réel — modèle
meilleur que le carnet sur ≥ 500 rounds, gain significatif (t ≥ 2) sur ≥ 200 trades, réussite
réelle pas significativement sous la probabilité annoncée sur ≥ 100 trades ; ⏳ en attente,
✅ rempli, ❌ échoué) et des **⚠️ ALERTES** (pause de risque,
registre illisible), au plus une par motif toutes les 6 h.

> ⚠️ **Ancien recap Hermes** (`paperbot-recap-telegram` → `/root/.hermes/scripts/paperbot-recap.py`,
> hors dépôt) : il décrit encore l'ancienne règle « fenêtre [0,58–0,65] » et enverrait des
> messages contradictoires. **Désactive ce cron** une fois le Telegram intégré configuré.

---

## 5. Stratégie en clair (juste valeur, déterministe)

**Pourquoi l'ancienne règle a été retirée.** « Acheter le favori si son ask ∈ [0,58 ; 0,65] »
a été mesurée sur 1 411 décisions : le marché est **calibré** par niveau de prix (WR 63,2 % <
prix payé 64,9 %, `docs/EDGE-VALIDATION.md` §5). Une règle fondée sur le seul prix d'entrée ne
peut pas créer d'edge ; le cooldown/« fenêtre apprise » par coin réagissait à du bruit (§9 du
même rapport). L'objectif n'est **pas** le win rate (acheter des favoris à 0,95 donne 95 % de WR
et zéro gain) mais l'**espérance par trade après frais**.

En continu (évaluation sur mouvement du spot + passage de fond toutes les ~10 s), pour chaque round 5 min ouvert (au plus **une entrée par round**) :

1. **Marchés** : le round en cours de chaque coin est trouvé directement par son slug
   `<coin>-updown-5m-<slot>` (Gamma `events?slug=`), tokens Up/Down associés par libellé.
2. **Données** : strike = ouverture de la bougie 1 min Binance du slot ; σ = max(vol réalisée
   60 min, 15 min) ; spot = **flux WebSocket Binance temps réel** (repli : dernière bougie
   REST, puis binance.vision, puis Coinbase). Chaque mouvement ≥ `FV_MOVE_BPS` déclenche une
   évaluation immédiate du coin (au plus une toutes les 1,5 s). Flux absent ou figé → pas de
   mise. L'horloge du serveur est contrôlée contre les horodatages Binance (alerte si décalée).
3. **Probabilité** : `P(Up) = Φ(ln(S/K) / √(σ²·(τ + bruit_strike) + basis²))` — résolution
   ponctuelle Chainlink (« Up » si prix final ≥ prix d'ouverture). Optionnellement mélangée
   au prix du carnet (`FV_BLEND_*`, désactivé par défaut, à régler seulement sur preuve).
4. **Coût réel** d'une part = ask + frais taker `0,07·p·(1−p)`. Edge = P(côté) − coût.
   Entrée seulement si **P(côté) ≥ `FV_MIN_PROB` (0,60)**, edge ≥ `FV_MIN_EDGE`,
   τ ∈ [45 ; 270] s et ask ∈ [0,08 ; 0,92].
5. **Mise** : `computeStake` (Kelly ×0,25, probabilité du modèle **shrinkée de moitié** vers le
   prix, plafonds durs 1 % du capital/trade, 10 % d'exposition, modérateurs drawdown et
   **série de pertes réelle** lus dans `fv-ledger.json`).
6. **Exécution simulée réaliste** : la mise consomme le carnet niveau par niveau (VWAP) ; si la
   profondeur manque ou si l'edge au VWAP passe sous le seuil → pas de mise.
7. **Sortie** : on garde jusqu'à la résolution, sauf si `bid − frais > p + FV_EXIT_EDGE`
   (`p` = même probabilité qu'à l'entrée, mélange avec le carnet compris s'il est configuré)
   (le marché paie plus que la position ne vaut). Plus de TP/SL en % (vendre au bid coûte
   spread + frais, et le stop-loss était inerte sur un binaire).

La boucle vit dans `src/strategy/fair-value-runner.ts` (dépendances injectées, testée de bout
en bout sans réseau : `tests/fair-value-runner.test.ts`). La logique de décision est validée
par simulation (`tests/strategy-simulation.test.ts`) : face à un carnet juste le bot ne parie
pas ; face à un carnet en retard de 10 s il gagne, avec un win rate ≈ 69 % égal à la
probabilité annoncée (calibration). Cela valide la logique, **pas** l'existence d'un edge sur
le vrai Polymarket.

### Réponse rapide sur l'historique (backtest)

```bash
npx tsx scripts/analysis/historical-backtest.ts --days 3     # réseau requis, résultats en cache
```

Rejoue le modèle sur les rounds des derniers jours (prix Polymarket minute par minute,
bougies Binance, résolutions Gamma) : Brier modèle vs marché à τ = 240/180/120/60 s, par coin,
comparaison de 3 estimateurs de volatilité, calibration, `FV_Z_SCALE` suggéré, mélange
modèle/marché estimé et validé hors échantillon, seuils rejoués
sur des asks **reconstitués** (indicatif). ⚠️ Si le prix historique est un dernier prix
échangé, il peut être en retard et le test **surestime** l'avantage : c'est un filtre rapide
(« pas d'edge ici → inutile d'attendre »), pas une preuve. La preuve vient du journal en direct.

### Mesurer si ça marche (journal des décisions)

Chaque évaluation — pari **ou** abstention — est écrite dans
`~/.polymarket/journal/decisions-AAAA-MM-JJ.jsonl` (≤ 1 ligne / round / 10 s, 30 jours
gardés par défaut, `FV_JOURNAL_KEEP_DAYS` ; les jours révolus sont compressés en `.jsonl.gz`,
~1 Mo/jour ; `FV_JOURNAL=false` pour couper). Après quelques jours :

```bash
npx tsx scripts/analysis/fv-report.ts --days 7
```

Le rapport règle les rounds (cache `~/.polymarket/outcomes-cache.json`) et répond dans l'ordre :
1. **Le modèle prédit-il mieux que le carnet ?** (score de Brier). Si non : aucun seuil ne
   rendra la stratégie rentable.
   1b. **Le carnet sait-il quelque chose que le modèle ignore ?** Estimation du mélange
   `FV_BLEND_MODEL` / `FV_BLEND_MARKET`, ajusté sur la 1re moitié des rounds et jugé sur la 2e
   (jamais vue). N'est suggéré que s'il bat le modèle seul hors échantillon (t < −2) ; si le
   poids du modèle tombe vers 0, le rapport conclut qu'il n'y a pas d'edge.
2. **Est-il calibré ?** (« 70 % » gagne-t-il ~70 % du temps ?)
3. **Quels seuils (`FV_MIN_EDGE` × `FV_MIN_PROB`) auraient rapporté**, avec l'EV sur chaque
   moitié de l'échantillon : ne retenir qu'un réglage positif sur les deux moitiés.

C'est des milliers de rounds par jour, au lieu de ~1 trade par heure.

`history.json` enregistre aussi pour chaque trade `modelProb`, `edge`, `tauSec`, `spot`, `strike`,
`sigma1m`, `ask` et `feePerShare` ; `price` y est le **coût réel par part, frais inclus**, donc
le PnL résolu inclut les frais. C'est ce qui permet de **mesurer la calibration** du modèle
(`modelProb` moyen vs taux de réussite réel par tranche).

**Exécution simulée = ordre à prix limite** : à la décision, le bot fixe un prix limite qui
garantit l'edge minimal **avec l'information de cet instant** ; l'ordre « arrive » après
`FV_FILL_DELAY_MS` (1 s) et ne prend que les asks encore sous la limite (coût exact, frais
niveau par niveau). Le modèle n'est **pas** réévalué après le délai : un vrai ordre ne voit pas
le mouvement du spot pendant son trajet (le réévaluer trierait les trades a posteriori et
flatterait le papier). Même logique pour les reventes (prix plancher net fixé à la décision ;
reventes seulement à partir de 5 parts, minimum Polymarket).

**Limites honnêtes** : le modèle n'est **pas encore** validé sur données réelles. Le backtest
historique n'a qu'un prix par minute (pas de carnet, peut-être un dernier prix échangé) : il
peut écarter la stratégie, pas la prouver ; seule la mesure en direct (journal, ligne
« Modèle vs carnet » du bilan Telegram) tranche. Le strike est approché (ouverture de la bougie 1 min
Binance/Coinbase, pas le point Chainlink exact) ; la latence simulée d'1 s retire une partie des
prix fantômes, mais des bots co-localisés restent plus rapides : le papier peut encore
**surestimer** les exécutions sur ces opportunités.

---

## 6. Garde-fous (risque, performance, fiabilité)

| Garde-fou | Déclencheur | Effet |
|---|---|---|
| Mise plafonnée | toujours | ≤ 1 % du capital **actuel** (départ + PnL) par trade, ≤ 10 % exposé, Kelly ×0,25 sur une proba modèle shrinkée de moitié |
| Série de pertes | 4 / 8 pertes d'affilée (sur 6 h) | mise ÷2 / pause de 6 h + alerte |
| Drawdown | baisse ≥ 10 % / 20 % depuis le plus haut | mise ÷2 / arrêt des entrées + alerte (reprise manuelle) |
| Perte du jour / du mois | ≥ 5 % / 15 % du capital (UTC, calendaire) | plus d'entrée jusqu'à minuit / au 1er du mois |
| **Perte significative** | t ≤ −2 sur ≥ 50 trades | arrêt persistant des entrées (`~/.polymarket/fv-guard.json`), observation continue |
| Modèle sur-confiant | réussite < proba annoncée − 2 σ (n ≥ 30) | alerte |
| Chien de garde | boucle bloquée 3 min, 10 échecs, aucun marché 5 min | alerte |
| Données | spot > 3 s (flux) ou bougie > 65 s, strike absent | pas de mise |
| Horloge | décalage > 2 s / > 5 s vs Binance | alerte / plus de nouvelle entrée |
| Taille d'ordre | mise < 1 $ (minimum Polymarket) | pas de mise + alerte (capital papier trop petit) |
| Round jamais réglé | toujours non réglé 6 h après la fin | alerte (une par trade) ; nouvel essai toutes les 5 min |
| Pendant une pause | toute pause de risque ou arrêt de sécurité | plus d'entrée, mais évaluations, journal et mesure « modèle vs carnet » continuent (pas de trou dans la mesure) |

Le cooldown « santé par coin » et la fenêtre apprise de l'ancienne stratégie ont été retirés :
ils réagissaient à du bruit (`docs/EDGE-VALIDATION.md` §9).

---

## 7. Bugs déjà corrigés (et vérifiés)

| # | Bug | Correctif | Source |
|---|---|---|---|
| 1 | **Résolveur PnL faux** : endpoint `markets?condition_id=` ignorait son filtre → renvoyait toujours `xi-jinping-out-before-2027` → tous les YES perdants, tous les NO gagnants. Écart mesuré **21,69 €**. | Passage à `events?slug=<coin>-updown-5m-<slot>` + rejet si le slug ne correspond pas. Auto-test : 5 cids → 5 slugs distincts. | `docs/STRATEGY-REVIEW.md` §1.2, `docs/rebuild/pnl/REPORT.md` (a) |
| 2 | **Registre PnL stockait `true`** au lieu du montant réalisé (64 entrées) → total non reconstructible (`sum(ledger)=−2,07` vs `pnl=+6,79`). | Le ledger stocke désormais le **montant** ; il est **source de vérité** ; `pnl` recalculé par `sum(ledger)`. | `docs/rebuild/pnl/REPORT.md` (e) |
| 3 | **RPC Polygon mort** (`polygon-rpc.com` → `API key disabled`). | Remplacement par un endpoint fiable (`1rpc.io/matic`). | commit `d3780ca` (« RPC fiable ») |
| 4 | **Canal WS `clob_market` déprécié** : le serveur rejette les souscriptions (400, 128–274×/h) → `emit('orderbook')` ne se déclenche jamais. | **Non coupé** (des consommateurs réels l'écoutent) ; commentaire d'audit ajouté. Le cycle des rounds DipArb a été **re-piloté par le flux REST vivant**. | `docs/rebuild/code/REPORT.md` (points 1–2) |
| 5 | *(ancienne stratégie, code retiré)* **Cooldown éternel** bloquant des coins (résultats périmés de 7–25 h réappliqués). | Bornage par âge (`LEARN_COOLDOWN_AGE_H`). | code `bot-with-dashboard.ts` (~l.410–424) |
| 6 | *(ancienne stratégie, code retiré)* **Probabilités UP/DOWN ≠ 100 %** : les `ask` bruts sommaient ≈ 1 + spread (ex. 0,56 + 0,47 → recap à **103 %**). | Chaque côté divisé par `(yes + no) \|\| 1` → somme exactement 100 %. | `docs/rebuild/recap/REPORT.md` |
| 7 | **Clé de dédup du recap instable** : les prix live/probas changeaient la clé → le recap repartait toutes les 5 min. | Marqueur `VOL` (`\x00`) excluant les lignes volatiles de la clé ; dédup stable prouvée sur 2 appels. | `docs/rebuild/recap/REPORT.md` §4 |
| 8 | **`history.json` saturé de HOLD** (298/300 → fenêtre de ~4 h). | Les HOLD ne sont plus écrits ; purge → fenêtre couvre plusieurs jours. | `docs/CHANGES-APPLIED.md` §4 |
| 9 | *(ancienne stratégie, code retiré)* **Fenêtre apprise écrasait `.env`** : `P_STRONG_MAX` sans effet (log `[0.55 - 0.75]`). | Fenêtre apprise bornée par `[P_STRONG_MIN ; P_STRONG_MAX]`. | `docs/CHANGES-APPLIED.md` §5 |
| 10 | **Dump d'objet ethers ~7,3 Ko/ligne** dans les logs. | Helper `errStr()` borné à 240 caractères sur 10 sites. | `docs/rebuild/code/REPORT.md` (point 4) |
| 11 | **Tempête de reconnexion WebSocket** (librairie Polymarket : 4 095 tentatives en 0,5 s sur une coupure). | Reconnexion gérée avec délai 1 s → 60 s ; pong natif restauré. | `tests/realtime-reconnect.test.ts` |
| 12 | **Dashboard** : une requête malformée faisait planter le bot ; écoute sur toutes les interfaces sans auth ; passage en LIVE en un clic (confirmation inversée). | 127.0.0.1 par défaut, jeton, Origin vérifié, LIVE refusé si démarré en papier. | `tests/dashboard-server.test.ts` |
| 13 | **`DRY_RUN=0` = papier pour le bot mais écritures on-chain autorisées.** | Règle unique : LIVE seulement si `DRY_RUN=false`. | `src/clients/ctf-client.ts` |
| 14 | **Limites de perte jour/mois inertes** (compteurs jamais alimentés en papier) ; arrêts de mise définitifs et silencieux. | Calcul depuis le registre ; série de pertes sur 6 h ; alertes. | `tests/fair-value-runner.test.ts` |
| 15 | **Requêtes CLOB sans délai** (une réponse bloquée figeait la stratégie) ; démarrage impossible sans clé API en papier. | Délais 8–10 s ; démarrage tolérant en papier. | `bot-with-dashboard.ts` |

---

## 8. Ce qui reste ouvert (honnêtement)

- **L'edge de la stratégie juste valeur n'est PAS prouvé.** Il ne le sera que par la mesure en
  direct : ligne « Modèle vs carnet » et « Avant le réel » du bilan Telegram, puis
  `fv-report.ts` (Brier, calibration, seuils stables sur les deux moitiés). Si le modèle ne
  prédit pas mieux que le carnet, aucun réglage ne rendra la stratégie rentable : l'arrêter.
- **Capital papier** : avec `PAPER_CAPITAL` < 100 $, la mise plafonnée (1 %) reste sous le
  minimum Polymarket de 1 $ → aucun pari. 250 $ recommandé.
- **Papier ≠ réel** : latence simulée d'1 s et ordres limites, mais des bots co-localisés restent
  plus rapides ; la profondeur au meilleur prix est souvent faible (`docs/rebuild/execution/COSTS.md`).
  En réel, les mises doivent aussi être ≥ 5 $ pour revendre (minimum 5 parts).
- **Exécution réelle non implémentée** (volontaire) : à n'envisager qu'après les critères
  « Avant le réel » remplis et le rapport favorable sur les deux moitiés.
- *(Ancienne stratégie, retirée)* : 167 trades, t = +1,25, edge non prouvé et non transposable
  au réel (`docs/rebuild/strategy/EDGE.md`).
- **Topics WS `clob_market`** à retirer proprement une fois DipArb/Arbitrage migrés vers REST
  (`docs/rebuild/code/REPORT.md`).

---

## 9. Vérification live — ANCIENNE stratégie (instantané du 2026-09-26 ~23:25 UTC)

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
- `npm run doctor` — diagnostic d'installation ; `npm run demo` — le bot sur un marché simulé
  (hors ligne) ; `npm run check` — types et tests.