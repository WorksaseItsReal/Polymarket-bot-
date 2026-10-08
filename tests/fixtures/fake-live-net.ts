/**
 * Faux réseau + horloge accélérée pour lancer le VRAI bot (bot-with-dashboard.ts) de bout
 * en bout, sans Internet (préchargé avec `node --import tsx --import ./tests/fixtures/fake-live-net.ts`).
 *
 *   - horloge : Date (now et new Date()) accélérée ×FAKE_TIME_SPEED (défaut 20) : un round
 *     de 5 min dure ~15 s ; départ 40 s après le début d'un créneau ;
 *   - spot : marche aléatoire seconde par seconde (σ ≈ 0,06 %/min) par crypto ;
 *   - Binance klines (fetch) : bougies 1 min cohérentes avec ce spot ;
 *   - Gamma events?slug= (fetch) : rounds <coin>-updown-5m-<slot>, réglés 10 s après la fin,
 *     comme les vrais depuis août 2026 : moyenne (TWAP) des 60 s finales ≥ moyenne des
 *     60 s précédant l'ouverture ;
 *   - CLOB /book (axios, utilisé par le client Polymarket) : juste valeur d'un spot vu avec
 *     FAKE_BOOK_LAG_SEC (défaut 30) secondes de retard, ±1 ct, profondeur 200 parts ;
 *   - Telegram (fetch) : getMe/getChat/sendMessage ; messages écrits dans FAKE_TELEGRAM_LOG,
 *     HTML refusé (400) s'il est invalide, comme le vrai.
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

/** Moyenne du spot sur les 60 s qui se terminent à `tSec` (règlement TWAP Chainlink). */
function twap60(coin: string, tSec: number): number {
  let sum = 0;
  for (let k = 0; k < 60; k++) sum += spot(coin, tSec - k);
  return sum / 60;
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
  const upWon = twap60(coin, slot + 300) >= twap60(coin, slot);
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

// Faux Telegram : messages enregistrés (une ligne JSON par envoi) dans FAKE_TELEGRAM_LOG ;
// le HTML est vérifié comme le ferait Telegram (balises autorisées, bien fermées).
const TG_LOG = process.env.FAKE_TELEGRAM_LOG;
const TG_TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a']);
function htmlProblem(text: string): string | null {
  const stack: string[] = [];
  for (const m of text.matchAll(/<(\/?)([a-zA-Z]+)[^>]*>/g)) {
    const tag = m[2].toLowerCase();
    if (!TG_TAGS.has(tag)) return `balise non supportée <${tag}>`;
    if (m[1]) { if (stack.pop() !== tag) return `balise </${tag}> mal fermée`; } else stack.push(tag);
  }
  if (stack.length) return `balise <${stack[stack.length - 1]}> non fermée`;
  if (/&(?!(amp|lt|gt|quot);)/.test(text)) return 'entité & non échappée';
  return null;
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.telegram.org/bot')) {
    const method = url.split('/').pop();
    if (method === 'getMe') return json({ ok: true, result: { id: 1, is_bot: true, username: 'faux_bot' } });
    if (method === 'getChat') return json({ ok: true, result: { id: 42, type: 'private' } });
    if (method === 'sendMessage') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string; parse_mode?: string };
      const problem = body.parse_mode === 'HTML' ? htmlProblem(body.text ?? '') : null;
      if (TG_LOG) (await import('node:fs')).appendFileSync(TG_LOG, JSON.stringify({ text: body.text, html: body.parse_mode === 'HTML', problem }) + '\n');
      if (problem) return json({ ok: false, error_code: 400, description: `Bad Request: can't parse entities: ${problem}` }, 400);
      return json({ ok: true, result: { message_id: 1 } });
    }
    return json({ ok: false, error_code: 404, description: 'Not Found' }, 404);
  }
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
      const end = Math.min(nowSec, m + 59);
      const open = spot(sym, m - 1);
      let high = open;
      let low = open;
      for (let t = m; t <= end; t++) { const x = spot(sym, t); if (x > high) high = x; if (x < low) low = x; }
      rows.push([m * 1000, String(open), String(high), String(low), String(spot(sym, end)), '1', m * 1000 + 59_999]);
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
    // Juste valeur (règlement TWAP 60 s) d'un spot vu avec LAG secondes de retard.
    const t = simNow() / 1000 - LAG;
    const tau = Math.max(1, slot + 300 - t);
    const varSec = tau >= 60 ? tau - 40 : (tau * tau * tau) / (3 * 3600);
    const pUp = normCdf(Math.log(spot(coin, t) / twap60(coin, slot)) / (SIG * Math.sqrt(varSec)));
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
