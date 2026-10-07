/**
 * tests/paper-ledger.test.ts — registre des trades et résolution des rounds.
 * Exécution : `npx tsx --test tests/paper-ledger.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeStats,
  fetchRoundOutcome,
  loadLedger,
  parseGammaEvent,
  saveLedger,
  settlePnl,
  type LedgerTrade,
} from '../src/services/paper-ledger.ts';

const SLUG = 'btc-updown-5m-1790000100';

function trade(over: Partial<LedgerTrade>): LedgerTrade {
  return {
    id: 'c' + Math.random(), slug: SLUG, coin: 'BTC', side: 'UP', stake: 1, costPerShare: 0.625, shares: 1.6,
    modelProb: 0.7, edge: 0.075, openedAt: '2026-10-07T10:00:00Z', endMs: 0, status: 'open', pnl: null, ...over,
  };
}

test('parseGammaEvent : seul un marché CLÔTURÉ avec un prix final 1/0 est un résultat', () => {
  const ev = (closed: boolean, prices: string, outcomes = '["Up","Down"]', slug = SLUG) =>
    [{ slug, markets: [{ closed, outcomes, outcomePrices: prices }] }];
  assert.deepEqual(parseGammaEvent(ev(true, '["1","0"]'), SLUG), { resolved: true, upWon: true });
  assert.deepEqual(parseGammaEvent(ev(true, '["0","1"]'), SLUG), { resolved: true, upWon: false });
  // ordre des outcomes inversé : on suit le libellé, pas l'index
  assert.deepEqual(parseGammaEvent(ev(true, '["1","0"]', '["Down","Up"]'), SLUG), { resolved: true, upWon: false });
  // marché ouvert avec prix provisoires (le piège du 50/50 « seedé »)
  assert.equal(parseGammaEvent(ev(false, '["0.5","0.5"]'), SLUG).resolved, false);
  assert.equal(parseGammaEvent(ev(false, '["1","0"]'), SLUG).resolved, false);
  // clôturé mais prix non définitifs
  assert.equal(parseGammaEvent(ev(true, '["0.6","0.4"]'), SLUG).resolved, false);
  // réponse non filtrée (autre marché) : rejetée
  assert.equal(parseGammaEvent(ev(true, '["1","0"]', '["Yes","No"]', 'xi-jinping-out-before-2027'), SLUG).resolved, false);
  // déchets
  for (const junk of [null, {}, [], [{ slug: SLUG }], [{ slug: SLUG, markets: [{ closed: true, outcomePrices: 'pas du json' }] }]]) {
    assert.equal(parseGammaEvent(junk, SLUG).resolved, false);
  }
});

test('fetchRoundOutcome : erreur HTTP ou réseau → non résolu, jamais une exception', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('err', { status: 500 })) as typeof fetch;
    assert.deepEqual(await fetchRoundOutcome(SLUG), { resolved: false, reason: 'HTTP 500' });
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as typeof fetch;
    assert.equal((await fetchRoundOutcome(SLUG)).resolved, false);
    globalThis.fetch = (async (u: string | URL | Request) => {
      assert.ok(String(u).includes(`events?slug=${SLUG}`), 'chemin vérifié events?slug=');
      return new Response(JSON.stringify([{ slug: SLUG, markets: [{ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0","1"]' }] }]));
    }) as typeof fetch;
    assert.deepEqual(await fetchRoundOutcome(SLUG), { resolved: true, upWon: false });
  } finally {
    globalThis.fetch = original;
  }
});

test('settlePnl : gagné = parts − mise, perdu = − mise', () => {
  assert.ok(Math.abs(settlePnl({ shares: 1.6, stake: 1 }, true) - 0.6) < 1e-12);
  assert.equal(settlePnl({ shares: 1.6, stake: 1 }, false), -1);
});

test('computeStats : ouverts exclus, série de pertes, drawdown, t-stat', () => {
  const t = (pnl: number, i: number, status: LedgerTrade['status'] = pnl > 0 ? 'won' : 'lost') =>
    trade({ status, pnl, resolvedAt: `2026-10-07T10:${String(i).padStart(2, '0')}:00Z`, modelProb: 0.7 });
  const trades = [t(0.6, 1), t(0.6, 2), t(-1, 3), t(0.6, 4), t(-1, 5), t(-1, 6), trade({ stake: 0.5 })];
  const st = computeStats(trades);
  assert.equal(st.n, 6);
  assert.equal(st.wins, 3);
  assert.equal(st.losses, 3);
  assert.equal(st.open, 1);
  assert.equal(st.openExposure, 0.5);
  assert.equal(st.lossStreak, 2);
  assert.ok(Math.abs(st.pnl - (-1.2)) < 1e-9);
  assert.ok(Math.abs(st.winRate! - 0.5) < 1e-12);
  assert.ok(Math.abs(st.avgModelProb! - 0.7) < 1e-12);
  // cumul : .6 1.2 .2 .8 -.2 -1.2 → pic 1.2, creux final -1.2
  assert.ok(Math.abs(st.peakPnl - 1.2) < 1e-9);
  assert.ok(Math.abs(st.maxDrawdown - 2.4) < 1e-9);
  assert.ok(Math.abs(st.drawdownNow - 2.4) < 1e-9);
  assert.ok(st.tStat !== null && st.tStat < 0);
  const empty = computeStats([]);
  assert.equal(empty.winRate, null);
  assert.equal(empty.tStat, null);
  assert.equal(empty.pnl, 0);
});

test('registre : aller-retour fichier, fichier illisible jamais écrasé', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const path = join(dir, 'sub', 'fv-ledger.json');
  assert.deepEqual(loadLedger(path), [], 'absent → vide');
  const trades = [trade({ id: 'a' }), trade({ id: 'b', status: 'won', pnl: 0.6 })];
  saveLedger(path, trades);
  assert.deepEqual(loadLedger(path), trades);
  assert.equal(existsSync(`${path}.tmp-${process.pid}`), false, 'pas de fichier temporaire résiduel');
  writeFileSync(path, '{"version":1,"trades":[{"id":"a"');
  assert.equal(loadLedger(path), null, 'tronqué → null (l\'appelant ne doit rien écrire)');
  assert.equal(readFileSync(path, 'utf-8'), '{"version":1,"trades":[{"id":"a"', 'contenu préservé');
});
