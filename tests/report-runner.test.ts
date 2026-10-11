/**
 * tests/report-runner.test.ts — calculs longs (/rapport, /backtest) dans un processus séparé :
 * résultat, un seul à la fois, échec lisible, délai maximal, arrêt, options node héritées.
 * Exécution : `npx tsx --test tests/report-runner.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportRunner, childNodeArgs, stderrTail, type ReportResult } from '../src/bot/report-runner.ts';

const dir = mkdtempSync(join(tmpdir(), 'report-runner-'));
const script = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};
const ok = script('ok.mjs', "await new Promise(r => setTimeout(r, 150)); console.log('verdict', process.argv.slice(2).join(' '));");
const fail = script('fail.mjs', "console.error('Aucun journal dans /x'); process.exit(3);");
const slow = script('slow.mjs', 'setTimeout(() => {}, 60_000);');
const noisy = script('noisy.mjs', "process.stdout.write('x'.repeat(300_000)); console.error('e');");

const run = (r: ReportRunner, s: string, args: string[] = []) => new Promise<ReportResult>(resolve => {
  assert.equal(r.start({ name: 'rapport', script: s, args }, resolve), true);
});

test('succès : sortie et arguments transmis ; un seul calcul à la fois', async () => {
  const r = new ReportRunner({ cwd: dir, nodeArgs: [] });
  const p = run(r, ok, ['--summary', '--days', '3']);
  assert.equal(r.busy, 'rapport');
  assert.equal(r.start({ name: 'backtest', script: ok, args: [] }, () => assert.fail('ne doit pas tourner')), false, 'déjà occupé');
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), 'verdict --summary --days 3');
  assert.equal(r.busy, null, 'libre après la fin');
  assert.equal((await run(r, ok)).ok, true, 'relançable');
});

test('échec : code et sortie d\'erreur rendus, jamais d\'exception', async () => {
  const res = await run(new ReportRunner({ cwd: dir, nodeArgs: [] }), fail);
  assert.equal(res.ok, false);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /Aucun journal/);
  const missing = await run(new ReportRunner({ cwd: dir, nodeArgs: [] }), join(dir, 'absent.mjs'));
  assert.equal(missing.ok, false);
  assert.ok(missing.stderr.length > 0);
});

test('délai dépassé : processus tué, résultat marqué ; stop() tue le calcul en cours', async () => {
  const t0 = Date.now();
  const res = await run(new ReportRunner({ cwd: dir, nodeArgs: [], timeoutMs: 300 }), slow);
  assert.equal(res.timedOut, true);
  assert.equal(res.ok, false);
  assert.ok(Date.now() - t0 < 10_000);
  const r = new ReportRunner({ cwd: dir, nodeArgs: [] });
  const p = run(r, slow);
  setTimeout(() => r.stop(), 200);
  const stopped = await p;
  assert.equal(stopped.ok, false);
  assert.equal(r.busy, null);
});

test('sortie bornée ; rappel qui lève sans effet', async () => {
  const r = new ReportRunner({ cwd: dir, nodeArgs: [], maxOutputBytes: 1024 });
  const res = await run(r, noisy);
  assert.ok(res.stdout.length < 300_000 && res.stdout.length >= 1024, `sortie gardée : ${res.stdout.length}`);
  await new Promise<void>(resolve => {
    r.start({ name: 'rapport', script: ok, args: [] }, () => { setTimeout(resolve, 50); throw new Error('rappel cassé'); });
  });
  assert.equal(r.busy, null);
});

test('options node : celles du bot sans débogueur ; tsx ajouté s\'il manque', () => {
  assert.deepEqual(childNodeArgs(['--import', 'tsx', '--import', './tests/fixtures/fake-live-net.ts']), ['--import', 'tsx', '--import', './tests/fixtures/fake-live-net.ts']);
  assert.deepEqual(childNodeArgs(['--inspect=9229', '--require', '/x/tsx/dist/preflight.cjs']), ['--require', '/x/tsx/dist/preflight.cjs']);
  assert.deepEqual(childNodeArgs([]), ['--import', 'tsx']);
  assert.equal(stderrTail('a'.repeat(1000), 10), '…aaaaaaaaaa');
  assert.equal(stderrTail('  court \n'), 'court');
});
