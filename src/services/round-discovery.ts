/**
 * round-discovery.ts — trouve le round 5 min EN COURS de chaque coin, sans scan.
 *
 * Un round « Up or Down » 5 min a un slug déterministe : `<coin>-updown-5m-<slot>`, où
 * `slot` = début du round en secondes epoch, multiple de 300. On le construit, puis on
 * lit `GET gamma-api/events?slug=<slug>` (chemin vérifié, cf. docs/backtest/resolve.py)
 * pour obtenir le conditionId et les deux token ids.
 *
 * Avant : le bot scannait une fenêtre de slugs, triait, tronquait à `limit`, puis
 * interrogeait le CLOB marché par marché avec 3 essais et 1 s d'attente — lent, et un
 * round pouvait disparaître du résultat tronqué.
 *
 * Garde-fous : le slug renvoyé doit être EXACTEMENT celui demandé ; les tokens sont
 * associés à « Up »/« Down » par LIBELLÉ, jamais par index ; un marché clôturé est ignoré.
 * Les métadonnées d'un round ne changent pas : elles sont mises en cache jusqu'à sa fin.
 */

import { roundPrices } from './paper-ledger.js';

export const DISCOVERY_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] as const;
export type DiscoveryCoin = (typeof DISCOVERY_COINS)[number];

export interface DiscoveredRound {
  conditionId: string;
  name: string;
  slug: string;
  underlying: DiscoveryCoin;
  durationMinutes: 5;
  upTokenId: string;
  downTokenId: string;
  /** Prix à battre officiel (Gamma `eventMetadata.priceToBeat`), s'il est déjà publié. MESURE
   *  seulement : journalisé (ps) pour savoir s'il est disponible pendant le round. */
  priceToBeat?: number;
}

export function slotStart(nowMs: number): number {
  return Math.floor(nowMs / 1000 / 300) * 300;
}

export function roundSlug(coin: DiscoveryCoin, slotSec: number): string {
  return `${coin.toLowerCase()}-updown-5m-${slotSec}`;
}

function parseArr(v: unknown): unknown[] | null {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}

/**
 * Tokens Up/Down et conditionId d'un round dans la réponse Gamma `events?slug=`, que le
 * marché soit ouvert ou clôturé (le backtest historique en a besoin). Pure.
 */
export function parseRoundTokens(
  data: unknown,
  coin: DiscoveryCoin,
  slug: string,
): (DiscoveredRound & { closed: boolean }) | null {
  const events = Array.isArray(data) ? data : [];
  const ev = events.find(e => e && typeof e === 'object' && (e as { slug?: unknown }).slug === slug) as
    | { markets?: unknown; title?: unknown; eventMetadata?: unknown }
    | undefined;
  if (!ev) return null;
  const markets = Array.isArray(ev.markets) ? ev.markets : [];
  const m = markets[0] as
    | { conditionId?: unknown; clobTokenIds?: unknown; outcomes?: unknown; closed?: unknown; question?: unknown }
    | undefined;
  if (!m) return null;
  const conditionId = typeof m.conditionId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(m.conditionId) ? m.conditionId : null;
  const tokens = (parseArr(m.clobTokenIds) ?? []).map(String);
  const outcomes = (parseArr(m.outcomes) ?? []).map(o => String(o).toLowerCase());
  const up = outcomes.indexOf('up');
  const down = outcomes.indexOf('down');
  if (!conditionId || up < 0 || down < 0 || tokens.length !== outcomes.length) return null;
  const upTokenId = tokens[up];
  const downTokenId = tokens[down];
  if (!/^\d{10,}$/.test(upTokenId) || !/^\d{10,}$/.test(downTokenId) || upTokenId === downTokenId) return null;
  return {
    conditionId,
    name: String(m.question ?? ev.title ?? slug),
    slug,
    underlying: coin,
    durationMinutes: 5,
    upTokenId,
    downTokenId,
    ...(roundPrices(ev).priceToBeat !== undefined ? { priceToBeat: roundPrices(ev).priceToBeat } : {}),
    closed: m.closed === true,
  };
}

/** Interprète la réponse Gamma `events?slug=`. Pure. null = round inexploitable ou clôturé. */
export function parseDiscoveryEvent(data: unknown, coin: DiscoveryCoin, slug: string): DiscoveredRound | null {
  const r = parseRoundTokens(data, coin, slug);
  if (!r || r.closed) return null;
  const { closed: _closed, ...round } = r;
  return round;
}

export interface DiscoveryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Délai minimal entre deux essais pour un slug introuvable (ms). */
  retryMs?: number;
  /** Relecture d'un round connu tant que son prix à battre officiel manque (ms ; 0 = jamais). */
  priceToBeatRetryMs?: number;
}

/**
 * Découvre les rounds en cours, avec cache par slug. Un slug introuvable (pas encore
 * créé, Gamma en retard) est réessayé au plus toutes les `retryMs`.
 */
export class RoundDiscovery {
  private readonly cache = new Map<string, DiscoveredRound>();
  private readonly misses = new Map<string, number>();
  private readonly ptbTried = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly ptbRetryMs: number;

  constructor(opts: DiscoveryOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.retryMs = opts.retryMs ?? 15_000;
    this.ptbRetryMs = opts.priceToBeatRetryMs ?? 20_000;
  }

  private async fetchOne(coin: DiscoveryCoin, slug: string): Promise<DiscoveredRound | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      return parseDiscoveryEvent(await res.json(), coin, slug);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Rounds en cours pour `coins` (ceux introuvables sont simplement absents). */
  async current(nowMs: number, coins: readonly DiscoveryCoin[] = DISCOVERY_COINS): Promise<DiscoveredRound[]> {
    const slot = slotStart(nowMs);
    // Purge : les rounds terminés ne servent plus.
    for (const [slug, r] of this.cache) {
      const s = Number(r.slug.split('-').pop());
      if (s + 300 < nowMs / 1000 - 60) this.cache.delete(slug);
    }
    for (const [slug, t] of this.misses) if (nowMs - t > 600_000) this.misses.delete(slug);
    for (const [slug, t] of this.ptbTried) if (nowMs - t > 600_000) this.ptbTried.delete(slug);

    const out = await Promise.all(
      coins.map(async coin => {
        const slug = roundSlug(coin, slot);
        const hit = this.cache.get(slug);
        if (hit) {
          // Prix à battre officiel pas encore publié : relu au plus toutes les ptbRetryMs, et
          // seulement pendant la fenêtre d'entrée (au-delà, il ne servirait plus à la mesure).
          const tauSec = slot + 300 - nowMs / 1000;
          if (hit.priceToBeat === undefined && this.ptbRetryMs > 0 && tauSec > 60
            && nowMs - (this.ptbTried.get(slug) ?? 0) >= this.ptbRetryMs) {
            this.ptbTried.set(slug, nowMs);
            const again = await this.fetchOne(coin, slug);
            if (again?.priceToBeat !== undefined && again.conditionId === hit.conditionId) {
              this.cache.set(slug, again);
              return again;
            }
          }
          return hit;
        }
        const lastMiss = this.misses.get(slug);
        if (lastMiss !== undefined && nowMs - lastMiss < this.retryMs) return null;
        const found = await this.fetchOne(coin, slug);
        if (found) {
          this.cache.set(slug, found);
          this.misses.delete(slug);
          this.ptbTried.set(slug, nowMs);
        } else {
          this.misses.set(slug, nowMs);
        }
        return found;
      }),
    );
    return out.filter((r): r is DiscoveredRound => r !== null);
  }
}
