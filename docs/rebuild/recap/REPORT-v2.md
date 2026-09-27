# REPORT-v2 — Réparation du message Telegram du paperbot

Script : `/root/.hermes/scripts/paperbot-recap.py` (seul fichier modifié).
Date de rédaction : 2026-09-27, ~12:43 UTC. Toutes les sorties ci-dessous sont des
sorties de commandes réelles (aucune valeur inventée). `send()` / `main()` n'ont
JAMAIS été appelés pendant les tests — seul `build_message()` et `dedup_key()`.

---

## 1. BUG PRINCIPAL (le mensonge) — prouvé

`round_info()` lisait `outcomePrices` de l'API **GAMMA**. Pour un marché 5m non
résolu ce champ est **seedé/figé** et ne reflète PAS le carnet.

Comparaison à un même instant (slot 1790512800 = 12:40→12:45 UTC), source Gamma vs
carnet CLOB réel (`/book?token_id=`, asks triés, meilleur ask = le moins cher) :

```
=== 12:43:31 slot 1790512800 : Gamma(SEEDE) vs CLOB(REEL) ===
  BTC   gamma.op=["0.625", "0.375"]  |  clob up=0.88 down=0.13
  ETH   gamma.op=["0.765", "0.235"]  |  clob up=0.81 down=0.21
  SOL   gamma.op=["0.475", "0.525"]  |  clob up=0.34 down=0.72
  XRP   gamma.op=["0.445", "0.555"]  |  clob up=0.95 down=0.06
  DOGE  gamma.op=["0.535", "0.465"]  |  clob up=0.35 down=0.69
```

Exemple frappant : **XRP** — le recap v1 affichait `UP 45% / DOWN 56%` alors que le
bot tradait un marché où **UP = 0.95**. Un autre tir (12:36) montrait ETH à
`0.545/0.455` côté Gamma contre `0.13/0.88` côté carnet réel.

Le recap annonçait donc ~50/50 pendant que le bot voyait un favori écrasant : c'est
un mensonge à l'utilisateur. La source de vérité est le **carnet CLOB**, exactement
comme le bot (`src/services/market-service.ts` : `asks.sort((a,b)=>a.price-b.price)`
puis `asks[0]` → `orderbook.yes.ask` / `orderbook.no.ask`).

---

## 2. CORRECTIONS

### (a) Probas UP/DOWN lues au VRAI carnet CLOB
- Nouvelle fonction `best_ask(token_id)` : `GET /book?token_id=…`, tri croissant des
  asks, on prend le premier (= le MOINS cher = le prix réellement payé pour ACHETER).
  Même sémantique que le bot.
- `round_info()` récupère les `clobTokenIds` du marché Gamma (structure fiable, ordre
  `["Up","Down"]`) puis lit les deux carnets. `outcomePrices` n'est **plus jamais** affiché.
- Carnet indisponible → on affiche `<b>carnet CLOB indisponible</b> — proba réelle
  inconnue` (on ne retombe PAS sur la valeur seedée).

### (b) Ask BRUT + pourcentage normalisé
Chaque coin affiche désormais les deux, comme le bot le fait dans son log
(« ask brut UP 0.93 / DOWN 0.08 ») :
```
· XRP: UP 95% / DOWN 5% · ask brut 0.97 / 0.05
```
Le raw est la valeur qui DÉCIDE ; le % (normalisé pour sommer à 100) sert à lire.

### (c) Verdict fenêtre d'entrée par coin
Fenêtre `[P_STRONG_MIN, P_STRONG_MAX]` **lue dans le `.env` du bot** (`0.58` / `0.65`),
+ garde `P_MIN_PRICE=0.25`. Une ligne explique pourquoi le bot mise ou pas :
```
   ↳ ✅ DANS la fenêtre [0.58–0.65] → le bot mise UP @ 0.64
   ↳ ⏸️ HORS fenêtre [0.58–0.65] : favori UP trop net (ask 0.70 > 0.65 : gain trop faible) → le bot ne mise pas
   ↳ ⏸️ HORS fenêtre [0.58–0.65] : pas de favori net (meilleur ask 0.51 < 0.58 → ~50/50) → le bot ne mise pas
```

---

## 3. AUDIT DES AUTRES LIGNES (d)

| Ligne / champ | Constat | Action |
|---|---|---|
| `· <coin>: UP x% / DOWN y%` | valeurs seedées Gamma (bug principal) → trompeur | **corrigé** (carnet CLOB) |
| `📐 Edge: moy 0.25$/mise` | la moyenne est un PnL réalisé **par trade**, pas par 1 € misé → unité fausse | **corrigé** → `$`**`/trade`** |
| `❌ XRP YES @ $ 0.60` | espace parasite (`$ 0.60`) | **corrigé** → `@ $0.60` |
| `🎯` utilisé 3× (Rounds, Win rate, Fenêtre apprise) | doublon d'emoji, ambiguïté | Win rate → `🏆` |
| `📊 POLYMARKET — Up/Down 5m (5 coins)` | exact | inchangé |
| `🔁 Round: <fenêtre>` | dérivé du dernier « New round » du log → pouvait être périmé et contredire les coins | **corrigé** : dérivé du slot courant réellement interrogé |
| `fmt_live()` | fonction morte (jamais appelée) | **supprimée** |
| `à battre … (ouverture)` vs `Prix live` | le prix live apparaît 2× (section + ligne « à battre ») — redondance informative, pas un bug | inchangé (utile pour lire la variation) |
| `PnL réalisé (résolu): $+35.28 · 160 trades` | cohérent avec `pnl.json` | inchangé |
| `⏳ … en attente` | correct | inchangé |
| `Annual`/unités prix (`fmtp`) | BTC $85,008 / XRP $1.5440 / DOGE $0.09872 distincts, pas de doublon | inchangé |
| `Mise simulée 5€/décision` | lue dans `.env` (`BET_STAKE=5`) | inchangé |
| Mode IA / déterministe | cohérent (`DEEPSEEK_ANALYZER_ENABLED` non activé → mode déterministe) | inchangé |

---

## 4. PREUVES D'EXÉCUTION (e)

### 4.1 AVANT (v1, extrait) — `build_message()` au 12:37
```
🎯 <b>Rounds en cours / à venir</b>
· Bitcoin: <b>UP 68%</b> / DOWN 32%
· Ethereum: <b>UP 55%</b> / DOWN 45%
· Solana: <b>UP 94%</b> / DOWN 6%
· XRP: <b>UP 48%</b> / DOWN 52%
· Dogecoin: <b>UP 50%</b> / DOWN 50%
```
(ces % venaient de `outcomePrices` Gamma — cf. §1 : ETH 55/45 affiché alors que le
carnet réel était 13/88.)

### 4.2 APRÈS (v2) — `build_message()`, message tel qu'envoyé (marqueurs VOL retirés)
```
📊 <b>POLYMARKET — Up/Down 5m (5 coins)</b>
🕐 <b>12:43</b> — Paper (dry) · cycle 5 min
🔁 Round: <b>12:40→12:45</b>

💲 <b>Prix live</b>
₿ <b>Bitcoin</b>  $85,008
Ξ <b>Ethereum</b>  $2,715
◆ <b>Solana</b>  $124.13
✕ <b>XRP</b>  $1.5440
Ð <b>Dogecoin</b>  $0.09872

🎯 <b>Rounds en cours / à venir</b>
· Bitcoin: <b>UP 69%</b> / DOWN 31% · ask brut <b>0.70</b> / <b>0.31</b>
   ↳ ⏸️ <b>HORS fenêtre [0.58–0.65]</b> : favori UP trop net (ask 0.70 &gt; 0.65 : gain trop faible) → le bot ne mise pas
   à battre <b>Bitcoin</b>: $85,013 (ouverture) · live $85,008 (-0.01%)
· Ethereum: <b>UP 85%</b> / DOWN 15% · ask brut <b>0.86</b> / <b>0.15</b>
   ↳ ⏸️ <b>HORS fenêtre [0.58–0.65]</b> : favori UP trop net (ask 0.86 &gt; 0.65 : gain trop faible) → le bot ne mise pas
   à battre <b>Ethereum</b>: $2,715 (ouverture) · live $2,715 (+0.00%)
· Solana: <b>UP 18%</b> / DOWN 82% · ask brut <b>0.19</b> / <b>0.84</b>
   ↳ ⏸️ <b>HORS fenêtre [0.58–0.65]</b> : favori DOWN trop net (ask 0.84 &gt; 0.65 : gain trop faible) → le bot ne mise pas
   à battre <b>Solana</b>: $124.15 (ouverture) · live $124.13 (-0.02%)
· XRP: <b>UP 95%</b> / DOWN 5% · ask brut <b>0.97</b> / <b>0.05</b>
   ↳ ⏸️ <b>HORS fenêtre [0.58–0.65]</b> : favori UP trop net (ask 0.97 &gt; 0.65 : gain trop faible) → le bot ne mise pas
   à battre <b>XRP</b>: $1.5429 (ouverture) · live $1.5440 (+0.07%)
· Dogecoin: <b>UP 6%</b> / DOWN 94% · ask brut <b>0.06</b> / <b>0.95</b>
   ↳ ⏸️ <b>HORS fenêtre [0.58–0.65]</b> : favori DOWN trop net (ask 0.95 &gt; 0.65 : gain trop faible) → le bot ne mise pas
   à battre <b>Dogecoin</b>: $0.09887 (ouverture) · live $0.09872 (-0.15%)

🟢 <b>PnL réalisé (résolu): $+35.28</b> · 160 trades
🏆 Win rate: <b>69.4%</b> (111W / 49L) · 2 en attente
📐 <b>Edge</b>: moy <b>+0.22$</b>/trade · t-stat <b>+1.56</b> (n=160, seuil 1.96) → <b>non significatif (bruit)</b>
📈 <b>Derniers trades résolus</b>
❌ <b>DOGE</b> YES @ $0.64 → <b>$-5.00</b>
✅ <b>SOL</b> NO @ $0.64 → <b>$+2.81</b>
✅ <b>ETH</b> NO @ $0.63 → <b>$+2.94</b>
✅ <b>ETH</b> YES @ $0.60 → <b>$+3.33</b>
✅ <b>SOL</b> YES @ $0.63 → <b>$+2.94</b>
❌ <b>XRP</b> NO @ $0.58 → <b>$-5.00</b>

🧠 <b>Auto-apprentissage</b>: BTC: WR 80% (20) ×1.00 | ETH: WR 55% (11) ×1.00 | DOGE: WR 64% (11) ❄️ cooldown | XRP: WR 50% (12) ❄️ cooldown | SOL: WR 85% (20) ×1.10
🎯 <b>Fenêtre apprise</b>: [0.58 - 0.65]

⚙️ <b>Mode déterministe</b> — IA désactivée : le bot mise le favori du carnet dans la fenêtre apprise, zéro appel LLM.

<i>Mise simulée 5€/décision · aucun ordre réel · bot continue</i>
```

### 4.3 Concordance source recap ⇔ bot (même instant)
Bot (son propre SDK/CLOB, log `paperbot.log`) à **12:42:10** :
```
🎯 ↳ 📈 SOL/USD $124.13 · Solana Up or Down - September aucun favori dans [0.58 - 0.65] (ask brut UP 0.46 / DOWN 0.55) — UP 46% / DOWN 54% → HOLD
🎯 ↳ 📈 XRP/USD $1.5440 · XRP Up or Down - September 27, favori hors fenetre (ask brut UP 0.88 / DOWN 0.13 > 0.65) — UP 87% / DOWN 13% → HOLD
```
Ma lecture `best_ask()` à **12:42:38** (slot 1790512800) :
```
sol: up_best=0.5 down_best=0.53
xrp: up_best=0.93 down_best=0.09
```
Même source, mêmes tokens (léger drift de prix normal sur ces marchés très volatils :
BTC est passé de 0.65 à 0.77 en 26 s lors d'un contrôle).

### 4.4 Clé de dédup STABLE + jamais de `\x00`
`main()` a été refactoré pour utiliser `dedup_key(raw)` (comportement identique,
désormais testable). Test réel :
```
A) 2 appels consecutifs -> cle identique : True | len k1 1010 len k2 1010
B) prix/probas RADICALEMENT changés -> cle identique : True
C) cle SANS \x00 : True | message envoye SANS \x00 : True | brut CONTIENT des marqueurs VOL : True
```
- (A) deux `build_message()` réels consécutifs → clé identique.
- (B) `live_price`/`round_info` remplacés par des valeurs radicalement différentes
  → clé **inchangée** (les lignes volatiles sont bien exclues) ⇒ pas de re-spam toutes
  les 5 min.
- (C) la clé et le message envoyé ne contiennent jamais `\x00` ; le message brut
  contient bien les marqueurs `VOL`.
- Contre-test : la clé **change** quand un événement change
  (`dédup sensible aux événements : clé change si PnL change: True`) ⇒ la dédup n'est
  pas cassée en « toujours identique ».

### 4.5 Chemin dégradé
`best_ask` forcé à `None` → aucune fausse proba affichée :
```
· Bitcoin: <b>carnet CLOB indisponible</b> — proba réelle inconnue
· Ethereum: <b>carnet CLOB indisponible</b> — proba réelle inconnue
…
```

### 4.6 Compilation
```
$ python3 -m py_compile paperbot-recap.py   → COMPILE_OK
```

---

## 5. Fichiers
- Modifié : `/root/.hermes/scripts/paperbot-recap.py`
- Créé : `/root/clawd/Polymarket-bot/docs/rebuild/recap/REPORT-v2.md` (ce fichier)
- Aucun autre fichier touché ; `pm2 restart` jamais lancé ; aucun message réel envoyé.

## 6. Limites / non-résolu
- Le header `🔁 Round` utilise le slot **courant** (floor(now/300)*300), qui est bien
  le marché évalué par le bot (log : `New round: btc-updown-5m-1790512800` à 12:40).
  Si le bot scanne un round futur, le recap ne le montrera pas — hors périmètre demandé.
- `outcomePrices` Gamma reste stocké dans la réponse, mais n'est plus utilisé par le recap.
