# Rapport de tests — bot paper Polymarket Up/Down 5m

Date : 2026-09-26 · Auteur : harnais de test automatisé · Projet : `/root/clawd/Polymarket-bot`

Ce document décrit la **suite de tests** créée, ce qu'elle teste **du code réel**, les
sorties **réellement obtenues** des commandes, et les **limites** assumées.

---

## 1. Invocation réelle retenue

Le runner retenu est le **test runner natif de Node**, exécuté par `tsx` :

```
npx tsx --test tests/*.test.ts
```

Vérifié au préalable sur un fichier bidon (TAP v13, `# pass 1`), puis sur la suite
complète. **Aucune dépendance npm n'a été installée.** `tsx` et `typescript` proviennent
des `devDependencies` déjà présentes (`node_modules/`).

Versions :

```
$ node -v        → v22.23.2
$ npx tsx --version → tsx v4.21.0 ; node v22.23.2
$ python3 --version → Python 3.12.3
```

---

## 2. Fichiers livrés

| Fichier | Rôle |
|---|---|
| `tests/harness.ts` | Helpers : lancement du harnais Python, extraction d'expressions du source TS. |
| `tests/harness_recap.py` | **Harnais Python** : importe par chemin les fichiers réels `paperbot-recap.py` et `paperbot-pnl.py` et exerce leurs fonctions/logique réelles. |
| `tests/pnl-resolution.test.ts` | (1) résolution PnL : gagné / perdu / `realized:0` → PENDING. |
| `tests/bet-scaling.test.ts` | (2) scaling de la mise : gain à 5 € = 5 × gain à 1 €. |
| `tests/recap-dedup.test.ts` | (3) clé de dédup Telegram : stable malgré prix live, sans marqueur interne. |
| `tests/prob-normalization.test.ts` | (4) normalisation UP/DOWN = 100 %. |
| `tests/round-format.test.ts` | (5) id de round → fenêtre `23:15→23:20`. |
| `tests/tsconfig.json` | Typecheck dédié aux tests (`npx tsc --noEmit -p tests/tsconfig.json`). |
| `docs/rebuild/tests/REPORT.md` | Ce rapport. |
| `.github/workflows/ci.yml` | Workflow CI GitHub Actions. |

Aucun fichier interdit n'a été écrit (ni `.env`, ni `bot-with-dashboard.ts`, ni
`package.json`, ni `.gitignore`, ni `/root/.hermes/scripts/**`, ni `node_modules/`, ni
`src/services/**`). Aucun `pm2 restart`.

---

## 3. Ce qui est testé — du **code réel**, pas des copies

### 3.1 Python (recap + résolveur PnL)

`tests/harness_recap.py` **importe par chemin** les scripts réels
(`/root/.hermes/scripts/paperbot-recap.py`, `paperbot-pnl.py`) via
`importlib.util.spec_from_file_location`. Les sources ne sont **jamais copiées ni
modifiées**. Seuls les **effets de bord** sont neutralisés dans le harnais :

- `send()` (Telegram) → capture en mémoire (aucun message réel n'est envoyé) ;
- `live_price()`, `round_info()`, `round_open_price()`, `parse_log()`, `llm_enabled()`
  → valeurs déterministes (le vrai réseau n'est pas sollicité autrement) ;
- `subprocess.run` → no-op (le harnais ne relance pas `paperbot-pnl.py`) ;
- `HOME` → dossier temporaire jetable → le fichier tampon `last_msg` de dédup est écrit
  dans `/tmp`, **jamais** dans `~/.config/paperbot-recap/` ;
- dans le test PnL, `HIST`/`CUM`/`OSUM` sont redirigés vers `/tmp` et `fetch()` est coupé :
  **les données réelles de production ne sont jamais touchées** (`/root/.polymarket/*`).

Ainsi `fmt_round()`, `build_message()`, `main()` (avec sa clé de dédup) et
`realized_for()`/`main()` du résolveur PnL sont **le code réellement exécuté**.

### 3.2 TypeScript (`bot-with-dashboard.ts`)

Ce fichier est un **monolithe non importable** : l'importer lancerait `main()` (connexion
au bot). Les expressions ciblées sont donc **extraites du fichier source au moment du
test** (regex sur le texte réel) puis **évaluées** via `new Function`. Si la formule
régresse (ex. `sizeFactor` retiré, division de normalisation supprimée), l'extraction ou
l'assertion **échoue** — c'est une protection de non-régression ancrée sur le source réel.
**Limite assumée** : on teste l'expression telle qu'écrite dans le fichier, pas son
intégration dans le flux d'exécution complet du bot.

---

## 4. Sorties BRUTES des commandes

### 4.1 Suite de tests

```
$ npx tsc --noEmit -p tests/tsconfig.json
exit=0
```

```
$ npx tsx --test tests/*.test.ts
ok 1 - la formule source multiplie bien par sizeFactor ET par BET_STAKE
ok 2 - un gain à 5 € de mise vaut exactement 5× un gain à 1 €
ok 3 - sizeFactor pondère le gain proportionnellement
ok 4 - le résolveur Python applique la même échelle de mise (cohérence)
ok 5 - PnL réalisé : un gain à 0,50$ vaut +1× mise, une perte vaut −1× mise
ok 6 - PnL réalisé : `realized: 0` non résolvable reste PENDING (ni gain ni perte)
ok 7 - NON-RÉGRESSION : les deux points d’affichage normalisent bien leurs probas
ok 8 - UP + DOWN = 100 % dans les deux emplacements (asks bruts à 103 %)
ok 9 - garde-fou : asks nuls/absents ne provoquent pas de division par zéro
ok 10 - valeur affichée arrondie : le favori 0,56 vs 0,47 reste > 50 %
ok 11 - préparation : un cycle de dédup sur le vrai main()
ok 12 - la clé est IDENTIQUE sur deux appels consécutifs malgré des prix live qui bougent
ok 13 - la clé ne contient JAMAIS le marqueur interne (ni le message envoyé)
ok 14 - un ÉVÉNEMENT réel relance bien l’envoi (la dédup n’est pas un blocage permanent)
ok 15 - fmt_round : un epoch brut devient une fenêtre lisible 23:15→23:20
ok 16 - fmt_round : ne casse pas les identifiants non numériques
ok 17 - build_message : un slug dégradé (virgule + suffixe) devient une fenêtre propre
# tests 17
# suites 0
# pass 17
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 885.544156
exit=0
```

### 4.2 Harnais Python (preuves directes, sorties réelles)

```
$ TZ=UTC python3 tests/harness_recap.py fmt-round 1767309300
{"input": "1767309300", "output": "23:15→23:20"}

$ TZ=UTC python3 tests/harness_recap.py round-line
{"slug_avec_virgule": "🔁 Round: <b>23:15→23:20</b>", "slug_propre": "🔁 Round: <b>23:15→23:20</b>",
 "epoch_brut": "🔁 Round: <b>1767309300</b>", "vide": "🔁 Round: <b>…</b>"}

$ TZ=UTC python3 tests/harness_recap.py dedup
{"sent_apres_appel_1": 1, "sent_apres_appel_2_prix_bouges": 1, "sent_apres_appel_3_evenement": 2,
 "cle_identique": true, "cle_contient_marqueur": false, "cle_contient_ligne_round": false,
 "cle_contient_prix_live": false, "message_envoye_contient_marqueur": false,
 "cle_extrait": "📊 <b>POLYMARKET — Up/Down 5m (5 coins)</b>\n🕐 <b>--</b> — Pap"}

$ python3 tests/harness_recap.py pnl-realized
{"gagne_1": 1.0, "perdu_1": -1.0, "gagne_5": 5.0, "perdu_5": -5.0,
 "gagne_5_no": 7.5, "realized_0_impossible": -0.0}

$ python3 tests/harness_recap.py pnl-pending
{"trades": 2, "wins": 1, "losses": 1, "win_rate": 50.0, "pnl": 0.5, "pending": 1,
 "window_pnl": 0.5, "cumulative": true, "realized_du_pending_apres_main": 0, "history_len": 4}
```

### 4.3 Contrôle négatif (les tests détectent bien une régression)

**a) Garde-fou d'extraction TS** — si la formule redevient buguée, la regex ne matche plus :

```
$ npx tsx -e '<regex contre code réel vs régressé>'
garde-fou sur code RÉEL (normalisé) : true
garde-fou sur code RÉGRESSÉ (brut)   : false
garde-fou sizing sur code SANS sizeFactor : false
```

**b) Sabotage de bout en bout de la logique Python réelle** — `fmt_round` cassé dans une
copie *jetable* (`/tmp/mutsrc`, jamais un livrable), puis tests relancés via
`PAPERBOT_SCRIPTS_DIR=/tmp/mutsrc` :

```
$ PAPERBOT_SCRIPTS_DIR=/tmp/mutsrc npx tsx --test tests/round-format.test.ts
exit=1
# tests 3
# pass 0
# fail 3
```

→ Les tests **échouent** quand la logique réelle change : ils ne sont pas décoratifs.

---

## 5. Couverture vs. demandes

| # | Demande | Statut | Preuve |
|---|---|---|---|
| 1 | PnL : gagné (win), perdu (loss), `realized:0` reste PENDING | ✅ | `ok 5`, `ok 6` ; `pending=1`, `wins=1`, `losses=1`, `realized` du pending reste `0` |
| 2 | Scaling : gain 5 € = 5 × gain 1 € | ✅ | `ok 2` (TS) + `ok 4` (Python : `gagne_5 = 5 × gagne_1`) |
| 3 | Clé de dédup identique malgré prix live ; jamais le marqueur interne | ✅ | `ok 12`, `ok 13` ; `cle_identique=true`, `cle_contient_marqueur=false`, `sent_apres_appel_2=1` |
| 4 | Probas UP/DOWN = 100 % | ✅ | `ok 7`, `ok 8` ; cas `0,56 + 0,47 = 1,03` → normalisé `54 % / 46 %` |
| 5 | Id de round → fenêtre `23:15→23:20` | ✅ | `ok 15`, `ok 17` ; slug dégradé `…9300-abc,` → `23:15→23:20`, sans virgule ni suffixe |

---

## 6. Limites honnêtes

1. **`bot-with-dashboard.ts` non importable.** Les tests TS extraient les expressions du
   source et les évaluent ; ils ne font pas tourner le flux complet du bot (qui exige
   réseau, clés API, WebSocket). La logique de normalisation et de scaling est donc
   vérifiée « au texte réel évalué », pas « en contexte d'exécution ». Documenté aussi en
   en-tête des fichiers de test.
2. **Résolution PnL réseau non exercée en ligne.** Le chemin *hors ligne* est testé
   (`realized_for`, comptage win/loss/pending). La résolution réelle via les API Gamma/CLOB
   de Polymarket (`outcome_from_slug`, `outcome_from_cid`) dépend du réseau et n'est pas
   testée ici : ces fonctions sont court-circuitées (`fetch` coupé) pour rendre le test
   **déterministe et sans effet de bord** sur les données de production.
3. **`fmt-round` sur un epoch « nu » dans `build_message`.** `fmt_round()` formate bien un
   epoch brut (testé : `ok 15`), mais la ligne `🔁 Round:` de `build_message()` ne
   reformate que les id contenant le motif `updown-5m-<9+ chiffres>` ; un epoch nu y reste
   affiché tel quel (`epoch_brut` ci-dessus). Ce n'est pas un bug en production (le log écrit
   toujours le slug), mais c'est une asymétrie réelle, reproduite telle quelle plutôt que
   maquillée.
4. **En CI (dépôt cloné loin de cette machine), les sources Python sont absentes.** Les
   tests Python sont alors **SKIPPÉS explicitement** (avec raison lisible dans le TAP),
   jamais remplacés par une simulation. Les tests TS (source du bot présente dans le dépôt)
   s'exécutent toujours.
5. **`npx tsc --noEmit` (projet entier) échoue au moment de la capture**, mais **pas à
   cause de ces tests** : `src/services/realtime-service-v2.ts` est en cours de modification
   par un autre processus (mtime = instant de la capture), en refactor inachevé
   (méthodes appelées mais non encore définies). Exemple réel :

   ```
   src/services/realtime-service-v2.ts(379,10): error TS2339: Property 'stopRestPoller' does not exist on type 'RealtimeServiceV2'.
   src/services/realtime-service-v2.ts(453,12): error TS2339: Property 'armWsOrderbookProbe' does not exist on type 'RealtimeServiceV2'.
   src/services/realtime-service-v2.ts(458,12): error TS2551: Property 'addRestTokens' does not exist on type 'RealtimeServiceV2'. Did you mean 'restTokens'?
   src/services/realtime-service-v2.ts(506,14): error TS2339: Property 'removeRestTokens' does not exist on type 'RealtimeServiceV2'.
   src/services/realtime-service-v2.ts(1096,14): error TS2339: Property 'emitOrderbook' does not exist on type 'RealtimeServiceV2'.
   exit=2
   ```

   Ce fichier est **hors de mon périmètre d'écriture** (`src/services/**` interdit) : je ne
   l'ai ni modifié ni « corrigé ». Le typecheck **des tests** (`npx tsc --noEmit -p
   tests/tsconfig.json`) passe, lui, en `exit=0`.

---

## 7. CI GitHub Actions

`.github/workflows/ci.yml` (déclenché sur push / PR / manuel) exécute :

1. `npm ci` (lockfile uniquement, aucune dépendance nouvelle) ;
2. `npx tsc --noEmit` (projet) ;
3. `npx tsc --noEmit -p tests/tsconfig.json` (tests) ;
4. `npx tsx --test tests/*.test.ts` ;
5. archive le rapport TAP en artefact.

Validité YAML vérifiée localement :

```
$ python3 -c "import yaml; ..." → OK jobs= ['test']
```
