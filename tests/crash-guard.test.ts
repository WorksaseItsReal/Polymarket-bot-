/**
 * tests/crash-guard.test.ts — espacement des alertes Telegram quand le bot plante en boucle.
 * Exécution : `npx tsx --test tests/crash-guard.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBotProcess, noteStart, noteStop } from '../src/services/crash-guard.ts';

const MIN = 60_000;
const DEAD_PID = 99_999_999; // au-delà de pid_max : jamais vivant
const file = () => join(mkdtempSync(join(tmpdir(), 'crash-')), 'run-state.json');

test('arrêts propres : aucune alerte, démarrage toujours annoncé', () => {
  const f = file();
  for (let i = 0; i < 5; i++) {
    const st = noteStart(f, i * MIN, DEAD_PID - 10 + i);
    assert.deepEqual(st, { brutal: false, afterError: false, recentCrashes: 0, announce: true, otherInstance: false });
    assert.equal(noteStop(f, false, i * MIN + 30_000, DEAD_PID - 10 + i).alert, false);
  }
});

test('boucle de plantage toutes les 2 min : alertes à 0, 10, 30, 70 min… et démarrages tus entre-temps', () => {
  const f = file();
  const alerts: number[] = [];
  const announces: number[] = [];
  for (let m = 0; m < 6 * 60; m += 2) {
    const pid = DEAD_PID - 1000 + m;
    if (noteStart(f, m * MIN, pid).announce) announces.push(m);
    if (noteStop(f, true, m * MIN + MIN, pid).alert) alerts.push(m + 1);
  }
  assert.deepEqual(alerts, [1, 11, 31, 71, 151, 311], 'espacement 10 → 20 → 40 → 80 → 160 min');
  // Le 1er démarrage, puis seulement ceux qui suivent un arrêt signalé.
  assert.deepEqual(announces, [0, 2, 12, 32, 72, 152, 312]);
  assert.equal(noteStart(f, 7 * 60 * MIN, DEAD_PID).afterError, true, 'lancement qui suit un arrêt sur erreur');
});

test('l\'espacement repart de zéro après une heure sans arrêt', () => {
  const f = file();
  assert.equal(noteStop(f, true, 0).alert, true);
  assert.equal(noteStop(f, true, 2 * MIN).alert, false);
  const r = noteStop(f, true, 2 * MIN + 61 * MIN);
  assert.equal(r.alert, true);
  assert.equal(r.recentCrashes, 1);
});

test('arrêt brutal (marqueur resté en place, process mort) : détecté au lancement suivant', () => {
  const f = file();
  noteStart(f, 0, DEAD_PID);
  const st = noteStart(f, 5 * MIN, 4242);
  assert.equal(st.brutal, true);
  assert.equal(st.recentCrashes, 1);
  assert.equal(st.announce, true, 'arrêt brutal signalé avec le démarrage');
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).running.pid, 4242);
});

test('autre instance vivante avec le même dossier : pas un plantage, marqueur conservé', () => {
  const f = file();
  noteStart(f, 0, 1234);
  const st = noteStart(f, MIN, DEAD_PID, pid => pid === 1234);
  assert.equal(st.otherInstance, true);
  assert.equal(st.brutal, false);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).running.pid, 1234);
});

test('PID repris par un autre programme (après un reboot) : arrêt brutal, pas « autre instance »', () => {
  assert.equal(isBotProcess(process.pid), process.argv.join(' ').includes('bot-with-dashboard'), 'ce test n\'est pas le bot');
  assert.equal(isBotProcess(DEAD_PID), false);
  const f = file();
  noteStart(f, 0, process.pid); // le PID du test : vivant, mais pas un bot
  const st = noteStart(f, MIN, DEAD_PID);
  assert.equal(st.otherInstance, false);
  assert.equal(st.brutal, true);
});

test('fichier illisible ou champs absurdes : on repart de zéro sans lever', () => {
  const f = file();
  writeFileSync(f, '{tronqué');
  assert.equal(noteStart(f, 0, DEAD_PID).announce, true);
  writeFileSync(f, JSON.stringify({ crashes: ['x', null, 5], lastAlertAt: 'y', running: { pid: 'z' } }));
  const st = noteStart(f, 10, DEAD_PID - 1);
  assert.equal(st.brutal, false);
  assert.equal(st.recentCrashes, 1);
  // Écriture impossible (le « dossier » parent est un fichier) : sans effet. (Pas /proc :
  // mkdirSync récursif y boucle indéfiniment sous Node 22.)
  const notDir = join(mkdtempSync(join(tmpdir(), 'crash-')), 'fichier');
  writeFileSync(notDir, '');
  assert.equal(noteStart(join(notDir, 'run-state.json'), 0, DEAD_PID).announce, true);
});
