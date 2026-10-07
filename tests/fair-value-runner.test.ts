/**
 * tests/fair-value-runner.test.ts — la boucle de stratégie de bout en bout, sans réseau.
 * Exécution : `npx tsx --test tests/fair-value-runner.test.ts`
 *
 * Faux scan Polymarket, faux carnets, fausses données spot, fausse résolution Gamma,
 * horloge pilotée ; registre réel dans un dossier temporaire ; on capture les
 * messages Telegram produits. On vérifie le cycle complet :
 *   marché → pari (registre + message) → pas de second pari sur le même round →
 *   fin du round → résolution → message GAGNÉ/PERDU → bilan à jour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FAIR_VALUE_CONFIG, probUp } from '../src/services/fair-value.ts';
import { loadLedger, type RoundOutcome } from '../src/services/paper-ledger.ts';
import type { RoundMarketData } from '../src/services/round-market-data.ts';
import { FairValueRunner, slotOf, type Book, type RunnerDeps, type ScannedMarket } from '../src/strategy/fair-value-runner.ts';

const SLOT = 1_790_000_100;
const SIGMA = 0.0006 / Math.sqrt(60);
const MARKET: ScannedMarket = {
  conditionId: '0xabc', name: 'Bitcoin Up or Down', slug: `btc-updown-5m-${SLOT}`, underlying: 'BTC',
  durationMinutes: 5, upTokenId: 'UP', downTokenId: 'DOWN',
};

function setup(over: Partial<RunnerDeps> & { spot?: number; upAsk?: number; downAsk?: number; outcome?: RoundOutcome } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  const ledgerPath = join(dir, 'fv-ledger.json');
  let now = (SLOT + 180) * 1000; // τ = 120 s
  const messages: string[] = [];
  const logs: string[] = [];
  let outcome: RoundOutcome = over.outcome ?? { resolved: false, reason: 'pas encore' };
  const data = (): RoundMarketData => ({ spot: over.spot ?? 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 1000 });
  const book = (ask: number): Book => ({
    asks: [{ price: 0.99, size: 1000 }, { price: ask + 0.01, size: 50 }, { price: ask, size: 5 }], // ordre API : du plus cher au moins cher
    bids: [{ price: ask - 0.01, size: 100 }],
  });
  let scans = 0;
  const deps: RunnerDeps = {
    cfg: DEFAULT_FAIR_VALUE_CONFIG,
    exitEdge: 0.04,
    ledgerPath,
    capital: () => 50,
    now: () => now,
    canTrade: () => true,
    scanMarkets: async () => { scans++; return [MARKET]; },
    getBook: async id => book(id === 'UP' ? (over.upAsk ?? 0.6) : (over.downAsk ?? 0.41)),
    getRoundData: async () => data(),
    fetchOutcome: async () => outcome,
    notify: m => messages.push(m),
    log: (_l, m) => logs.push(m),
    timeZone: 'Europe/Paris',
    ...over,
  };
  return {
    deps, ledgerPath, messages, logs,
    runner: () => new FairValueRunner(deps),
    setNow: (ms: number) => { now = ms; },
    setOutcome: (o: RoundOutcome) => { outcome = o; },
    scans: () => scans,
  };
}

test('slotOf : slug exact du bon coin uniquement', () => {
  assert.equal(slotOf(MARKET), SLOT);
  assert.equal(slotOf({ ...MARKET, underlying: 'ETH' }), null, 'slug BTC annoncé comme ETH');
  assert.equal(slotOf({ ...MARKET, slug: 'xi-jinping-out-before-2027' }), null);
  assert.equal(slotOf({ ...MARKET, slug: `btc-updown-15m-${SLOT}` }), null);
});

test('cycle complet : pari → un seul par round → résolution GAGNÉ → messages clairs', async () => {
  const env = setup();
  const r = env.runner();
  await r.tick();

  let ledger = loadLedger(env.ledgerPath)!;
  assert.equal(ledger.length, 1, 'un pari ouvert');
  const t = ledger[0];
  assert.equal(t.side, 'UP');
  assert.equal(t.status, 'open');
  assert.ok(t.stake > 0 && t.stake <= 50 * 0.01 + 1e-9, `mise plafonnée à 1 % du capital (${t.stake})`);
  assert.ok(t.costPerShare > 0.6, 'coût = VWAP + frais, jamais l\'ask brut');
  assert.ok(Math.abs(t.modelProb - probUp({ spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!) < 1e-12);
  assert.equal(env.messages.length, 1);
  assert.match(env.messages[0], /NOUVEAU PARI — BTC ⬆️ HAUSSE/);

  // Ticks suivants dans le même round : aucun second pari, aucun nouveau message.
  env.setNow((SLOT + 200) * 1000);
  await r.tick();
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 1);
  assert.equal(env.messages.length, 1);

  // Fin du round, pas encore réglé par Polymarket : rien ne bouge.
  env.setNow((SLOT + 330) * 1000);
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'open');

  // Réglé : UP a gagné.
  env.setOutcome({ resolved: true, upWon: true });
  await r.tick();
  ledger = loadLedger(env.ledgerPath)!;
  assert.equal(ledger[0].status, 'won');
  assert.ok(Math.abs(ledger[0].pnl! - (t.shares - t.stake)) < 1e-12);
  assert.equal(env.messages.length, 2);
  assert.match(env.messages[1], /✅ <b>GAGNÉ<\/b> — BTC ⬆️ HAUSSE/);
  assert.match(env.messages[1], /Bilan : 1 trades · 1 ✅ \/ 0 ❌ \(100 %\)/);

  // Un redémarrage ne rejoue pas le round (registre relu).
  env.setNow((SLOT + 180) * 1000);
  const r2 = env.runner();
  await r2.tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 1);
});

test('PERDU : la mise entière est perdue et annoncée', async () => {
  const env = setup();
  const r = env.runner();
  await r.tick();
  env.setNow((SLOT + 330) * 1000);
  env.setOutcome({ resolved: true, upWon: false });
  await r.tick();
  const t = loadLedger(env.ledgerPath)![0];
  assert.equal(t.status, 'lost');
  assert.equal(t.pnl, -t.stake);
  assert.match(env.messages[1], /❌ <b>PERDU<\/b>/);
});

test('carnet juste (pas d\'edge) : aucun pari, aucun message', async () => {
  const p = probUp({ spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!;
  const env = setup({ upAsk: Math.ceil(p * 100) / 100, downAsk: Math.ceil((1 - p) * 100) / 100 + 0.01 });
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 0);
  assert.equal(env.messages.length, 0);
  assert.ok(env.logs.some(l => /HOLD/.test(l)), 'la raison du HOLD est journalisée');
});

test('porte de risque fermée : aucun nouveau pari, MAIS les rounds terminés sont réglés', async () => {
  let open = true;
  const env = setup({ canTrade: () => open });
  const r = env.runner();
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 1);
  open = false;
  env.setNow((SLOT + 330) * 1000);
  env.setOutcome({ resolved: true, upWon: true });
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath)![0].status, 'won', 'résolution même en pause');
});

test('hors fenêtre de temps, données absentes ou erreurs réseau : pas de pari, pas de crash', async () => {
  const early = setup();
  early.setNow((SLOT + 10) * 1000); // τ = 290 s > 270
  await early.runner().tick();
  assert.equal(loadLedger(early.ledgerPath)!.length, 0);

  const late = setup();
  late.setNow((SLOT + 280) * 1000); // τ = 20 s < 45
  await late.runner().tick();
  assert.equal(loadLedger(late.ledgerPath)!.length, 0);

  const noData = setup({ getRoundData: async () => null });
  await noData.runner().tick();
  assert.equal(loadLedger(noData.ledgerPath)!.length, 0);

  const broken = setup({ getBook: async () => { throw new Error('CLOB 503'); } });
  await broken.runner().tick();
  assert.equal(loadLedger(broken.ledgerPath)!.length, 0);
  assert.ok(broken.logs.some(l => /erreur d'analyse/.test(l)));

  const scanFail = setup({ scanMarkets: async () => { throw new Error('gamma down'); } });
  await scanFail.runner().tick();
  assert.ok(scanFail.logs.some(l => /tick en échec/.test(l)));
});

test('profondeur insuffisante : pas de pari sur un carnet vide au bon prix', async () => {
  const env = setup({ getBook: async id => (id === 'UP' ? { asks: [{ price: 0.6, size: 0.1 }], bids: [] } : { asks: [{ price: 0.41, size: 100 }], bids: [] }) });
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 0);
  assert.ok(env.logs.some(l => /profondeur insuffisante/.test(l)));
});

test('registre illisible : aucun pari, une seule alerte, fichier préservé', async () => {
  const env = setup();
  writeFileSync(env.ledgerPath, '{"trades":[');
  const r = env.runner();
  await r.tick();
  await r.tick();
  assert.equal(loadLedger(env.ledgerPath), null, 'fichier non écrasé');
  assert.equal(env.messages.filter(m => /registre des trades illisible/.test(m)).length, 1);
});

test('revente anticipée quand le marché paie plus que la position ne vaut', async () => {
  const env = setup();
  const r = env.runner();
  await r.tick();
  const t = loadLedger(env.ledgerPath)![0];
  // Le spot retombe au strike (p_UP ≈ 0,5) mais un acheteur paie 0,80 pour UP.
  env.deps.getRoundData = async () => ({ spot: 100, strike: 100, sigmaPerSqrtSec: SIGMA, source: 'test', candleAgeMs: 0 });
  env.deps.getBook = async () => ({ asks: [], bids: [{ price: 0.8, size: 1000 }] });
  env.setNow((SLOT + 200) * 1000);
  await r.tick();
  const after = loadLedger(env.ledgerPath)![0];
  assert.equal(after.status, 'sold');
  assert.ok(after.pnl! > 0 && Math.abs(after.pnl! - (t.shares * (0.8 - DEFAULT_FAIR_VALUE_CONFIG.takerFeeRate * 0.8 * 0.2) - t.stake)) < 1e-9);
  assert.match(env.messages[env.messages.length - 1], /REVENDU avant la fin/);
});

test('le scan des marchés est mis en cache 60 s (pas de spam de l\'API)', async () => {
  const env = setup({ getRoundData: async () => null });
  const r = env.runner();
  for (let i = 0; i < 5; i++) {
    env.setNow((SLOT + 180 + i * 10) * 1000);
    await r.tick();
  }
  assert.equal(env.scans(), 1);
  env.setNow((SLOT + 300) * 1000);
  await r.tick();
  assert.equal(env.scans(), 2);
});

test('journal : chaque évaluation est transmise (abstention puis pari), avec asks et tailles', async () => {
  const evals: Array<Record<string, unknown>> = [];
  const p = probUp({ spot: 100.12, strike: 100, sigmaPerSqrtSec: SIGMA, tauSec: 120 })!;
  let fair = true;
  const env = setup({
    onEvaluation: r => evals.push({ ...r }),
    getBook: async id => {
      const ask = id === 'UP' ? (fair ? Math.ceil(p * 100) / 100 : 0.6) : 0.41;
      return { asks: [{ price: ask, size: 50 }], bids: [] };
    },
  });
  const r = env.runner();
  await r.tick();
  assert.equal(evals.length, 1);
  assert.equal(evals[0].act, 'hold');
  assert.equal(evals[0].slug, MARKET.slug);
  assert.equal(evals[0].upAskSz, 50);
  assert.ok(Math.abs((evals[0].pUp as number) - p) < 1e-12);
  fair = false;
  env.setNow((SLOT + 190) * 1000);
  await r.tick();
  assert.equal(evals.length, 2);
  assert.equal(evals[1].act, 'buy');
  assert.equal(evals[1].side, 'UP');
  assert.ok((evals[1].stake as number) > 0);
  // un journal qui plante ne casse pas la stratégie
  const env2 = setup({ onEvaluation: () => { throw new Error('disque plein'); } });
  await env2.runner().tick();
  assert.equal(loadLedger(env2.ledgerPath)!.length, 1);
});

test('entrées bloquées (arrêt de sécurité) : aucun pari, mais l\'évaluation est journalisée', async () => {
  const evals: string[] = [];
  const env = setup({ entryBlock: () => 'perte significative', onEvaluation: r => evals.push(r.act) });
  await env.runner().tick();
  assert.equal(loadLedger(env.ledgerPath)!.length, 0);
  assert.deepEqual(evals, ['hold']);
  assert.ok(env.logs.some(l => /entrées bloquées \(perte significative\)/.test(l)));
});
