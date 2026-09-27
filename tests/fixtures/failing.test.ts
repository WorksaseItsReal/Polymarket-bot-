/**
 * FIXTURE (contrôle négatif) — ce fichier DOIT ÉCHOUER.
 *
 * Un test qui ne mord pas ne vaut rien : la suite doit prouver qu'une assertion
 * FAUSSE est bien signalée par le runner (code de sortie non nul, « fail » > 0).
 * Elle est lancée par tests/negative-control.test.ts, jamais par le glob
 * `tests/*.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('ce test doit ÉCHOUER — contrôle négatif du runner', () => {
  assert.equal(1 + 1, 3, '2 n’est pas 3 : le runner DOIT signaler cet échec');
});
