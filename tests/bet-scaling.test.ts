/**
 * (2) SCALING DE LA MISE — gain attendu = (1/prix − 1) × sizeFactor × BET_STAKE.
 *
 * Le calcul vit DANS le monolithe bot-with-dashboard.ts (setupLLMAnalysis), non
 * importable sans exécuter le bot. On extrait donc l'expression EXACTE du source
 * au moment du test et on l'évalue : un gain à 5 € de mise vaut exactement 5× le
 * gain à 1 € (à prix et sizeFactor identiques).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromBot, pySourcesAvailable, runHarness } from './harness.ts';

// Expression réelle : `const estProfit = ((1 / buyPrice) - 1) * sizeFactor * BET_STAKE;`
const EST_PROFIT_RE = /const estProfit = \(\(1 \/ buyPrice\) - 1\) \* sizeFactor \* BET_STAKE;/;

function estProfit(buyPrice: number, sizeFactor: number, BET_STAKE: number): number {
  const stmt = extractFromBot(EST_PROFIT_RE, 'estProfit (scaling de la mise)');
  const fn = new Function('buyPrice', 'sizeFactor', 'BET_STAKE', `${stmt}\nreturn estProfit;`);
  return fn(buyPrice, sizeFactor, BET_STAKE) as number;
}

test('la formule source multiplie bien par sizeFactor ET par BET_STAKE', () => {
  const stmt = extractFromBot(EST_PROFIT_RE, 'estProfit (scaling de la mise)');
  // NON-RÉGRESSION : le bug historique était que sizeFactor n'était PAS crédité
  // au PnL (purement cosmétique). On le prouve par la présence des facteurs.
  assert.match(stmt, /sizeFactor/, 'sizeFactor doit multiplier le gain');
  assert.match(stmt, /BET_STAKE/, 'BET_STAKE (mise) doit multiplier le gain');
});

test('un gain à 5 € de mise vaut exactement 5× un gain à 1 €', () => {
  const p = 0.6;
  const g1 = estProfit(p, 1, 1);
  const g5 = estProfit(p, 1, 5);
  assert.ok(Math.abs(g1 - (1 / p - 1)) < 1e-12, 'à 1€ : gain = 1/prix − 1');
  assert.ok(Math.abs(g5 / g1 - 5) < 1e-12, `gain(5€)/gain(1€) doit valoir 5, obtenu ${g5 / g1}`);
  // valeur absolue vérifiée pour un prix réaliste du sweet-spot (0,60)
  assert.ok(Math.abs(g5 - (1 / 0.6 - 1) * 5) < 1e-9, 'gain à 5€ pour prix 0,60 ≈ 3,333');
});

test('sizeFactor pondère le gain proportionnellement', () => {
  const p = 0.6;
  const base = estProfit(p, 1, 2);
  const boosted = estProfit(p, 1.2, 2);
  const reduced = estProfit(p, 0.8, 2);
  assert.ok(Math.abs(boosted - base * 1.2) < 1e-12, 'sizeFactor 1,2 → gain ×1,2');
  assert.ok(Math.abs(reduced - base * 0.8) < 1e-12, 'sizeFactor 0,8 → gain ×0,8');
});

test('le résolveur Python applique la même échelle de mise (cohérence)', {
  skip: pySourcesAvailable ? false : 'sources réelles absentes',
}, () => {
  const r = runHarness<Record<string, number>>('pnl-realized');
  assert.equal(r.gagne_5, 5 * r.gagne_1, 'gain 5€ = 5 × gain 1€ (paperbot-pnl.py)');
  assert.equal(r.perdu_5, 5 * r.perdu_1, 'perte 5€ = 5 × perte 1€ (paperbot-pnl.py)');
});
