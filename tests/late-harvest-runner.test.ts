/**
 * tests/late-harvest-runner.test.ts — la récolte de fin de round dans la VRAIE boucle (runner),
 * sans réseau : entrée après stabilité, exécution au carnet relu, identifiant distinct, aucun
 * message par gain, perte annoncée, garde-fous séparés, jamais revendue.
 * Exécution : `npx tsx --test tests/late-harvest-runner.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FAIR_VALUE_CONFIG, effectiveCostPerShare } from '../src/services/fair-value.ts';
import type { LedgerTrade, RoundOutcome } from '../src/services/paper-ledger.ts';
import { ledgerStatsSharedFor, loadLedger, saveLedger } from '../src/services/ledger-store.ts';
import type { RoundMarketData } from '../src/services/round-market-data.ts';
import type { DecisionRecord } from '../src/services/decision-journal.ts';
import { FairValueRunner, harvestTradeId, type Book, type RunnerDeps, type ScannedMarket } from '../src/strategy/fair-value-runner.ts';
import { DEFAULT_HARVEST_CONFIG } from '../src/strategy/late-harvest.ts';

const SLOT = 1_790_000_100;
const END = SLOT * 1000 + 300_000;
const SIGMA = 0.0006 / Math.sqrt(60);
const MARKET: ScannedMarket = {
  conditionId: '0xabc', name: 'Bitcoin Up or Down', slug: `btc-updown-5m-${SLOT}`, underlying: 'BTC',
  durationMinutes: 5, upTokenId: 'UP', downTokenId: 'DOWN',
};

function setup(over: Partial<RunnerDeps> & { up?: () => number; down?: () => number; partialMean?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'harvest-'));
  const ledgerPath = join(dir, 'fv-ledger.json');
  let now = END - 40_000;
  let outcome: RoundOutcome = { resolved: false, reason: 'pas encore' };
  const messages: string[] = [];
  const logs: string[] = [];
  const evals: DecisionRecord[] = [];
  const books: string[] = [];
  const data = (nowMs: number): RoundMarketData => ({
    spot: 100.06, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'binance+ws', candleAgeMs: 0,
    twapPartial: { mean: over.partialMean ?? 100.05, knownSec: 60 - (END - nowMs) / 1000 },
  });
  const book = (ask: number): Book => ({ asks: [{ price: ask, size: 500 }], bids: [{ price: Math.max(0.01, ask - 0.01), size: 500 }] });
  const deps: RunnerDeps = {
    cfg: DEFAULT_FAIR_VALUE_CONFIG,
    exitEdge: 0.04,
    ledgerPath,
    capital: () => 1000,
    now: () => now,
    canTrade: () => true,
    scanMarkets: async () => [MARKET],
    getBook: async id => { books.push(id); return book(id === 'UP' ? (over.up?.() ?? 0.99) : (over.down?.() ?? 0.02)); },
    getRoundData: async (_c, _s, nowMs) => data(nowMs),
    fetchOutcome: async () => outcome,
    notify: m => messages.push(m),
    log: (_l, m) => logs.push(m),
    onEvaluation: r => evals.push(r),
    harvest: { ...DEFAULT_HARVEST_CONFIG, enabled: true },
    timeZone: 'Europe/Paris',
    ...over,
  };
  return {
    deps, ledgerPath, messages, logs, evals, books,
    runner: () => new FairValueRunner(deps),
    at: (tauSec: number) => { now = END - tauSec * 1000; },
    setNow: (ms: number) => { now = ms; },
    setOutcome: (o: RoundOutcome) => { outcome = o; },
  };
}

/** Lectures à τ = 40, 37, 34, …, jusqu'à `stopTau` (une toutes les 3 s, comme le bot). */
async function walk(env: ReturnType<typeof setup>, r: FairValueRunner, taus: number[]) {
  for (const t of taus) {
    env.at(t);
    await r.tick();
  }
}

test('favori bloqué à 0,99 depuis ≥ 6 s, τ ≤ 30 s : achat papier au carnet, identifiant distinct, sans message', async () => {
  const env = setup();
  const r = env.runner();
  await walk(env, r, [40, 37, 34, 31]);
  assert.equal(loadLedger(env.ledgerPath)!.length, 0, 'stable depuis 9 s, mais τ = 31 s > 30 s : pas encore');
  await walk(env, r, [28]);
  const trades = loadLedger(env.ledgerPath)!;
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.id, harvestTradeId('0xabc'));
  assert.equal(t.id, '0xabc|late');
  assert.equal(t.strategy, 'late');
  assert.equal(t.side, 'UP');
  assert.ok(Math.abs(t.costPerShare - effectiveCostPerShare(0.99, 0.07)) < 1e-9, `coût ${t.costPerShare}`);
  assert.equal(t.stake, 10, '1 % du capital (plafond de variance)');
  assert.ok(Math.abs(t.shares - 10 / t.costPerShare) < 1e-9);
  assert.equal(t.modelProb, 0.997);
  assert.equal(env.messages.length, 0, 'aucun message Telegram à l\'ouverture');
  assert.ok(env.logs.some(l => /RÉCOLTE FIN DE ROUND BTC UP @ \$0\.990 mise \$10\.00 τ 28 s \(favori bloqué depuis 12 s\)/.test(l)), env.logs.join('\n'));
  const buy = env.evals.find(e => e.act === 'buy');
  assert.ok(buy && buy.hv === true && buy.lt === true && buy.side === 'UP' && buy.stake === 10 && (buy.hs as number) >= 6, JSON.stringify(buy));
  // Un seul pari de récolte par round
  await walk(env, r, [25, 22, 19]);
  assert.equal(loadLedger(env.ledgerPath)!.length, 1);
  // Règlement GAGNÉ : pas de message (bilan périodique) ; PnL et stats de la stratégie
  env.setOutcome({ resolved: true, upWon: true });
  env.setNow(END + 20_000);
  await r.tick();
  const done = loadLedger(env.ledgerPath)![0];
  assert.equal(done.status, 'won');
  assert.ok(Math.abs((done.pnl as number) - (done.shares - done.stake)) < 1e-9);
  assert.equal(env.messages.length, 0, 'aucun message pour un gain de récolte');
  const late = ledgerStatsSharedFor(env.ledgerPath, 'late');
  assert.equal(late.n, 1);
  assert.equal(ledgerStatsSharedFor(env.ledgerPath, 'fv').n, 0, 'statistiques séparées');
});

test('perte de récolte : annoncée sur Telegram, avec le bilan de la récolte', async () => {
  const env = setup();
  const r = env.runner();
  await walk(env, r, [40, 37, 34, 31, 28]);
  env.setOutcome({ resolved: true, upWon: false });
  env.setNow(END + 20_000);
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'lost');
  assert.equal(env.messages.length, 1);
  assert.match(env.messages[0], /❌ <b>PERDU<\/b> \(récolte fin de round\) — BTC ⬆️ HAUSSE · <b>−10,00 \$<\/b>/);
  assert.match(env.messages[0], /favori à 0,99 retourné/);
  assert.match(env.messages[0], /Bilan récolte : 1 trade · 0 ✅ \/ 1 ❌/);
});

test('premier contact avec 0,99 (pic), 0,98, modèle en désaccord, fenêtre dépassée : pas de récolte', async () => {
  // Bloqué seulement à partir de τ = 28 s : il faut attendre 6 s de stabilité (entrée à τ ≤ 22 s)
  let pinned = false;
  const env = setup({ up: () => (pinned ? 0.99 : 0.97) });
  const r = env.runner();
  await walk(env, r, [40, 37, 34, 31]);
  pinned = true;
  await walk(env, r, [28, 25]);
  assert.equal(loadLedger(env.ledgerPath)!.length, 0, 'bloqué depuis 3 s seulement');
  await walk(env, r, [22]);
  assert.equal(loadLedger(env.ledgerPath)!.length, 1, 'stable depuis 6 s');
  // 0,98 : prix libre, jamais récolté
  const e2 = setup({ up: () => 0.98 });
  await walk(e2, e2.runner(), [40, 37, 34, 31, 28, 25, 22, 19, 16, 13, 10]);
  assert.equal(loadLedger(e2.ledgerPath)!.length, 0);
  // Modèle fin de round contre le favori (TWAP acquis SOUS le prix à battre) : pas de récolte
  const e3 = setup({ partialMean: 99.9 });
  await walk(e3, e3.runner(), [40, 37, 34, 31, 28, 25]);
  assert.equal(loadLedger(e3.ledgerPath)!.length, 0);
  // Interruption de la série (le favori retombe) : la stabilité repart de zéro
  let k = 0;
  const e4 = setup({ up: () => ([0.99, 0.99, 0.99, 0.97, 0.99, 0.99][k++] ?? 0.99) });
  await walk(e4, e4.runner(), [40, 37, 34, 31, 28, 25]);
  assert.equal(loadLedger(e4.ledgerPath)!.length, 0, 'retombé à 0,97 à τ = 31 s : série relancée à 28 s');
  // Désactivée : jamais
  const e5 = setup({ harvest: { ...DEFAULT_HARVEST_CONFIG, enabled: false } });
  await walk(e5, e5.runner(), [40, 37, 34, 31, 28, 25]);
  assert.equal(loadLedger(e5.ledgerPath)!.length, 0);
});

test('exécution : carnet relu après la latence ; prix parti au-delà de 0,995 ou plus de profondeur → rien', async () => {
  let afterDelay = false;
  const sleeps: number[] = [];
  const env = setup({ fillDelayMs: 1000, sleep: async ms => { sleeps.push(ms); afterDelay = true; }, up: () => (afterDelay ? 0.995 : 0.99) });
  const r = env.runner();
  await walk(env, r, [40, 37, 34]);
  afterDelay = false;
  await walk(env, r, [28]);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(loadLedger(env.ledgerPath)!.length, 0, 'ask monté à 0,995 pendant le trajet de l\'ordre');
  assert.ok(env.logs.some(l => /profondeur insuffisante pour \$10\.00 sous 0\.995 \(carnet relu 1000 ms après la décision\)/.test(l)), env.logs.join('\n'));
  // Profondeur trop faible au plafond
  const thin = setup({ getBook: async id => ({ asks: [{ price: id === 'UP' ? 0.99 : 0.02, size: 3 }], bids: [] }) });
  await walk(thin, thin.runner(), [40, 37, 34, 31, 28]);
  assert.equal(loadLedger(thin.ledgerPath)!.length, 0, '3 parts à 0,99 < mise de 10 $');
});

test('garde-fous : la récolte a les siens ; pause de risque générale = rien ; arrêt de la juste valeur ≠ arrêt de la récolte', async () => {
  // Garde-fou propre à la récolte : bloque
  const e1 = setup({ harvestBlock: () => 'récolte fin de round : perte significative' });
  await walk(e1, e1.runner(), [40, 37, 34, 31, 28, 25]);
  assert.equal(loadLedger(e1.ledgerPath)!.length, 0);
  assert.ok(e1.logs.some(l => /récolte fin de round : favori UP bloqué[^\n]*ignorée : entrées bloquées \(récolte fin de round : perte significative\)/.test(l)), e1.logs.join('\n'));
  // Arrêt de la juste valeur (entryBlock) : n'empêche pas la récolte quand harvestBlock est fourni
  const e2 = setup({ entryBlock: () => 'perte significative de la juste valeur', harvestBlock: () => null });
  await walk(e2, e2.runner(), [40, 37, 34, 31, 28]);
  assert.equal(loadLedger(e2.ledgerPath)!.length, 1);
  // Porte de risque générale fermée : ni juste valeur ni récolte (mais la mesure continue)
  const e3 = setup({ canTrade: () => false });
  await walk(e3, e3.runner(), [40, 37, 34, 31, 28, 25]);
  assert.equal(loadLedger(e3.ledgerPath)!.length, 0);
  assert.ok(e3.evals.some(e => e.lt), 'mesure continue pendant la pause');
});

test('cohabitation : round déjà joué par la juste valeur → mesure et récolte quand même ; jamais revendue', async () => {
  const env = setup();
  const fvTrade: LedgerTrade = {
    id: '0xabc', slug: MARKET.slug, coin: 'BTC', side: 'DOWN', stake: 5, costPerShare: 0.4, shares: 12.5, modelProb: 0.7, edge: 0.3,
    openedAt: new Date(END - 200_000).toISOString(), endMs: END, status: 'open', pnl: null, tokenId: 'DOWN', otherTokenId: 'UP', slotSec: SLOT,
  };
  saveLedger(env.ledgerPath, [fvTrade]);
  const r = env.runner();
  await walk(env, r, [40, 37, 34, 31, 28]);
  const trades = loadLedger(env.ledgerPath)!;
  assert.deepEqual(trades.map(t => t.id).sort(), ['0xabc', '0xabc|late']);
  assert.ok(env.evals.some(e => e.lt && !e.hv), 'mesure de fin de round sur un round déjà joué (biais corrigé)');
  // Bid très au-dessus de la valeur : la récolte n'est jamais revendue (ni la juste valeur en fin de round)
  const late = trades.find(t => t.strategy === 'late')!;
  assert.equal(late.status, 'open');
  // Pertes de la juste valeur : n'entrent pas dans la série de pertes de la récolte (et inversement)
  const st = ledgerStatsSharedFor(env.ledgerPath, 'late');
  assert.equal(st.open, 1);
  assert.equal(ledgerStatsSharedFor(env.ledgerPath, 'fv').open, 1);
});

test('lectures des carnets : toutes les 3 s à l\'approche de la fenêtre, 8 s ailleurs (dernière minute)', async () => {
  const env = setup({ harvest: { ...DEFAULT_HARVEST_CONFIG, enabled: true } });
  const r = env.runner();
  // τ 58 → 46 : hors zone de récolte (> 30 + 6 + 3 + 1 = 40 s) → une lecture par 8 s
  for (const t of [58, 55, 52, 49, 46]) { env.at(t); await r.tick(); }
  const outside = env.books.length;
  assert.equal(outside, 4, `58 et 49 seulement (2 carnets chacun) : ${outside / 2} lectures`);
  // Zone de récolte : chaque tick de 3 s lit les carnets
  for (const t of [40, 37, 34]) { env.at(t); await r.tick(); }
  assert.equal(env.books.length - outside, 6);
});
