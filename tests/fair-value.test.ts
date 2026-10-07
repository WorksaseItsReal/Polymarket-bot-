/**
 * tests/fair-value.test.ts — modèle de juste valeur Up/Down 5 min.
 * Exécution : `npx tsx --test tests/fair-value.test.ts`
 *
 * On exerce les VRAIES fonctions exportées (aucune copie, aucun mock réseau).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FAIR_VALUE_CONFIG as CFG,
  decide,
  effectiveCostPerShare,
  estimateFill,
  fairValueConfigFromEnv,
  normCdf,
  probUp,
  realizedVolPerSqrtSec,
  studentT4CdfStd,
  takerFeePerShare,
  twapVarianceSeconds,
} from '../src/services/fair-value.ts';
import { deriveRoundData } from '../src/services/round-market-data.ts';

const close = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);

// σ réaliste BTC : ~0,05 % par minute → par √s
const SIGMA = 0.0005 / Math.sqrt(60);

test('normCdf : valeurs de référence', () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.96), 0.975, 1e-4);
  close(normCdf(-1.96), 0.025, 1e-4);
});

test('t4 réduite : symétrique, centrée, intègre sa densité, queues plus épaisses que la normale', () => {
  close(studentT4CdfStd(0), 0.5, 1e-12);
  for (const x of [0.3, 1, 2.5]) close(studentT4CdfStd(x) + studentT4CdfStd(-x), 1, 1e-12);
  // Densité de la t4 réduite : f(x) = √2 · (3/8) · (1 + 2x²/4)^(−5/2)
  const pdf = (x: number) => Math.SQRT2 * 0.375 * Math.pow(1 + (2 * x * x) / 4, -2.5);
  let acc = 0;
  const steps = 15_000;
  const h = 1.5 / steps;
  for (let i = 0; i < steps; i++) acc += pdf((i + 0.5) * h) * h;
  close(0.5 + acc, studentT4CdfStd(1.5), 1e-6);
  assert.ok(studentT4CdfStd(3) < normCdf(3), 'queue droite plus lourde');
});

test('frais taker crypto_fees_v2 et coût réel', () => {
  close(takerFeePerShare(0.5, 0.07), 0.0175, 1e-12);
  close(effectiveCostPerShare(0.6, 0.07), 0.6 + 0.07 * 0.6 * 0.4, 1e-12);
});

test('vol réalisée : null sans assez de points, valeur exacte sinon', () => {
  assert.equal(realizedVolPerSqrtSec([100, 101], 60), null);
  const r = 0.001;
  const closes = [100];
  for (let i = 0; i < 20; i++) closes.push(closes[closes.length - 1] * Math.exp(i % 2 ? -r : r));
  close(realizedVolPerSqrtSec(closes, 60)!, r / Math.sqrt(60), 1e-12);
  // un point invalide est ignoré, pas transformé en rendement
  assert.ok(realizedVolPerSqrtSec([...closes, 0, NaN], 60)! > 0);
});

test('variance TWAP : continue en τ = W, plein chemin au-delà', () => {
  close(twapVarianceSeconds(300, 60), 260, 1e-12);
  close(twapVarianceSeconds(60, 60), 20, 1e-12);
  close(twapVarianceSeconds(60 - 1e-9, 60), 20, 1e-6);
  assert.equal(twapVarianceSeconds(0, 60), 0);
});

test('probUp : 0,5 au strike, monotone en spot, se rapproche de 0,5 quand τ augmente', () => {
  close(probUp({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!, 0.5, 1e-6); // précision de normCdf ≈ 1,5e-7
  const up = probUp({ spot: 100.05, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!;
  const upMore = probUp({ spot: 100.1, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!;
  const upLong = probUp({ spot: 100.05, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 240 })!;
  assert.ok(up > 0.5 && upMore > up && upLong < up && upLong > 0.5);
  // symétrie : spot sous le strike du même écart log
  close(probUp({ spot: 100 * 100 / 100.05, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!, 1 - up, 1e-6);
  // jamais 0 ni 1
  assert.ok(probUp({ spot: 200, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })! <= 0.99);
});

test('probUp : entrées invalides → null (jamais 0,5 par défaut)', () => {
  assert.equal(probUp({ spot: 0, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 }), null);
  assert.equal(probUp({ spot: 100, strike: NaN, sigmaPerSqrtSec: SIGMA, tauSec: 120 }), null);
  assert.equal(probUp({ spot: 100, strike: 100, sigmaPerSqrtSec: 0, tauSec: 120 }), null);
  assert.equal(probUp({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 0 }), null);
});

test('decide : un carnet calibré sur le modèle ne déclenche AUCUN trade (les frais mangent tout)', () => {
  const base = { spot: 100.04, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 150 };
  const p = probUp(base)!;
  const upAsk = Math.round(p * 100) / 100 + 0.01; // ask = juste valeur + 1 tick (demi-spread)
  const downAsk = Math.round((1 - p) * 100) / 100 + 0.01;
  const d = decide({ ...base, upAsk, downAsk });
  assert.equal(d.side, null, d.reason);
});

test('decide : un carnet en retard sur le spot déclenche l\'achat du bon côté', () => {
  const base = { spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 };
  const p = probUp(base)!;
  assert.ok(p > 0.75, `p=${p}`);
  const d = decide({ ...base, upAsk: 0.6, downAsk: 0.41 });
  assert.equal(d.side, 'UP', d.reason);
  close(d.best!.edge, p - effectiveCostPerShare(0.6, CFG.takerFeeRate), 1e-12);
  // même situation vue côté DOWN
  const dn = decide({ ...base, spot: 100 * 100 / 100.12, upAsk: 0.41, downAsk: 0.6 });
  assert.equal(dn.side, 'DOWN', dn.reason);
});

test('decide : bornes de τ et d\'ask respectées', () => {
  const base = { spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, upAsk: 0.6, downAsk: 0.41 };
  assert.equal(decide({ ...base, tauSec: 30 }).side, null);
  assert.equal(decide({ ...base, tauSec: 290 }).side, null);
  // favori à 0,95 : hors borne même si le modèle dit 0,99
  const big = decide({ ...base, spot: 101, tauSec: 120, upAsk: 0.95, downAsk: 0.06 });
  assert.equal(big.side, null, big.reason);
  // ask absent ou aberrant
  assert.equal(decide({ ...base, tauSec: 120, upAsk: null, downAsk: null }).side, null);
  assert.equal(decide({ ...base, tauSec: 120, upAsk: 1, downAsk: 0 }).side, null);
});

test('estimateFill : trie les asks, consomme la profondeur, respecte le prix limite', () => {
  const asks = [
    { price: 0.99, size: 1000 },
    { price: 0.62, size: 10 },
    { price: 0.61, size: 5 },
  ];
  const f = estimateFill(asks, 5);
  // 5 parts × 0,61 = 3,05 ; reste 1,95 à 0,62 → 3,1452 parts
  close(f.shares, 5 + 1.95 / 0.62, 1e-9);
  close(f.avgPrice!, 5 / f.shares, 1e-12);
  assert.equal(f.complete, true);
  const lim = estimateFill(asks, 50, 0.62);
  assert.equal(lim.complete, false);
  close(lim.spent, 3.05 + 6.2, 1e-9);
  const empty = estimateFill([], 5);
  assert.equal(empty.avgPrice, null);
  assert.equal(empty.complete, false);
});

test('config depuis env : valeurs invalides ignorées, bornes incohérentes rejetées', () => {
  const c = fairValueConfigFromEnv({ FV_MIN_EDGE: 'abc', FV_BASIS_BPS: '-3', FV_MIN_TAU_SEC: '200', FV_MAX_TAU_SEC: '100', FV_TAILS: 't4' });
  assert.equal(c.minEdge, CFG.minEdge);
  assert.equal(c.basisBps, CFG.basisBps);
  assert.equal(c.minTauSec, CFG.minTauSec);
  assert.equal(c.maxTauSec, CFG.maxTauSec);
  assert.equal(c.tails, 't4');
  assert.equal(fairValueConfigFromEnv({}).tails, 'normal', 'normale par défaut');
  assert.equal(fairValueConfigFromEnv({ FV_MIN_EDGE: '0.06' }).minEdge, 0.06);
});

test('deriveRoundData : strike = open du slot, spot = close courant, flux périmé → null', () => {
  const slot = 1_790_000_100;
  const candles = [] as Array<{ openTimeMs: number; open: number; close: number }>;
  let px = 100;
  for (let i = -40; i <= 2; i++) {
    const open = px;
    px = px * Math.exp((i % 2 ? 1 : -1) * 0.0004);
    candles.push({ openTimeMs: (slot + i * 60) * 1000, open, close: px });
  }
  const now = (slot + 2 * 60 + 30) * 1000;
  const d = deriveRoundData(candles, slot, now, 'test')!;
  assert.equal(d.strike, candles.find(c => c.openTimeMs === slot * 1000)!.open);
  assert.equal(d.spot, candles[candles.length - 1].close);
  close(d.sigmaPerSqrtSec, 0.0004 / Math.sqrt(60), 1e-9);
  assert.equal(deriveRoundData(candles, slot, now + 10 * 60_000, 'test'), null, 'flux figé');
  assert.equal(deriveRoundData(candles, slot + 3600, now, 'test'), null, 'slot absent');
});
