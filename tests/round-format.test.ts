/**
 * (5) FORMATAGE DE L'IDENTIFIANT DE ROUND — code RÉEL.
 *
 * Deux maillons réels :
 *  - fmt_round() de paperbot-recap.py : un epoch brut → fenêtre « 23:15→23:20 ».
 *  - build_message() (même fichier) : extrait le slot d'un slug dégradé
 *    (« btc-updown-5m-<slot>-<suffixe>, » avec virgule finale) et le formate.
 *    Bug historique : l'id affiché gardait la virgule finale et le suffixe interne.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pySourcesAvailable, runHarness } from './harness.ts';

const skip = pySourcesAvailable ? false : 'sources réelles absentes — test skippé';
const WINDOW = /^\d{2}:\d{2}→\d{2}:\d{2}$/;
const EPOCH = '1767309300'; // = 2026-01-01 23:15:00 UTC
const EXPECTED = '23:15→23:20'; // fenêtre 5 min (TZ=UTC imposé par le harnais)

test('fmt_round : un epoch brut devient une fenêtre lisible 23:15→23:20', { skip }, () => {
  const r = runHarness<{ input: string; output: string }>('fmt-round', [EPOCH]);
  assert.equal(r.output, EXPECTED, 'epoch → fenêtre de 5 minutes');
  assert.match(r.output, WINDOW, 'format HH:MM→HH:MM');
});

test('fmt_round : ne casse pas les identifiants non numériques', { skip }, () => {
  const slug = runHarness<{ output: string }>('fmt-round', ['eth-updown-5m-1767309300']);
  assert.equal(slug.output, 'eth-updown-5m-1767309300', 'un slug non nu est rendu tel quel ici');
  const empty = runHarness<{ output: string }>('fmt-round', ['']);
  assert.equal(empty.output, '…', 'id vide → ellipse (jamais une chaîne vide)');
});

test('build_message : un slug dégradé (virgule + suffixe) devient une fenêtre propre', { skip }, () => {
  const r = runHarness<Record<string, string>>('round-line');
  assert.equal(
    r.slug_avec_virgule,
    '🔁 Round: <b>23:15→23:20</b>',
    'la virgule finale et le suffixe interne sont éliminés, le slot est formaté',
  );
  assert.equal(r.slug_propre, '🔁 Round: <b>23:15→23:20</b>', 'slug propre → même fenêtre');
  assert.equal(r.vide, '🔁 Round: <b>…</b>', 'aucun id → ellipse');

  // NON-RÉGRESSION explicite : jamais de virgule finale ni de suffixe interne affiché.
  for (const [name, line] of Object.entries(r)) {
    assert.ok(!line.includes('519183,'), `[${name}] id tronqué avec virgule finale affiché`);
    assert.ok(!line.includes('-abc'), `[${name}] suffixe interne affiché`);
    assert.ok(!/,\s*<\/b>/.test(line), `[${name}] virgule avant la fin du balisage`);
  }
});
