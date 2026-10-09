/**
 * tests/vol-estimator.test.ts — estimateur de volatilité Parkinson (plus haut/plus bas) :
 * efficacité face à clôture-à-clôture sur un mouvement brownien simulé, sélection par réglage,
 * journalisation des deux σ, comparaison dans l'analyse (probabilités recalculées).
 * Exécution : `npx tsx --test tests/vol-estimator.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FAIR_VALUE_CONFIG, fairValueConfigFromEnv, parkinsonVolPerSqrtSec, probUp, realizedVolPerSqrtSec, selectSigma, twapVarianceSeconds,
} from '../src/services/fair-value.ts';
import { deriveRoundData, type Candle } from '../src/services/round-market-data.ts';
import { compareSigmaEstimators, probWithSigma, type ResolvedRecord } from '../src/analysis/fv-analysis.ts';
import { loadBotConfig } from '../src/bot/config.ts';

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}
const SIG = 0.0005 / Math.sqrt(60); // 0,05 % par minute, par √seconde

/** Bougies 1 min bâties sur un mouvement brownien à la seconde (60 pas par bougie). */
function gbmCandles(n: number, r: () => number, t0 = 1_790_000_000_000): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const open = p;
    let high = p;
    let low = p;
    for (let s = 0; s < 60; s++) {
      p *= Math.exp(SIG * gauss(r));
      high = Math.max(high, p);
      low = Math.min(low, p);
    }
    out.push({ openTimeMs: t0 + i * 60_000, open, close: p, high, low });
  }
  return out;
}

// Pourquoi le défaut reste clôture-à-clôture : l'erreur ALÉATOIRE de Parkinson est bien plus
// petite, mais il est biaisé vers le bas par l'échantillonnage (l'amplitude observée sur 60 pas
// est sous l'amplitude continue) et, sur les vrais marchés, vers le haut par le rebond bid/ask —
// deux biais que seule la mesure sur données réelles (rapport, section 1c) peut arbitrer.
test('Parkinson : dispersion bien plus faible que clôture-à-clôture, biais d\'échantillonnage modéré (négatif)', () => {
  const r = rng(3);
  const W = 60;
  const errCc: number[] = [];
  const errPk: number[] = [];
  for (let k = 0; k < 80; k++) {
    const c = gbmCandles(W, r);
    const cc = realizedVolPerSqrtSec(c.map(x => x.close), 60, 10)!;
    const pk = parkinsonVolPerSqrtSec(c, 60, 10)!;
    errCc.push(cc / SIG - 1);
    errPk.push(pk / SIG - 1);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
  const msg = `cc : biais ${(mean(errCc) * 100).toFixed(1)} %, dispersion ${(sd(errCc) * 100).toFixed(1)} % | parkinson : biais ${(mean(errPk) * 100).toFixed(1)} %, dispersion ${(sd(errPk) * 100).toFixed(1)} %`;
  assert.ok(sd(errPk) < 0.6 * sd(errCc), msg);
  assert.ok(Math.abs(mean(errCc)) < 0.05, msg);
  assert.ok(mean(errPk) < 0 && mean(errPk) > -0.12, msg);
});

test('Parkinson : bougies sans plus haut/plus bas ou incohérentes ignorées, null sous 10 bougies', () => {
  const c = gbmCandles(12, rng(9));
  assert.ok(parkinsonVolPerSqrtSec(c, 60)! > 0);
  const noHl = c.map(({ openTimeMs, open, close }) => ({ openTimeMs, open, close }));
  assert.equal(parkinsonVolPerSqrtSec(noHl, 60), null);
  const bad = c.map(x => ({ ...x, high: x.low })); // plus haut < open/close : incohérent
  assert.equal(parkinsonVolPerSqrtSec(bad, 60), null);
  assert.equal(parkinsonVolPerSqrtSec(c.slice(0, 9), 60), null);
  assert.equal(parkinsonVolPerSqrtSec(c, 0), null);
});

test('selectSigma : réglage respecté, repli si un estimateur manque', () => {
  assert.equal(selectSigma(2, 3, 'cc'), 2);
  assert.equal(selectSigma(2, 3, 'parkinson'), 3);
  assert.ok(Math.abs(selectSigma(3, 4, 'blend')! - Math.sqrt((9 + 16) / 2)) < 1e-12);
  assert.equal(selectSigma(null, 3, 'cc'), null, 'défaut : sans σ clôture-à-clôture, pas de données → pas de pari (pas de repli croisé)');
  assert.equal(selectSigma(2, null, 'parkinson'), 2);
  assert.equal(selectSigma(2, null, 'blend'), 2);
  assert.equal(selectSigma(null, 3, 'blend'), null);
  assert.equal(selectSigma(null, null, 'blend'), null);
  assert.equal(fairValueConfigFromEnv({ FV_VOL_ESTIMATOR: 'parkinson' }).volEstimator, 'parkinson');
  assert.equal(fairValueConfigFromEnv({ FV_VOL_ESTIMATOR: 'n importe quoi' }).volEstimator, 'cc');
  assert.equal(fairValueConfigFromEnv({}).volEstimator, 'cc');
  const { config, warnings } = loadBotConfig({ FV_VOL_ESTIMATOR: 'foo' });
  assert.equal(config.fv.volEstimator, 'cc');
  assert.match(warnings.join('\n'), /FV_VOL_ESTIMATOR=foo ignoré \(attendu : cc, parkinson ou blend\)/);
  assert.deepEqual(loadBotConfig({ FV_VOL_ESTIMATOR: 'blend' }).warnings, []);
});

test('deriveRoundData : les deux σ sont fournis, σ utilisée selon le réglage (défaut : clôture-à-clôture)', () => {
  const slot = 1_790_000_400; // multiple de 300
  const candles = gbmCandles(63, rng(5), (slot - 3600) * 1000); // dernière bougie : slot + 120 s
  const now = (slot + 125) * 1000;
  const d = deriveRoundData(candles, slot, now, 'test')!;
  assert.ok(d, 'données du round');
  assert.ok(d.sigmaCcPerSqrtSec! > 0 && d.sigmaParkPerSqrtSec! > 0);
  assert.equal(d.sigmaPerSqrtSec, d.sigmaCcPerSqrtSec, 'défaut : clôture-à-clôture, modèle inchangé');
  const p = deriveRoundData(candles, slot, now, 'test', undefined, undefined, 'parkinson')!;
  assert.equal(p.sigmaPerSqrtSec, p.sigmaParkPerSqrtSec);
  assert.equal(p.sigmaCcPerSqrtSec, d.sigmaCcPerSqrtSec, 'les deux σ sont toujours calculés');
  const b = deriveRoundData(candles, slot, now, 'test', undefined, undefined, 'blend')!;
  assert.ok(b.sigmaPerSqrtSec > Math.min(d.sigmaCcPerSqrtSec!, d.sigmaParkPerSqrtSec!) && b.sigmaPerSqrtSec < Math.max(d.sigmaCcPerSqrtSec!, d.sigmaParkPerSqrtSec!));
  // Sans plus haut/plus bas (ex. source dégradée) : σ Parkinson absente, clôture-à-clôture conservée
  const noHl = candles.map(({ openTimeMs, open, close }) => ({ openTimeMs, open, close }));
  const n = deriveRoundData(noHl, slot, now, 'test', undefined, undefined, 'parkinson')!;
  assert.equal(n.sigmaParkPerSqrtSec, null);
  assert.equal(n.sigmaPerSqrtSec, n.sigmaCcPerSqrtSec, 'repli sur clôture-à-clôture');
});

test('analyse : probWithSigma(sig) redonne pRaw ; avec des issues tirées du vrai σ, l\'estimateur exact bat l\'estimateur bruité', () => {
  const r = rng(21);
  const cfg = DEFAULT_FAIR_VALUE_CONFIG;
  const rounds: ResolvedRecord[][] = [];
  for (let i = 0; i < 600; i++) {
    const slot = 1_790_000_100 + i * 300;
    const tau = 150;
    const sd = SIG * Math.sqrt(twapVarianceSeconds(tau, cfg.twapWindowSec) + cfg.strikeNoiseSec);
    const strike = 100 * Math.exp(-1.2 * sd * gauss(r)); // écarts spot/strike réalistes
    const pTrue = probUp({ spot: 100, strike, sigmaPerSqrtSec: SIG, tauSec: tau }, cfg)!;
    const sc = SIG * (1 + 0.5 * (r() - 0.5) * 2); // clôture-à-clôture bruitée : ±50 %
    const rec: ResolvedRecord = {
      t: slot * 1000 + 150_000, slug: `btc-updown-5m-${slot}`, coin: 'BTC', tau, spot: 100, strike, sig: sc, sc, sp: SIG,
      pUp: null, pRaw: probUp({ spot: 100, strike, sigmaPerSqrtSec: sc, tauSec: tau }, cfg), zs: 1, tw: cfg.twapWindowSec,
      upAsk: null, downAsk: null, upAskSz: null, downAskSz: null, src: 'test', act: 'hold', upWon: r() < pTrue,
    };
    const again = probWithSigma(rec, rec.sig, cfg)!;
    assert.ok(Math.abs(again - (rec.pRaw as number)) < 1e-12, 'même σ → même probabilité que le bot');
    rounds.push([rec]);
  }
  const c = compareSigmaEstimators(rounds, cfg, { minTau: 60, maxTau: 270 });
  assert.equal(c.rounds, 600);
  assert.ok(c.brierPark! < c.brierCc!, `parkinson (σ exacte) ${c.brierPark} < cc bruitée ${c.brierCc}`);
  assert.ok(c.tPark! < -2, `différence significative attendue, t=${c.tPark}`);
  assert.ok(c.brierBlend! < c.brierCc!, 'le mélange réduit aussi l\'erreur');
  // Sans sc/sp : aucune comparaison possible, pas de faux résultat
  const empty = compareSigmaEstimators(rounds.map(l => l.map(({ sc: _a, sp: _b, ...rest }) => rest)), cfg);
  assert.equal(empty.rounds, 0);
  assert.equal(empty.tPark, null);
});
