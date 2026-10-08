/**
 * tests/historical-backtest.test.ts — backtest historique (calcul pur + récupération).
 * Exécution : `npx tsx --test tests/historical-backtest.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareBrier, evaluateRound, marketProbAt, parsePriceHistory, toResolvedRecords, LIVE_VARIANT, type BacktestPoint,
} from '../src/analysis/historical-backtest.ts';
import { fetchKlinesRange, fetchPriceHistory, fetchRoundsMeta, mapLimit } from '../src/analysis/historical-data.ts';
import { DEFAULT_FAIR_VALUE_CONFIG as CFG, normCdf, probUp } from '../src/services/fair-value.ts';

const SLOT = 1_790_000_100; // multiple de 300 et de 60

test('parsePriceHistory : formats tolérés, valeurs aberrantes ignorées, millisecondes converties', () => {
  assert.deepEqual(parsePriceHistory({ history: [{ t: 20, p: '0.6' }, { t: 10, p: 0.5 }] }), [{ t: 10, p: 0.5 }, { t: 20, p: 0.6 }]);
  assert.deepEqual(parsePriceHistory([{ t: 1_790_000_100_000, p: 0.4 }]), [{ t: 1_790_000_100, p: 0.4 }]);
  assert.deepEqual(parsePriceHistory({ history: [{ t: 1, p: 1.5 }, { t: 'x', p: 0.5 }, null] }), []);
  assert.deepEqual(parsePriceHistory('html'), []);
});

test('marketProbAt : dernier prix connu, refusé s\'il est trop vieux', () => {
  const h = [{ t: 100, p: 0.4 }, { t: 160, p: 0.55 }];
  assert.equal(marketProbAt(h, 159), 0.4);
  assert.equal(marketProbAt(h, 160), 0.55);
  assert.equal(marketProbAt(h, 300), null, '140 s sans prix : pas de mesure');
  assert.equal(marketProbAt(h, 50), null);
});

function candlesAround(slot: number, priceAt: (m: number) => number) {
  // bougies de slot−65 min à slot+5 min ; open = clôture précédente
  const out = [];
  for (let m = -65; m < 5; m++) {
    const open = priceAt(m - 1);
    out.push({ openTimeMs: (slot + m * 60) * 1000, open, close: priceAt(m) });
  }
  return out;
}

test('evaluateRound : strike = ouverture du slot, spot = clôture à l\'instant évalué, τ corrects', () => {
  const price = (m: number) => 100 * Math.exp((m % 2 ? 1 : -1) * 0.0005 + (m >= 0 ? 0.0002 * (m + 1) : 0));
  const candles = candlesAround(SLOT, price);
  const hist = [0, 60, 120, 180, 240].map(k => ({ t: SLOT + k, p: 0.5 }));
  const pts = evaluateRound({ slug: 's', coin: 'BTC', slotSec: SLOT, upWon: true }, candles, hist, CFG);
  assert.deepEqual(pts.map(p => p.tau), [240, 180, 120, 60]);
  const at120 = pts.find(p => p.tau === 120)!;
  assert.equal(at120.strike, price(-1), 'open de la bougie du slot');
  assert.equal(at120.spot, price(2), 'clôture de la bougie [slot+120, slot+180)');
  assert.equal(at120.pMarket, 0.5);
  const expected = probUp({ spot: at120.spot, strike: at120.strike, sigmaPerSqrtSec: at120.sig, tauSec: 120 }, CFG)!;
  assert.ok(Math.abs((at120.pModel[LIVE_VARIANT] as number) - expected) < 1e-12);
  assert.deepEqual(evaluateRound({ slug: 's', coin: 'BTC', slotSec: SLOT + 3600, upWon: true }, candles, hist, CFG), [], 'pas de bougie du strike');
});

test('compareBrier : différence appariée PAR ROUND ; asks reconstitués', () => {
  const pt = (slug: string, pm: number, pk: number, up: boolean): BacktestPoint => ({
    slug, coin: 'BTC', slotSec: SLOT, tau: 120, spot: 1, strike: 1, sig: 1e-4, pMarket: pk, pModel: { [LIVE_VARIANT]: pm }, upWon: up,
  });
  const pts = [pt('a', 0.9, 0.6, true), pt('a', 0.8, 0.6, true), pt('b', 0.2, 0.4, false), pt('c', 0.7, 0.6, true)];
  const c = compareBrier(pts);
  assert.equal(c.rounds, 3);
  assert.equal(c.points, 4);
  assert.ok(c.brierModel! < c.brierMarket!);
  assert.ok(c.tDiff! < 0);
  const r = toResolvedRecords([pt('a', 0.9, 0.61, true)])[0];
  assert.equal(r.upAsk, 0.62);
  assert.equal(r.downAsk, 0.4);
});

test('récupération : Gamma par lots (tokens + issue), prix, bougies par tranches avec repli', async () => {
  const urls: string[] = [];
  const up = '1'.repeat(70);
  const down = '2'.repeat(70);
  const fetchImpl = (async (u: string | URL | Request) => {
    const url = String(u);
    urls.push(url);
    if (url.includes('gamma-api')) {
      const slugs = [...url.matchAll(/slug=([^&]+)/g)].map(m => decodeURIComponent(m[1]));
      return new Response(JSON.stringify(slugs.map((slug, i) => ({
        slug, markets: [{ conditionId: '0x' + 'ab'.repeat(32), closed: i !== 1, outcomes: '["Up","Down"]', clobTokenIds: JSON.stringify([up, down]), outcomePrices: i === 1 ? '["0.5","0.5"]' : '["0","1"]' }],
      }))));
    }
    if (url.includes('prices-history')) return new Response(JSON.stringify({ history: [{ t: SLOT, p: 0.42 }] }));
    if (url.startsWith('https://api.binance.com')) return new Response('blocked', { status: 451 });
    const start = Number(/startTime=(\d+)/.exec(url)![1]);
    const end = Number(/endTime=(\d+)/.exec(url)![1]);
    const rows = [];
    for (let t = start; t <= end; t += 60_000) rows.push([t, '1', '1', '1', '1', '1', t + 59_999]);
    return new Response(JSON.stringify(rows));
  }) as typeof fetch;

  const meta = await fetchRoundsMeta([0, 1, 2].map(i => ({ slug: `btc-updown-5m-${SLOT + i * 300}`, coin: 'BTC' as const })), { fetchImpl });
  assert.equal(urls.filter(u => u.includes('gamma')).length, 1, 'un seul appel pour le lot');
  assert.equal(meta.get(`btc-updown-5m-${SLOT}`)!.upWon, false);
  assert.equal(meta.get(`btc-updown-5m-${SLOT + 300}`)!.upWon, null, 'pas réglé');
  assert.equal(meta.get(`btc-updown-5m-${SLOT}`)!.upTokenId, up);

  const h = await fetchPriceHistory(up, SLOT, SLOT + 300, { fetchImpl });
  assert.deepEqual(h, [{ t: SLOT, p: 0.42 }]);
  assert.ok(urls.some(u => u.includes(`prices-history?market=${up}&startTs=${SLOT}&endTs=${SLOT + 300}&fidelity=1`)));

  const k = await fetchKlinesRange('BTCUSDT', 0, 1500 * 60_000, { fetchImpl });
  assert.equal(k.length, 1501, 'deux tranches, sans doublon');
  assert.ok(urls.some(u => u.startsWith('https://data-api.binance.vision')), 'repli binance.vision');
});

test('mapLimit : ordre conservé, concurrence bornée', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async x => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    return x * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.ok(peak <= 2);
});

test('script de bout en bout contre un faux Polymarket/Binance : détecte un marché en retard', () => {
  const home = mkdtempSync(join(tmpdir(), 'hist-'));
  const out = execFileSync(process.execPath, [
    '--import', 'tsx', '--import', './tests/fixtures/fake-market-net.ts',
    'scripts/analysis/historical-backtest.ts', '--days', '1', '--coins', 'BTC,ETH',
  ], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /Backtest historique : \d+ rounds/);
  assert.match(out, /SIGNIFICATIVEMENT meilleur que le marché/);
  assert.match(out, /réglage actuel/);
  // deuxième passage : tout vient du cache (aucune requête Gamma ni prices-history)
  const again = spawnSync(process.execPath, [
    '--import', 'tsx', '--import', './tests/fixtures/fake-market-net.ts',
    'scripts/analysis/historical-backtest.ts', '--days', '1', '--coins', 'BTC,ETH',
  ], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 180_000 });
  assert.equal(again.status, 0);
  assert.match(again.stderr, /Rounds à interroger sur Gamma : 0 /);
  assert.match(again.stderr, /Historiques de prix à télécharger : 0/);
  assert.match(again.stdout, /Backtest historique/);
});

test('prix marché en retard d\'une minute : le modèle n\'est PAS déclaré meilleur (biais optimiste corrigé)', () => {
  // Marché PARFAIT à son heure (juste valeur exacte calculée avec le spot de son instant),
  // mais publié seulement toutes les 2 min : à τ = 120 s et 60 s, le dernier prix date
  // d'une minute. Avant, le modèle voyait le spot à l'heure et « battait » ce marché.
  let a = 77;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sigMin = 0.0006;
  const points: BacktestPoint[] = [];
  for (let k = 0; k < 400; k++) {
    const slot = SLOT + k * 300;
    const px: number[] = [100]; // px[i] = clôture de la minute i, i = 0 ↔ slot − 66 min
    for (let i = 1; i < 72; i++) px.push(px[i - 1] * Math.exp(sigMin * gauss()));
    const at = (m: number) => px[m + 66]; // clôture de la minute commençant à slot + 60·m
    const candles = [];
    for (let m = -65; m < 5; m++) candles.push({ openTimeMs: (slot + m * 60) * 1000, open: at(m - 1), close: at(m) });
    const strike = at(-1);
    const sigS = sigMin / Math.sqrt(60);
    const hist = [0, 120, 240].map(off => {
      const spot = at(off / 60 - 1); // spot à l'instant slot + off (clôture de la minute précédente)
      return { t: slot + off, p: normCdf(Math.log(spot / strike) / (sigS * Math.sqrt(300 - off + CFG.strikeNoiseSec))) };
    });
    const upWon = at(4) >= strike;
    points.push(...evaluateRound({ slug: `btc-updown-5m-${slot}`, coin: 'BTC', slotSec: slot, upWon }, candles, hist, CFG));
  }
  assert.ok(points.length > 0);
  assert.ok(points.every(p => (p.lagSec ?? 0) >= 0), 'le marché n\'est jamais plus ancien que le spot du modèle');
  const c = compareBrier(points);
  assert.ok(c.tDiff === null || c.tDiff > -2, `marché parfait déclaré battu : t = ${c.tDiff}`);
});
