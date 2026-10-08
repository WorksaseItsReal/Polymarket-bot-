/**
 * tests/decision-journal.test.ts — journal des évaluations, analyse et rapport.
 * Exécution : `npx tsx --test tests/decision-journal.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionJournal, journalFileName, type DecisionRecord } from '../src/services/decision-journal.ts';
import { brier, byRound, calibration, halves, marketProbUp, replay, type ResolvedRecord } from '../src/analysis/fv-analysis.ts';
import { DEFAULT_FAIR_VALUE_CONFIG, normCdf } from '../src/services/fair-value.ts';

const DAY = Date.parse('2026-10-07T00:00:00Z');

function rec(over: Partial<DecisionRecord>): DecisionRecord {
  return {
    t: DAY + 3_600_000, slug: 'btc-updown-5m-1', coin: 'BTC', tau: 120, spot: 100, strike: 100, sig: 1e-4,
    pUp: 0.5, upAsk: 0.51, downAsk: 0.51, upAskSz: 10, downAskSz: 10, src: 'test', act: 'hold', ...over,
  };
}

test('journal : une ligne par round toutes les 10 s, paris toujours écrits, un fichier par jour UTC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  const j = new DecisionJournal({ dir, minIntervalMs: 10_000 });
  assert.equal(j.record(rec({ t: DAY + 1000 })), true);
  assert.equal(j.record(rec({ t: DAY + 5000 })), false, 'bridé');
  assert.equal(j.record(rec({ t: DAY + 6000, act: 'buy', side: 'UP', stake: 0.5 })), true, 'un pari passe toujours');
  assert.equal(j.record(rec({ t: DAY + 6500, slug: 'eth-updown-5m-1' })), true, 'autre round : indépendant');
  assert.equal(j.record(rec({ t: DAY + 86_400_000 + 1 })), true, 'lendemain');
  await j.flush();
  const day1 = readFileSync(join(dir, journalFileName(DAY)), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(day1.length, 3);
  assert.equal(day1[1].act, 'buy');
  assert.ok(existsSync(join(dir, 'decisions-2026-10-08.jsonl')));
});

test('journal : vieux fichiers supprimés, disque en panne → pas d\'exception', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  writeFileSync(join(dir, 'decisions-2026-09-01.jsonl'), '{}\n');
  writeFileSync(join(dir, 'autre.txt'), 'x');
  const j = new DecisionJournal({ dir, keepDays: 10 });
  j.record(rec({}));
  await j.flush();
  assert.equal(existsSync(join(dir, 'decisions-2026-09-01.jsonl')), false);
  assert.ok(existsSync(join(dir, 'autre.txt')), 'les autres fichiers ne sont jamais touchés');

  const logs: string[] = [];
  const blocked = join(dir, 'autre.txt', 'sous-dossier'); // un fichier ne peut pas contenir de dossier
  const bad = new DecisionJournal({ dir: blocked, log: m => logs.push(m) });
  bad.record(rec({}));
  bad.record(rec({ slug: 'x' }));
  await bad.flush();
  assert.equal(logs.length, 1, 'erreur signalée une seule fois');
});

test('analyse : Brier, calibration, prix implicite du carnet', () => {
  const rs: ResolvedRecord[] = [
    { ...rec({ pUp: 0.9 }), upWon: true },
    { ...rec({ pUp: 0.9, slug: 'b' }), upWon: true },
    { ...rec({ pUp: 0.1, slug: 'c' }), upWon: false },
    { ...rec({ pUp: 0.5, slug: 'd' }), upWon: false },
  ];
  const b = brier(rs, r => r.pUp);
  assert.equal(b.n, 4);
  assert.ok(Math.abs(b.score! - (0.01 + 0.01 + 0.01 + 0.25) / 4) < 1e-12);
  const cal = calibration(rs, r => r.pUp, 10);
  assert.deepEqual(cal.map(c => [c.n, c.freqUp]), [[1, 0], [1, 0], [2, 1]]);
  assert.equal(marketProbUp({ upAsk: 0.62, downAsk: 0.4 }), 0.61);
  assert.equal(marketProbUp({ upAsk: null, downAsk: 0.4 }), null);
});

test('analyse : rejeu = un seul pari par round, au premier signal, frais inclus', () => {
  const p = { feeRate: 0.07, minAsk: 0.08, maxAsk: 0.92 };
  const rounds = byRound([
    { ...rec({ slug: 'r1', t: 3, pUp: 0.9, upAsk: 0.7, downAsk: 0.31 }), upWon: true },
    { ...rec({ slug: 'r1', t: 1, pUp: 0.55, upAsk: 0.55, downAsk: 0.46 }), upWon: true }, // pas d'edge
    { ...rec({ slug: 'r1', t: 5, pUp: 0.95, upAsk: 0.6, downAsk: 0.41 }), upWon: true }, // après le pari : ignoré
    { ...rec({ slug: 'r2', t: 2, pUp: 0.1, upAsk: 0.31, downAsk: 0.7 }), upWon: true }, // DOWN, perdu
  ]);
  const r = replay(rounds, 0.04, 0.6, p);
  assert.equal(r.n, 2);
  assert.equal(r.wins, 1);
  const cost = 0.7 + 0.07 * 0.7 * 0.3;
  assert.ok(Math.abs(r.total - ((1 / cost - 1) - 1)) < 1e-12);
  assert.equal(replay(rounds, 0.04, 0.95, p).n, 1, 'seule l\'évaluation à p = 0,95 qualifie');
  assert.equal(replay(rounds, 0.04, 0.99, p).n, 0, 'probabilité minimale respectée');
  const [a, b] = halves(byRound([...Array(10)].map((_, i) => ({ ...rec({ slug: `s${i}`, t: i }), upWon: true }))));
  assert.equal(a.length, 5);
  assert.ok(a.every(l => l[0].t < b[0][0].t));
});

test('rapport complet : journal + résultats en cache → le modèle bat un carnet en retard', () => {
  const home = mkdtempSync(join(tmpdir(), 'report-'));
  const poly = join(home, '.polymarket');
  mkdirSync(join(poly, 'journal'), { recursive: true });
  // Monde simulé : carnet en retard de 10 s sur le spot.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sig = 0.0006 / Math.sqrt(60);
  const lines: string[] = [];
  const cache: Record<string, boolean> = {};
  const now = Date.now();
  for (let k = 0; k < 400; k++) {
    const slot = Math.floor(now / 1000 / 300) * 300 - 3600 * 24 + k * 300;
    const slug = `btc-updown-5m-${slot}`;
    const path = [100];
    for (let t = 1; t <= 300; t++) path.push(path[t - 1] * Math.exp(sig * gauss()));
    cache[slug] = path[300] >= 100;
    for (let t = 40; t <= 250; t += 10) {
      const tau = 300 - t;
      const pUp = normCdf(Math.log(path[t] / 100) / (sig * Math.sqrt(tau + DEFAULT_FAIR_VALUE_CONFIG.strikeNoiseSec)));
      const pMkt = normCdf(Math.log(path[t - 10] / 100) / (sig * Math.sqrt(tau + 10)));
      const tick = (x: number) => Math.min(0.99, Math.max(0.01, Math.ceil(x * 100) / 100));
      lines.push(JSON.stringify(rec({ t: (slot + t) * 1000, slug, tau, spot: path[t], sig, pUp, upAsk: tick(pMkt + 0.005), downAsk: tick(1 - pMkt + 0.005) })));
    }
  }
  writeFileSync(join(poly, 'journal', journalFileName(now)), lines.join('\n') + '\n');
  writeFileSync(join(poly, 'outcomes-cache.json'), JSON.stringify(cache));
  const out = execFileSync('npx', ['tsx', 'scripts/analysis/fv-report.ts', '--days', '3'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 120_000,
  });
  assert.match(out, /400 rounds réglés/);
  assert.match(out, /le modèle bat SIGNIFICATIVEMENT le carnet/);
  assert.match(out, /réglage actuel/);
  assert.match(out, /1b\) Mélange modèle \+ carnet/);
  if (process.env.SHOW_REPORT) console.log(out);
});

test('analyse : statistiques de carnet par coin (écart, miroir, profondeur) ; anciens journaux ignorés', async () => {
  const { bookStats } = await import('../src/analysis/fv-analysis.ts');
  const base = rec({ t: 1, slug: 's', tau: 100, spot: 1, sig: 1, pUp: 0.5, upAsk: 0.52, downAsk: 0.5 });
  const stats = bookStats([
    { ...base, upBid: 0.5, upAskSz: 10 },
    { ...base, upBid: 0.48, upAskSz: 30 },
    { ...base, upBid: 0.5, upAskSz: 20, coin: 'ETH' },
    { ...base }, // ancien journal : pas de bid
  ]);
  assert.equal(stats.length, 2);
  const btc = stats.find(s => s.coin === base.coin)!;
  assert.equal(btc.n, 2);
  assert.ok(Math.abs(btc.medianSpread - 0.03) < 1e-9);
  assert.equal(btc.mirrorShare, 0.5, 'bid 0,50 = 1 − ask Down 0,50 ; bid 0,48 non');
  assert.equal(btc.medianAskSize, 20);
});
