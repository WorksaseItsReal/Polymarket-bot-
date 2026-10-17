# Polymarket paper bot — « Up or Down 5 min » (documentation de référence)

> **Ce document décrit le bot qui tourne réellement sur cette machine** : `polymarket-paperbot`
> sous PM2, en **PAPIER** (aucun ordre réel ; l'exécution réelle n'est pas implémentée),
> stratégie **100 % déterministe** (aucun LLM), 5 coins (BTC / ETH / SOL / XRP / DOGE).

---

## ⚠️ Statut réel — à lire avant tout le reste

**L'edge n'est pas prouvé.** La stratégie (juste valeur, §5) est mesurée en continu : le bilan
Telegram et le dashboard disent si le modèle prédit mieux que les prix Polymarket (« Modèle vs
carnet ») et où en sont les critères à remplir avant d'envisager de l'argent réel (« Avant le
réel » : ⏳ / ✅ / ❌). Le rapport `scripts/analysis/fv-report.ts` donne le détail. Tant que ces
mesures ne sont pas favorables, **aucune hausse de mise ni passage en réel n'est justifié**.

> Depuis le 7 août 2026, Polymarket règle ces marchés sur la **moyenne Chainlink des 60
> dernières secondes** comparée à un **prix à battre** lui-même moyenné sur les 60 s précédant
> l'ouverture (règlement TWAP). Le modèle a été refait pour cette règle le 8 octobre 2026 ; les
> mesures antérieures (modèle à règlement ponctuel) ne comptent plus et « Modèle vs carnet »
> est reparti de zéro.

> **Récolte de fin de round (papier, depuis le 11 octobre 2026)** — seule piste mesurée sur de
> **vrais carnets** Polymarket (6 590 rounds 5 min BTC/ETH, 7–18 août 2026, jeu de données
> public) : quand le favori est **bloqué à 0,99** (plafond du pas de prix) depuis ≥ 6 s, entre
> 30 et 8 s de la fin, il gagne 99,74 % du temps → **+0,72 % par pari** frais compris (t = 9,4),
> positif sur chaque moitié de la période et sous les deux règles TWAP. Petits gains, perte rare
> mais totale (une perte ≈ 110 gains) : à juger sur ses propres résultats papier (`/rapport`,
> section 1e), avec son propre garde-fou. Détails §5 bis.

> L'**ancienne** règle « favori dans [0,58 ; 0,65] », retirée, n'avait pas d'edge : 167 trades,
> PnL moyen +0,07 € par trade, t = +1,25, IC 95 % contenant zéro
> ([`docs/rebuild/strategy/EDGE.md`](docs/rebuild/strategy/EDGE.md)).

---

## Comment décider (4 étapes, dans l'ordre)

1. **Jours 1–3 — le modèle voit-il quelque chose que le marché ne voit pas ?** Ligne « Modèle
   vs carnet » (Telegram, dashboard). `t ≥ +2` : le carnet prédit mieux → **arrêter la
   stratégie**, aucun réglage ne la rendra rentable. `t ≤ −2` sur ≥ 500 rounds : continuer.
   Entre les deux : attendre.
2. **Semaine 1 — est-ce que ça paierait, frais et spread compris ?**
   `npx tsx scripts/analysis/fv-report.ts --days 7` : section 1 significative, réglage actuel
   positif sur **les deux moitiés** (section 3), calibration correcte (section 2). Un réglage
   positif sur une seule moitié est du hasard. Le rapport rejoue aussi la marge de bruit
   (`FV_NOISE_EDGE_K`) et compare notre prix à battre à celui publié par Polymarket.
3. **Avant tout argent réel** : ligne « Avant le réel » entièrement ✅ (modèle > carnet, gain
   significatif t ≥ 2 sur ≥ 200 trades, calibration), capital permettant des mises ≥ 5 $. Puis
   commencer petit : le papier reste optimiste face aux bots les plus rapides. (L'exécution
   réelle reste à écrire : ce bot ne l'a pas.)
4. **Ce qu'il ne faut pas faire** : changer les seuils jusqu'à ce qu'un résultat « marche »
   (sur-ajustement) ; juger sur le taux de réussite seul (66 % de réussite peut perdre de
   l'argent) ; cumuler `FV_Z_SCALE` et le mélange.

---

## Mise en route

Sur le serveur, dans le dossier du bot, **une commande fait tout** (code `main`, dépendances,
interface, diagnostic, relance PM2 ; ne touche ni au `.env` ni aux données) :

```bash
npm run upgrade                            # = bash scripts/update.sh (sans argument : toujours main)
```

**Le serveur ne déploie que `main`.** PM2 exécute ce qui est extrait sur le disque : une branche
de travail déployée, ou un `git checkout` manuel resté en place jusqu'à la mise à jour suivante,
fait tourner du code non validé dont les résultats papier se mêlent au registre et au journal —
on ne sait plus quel code a produit quelle mesure. Une branche se teste en local
(`npm run check`, `npm run demo`), puis se fusionne dans `main` avant d'arriver sur le serveur.
D'où : `npm run upgrade -- <branche>` est refusé (code 2, avant toute commande git), et le
doctor affiche ❌ « Code déployé » si autre chose que `main` est extrait (⚠️ si HEAD est détaché).

Vérifier ce qui tourne réellement sur le serveur :

```bash
pm2 describe polymarket-paperbot | grep -E 'exec cwd|script path'   # <dossier> exécuté par PM2
git -C <dossier> rev-parse --abbrev-ref HEAD   # doit afficher : main
git -C <dossier> log -1 --oneline              # commit déployé (à comparer avec le dernier commit de main sur GitHub)
```

**Sauvegardes du registre** : avant de relancer le bot (le nouveau code peut migrer le registre
au démarrage), `npm run upgrade` copie `fv-ledger.json`, `fv-ledger.jsonl` et `fv-guard*.json` dans
`~/.polymarket/backups/ledger-<date UTC>-<commit>/` (les 10 plus récentes sont gardées).
Sauvegarde impossible → bot non relancé (code 1). Restaurer : arrêter le bot, recopier les
fichiers du dossier choisi dans `~/.polymarket/`, relancer.

À la main, la même chose étape par étape :

```bash
git fetch origin main && git checkout main && git pull --ff-only origin main
npm install
npm run check                              # types + tests (sans réseau) : doit finir sans échec
(cd dashboard && npm install && npm run build)   # interface web (à refaire après chaque mise à jour)
npm run doctor                             # diagnostic : Node, .env, registre, réseau, horloge, Telegram (❌ = à corriger)
# (facultatif) npm run demo → le vrai bot sur un marché SIMULÉ, hors ligne, dashboard sur :3002 (résultats fictifs)
# .env : partir de .env.example (PAPER_CAPITAL, FV_*, TELEGRAM_*, DASHBOARD_*)
npx tsx scripts/telegram/check.ts          # doit afficher « ✅ … Message de test envoyé »
pm2 delete polymarket-paperbot; pm2 start ecosystem.config.cjs && pm2 logs polymarket-paperbot --lines 50
# (delete + start : un simple restart ne relit pas ecosystem.config.cjs)
```

Recommandé une fois pour toutes (les logs PM2 grossissent sans fin sinon) :

```bash
pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 50M && pm2 set pm2-logrotate:retain 7
```

Puis :
1. **Vérifier le `.env`** : `PAPER_CAPITAL=250` (sous 100 $, aucune mise n'atteint le minimum
   Polymarket de 1 $ → aucun pari). Le doctor signale les variables devenues sans effet
   (`DIPARB_ENABLED`, `DEEPSEEK_*`, `POLYMARKET_PRIVATE_KEY`…) : les retirer.
2. **Désactiver l'ancien recap Hermes** (`paperbot-recap-telegram`) s'il tourne encore : il
   lisait des fichiers (`history.json`, `pnl.json`) que le bot n'écrit plus.
3. Vérifier dans les logs : `Flux spot temps réel connecté`, `Telegram connecté`, puis des
   lignes `HOLD : edge … requis` (le bot évalue, et s'abstient tant que le carnet est juste).
4. Sur Telegram : `/backtest` tout de suite (le modèle rejoué sur les rounds passés), puis
   `/rapport` après 2–3 jours (verdict sur le journal en direct). Même chose en SSH :
   `npx tsx scripts/analysis/fv-report.ts --days 3`.

---

## 1. Ce que fait le bot

- **Marchés** : les marchés binaires **« Up or Down 5 minutes »** de Polymarket, trouvés par
  leur slug `<coin>-updown-5m-<slot>` (Gamma). Règlement : moyenne Chainlink des 60 s finales ≥
  prix à battre (moyenne des 60 s précédant l'ouverture) → « Up ».
- **Décision** : par **juste valeur** (`src/services/fair-value.ts`) : P(Up) calculée depuis le
  spot, le prix à battre estimé, la volatilité réalisée et le temps restant ; achat d'un côté
  seulement si cette probabilité dépasse son **coût réel** (VWAP du carnet + frais taker) d'au
  moins `FV_MIN_EDGE` **plus une marge égale à `FV_NOISE_EDGE_K` fois notre propre bruit** (le
  carnet connaît le prix à battre exact, nous l'estimons). Sinon → **HOLD**.
- **Récolte de fin de round** (`src/strategy/late-harvest.ts`, §5 bis) : favori bloqué à 0,99
  depuis ≥ 6 s entre 30 et 8 s de la fin → achat papier au vrai carnet (latence, limite 0,995).
  Statistiques, série de pertes et garde-fou séparés de la juste valeur ; pas de message Telegram
  par gain (bilan), chaque perte annoncée.
- **Mode** : **PAPIER**. Chaque pari est simulé sur le vrai carnet (latence, prix limite, VWAP,
  frais, profondeur) et réglé sur le vrai résultat. `DRY_RUN=false` est refusé au démarrage.
- **Mesure** : chaque évaluation (pari ou abstention) est journalisée, et le modèle est comparé
  en continu aux prix Polymarket sur tous les rounds observés (score de Brier, t groupé).

---

## 2. Architecture (après reconstruction du 9 octobre 2026)

```
bot-with-dashboard.ts          point d'entrée (14 lignes ; nom conservé pour PM2)
src/bot/
  config.ts                    TOUTES les variables d'environnement, lues une fois, bornes, défauts,
                               avertissements nommés ; partagé avec le doctor
  risk-gate.ts                 porte de risque pure (jour / mois / baisse / totale), depuis le registre
  app.ts                       câblage : dashboard, Telegram, flux spot, découverte, runner, journal,
                               mesure, chiens de garde, plantages, arrêt propre — aucune règle de trading
src/strategy/
  fair-value-runner.ts         la boucle (dépendances injectées, testée sans réseau)
  shadow-tracker.ts            mesure « modèle vs carnet »
  performance-guard.ts         arrêt de sécurité (perte significative), alerte de calibration
  move-scheduler.ts            réaction aux mouvements du spot
src/services/
  fair-value.ts                modèle (pur) : probabilité, frais, edge exigé, bruit, remplissage
  round-market-data.ts         spot, prix à battre, volatilité (bougies Binance/Coinbase)
  spot-stream.ts               flux WebSocket Binance + contrôle d'horloge
  round-discovery.ts           rounds par slug (Gamma)
  clob-book.ts                 carnet CLOB (lecture publique, sans SDK ni clé)
  paper-ledger.ts              modèle du registre papier (statistiques pures), résolution Gamma
  ledger-store.ts              registre papier : journal append-only, statistiques incrémentales, migration
  decision-journal.ts          journal des évaluations (jsonl, compression, rétention)
  stake-sizing.ts              mise (Kelly ×0,25, plafonds, modérateurs)
  telegram.ts / telegram-messages.ts, crash-guard.ts, redact.ts, doctor.ts
src/analysis/                  rapports (fv-analysis, backtest historique, stats groupées)
src/dashboard/                 serveur HTTP/WebSocket + types partagés ; dashboard/ = interface React
scripts/analysis/              fv-report.ts, historical-backtest.ts, ledger.ts ; scripts/doctor.ts, demo.ts
tests/                         node:test ; tests/fixtures/fake-live-net.ts = faux Polymarket/Binance/Telegram
```

Ce qui n'existe **plus** dans le bot : les stratégies héritées (smart money, arbitrage,
DipArb, tendance, direct), le SDK Polymarket (wallet, client signé, WebSocket Polymarket), le
module LLM, la comptabilité `history.json` / `pnl.json`. Le code du SDK reste dans
`src/services`, `src/clients`, `examples/` et `scripts/` pour les outils ; le bot ne l'importe
pas. `git log` garde l'ancien point d'entrée.

### 2.1 PM2

| Champ PM2 | Valeur |
|---|---|
| `name` | `polymarket-paperbot` |
| `script` | `bot-with-dashboard.ts` |
| `interpreter` | `node --import tsx` (TypeScript exécuté directement, dans un seul process : un arrêt PM2 laisse au bot le temps de s'arrêter proprement) |
| `autorestart` | `true`, `exp_backoff_restart_delay: 100` (relance après 0,1 s, puis ×1,5 à chaque plantage, plafond 15 s ; remis à zéro après 30 s sans plantage) |
| `kill_timeout` | `7000` (le bot a jusqu'à 5 s pour vider le journal et Telegram avant d'être tué) |
| `out_file` / `error_file` | `paperbot.log` / `paperbot.error.log` |

`pm2 list | grep polymarket` (état, restarts, uptime), `pm2 describe polymarket-paperbot`.
Lancement manuel : `npx tsx bot-with-dashboard.ts`.

### 2.2 Configuration : `.env`

Lue une seule fois par `src/bot/config.ts` ; toute valeur invalide est signalée au démarrage et
par `npm run doctor`. Modèle complet et commenté : [`.env.example`](.env.example).

| Variable | Défaut | Rôle |
|---|---|---|
| `PAPER_CAPITAL` | `50` | Capital papier de référence. Mise ≤ 1 % du capital **actuel** → **250 $ recommandé** (minimum Polymarket 1 $ par ordre). |
| `CAPITAL_USD` | — | Ancien nom : lu seulement si `PAPER_CAPITAL` est absent (le doctor le signale). À renommer. |
| `DRY_RUN` | `true` | `false` = demande de mode réel : **refusé** (non implémenté) — le bot s'arrête (code 1) en l'annonçant sur Telegram ; sous PM2 les relances sont comptées et les alertes espacées. |
| `DAILY_MAX_LOSS_PCT` / `MONTHLY_MAX_LOSS_PCT` / `MAX_DRAWDOWN_PCT` / `TOTAL_MAX_LOSS_PCT` | `0.05` / `0.15` / `0.25` / `0.40` | Porte de risque (§6). Hiérarchie vérifiée (jour ≤ mois ≤ totale). |
| `FV_MIN_EDGE` | `0.04` | Edge minimal exigé (probabilité modèle − coût réel par part), après frais. |
| `FV_NOISE_EDGE_K` | `1.5` | Marge en plus, en écarts-types du bruit de notre probabilité (prix à battre estimé, écart Binance/Chainlink). Simulation (10 graines × 3 000 rounds) : sans marge, 13 % des rounds joués à −5 %/$ contre un carnet juste ; avec, 0,1 %, et sur un carnet en retard le gain par pari passe de +17,5 % à +38 %. S'applique aussi aux reventes. |
| `FV_MIN_PROB` | `0.60` | Probabilité modèle minimale du côté acheté (réussite attendue ≥ 60 %). |
| `FV_EXIT_EDGE` | = `FV_MIN_EDGE` | Revente anticipée si `bid − frais` dépasse `p_modèle` de cette marge (+ marge de bruit). |
| `FV_MIN_TAU_SEC` / `FV_MAX_TAU_SEC` | `60` / `270` | Fenêtre de temps restant pour entrer ou revendre. Jamais dans la minute finale moyennée. |
| `FV_MIN_ASK` / `FV_MAX_ASK` | `0.08` / `0.92` | Bornes d'ask achetable. |
| `FV_TAKER_FEE_RATE` | `0.07` | Barème crypto : frais = parts · taux · p · (1−p) (1,75 $ pour 100 parts à 0,50 $). |
| `FV_BASIS_BPS` / `FV_STRIKE_NOISE_SEC` / `FV_TWAP_WINDOW_SEC` | `2` / `3` / `60` | Incertitudes (écart de flux, prix à battre) et fenêtre du règlement. `FV_TWAP_WINDOW_SEC=0` = ancien règlement : faux aujourd'hui, le doctor le signale. |
| `FV_Z_SCALE` / `FV_BLEND_MODEL` / `FV_BLEND_MARKET` / `FV_TAILS` | `1` / `1` / `0` / `normal` | Calibration et mélange avec le carnet : **ne changer que sur suggestion du rapport**, validée hors échantillon. |
| `FV_HARVEST` | `false` | Récolte de fin de round en papier (§5 bis), désactivée par défaut : `true` pour l'activer. Réglages : `FV_HARVEST_MAX_TAU` (30), `FV_HARVEST_MIN_TAU` (8), `FV_HARVEST_STABLE_SEC` (6), `FV_HARVEST_MIN_ASK` (0,99) — à ne changer que sur preuve (rapport section 1e). |
| `FV_LATE_MEASURE` | `true` | Dernière minute des rounds (τ < 60 s) : P(Up) avec la part déjà acquise du TWAP (flux spot par seconde) et le carnet sont **mesurés** (journal `lt`/`pl`, rapport section 1d) — le bot n'y entre jamais. `false` pour économiser ces lectures de carnet. |
| `FV_VOL_ESTIMATOR` | `cc` | Volatilité : `cc` clôture-à-clôture, `parkinson` (plus haut/plus bas : dispersion ~2× plus faible, mais biaisé par l'échantillonnage et le rebond bid/ask), `blend`. Les deux σ sont journalisés quoi qu'il arrive ; le rapport (section 1c) dit lequel prédit mieux **avant** de changer. |
| `FV_POLL_SEC` / `FV_MOVE_BPS` / `FV_SPOT_STREAM` | `10` / `3` / `true` | Passage régulier, seuil de réaction aux mouvements du spot, flux temps réel. |
| `FV_FILL_DELAY_MS` / `FV_MIN_ORDER_USD` | `1000` / `1` | Latence d'ordre simulée ; minimum d'achat Polymarket. |
| `FV_JOURNAL` / `FV_JOURNAL_KEEP_DAYS` / `FV_COINS` | `true` / `30` / les 5 | Journal des évaluations ; coins tradés. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_ENABLED` / `TELEGRAM_SUMMARY_MIN` / `TELEGRAM_TZ` | — / — / — / `60` / `Europe/Paris` | Notifications (§4). |
| `DASHBOARD_PORT` / `DASHBOARD_HOST` / `DASHBOARD_TOKEN` | `3001` / `127.0.0.1` / — | Dashboard (§4). Hors local, le jeton est **obligatoire** (sinon repli sur 127.0.0.1). |
| `HTTP_TIMEOUT_MS` | `10000` | Délai des requêtes HTTP (carnets). |

---

## 3. Où sont les données

Tout vit dans **`~/.polymarket/`** (`/root/.polymarket/`) :

| Fichier | Contenu | Statut |
|---|---|---|
| `fv-ledger.jsonl` | **Registre papier — SOURCE DE VÉRITÉ.** Journal append-only : une ligne par événement (ouverture d'un trade, règlement, revente…), un trade par round et par stratégie : mise, coût par part, `modelProb`, statut (`open`/`won`/`lost`/`sold`), PnL, horodatages. Le bot en tient PnL, baisse, série de pertes, positions ouvertes à jour événement par événement (aucune relecture de l'historique) ; il résout lui-même les rounds (Gamma). Chaque ajout est synchronisé sur disque ; une ligne invalide au milieu rend le registre illisible (le bot n'ouvre alors plus rien, fichier jamais modifié) ; une dernière ligne coupée par un arrêt brutal est mise de côté (`.ligne-coupee-<date>`) et signalée. Un seul bot l'écrit (verrou `fv-ledger.jsonl.lock`). | **Autorité** |
| `fv-ledger.json`, `fv-ledger.json.migre-<date>` | Ancien registre (un seul JSON réécrit à chaque trade). Migré au premier démarrage de cette version, après vérification que toutes les statistiques rejouées sont identiques (sinon : rien n'est migré, le bot n'ouvre aucune position et alerte) ; conservé renommé `.migre-<date>`. Répétition sur une copie : `npm run ledger:check-migration -- <copie>`. Retour à une version antérieure : `npx tsx scripts/analysis/ledger.ts --export-json` (bot arrêté) reconstruit `fv-ledger.json`. | Archive |
| `journal/decisions-*.jsonl(.gz)` | Toutes les évaluations (pari ou abstention), 30 jours (jours révolus compressés), pour `fv-report.ts`. | Analyse |
| `fv-shadow.json` | Agrégats « modèle vs carnet ». Repart de zéro si l'empreinte du modèle change. | Mesure continue |
| `fv-guard.json` | Présent = **arrêt de sécurité actif** (perte significative). Le supprimer pour reprendre. | Garde-fou |
| `run-state.json` | Arrêts anormaux récents (espacement des alertes de plantage). Supprimable. | Suivi |
| `session-history.json` | Bilan de chaque session (page « Historique » du dashboard), écrit à l'arrêt. | Affichage |
| `outcomes-cache.json`, `round-prices-cache.json` | Résultats et prix publiés des rounds déjà réglés (caches du rapport). | Cache |
| `history.json`, `pnl.json`, `cumulative.json`, `llm-calls.json`, `archive/`, `audit-*.json` | Ancienne chaîne (Hermes, LLM) : **plus écrits ni lus** par le bot. Archivables. | Obsolète |

---

## 4. Lire son PnL, Telegram, dashboard

```bash
npx tsx scripts/analysis/ledger.ts          # bilan + derniers trades du registre (--export-json : ancien format)
npx tsx scripts/analysis/fv-report.ts --days 7   # le modèle a-t-il un edge ? (sections 0 à 5)
```

### 4.1 Telegram (intégré au bot)

| Variable | Rôle |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token donné par **@BotFather** (`123456789:ABC…`). |
| `TELEGRAM_CHAT_ID` | Ton chat (nombre) ou un groupe (`-100…`). Trouvable via **@userinfobot**. |
| `TELEGRAM_ENABLED` | `false` pour couper sans retirer le token. |
| `TELEGRAM_SUMMARY_MIN` | Période du bilan (défaut 60, bornée 15–1440). Envoyé s'il y a de nouveaux trades ; sinon (seule la mesure a avancé) au plus toutes les 6 h. |
| `TELEGRAM_TZ` | Fuseau des heures de round (défaut `Europe/Paris`). |
| `TELEGRAM_COMMANDS` | `false` pour ne plus répondre aux commandes (défaut : le bot écoute le chat configuré). |
| `TELEGRAM_DAILY_REPORT` / `TELEGRAM_DAILY_REPORT_DAYS` | Rapport quotidien sur Telegram (le résumé de `/rapport`, avec son verdict), à cette heure locale (`TELEGRAM_TZ`), sur ces jours : défaut `08:00` / `3`. `off` pour couper. Un bot démarré après l'heure l'envoie à son démarrage (+2 min) s'il n'est pas déjà parti ; jamais deux fois le même jour. |

**Au démarrage**, la connexion est vérifiée (`getMe` + `getChat`) et le log dit exactement quoi
faire si elle échoue : token refusé → le régénérer chez @BotFather ; « chat introuvable » →
envoyer **/start** au bot (ou l'ajouter au groupe) ; bot bloqué → le débloquer. Une panne
Telegram n'arrête jamais le bot (nouvel essai toutes les 5 min). Les envois sont en file
(≥ 1,1 s d'écart, respect des 429, 4 essais réseau, repli texte brut si le HTML est refusé) et
aucun secret n'apparaît jamais dans les logs.

**Messages** : démarrage (règle, capital, historique ; « ↻ Relancé après un arrêt … » après
un plantage) · `🎯 NOUVEAU PARI` (round, prix à battre, spot, chance de gagner, prix payé frais
inclus, avantage, mise, gain/perte) · `✅ GAGNÉ` / `❌ PERDU` / `💱 REVENDU` avec le bilan ·
bilan périodique (trades, réussite, calibration, PnL, fiabilité t, « Modèle vs carnet »,
« Avant le réel ») · `⚠️ ALERTE` (porte de risque, arrêt de sécurité, chiens de garde,
horloge, capital trop petit, plantage — au plus une par motif toutes les 6 h ; en boucle de
plantage, espacées 10 min → 6 h).

**Commandes** (envoyées au bot depuis le chat configuré, lecture seule — rien ne change au bot) :
`/status` (entrées autorisées ou bloquées et pourquoi, capital, trades, positions, santé du
flux et des passages), `/bilan` (le bilan périodique, à la demande), `/risque` (les quatre
limites chiffrées), `/positions` (paris en cours : côté, mise, prix, modèle, fin, gain si
gagné), `/rapport [jours]` (le rapport d'analyse du journal en direct, résumé avec un
verdict « edge ou pas » ; défaut 3 jours), `/backtest [jours]` (le modèle rejoué sur les rounds
Polymarket passés ; défaut 2 jours), `/aide`. `/rapport` et `/backtest` répondent tout de
suite puis envoient le résultat 1 à 15 min plus tard : le calcul tourne dans un processus
séparé, en priorité basse, un seul à la fois, tué à l'arrêt du bot — la boucle de trading
n'attend jamais. Seul `TELEGRAM_CHAT_ID` est écouté (les messages d'autres chats sont
ignorés) ; une commande envoyée pendant un arrêt du bot (> 5 min) n'est pas rejouée. Si un
autre programme lit déjà les messages du même bot (conflit 409 de `getUpdates`), les commandes
ne répondent pas et le log le dit : utiliser un bot distinct par programme.

### 4.2 Dashboard

`http://127.0.0.1:3001` sur le serveur (tunnel SSH : `ssh -L 3001:127.0.0.1:3001 serveur`), ou
`DASHBOARD_HOST=0.0.0.0` + `DASHBOARD_TOKEN=<secret>` puis `http://serveur:3001/?token=<secret>`.
Tout vient du registre et de l'état du process : capital et PnL (jour, mois, fiabilité t),
porte de risque (4 couches), paris en cours, dernière évaluation de chaque coin avec sa raison,
santé (passages, marchés, flux spot, horloge, Telegram, journal), journal filtrable, réglages
en vigueur, historique des sessions. Aucune commande ne change le comportement du bot (pas de
bascule LIVE : non implémentée). Après une mise à jour : `cd dashboard && npm run build`.

---

## 5. Stratégie en clair (juste valeur, déterministe)

**Pourquoi l'ancienne règle a été retirée.** « Acheter le favori si son ask ∈ [0,58 ; 0,65] »
a été mesurée sur 1 411 décisions : le marché est **calibré** par niveau de prix
(`docs/EDGE-VALIDATION.md` §5). Une règle fondée sur le seul prix d'entrée ne peut pas créer
d'edge. L'objectif n'est **pas** le win rate (acheter des favoris à 0,95 donne 95 % de WR et
zéro gain) mais l'**espérance par trade après frais**.

En continu (évaluation sur mouvement du spot + passage de fond toutes les ~10 s), pour chaque
round 5 min ouvert (au plus **une entrée par round**) :

1. **Marchés** : le round en cours de chaque coin est trouvé par son slug (Gamma
   `events?slug=`), tokens Up/Down associés par libellé.
2. **Données** : prix à battre = moyenne de la minute précédant l'ouverture, estimée par
   `(O+H+L+C)/4` de la bougie 1 min Binance [T0 − 60 s, T0) (erreur 3× plus petite que
   l'ouverture du slot) ; σ = max(vol réalisée 60 min, 15 min) ; spot = **flux WebSocket Binance
   temps réel** (repli : dernière bougie REST, binance.vision, Coinbase). Chaque mouvement
   ≥ `FV_MOVE_BPS` déclenche une évaluation immédiate (au plus une toutes les 1,5 s). Flux
   absent ou figé → pas de mise. Horloge contrôlée contre les horodatages Binance.
3. **Probabilité** : `P(Up) = Φ(ln(S/K) / √(σ²·(τ − 40 + bruit_strike) + basis²))` — règlement
   TWAP 60 s (la moyenne finale varie moins qu'un prix ponctuel : `τ − W + W/3` secondes de
   variance). Optionnellement mélangée au prix du carnet (`FV_BLEND_*`, désactivé par défaut).
4. **Coût réel** d'une part = ask + frais taker `0,07·p·(1−p)`. Edge = P(côté) − coût. Entrée
   seulement si **P(côté) ≥ 0,60**, edge ≥ `FV_MIN_EDGE` + `FV_NOISE_EDGE_K`·σ_bruit,
   τ ∈ [60 ; 270] s et ask ∈ [0,08 ; 0,92]. σ_bruit = ce que l'incertitude sur le prix à battre
   et l'écart de flux font varier notre probabilité (grand près de 50/50 et à faible vol).
5. **Mise** : `computeStake` (Kelly ×0,25 sur une probabilité **shrinkée de moitié** vers le
   prix, plafonds durs 1 % du capital actuel par trade et 10 % d'exposition, modérateurs
   drawdown et série de pertes lus dans le registre).
6. **Exécution simulée = ordre à prix limite** : prix limite fixé à la décision (garantit l'edge
   exigé avec l'information de cet instant) ; l'ordre « arrive » après `FV_FILL_DELAY_MS` (1 s)
   et ne prend que les asks encore sous la limite, niveau par niveau (coût exact, frais inclus).
   Le modèle n'est **pas** réévalué après le délai (un vrai ordre ne voit pas le mouvement
   pendant son trajet). Profondeur insuffisante ou edge au VWAP sous le seuil → pas de mise.
7. **Sortie** : on garde jusqu'à la résolution, sauf si `bid − frais > p + FV_EXIT_EDGE + marge
   de bruit` (le marché paie plus que la position ne vaut ; même formule qu'à l'entrée), jamais
   dans la minute finale, reventes à partir de 5 parts (minimum Polymarket).

La boucle vit dans `src/strategy/fair-value-runner.ts` (testée sans réseau :
`tests/fair-value-runner.test.ts`). Mondes simulés à règlement TWAP
(`tests/strategy-simulation.test.ts`, `tests/runner-simulation.test.ts`) : face à un carnet
juste le bot ne parie quasiment pas ; face à un carnet en retard de 10 s il gagne, avec une
réussite égale à la probabilité annoncée (calibration). Cela valide la logique, **pas**
l'existence d'un edge sur le vrai Polymarket.

## 5 bis. Récolte de fin de round (papier)

**Mesure qui l'a motivée** (`late-harvest.ts`, jeu de données public de carnets Polymarket à la
seconde, 7–18 août 2026, 6 590 rounds 5 min BTC/ETH, issue = carnet final) :

| Règle | Paris | Gagnés | Gain par pari (frais compris) |
| ----- | ----- | ------ | ----------------------------- |
| Favori à 0,99 **depuis ≥ 6 s**, τ 30→8 s, exécution 1 s après | 4 944 | 99,74 % | **+0,72 %** (t 9,4 ; moitiés +0,58 / +0,84) |
| Même règle, contrôle toutes les 8 s (2 lectures consécutives) | 4 378 | 99,77 % | +0,72 % (t 9,9) |
| Premier instant où le favori touche 0,99 (sans stabilité) | 5 373 | 99,13 % | +0,21 % (non significatif) |
| Favori à 0,97–0,98 (prix libre) | — | — | ≈ 0 ou négatif |
| Entrée avant τ = 30 s (fenêtre 60→8 s) | 5 591 | 99,16 % | +0,19 % (non significatif) |

Pourquoi : le pas de prix (0,01) empêche le favori de coter au-delà de 0,99 alors qu'en fin de
round TWAP sa vraie probabilité est plus haute ; un pic juste arrivé à 0,99 se retourne souvent,
un favori qui y reste plusieurs secondes beaucoup plus rarement.

Reproduire (ou refaire sur de nouveaux fichiers du jeu de données) :
`npx tsx scripts/analysis/harvest-dataset.ts --download` (Node ≥ 22.15 ; fichiers dans
`~/.polymarket/datasets/`) — même règle que le bot, avec moitiés, actifs et variantes de robustesse.

**Règle du bot** : lecture des carnets toutes les 3 s à l'approche de la fenêtre ; même côté
bloqué dans [0,99 ; 0,995[ sans interruption depuis `FV_HARVEST_STABLE_SEC` (6 s) ; τ entre
`FV_HARVEST_MAX_TAU` (30) et `FV_HARVEST_MIN_TAU` (8) ; refus si le modèle « fin de round »
(TWAP en partie acquis, flux temps réel) donne au favori moins de 90 % ; mise = `computeStake`
(1 % du capital au plus) ; ordre limite 0,995 exécuté après `FV_FILL_DELAY_MS` sur le carnet relu.
Un pari par round (`<conditionId>|late` au registre, `strategy: late`), jamais revendu.

**Limites honnêtes** : 12 jours d'août, deux cryptos ; l'issue mesurée est le carnet final, pas
le règlement officiel ; la profondeur réelle à 0,99 n'est pas connue pour tous les cas ; une
perte coûte ~110 gains. Garde-fou propre (`~/.polymarket/fv-guard-late.json`) : arrêt si perte
significative (t ≤ −2 sur ≥ 50 paris), alerte si la réussite tombe nettement sous 99,7 %.
Désactivée par défaut : `FV_HARVEST=true` l'active, `false` (ou l'absence du réglage) la coupe.

### 5 ter. Stratégie llm (papier, agents Claude) — désactivée par défaut

Trois agents Claude Haiku (analyste → décideur → sécurité), appelés l'un après l'autre par un
orchestrateur **en code** (il ne décide rien), chacun en mode headless **sans aucun outil**.
Toute erreur, tout délai dépassé, tout JSON invalide, toute limite d'usage = **abstention
enregistrée**, jamais un pari. Les garde-fous du code s'appliquent **après** les agents et ont
le dernier mot (mise ≤ 2 $ et ≤ limites du capital llm, prix limite recalculé frais compris,
garde de fraîcheur, exécution simulée +1 s sur carnet relu). Capital papier **séparé**
(`LLM_PAPER_CAPITAL`) : ses pertes ne touchent pas les limites de formule et récolte.

Sécurité indépendante des options du CLI : délai dur qui tue tout le groupe de processus,
compteur d'appels persistant, environnement minimal (aucune clé du bot, pas d'`ANTHROPIC_API_KEY`),
HOME et dossier de travail isolés hors du dépôt, fil-piège qui tue le processus si un outil
apparaît, pause automatique (3 échecs → 30 min doublées, limite d'usage → 60 min, plafond 6 h).

Mise en route : voir `.env.example` (version du CLI figée, `claude setup-token` puis
`npm run llm:token`, `npm run llm:probe` sur le serveur, puis `/llm on`). La sonde mesure la latence
réelle d'une décision complète. Enregistrement : `~/.polymarket/llm/` (decisions.jsonl, instantanés,
sorties brutes par agent) — hors du registre, référencé par `decisionId`.

### Mesurer si ça marche (journal des décisions)

Chaque évaluation est écrite dans `~/.polymarket/journal/decisions-AAAA-MM-JJ.jsonl` (≤ 1 ligne
par round toutes les 10 s, avec probabilité, bruit, asks, meilleurs bids, fenêtre du modèle).
`npx tsx scripts/analysis/fv-report.ts --days 7` règle les rounds et répond dans l'ordre :
0. **Prix à battre** : notre estimation vs celle publiée par Polymarket (décalage, dispersion,
   gain possible en lisant le prix officiel). 0b : le prix officiel est-il **disponible pendant
   le round** (relu dans Gamma tant qu'il manque, journalisé `ps`), avec quel délai, et égal à la
   valeur du règlement ? Prérequis avant de l'utiliser en direct. 0c : le modèle prédirait-il
   **mieux** avec le prix officiel, corrigé de l'écart Binance (USDT) / Chainlink (USD) mesuré
   sur les 12 rounds précédents (Brier apparié, t ≤ −2 = oui) ?
1. **Le modèle prédit-il mieux que le carnet ?** (Brier, t groupé par créneau). 1c : quelle
   volatilité prédit le mieux (clôture-à-clôture, Parkinson, mélange — `FV_VOL_ESTIMATOR`).
   1d : **dernière minute** (TWAP en partie acquis) — le modèle « fin de round » voit-il mieux
   que le carnet, et des entrées hypothétiques y auraient-elles rapporté (le bot n'y entre jamais).
   1b : mélange modèle/carnet estimé sur une moitié, jugé sur l'autre.
2. **Est-il calibré ?** (« 70 % » gagne-t-il ~70 % du temps ?), `FV_Z_SCALE` suggéré avec IC.
3. **Quels seuils auraient rapporté**, sur chaque moitié, et selon la marge de bruit `k`.
4. Paris réellement pris.
5. **Comparatif formule / récolte / llm** (papier) : trades réglés du registre par stratégie (taux
   de gain, gain par 1 $ misé avec IC 95 % groupé par créneau, PnL), puis décisions llm
   (`~/.polymarket/llm/decisions.jsonl`, autre fichier : `--llm-decisions`) par campagne :
   abstentions par motif, veto, échecs techniques, latence, Brier et gains **appariés** contre la
   formule au même instantané, calibration, désaccords, et verdict de la règle d'arrêt
   pré-enregistrée (jugée sur toute la campagne). `/rapport` en reprend 4 lignes.

Les évaluations d'un autre modèle (fenêtre TWAP différente) sont ignorées. Backtest rapide sur
l'historique (prix par minute, indicatif) : `npx tsx scripts/analysis/historical-backtest.ts --days 3`.
`--summary` (les deux scripts) n'affiche que le résumé Telegram et son verdict : c'est ce
qu'exécutent `/rapport` et `/backtest`.

**Limites honnêtes** : le prix à battre est **estimé** (bougie Binance), alors que Polymarket
l'affiche exactement — d'où la marge de bruit (amélioration possible : lire le flux Chainlink
TWAP de Polymarket, à décider sur la section 0 du rapport). La latence simulée d'1 s retire une
partie des prix fantômes, mais des bots co-localisés restent plus rapides : le papier peut
**surestimer** les exécutions.

---

## 6. Garde-fous (risque, performance, fiabilité)

| Garde-fou | Déclencheur | Effet |
|---|---|---|
| Mise plafonnée | toujours | ≤ 1 % du capital **actuel** par trade, ≤ 10 % exposé, Kelly ×0,25 sur une proba shrinkée |
| Série de pertes | 4 / 8 pertes d'affilée (sur 6 h) | mise ÷2 / pause de 6 h + alerte |
| Baisse (mise) | ≥ 10 % / 20 % depuis le plus haut | mise ÷2 / mise suspendue + alerte |
| **Porte de risque** (`src/bot/risk-gate.ts`) | perte du jour ≥ 5 %, du mois ≥ 15 % (UTC), baisse ≥ 25 %, perte totale ≥ 40 % | plus d'entrée jusqu'à minuit UTC / au 1er du mois / décision manuelle / définitivement — recalculé depuis le registre à chaque passage |
| **Perte significative** | t ≤ −2 sur ≥ 50 trades | arrêt persistant des entrées (`fv-guard.json`), observation continue |
| Modèle sur-confiant | réussite < proba annoncée − 2 σ (n ≥ 30) | alerte |
| Chien de garde | boucle bloquée 3 min, 10 échecs, aucun marché 5 min | alerte |
| Données | spot > 3 s (flux) ou bougie > 65 s, prix à battre absent | pas de mise |
| Horloge | décalage > 2 s / > 5 s vs Binance | alerte / plus de nouvelle entrée |
| Taille d'ordre | mise < 1 $ | pas de mise + alerte (capital papier trop petit) |
| Round jamais réglé | 6 h après la fin | alerte (une par trade) ; nouvel essai toutes les 5 min |
| Arrêt en cours | SIGINT/SIGTERM, exception | plus d'entrée (vérifié jusqu'au dernier instant), journal et Telegram vidés (≤ 5 s) |
| Plantage | arrêt sur erreur, kill -9, mémoire | signalé au lancement suivant ; alertes espacées en boucle (10 min → 6 h) |
| Pendant toute pause | | évaluations, journal et mesure « modèle vs carnet » continuent (pas de trou dans la mesure) |

---

## 7. Ce qui reste ouvert (honnêtement)

- **L'edge n'est PAS prouvé.** Seule la mesure en direct tranche (« Modèle vs carnet », puis
  `fv-report.ts` sur les deux moitiés). Si le modèle ne prédit pas mieux que le carnet, aucun
  réglage ne rendra la stratégie rentable : l'arrêter.
- **Marge de bruit** : sa taille repose sur l'hypothèse de 2 bps d'écart Binance/Chainlink et
  3 s de variance sur le prix à battre. Le rapport (sections 0 et 3) dira si elle est trop
  prudente ; ne pas la baisser à l'intuition.
- **Papier ≠ réel** : latence simulée et ordres limites, mais des bots co-localisés restent plus
  rapides ; profondeur au meilleur prix souvent faible. En réel, mises ≥ 5 $ pour pouvoir
  revendre.
- **Exécution réelle non implémentée** (volontaire) : à n'écrire qu'après les critères « Avant
  le réel » remplis, avec le prix à battre officiel lu en direct.

---

## 8. Carte de la documentation

- [`docs/rebuild/SYNTHESIS.md`](docs/rebuild/SYNTHESIS.md) — synthèse des audits historiques
  (edge, risque, exécution, PnL, recap, code) ; [`docs/rebuild/strategy/EDGE.md`](docs/rebuild/strategy/EDGE.md),
  [`docs/rebuild/risk/RISK.md`](docs/rebuild/risk/RISK.md), [`docs/rebuild/execution/COSTS.md`](docs/rebuild/execution/COSTS.md).
- [`docs/EDGE-VALIDATION.md`](docs/EDGE-VALIDATION.md) — validation d'edge de l'ancienne règle
  (1 411 décisions).
- [`docs/legacy/`](docs/legacy/) — guides de l'ancienne architecture (QUICKSTART, BEGINNER_GUIDE,
  README arabe, ancien dashboard, correctifs C2–C9) : **ils ne décrivent plus ce bot**, conservés
  pour l'historique. Les autres documents de `docs/` (SDK, DipArb, recap Hermes) sont des archives
  de même nature. Le dump de code `repoinfo.md` (31 791 lignes) a été supprimé.
- [`.env.example`](.env.example) — modèle de configuration (sans secrets).
- `npm run doctor` — diagnostic ; `npm run demo` — le bot sur un marché simulé (hors ligne) ;
  `npm run check` — types et tests (dont le vrai bot de bout en bout sur un faux réseau).
