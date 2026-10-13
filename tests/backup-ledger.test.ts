/**
 * tests/backup-ledger.test.ts — scripts/lib/backup-ledger.sh : sauvegarde du registre avant
 * toute relance du bot (update.sh).
 * Exécution : `npx tsx --test tests/backup-ledger.test.ts`
 *
 * Le vrai script, lancé seul par bash avec un HOME temporaire (aucun fichier réel touché).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../scripts/lib/backup-ledger.sh', import.meta.url));

function home(): { home: string; poly: string; backups: string } {
  const h = mkdtempSync(join(tmpdir(), 'backup-ledger-'));
  const poly = join(h, '.polymarket');
  mkdirSync(poly);
  return { home: h, poly, backups: join(poly, 'backups') };
}
const backup = (h: string, ...args: string[]) =>
  spawnSync('bash', [LIB, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: h } });
const ledgerDirs = (backups: string) => readdirSync(backups).filter(n => /^ledger-\d{8}-\d{6}-/.test(n)).sort();

test('sauvegarde : registres JSON et JSONL et arrêts de sécurité copiés (dates conservées), rien d\'autre', () => {
  const { home: h, poly, backups } = home();
  const files: Record<string, string> = {
    'fv-ledger.json': '[{"id":1}]',
    'fv-ledger.jsonl': '{"id":1}\n{"id":2}\n',
    'fv-guard.json': '{"reason":"perte"}',
    'fv-guard-late.json': '{"reason":"récolte"}',
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(poly, name), body);
  writeFileSync(join(poly, 'fv-shadow.json'), '{}');
  writeFileSync(join(poly, 'run-state.json'), '{}');
  const old = new Date('2026-10-01T12:00:00Z');
  utimesSync(join(poly, 'fv-ledger.json'), old, old);

  const r = backup(h, 'abc1234');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dirs = ledgerDirs(backups);
  assert.equal(dirs.length, 1);
  const m = /^ledger-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-abc1234$/.exec(dirs[0]);
  assert.ok(m, dirs[0]);
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  assert.ok(Math.abs(at - Date.now()) < 120_000, `horodatage UTC : ${dirs[0]}`);
  const dest = join(backups, dirs[0]);
  assert.deepEqual(readdirSync(dest).sort(), Object.keys(files).sort());
  for (const [name, body] of Object.entries(files)) assert.equal(readFileSync(join(dest, name), 'utf8'), body, name);
  assert.equal(statSync(join(dest, 'fv-ledger.json')).mtimeMs, old.getTime(), 'cp -p : date d\'origine conservée');
  assert.match(r.stdout, /Registre sauvegardé/);

  // Deuxième sauvegarde (même seconde possible) : un nouveau dossier, jamais d'écrasement.
  assert.equal(backup(h, 'abc1234').status, 0);
  assert.equal(ledgerDirs(backups).length, 2);
  // Sha douteux → « inconnu » (pas de chemin fabriqué depuis l'argument).
  assert.equal(backup(h, '../../x').status, 0);
  assert.ok(ledgerDirs(backups).some(n => n.endsWith('-inconnu')), ledgerDirs(backups).join(' '));
});

test('rotation : 10 sauvegardes gardées (les plus récentes), rien d\'autre supprimé', () => {
  const { home: h, poly, backups } = home();
  writeFileSync(join(poly, 'fv-ledger.jsonl'), '{"id":1}\n');
  mkdirSync(backups);
  const old = Array.from({ length: 12 }, (_, i) => `ledger-20250101-0000${String(i).padStart(2, '0')}-aaaaaaa`);
  for (const d of old) mkdirSync(join(backups, d));
  // Hors motif : à ne jamais toucher.
  const others = ['ledger-notes', 'autre-dossier', 'ledger-20240101-000000-AAAA'];
  for (const d of others) mkdirSync(join(backups, d));
  writeFileSync(join(backups, 'ledger-20240101-000000-bbbbbbb'), 'un fichier, pas un dossier');
  writeFileSync(join(backups, 'LISEZMOI.txt'), 'x');

  const r = backup(h, 'def5678');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const kept = readdirSync(backups).filter(n => /^ledger-\d{8}-\d{6}-[0-9a-z]+(-\d+)?$/.test(n) && statSync(join(backups, n)).isDirectory()).sort();
  assert.equal(kept.length, 10, kept.join('\n'));
  assert.deepEqual(kept.slice(0, 9), old.slice(3), 'les 3 plus anciennes supprimées');
  assert.match(kept[9], /-def5678$/, 'la nouvelle est gardée');
  for (const n of [...others, 'ledger-20240101-000000-bbbbbbb', 'LISEZMOI.txt']) assert.ok(existsSync(join(backups, n)), `${n} supprimé à tort`);
});

test('sauvegarde : aucun registre → succès sans dossier créé ; copie impossible → code non nul', () => {
  const vide = home();
  const r = backup(vide.home, 'abc1234');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /rien à sauvegarder/);
  assert.equal(existsSync(vide.backups), false);

  const bloque = home();
  writeFileSync(join(bloque.poly, 'fv-ledger.json'), '[]');
  writeFileSync(bloque.backups, 'un fichier à la place du dossier');
  const ko = backup(bloque.home, 'abc1234');
  assert.notEqual(ko.status, 0);
  assert.match(ko.stderr, /Impossible de créer/);
});
