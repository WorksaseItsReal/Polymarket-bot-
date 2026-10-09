/**
 * tests/risk-gate.test.ts — les quatre couches de perte, recalculées depuis le registre.
 * Exécution : `npx tsx --test tests/risk-gate.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerTrade } from '../src/services/paper-ledger.ts';
import { computeStats } from '../src/services/paper-ledger.ts';
import { DEFAULT_RISK_LIMITS as L } from '../src/bot/config.ts';
import { calendarPnl, evaluateRisk, nextUtcMidnight, nextUtcMonthStart } from '../src/bot/risk-gate.ts';

const NOW = Date.UTC(2026, 9, 15, 14, 30); // 15 oct. 2026 14:30 UTC
let n = 0;
function trade(pnl: number, resolvedAt: number, status: 'won' | 'lost' = pnl >= 0 ? 'won' : 'lost'): LedgerTrade {
  const stake = Math.abs(pnl) || 1;
  return {
    id: `t${++n}`, slug: `btc-updown-5m-${1_790_000_100 + n * 300}`, coin: 'BTC', side: 'UP', stake, costPerShare: 0.5, shares: stake * 2,
    modelProb: 0.7, edge: 0.1, openedAt: new Date(resolvedAt - 200_000).toISOString(), endMs: resolvedAt, status, pnl,
    resolvedAt: new Date(resolvedAt).toISOString(),
  };
}
const H = 3_600_000;

test('calendrier UTC : jour et mois courants seulement, positions ouvertes ignorées', () => {
  const trades = [
    trade(-3, NOW - 2 * H), // aujourd'hui
    trade(+2, NOW - 30 * H), // hier
    trade(-4, Date.UTC(2026, 9, 2)), // ce mois
    trade(-10, Date.UTC(2026, 8, 30)), // mois précédent
    { ...trade(-50, NOW - H), status: 'open' as const, pnl: null },
  ];
  assert.deepEqual(calendarPnl(trades, NOW), { today: -3, month: -5 });
  assert.equal(nextUtcMidnight(NOW), Date.UTC(2026, 9, 16));
  assert.equal(nextUtcMonthStart(NOW), Date.UTC(2026, 10, 1));
});

test('registre sain : autorisé, capital et plus haut cohérents', () => {
  const trades = [trade(+5, NOW - 3 * H), trade(-2, NOW - 2 * H)];
  const v = evaluateRisk(250, computeStats(trades), trades, L, NOW);
  assert.equal(v.allowed, true);
  assert.equal(v.layer, null);
  assert.equal(v.currentCapital, 253);
  assert.equal(v.peakCapital, 255);
  assert.ok(Math.abs(v.drawdown - 2 / 255) < 1e-12);
});

test('couche 1 : perte du jour ≥ 5 % → bloqué jusqu\'à minuit UTC', () => {
  const trades = [trade(-12.5, NOW - H)];
  const v = evaluateRisk(250, computeStats(trades), trades, L, NOW);
  assert.equal(v.allowed, false);
  assert.equal(v.layer, 'daily');
  assert.equal(v.until, Date.UTC(2026, 9, 16));
  assert.match(v.reason ?? '', /perte du jour 12\.50 \$ ≥ limite 12\.50 \$/);
  // la même perte hier : plus de blocage journalier
  const old = [trade(-12.5, NOW - 30 * H)];
  assert.equal(evaluateRisk(250, computeStats(old), old, L, NOW).allowed, true);
});

test('couche 2 : perte du mois ≥ 15 % → bloqué jusqu\'au 1er du mois suivant, prime sur la couche jour', () => {
  const trades = [trade(-20, Date.UTC(2026, 9, 3)), trade(-20, NOW - H)];
  const v = evaluateRisk(250, computeStats(trades), trades, L, NOW);
  assert.equal(v.layer, 'monthly');
  assert.equal(v.until, Date.UTC(2026, 10, 1));
});

test('couche 3 : baisse ≥ 25 % depuis le plus haut → bloqué sans date (décision manuelle), même avec un mois gagnant', () => {
  // plus haut +200 (capital 450), puis −120 ce mois : capital 330, baisse 26,7 %, mois −120 ≥ 15 % aussi → la baisse prime
  const trades = [trade(+200, Date.UTC(2026, 7, 10)), trade(-120, NOW - H)];
  const v = evaluateRisk(250, computeStats(trades), trades, L, NOW);
  assert.equal(v.layer, 'drawdown');
  assert.equal(v.until, null);
  assert.match(v.reason ?? '', /baisse de 26\.7 %/);
});

test('couche 4 : perte totale ≥ 40 % → arrêt définitif, prime sur tout', () => {
  const trades = [trade(-50, Date.UTC(2026, 6, 1)), trade(-51, Date.UTC(2026, 7, 1))];
  const v = evaluateRisk(250, computeStats(trades), trades, L, NOW);
  assert.equal(v.layer, 'total');
  assert.equal(v.until, null);
  assert.equal(v.currentCapital, 149);
});

test('redémarrage : tout découle du registre, aucun compteur en mémoire à conserver', () => {
  const trades = [trade(-13, NOW - H)];
  const a = evaluateRisk(250, computeStats(trades), trades, L, NOW);
  const b = evaluateRisk(250, computeStats(trades), trades, L, NOW + 60_000);
  assert.deepEqual({ ...a, until: 0 }, { ...b, until: 0 });
  assert.equal(evaluateRisk(250, computeStats(trades), trades, L, Date.UTC(2026, 9, 16, 0, 1)).allowed, true, 'le lendemain : libre');
});

test('calendrier : un trade réglé sans resolvedAt compte à sa date d\'ouverture (comme les statistiques)', () => {
  const t = trade(-5, NOW - H);
  delete t.resolvedAt;
  assert.deepEqual(calendarPnl([t], NOW), { today: -5, month: -5 });
  const v = evaluateRisk(100, computeStats([t]), [t], L, NOW);
  assert.equal(v.allowed, false, 'perte du jour 5 % = limite quotidienne, comptée');
  assert.equal(v.layer, 'daily');
});
