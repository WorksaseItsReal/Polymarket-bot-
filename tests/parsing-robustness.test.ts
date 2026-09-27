/**
 * (4) ROBUSTESSE DU PARSING — log du bot et fichiers JSON.
 *
 * On exerce les FONCTIONS RÉELLES qui lisent les fichiers de production :
 *
 *  A. `parse_log()` (paperbot-recap.py) lit paperbot.log ligne à ligne.
 *     Cas couverts : fichier VIDE, seulement un saut de ligne, TRONQUÉ en plein
 *     milieu d'une ligne, CORROMPU (ordures binaires / non-UTF8) entrelacé de
 *     lignes valides, ABSENT. Attendu : jamais d'exception, et les lignes valides
 *     d'un fichier partiellement corrompu restent extraites.
 *
 *  B. `edge_stats()` (paperbot-recap.py) lit cumulative.json + history.json.
 *     Cas couverts : fichiers ABSENTS, VALIDES, TRONQUÉS, vides, racine non-objet,
 *     entrées non-objet, valeurs booléennes. Attendu : jamais d'exception.
 *
 *  C. `main()` (paperbot-pnl.py) lit history.json.
 *     ⚠️ GAP CONNU : `hist = json.load(open(HIST))` et `for e in hist: e.get(...)`
 *     ne sont PAS protégés. Ce fichier ÉPINGLE le comportement réel (l'exception)
 *     pour qu'une correction future casse le test et soit vue. Voir REPORT-v2.md.
 *
 * LIMITE : ces tests exercent le code réel via import de chemin (tests/harness_v2.py
 * neutralise réseau/Telegram/écritures). Si les sources Python sont absentes (CI
 * hors de cette machine) les cas A/B/C sont SKIPPÉS explicitement — jamais
 * remplacés par une simulation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pySourcesAvailable, runHarnessV2 } from './harness-v2.ts';

const skip = pySourcesAvailable
  ? false
  : `sources réelles absentes (${'PAPERBOT_SCRIPTS_DIR'}) — test skippé, jamais simulé`;

type ParseCase = { raised: false; recap: Record<string, unknown> } | { raised: true; error: string };
type EdgeCase = { raised: false; value: unknown } | { raised: true; error: string };
type PnlCase = { raised: false; stdout: string } | { raised: true; error: string };

// ---------------------------------------------------------------------------
// A. parse_log()
// ---------------------------------------------------------------------------

test('parse_log() ne lève sur AUCUN fichier dégradé (vide/tronqué/corrompu/absent)', { skip }, () => {
  const cases = runHarnessV2<Record<string, ParseCase>>('parse-log-cases');
  for (const [name, r] of Object.entries(cases)) {
    assert.equal(r.raised, false, `parse_log() a levé sur « ${name} » : ${(r as { error: string }).error ?? ''}`);
  }
});

test('parse_log() : un log VIDE ou réduit à un saut de ligne donne un recap neutre', { skip }, () => {
  const cases = runHarnessV2<Record<string, ParseCase>>('parse-log-cases');
  for (const name of ['vide', 'vide_juste_retour_ligne', 'absent']) {
    const r = cases[name] as Extract<ParseCase, { raised: false }>;
    assert.equal(r.recap.sim_trades, 0, `${name} : aucun trade simulé`);
    assert.equal(r.recap.sim_pnl, 0, `${name} : PnL neutre (0, pas NaN)`);
    assert.equal(r.recap.diparb_trades, null, `${name} : aucun trade dipArb`);
    assert.ok(Array.isArray(r.recap.sim_history), `${name} : historique = tableau`);
  }
});

test('parse_log() : un fichier TRONQUÉ en pleine ligne ne casse pas la lecture', { skip }, () => {
  const cases = runHarnessV2<Record<string, ParseCase>>('parse-log-cases');
  const r = cases.tronque_milieu_ligne as Extract<ParseCase, { raised: false }>;
  // Les lignes complètes AVANT la troncature restent extraites.
  assert.equal(r.recap.sim_trades, 1, 'le trade complet avant troncature est conservé');
  assert.equal(r.recap.round, 'eth-updown-5m-1767309300', 'la ligne « New round » complète est conservée');
  // La ligne tronquée, elle, ne produit PAS de décision fantôme.
  assert.ok(Number.isFinite(r.recap.sim_pnl as number), 'le PnL reste un nombre fini');
});

test('parse_log() : des lignes CORROMPUES entrelacées n’empêchent pas d’extraire les valides', { skip }, () => {
  const cases = runHarnessV2<Record<string, ParseCase>>('parse-log-cases');
  const r = cases.corrompu_entrelace as Extract<ParseCase, { raised: false }>;
  // Deux blocs valides (avant ET après les ordures) → 2 trades, pas 0 ni 1.
  assert.equal(r.recap.sim_trades, 2, 'les lignes valides avant ET après les ordures sont lues');
  assert.equal(r.recap.diparb_trades, '3', 'la ligne dipArb valide reste extraite');
  assert.equal(r.recap.round, 'eth-updown-5m-1767309300', 'la ligne de round valide reste extraite');
  assert.equal(r.recap.learn_window, '[0.60-0.65]', 'la fenêtre apprise reste extraite');
});

test('parse_log() : des octets NON-UTF8 sont ignorés, pas fatals', { skip }, () => {
  const cases = runHarnessV2<Record<string, ParseCase>>('parse-log-cases');
  const r = cases.non_utf8 as Extract<ParseCase, { raised: false }>;
  assert.equal((r as { error?: string }).error, undefined, 'aucune erreur');
  assert.equal(r.recap.sim_trades, 1, 'les lignes valides autour des octets invalides sont lues');
});

// ---------------------------------------------------------------------------
// B. edge_stats()
// ---------------------------------------------------------------------------

test('edge_stats() ne lève sur AUCUN JSON dégradé (absent/vide/tronqué/non-objet)', { skip }, () => {
  const cases = runHarnessV2<Record<string, EdgeCase>>('edge-stats-cases');
  for (const [name, r] of Object.entries(cases)) {
    assert.equal(r.raised, false, `edge_stats() a levé sur « ${name} » : ${(r as { error: string }).error ?? ''}`);
  }
});

test('edge_stats() : un JSON illisible → None (statistique omise), jamais un chiffre inventé', { skip }, () => {
  const cases = runHarnessV2<Record<string, EdgeCase>>('edge-stats-cases');
  for (const name of ['absent', 'tronque', 'vide_octet_zero', 'racine_non_objet', 'entree_non_objet', 'valeur_booleenne']) {
    const r = cases[name] as Extract<EdgeCase, { raised: false }>;
    assert.equal(r.value, null, `${name} : pas de statistique plutôt qu’une fausse`);
  }
});

test('edge_stats() : un JSON VALIDE produit bien (n, moyenne, t-statistique)', { skip }, () => {
  const cases = runHarnessV2<Record<string, EdgeCase>>('edge-stats-cases');
  const r = cases.valide as Extract<EdgeCase, { raised: false }>;
  assert.ok(Array.isArray(r.value), 'résultat = tuple [n, mean, t]');
  const [n, mean, t] = r.value as number[];
  assert.equal(n, 2, 'deux valeurs distinctes après dédup par conditionId|side|price');
  assert.ok(Math.abs(mean - 0.25) < 1e-12, `moyenne = (1,5 − 1,0)/2 = 0,25, obtenu ${mean}`);
  assert.ok(Number.isFinite(t), `t-statistique finie, obtenue ${t}`);
});

// ---------------------------------------------------------------------------
// C. main() de paperbot-pnl.py — ROBUSTESSE (trou corrigé le 2026-09-27)
// ---------------------------------------------------------------------------

test('main() du résolveur PnL NE LÈVE PLUS sur un history.json dégradé', { skip }, () => {
  // AVANT (épinglé comme « gap connu », corrigé le 2026-09-27) : `json.load(open(HIST))`
  // puis `for e in hist: e.get(...)` sans garde → JSONDecodeError sur un fichier tronqué,
  // AttributeError sur une entrée non-objet. Le résolveur tourne dans le recap toutes les
  // 5 min : un fichier corrompu faisait tomber toute la résolution PnL.
  // Corrigé par `_read_json_safe()` (lecture tolérante) + filtrage des entrées non-objet.
  const cases = runHarnessV2<Record<string, PnlCase>>('pnl-malformed');
  for (const name of ['tronque', 'vide', 'racine_non_liste', 'entree_non_objet']) {
    const r = cases[name] as Extract<PnlCase, { raised: false }>;
    assert.equal(
      r.raised,
      false,
      `${name} : le résolveur ne doit plus lever — repli propre attendu (trou corrigé)`,
    );
  }
});

test('main() du résolveur PnL traite correctement un history.json VALIDE', { skip }, () => {
  const cases = runHarnessV2<Record<string, PnlCase>>('pnl-malformed');
  const r = cases.valide as Extract<PnlCase, { raised: false }>;
  assert.equal(r.raised, false, 'un history valide ne lève pas');
  const out = JSON.parse(r.stdout) as Record<string, number>;
  assert.equal(out.trades, 1, 'un trade résolu (YES gagnant)');
  assert.equal(out.wins, 1, 'compté gagnant');
  assert.equal(out.losses, 0, 'aucun perdant');
  // Le HOLD de l’échantillon est ignoré (jamais compté comme un trade).
  assert.equal(out.pnl, 1.5, 'PnL = realized du gagnant (+1,5)');
});
