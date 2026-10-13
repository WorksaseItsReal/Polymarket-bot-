/**
 * tests/update-script.test.ts — scripts/update.sh (`npm run upgrade`) : le serveur ne déploie
 * que main.
 * Exécution : `npx tsx --test tests/update-script.test.ts`
 *
 * Le vrai script est lancé par bash, COPIÉ dans un dossier temporaire (il travaille dans le
 * parent de scripts/), avec un PATH où `git`, `npm` et `pm2` sont des faux qui notent leurs
 * appels dans un fichier témoin : aucune commande réelle, aucun accès réseau.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/update.sh', import.meta.url));

/** Copie du script dans un dépôt factice + faux exécutables (chacun note « nom args » dans `log`). */
function sandbox(fakes: Record<string, string>): { script: string; log: string; run: (...args: string[]) => SpawnSyncReturns<string> } {
  const dir = mkdtempSync(join(tmpdir(), 'update-sh-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'dashboard'));
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  writeFileSync(join(dir, 'dashboard', 'package-lock.json'), '{}');
  const script = join(dir, 'scripts', 'update.sh');
  copyFileSync(SCRIPT, script);
  const log = join(dir, 'appels.log');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const run = (...args: string[]) => spawnSync('bash', [script, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  return { script, log, run };
}

test('update.sh refuse toute branche en argument (code 2, message clair), sans lancer git', () => {
  for (const args of [['une-branche'], ['feat/fair-value-strategy'], ['main'], ['feat/x', 'autre']]) {
    // Le faux git échoue et laisse un témoin : s'il était appelé, le fichier existerait.
    const { log, run } = sandbox({ git: 'exit 1', npm: 'exit 1', pm2: 'exit 1' });
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')} : ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /le serveur ne déploie que main/);
    assert.ok(r.stderr.includes(`reçu : ${args.join(' ')}`), r.stderr);
    assert.equal(existsSync(log), false, `commande lancée malgré le refus : ${existsSync(log) ? readFileSync(log, 'utf8') : ''}`);
  }
});

test('update.sh sans argument : fetch, checkout et pull de main seulement, puis dépendances, dashboard, doctor, PM2', () => {
  const { log, run } = sandbox({
    git: [
      'case "$*" in',
      '  "rev-parse --abbrev-ref HEAD") echo main ;;',
      '  "log --oneline -1") echo "abc1234 Dernier commit" ;;',
      'esac',
      'exit 0',
    ].join('\n'),
    npm: 'exit 0',
    pm2: 'exit 0',
  });
  const r = run();
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(calls.filter(c => /^git (fetch|checkout|pull|switch)\b/.test(c)), [
    'git checkout -- package-lock.json dashboard/package-lock.json',
    'git fetch origin main',
    'git checkout -q main',
    'git pull --ff-only origin main',
  ]);
  assert.equal(calls.filter(c => c === 'npm ci --no-audit --no-fund').length, 2, 'bot + dashboard');
  const pull = calls.indexOf('git pull --ff-only origin main');
  assert.ok(pull < calls.findIndex(c => c.startsWith('npm ')), 'le code avant les dépendances');
  for (const c of ['npm run build', 'npm run doctor', 'pm2 start ecosystem.config.cjs']) assert.ok(calls.includes(c), c);
  assert.match(r.stdout, /Déployé : branche main, commit abc1234 Dernier commit/);
});
