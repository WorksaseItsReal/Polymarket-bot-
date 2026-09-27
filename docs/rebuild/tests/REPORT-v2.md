# REPORT-v2 — Renforcement de la suite de tests (zones non couvertes)

Date : 2026-09-27 · Périmètre : ajout de tests uniquement (aucune source modifiée).
Commande de référence : `npx tsx --test tests/*.test.ts` (runner natif Node via tsx).

---

## 1. Ce qui a été ajouté

| Fichier | Objet | Tests |
|---|---|---|
| `tests/profit-ratio-guard.test.ts` | **(1) Garde de ratio de profit** — non-régression du bug réel (ratio 0/undefined/NaN/Infinity → mise enregistrée en perte totale) | 6 |
| `tests/bet-sizing-caps.test.ts` | **(2) Dimensionnement de mise** — plafonds, bornes, cas dégénérés | 9 |
| `tests/data-freshness.test.ts` | **(3) Fraîcheur des données** — défaut ≠ mesure ; 0.5 absent vs 0.5 réel | 6 |
| `tests/parsing-robustness.test.ts` | **(4) Robustesse du parsing** — log tronqué/vide/corrompu, JSON tronqué/vide | 10 |
| `tests/negative-control.test.ts` | **(5) Contrôle négatif** — prouver que la suite mord | 3 |
| `tests/harness_v2.py` | Harnais Python additif (import par chemin, effets de bord neutralisés) | — |
| `tests/harness-v2.ts` | Helpers TS (extraction source réelle, exécution du harnais v2) | — |
| `tests/fixtures/failing.test.ts` · `tests/fixtures/passing.test.ts` | Fixtures du contrôle négatif (hors du glob `tests/*.test.ts`) | — |

**Total ajouté : 34 tests.** Les 17 tests préexistants ne sont pas modifiés ; un
fichier `tests/stake-sizing.test.ts` (22 tests + ceux listés « 45–50 ») a été
ajouté en parallèle par un autre chantier pendant cette session — il n'est pas de
moi et je ne l'ai pas touché.

---

## 2. Décompte brut (sortie réelle)

```
$ npx tsc --noEmit
(0 ligne, exit 0)

$ npx tsx --test tests/*.test.ts
# tests 74
# suites 0
# pass 73
# fail 1
# cancelled 0
# skipped 0
# todo 0
```

**73 / 74 passent. 1 échec — qui n'est pas le mien** (voir §5).

---

## 3. Ce que les nouveaux tests vérifient réellement

### (1) Garde de ratio de profit — NON-RÉGRESSION du bug réel
Le bug : `estimatedProfitRate` non calculé valait `0` ; le code faisait
`stake * (profitRate - 1) = -stake` → chaque signal compté comme **perte totale**
(2 514 signalements mesurés) → PnL interne détruit → `currentCapital` effondré →
garde-fou de drawdown de 25 % → **pause silencieuse de 7 jours** (layer 3).

Test : le bloc de garde EXACT (`const profitRate = …` jusqu'au repli
`estProfit = stake * ((1 / p) - 1)`) est **extrait de `bot-with-dashboard.ts`** au
moment du test, les `as any` retirés, puis évalué. Assertions : pour
`0, undefined, null, NaN, ±Infinity, -1, 0.5, 1, '0.5', {} , []`, le résultat est
**toujours fini, ≥ 0, et jamais `-stake`**. Plus : la présence de
`Number.isFinite(profitRate)` **et** `profitRate > 1` dans la garde source est
assertée (si la garde disparaît, l'extraction/l'assertion casse).

### (2) Dimensionnement de mise
Deux logiques RÉELLES :
- `calculatePositionSize()` extraite de `bot-config.ts` : plafond par trade, mise
  de base > plafond ramenée au plafond, < plancher remontée au plancher, aucune
  mise négative pour toute entrée finie, série de pertes qui réduit sans sortir des
  bornes, série de gains qui ne dépasse jamais le plafond.
- Clamp du multiplicateur `sizeFactor` (Kelly) extrait de `bot-with-dashboard.ts` :
  reste dans `[0,5 ; 2]` et fini sur tout le domaine testé.
- Plafonds de CONFIG extraits du source :
  `maxPerTradePct ≤ 2 %`, `maxPerMarketPct ≤ 10 %`, `maxTotalExposurePct ≤ 30 %`,
  et `maxPerTradePct ≤ maxTotalExposurePct`.

### (3) Fraîcheur des données
- **Trou documenté** : `orderbook.yes?.ask || 0.5` rend `undefined`, `null`, `0`
  ET un vrai `0.5` **indistinguables** (les quatre valent 0.5). Test de constat.
- **Là où le code fait bien** : `orderbook.no?.ask ?? …` (`??` ≠ `||`) préserve un
  `0` réel ; `typeof t.realized !== 'number'` rejette une mesure absente tout en
  gardant un `0`/`0.5` réel → **absent ≠ valeur réelle**.
- **`live_price()` / `best_ask()`** (Python, code réel) : source muette ou carnet
  indisponible → **`None`**, jamais un défaut inventé ; un ask réel de `0,5` est
  rendu `0,5` → **distinguable de l'absence**. Un prix illisible ou `null` est
  ignoré sans casser la lecture.
- **Constat** : `BET_STAKE || 1` écrase une mise explicitement valant `0`.

### (4) Robustesse du parsing
- `parse_log()` (paperbot-recap.py, code réel) sur : **vide**, **quasi-vide**,
  **tronqué en pleine ligne**, **corrompu entrelacé d'ordures**, **octets non-UTF8**,
  **absent** → **aucune exception** ; les lignes valides avant ET après la
  corruption restent extraites ; un log vide donne un recap neutre (0, pas NaN).
- `edge_stats()` sur JSON **absent / vide / tronqué / racine non-objet / entrée
  non-objet / valeur booléenne** → **aucune exception**, résultat `None` (statistique
  omise plutôt qu'inventée) ; un JSON valide produit bien `[n, moyenne, t]`.
- `main()` de `paperbot-pnl.py` sur `history.json` **tronqué / vide / non-liste /
  entrée non-objet** → **GAP CONNU : lève** (`JSONDecodeError`, `TypeError`,
  `AttributeError`). Test de caractérisation volontaire (voir §4).

### (5) Contrôle négatif — « un test qui ne mord pas ne vaut rien »
1. Le runner est lancé (child_process) sur une fixture dont l'assertion est FAUSSE
   → **exit ≠ 0**, `# fail 1`, ligne `not ok` présente.
2. Sur une fixture VRAIE → **exit 0**, `# pass 1`, `# fail 0`.
3. `extractFromBot()` avec un motif impossible **lève** → preuve que les tests de
   non-régression cassent si le code réel change au lieu de passer en silence.

---

## 4. Trous / bugs réels mis au jour par ces tests

1. **`paperbot-pnl.py` `main()` ne protège pas la lecture de `history.json`.**
   `hist = json.load(open(HIST))` (lecture non gardée) et `for e in hist: e.get(...)`
   sans validation de type. Un fichier **tronqué** (écriture concurrente du bot, kill
   en pleine écriture) ou une entrée non-objet **fait planter le résolveur PnL**.
   Le chemin `cumulative.json` (ligne 250-251), lui, EST protégé — l'asymétrie est
   le signe d'un oubli. Non corrigé ici (hors périmètre : `src/**` interdit en
   écriture, et `/root/.hermes/scripts/**` n'est pas sur la liste autorisée).
2. **`calculatePositionSize()` ne borne pas `NaN`.** `Infinity` et les valeurs
   négatives sont bien ramenés dans `[minPositionPct, maxPositionPct]`, mais
   `Math.min(plafond, NaN) = NaN` : un `baseSize` NaN traverse les bornes. Test de
   caractérisation.
3. **`orderbook.yes?.ask || 0.5`** (2 emplacements) : un ask **réel de 0** est
   écrasé par le défaut, et l'absence est indiscernable d'un vrai `0,5`. Risque :
   décider sur une donnée qui n'existe pas. Piste : `?? 0.5` + garde
   `> 0` explicite, comme le fait déjà la ligne `no.ask`.
4. **`BET_STAKE || 1`** : une mise `0` est forcée à `1`. À confirmer comme voulu.

---

## 5. L'unique échec de la suite — non causé par ces ajouts

```
not ok 51 - build_message : un slug dégradé (virgule + suffixe) devient une fenêtre propre
      + '🔁 Round: <b>12:45→12:50</b>'   (actual)
      - '🔁 Round: <b>23:15→23:20</b>'   (expected)
```

Ce test appartient à **`tests/round-format.test.ts`**, fichier **préexistant** que
je n'ai pas le droit de réécrire. Il était au vert au début de la session
(17/17). Il casse parce que **`/root/.hermes/scripts/paperbot-recap.py` a été
modifié en cours de session par un autre chantier** (le fichier est passé de 409 à
489 lignes, `fmt_live()` a disparu, `build_message()` a changé : la ligne « Round »
n'est plus dérivée de l'identifiant de round lu dans le log mais d'une fenêtre
calculée). C'est un effet de bord d'édition concurrente, pas de mes fichiers :
`tests/round-format.test.ts` exerce `build_message()` du script, pas une source du
dépôt. Vérifié : le franchissement n'est pas dû au fuseau horaire (`TZ=UTC` ne
change rien).

---

## 6. Ce qui reste NON testable, et pourquoi (honnête)

| Zone | Pourquoi c'est non testable ici |
|---|---|
| **Intégration de la garde de ratio dans le flux réel** | `bot-with-dashboard.ts` n'est **pas importable** : son top-level démarre le SDK, le WebSocket et des écritures réseau. On teste le **bloc de code exact extrait**, pas son appel par `onSignal` → on ne peut PAS prouver que `onSignal` l'invoque, ni que `simulateTrade`/`recordTrade` propagent le résultat jusqu'à `state.totalPnL`. |
| **`calculatePositionSize` / CONFIG** | Idem : `bot-config.ts` importe `./src/index.js` (SDK). Extraction + `new Function` : la **valeur** est testée, le **câblage** ne l'est pas. |
| **Pause 7 jours / drawdown / gates de risque** (`checkRiskGates`) | Dépend d'un état global mutable non exporté (`state.isPaused`, `pauseUntil`, `peakCapital`) et de `Date.now()`. Non exerçable sans instrumenter le monolithe, interdit en écriture. |
| **Résolution PnL via l'API Gamma/CLOB** | Nécessite le réseau et un round réellement clos. Le harnais coupe le réseau : `outcome()` renvoie `None` → les chemins « non résolu » sont testés, pas le chemin « résolu en ligne ». |
| **`reconcilier` la dédup du recap en production** | Le vrai `main()` lit un token Telegram au niveau module et envoie via réseau ; le harnais neutralise l'envoi et redirige le tampon vers un dossier jetable. Le comportement testé est celui de la logique, pas de l'API Telegram. |
| **`.env` réel, tokens, `~/.polymarket/**`** | Interdits en écriture. Tous les fichiers de données manipulés par les tests sont créés dans des dossiers temporaires. |
| **`bot-config.ts` : `maxSizePerTrade`, `minTradeSize`, allocation par stratégie** | Ces plafonds ne sont appliqués que dans des services du SDK non importables ; on ne les a pas testés (aucun bug signalé dessus). |
| **Stabilité du harnais dans le temps** | `paperbot-recap.py` **change en direct**. Le harnais v2 s'accroche à des noms stables (`parse_log`, `edge_stats`, `live_price`, `best_ask`, `LOG`, `HOME`). Si l'un est renommé, le harnais lèvera — c'est voulu (signal), mais il faudra le mettre à jour. |

### Limites de la méthode d'extraction (à connaître)
Les sources TS sont lues comme du **texte**, puis évaluées via `new Function` après
retrait des seules annotations TS (`as any`, `: number|string|boolean|…`) — altération
**purement syntaxique** (les types TS n'existent pas à l'exécution). Conséquence :
le test est **structurellement accroché** à l'expression ; il détecte une
suppression/réécriture de l'expression (⇒ l'extraction lève), mais il ne détecte
pas un bug introduit *ailleurs* dans le flux qui l'entoure.

---

## 7. Relancer

```bash
cd /root/clawd/Polymarket-bot
npx tsc --noEmit                                   # typage projet (exit 0)
npx tsc --noEmit -p tests/tsconfig.json            # typage des tests (exit 0)
npx tsx --test tests/*.test.ts                     # suite complète
npx tsx --test tests/profit-ratio-guard.test.ts    # garde de ratio
npx tsx --test tests/bet-sizing-caps.test.ts       # dimensionnement
npx tsx --test tests/data-freshness.test.ts        # fraîcheur
npx tsx --test tests/parsing-robustness.test.ts    # parsing
npx tsx --test tests/negative-control.test.ts      # contrôle négatif
```

Contrainte respectée : **aucune dépendance npm ajoutée**, **`pm2` jamais redémarré**,
aucune écriture dans `.env`, `bot-with-dashboard.ts`, `package.json`,
`tsconfig.json`, `vitest.config.ts`, `.gitignore`, `node_modules`, `src/**` ou
`/root/.polymarket/**`.
