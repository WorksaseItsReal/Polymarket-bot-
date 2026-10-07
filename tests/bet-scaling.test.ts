/**
 * (2) SCALING DE LA MISE — CONTRAT DU 2026-10-07 (stratégie juste valeur).
 *
 * La mise vient de `computeStake` (module pur, `src/services/stake-sizing.ts`) et
 * l'issue d'un trade de `binaryPayoff` (module pur, `src/services/fair-value.ts`) :
 * gain = parts − mise, perte = mise, le tout LINÉAIRE en la mise et frais inclus.
 * Le monolithe n'étant pas importable sans démarrer le bot, on vérifie par extraction
 * de source qu'il passe bien par ces deux fonctions, et on teste les fonctions elles-mêmes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromBot, pySourcesAvailable, runHarness } from './harness.ts';
import { binaryPayoff, effectiveCostPerShare } from '../src/services/fair-value.ts';

test('la mise vient du module de sizing et le gain de binaryPayoff (pas de mise figée)', () => {
  assert.match(extractFromBot(/const stake = stakeRes\.stake;/, 'source de la mise'), /stakeRes\.stake/);
  assert.match(
    extractFromBot(/binaryPayoff\(stake, entryCost\)/, 'gain via binaryPayoff'),
    /binaryPayoff/,
  );
});

test('le gain est linéaire en la mise (5 € = 5× 1 €)', () => {
  const c = effectiveCostPerShare(0.6, 0.07);
  const g1 = binaryPayoff(1, c);
  const g5 = binaryPayoff(5, c);
  assert.ok(Math.abs(g5.winProfit - 5 * g1.winProfit) < 1e-12);
  assert.ok(Math.abs(g5.loss - 5 * g1.loss) < 1e-12);
  assert.ok(Math.abs(g1.winProfit - (1 / c - 1)) < 1e-12, 'gain = 1/coût − 1 par € misé');
});

test('les frais réduisent le gain : coût réel > ask', () => {
  assert.ok(binaryPayoff(1, effectiveCostPerShare(0.6, 0.07)).winProfit < binaryPayoff(1, 0.6).winProfit);
});

test('une mise nulle ou un coût invalide ne produit ni gain ni perte, jamais un négatif', () => {
  for (const [stake, cost] of [[0, 0.6], [1, 0], [1, 1], [1, NaN], [-1, 0.6]] as const) {
    const r = binaryPayoff(stake, cost);
    assert.deepEqual(r, { shares: 0, winProfit: 0, loss: 0 }, `stake=${stake} cost=${cost}`);
  }
  assert.ok(binaryPayoff(0.5, 0.6).winProfit > 0);
});

test('le résolveur Python applique la même échelle de mise (cohérence)', {
  skip: pySourcesAvailable ? false : 'sources réelles absentes',
}, () => {
  const r = runHarness<Record<string, number>>('pnl-realized');
  assert.equal(r.gagne_5, 5 * r.gagne_1, 'gain 5€ = 5 × gain 1€ (paperbot-pnl.py)');
  assert.equal(r.perdu_5, 5 * r.perdu_1, 'perte 5€ = 5 × perte 1€ (paperbot-pnl.py)');
});
