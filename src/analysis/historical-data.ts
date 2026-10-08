/**
 * historical-data.ts — récupération des données du backtest historique (I/O).
 *
 *   - rounds passés : Gamma `events?slug=a&slug=b…` (paramètre répétable, vérifié dans
 *     docs/backtest/resolve.py), tokens par libellé + issue (marché clôturé, prix 1/0) ;
 *   - prix Polymarket : CLOB `prices-history?market=<token Up>&startTs&endTs&fidelity=1` ;
 *   - bougies Binance 1 min : `klines` par tranches de 1000.
 * Délai et un nouvel essai sur chaque requête ; `fetchImpl` injectable (tests).
 */

import { parseGammaEvent } from '../services/paper-ledger.js';
import { parseRoundTokens, type DiscoveryCoin } from '../services/round-discovery.js';
import { parseBinance, type Candle } from '../services/round-market-data.js';
import { parsePriceHistory, type PricePoint } from './historical-backtest.js';

export interface RoundMeta {
  upTokenId: string;
  downTokenId: string;
  /** null = pas (encore) réglé. */
  upWon: boolean | null;
}

export interface FetchOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function getJson(url: string, o: FetchOpts = {}): Promise<unknown | null> {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 10_000);
    try {
      const res = await f(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Métadonnées et issues d'un lot de rounds (≤ 20 slugs par requête). */
export async function fetchRoundsMeta(
  slugs: Array<{ slug: string; coin: DiscoveryCoin }>,
  o: FetchOpts = {},
): Promise<Map<string, RoundMeta>> {
  const out = new Map<string, RoundMeta>();
  for (let i = 0; i < slugs.length; i += 20) {
    const batch = slugs.slice(i, i + 20);
    const url = `https://gamma-api.polymarket.com/events?limit=${batch.length * 2}&`
      + batch.map(b => `slug=${encodeURIComponent(b.slug)}`).join('&');
    const data = await getJson(url, o);
    if (!data) continue;
    for (const b of batch) {
      const tokens = parseRoundTokens(data, b.coin, b.slug);
      if (!tokens) continue;
      const outcome = parseGammaEvent(data, b.slug);
      out.set(b.slug, {
        upTokenId: tokens.upTokenId,
        downTokenId: tokens.downTokenId,
        upWon: outcome.resolved ? outcome.upWon : null,
      });
    }
  }
  return out;
}

/** Historique de prix d'un token sur [startTs, endTs] (secondes). [] si indisponible. */
export async function fetchPriceHistory(
  tokenId: string,
  startTs: number,
  endTs: number,
  o: FetchOpts & { onRaw?: (raw: unknown) => void } = {},
): Promise<PricePoint[]> {
  const url = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}`
    + `&startTs=${startTs}&endTs=${endTs}&fidelity=1`;
  const data = await getJson(url, o);
  if (data !== null) o.onRaw?.(data);
  return data === null ? [] : parsePriceHistory(data);
}

/** Bougies Binance 1 min sur [startMs, endMs] (binance.com puis binance.vision). */
export async function fetchKlinesRange(symbol: string, startMs: number, endMs: number, o: FetchOpts = {}): Promise<Candle[]> {
  const all = new Map<number, Candle>();
  for (let from = startMs; from <= endMs; from += 1000 * 60_000) {
    const to = Math.min(endMs, from + 999 * 60_000);
    let got: Candle[] | null = null;
    for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
      got = parseBinance(await getJson(`${host}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${to}&limit=1000`, o));
      if (got) break;
    }
    for (const c of got ?? []) all.set(c.openTimeMs, c);
  }
  return [...all.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

/** Exécute `fn` sur `items` avec au plus `n` appels simultanés. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}
