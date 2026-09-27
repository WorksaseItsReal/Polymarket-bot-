/**
 * FIXTURE (contrôle positif) — ce fichier DOIT passer.
 *
 * Il est volontairement dans tests/fixtures/ (hors du glob `tests/*.test.ts`) :
 * il n'est exécuté QUE par le contrôle négatif (tests/negative-control.test.ts),
 * qui lance le runner dessus par child_process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('ce test doit PASSER — contrôle positif du runner', () => {
  assert.equal(1 + 1, 2);
});
