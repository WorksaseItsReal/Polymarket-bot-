# COSTS.md — Réalisme d'exécution & coûts réels (Up/Down 5m)

**Bot analysé :** `/root/clawd/Polymarket-bot` — bot PAPER, IA off, mise simulée 1 €.
**Mesures :** 100 % lecture seule, GET publics Gamma + CLOB. Aucun ordre, aucune clé, aucune transaction.
**Date des mesures :** 2026-09-26, 22:53–23:12 UTC (19 min de *watch*, 59 snapshots) + sondes complémentaires.
**Script :** `measure_costs.py` (ce dossier). Sondes : `_zone_probe.py`, `_zone_58_65.py`, `_verify_tick.py`, `_verify_tokens.py`.
**Données brutes :** `snapshots.jsonl` (59 snapshots), `zone_58_65.json` (75 obs. en zone bot).

---

## 0. Réponse directe à la question posée

> **« Est-ce que le bot mise plus gros que la profondeur disponible au meilleur prix ? »**

**En paper, non par construction (il ne mise que 0,65–1,30 €). En réel, oui dans ~18 % des cas — et de toute façon le bot ne peut PAS passer ses ordres :**

1. **L'ordre minimum live est 5 USDC notionnels** (`orderMinSize = 5`, confirmé docs Polymarket « minimum order size in USDC »). La mise paper du bot (0,65–1,30 €) est **4 à 8× sous ce minimum** : ses décisions ne sont pas exécutables telles quelles. Tout ordre réel devrait être **≥ 5 $**, soit **≥ 3,8× la mise simulée** de 1 €.
2. À 5 $, la profondeur au meilleur ask est **insuffisante dans 17,7 % des observations de la zone de mise [0,58–0,65]** (11/62) et **21,3 %** sur l'ensemble des côtés (235/1102). Le premier niveau d'ask ne contient souvent que **5 parts (~3 $)** — voir §3.
3. **Le bot ne regarde JAMAIS la profondeur avant de miser** : `bot-with-dashboard.ts:1170-1203` lit `orderbook.yes.ask` / `no.ask` et décide sans aucun contrôle de `askDepth`. Il n'y a donc aucune protection contre le dépassement de profondeur.

---

## 1. Paramètres de marché réellement mesurés

### 1.1 Tick et taille minimale

Commande :
```
python3 _verify_tick.py
```
Extrait brut (market 1790463600, en cours) :
```
BTC  btc-updown-5m-1790463600   gammaTick=0.01 gammaMin=5 fee=crypto_fees_v2
     YES tick=0.01 min=5 bestBid=(0.6, 967.91) bestAsk=(0.61, 5.0)
     NO  tick=0.01 min=5 bestBid=(0.39, 5.0) bestAsk=(0.4, 967.91)
XRP  xrp-updown-5m-1790463600   gammaTick=0.01 gammaMin=5 fee=crypto_fees_v2
     YES tick=0.01 min=5 bestBid=(0.49, 23.0) bestAsk=(0.5, 5.0)
     NO  tick=0.01 min=5 bestBid=(0.5, 5.0) bestAsk=(0.51, 18.0)
```

Répartition du tick sur **590 lectures** de `book.tick_size` :
| source | valeur | n |
|---|---|---|
| gamma `orderPriceMinTickSize` | **0.01** | 581 |
| gamma | 0.001 | 9 |
| clob `book.tick_size` | **0.01** | 568 |
| clob | 0.001 | 22 |

> **Correction de l'hypothèse de départ :** le tick **n'est pas 0,001 mais 0,01** pour ces marchés 5m crypto. Le 0,001 n'apparaît qu'en fin de round (prix collés à 0,001–0,01 lors de la résolution — ex. marché résolu : `yes bestAsk=0.001 size=35071`). Le pas réel de cotation est **1 cent**.

**Taille minimale :** `min_order_size = 5` (USDC notionnel) — constant sur les 5 coins et les 6 rounds observés.
**Type de frais :** `feeType = crypto_fees_v2`, `feesEnabled = true` sur 100 % des marchés.

### 1.2 Structure du carnet (le piège de l'ordre des asks)

La réponse `/book` renvoie les **asks du plus cher au moins cher** — confirmé :
```
$ curl -s "https://clob.polymarket.com/book?token_id=5527478594..." 
asks (as returned, first 5): [{'price':'0.99','size':'8510.97'},{'0.98'},{'0.97'},{'0.96'},{'0.95'}]
tick_size: 0.01  min_order_size: 5  neg_risk: False  last_trade: 0.050
```
→ **Il faut trier pour trouver le meilleur ask exécutable.** `measure_costs.norm_book()` trie systématiquement.

Les deux tokens sont des **miroirs exacts** (`yes.ask = 1 − no.bid`) :
```
YES bestAsk=(0.61, 5.0)   <->   NO bestBid=(0.39, 5.0)
YES bestBid=(0.60, 967.9) <->   NO bestAsk=(0.40, 967.9)
```
Conséquence : **acheter le favori (prix haut) revient souvent à croiser le côté mince** ; le côté opposé est profond. Ex. BTC : acheter YES @0.61 = 5 parts (3,05 $) ; acheter NO @0.40 = 968 parts (387 $).

---

## 2. Spread réel et profondeur (a)

### 2.1 Échantillon global — 59 snapshots, 1024 côtés mesurés

```
python3 measure_costs.py watch --minutes 19 --interval 18   (extrait du résumé)
SPREAD  p10=0.0100  p50=0.0100  p90=0.0600  mean=0.0396  max=0.78
DEPTH@top  p10=2.55  p50=12.91  p90=103.60  min=0.01  max=2679.42
DEPTH@top+2c  p10=12.47  p50=42.01  p90=286.41
  # depth@top < $5 : 235/1102 = 21.3 %
```

### 2.2 Par coin (médiane de la profondeur au meilleur ask)

| coin | n | spread p50 | depth@top p50 | depth@top p10 | depth@top min |
|---|---|---|---|---|---|
| BTC | 21 | 0.01 | **14,99 $** | 11,99 $ | 11,99 $ |
| ETH | 16 | 0.01 | **18,24 $** | 2,90 $ | 2,90 $ |
| DOGE | 19 | 0.01–0.05 | **9,70 $** | 3,30 $ | 3,30 $ |
| SOL | 12 | 0.01 | **8,77 $** | 3,20 $ | 3,20 $ |
| XRP | 7 | 0.01 | **10,98 $** | 3,15 $ | 3,15 $ |

> **Écart avec l'état « mesuré » fourni en hypothèse** (« profondeur médiane ~401–1 150 USDC ») : je mesure une **médiane ~12–18 USDC**. Cette différence vient presque sûrement de la **définition** : la valeur `liquidity` de Gamma (ex. BTC = 12 232 $) ou la profondeur cumulée sur tous les niveaux du carnet donnent des centaines/milliers d'USDC ; la **profondeur au meilleur ask** — celle réellement exécutable au top — est **~12 $ médiane**. Ex. cumul jusqu'à ask+2c : p50 = 42 $ (déjà 3,5× plus). Toutes mes conclusions portent sur le **top-of-book**, conforme à la définition demandée (« combien d'USDC exécutables au top »).

---

## 3. Prix bot vs prix réellement exécutable (b)

Le bot prend `orderbook.yes.ask` comme prix et calcule `retour = 1/ask − 1`. Voici le prix réel (VWAP, traversée du carnet) pour 1 € / 5 € / 10 € / 100 € — extraits bruts de `zone_58_65.json` (obs. en zone bot) :

| coin | côté | best ask | depth@top | VWAP 5 € | VWAP 10 € | VWAP 100 € | prix bot utilisé |
|---|---|---|---|---|---|---|---|
| BTC | yes | 0.60 | 13,0 $ | 0.6000 | 0.6000 | **0.6246** | 0.60 |
| ETH | no  | 0.61 | 10,7 $ | 0.6100 | 0.6100 | **0.6262** | 0.61 |
| DOGE| yes | 0.63 | 11,3 $ | 0.6300 | 0.6300 | **0.6726** | 0.63 |
| SOL | no  | 0.62 | 6,2 $  | 0.6200 | **0.6237** | **0.6559** | 0.62 |
| XRP | yes | 0.65 | 3,3 $  | **0.7083** | **0.7807** | **0.8777** | 0.65 |
| DOGE| yes | 0.59 | 10,6 $ | 0.5900 | 0.5900 | **0.7713** | 0.59 |

Synthèse du slippage (VWAP vs meilleur ask), 75 obs. zone [0,56–0,67] :

| taille | slippage p50 | slippage p90 | slippage max | obs. non remplissables au top |
|---|---|---|---|---|
| **1 €** | 0,000 % | — | — | ~0 % |
| **5 €** | 0,000 % | 0,604 % | **10,42 %** | 8/75 |
| **10 €** | 0,000 % | 1,573 % | **22,25 %** | 26/75 |
| **100 €** | **3,770 %** | **11,203 %** | **37,14 %** | **70/75** |

> À 1 € et souvent à 5 €/10 €, le bot remplit pile au meilleur ask → **son prix est correct en petit**. Mais **dès 100 €**, 93 % des observations glissent (médiane +3,8 %, jusqu'à +37 %). Et **17,7 % des obs. zone ne peuvent même pas absorber 5 $ au top** (le minimum live).

Cas extrême mesuré (XRP, ask 0.65, top = 5 parts / 3,25 $) :
```
XRP yes ask=0.65 spread=0.15 dep_top=$3.25  VWAP5=0.7083 VWAP10=0.7807 VWAP100=0.8777
     asks=[(0.65,5.0),(0.85,5.0),(0.89,204.0),(0.9,5.0),(0.91,506.01)]
```
→ 5 € payés donnent un VWAP de 0,7083 (+9 %) : le bot annoncerait le round « YES @0,65 » et paierait en réalité ≈ 0,71.

---

## 4. Coût d'entrée TOTAL et WR break-even réel (c)

Formule officielle des frais (takers uniquement) : `fee = C · feeRate · p · (1−p)`, **crypto = 0,07**.
En % de la mise S (C = S/p) : **`fee% = 0,07·(1−p)`**.
Coût taker+slippage en % de mise retenu ici = **demi-spread/p + frais taker** (demi-spread = spread/2 = 0,005 = médiane mesurée).
Break-even : `WR·(1/p − 1 − fee) = (1−WR)·(1+fee)` ⟹ **`WR_be = p·(1 + feeRate·(1−p))`**.

### 4.1 Table par tranche de prix (dans la zone de mise du bot)

| p (prix payé) | be paper = p | frais taker % mise | demi-spread % mise | **coût total % mise** | **WR break-even réel** | Δ vs paper |
|---|---|---|---|---|---|---|
| 0,58 | 58,00 % | 2,940 % | 0,862 % | **3,802 %** | **59,71 %** | **+1,71 pt** |
| 0,60 | 60,00 % | 2,800 % | 0,833 % | **3,633 %** | **61,68 %** | **+1,68 pt** |
| 0,62 | 62,00 % | 2,660 % | 0,806 % | **3,466 %** | **63,65 %** | **+1,65 pt** |
| **0,6488** (prix moyen bot) | 64,88 % | 2,458 % | 0,771 % | **3,229 %** | **66,48 %** | **+1,60 pt** |
| 0,65 | 65,00 % | 2,450 % | 0,769 % | **3,219 %** | **66,59 %** | **+1,59 pt** |
| 0,70 | 70,00 % | 2,100 % | 0,714 % | 2,814 % | 71,47 % | +1,47 pt |
| 0,74 | 74,00 % | 1,820 % | 0,676 % | 2,496 % | 75,35 % | +1,35 pt |

Avec le **slippage de taille** (carnet réel) en plus :

| taille | WR break-even réel @p=0,6488 | Δ vs paper |
|---|---|---|
| 5 € | **66,48 %** | +1,60 pt |
| 10 € | **66,48 %** | +1,60 pt |
| **100 €** | **68,92 %** | **+4,04 pt** |

> **Le coût dominant est le frais taker (2,45–2,94 % de la mise), pas le spread.** Le demi-spread ne pèse que 0,7–0,9 %. Le passage paper→réel exige **+1,6 point de win-rate** à petite taille, **+4,0 points à 100 €**.

---

## 5. Impact sur le PnL paper (d)

Chiffres de référence du bot (source interne `docs/EDGE-VALIDATION.md`, n=1411 décisions réelles) :
```
décisions : n=1411  prix moyen payé=0.6488  WR réel=63.22%  break-even=64.88%  marge=-1.67 pt  EV mesurée=-0.0253 €/trade
```
**Le bot perd déjà de l'argent au prix paper** (EV −0,0256 €/trade sur 1 € misée : WR 63,22 % < break-even 64,88 %).

Sous exécution réelle, en ajoutant le frais taker `fee = 0,07·(1−0,6488) = 2,458 %` de la mise :

| | WR requis | EV / trade (mise 1 €) |
|---|---|---|
| **Paper (bot actuel)** | 64,88 % | **−0,0256 €** |
| Réel, taille 5–10 € (frais seuls) | 66,48 % | **−0,0502 €** (≈ ×2 la perte paper) |
| Réel, 5 € + slippage p90 (0,6 %) | 66,48 % | −0,0562 € |
| Réel, 10 € + slippage p90 (1,6 %) | 66,48 % | −0,0662 € |
| Réel, 100 € + slippage p50 (3,8 %) | 68,92 % | −0,0882 € |

> **Part du PnL paper qui survivrait à une exécution réelle : ~0 % — le PnL paper est déjà négatif, et le réel double environ la perte.**
> Si l'on prend la lecture optimiste du bot (échantillon 100 trades : WR 68 %, PnL +3,03 €), le frais taker (≈ 2,5 % de mise/trade) retirerait **≈ 2,5 € de ces 3,03 €** — soit ~80 % du gain paper effacé, **avant** slippage. Dans les deux lectures, l'exécution réelle fait basculer le résultat : **le paper n'est pas transposable**.

---

## 6. Conclusion chiffre par chiffre

| Question | Mesure |
|---|---|
| Tick réel | **0,01** (99 % des lectures), pas 0,001 |
| Taille min live | **5 USDC notionnels** |
| Mise du bot (paper) | **0,65–1,30 €** (1 € × sizeFactor) → **sous le minimum live** |
| Spread médian | **0,01** (p90 = 0,06) |
| Profondeur au meilleur ask (médiane) | **~12–18 $** selon le coin (p10 ≈ 3 $) |
| Profondeur au top < 5 $ (min live) | **21,3 %** de tous les côtés ; **17,7 %** en zone bot |
| Coût d'entrée total en zone bot | **3,2–3,8 % de la mise** (≈ 2,5–2,9 % frais + 0,7–0,9 % demi-spread) |
| WR break-even réel @p=0,6488 | **66,48 %** (paper 64,88 %) — **+1,60 pt** |
| WR break-even réel @100 € | **68,92 %** — **+4,04 pt** |
| PnL paper qui survit | **≈ 0 %** (paper déjà EV −0,0256 €/trade ; réel ≈ −0,050 €/trade) |

**À partir de quelle taille la profondeur devient un problème ?**
- **≤ 5 $** : problème **intermittent** — 17,7 % de la zone bot ne peut pas absorber le minimum live au meilleur prix (il faut manger 1–2 niveaux, +0,6 % p90).
- **10 $** : ~35 % des obs. glissent (26/75), p90 +1,6 %.
- **100 $** : problème **systématique** — 93 % des obs. glissent, médiane +3,8 %, pire cas +37 % ; le break-even monte à 68,9 %.

**Cause racine :** le bot fixe son prix sur `orderbook.yes.ask`/`no.ask` et l'annonce comme exécutable, sans jamais consulter la profondeur. Sur ces carnets 5m, le premier ask ne contient typiquement que **5–25 parts (~3–15 $)**, et le côté favori (celui que le bot achète) est souvent **le côté mince**. Le prix du bot n'est réaliste que pour une mise de l'ordre de **quelques euros**, jamais pour ce que le minimum live impose ni pour 100 €.

---

## 7. Reproductibilité

```bash
cd /root/clawd/Polymarket-bot/docs/rebuild/execution
python3 measure_costs.py snapshot                       # 1 passe
python3 measure_costs.py watch --minutes 19 --interval 18   # 59 snapshots
python3 _verify_tick.py                                 # tick/min live
python3 _zone_58_65.py 300                              # obs. zone bot
```
Sorties brutes : `snapshots.jsonl`, `zone_58_65.json`, `zone_hits.json`.
