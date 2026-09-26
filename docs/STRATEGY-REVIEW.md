# Revue de stratégie — Polymarket paper bot (Up/Down 5m)

**Analyse : 2026-09-25** · périmètre : `/root/clawd/Polymarket-bot` + `~/.polymarket/`
**Échantillon analysé : 63 trades résolus, mise 1 €/trade, 5 coins (BTC/ETH/SOL/XRP/DOGE).**
Méthode : les 63 clés de `cumulative.json` ont été appariées à l'identique (égalité d'ensembles, 0 différence) aux 63 trades
du log du 2026-09-18T13:41 → 2026-09-20T10:14, puis chaque round a été re-résolu sur l'issue réelle via l'API Gamma.

---

## TL;DR

| | Officiel (`pnl.json`) | Réel (recalculé sur l'issue Polymarket) |
|---|---|---|
| Trades résolus | 63 | **63** |
| Wins / Losses | 28 / 35 | **43 / 20** |
| Win rate | 44,4 % | **68,3 %** (IC95 56,0–78,4) |
| PnL réalisé | **−21,07 €** | **+0,62 €** |
| EV / trade | −0,334 € | **+0,0098 €** |

- **Écart : +21,69 €.** Le PnL réalisé affiché est **faux** — cause identifiée et vérifiée (§1.2). Le WR affiché de 44,4 % l'est aussi.
- Même corrigé, l'edge réel est **+1 centime par trade** et **statistiquement non significatif** (t = 0,11).
- Break-even : à gain moyen +0,4795 € et perte −1,00 €, il faut **67,6 % de réussite** pour être à zéro. Mesuré 68,3 % → marge de 0,7 pt.

---

## 1. Santé du pipeline de données

### 1.1 Ce qui est cohérent
- `pnl.json` : `wins+losses = 28+35 = 63 = trades` ✔ ; `win_rate 44,4 % = 28/63` ✔ ; `pending = 0` ✔ ; `window_pnl 0,76 = 0,4143+0,35` (les 2 trades encore dans `history.json`) ✔.
- `cumulative.json` est **monotone** (il n'ajoute que les nouveaux `realized`, jamais de re-somme glissante) → le bug « PnL cumulé qui rétrécit » est bien corrigé.
- `llm-calls.json` : `calls: 0` → LLM bien désactivé.
- Aucun trade non résolu en attente > 1 h **dans la fenêtre couverte** (`pending = 0`).

### 1.2 Incohérence majeure #1 — le PnL réalisé stocké ne correspond pas aux marchés
- Les 63 clés de `cumulative.json` = **exactement** les 63 trades de la fenêtre du log (vérifié par égalité d'ensembles).
- Re-résolution des 63 rounds sur l'issue réelle : 43 W / 20 L, **+0,62 €** — contre −21,07 € affichés.
- **Cause racine vérifiée** : `/root/.hermes/scripts/paperbot-pnl.py` ligne 29 appelle
  `https://gamma-api.polymarket.com/markets?condition_id=<cid>` et lit `data[0]`.
  Ce filtre est **ignoré** par l'API : la requête renvoie toujours la même page non filtrée de 20 marchés,
  `data[0]` = `xi-jinping-out-before-2027` (`outcomePrices ["0.0435","0.9565"]` → « Down » gagnant).
  Conséquence : presque tout **YES est enregistré perdant (−1,00)** et tout **NO gagnant (+1/prix−1)**.
- Confirmation indépendante sur `archive/2026-09-18/history.json` (données que je n'ai pas construites) :
  **33 `realized` sur 101 (33 %)** contredisent l'issue réelle du round. Sur ces 101 :
  **30 YES non vendus en TP → 0 déclaré gagnant** ; **23 NO non vendus en TP → 21 déclarés gagnants**.
- L'endpoint correct a été vérifié et fonctionne : `https://gamma-api.polymarket.com/events?slug=<coin>-updown-5m-<slot>`
  (`closed: true`, `outcomePrices ["1","0"]`).

### 1.3 Incohérence #2 — l'archive quotidienne ne tourne plus
- `~/.polymarket/archive/` ne contient que **`2026-09-18/`** (1 seul `resume.json`).
- `hermes cron list` ne liste **aucun job paperbot** (recap / archive / pnl). Les journées 09-19 et 09-20 ne seront jamais archivées.
- À noter : un autre agent travaille le code en parallèle → état au 2026-09-25T21:xx, à re-vérifier après son passage.

### 1.4 Incohérence #3 — `history.json` est saturé de HOLD
- 300 entrées, dont **298 HOLD (99,3 %)** et **2 trades** (tous deux `soldTp`).
- Fenêtre couverte : **2026-09-20T09:59:43 → 14:24:44 seulement (4 h 25)**, soit ~1 entrée / 53 s.
- Conséquence : les trades sortent de la fenêtre en ~4–5 h → **impossible de reconstruire les 63 trades depuis les fichiers du bot**
  (le détail par coin / par bucket n'existe nulle part dans `~/.polymarket`).

### 1.5 Hygiène
- `paperbot.log` = **622 Mo**, `paperbot.error.log` = **826 Mo**, dont **6 847 295 lignes** « Monitoring active. Last Price: $Waiting (Never) ».
- Bot **arrêté** (`pm2 status stopped`), dernier log 2026-09-20T14:29:40, dernière écriture de données 14:26.

---

## 2. Performance réelle chiffrée

### 2.1 Couverture temporelle — bot en marche vs arrêt
- **63/63 trades (100 %) sont dans 2026-09-18T13:41 → 2026-09-20T10:14** (44,6 h, **1,41 trade/h**) :
  52 trades le 09-18, 6 le 09-19, 5 le 09-20.
- Dans la fenêtre, le bot a passé 09-20T10:14 → 14:29 **bloqué sans aucun trade** (« Waiting (Never) », problème RPC/prix).
- **Période d'arrêt 2026-09-20T14:29 → 2026-09-25T21:08 = 5,28 jours : 0 trade, 0 donnée.**
- Donc : **100 % de l'analyse porte sur 18–20/09, 0 % sur la période 20/09 → 25/09.** (`history.json` ne couvre que 4 h 25 le 20/09.)

### 2.2 Résultats globaux (n = 63, issue réelle)
- **43 W / 20 L → WR 68,3 %** (IC95 **56,0–78,4 %**).
- Gains : 43 × moyenne **+0,4795 €** = +20,62 €. Pertes : 20 × **−1,0000 €** exactement = −20,00 €.
- **PnL réalisé = +0,62 €** — soit **EV +0,0098 €/trades** (≈ +1 centime).
- Payoff **b = 0,480** → **break-even WR = 67,6 %**. Marge mesurée : **+0,7 pt**.
- Sorties : **17 trades vendus au take-profit** (gain capturé = **98,4 %** du gain max atteignable), **46 résolus au round** (26 W / 20 L = 56,5 %).
- **20/20 pertes sont à −1,0000 exactement** → sur un round binaire, tout perdant perd 100 % de la mise ; le stop-loss n'a coupé **aucune** perte.
- `t = 0,11` → **l'edge mesuré n'est pas distinguable de zéro.**

### 2.3 PnL par coin (issue réelle)
| Coin | n | WR | IC95 WR | PnL | EV/trade |
|---|---|---|---|---|---|
| XRP | 10 | 90 % | 60–98 | **+3,435 €** | +0,344 |
| BTC | 10 | 80 % | 49–94 | **+2,066 €** | +0,207 |
| DOGE | 8 | 62 % | 31–86 | **−0,770 €** | −0,096 |
| SOL | 16 | 62 % | 39–82 | **−1,661 €** | −0,104 |
| ETH | 19 | 58 % | 36–77 | **−2,451 €** | −0,129 |

→ Toutes les IC95 se recouvrent : **aucun coin ne peut être déclaré bon ou mauvais.**

### 2.4 PnL par tranche de prix d'entrée (issue réelle)
| Bucket | n | WR | IC95 WR | Prix moyen | Break-even WR | PnL | EV/trade |
|---|---|---|---|---|---|---|---|
| 0,55–0,60 | 5 | 80 % | 38–96 | 0,582 | 58 % | **+1,858 €** | +0,372 |
| 0,60–0,65 | 11 | 82 % | 52–95 | 0,621 | 62 % | **+3,393 €** | +0,308 |
| 0,65–0,70 | 15 | 53 % | 30–75 | 0,665 | 67 % | **−2,949 €** | −0,197 |
| 0,70–0,75 | 25 | 64 % | 45–80 | 0,713 | 71 % | **−2,680 €** | −0,107 |
| 0,75+ | 7 | 86 % | 49–97 | 0,750 | 75 % | **+0,996 €** | +0,142 |

- Regroupé : **0,58–0,65 → 16 trades, +5,251 €** ; **0,65–0,75 → 47 trades, −4,632 €**.
- Lecture : au-dessus de 0,65, le WR (53–64 %) **ne bat plus le prix payé** (67–71 %) → EV négative.

### 2.5 Échantillon
- 63 trades seulement, sur 3 jours, avec un bot partiellement bloqué. Ce qui suit est un **signal**, pas une preuve.

---

## 3. Changements proposés (justifiés par les chiffres)

### C1 — Réparer le résolveur PnL *(priorité absolue)*
- Fichier : `/root/.hermes/scripts/paperbot-pnl.py` ligne 29.
- Valeur actuelle : `https://gamma-api.polymarket.com/markets?condition_id={cid}` (+ `data[0]`).
- Valeur proposée : `https://gamma-api.polymarket.com/events?slug={coin}-updown-5m-{slot}` (vérifié : `closed:true`, `outcomePrices ["1","0"]`).
- Chiffres : **écart 21,69 €** (−21,07 affiché vs +0,62 réel) ; **33/101 `realized` faux** sur l'archive 09-18 ; **0/30 YES non-TP** déclaré gagnant ; WR affiché 44,4 % vs **68,3 % réel**.

### C2 — Fenêtre sweet-spot : baisser le plafond
- Paramètre : `.env` → `P_STRONG_MAX` (aussi `bot-with-dashboard.ts` fallback 0.75).
- Actuel : **0,75** → proposé : **0,65**.
- `P_STRONG_MIN` (0,58) : **inchangé** (bucket 0,55–0,60 trop petit : n=5).
- Chiffres : buckets 0,65–0,70 (EV −0,197 €) + 0,70–0,75 (EV −0,107 €) = **47/63 trades (75 %) pour −4,632 €**, alors que 0,58–0,65 = 16 trades pour **+5,251 €**.
- Réserve : IC95 larges (n=5 à 25) — voir §4.

### C3 — Take-profit : ne plus vendre à 0,99
- Paramètre : `.env` → `P_TAKE_PROFIT`.
- Actuel : **50** → proposé : **100** (ou désactiver la vente TP).
- Chiffres : les 17 ventes TP ont capturé **98,4 %** du gain max → **0,1243 € abandonnés**, soit **20,1 % de l'EV totale** (+0,0098 €/trade). Vendre 1 % sous le prix de résolution coûte 1/5 de l'edge.

### C4 — Stop-loss : inerte, ne pas le compter comme contrôle du risque
- Paramètre : `.env` → `P_STOP_LOSS` = **25**.
- Chiffre : **20/20 pertes à −1,0000 exactement** ; **0 vente coupée en perte sur 63 trades** (1 seule dans l'archive 09-18, à −0,8984).
- Proposition : le laisser (inoffensif) mais **documenter** qu'il ne peut pas fonctionner sur un round tout-ou-rien. Le seul levier de perte est **le prix d'entrée**.

### C5 — Filtre d'edge par coin : à désactiver tant que C1 n'est pas fait
- Paramètre : `bot-with-dashboard.ts` (~l. 1128) `learn.recent >= 8 && learn.wr >= (buyPrice + 0.10) * 100`.
- Chiffres : le `wr` par coin est calculé sur des `realized` **faux** (44,4 % affiché vs 68,3 % réel) → le filtre bloque des coins gagnants. Backtest séquentiel sur les 63 trades avec l'issue réelle : filtre actif = **42 trades, −1,678 €** ; sans filtre = **63 trades, +0,619 €**.
- Proposition : court-circuiter le filtre (ou le rendre inactif) jusqu'à ce que C1 soit corrigé, puis re-mesurer.

### C6 — Kelly : plafond 12× trop haut
- Paramètres : `kellyCeil = 0.25` / `kellyFloor = 0` (`bot-with-dashboard.ts` l. 363-364) ; `sizeFactor = 1 + kelly*2` (l. 402).
- Actuel : `kellyCeil` **0,25** → proposé : **0,05** tant que `n_resolus < 200`.
- Chiffres : **f\* mesuré = 0,0205** (p = 0,6825, b = 0,480) → `sizeFactor` ≈ **1,04**. En production (log 09-18) les coins tournaient à **×1,30 / ×1,50** = plafond 0,25 atteint, soit **12× la fraction mesurée**.
- Rappel déjà en place et à garder : `n < 10 → sizeFactor ≤ 1,2`.

### C7 — Nombre de coins : ne rien changer
- Chiffre : XRP 90 % (IC95 60–98) vs ETH 58 % (IC95 36–77) → les intervalles se recouvrent. **Retirer un coin n'est pas justifié.**
- `P_MIN_PRICE` (`0.15` en code, `0.25` en `.env` — divergence à corriger) : aucun trade sous 0,55 dans l'échantillon → **donnée absente** pour le calibrer.

### C8 — Cooldown par coin : ne pas ajouter de règle sur cet échantillon
- Backtests (issue réelle) : « 2 pertes consécutives → skip » = 57 trades, **+1,999 €** ; « PnL cumulé du coin < 0 → skip » = 25 trades, **+1,622 €** ; sans règle = 63 trades, **+0,619 €**.
- Les deux « améliorent » le résultat, mais avec n=63 et 5 coins c'est du **sur-apprentissage** — ne pas coder ça en dur maintenant.

### C9 — Coût d'exploitation du logging
- `paperbot.log` 622 Mo / `paperbot.error.log` 826 Mo ; **6 847 295 lignes** « Monitoring active ».
- `history.json` : **298/300 (99,3 %)** d'entrées HOLD → les trades sortent de la fenêtre en ~4 h.
- Proposition : rotation des logs (pm2-logrotate) ou suppression de la ligne heartbeat, et **ne plus écrire les HOLD dans `history.json`** (garder seulement les décisions/trades) pour que la fenêtre de 300 couvre plusieurs jours au lieu de 4 h.

---

## 4. Stats insuffisantes — ce qui ne peut PAS être conclu

- **L'edge n'est pas prouvé.** EV = +0,0098 €/trade, `t = 0,11` ; IC95 du WR [56,0 ; 78,4 %] **contient le break-even 67,6 %**. Traduire : les 68,3 % mesurés sont compatibles avec un bot à l'équilibre, voire perdant.
- **Taille d'échantillon nécessaire (t = 2)** à la cadence réelle de 1,41 trade/h :
  - EV = +0,0098 € (mesurée) : **~20 069 trades ≈ 591 jours** de fonctionnement continu ;
  - EV = +0,05 € : **~775 trades ≈ 23 jours** ;
  - EV = +0,10 € : **~194 trades ≈ 6 jours**.
- **Par coin : impossible de conclure.** n = 8 à 19. ETH (58 %, IC95 36–77) ne peut pas être déclaré mauvais, XRP (90 %, IC95 60–98) ne peut pas être déclaré bon. C7 reste donc sans objet.
- **Par bucket de prix : signal faible.** n = 5 à 25 ; 0,65–0,70 = 53 % avec IC95 [30 ; 75] → contient le break-even 67 %. **C2 est une hypothèse à re-tester, pas une conclusion.**
- **Optimum de Kelly par coin : non mesurable.** n par coin < 20 → f\* est du bruit ; C6 ne propose qu'un plafond prudent, pas un calibrage.
- **Fenêtre optimale, seuils de cooldown, nombre de coins : non déterminables** avec 63 trades sur 3 jours. Les backtests de C8 (±1,3 €) sont dans le bruit d'échantillonnage.
- **Donnée absente** : `realized` par coin/bucket pour la période d'arrêt 20/09 → 25/09 (aucun trade) ; journées 09-19 et 09-20 non archivées ; PnL du 09-20 après 10:14 (bot bloqué) ; `P_MIN_PRICE` non calibré (aucun trade < 0,55).
- **Rappel d'honnêteté** : un Up/Down 5m est un quasi pile-ou-face. WR ~50–55 % est le régime normal ; une série de pertes est de la variance, pas un bug. Rien ici ne permet de promettre un gain.

---

## 5. Reproductibilité

```bash
# 1. Inventaire des données
ls -la ~/.polymarket/ ~/.polymarket/archive/
cat ~/.polymarket/pnl.json ~/.polymarket/cumulative.json

# 2. Extraction des trades depuis le log (622 Mo)
cd /root/clawd/Polymarket-bot
grep -aE "Décision (YES|NO) @|gain réalisé" paperbot.log > docs/data/_raw_trades.txt

# 3. Test du résolveur PnL (retourne 20 marchés NON filtrés, identiques pour tout cid)
python3 docs/data/_probe2.py

# 4. Reconstruction des 63 trades + contrôle du résolveur sur l'archive 09-18
python3 docs/data/_recon.py

# 5. Preuve par égalité d'ensembles + stats par coin/bucket
python3 docs/data/_verify.py
python3 docs/data/_stats.py
python3 docs/data/_extra.py
python3 docs/data/_final.py
```

- Détail trade par trade : **`docs/data/recon_trades.csv`** (63 lignes : coin, round, ts, side, prix d'entrée, source de sortie TP/Gamma, issue réelle, PnL réalisé).
- Scripts d'analyse (lecture seule sur les données) : `docs/data/_probe*.py`, `docs/data/_recon.py`, `docs/data/_verify.py`, `docs/data/_stats.py`, `docs/data/_extra.py`, `docs/data/_final.py`.
- Aucun fichier hors de `docs/**` n'a été modifié ; `bot-with-dashboard.ts`, `src/**`, `.env` et `~/.hermes/scripts/paperbot-*.py` sont en lecture seule.
