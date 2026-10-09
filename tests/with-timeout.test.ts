/**
 * tests/with-timeout.test.ts — délai garanti sur une promesse (carnet CLOB bloqué, etc.).
 * Exécution : `npx tsx --test tests/with-timeout.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeoutError, withTimeout } from '../src/utils/with-timeout.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('withTimeout : résultat rendu à temps, erreur typée au-delà du délai', async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 50, 'rapide'), 42);
  await assert.rejects(withTimeout(sleep(200).then(() => 'tard'), 20, 'carnet CLOB'), (e: unknown) => {
    assert.ok(e instanceof TimeoutError);
    assert.match((e as Error).message, /carnet CLOB/);
    return true;
  });
});

test('withTimeout : un rejet TARDIF de la promesse perdante n\'est pas un rejet non géré (le bot ne doit pas le journaliser en erreur)', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (r: unknown) => unhandled.push(r);
  process.on('unhandledRejection', onUnhandled);
  try {
    const late = sleep(30).then(() => { throw new Error('réseau, trop tard'); });
    await assert.rejects(withTimeout(late, 5, 'x'), TimeoutError);
    await sleep(60);
    assert.deepEqual(unhandled, [], 'rejet tardif absorbé');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
