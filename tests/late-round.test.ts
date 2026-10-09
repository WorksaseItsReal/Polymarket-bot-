/**
 * tests/late-round.test.ts — mesure « fin de round » (τ < fenêtre TWAP) : P(Up) avec la part déjà
 * acquise du TWAP, moyenne par seconde du flux spot, journal séparé, rejeu dans l'analyse.
 * Jamais d'entrée : on vérifie aussi cela.
 * Exécution : `npx tsx --test tests/late-round.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FAIR_VALUE_CONFIG, probUp, probUpLate } from '../src/services/fair-value.ts';
import { SpotStream } from '../src/services/spot-stream.ts';
import { DecisionJournal, type DecisionRecord } from '../src/services/decision-journal.ts';
import { compareProbs, lateRounds, liveStrikeAvailability, marketProbUp, replay, type ResolvedRecord } from '../src/analysis/fv-analysis.ts';
import { loadBotConfig } from '../src/bot/config.ts';

const SIG = 0.0005 / Math.sqrt(60);
const cfg = DEFAULT_FAIR_VALUE_CONFIG;

test('probUpLate : continu avec probUp à τ = W, tranché quand la part acquise domine, null hors domaine', () => {
  const base = { spot: 100.02, strike: 100, sigmaPerSqrtSec: SIG };
  const atW = probUpLate({ ...base, tauSec: 60, partialMean: 123, knownSec: 0 }, cfg)!;
  assert.ok(Math.abs(atW - probUp({ ...base, tauSec: 60 }, cfg)!) < 1e-12, 'à τ = W, la part acquise ne pèse rien');
  // 50 s acquises nettement au-dessus du prix à battre : quasi certain même si le spot est revenu dessous
  const sure = probUpLate({ ...base, spot: 99.98, tauSec: 10, partialMean: 100.08, knownSec: 50 }, cfg)!;
  assert.ok(sure > 0.95, `P=${sure}`);
  const lost = probUpLate({ ...base, spot: 100.03, tauSec: 10, partialMean: 99.9, knownSec: 50 }, cfg)!;
  assert.ok(lost < 0.05, `P=${lost}`);
  // Plus il reste de temps, moins la part acquise tranche
  const p30 = probUpLate({ ...base, tauSec: 30, partialMean: 100.04, knownSec: 30 }, cfg)!;
  const p5 = probUpLate({ ...base, tauSec: 5, partialMean: 100.04, knownSec: 55 }, cfg)!;
  assert.ok(p5 > p30 && p30 > 0.5, `p5=${p5} p30=${p30}`);
  assert.equal(probUpLate({ ...base, tauSec: 61, partialMean: 100, knownSec: 0 }, cfg), null, 'hors fenêtre');
  assert.equal(probUpLate({ ...base, tauSec: 10, partialMean: 0, knownSec: 50 }, cfg), null);
  assert.equal(probUpLate({ ...base, tauSec: 10, partialMean: 100, knownSec: 50 }, { ...cfg, twapWindowSec: 0 }), null, 'sans TWAP, pas de fin de round');
});

test('SpotStream.meanSince : dernier prix par seconde, report sur les secondes vides, null sans prix au début', () => {
  let now = 1_790_000_000_000;
  const s = new SpotStream({ coins: ['BTC'], now: () => now, log: () => undefined });
  const tick = (price: number) => (s as unknown as { onMessage(raw: string): void }).onMessage(JSON.stringify({ data: { e: 'aggTrade', s: 'BTCUSDT', p: String(price), T: now } }));
  tick(100); // seconde 0
  now += 1000; tick(101); now += 200; tick(103); // seconde 1 : dernier prix 103
  now += 3800; tick(107); // seconde 5 (2, 3, 4 : report de 103)
  // [0, 6) : 100, 103, 103, 103, 103, 107
  assert.ok(Math.abs(s.meanSince('BTC', 1_790_000_000_000, 1_790_000_006_000)! - (100 + 103 * 4 + 107) / 6) < 1e-9);
  assert.ok(Math.abs(s.meanSince('BTC', 1_790_000_002_000, 1_790_000_005_000)! - 103) < 1e-9, 'secondes sans échange : dernier prix connu');
  assert.equal(s.meanSince('BTC', 1_789_999_990_000, 1_789_999_995_000), null, 'aucun prix connu au début');
  assert.equal(s.meanSince('ETH', 1_790_000_000_000, 1_790_000_006_000), null);
  assert.equal(s.meanSince('BTC', 1_790_000_003_000, 1_790_000_003_000), null, 'intervalle vide');
  // Flux coupé pendant 30 s au milieu de la fenêtre : pas de moyenne fictive
  now += 30_000; tick(111); // seconde 35
  assert.equal(s.meanSince('BTC', 1_790_000_000_000, 1_790_000_036_000), null, 'trou de 30 s : flux coupé → null');
  assert.ok(Math.abs(s.meanSince('BTC', 1_790_000_035_000, 1_790_000_036_000)! - 111) < 1e-9, 'après la coupure, la fenêtre récente est valide');
});

test('journal : une mesure fin de round n\'est pas écrasée par le passage régulier du même round', () => {
  const j = new DecisionJournal({ dir: mkdtempSync(join(tmpdir(), 'journal-late-')), minIntervalMs: 10_000, keepDays: 1 });
  const t = 1_790_000_200_000;
  const rec = (over: Partial<DecisionRecord>): DecisionRecord => ({
    t, slug: 'btc-updown-5m-1790000100', coin: 'BTC', tau: 100, spot: 100, strike: 100, sig: SIG, pUp: 0.5, upAsk: 0.5, downAsk: 0.5,
    upAskSz: 1, downAskSz: 1, src: 'test', act: 'hold', ...over,
  });
  assert.equal(j.record(rec({})), true);
  assert.equal(j.record(rec({ t: t + 1000, tau: 50, lt: true, pl: 0.9, kn: 10 })), true, 'clé séparée');
  assert.equal(j.record(rec({ t: t + 2000, tau: 49, lt: true, pl: 0.9, kn: 11 })), false, 'puis espacée comme les autres');
});

test('analyse : lateRounds ramène pl en pUp, rejeu et comparaison appariée fonctionnent, réglage FV_LATE_MEASURE', () => {
  const rounds: ResolvedRecord[][] = [];
  for (let i = 0; i < 40; i++) {
    const slot = 1_790_000_100 + i * 300;
    const upWon = i % 3 !== 0;
    const pl = upWon ? 0.9 : 0.1;
    rounds.push([
      { t: slot * 1000 + 150_000, slug: `btc-updown-5m-${slot}`, coin: 'BTC', tau: 150, spot: 100, strike: 100, sig: SIG, pUp: 0.55, pRaw: 0.55, upAsk: 0.55, downAsk: 0.46, upAskSz: 10, downAskSz: 10, src: 't', act: 'hold', upWon },
      { t: slot * 1000 + 270_000, slug: `btc-updown-5m-${slot}`, coin: 'BTC', tau: 30, spot: 100, strike: 100, sig: SIG, pUp: 0.55, pRaw: 0.55, lt: true, pl, kn: 30, upAsk: 0.7, downAsk: 0.31, upAskSz: 10, downAskSz: 10, src: 't', act: 'hold', upWon },
    ]);
  }
  const late = lateRounds(rounds);
  assert.equal(late.length, 40);
  assert.ok(late.every(l => l.length === 1 && l[0].pUp === l[0].pl && l[0].tau === 30), 'seules les mesures fin de round, pUp = pl');
  const r = replay(late, cfg.minEdge, cfg.minProb, { feeRate: cfg.takerFeeRate, minAsk: cfg.minAsk, maxAsk: cfg.maxAsk, minTau: 5, maxTau: 60, noiseK: 0 });
  assert.equal(r.n, 40, 'un pari hypothétique par round');
  assert.equal(r.wins, 40, 'le modèle fin de round (parfait ici) gagne à chaque fois');
  const c = compareProbs(late, x => x.pUp, marketProbUp, { minTau: 5, maxTau: 60 });
  assert.equal(c.rounds, 40);
  assert.ok(c.brierA! < c.brierB! && c.t! < -2, `modèle ${c.brierA} < carnet ${c.brierB}, t=${c.t}`);
  assert.equal(lateRounds(rounds.map(l => l.filter(x => !x.lt))).length, 0);
  assert.equal(loadBotConfig({ FV_LATE_MEASURE: 'false' }).config.fv.lateMeasure, false);
  assert.equal(loadBotConfig({ FV_LATE_MEASURE: 'off' }).config.fv.lateMeasure, false, 'mêmes orthographes que les autres booléens');
  assert.deepEqual(loadBotConfig({ FV_LATE_MEASURE: '0' }).warnings, []);
  assert.equal(loadBotConfig({}).config.fv.lateMeasure, true);
  assert.match(loadBotConfig({ FV_LATE_MEASURE: 'peut-être' }).warnings.join('\n'), /FV_LATE_MEASURE=peut-être ignoré/);
});

test('liveStrikeAvailability : part des rounds avec le prix officiel en direct, délai, égalité avec la valeur du règlement', () => {
  const rec = (slot: number, t: number, ps?: number): ResolvedRecord => ({
    t: t * 1000, slug: `btc-updown-5m-${slot}`, coin: 'BTC', tau: slot + 300 - t, spot: 100, strike: 100, sig: SIG, pUp: 0.5,
    upAsk: 0.5, downAsk: 0.5, upAskSz: 1, downAskSz: 1, src: 't', act: 'hold', upWon: true, ...(ps ? { ps } : {}),
  });
  const S = 1_790_000_100;
  const rounds = [
    [rec(S, S + 40), rec(S, S + 50, 100.1), rec(S, S + 60, 100.1)], // publié, délai 50 s
    [rec(S + 300, S + 330, 99.9)], // publié, délai 30 s, différent du règlement
    [rec(S + 600, S + 640)], // jamais vu
  ];
  const a = liveStrikeAvailability(rounds, { [`btc-updown-5m-${S}`]: [100.1, null], [`btc-updown-5m-${S + 300}`]: [99.95, null] });
  assert.deepEqual(a, { rounds: 3, withPs: 2, medianDelaySec: 50, compared: 2, same: 1 });
  assert.deepEqual(liveStrikeAvailability([], {}), { rounds: 0, withPs: 0, medianDelaySec: null, compared: 0, same: 0 });
});
