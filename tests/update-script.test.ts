/**
 * tests/update-script.test.ts — scripts/update.sh (`npm run upgrade`) : le serveur ne déploie
 * que main, et le registre est sauvegardé avant toute relance du bot.
 * Exécution : `npx tsx --test tests/update-script.test.ts`
 *
 * Le vrai script (et scripts/lib/backup-ledger.sh) est lancé par bash, COPIÉ dans un dossier
 * temporaire (il travaille dans le parent de scripts/), avec un HOME temporaire et un PATH où
 * `git`, `npm` et `pm2` sont des faux qui notent leurs appels dans un fichier témoin : aucune
 * commande réelle, aucun accès réseau.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/update.sh', import.meta.url));
const LIB = fileURLToPath(new URL('../scripts/lib/backup-ledger.sh', import.meta.url));

/** Faux git du chemin nominal : main, commit abc1234, tout réussit. */
const FAKE_GIT = [
  'case "$*" in',
  '  "rev-parse --abbrev-ref HEAD") echo main ;;',
  '  "rev-parse --short HEAD") echo abc1234 ;;',
  '  "log --oneline -1") echo "abc1234 Dernier commit" ;;',
  'esac',
  'exit 0',
].join('\n');

interface Sandbox { log: string; poly: string; run: (...args: string[]) => SpawnSyncReturns<string> }

/** Copie du script dans un dépôt factice + faux exécutables (chacun note « nom args » dans `log`). */
function sandbox(fakes: Record<string, string>): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'update-sh-'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'dashboard'));
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  writeFileSync(join(dir, 'dashboard', 'package-lock.json'), '{}');
  const script = join(dir, 'scripts', 'update.sh');
  copyFileSync(SCRIPT, script);
  copyFileSync(LIB, join(dir, 'scripts', 'lib', 'backup-ledger.sh'));
  const home = join(dir, 'home');
  const poly = join(home, '.polymarket');
  mkdirSync(poly, { recursive: true });
  const log = join(dir, 'appels.log');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const run = (...args: string[]) => spawnSync('bash', [script, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  return { log, poly, run };
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

test('update.sh sans argument : fetch, checkout et pull de main seulement, puis dépendances, dashboard, doctor, sauvegarde, PM2', () => {
  const { log, poly, run } = sandbox({ git: FAKE_GIT, npm: 'exit 0', pm2: 'exit 0' });
  writeFileSync(join(poly, 'fv-ledger.json'), '[]');
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
  // Registre sauvegardé, nommé d'après le code qui l'a écrit, AVANT la relance PM2.
  const backups = readdirSync(join(poly, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^ledger-\d{8}-\d{6}-abc1234$/);
  assert.deepEqual(readdirSync(join(poly, 'backups', backups[0])), ['fv-ledger.json']);
  assert.ok(r.stdout.indexOf('Sauvegarde du registre') < r.stdout.indexOf('PM2 : relance'), r.stdout);
});

test('update.sh : sauvegarde du registre impossible → arrêt (code 1) AVANT toute relance PM2', () => {
  const { log, poly, run } = sandbox({ git: FAKE_GIT, npm: 'exit 0', pm2: 'exit 0' });
  writeFileSync(join(poly, 'fv-ledger.json'), '[]');
  writeFileSync(join(poly, 'backups'), 'un fichier à la place du dossier : mkdir échoue');
  const r = run();
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /Sauvegarde du registre impossible : le bot n'est PAS relancé/);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.some(c => c.startsWith('pm2 ')), false, calls.join('\n'));
});

test('update.sh : aucun registre (première installation) → rien à sauvegarder, bot relancé', () => {
  const { log, poly, run } = sandbox({ git: FAKE_GIT, npm: 'exit 0', pm2: 'exit 0' });
  const r = run();
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /rien à sauvegarder/);
  assert.equal(existsSync(join(poly, 'backups')), false);
  assert.ok(readFileSync(log, 'utf8').includes('pm2 start ecosystem.config.cjs'));
});
