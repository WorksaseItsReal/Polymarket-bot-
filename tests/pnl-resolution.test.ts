/**
 * (1) RÉSOLUTION DU PnL D'UN ROUND — exerce le VRAI paperbot-pnl.py
 * (import par chemin via tests/harness_recap.py).
 *
 * Couvre :
 *  - un trade GAGNÉ  → realized = (1/prix − 1) × mise
 *  - un trade PERDU  → realized = −mise (round binaire tout-ou-rien)
 *  - un trade `realized: 0` NON résolvable → doit RESTER « en attente »
 *    (compté ni gagnant, ni perdant), et sa valeur reste 0 dans history.json
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pySourcesAvailable, runHarness } from './harness.ts';

type Realized = {
  gagne_1: number;
  perdu_1: number;
  gagne_5: number;
  perdu_5: number;
  gagne_5_no: number;
  realized_0_impossible: number;
};

type Pending = {
  trades: number;
  wins: number;
  losses: number;
  pending: number;
  pnl: number;
  realized_du_pending_apres_main: number;
  history_len: number;
};

const skip = pySourcesAvailable
  ? false
  : `sources réelles absentes (${'PAPERBOT_SCRIPTS_DIR'}) — test skippé, jamais simulé`;

test('PnL réalisé : un gain à 0,50$ vaut +1× mise, une perte vaut −1× mise', { skip }, () => {
  const r = runHarness<Realized>('pnl-realized');
  assert.equal(r.gagne_1, 1.0, 'gagner un token acheté 0,50$ rend (1/0.5−1)=+1 sur 1€');
  assert.equal(r.perdu_1, -1.0, 'un round binaire perdu perd la mise ENTIÈRE (−1)');
  assert.equal(r.perdu_5, -5.0, 'perte = −mise (5€)');
  assert.equal(r.gagne_5_no, 7.5, 'NO @0,40 gagnant sur 5€ : (1/0.4−1)×5 = +7,5');
  assert.equal(r.realized_0_impossible, -0.0, 'mise 0 → réalized 0 (toujours pas un gain)');
});

test('PnL réalisé : `realized: 0` non résolvable reste PENDING (ni gain ni perte)', { skip }, () => {
  const p = runHarness<Pending>('pnl-pending');
  assert.equal(p.pending, 1, 'le trade realized:0 non résolvable doit être en attente');
  assert.equal(p.trades, 2, 'seuls les 2 trades réellement résolus comptent');
  assert.equal(p.wins, 1, 'un seul gagnant');
  assert.equal(p.losses, 1, 'un seul perdant');
  assert.equal(p.realized_du_pending_apres_main, 0, 'realized du pending reste 0 (pas −0, pas +X)');
  assert.equal(p.history_len, 4, 'le HOLD et le pending restent dans history.json (aucune perte d’entrée)');
  // Le gagnant (+1,5) et le perdant (−1,0) → PnL net +0,5, le pending n'y touche pas.
  assert.equal(p.pnl, 0.5, 'PnL = +1,5 − 1,0 = +0,5 ; le pending ne modifie pas le total');
});
