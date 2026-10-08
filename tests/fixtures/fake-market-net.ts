/**
 * Faux réseau pour le test de bout en bout du backtest historique (préchargé avec
 * `node --import tsx --import ./tests/fixtures/fake-market-net.ts …`).
 *
 * Monde simulé COHÉRENT entre les trois API :
 *   - Binance : marche aléatoire 1 min par coin (σ = 0,06 %/min), open = clôture précédente ;
 *   - Gamma : rounds `<coin>-updown-5m-<slot>`, issue = clôture finale ≥ ouverture du slot ;
 *   - CLOB prices-history : juste valeur calculée avec le spot d'UNE MINUTE AVANT
 *     (marché en retard) → le modèle, qui voit le spot à l'heure, doit le battre.
 */
import { normCdf } from '../../src/services/fair-value.ts';

const SIG_MIN = 0.0006;
const COINS = ['btc', 'eth', 'sol', 'xrp', 'doge'];
const BASE_MIN = Math.floor(Date.now() / 60_000) - 4 * 1440; // 4 jours d'historique

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

const paths = new Map<string, number[]>();
/** Clôture de la bougie qui commence à la minute absolue `m`. */
function price(coin: string, m: number): number {
  let p = paths.get(coin);
  if (!p) {
    p = [100];
    paths.set(coin, p);
  }
  // régénère de façon déterministe jusqu'à l'indice voulu
  const idx = m - BASE_MIN;
  if (idx < 0) return 100;
  while (p.length <= idx) {
    // tirage déterministe propre à (coin, position)
    const rr = rng(COINS.indexOf(coin) * 1_000_003 + p.length);
    const g = Math.sqrt(-2 * Math.log(rr() + 1e-12)) * Math.cos(2 * Math.PI * rr());
    p.push(p[p.length - 1] * Math.exp(SIG_MIN * g));
  }
  return p[idx];
}

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });

function round(slug: string) {
  const m = /^(\w+)-updown-5m-(\d+)$/.exec(slug);
  if (!m) return null;
  const coin = m[1];
  const slot = Number(m[2]);
  const strike = price(coin, slot / 60 - 1);
  const final = price(coin, slot / 60 + 4);
  return { coin, slot, strike, upWon: final >= strike, ci: COINS.indexOf(coin) };
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes('gamma-api.polymarket.com/events')) {
    const slugs = [...url.matchAll(/slug=([^&]+)/g)].map(x => decodeURIComponent(x[1]));
    const now = Date.now() / 1000;
    return json(slugs.map(slug => {
      const r = round(slug)!;
      const closed = r.slot + 300 < now - 60;
      return {
        slug,
        markets: [{
          conditionId: '0x' + String(r.slot).padStart(64, '0').slice(-64),
          closed,
          outcomes: '["Up","Down"]',
          clobTokenIds: JSON.stringify([`1${r.ci}${r.slot}`, `2${r.ci}${r.slot}`]),
          outcomePrices: closed ? (r.upWon ? '["1","0"]' : '["0","1"]') : '["0.5","0.5"]',
        }],
      };
    }));
  }
  if (url.includes('clob.polymarket.com/prices-history')) {
    const token = /market=(\d+)/.exec(url)![1];
    const ci = Number(token[1]);
    const slot = Number(token.slice(2));
    const coin = COINS[ci];
    const strike = price(coin, slot / 60 - 1);
    const sigS = SIG_MIN / Math.sqrt(60);
    const history = [0, 60, 120, 180, 240].map(k => {
      const t = slot + k;
      const tau = slot + 300 - t;
      // FAKE_MARKET_LAG_MIN=0 : marché JUSTE (contrôle négatif) ; défaut 1 : spot d'une minute avant
      const lagMin = Number(process.env.FAKE_MARKET_LAG_MIN ?? '1');
      const lagged = price(coin, (t - 60 * lagMin) / 60 - 1);
      const p = normCdf(Math.log(lagged / strike) / (sigS * Math.sqrt(tau + 60 * lagMin)));
      return { t, p: Math.round(p * 1000) / 1000 };
    });
    return json({ history });
  }
  if (url.includes('/api/v3/klines')) {
    const sym = /symbol=(\w+)USDT/.exec(url)![1].toLowerCase();
    const start = Number(/startTime=(\d+)/.exec(url)![1]);
    const end = Number(/endTime=(\d+)/.exec(url)![1]);
    const rows = [];
    for (let t = Math.ceil(start / 60_000) * 60_000; t <= end && rows.length < 1000; t += 60_000) {
      const m = t / 60_000;
      rows.push([t, String(price(sym, m - 1)), '0', '0', String(price(sym, m)), '1', t + 59_999]);
    }
    return json(rows);
  }
  return json({ error: 'not found' }, 404);
}) as typeof fetch;
