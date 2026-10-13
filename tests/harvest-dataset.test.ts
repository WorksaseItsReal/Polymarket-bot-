/**
 * tests/harvest-dataset.test.ts — rejeu de la récolte sur carnets réels : issue prudente,
 * règle de stabilité, délai d'exécution, et le script complet sur une petite base SQLite.
 * Exécution : `npx tsx --test tests/harvest-dataset.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { datasetOutcome, loadSqlite, simulateAll, simulateRound, type DatasetRound, type HarvestSimOpts, type Tick } from '../src/analysis/harvest-dataset.ts';

const O: HarvestSimOpts = { minAsk: 0.99, maxAsk: 0.995, minTau: 8, maxTau: 30, stableSec: 6, stepSec: 3, delaySec: 1, feeRate: 0.07 };

/** Un instantané par seconde de τ = 299 à 0 ; `up(τ)` donne l'ask Up (Down = miroir). */
function round(slug: string, up: (tau: number) => number, final: 'UP' | 'DOWN' | 'mid' | 'gap'): DatasetRound {
  const ticks: Tick[] = [];
  const last = final === 'gap' ? 20 : 0;
  for (let tau = 299; tau >= last; tau--) {
    let a = up(tau);
    if (tau <= 1 && final !== 'gap') a = final === 'UP' ? 0.99 : final === 'DOWN' ? 0.01 : 0.5;
    const finalUp = tau <= 1 && final === 'UP';
    const finalDown = tau <= 1 && final === 'DOWN';
    ticks.push({ tau: tau + 0.4, upAsk: a, upBid: finalUp ? 1 : a - 0.01, downAsk: finalUp ? 0 : 1 - a + 0.01, downBid: finalDown ? 1 : 1 - a });
  }
  return { slug, asset: 'BTC', startSec: Number(slug.split('-').pop()), ticks };
}

test('issue prudente : carnet final décidé, indécis = perdu, collecteur arrêté = écarté', () => {
  assert.equal(datasetOutcome(round('btc-updown-5m-1', () => 0.5, 'UP')), 'UP');
  assert.equal(datasetOutcome(round('btc-updown-5m-2', () => 0.5, 'DOWN')), 'DOWN');
  assert.equal(datasetOutcome(round('btc-updown-5m-3', () => 0.5, 'mid')), 'undecided');
  assert.equal(datasetOutcome(round('btc-updown-5m-4', () => 0.5, 'gap')), null);
});

test('règle : entrée après 6 s de stabilité dans la fenêtre, à l\'ask 1 s plus tard ; pic, retour ou fenêtre manquée → rien', () => {
  // Bloqué à 0,99 dès τ = 45 s : série stable avant la fenêtre → entrée à la première lecture ≤ 30 s
  const r1 = simulateRound(round('btc-updown-5m-10', t => (t <= 45 ? 0.99 : 0.9), 'UP'), O)!;
  assert.ok(r1 && r1.side === 'UP' && r1.won && r1.tau <= 30 && r1.tau > 26, JSON.stringify(r1));
  const cost = 0.99 + 0.07 * 0.99 * 0.01;
  assert.ok(Math.abs(r1.pnl - (1 / cost - 1)) < 1e-12);
  // Bloqué seulement à partir de τ = 20 s : entrée vers τ 14 s (6 s plus tard)
  const r2 = simulateRound(round('btc-updown-5m-20', t => (t <= 20 ? 0.99 : 0.9), 'UP'), O)!;
  assert.ok(r2.tau <= 14.5 && r2.tau >= 8, `τ ${r2.tau}`);
  // Pic d'une lecture puis retour : jamais stable
  assert.equal(simulateRound(round('btc-updown-5m-30', t => (t === 25 ? 0.99 : 0.95), 'UP'), O), null);
  // Retournement après l'entrée : pari perdu
  const r3 = simulateRound(round('btc-updown-5m-40', t => (t <= 45 ? 0.99 : 0.9), 'DOWN'), O)!;
  assert.equal(r3.won, false);
  assert.equal(r3.pnl, -1);
  // Prix parti au-delà de 0,995 pendant le trajet de l'ordre : rien
  // (décision à τ = 30 s sur 0,99 ; l'ordre arrive à τ = 29 s, l'ask est passé à 0,999)
  assert.equal(simulateRound(round('btc-updown-5m-50', t => (t <= 45 ? (t < 30 ? 0.999 : 0.99) : 0.9), 'UP'), O), null);
  // Résumé : t groupé par créneau
  const s = simulateAll([round('btc-updown-5m-10', t => (t <= 45 ? 0.99 : 0.9), 'UP'), round('btc-updown-5m-40', t => (t <= 45 ? 0.99 : 0.9), 'DOWN'), round('btc-updown-5m-4', () => 0.5, 'gap')], O);
  assert.equal(s.rounds, 2, 'round au collecteur arrêté écarté');
  assert.equal(s.trades, 2);
  assert.equal(s.winRate, 0.5);
});

test('script complet sur une petite base SQLite (si node:sqlite est disponible)', async t => {
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) { t.skip('node:sqlite absent (Node < 22.5)'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'harvest-ds-'));
  const db = new DatabaseSync(join(dir, 'pm_test.db'));
  db.exec('CREATE TABLE ticks (ts_ms INTEGER, asset TEXT, slug TEXT, window_label TEXT, window_start INTEGER, secs_to_close REAL, up_bid REAL, up_ask REAL, down_bid REAL, down_ask REAL, ok INTEGER)');
  const ins = db.prepare('INSERT INTO ticks VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const start0 = 1_786_100_000 - (1_786_100_000 % 300);
  for (let k = 0; k < 40; k++) {
    const start = start0 + k * 300;
    const r = round(`btc-updown-5m-${start}`, tau => (tau <= 45 ? 0.99 : 0.8), k === 7 ? 'DOWN' : 'UP');
    for (const x of r.ticks) ins.run((start + 300 - x.tau) * 1000, 'BTC', r.slug, '5m', start, x.tau, x.upBid, x.upAsk, x.downBid, x.downAsk, 1);
  }
  db.close();
  const out = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/analysis/harvest-dataset.ts', '--dir', dir], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /=== Récolte de fin de round sur carnets réels \(5m\) : 40 rounds/);
  assert.match(out.stdout, /40 paris \/ 40 rounds · gagnés 97\.50 %/);
  assert.match(out.stdout, /SANS stabilité, lecture \/1 s \(premier contact\)/);
});
