/**
 * tests/performance-guard.test.ts — arrêt sur perte significative, alerte de calibration.
 * Exécution : `npx tsx --test tests/performance-guard.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentGuard, evaluateGuard } from '../src/strategy/performance-guard.ts';
import { computeStats, type LedgerTrade } from '../src/services/paper-ledger.ts';

function stats(pnls: number[], modelProb = 0.7) {
  return computeStats(pnls.map((pnl, i): LedgerTrade => ({
    id: String(i), slug: `btc-updown-5m-${1_790_000_100 + 300 * i}`, coin: 'BTC', side: 'UP', stake: 1, costPerShare: 0.6, shares: 1.66, modelProb, edge: 0.1,
    openedAt: '2026-10-07T00:00:00Z', endMs: 0, status: pnl > 0 ? 'won' : 'lost', pnl, resolvedAt: new Date(1e12 + i * 1000).toISOString(),
  })));
}

test('STOP seulement si la perte est significative ET l\'échantillon suffisant', () => {
  const losing = [...Array(60)].map((_, i) => (i % 3 === 0 ? 0.6 : -1)); // WR 33 % à 0,6 → très perdant
  assert.match(evaluateGuard(stats(losing)).stop ?? '', /perte statistiquement significative/);
  assert.equal(evaluateGuard(stats(losing.slice(0, 40))).stop, null, 'n < 50 : pas de conclusion');
  const breakEven = [...Array(60)].map((_, i) => (i % 5 < 3 ? 0.66 : -1)); // WR 60 % ≈ seuil
  assert.equal(evaluateGuard(stats(breakEven)).stop, null, 'perte non significative : on continue');
});

test('ALERTE de sur-confiance : réussite réelle très inférieure à la probabilité annoncée', () => {
  const v = evaluateGuard(stats([...Array(40)].map((_, i) => (i % 2 ? 0.6 : -1)), 0.75)); // 50 % pour 75 % annoncés
  assert.match(v.warn ?? '', /sur-confiant/);
  assert.equal(evaluateGuard(stats([...Array(40)].map((_, i) => (i % 4 ? 0.4 : -1)), 0.75)).warn, null, '75 % réels pour 75 % annoncés');
});

test('STOP persistant : survit au redémarrage, levé en supprimant le fichier, fichier illisible = prudence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const g = new PersistentGuard(join(dir, 'fv-guard.json'));
  assert.equal(g.current(), null);
  g.trip('perte significative', Date.parse('2026-10-07T12:00:00Z'));
  assert.match(new PersistentGuard(join(dir, 'fv-guard.json')).current() ?? '', /perte significative \(depuis 2026-10-07T12:00:00.000Z\)/);
  writeFileSync(join(dir, 'fv-guard.json'), '{oups');
  assert.match(g.current() ?? '', /illisible/);
});
