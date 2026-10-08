/**
 * tests/shadow-tracker.test.ts — mesure continue « modèle vs carnet ».
 * Exécution : `npx tsx --test tests/shadow-tracker.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowTracker, shadowStats } from '../src/strategy/shadow-tracker.ts';
import { shadowLine } from '../src/services/telegram-messages.ts';
import type { DecisionRecord } from '../src/services/decision-journal.ts';

const SLOT = 1_790_000_100;
const rec = (slug: string, pUp: number, upAsk: number, downAsk: number): DecisionRecord => ({
  t: 0, slug, coin: 'BTC', tau: 200, spot: 1, strike: 1, sig: 1e-4, pUp, upAsk, downAsk, upAskSz: 1, downAskSz: 1, src: 't', act: 'hold',
});

test('première évaluation par round, résolution après la fin, Brier apparié, persistance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
  let now = (SLOT + 100) * 1000;
  const outcomes: Record<string, boolean> = {};
  const fetched: string[] = [];
  const t = new ShadowTracker({
    path: join(dir, 'fv-shadow.json'), now: () => now,
    fetchOutcome: async slug => { fetched.push(slug); return slug in outcomes ? { resolved: true, upWon: outcomes[slug] } : { resolved: false, reason: 'pas encore' }; },
  });
  const slug = `btc-updown-5m-${SLOT}`;
  t.observe(rec(slug, 0.9, 0.61, 0.41)); // carnet : (0,61 + 0,59)/2 = 0,60
  t.observe(rec(slug, 0.1, 0.5, 0.5)); // ignorée : pas la première
  await t.resolveDue();
  assert.equal(fetched.length, 0, 'pas avant la fin du round + 60 s');
  now = (SLOT + 400) * 1000;
  await t.resolveDue();
  assert.equal(fetched.length, 1);
  assert.equal(t.stats().n, 0, 'pas encore réglé : on retentera');
  outcomes[slug] = true;
  await t.resolveDue();
  const st = t.stats();
  assert.equal(st.n, 1);
  assert.ok(Math.abs(st.brierModel! - 0.01) < 1e-12);
  assert.ok(Math.abs(st.brierMarket! - 0.16) < 1e-12);
  // redémarrage : agrégats relus
  const t2 = new ShadowTracker({ path: join(dir, 'fv-shadow.json'), fetchOutcome: async () => ({ resolved: false, reason: '' }) });
  assert.equal(t2.stats().n, 1);
  writeFileSync(join(dir, 'fv-shadow.json'), '{corrompu');
  assert.equal(new ShadowTracker({ path: join(dir, 'fv-shadow.json'), fetchOutcome: async () => ({ resolved: false, reason: '' }) }).stats().n, 0);
});

test('verdict honnête : trop tôt, meilleur, pire, indistinct', () => {
  assert.match(shadowLine(shadowStats({ n: 10, sumModel: 1, sumMarket: 2, sumD: -1, sumD2: 1 })), /trop tôt/);
  // modèle nettement meilleur : d = −0,05 ± petit bruit sur 200 rounds
  const better = { n: 200, sumModel: 40, sumMarket: 50, sumD: -10, sumD2: 200 * (0.05 ** 2 + 0.01 ** 2) };
  assert.match(shadowLine(shadowStats(better)), /prédit MIEUX/);
  const worse = { ...better, sumModel: 50, sumMarket: 40, sumD: 10 };
  assert.match(shadowLine(shadowStats(worse)), /pas d'edge/);
  const same = { n: 200, sumModel: 45, sumMarket: 45, sumD: 0.1, sumD2: 200 * 0.01 };
  assert.match(shadowLine(shadowStats(same)), /pas de différence significative/);
});

test('round jamais réglé abandonné après 1 h ; nombre de rounds en attente borné', async () => {
  let now = SLOT * 1000;
  const t = new ShadowTracker({ path: join(mkdtempSync(join(tmpdir(), 'shadow-')), 's.json'), now: () => now, maxPending: 3, fetchOutcome: async () => ({ resolved: false, reason: '' }) });
  for (let i = 0; i < 5; i++) t.observe(rec(`eth-updown-5m-${SLOT + i * 300}`, 0.5, 0.5, 0.5));
  assert.equal(t.pendingCount(), 3);
  now = (SLOT + 5 * 3600) * 1000;
  await t.resolveDue();
  assert.equal(t.pendingCount(), 0);
});

test('mélange actif : la comparaison porte sur le modèle SEUL (pRaw), pas sur la probabilité mélangée', async () => {
  const now = (SLOT + 400) * 1000;
  const t = new ShadowTracker({
    path: join(mkdtempSync(join(tmpdir(), 'shadow-')), 'fv-shadow.json'), now: () => now,
    fetchOutcome: async () => ({ resolved: true, upWon: true }),
  });
  // pUp mélangée = 0,6 (≈ carnet), modèle seul = 0,9
  t.observe({ ...rec(`btc-updown-5m-${SLOT}`, 0.6, 0.61, 0.41), pRaw: 0.9 });
  await t.resolveDue();
  assert.ok(Math.abs(t.stats().brierModel! - 0.01) < 1e-12, 'Brier de 0,9, pas de 0,6');
});
