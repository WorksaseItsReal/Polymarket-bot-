/**
 * (2) SCALING DE LA MISE — CONTRAT DU 2026-09-27 (mise ADAPTATIVE).
 *
 * AVANT : `estProfit = ((1/prix) - 1) * sizeFactor * BET_STAKE`, `BET_STAKE` lu dans le
 * `.env` → la mise était FIGÉE (5 EUR sur chaque décision, quelle que soit la situation).
 * L'utilisateur a demandé que le bot « détecte la meilleure mise en fonction de la chose ».
 *
 * MAINTENANT : la mise vient de `computeStake` (module pur + testé,
 * `src/services/stake-sizing.ts`) et le gain reste linéaire en la mise. `sizeFactor` a été
 * retiré de la formule : le track record de la coin est déjà intégré par le shrinkage de
 * crédibilité du module — le multiplier une 2e fois compterait double.
 *
 * Le calcul vit DANS le monolithe `bot-with-dashboard.ts`, non importable sans démarrer le
 * bot : on extrait donc l'expression EXACTE du source au moment du test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromBot, pySourcesAvailable, runHarness } from './harness.ts';

// Expression réelle (entrée principale) : `const estProfit = ((1 / buyPrice) - 1) * BET_STAKE;`
const EST_PROFIT_RE = /const estProfit = \(\(1 \/ buyPrice\) - 1\) \* BET_STAKE;/;
// La mise doit venir du module de sizing, plus d'une valeur figée du .env.
const STAKE_SOURCE_RE = /const BET_STAKE = stakeRes\.stake;/;

function estProfit(buyPrice: number, BET_STAKE: number): number {
  const stmt = extractFromBot(EST_PROFIT_RE, 'estProfit (scaling de la mise)');
  const fn = new Function('buyPrice', 'BET_STAKE', `${stmt}\nreturn estProfit;`);
  return fn(buyPrice, BET_STAKE) as number;
}

test('la mise vient du module de sizing, plus de BET_STAKE figé dans le .env', () => {
  const stmt = extractFromBot(STAKE_SOURCE_RE, 'source de BET_STAKE');
  assert.match(stmt, /stakeRes\.stake/, 'BET_STAKE doit venir de computeStake');
  // NON-RÉGRESSION : l'ancienne lecture figée ne doit pas revenir. `extractFromBot`
  // LÈVE quand le motif est absent du source — c'est exactement ce qu'on veut prouver.
  assert.throws(
    () =>
      extractFromBot(
        /const BET_STAKE = Number\(process\.env\.BET_STAKE/,
        'ancienne lecture .env',
      ),
    'la mise NE DOIT PLUS être lue directement dans process.env.BET_STAKE',
  );
});

test('le gain est linéaire en la mise (5 € = 5× 1 €)', () => {
  const p = 0.6;
  const g1 = estProfit(p, 1);
  const g5 = estProfit(p, 5);
  assert.ok(Math.abs(g1 - (1 / p - 1)) < 1e-12, 'à 1€ : gain = 1/prix − 1');
  assert.ok(Math.abs(g5 / g1 - 5) < 1e-12, `gain(5€)/gain(1€) doit valoir 5, obtenu ${g5 / g1}`);
  assert.ok(Math.abs(g5 - (1 / 0.6 - 1) * 5) < 1e-9, 'gain à 5€ pour prix 0,60 ≈ 3,333');
});

test('sizeFactor ne module PLUS le gain (il est intégré par le sizing)', () => {
  const stmt = extractFromBot(EST_PROFIT_RE, 'estProfit (scaling de la mise)');
  // Si sizeFactor revenait dans la formule, la coin serait modulée DEUX fois
  // (une par le shrinkage de computeStake, une par sizeFactor).
  assert.doesNotMatch(stmt, /sizeFactor/, 'sizeFactor ne doit plus multiplier le gain');
});

test('une mise adaptative reste bornée : 0 € ne produit aucun gain, jamais un négatif', () => {
  const p = 0.6;
  assert.equal(estProfit(p, 0), 0, 'mise 0 → gain 0');
  assert.ok(estProfit(p, 0.5) > 0, 'une petite mise positive produit un gain positif');
});

test('le résolveur Python applique la même échelle de mise (cohérence)', {
  skip: pySourcesAvailable ? false : 'sources réelles absentes',
}, () => {
  const r = runHarness<Record<string, number>>('pnl-realized');
  assert.equal(r.gagne_5, 5 * r.gagne_1, 'gain 5€ = 5 × gain 1€ (paperbot-pnl.py)');
  assert.equal(r.perdu_5, 5 * r.perdu_1, 'perte 5€ = 5 × perte 1€ (paperbot-pnl.py)');
});
