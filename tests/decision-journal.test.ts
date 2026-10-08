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
import { brier, byRound, calibration, halves, marketProbUp, replay, strikeVsOfficial, type ResolvedRecord } from '../src/analysis/fv-analysis.ts';
import { DEFAULT_FAIR_VALUE_CONFIG, normCdf } from '../src/services/fair-value.ts';

const DAY = Date.parse('2026-10-07T00:00:00Z');

function rec(over: Partial<DecisionRecord>): DecisionRecord {
  return {
    t: DAY + 3_600_000, slug: 'btc-updown-5m-1', coin: 'BTC', tau: 120, spot: 100, strike: 100, sig: 1e-4,
    // tw : évaluations du modèle en vigueur (règlement TWAP 60 s) ; le rapport ignore les autres
    pUp: 0.5, upAsk: 0.51, downAsk: 0.51, upAskSz: 10, downAskSz: 10, src: 'test', act: 'hold', tw: 60, ...over,
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
    env: { ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null' }, encoding: 'utf8', timeout: 120_000,
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

/** Monde simulé à carnet JUSTE ; le modèle a une volatilité fausse (× volFactor). */
function negativeControlReport(volFactor: number, seed: number): string {
  const home = mkdtempSync(join(tmpdir(), 'report-neg-'));
  const poly = join(home, '.polymarket');
  mkdirSync(join(poly, 'journal'), { recursive: true });
  let a = seed;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sig = 0.0006 / Math.sqrt(60);
  const lines: string[] = [];
  const cache: Record<string, boolean> = {};
  const now = Date.now();
  const coins = ['btc', 'eth', 'sol', 'xrp', 'doge'];
  for (let k = 0; k < 150; k++) {
    const slot = Math.floor(now / 1000 / 300) * 300 - 3600 * 24 + k * 300;
    // les 5 cryptos d'un créneau sont corrélées (facteur commun), comme en vrai
    const common: number[] = [0];
    for (let t = 1; t <= 300; t++) common.push(gauss());
    for (const coin of coins) {
      const slug = `${coin}-updown-5m-${slot}`;
      const path = [100];
      for (let t = 1; t <= 300; t++) path.push(path[t - 1] * Math.exp(sig * (0.8 * common[t] + 0.6 * gauss())));
      cache[slug] = path[300] >= 100;
      for (let t = 40; t <= 250; t += 10) {
        const tau = 300 - t;
        const pMkt = normCdf(Math.log(path[t] / 100) / (sig * Math.sqrt(tau)));
        const pUp = normCdf(Math.log(path[t] / 100) / (volFactor * sig * Math.sqrt(tau + DEFAULT_FAIR_VALUE_CONFIG.strikeNoiseSec)));
        const tick = (x: number) => Math.min(0.99, Math.max(0.01, Math.ceil(x * 100) / 100));
        lines.push(JSON.stringify(rec({ t: (slot + t) * 1000, slug, coin: coin.toUpperCase(), tau, spot: path[t], sig, pUp, upAsk: tick(pMkt + 0.005), downAsk: tick(1 - pMkt + 0.005) })));
      }
    }
  }
  writeFileSync(join(poly, 'journal', journalFileName(now)), lines.join('\n') + '\n');
  writeFileSync(join(poly, 'outcomes-cache.json'), JSON.stringify(cache));
  const out = execFileSync('npx', ['tsx', 'scripts/analysis/fv-report.ts', '--days', '3'], {
    env: { ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null' }, encoding: 'utf8', timeout: 120_000,
  });
  if (process.env.SHOW_REPORT) console.log(out);
  return out;
}

test('contrôle négatif : carnet JUSTE, modèle SOUS-confiant → jamais d\'edge annoncé', () => {
  const out = negativeControlReport(1.4, 2024);
  assert.match(out, /750 rounds réglés/);
  assert.doesNotMatch(out, /le modèle bat SIGNIFICATIVEMENT le carnet/);
  assert.doesNotMatch(out, /essayer FV_BLEND_MODEL/, 'aucun mélange « validé » quand le carnet sait tout');
});

test('contrôle négatif : carnet JUSTE, modèle SUR-confiant (voit de l\'edge partout) → le rejeu montre la perte', () => {
  const out = negativeControlReport(0.6, 7);
  assert.doesNotMatch(out, /le modèle bat SIGNIFICATIVEMENT le carnet/);
  assert.doesNotMatch(out, /essayer FV_BLEND_MODEL/);
  // Ligne du réglage actuel dans la grille : EV/$ ≤ 0 ou t < 2 (jamais un gain « significatif »).
  const row = out.split('\n').find(l => /← réglage actuel/.test(l));
  assert.ok(row, 'le réglage actuel parie (le modèle sur-confiant voit des edges)');
  const m = /(-?\d+\.\d{4})\s+(-?\d+\.\d)\s+\|/.exec(row!);
  assert.ok(m, row);
  const ev = Number(m![1]);
  const t = Number(m![2]);
  assert.ok(!(ev > 0 && t >= 2), `gain « significatif » dans un monde sans edge : ${row}`);
  assert.ok(ev < 0, `perte attendue (spread + frais contre un carnet juste) : ${row}`);
});

test('journal : jours révolus compressés (.jsonl.gz, archive existante jamais écrasée) et relus par le rapport', async () => {
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  const old = 'decisions-2026-10-04.jsonl'; // 3 jours avant l'évaluation (07/10)
  writeFileSync(join(dir, old), '{"a":1}\n{"a":2}\n');
  writeFileSync(join(dir, old + '.gz'), gzipSync('{"deja":1}\n')); // archive déjà là
  writeFileSync(join(dir, 'decisions-2026-10-06.jsonl'), '{"hier":1}\n'); // trop récent : non compressé
  const j = new DecisionJournal({ dir });
  j.record(rec({}));
  await j.flush();
  assert.equal(existsSync(join(dir, old)), false, 'original remplacé par son archive');
  assert.equal(gunzipSync(readFileSync(join(dir, old + '.gz'))).toString(), '{"deja":1}\n', 'archive existante intacte');
  assert.equal(gunzipSync(readFileSync(join(dir, 'decisions-2026-10-04.1.jsonl.gz'))).toString(), '{"a":1}\n{"a":2}\n');
  assert.ok(existsSync(join(dir, 'decisions-2026-10-06.jsonl')));

  // le rapport lit les archives compressées
  const home = mkdtempSync(join(tmpdir(), 'report-gz-'));
  const poly = join(home, '.polymarket');
  mkdirSync(join(poly, 'journal'), { recursive: true });
  const now = Date.now();
  const slot = Math.floor(now / 1000 / 300) * 300 - 3600;
  const lines = [0, 1, 2].map(i => JSON.stringify(rec({ t: now - 3600_000 + i * 10_000, slug: `btc-updown-5m-${slot}`, pUp: 0.6 })));
  writeFileSync(join(poly, 'journal', `decisions-${new Date(now).toISOString().slice(0, 10)}.jsonl.gz`), gzipSync(lines.join('\n') + '\n'));
  writeFileSync(join(poly, 'outcomes-cache.json'), JSON.stringify({ [`btc-updown-5m-${slot}`]: true }));
  const out = execFileSync('npx', ['tsx', 'scripts/analysis/fv-report.ts', '--days', '3'], { env: { ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null' }, encoding: 'utf8', timeout: 120_000 });
  assert.match(out, /Journal : 3 évaluations, 1 rounds, 1 rounds réglés/);
});

test('rapport : les évaluations de l\'ancien modèle (règlement ponctuel, sans tw) sont écartées et signalées', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'report-tw-'));
  const poly = join(home, '.polymarket');
  mkdirSync(join(poly, 'journal'), { recursive: true });
  const now = Date.now();
  const slot = Math.floor(now / 1000 / 300) * 300 - 3600;
  const lines = [
    ...[0, 1].map(i => rec({ t: now - 3600_000 + i * 10_000, slug: `btc-updown-5m-${slot}`, pUp: 0.6, tw: undefined })),
    ...[0, 1, 2].map(i => rec({ t: now - 3500_000 + i * 10_000, slug: `eth-updown-5m-${slot}`, coin: 'ETH', pUp: 0.6, ns: 0.05 })),
  ].map(r => JSON.stringify(r));
  writeFileSync(join(poly, 'journal', `decisions-${new Date(now).toISOString().slice(0, 10)}.jsonl`), lines.join('\n') + '\n');
  writeFileSync(join(poly, 'outcomes-cache.json'), JSON.stringify({ [`btc-updown-5m-${slot}`]: true, [`eth-updown-5m-${slot}`]: true }));
  const r = spawnSync('npx', ['tsx', 'scripts/analysis/fv-report.ts', '--days', '3'], { env: { ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null' }, encoding: 'utf8', timeout: 120_000 });
  assert.match(r.stdout, /Journal : 3 évaluations, 1 rounds/);
  assert.match(r.stderr, /2 évaluations d'un autre modèle ignorées : fenêtre TWAP ≠ 60 s/);
  // bruit enregistré → la marge FV_NOISE_EDGE_K est rejouée sur les vraies données
  assert.match(r.stdout, /selon la marge de bruit FV_NOISE_EDGE_K/);
  assert.match(r.stdout, /k = 1\.5 .*← réglage actuel/);
  assert.match(r.stdout, /0\) Prix à battre : Polymarket ne le publie pas/, 'sans prix publié : dit clairement');
});

test('journal : une évaluation par tranche fixe de 10 s, passages réguliers et sauts du spot séparés', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  const j = new DecisionJournal({ dir });
  const slot = 1_790_000_100;
  const slug = `btc-updown-5m-${slot}`;
  // passages réguliers avec gigue + un saut du spot entre deux
  const regular = [30, 39.97, 50.02, 60.01, 70.03, 79.99, 90].map(s => j.record(rec({ slug, t: (slot + s) * 1000 })));
  const move = j.record(rec({ slug, t: (slot + 64.5) * 1000, mv: true }));
  await j.flush();
  assert.equal(regular.filter(Boolean).length, 7, 'aucun passage régulier perdu (gigue, saut du spot)');
  assert.equal(move, true);
  assert.equal(j.record(rec({ slug, t: (slot + 92) * 1000 })), false, 'même tranche que le passage à 90 s');
});

test('journal : compression interrompue (archive écrite, original encore là) → pas de doublon', async () => {
  const { gzipSync } = await import('node:zlib');
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  const day = 'decisions-2026-10-03.jsonl';
  writeFileSync(join(dir, day), '{"a":1}\n{"a":2}\n');
  writeFileSync(join(dir, day + '.gz'), gzipSync('{"a":1}\n{"a":2}\n')); // même contenu : arrêt avant unlink
  writeFileSync(join(dir, 'decisions-2026-10-02.jsonl.gz.tmp'), 'reste');
  const j = new DecisionJournal({ dir });
  j.record(rec({}));
  await j.flush();
  assert.equal(existsSync(join(dir, day)), false, 'original supprimé');
  assert.equal(existsSync(join(dir, 'decisions-2026-10-03.1.jsonl.gz')), false, 'aucune 2e archive identique');
  assert.equal(existsSync(join(dir, 'decisions-2026-10-02.jsonl.gz.tmp')), false, 'reste temporaire nettoyé');
});

test('rapport : les évaluations « saut du spot » (mv) sont exclues des mesures (le lecteur ne perd pas le marqueur)', () => {
  const home = mkdtempSync(join(tmpdir(), 'report-mv-'));
  const poly = join(home, '.polymarket');
  mkdirSync(join(poly, 'journal'), { recursive: true });
  const now = Date.now();
  const lines: string[] = [];
  const cache: Record<string, boolean> = {};
  for (let k = 0; k < 60; k++) {
    const slot = Math.floor(now / 1000 / 300) * 300 - 3600 * 24 + k * 300;
    const slug = `btc-updown-5m-${slot}`;
    cache[slug] = k % 2 === 0;
    for (const s of [60, 120, 180]) {
      lines.push(JSON.stringify(rec({ t: (slot + s) * 1000, slug, tau: 300 - s, pUp: 0.5, pRaw: 0.5, upAsk: 0.51, downAsk: 0.51 })));
      lines.push(JSON.stringify(rec({ t: (slot + s + 5) * 1000, slug, tau: 295 - s, pUp: 0.95, pRaw: 0.95, upAsk: 0.51, downAsk: 0.51, mv: true })));
    }
  }
  writeFileSync(join(poly, 'journal', journalFileName(now)), lines.join('\n') + '\n');
  writeFileSync(join(poly, 'outcomes-cache.json'), JSON.stringify(cache));
  const out = execFileSync('npx', ['tsx', 'scripts/analysis/fv-report.ts', '--days', '3'], { env: { ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null' }, encoding: 'utf8', timeout: 120_000 });
  assert.match(out, /Journal : 360 évaluations/);
  assert.match(out, /toutes les évaluations\s+: modèle 0\.2500 \| carnet 0\.2500 \(n=180,/, 'seules les 180 évaluations régulières mesurées');
  const calib = out.split('2) Calibration')[1].split('2b)')[0];
  assert.doesNotMatch(calib, /0\.9-1\.0/, 'aucune évaluation mv (p = 0,95) dans la calibration');
});

test('journal : archive numérotée identique déjà présente → pas de nouvelle copie', async () => {
  const { gzipSync } = await import('node:zlib');
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  const day = 'decisions-2026-10-03.jsonl';
  writeFileSync(join(dir, day), '{"a":1}\n');
  writeFileSync(join(dir, day + '.gz'), gzipSync('{"autre":1}\n'));
  writeFileSync(join(dir, 'decisions-2026-10-03.1.jsonl.gz'), gzipSync('{"a":1}\n')); // arrêt avant unlink
  const j = new DecisionJournal({ dir });
  j.record(rec({}));
  await j.flush();
  assert.equal(existsSync(join(dir, day)), false);
  assert.equal(existsSync(join(dir, 'decisions-2026-10-03.2.jsonl.gz')), false, 'pas de 3e archive');
});

test('prix à battre : notre estimation vs Polymarket — décalage, dispersion, correction glissante, cohérence', () => {
  // Décalage constant de +3 bps (Binance vs Chainlink) + bruit ±1 bps alterné ; vrais prix ≈ 100.
  const rounds = Array.from({ length: 40 }, (_, i) => {
    const ptb = 100 * Math.exp(0.001 * Math.sin(i));
    const est = ptb * Math.exp((3 + (i % 2 ? 1 : -1)) / 1e4);
    const final = ptb * (i % 3 ? 1.0005 : 0.9995);
    return { coin: 'BTC', slotSec: 1_790_000_100 + i * 300, est, sig: 1e-4, ptb, final, upWon: final >= ptb };
  });
  const r = strikeVsOfficial(rounds, 3);
  const c = r.coins[0];
  assert.equal(c.n, 40);
  assert.ok(Math.abs(c.meanBps - 3) < 0.05, `décalage ${c.meanBps}`);
  assert.ok(Math.abs(c.sdBps - 1) < 0.05, `dispersion ${c.sdBps}`);
  assert.ok(c.sdResidBps !== null && c.sdResidBps < 1.2, 'le décalage constant disparaît après correction glissante');
  assert.ok(Math.abs(c.assumedBps - 1e4 * 1e-4 * Math.sqrt(3)) < 1e-9);
  assert.deepEqual(r.consistency, { n: 40, agree: 40 });
  // champs incohérents (prix final inversé) : la cohérence le montre
  const bad = strikeVsOfficial(rounds.map(x => ({ ...x, upWon: !x.upWon })), 3);
  assert.equal(bad.consistency.agree, 0);
});

test('rapport : avec les prix publiés par Polymarket, la section 0 compare notre prix à battre', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'report-ptb-'));
  const poly = join(home, '.polymarket');
  mkdirSync(join(poly, 'journal'), { recursive: true });
  const now = Date.now();
  const base = Math.floor(now / 1000 / 300) * 300 - 7200;
  const lines: string[] = [];
  const outcomes: Record<string, boolean> = {};
  const prices: Record<string, [number, number]> = {};
  for (let k = 0; k < 8; k++) {
    const slug = `btc-updown-5m-${base + k * 300}`;
    lines.push(JSON.stringify(rec({ t: (base + k * 300 + 100) * 1000, slug, strike: 100.02, sig: 1e-4, pUp: 0.55 })));
    outcomes[slug] = k % 2 === 0;
    prices[slug] = [100, k % 2 === 0 ? 100.1 : 99.9];
  }
  writeFileSync(join(poly, 'journal', `decisions-${new Date(now).toISOString().slice(0, 10)}.jsonl`), lines.join('\n') + '\n');
  writeFileSync(join(poly, 'outcomes-cache.json'), JSON.stringify(outcomes));
  writeFileSync(join(poly, 'round-prices-cache.json'), JSON.stringify(prices));
  const r = spawnSync('npx', ['tsx', 'scripts/analysis/fv-report.ts', '--days', '3'], { env: { ...process.env, HOME: home, DOTENV_CONFIG_PATH: '/dev/null' }, encoding: 'utf8', timeout: 120_000 });
  assert.match(r.stdout, /0\) Prix à battre : notre estimation .* vs Polymarket \(8 rounds\)/);
  assert.match(r.stdout, /BTC +n= +8 +écart moyen +2\.0 bps/);
  assert.match(r.stdout, /cohérence « prix final ≥ prix à battre ⇔ Up » : 100/);
});
