/**
 * tests/runner-simulation.test.ts — le bot COMPLET dans un monde simulé, sur des centaines
 * de rounds × 5 cryptos : horloge, carnets, latence d'ordre, prix limite, VWAP, frais, mise,
 * règlement et reventes, registre réel sur disque.
 * Exécution : `npx tsx --test tests/runner-simulation.test.ts`
 *
 * Monde : spot en marche aléatoire seconde par seconde, cryptos d'un créneau corrélées ;
 * règlement TWAP comme le vrai Polymarket depuis août 2026 (moyenne des 60 s finales ≥
 * moyenne des 60 s précédant l'ouverture). Le carnet affiche la juste valeur EXACTE (vrai
 * prix à battre) d'un spot vu avec `lag` secondes de retard (+ 1 tick de demi-spread,
 * arrondi au tick), carnets Up/Down miroirs, profondeur limitée ; le bot, lui, estime le
 * prix à battre depuis les bougies 1 min, comme en réel.
 *   - lag = 10 s : le bot doit gagner de l'argent de façon significative ;
 *   - lag = 0 (carnet juste) : il ne doit PAS afficher de gain significatif.
 * Et dans les deux cas : invariants comptables (un pari par round, PnL = somme du
 * registre, plafonds de mise et d'exposition respectés, tout est réglé).
 *
 * LIMITE : le modèle est juste dans ce monde ; ça valide la mécanique, pas l'existence
 * d'un edge sur le vrai Polymarket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FAIR_VALUE_CONFIG as CFG, normCdf } from '../src/services/fair-value.ts';
import { strikeFromCandles, type Candle } from '../src/services/round-market-data.ts';
import { computeStats, loadLedger, readLedgerShared, type LedgerTrade } from '../src/services/paper-ledger.ts';
import { FairValueRunner, type Book, type ScannedMarket } from '../src/strategy/fair-value-runner.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] as const;
const SIGMA = 0.0006 / Math.sqrt(60);
const T0 = 1_790_000_100; // multiple de 300

function simulate(lag: number, slots: number, seed: number, modelSigmaFactor = 1) {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  // Chemins seconde par seconde, cryptos corrélées (ρ ≈ 0,64)
  const len = slots * 300 + 900;
  const paths = new Map<string, Float64Array>();
  const common = new Float64Array(len);
  for (let i = 1; i < len; i++) common[i] = gauss();
  for (const c of COINS) {
    const p = new Float64Array(len);
    p[0] = 100;
    for (let i = 1; i < len; i++) p[i] = p[i - 1] * Math.exp(SIGMA * (0.8 * common[i] + 0.6 * gauss()));
    paths.set(c, p);
  }
  const spotAt = (c: string, tSec: number) => paths.get(c)![Math.max(0, Math.min(len - 1, Math.floor(tSec - T0)))];
  const tick = (x: number) => Math.min(0.99, Math.max(0.01, Math.round(x * 100) / 100));

  let now = T0 * 1000;
  const slotOfNow = () => Math.floor(now / 1000 / 300) * 300;
  const market = (c: string, slot: number): ScannedMarket => ({
    conditionId: `0x${c}${slot}`, name: c, slug: `${c.toLowerCase()}-updown-5m-${slot}`, underlying: c,
    durationMinutes: 5, upTokenId: `${c}:${slot}:UP`, downTokenId: `${c}:${slot}:DOWN`,
  });
  // Règlement TWAP 60 s : moyenne des 60 secondes se terminant à `tEnd`.
  const twapAt = (c: string, tEnd: number) => {
    let sum = 0;
    for (let k = 0; k < 60; k++) sum += spotAt(c, tEnd - k);
    return sum / 60;
  };
  const fairUp = (c: string, slot: number, tSecRaw: number) => {
    const tSec = Math.floor(tSecRaw);
    const K = twapAt(c, slot);
    const end = slot + 300;
    const S = spotAt(c, tSec);
    const tau = end - tSec;
    if (tau >= 60) return normCdf(Math.log(S / K) / (SIGMA * Math.sqrt(tau - 40)));
    // Fenêtre finale entamée : part déjà moyennée connue, reste aléatoire.
    let realized = 0;
    for (let u = end - 59; u <= tSec; u++) realized += spotAt(c, u);
    const nF = Math.max(0, end - tSec);
    const mean = (realized + nF * S) / 60;
    const sd = (S * SIGMA * Math.sqrt((nF * nF * nF) / 3)) / 60;
    return sd > 0 ? normCdf((mean - K) / sd) : (mean >= K ? 1 : 0);
  };
  // Bougie 1 min [m, m+60) telle que la verrait le bot (plus haut / plus bas inclus).
  const candleAt = (c: string, openMs: number): Candle => {
    const m = openMs / 1000;
    let high = spotAt(c, m - 1);
    let low = high;
    for (let u = m; u <= m + 59; u++) { const x = spotAt(c, u); if (x > high) high = x; if (x < low) low = x; }
    return { openTimeMs: openMs, open: spotAt(c, m - 1), close: spotAt(c, m + 59), high, low };
  };
  const book = (tokenId: string): Book => {
    const [c, slotS, side] = tokenId.split(':');
    const slot = Number(slotS);
    const tSec = now / 1000;
    const pUp = fairUp(c, slot, tSec - lag); // carnet en retard de `lag` s
    const p = side === 'UP' ? pUp : 1 - pUp;
    const ask = tick(p + 0.01);
    const bid = tick(p - 0.01);
    return {
      asks: [{ price: ask, size: 40 }, { price: Math.min(0.99, ask + 0.01), size: 200 }],
      bids: [{ price: bid, size: 40 }, { price: Math.max(0.01, bid - 0.01), size: 200 }],
    };
  };
  const dir = mkdtempSync(join(tmpdir(), 'runner-sim-'));
  const ledgerPath = join(dir, 'fv-ledger.json');
  const runner = new FairValueRunner({
    // plus d'entrée après le dernier créneau simulé (on laisse le temps de tout régler)
    cfg: CFG, exitEdge: 0.04, ledgerPath, capital: () => 1000, now: () => now, canTrade: () => now < (T0 + slots * 300) * 1000,
    scanMarkets: async () => COINS.map(c => market(c, slotOfNow())),
    marketsRefreshMs: 60_000, minOrderUsd: 1, minSellShares: 5, fillDelayMs: 1000,
    sleep: async ms => { now += ms; },
    getBook: async id => book(id),
    // modelSigmaFactor < 1 : volatilité sous-estimée → modèle SUR-confiant
    getRoundData: async (coin, slot) => ({
      spot: spotAt(coin, now / 1000), strike: strikeFromCandles(ms => candleAt(coin, ms), slot, CFG.twapWindowSec) as number,
      sigmaPerSqrtSec: SIGMA * modelSigmaFactor, source: 'sim', candleAgeMs: 0,
    }),
    fetchOutcome: async slug => {
      const slot = Number(slug.split('-').pop());
      const c = slug.split('-')[0].toUpperCase();
      if (now / 1000 < slot + 300 + 15) return { resolved: false, reason: 'pas encore' };
      return { resolved: true, upWon: twapAt(c, slot + 300) >= twapAt(c, slot) };
    },
    notify: () => undefined, log: () => undefined, timeZone: 'UTC',
  });
  const exposures: number[] = [];
  const end = (T0 + slots * 300 + 420) * 1000;
  return (async () => {
    while (now < end) {
      await runner.tick();
      const trades = readLedgerShared(ledgerPath) ?? [];
      exposures.push(trades.filter(t => t.status === 'open').reduce((a, t) => a + t.stake, 0));
      now += 5000;
    }
    return { trades: loadLedger(ledgerPath) as LedgerTrade[], exposures };
  })();
}

function checkInvariants(trades: LedgerTrade[], exposures: number[]) {
  assert.equal(new Set(trades.map(t => t.id)).size, trades.length, 'un seul pari par round');
  assert.ok(trades.every(t => t.status !== 'open'), 'tout est réglé à la fin');
  const st = computeStats(trades);
  const sum = trades.reduce((a, t) => a + (t.pnl ?? 0), 0);
  assert.ok(Math.abs(st.pnl - sum) < 1e-9, 'PnL = somme du registre');
  // mise ≤ 1 % du capital ACTUEL (≤ 1 % de 1 000 $ + gains), exposition ≤ 10 %
  const maxEquity = 1000 + Math.max(0, st.peakPnl);
  assert.ok(trades.every(t => t.stake <= 0.01 * maxEquity + 1e-9), 'plafond de mise');
  assert.ok(Math.max(...exposures) <= 0.1 * maxEquity + 1e-9, 'plafond d\'exposition');
  assert.ok(trades.every(t => t.stake >= 1 - 1e-9), 'minimum d\'ordre Polymarket');
  for (const t of trades) {
    if (t.status === 'won') assert.ok(Math.abs(t.pnl! - (t.shares - t.stake)) < 1e-9, 'gain = parts − mise');
    if (t.status === 'lost') assert.ok(Math.abs(t.pnl! + t.stake) < 1e-9, 'perte = mise');
  }
}

test('bot complet, carnet en retard de 10 s : gain significatif, comptabilité exacte', async () => {
  const { trades, exposures } = await simulate(10, 100, 11);
  checkInvariants(trades, exposures);
  const st = computeStats(trades);
  if (process.env.SIM_PRINT) console.log(`retard 10 s : ${trades.length} paris, réussite ${(st.winRate! * 100).toFixed(1)} %, PnL ${st.pnl.toFixed(2)} $, t ${st.tStat?.toFixed(2)}`);
  assert.ok(trades.length >= 100, `assez de paris : ${trades.length}`);
  assert.ok(st.pnl > 0 && st.tStat! >= 2, `gain significatif attendu : PnL ${st.pnl.toFixed(2)} $, t ${st.tStat?.toFixed(2)} (${trades.length} paris)`);
});

test('bot complet, carnet JUSTE et modèle SUR-confiant : le papier montre la perte (aucun gain inventé)', async () => {
  // Le modèle sous-estime la volatilité de 40 % : il « voit » des edges partout contre un
  // carnet pourtant juste. La simulation (latence, prix limite, VWAP, frais) doit faire
  // apparaître la perte, pas un gain.
  const { trades, exposures } = await simulate(0, 160, 12, 0.6);
  checkInvariants(trades, exposures);
  const st = computeStats(trades);
  if (process.env.SIM_PRINT) console.log(`carnet juste, modèle sur-confiant : ${trades.length} paris, réussite ${(st.winRate! * 100).toFixed(1)} %, PnL ${st.pnl.toFixed(2)} $, t ${st.tStat?.toFixed(2)}`);
  assert.ok(trades.length >= 50, `le modèle sur-confiant parie : ${trades.length}`);
  assert.ok(st.pnl < 0, `perte attendue : PnL ${st.pnl.toFixed(2)} $, t ${st.tStat?.toFixed(2)}`);
  assert.ok(!(st.tStat !== null && st.tStat >= 2), 'jamais de gain significatif sans edge');
});

test('bot complet, carnet JUSTE et modèle juste : (quasiment) aucun pari', async () => {
  const { trades, exposures } = await simulate(0, 60, 13);
  checkInvariants(trades, exposures);
  assert.ok(trades.length <= 3, `${trades.length} paris sans edge`);
});
