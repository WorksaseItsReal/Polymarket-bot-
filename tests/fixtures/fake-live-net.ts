/**
 * Faux réseau + horloge accélérée pour lancer le VRAI bot (bot-with-dashboard.ts) de bout
 * en bout, sans Internet (préchargé avec `node --import tsx --import ./tests/fixtures/fake-live-net.ts`).
 *
 *   - horloge : Date (now et new Date()) accélérée ×FAKE_TIME_SPEED (défaut 20) : un round
 *     de 5 min dure ~15 s ; départ 40 s après le début d'un créneau ;
 *   - spot : marche aléatoire seconde par seconde (σ ≈ 0,06 %/min) par crypto ;
 *   - Binance klines (fetch) : bougies 1 min cohérentes avec ce spot ;
 *   - Gamma events?slug= (fetch) : rounds <coin>-updown-5m-<slot>, réglés 10 s après la fin ;
 *   - CLOB /book (axios, utilisé par le client Polymarket) : juste valeur d'un spot vu avec
 *     FAKE_BOOK_LAG_SEC (défaut 30) secondes de retard, ±1 ct, profondeur 200 parts.
 * Tout le reste répond 404.
 */
import axios from 'axios';
import { normCdf } from '../../src/services/fair-value.ts';

const K = Number(process.env.FAKE_TIME_SPEED ?? '20');
const LAG = Number(process.env.FAKE_BOOK_LAG_SEC ?? '30');
const RealDate = Date;
const real0 = RealDate.now();
const sim0 = Math.ceil(real0 / 300_000) * 300_000 + 40_000;
const simNow = () => sim0 + (RealDate.now() - real0) * K;
class FakeDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(simNow());
    else super(...(a as [number]));
  }
  static now() { return simNow(); }
}
(globalThis as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;

const COINS = ['btc', 'eth', 'sol', 'xrp', 'doge'];
const SIG = 0.0006 / Math.sqrt(60);
const T0 = Math.floor(sim0 / 1000) - 4000; // début des chemins (une heure d'historique)
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const paths = COINS.map((_, i) => ({ p: [100] as number[], r: rng(1000 + i) }));
function spot(coin: string, tSec: number): number {
  const w = paths[COINS.indexOf(coin)];
  const idx = Math.max(0, Math.floor(tSec - T0));
  while (w.p.length <= idx) {
    const g = Math.sqrt(-2 * Math.log(w.r() + 1e-12)) * Math.cos(2 * Math.PI * w.r());
    w.p.push(w.p[w.p.length - 1] * Math.exp(SIG * g));
  }
  return w.p[idx];
}

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), {
  status, headers: { 'Content-Type': 'application/json', date: new RealDate(simNow()).toUTCString() },
});

function gammaEvent(slug: string) {
  const m = /^(\w+)-updown-5m-(\d+)$/.exec(slug);
  if (!m || !COINS.includes(m[1])) return null;
  const coin = m[1];
  const slot = Number(m[2]);
  const closed = simNow() / 1000 > slot + 300 + 10;
  const upWon = spot(coin, slot + 300) >= spot(coin, slot);
  const ci = COINS.indexOf(coin);
  return {
    slug, title: `${coin} up or down`,
    markets: [{
      conditionId: '0x' + String(slot).padStart(62, '0') + String(ci).padStart(2, '0'),
      question: `${coin.toUpperCase()} Up or Down`, closed,
      outcomes: '["Up","Down"]',
      clobTokenIds: JSON.stringify([`9${ci}1${slot}`, `9${ci}2${slot}`]),
      outcomePrices: closed ? (upWon ? '["1","0"]' : '["0","1"]') : '["0.5","0.5"]',
    }],
  };
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('gamma-api.polymarket.com/events')) {
    const slugs = [...url.matchAll(/slug=([^&]+)/g)].map(x => decodeURIComponent(x[1]));
    return json(slugs.map(gammaEvent).filter(Boolean));
  }
  if (url.includes('/api/v3/klines')) {
    const sym = /symbol=(\w+)USDT/.exec(url)![1].toLowerCase();
    if (!COINS.includes(sym)) return json({ error: 'symbol' }, 400);
    const nowSec = simNow() / 1000;
    const curMin = Math.floor(nowSec / 60) * 60;
    const rows = [];
    for (let m = curMin - 60 * 60; m <= curMin; m += 60) {
      const close = spot(sym, Math.min(nowSec, m + 59));
      rows.push([m * 1000, String(spot(sym, m - 1)), String(close), String(close), String(close), '1', m * 1000 + 59_999]);
    }
    return json(rows);
  }
  return json({ error: 'not found (faux réseau)' }, 404);
}) as typeof fetch;

axios.defaults.adapter = async config => {
  const url = String(config.url ?? '');
  const ok = (data: unknown, status = 200) => ({ data, status, statusText: String(status), headers: {}, config, request: {} });
  if (url.includes('/book')) {
    const token = String((config.params as { token_id?: string } | undefined)?.token_id ?? /token_id=(\d+)/.exec(url)?.[1] ?? '');
    const m = /^9(\d)([12])(\d+)$/.exec(token);
    if (!m) return ok({ error: 'No orderbook exists for the requested token id' }, 404);
    const coin = COINS[Number(m[1])];
    const slot = Number(m[3]);
    const t = simNow() / 1000 - LAG;
    const tau = Math.max(1, slot + 300 - t);
    const pUp = normCdf(Math.log(spot(coin, t) / spot(coin, slot)) / (SIG * Math.sqrt(tau)));
    const p = m[2] === '1' ? pUp : 1 - pUp;
    const tick = (x: number) => Math.min(0.99, Math.max(0.01, Math.round(x * 100) / 100));
    return ok({
      market: 'x', asset_id: token, timestamp: String(simNow()), hash: 'h',
      bids: [{ price: String(tick(p - 0.01)), size: '200' }],
      asks: [{ price: String(tick(p + 0.01)), size: '200' }],
    });
  }
  return ok({ error: 'not found (faux réseau)' }, 404);
};
