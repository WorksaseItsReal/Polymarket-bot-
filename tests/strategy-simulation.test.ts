/**
 * tests/strategy-simulation.test.ts — contrôles positif et négatif de la décision.
 * Exécution : `npx tsx --test tests/strategy-simulation.test.ts`
 *
 * Monde simulé (graine fixe, reproductible) : le spot suit une marche aléatoire
 * gaussienne seconde par seconde ; un round 5 min résout « Up » si le prix final ≥ prix
 * d'ouverture (règle Polymarket). Le carnet affiche la juste valeur d'un spot vu avec
 * `lag` secondes de retard, + 1 tick de demi-spread, arrondie au tick de 0,01.
 *
 *  - CONTRÔLE NÉGATIF (lag = 0, carnet juste) : il n'existe AUCUN edge après frais. Le
 *    bot doit (quasiment) s'abstenir ; s'il parie, il ne doit pas « inventer » un gain.
 *  - CONTRÔLE POSITIF (lag = 10 s) : le carnet est en retard sur le spot. Le bot doit
 *    trouver des paris, gagner de l'argent de façon significative, avec un win rate
 *    ≥ FV_MIN_PROB et cohérent avec la probabilité annoncée (calibration).
 *
 * LIMITE : ceci valide la LOGIQUE de décision (frais, bornes, filtre de probabilité,
 * calibration) dans un monde où le modèle est juste. Ça ne prouve PAS qu'un edge existe
 * sur le vrai Polymarket — seul le paper trading le dira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FAIR_VALUE_CONFIG as CFG,
  decide,
  effectiveCostPerShare,
  normCdf,
} from '../src/services/fair-value.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIGMA = 0.0006 / Math.sqrt(60); // ≈ 0,06 % par minute
const ROUND = 300;

function simulate(lag: number, rounds: number, seed: number) {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const tick = (p: number) => Math.min(0.99, Math.max(0.01, Math.ceil(p * 100 - 1e-9) / 100));
  const fair = (s: number, k: number, tau: number) => normCdf(Math.log(s / k) / (SIGMA * Math.sqrt(tau)));

  const pnls: number[] = [];
  const probs: number[] = [];
  let wins = 0;
  for (let r = 0; r < rounds; r++) {
    const path = [100];
    for (let t = 1; t <= ROUND; t++) path.push(path[t - 1] * Math.exp(SIGMA * gauss()));
    const strike = path[0];
    const upWon = path[ROUND] >= strike;
    // Le bot regarde toutes les 10 s, au plus une entrée par round.
    for (let t = ROUND - CFG.maxTauSec; t <= ROUND - CFG.minTauSec; t += 10) {
      const tau = ROUND - t;
      const seen = Math.max(0, t - lag);
      const pMkt = fair(path[seen], strike, tau + (t - seen));
      const d = decide({
        spot: path[t], strike, sigmaPerSqrtSec: SIGMA, tauSec: tau,
        upAsk: tick(pMkt + 0.005), downAsk: tick(1 - pMkt + 0.005),
      });
      if (!d.side || !d.best) continue;
      const cost = effectiveCostPerShare(d.best.ask, CFG.takerFeeRate);
      const won = (d.side === 'UP') === upWon;
      pnls.push(won ? 1 / cost - 1 : -1); // 1 $ misé
      probs.push(d.best.prob);
      if (won) wins++;
      break;
    }
  }
  const n = pnls.length;
  const mean = n ? pnls.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    winRate: n ? wins / n : 0,
    avgProb: n ? probs.reduce((a, b) => a + b, 0) / n : 0,
  };
}

test('contrôle NÉGATIF : carnet juste → quasiment aucun pari, aucun gain inventé', () => {
  const r = simulate(0, 4000, 7);
  assert.ok(r.n <= 4000 * 0.02, `le bot ne devrait presque jamais parier contre un carnet juste (n=${r.n})`);
  if (r.n >= 30) assert.ok(r.t < 2, `aucun gain significatif ne doit apparaître (t=${r.t.toFixed(2)})`);
});

test('contrôle POSITIF : carnet en retard de 10 s → gain significatif, win rate élevé et calibré', () => {
  const r = simulate(10, 4000, 11);
  assert.ok(r.n >= 200, `assez d'opportunités détectées (n=${r.n})`);
  assert.ok(r.mean > 0 && r.t > 3, `gain significatif attendu (EV ${r.mean.toFixed(4)} $/$, t=${r.t.toFixed(2)})`);
  assert.ok(r.winRate >= CFG.minProb, `win rate ${r.winRate.toFixed(3)} ≥ FV_MIN_PROB ${CFG.minProb}`);
  assert.ok(Math.abs(r.winRate - r.avgProb) < 0.04,
    `calibration : win rate ${r.winRate.toFixed(3)} ≈ probabilité annoncée ${r.avgProb.toFixed(3)}`);
});

test('FV_MIN_PROB : relever le seuil relève le win rate (au prix de moins de paris)', () => {
  const base = { spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 };
  // Outsider sous-coté : DOWN p≈0,45 coté 0,30 → +EV mais p < 0,6 → refusé par défaut.
  const spot = 100 * Math.exp(0.125 * SIGMA * Math.sqrt(120 + CFG.strikeNoiseSec));
  const d = decide({ ...base, spot, upAsk: 0.62, downAsk: 0.3 });
  assert.equal(d.side, null, d.reason);
  assert.match(d.reason, /aucun côté avec p_modèle ≥ 0.6/);
  assert.equal(decide({ ...base, spot, upAsk: 0.62, downAsk: 0.3 }, { ...CFG, minProb: 0 }).side, 'DOWN');
});
