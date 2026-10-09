# Correctifs appliqués — C2 / C3 / C5 / C6 / C9

**Date :** 2026-09-26 · **Périmètre :** `bot-with-dashboard.ts`, `.env`, `~/.polymarket/history.json`
**Source :** `docs/STRATEGY-REVIEW.md` (revue du 2026-09-25) · **Contrainte :** zéro token LLM.

---

## 1. Tableau avant / après

| # | Paramètre | Fichier / emplacement | Avant | Après | Justification chiffrée |
|---|-----------|----------------------|-------|-------|------------------------|
| **C6** | `kellyCeil` | `bot-with-dashboard.ts` l.386 | `0.25` | **`0.05`** | f* mesuré = 0,0205 ; la prod tournait à ×1,30/×1,50 (= 12× la fraction mesurée). Plafond prudent tant que `n_resolus < 200`. |
| **C6** | plafond `sizeFactor` (via Kelly) | idem l.423-428 | ~`1.50` (ceil atteint) | **`1.10`** | `sizeFactor = 1 + kelly*2` avec kelly ≤ 0,05 → 1,10. Règle `n < 10 → sizeFactor ≤ 1.2` **conservée**. |
| **C3** | `P_TAKE_PROFIT` | `.env` | `50` | **`100`** | 17 ventes TP abandonnaient 20,1 % de l'EV totale (0,1243 €/trade). À 100 % on ne vend plus 1 % sous la résolution. |
| **C3** | fallback TP | `bot-with-dashboard.ts` l.497 | `|| 30` | **`|| 100`** | Alignement code/.env (même classe de divergence que C7). |
| **C2** | `P_STRONG_MAX` | `.env` | `0.75` | **`0.65`** | Buckets 0,65-0,75 = 47/63 trades pour −4 632 € ; 0,58-0,65 = 16 trades pour +5 251 €. |
| **C2** | fallback `P_STRONG_MAX` | `bot-with-dashboard.ts` l.385, 464, 1122, 1163 | `0.75` | **`0.65`** | Idem (4 occurrences code). |
| **C2** | **bornage de la fenêtre apprise** | `bot-with-dashboard.ts` l.456-461 | clamp `[0,55 ; 0,80]` **ignorant .env** | clamp **`[P_STRONG_MIN ; P_STRONG_MAX]`** | ⚠️ **Correction critique** : la fenêtre auto-adaptative *écrasait* `P_STRONG_MAX` (le log affichait `[0.55 - 0.75]` → C2 sans effet). Voir §5. |
| **C5** | filtre d'edge par coin | `bot-with-dashboard.ts` l.1184 | actif (`learn.recent >= 8 && learn.wr > 0`) | **derrière `EDGE_FILTER_ENABLED`, défaut `false`** | wr par coin calculé sur des `realized` faux ; filtre actif = 42 trades −1 678 € vs 63 trades +619 €. |
| **C9** | écriture des HOLD | `bot-with-dashboard.ts` l.344-351 | HOLD écrits dans `history.json` | **`if (e.side === 'HOLD') return;`** (déjà en place, vérifié) | 298/300 entrées = HOLD → fenêtre de 300 ne couvrait que ~4 h. |
| **C9** | purge des HOLD | `~/.polymarket/history.json` | 300 entrées (HOLD inclus) | **38 entrées, 0 HOLD** | Aucun trade réel supprimé (25 YES + 13 NO conservés). |
| **C7** | `P_MIN_PRICE` (divergence) | `bot-with-dashboard.ts` l.1123, 1159 | `|| 0.15` | **`|| 0.25`** | Aligné sur `.env` (0.25). Divergence code/.env supprimée. |

`P_STRONG_MIN` reste `0.58` (inchangé), `P_MIN_PRICE` reste `0.25`, `P_STOP_LOSS` reste `25` (inerte, documenté).

---

## 2. Preuve : `npx tsc --noEmit` (exit 0)

```
$ cd /root/clawd/Polymarket-bot && npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```
(Aucune sortie = aucune erreur de compilation. Vérifié après **chaque** modification.)

---

## 3. Preuve : log après redémarrage — LLM DEGRADED + monitoring actif

Redémarrage PM2 (id 2, `polymarket-paperbot`) :

```
$ pm2 restart polymarket-paperbot
$ pm2 list | grep polymarket
│ 2  │ polymarket-paperbot │ default │ 0.4.3 │ fork │ 2021257 │ 78s │ 6 │ online │
```

Extrait `paperbot.log` (démarrage 2026-09-26T10:03) :

```
2026-09-26T10:03:32: [2026-09-26T10:03:32.768Z] 📋 🤖 DeepSeek LLM analysis module: DEGRADED (local HOLD — no API key / not enabled)
2026-09-26T10:03:35: [2026-09-26T10:03:35.160Z] • Auto-adaptation coins → BTC: WR 78% (18) ×1.10 | ETH: WR 57% (7) ❄️ cooldown | DOGE: WR 67% (3) ×1.00 | XRP: WR 67% (3) ×1.00 | SOL: WR 83% (6) ×1.10
2026-09-26T10:03:35: [2026-09-26T10:03:35.161Z] • Fenêtre apprise → [0.58 - 0.65] (étude 0.55-0.60:79% 0.60-0.65:50% 0.65-0.70:67% 0.70-0.75:86%)
2026-09-26T10:03:36: [2026-09-26T10:03:36.366Z] 🎯    ↳ 📈 XRP/USD $1.5437 · XRP Up or Down - September 26, ~50/50 ... → HOLD (pas de LLM)
2026-09-26T10:03:36: [2026-09-26T10:03:36.750Z] 📋 🚀 Bot + Dashboard running! Press Ctrl+C to stop.
2026-09-26T10:03:36:               POLYMARKET BOT v3.0 STATUS
2026-09-26T10:03:36:   Mode:           🧪 DRY RUN
2026-09-26T10:03:36:   Status:         ▶️ ACTIVE
2026-09-26T10:03:46: [DipArb] checkRotation: timeUntilEnd=674s, preloadMs=120s, nextMarket=none
2026-09-26T10:04:26: [DipArb] 💓 Monitoring active. BTC/USD $84,068 (maj il y a 5s)
```

**Lecture :**
- ✅ `DEGRADED (local HOLD — no API key / not enabled)` → module LLM toujours désactivé, décision 100 % déterministe.
- ✅ `Monitoring active` + rounds scannés (BTC/ETH/SOL/XRP/DOGE) → bot opérationnel.
- ✅ `Fenêtre apprise → [0.58 - 0.65]` → **C2 effectif** (avant le correctif de bornage : `[0.55 - 0.75]`).
- ✅ `BTC ... ×1.10` / `SOL ×1.10` → **C6 effectif** (avant : `×1.50`).

### Zéro token LLM confirmé

```
$ cat /root/.polymarket/llm-calls.json
{"date":"2026-09-12","calls":0}
```
`calls: 0` — aucun appel LLM. `DEEPSEEK_ANALYZER_ENABLED=false` inchangé dans `.env`.

---

## 4. Preuve : purge des HOLD de `history.json`

```
avant  : 300 entrées  (262 HOLD)
après  :  38 entrées  (0 HOLD)   → 25 YES + 13 NO (trades réels intacts)
```
- **262 entrées HOLD retirées**, **aucun trade réel supprimé** (contrôle : tous les `side != 'HOLD'` conservés).
- Fenêtre désormais : elle couvrira plusieurs jours (plus d'éviction des trades en ~4 h).
- Après redémarrage, `history.json` reste à 38 entrées / 0 HOLD → le garde-fou code (`if (e.side === 'HOLD') return;`) fonctionne.

---

## 5. ⚠️ Découverte importante (au-delà du périmètre littéral de C2)

Le code de sélection du côté appliquait la **fenêtre apprise** et *non* `.env` :

```ts
const STRONG_MAX = learnedMin ? learnedMax : ((Number(process.env.P_STRONG_MAX ?? '') || 0.65));
```

`learnedMin` étant toujours défini (initialisé à 0,58), le ternaire retourne **toujours** la valeur apprise. Et l'apprentissage bornait `learnedMax` à **0,80** (`Math.min(0.80, …)`), ignorant `.env`. Résultat : changer `P_STRONG_MAX=0.65` dans `.env` **n'avait aucun effet** — le log affichait `Fenêtre apprise → [0.55 - 0.75]`.

**Correctif appliqué** (l.456-461) : la fenêtre apprise est bornée par la config `.env` :

```ts
const cfgMin = Number(process.env.P_STRONG_MIN ?? '') || 0.58;
const cfgMax = Number(process.env.P_STRONG_MAX ?? '') || 0.65;
learnedMin = Math.max(cfgMin, learnedMin);
learnedMax = Math.min(cfgMax, learnedMax);
```

Après correctif, le log confirme `Fenêtre apprise → [0.58 - 0.65]`. Sans ce clamp, C2 était mort-né.

---

## 6. Fichiers & sauvegardes

**Modifiés :**
- `bot-with-dashboard.ts` (C2 clamp + fallbacks, C3 fallback+commentaire, C5 flag, C6 kellyCeil, C7 P_MIN_PRICE)
- `.env` (C2, C3, C5)
- `~/.polymarket/history.json` (purge HOLD)

**Sauvegardes créées :**
- `bot-with-dashboard.ts.bak-20260926-095944`
- `.env.bak-AVANT`
- `~/.polymarket/history.json.bak-AVANT`

**Non touchés :** `/root/.hermes/scripts/paperbot-pnl.py` (C1 déjà corrigé/vérifié par ailleurs), `src/**`, autres fichiers.

---

## 7. Réserves d'honnêteté (reprises de la revue)

- C2/C6 restent des **hypothèses** : n = 63 trades sur 3 jours, IC95 larges. Le clamp et le plafond Kelly sont **prudents**, pas calibrés.
- L'edge global (+0,0098 €/trade, `t = 0,11`) n'est **pas** statistiquement prouvé ; ~20 000 trades seraient nécessaires pour le conclure.
- `EDGE_FILTER_ENABLED=false` et `kellyCeil=0.05` sont **provisoires** : à ré-évaluer quand `n_resolus ≥ 200` et que les `realized` sont fiables (C1).
- Erreurs bénignes préexistantes (non introduites) : `[DipArb] … NETWORK_ERROR` (RPC) et `onMessage error` (WebSocket `ws-live-data.polymarket.com`, 370 occurrences depuis 00:00).