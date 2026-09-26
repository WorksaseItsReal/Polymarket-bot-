# RISK.md — Gestion du risque pour une edge NON PROUVÉE

**Bot** : `Polymarket-bot` (papier, Up/Down 5m, 5 coins BTC/ETH/SOL/XRP/DOGE, mise simulée 1 €).
**Objet** : définir une gestion du risque **défendable** pour une edge **non prouvée**, et chiffrer ce qui se passe **si l'edge est en réalité nulle**.
**Simulation** : `monte_carlo.py` (numpy, 20 000 trajectoires × 1 000 trades, graine `20260926`).
**Données** : `/root/.polymarket/history.json` (snapshot figé dans `data_snapshot_history.json`).
Sortie brute complète des simulations : `run_output.txt`.

---

## 0. Réponse franche à la question posée

> **Est-ce qu'augmenter les mises est une bonne idée aujourd'hui ?**

**NON.** Pas aujourd'hui, pas à ce stade.

Trois raisons chiffrées, dans l'ordre d'importance :

1. **L'edge n'est pas prouvée.** `t ≈ 1.5` (IC95 du PnL total largement à cheval sur zéro). Rien ne distingue statistiquement le bot d'un tirage au sort légèrement chanceux.
2. **Le coût de l'erreur est asymétrique.** Si l'edge est réelle (WR 72 %), doubler la mise double le gain. Si l'edge est **nulle** — hypothèse parfaitement compatible avec `t=1.5` — la même mise multiplie une espérance de ~0 par le bruit : la probabilité de finir perdant passe de ~0 % à ~42 % (WR mesurée), et une mise ×5 sur une edge nulle donne **P(ruine sur 100 € de capital) = 15,6 %** alors que la même mise ×1 la donne à 0,01 %.
3. **La mise actuelle est déjà correctement dimensionnée.** Le plafond Kelly (`kellyCeil=0.05`) borne la mise à **0,65–1,10 €/trade**. C'est *conservateur*, pas dangereux. Il n'y a rien à corriger dans le sens de la hausse ; le seul vrai risque serait de lever ce plafond ou la mise de base.

**Conclusion opérationnelle** : garder le sizing actuel tel quel, **ne rien augmenter** jusqu'à ce que `n ≥ 200` trades résolus **et** `t ≥ 2`. Si à ce moment l'edge tient, alors — et seulement alors — envisager une hausse *progressive et plafonnée*.

---

## 1. État mesuré (re-vérifié)

Recalculé depuis `/root/.polymarket/history.json` (donnée **vivante** : elle a bougé pendant ce travail, 64 → 65 trades) :

| Grandeur | Valeur mesurée | Cohérence avec le brief |
|---|---|---|
| n résolus | 64–65 | brief : 57–120 ✔ |
| Win rate | **70,8 – 71,9 %** (46 W / 19 L) | brief : ~72 % ✔ |
| Entrée moyenne | **0,6277** | brief : 0,61 ~✔ |
| Break-even WR = entrée moyenne | **62,8 %** | brief : 63,3 % ~✔ |
| PnL / trade (mise 1 €) | **+0,136 €** | brief : +0,136 € ✔ |
| Écart-type | **0,715** | brief : 0,71 ✔ |
| Erreur-type | **0,0887** | brief : 0,094 ~✔ |
| **t** | **1,54** | brief : **1,44** ✔ (même conclusion) |
| PnL total | **+8,86 €** | — |
| IC95 du PnL total | **[−2,43 € ; +20,16 €]** | brief : [−2,78 ; +18,30] ✔ |

**Lecture** : `|t| < 1,96` → **non significatif**. L'intervalle de confiance à 95 % du PnL total contient zéro. On ne peut pas rejeter l'hypothèse « edge = 0 ».

*Note de mécanique* : sur un marché **binaire réglé tout-ou-rien**, un stop-loss est **inerte** (le token ne dérive pas continûment, il saute de `prix` à 1 ou 0 à la cloche), et chaque perte vaut **exactement −1,00** (100 % de la mise). L'espérance par trade vaut `E = p·(1/e − 1) − (1 − p) = p/e − 1`, positive **seulement si `p > e`**. Le **seul** levier réel est donc le prix d'entrée face à la winrate prouvée.

---

## 2. (a) Monte-Carlo — 20 000 trajectoires × 1 000 trades, mise fixe 1 €

Prix d'entrée tirés par bootstrap sur les prix réels (dispersion conservée) ; gain si victoire = `1/e − 1`, perte = `−1,00` entier. BE = moyenne(prix) ≈ 0,628.

| Scénario | WR | Espérance/trade | P5 | P50 | P95 | **P(PnL total < 0)** |
|---|---|---|---|---|---|---|
| **A. edge mesurée** | 72,0 % | +0,147 € | **+115,4 €** | +152,7 € | **+190,0 €** | **0,0 %** |
| **B. edge ZÉRO** | 62,8 % (= BE) | 0,000 € | **−36,0 €** | +4,9 € | **+45,2 €** | **42,1 %** |
| **C. brief « négatif » WR 65 %** ⚠️ | 65,0 % | **+0,036 €** (positif !) | **+0,9 €** | +40,4 € | **+80,4 €** | **4,7 %** |
| C′. vrai négatif | 60,0 % | −0,044 € | −80,8 € | −39,4 € | +1,7 € | **94,2 %** |
| C″. vrai négatif | 55,0 % | −0,124 € | −161,5 € | −119,9 € | −78,0 € | **100,0 %** |
| Réf. pile ou face | 50,0 % | −0,203 € | −241,4 € | −200,0 € | −158,6 € | 100,0 % |

### ⚠️ Correction honnête sur le scénario « edge négatif (WR 65 %) »

Le brief classe **WR 65 %** comme « edge négatif ». **C'est faux** avec une entrée moyenne à 0,628 : le break-even vaut ≈ 62,8 %, donc **65 % est encore POSITIF** (+2,2 pt → espérance +0,036 €/trade, P(PnL<0) = 4,7 % après 1000 trades). Pour un scénario réellement négatif, il faut une WR **sous 62,8 %** ; j'ai donc ajouté **60 %** et **55 %**, qui sont les seuls cas vraiment perdants.

### Ce que dit la ligne B (edge = zéro) — la plus importante

Sur 1 000 trades à 1 €, si l'edge est nulle :
- le résultat **médian** est ≈ **+5 €** (bruit), mais
- **42,1 % des trajectoires finissent NÉGATIVES**, et
- l'intervalle 5 %–95 % s'étale de **−36 € à +45 €** — soit **±40 € d'incertitude pure** pour un capital engagé de 1 000 €.

Autrement dit : **le PnL observé (+8,86 € sur 65 trades) est exactement du calibre attendu d'une edge nulle.** C'est la définition de « non prouvé ».

**Drawdowns (mise 1 €)** : sous edge mesurée, drawdown médian 8,4 €, Q95 13,2 € — bénin. Sous edge **zéro**, drawdown médian **25,9 €**, Q95 **51,4 €** — sur des mises unitaires de 1 €, sans aucun gain réel pour compenser. La plus longue série de pertes consécutives est de 7 (médiane mesurée) à 9–13 (edge nulle / pile ou face).

---

## 3. (b) Taille de mise au-delà de laquelle la variance devient intenable

Avec `b = gain_moyen/|perte| = 0,6004/1,00 = 0,6004` :

| Hypothèse | Kelly `f* = p − (1−p)/b` |
|---|---|
| edge mesurée (WR 72 %) | **+25,4 %** du capital/trade |
| edge zéro (WR = BE) | **+0,8 %** |
| edge négative (WR 55 %) | **−19,9 %** (⇒ ne pas parier) |

Le point clé : **le Kelly non plafonné exige ~25 % du capital par trade si on croit l'edge mesurée — et ~0 % si on ne la croit pas.** Kelly est une fonction *discontinue* de la croyance en l'edge : la mise « optimale » suppose l'edge **vraie**, elle n'a aucune protection contre le fait qu'elle soit fausse.

### Critère de variance « intenable »

**Définition retenue** : mise telle que `P(drawdown max > 50 % du capital) ≤ 5 %`.
**Identité** utilisée : pour une mise fixe, `maxDD(s) = s · maxDD(1)` (homogénéité linéaire) donc `s_max = 0,5·B / Q95(maxDD@1)`.

Q95(maxDD à mise 1 €) mesurés :

| Hypothèse | Q95(maxDD@1 €) |
|---|---|
| edge mesurée | 13,2 € |
| **edge ZÉRO** | **51,5 €** |
| edge négative | 164,8 € |

Mises maximales qui en découlent :

| Capital B | s_max (edge mesurée) | **s_max (edge ZÉRO)** | en % du capital |
|---|---|---|---|
| 20 € | 0,76 € | **0,19 €** | 0,97 % |
| 50 € | 1,89 € | **0,49 €** | 0,97 % |
| **100 €** | 3,79 € | **0,97 €** | 0,97 % |
| 200 € | 7,58 € | **1,94 €** | 0,97 % |
| 500 € | 18,94 € | **4,85 €** | 0,97 % |
| 1000 € | 37,88 € | **9,70 €** | 0,97 % |

**Enseignements** :
- La contrainte qui compte est **celle de l'hypothèse edge ZÉRO**, pas celle de l'edge mesurée (qu'on n'a pas prouvée). Elle plafonne la mise à **~1 % du capital** (règle du 5 %-de-DD-à-50 %), vs ~3,8 % si l'edge était vraie.
- **La mise actuelle du bot (0,65–1,10 €)** est dans la limite **1 %** pour un capital de **≥ ~113 €** (`B ≥ 2,2 · Q95(maxDD@1) = 2,2 × 51,5 ≈ 113 €`). C'est le seuil de référence à retenir.
- Au-delà de **~1 % du capital par trade**, la variance d'une edge non prouvée devient **intenable** : un drawdown de −50 % devient plus probable que 5 %, sans gain d'espérance démontré pour le justifier.

---

## 4. (c) Le sizing actuel du bot est-il raisonnable ou dangereux ?

**Logique du code** (`bot-with-dashboard.ts`, lignes ~389–446) : `f* = p − (1−p)/b`, puis
`kelly = clamp(f*, 0, 0.05)` ; `sizeFactor = 1 + 2·kelly` ; `clamp(sizeFactor, 0.65, 2)` ; `min(1.2, sf)` si `n < 10`. Mise de base = 1 €.

Conséquence chiffrée (le plafond `kellyCeil=0.05` domine) :

| WR du « récent » | `f*` clampé | `sizeFactor` | Mise |
|---|---|---|---|
| 72 % | 0,050 | **1,10×** | 1,100 € |
| = BE (edge nulle) | 0,008 | 1,02× | 1,015 € |
| 55 % | 0,000 | 1,00× | 1,000 € |

→ **En pratique la mise est bornée à 0,65–1,10 €.** Le clamp `[0.65, 2]` est **inopérant** au-dessus de 1,10 : le plafond Kelly de 0,05 est la vraie borne.

Simulation comparée (WR 72 %, 1000 trades, capital 100 €) :

| Politique | P5 | P50 | P95 | P(PnL<0) | DD médian | DD Q95 |
|---|---|---|---|---|---|---|
| **Actuel (0,65–1,10 €)** | +114,4 € | +152,5 € | +190,0 € | 0,0 % | 8,4 € | 13,2 € |
| Naïf : Kelly non plafonné (1,51×) | +172,1 € | +229,5 € | +286,1 € | 0,0 % | 12,6 € | 19,8 € |
| Naïf non plafonné **+ edge ZÉRO** | **−53,3 €** | +7,5 € | +68,7 € | **41,9 %** | 38,8 € | **77,0 €** |

### Verdict

**Le sizing actuel est RAISONNABLE — et même prudent.** Compte tenu de `t = 1,54` :
- Le plafond `kellyCeil = 0.05` est **exactement la bonne mesure** pour une edge non prouvée. Il empêche le bot d'exploiter le `f*` mesuré (0,25), qui serait **12× trop grand** en cas d'edge nulle. C'est la protection clé — **ne pas y toucher**.
- Lever ce plafond serait **dangereux** : le Kelly non plafonné (1,51×) est **6× la limite de variance** sous edge nulle, et gonfle le drawdown Q95 à 77 € sur un capital de 100 €.

**Ce qui serait dangereux** (à ne PAS faire) :
1. **Lever `kellyCeil`** (0,05 → 0,25 comme « avant ») : augmente la mise jusqu'à ×1,50 sur une edge non prouvée.
2. **Lever la mise de BASE** (1 € → 2 € ou plus) : c'est le vrai levier de risque, mais il multiplie aussi le risque d'erreur. Le code plafonne déjà le multiplicateur ; la base, elle, n'est pas protégée.

---

## 5. (d) Règles concrètes et chiffrées

### 5.1 Plafond de mise
- **Mise fixe ≤ 1,10 €/trade** tant que `n < 200` **ou** `t < 2`. (Actuel : conforme.)
- **Borne de variance (règle du 1 %)** : `mise ≤ 0,01 · capital` sous l'hypothèse edge nulle. Ex. : capital 100 € → **mise ≤ 1,00 €** ; capital 500 € → mise ≤ 5 € mais **ne pas s'y rendre tant que l'edge n'est pas prouvée**.
- **Ne jamais** laisser le sizing dépasser **2 % du capital** par trade, quelle que soit la WR récente (au-delà, `P(DD>50 %)` franchit la barre des 5 % même sous l'edge mesurée).

### 5.2 Stop de session (à ajouter côté monitoring, pas dans le code — lecture seule)
- **Arrêt automatique de la session** si l'une des conditions est vraie :
  - perte cumulée de la session > **15 × mise unitaire** (≈ **16,5 €** à mise 1,10 €). Justification : la plus longue série de pertes Q95 est de 9 (edge nulle) à 11 (edge 55 %) — une session entièrement perdante dépasse 15 mises.
  - **8 pertes consécutives** (sous la série 9–13 du modèle edge nulle ; 8 est un signal précoce).
  - drawdown de session > **10 % du capital**.
- Ne **pas** interpréter ces arrêts comme une preuve que la stratégie est cassée : sous edge nulle, 42 % des sessions de 1000 trades finissent négatives — c'est du bruit attendu.

### 5.3 Alerte de drawdown (seuils à câbler dans le recap/monitoring)
| Seuil | Action |
|---|---|
| DD session > **5 %** du capital | alerte (log + notification) |
| DD session > **10 %** du capital | **réduire la mise de moitié** |
| DD session > **20 %** du capital | **STOP** + revue de la stratégie (pas un simple ajustement) |

### 5.4 Nombre de trades avant de re-juger

Puissance statistique (taille d'effet mesurée `d = PnL_moy/sd = 0,1363/0,7148 = 0,1907`) :

| Objectif | n requis |
|---|---|
| `t = 1,96` (95 % significatif) à l'effet mesuré | **~106 trades** |
| 80 % de puissance à l'effet mesuré | **~216 trades** |
| si la **vraie** edge = moitié de l'estimée | **~422** (sig.) / **~863** (puissance) |

- **Ne rien changer avant `n = 200`** (≈ 216 requis pour 80 % de puissance). Actuellement **65** → il manque **~150 trades**.
- **Re-juger sérieusement à `n = 400–850`** : c'est la fourchette qui couvre l'éventualité réaliste que l'effet mesuré soit surestimé par la sélection (la fenêtre « sweet-spot » et les filtres par coin ont été calibrés sur ces mêmes données → le `d` de 0,19 est probablement optimiste).
- À chaque palier, vérifier **le `t` du PnL total**, pas la WR brute.

---

## 6. Avertissement explicite : sur-dimensionnement d'une edge non prouvée

> **Ne sur-dimensionnez pas une edge que vous n'avez pas prouvée.**

Chiffres — simulation à **capital 100 €**, 1000 trades :

| Mise de base | Edge mesurée (WR 72 %) | **Edge ZÉRO (WR = BE)** | Edge négative (WR 55 %) |
|---|---|---|---|
| **1 €** | DD>25 % : 0,0 % · ruine : 0,00 % | DD>25 % : 52,8 % · DD>50 % : 5,8 % · **ruine 0,01 %** | ruine 77,7 % |
| **2 €** | DD>25 % : 7,0 % · ruine : 0,00 % | DD>25 % : 97,5 % · DD>50 % : 53,6 % · **ruine 1,3 %** | ruine 99,7 % |
| **5 €** | DD>50 % : 24,5 % · ruine : 0,00 % | P(DD>50 %) : 99,8 % · **ruine 15,6 %** | ruine 100 % |
| **10 €** | P(DD>50 %) : 99,4 % | P(DD>50 %) : 100 % · **ruine 27,7 %** | ruine 100 % |

**Le point** : chaque ligne « edge mesurée » est flatteuse ; chaque ligne « edge ZÉRO » est catastrophique. Or **on ne peut pas distinguer les deux colonnes avec les données actuelles** (`t = 1,54`). Décider une mise sur la base de la colonne optimiste, c'est parier sur l'absence de l'erreur qu'on n'a pas encore mesurée.

**Le coût de l'erreur est asymétrique et permanent** :
- se tromper en restant petit → on gagne moins (coût : opportunité, récupérable) ;
- se tromper en jouant gros → on perd le capital (coût : destruction, **non récupérable** — et Kelly avec une edge fausse mène à la ruine, pas à un simple ralentissement).

**Règle finale** : le sizing doit être dimensionné pour **survivre à l'hypothèse où l'edge est nulle**. C'est précisément ce que fait `kellyCeil = 0.05` (mise ≤ 1,10 €) aujourd'hui. Le garder est la décision défendable.

---

## 7. Limites de cette modélisation (honnêteté)

- **Trades supposés indépendants.** En réalité, plusieurs trades d'une même fenêtre 5 min partagent le même régime de marché (corrélation intra-fenêtre) → la variance réelle est **probablement plus grande** que modélisée, donc les plafonds de mise ci-dessus sont **optimistes** (à resserrer, pas à desserrer).
- **Muette sur la dérive du prix d'entrée.** Le bootstrap des prix d'entrée suppose la distribution future des entrées égale à la passée ; une dérive vers des favoris plus chers (entrées > 0,70) réduirait la marge.
- **Ne modélise pas** le coût de sortie / la liquidité / les frais / le fait que le prix n'est pas exactement la probabilité. Sur un bot papier c'est acceptable ; en réel l'edge net serait plus faible.
- **Le `+0,136 €/trade` mesuré n'est pas prouvé** (t=1,54) et provient d'un échantillon où la stratégie a été calibrée — biais de sélection probable.
- **`history.json` est vivant** : les chiffres exacts bougent à chaque résolution (64→65 trades pendant ce travail). Le snapshot figé est `data_snapshot_history.json`.

---

## 8. Reproduction

```bash
cd /root/clawd/Polymarket-bot/docs/rebuild/risk
python3 monte_carlo.py            # ~22 s, 20 000 × 1 000 trades, 3+ scénarios
```
Sortie intégrale : `run_output.txt`. Données d'entrée figées : `data_snapshot_history.json`.
