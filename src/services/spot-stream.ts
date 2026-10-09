/**
 * spot-stream.ts — prix spot en TEMPS RÉEL (WebSocket Binance `aggTrade`), avec
 * reconnexion automatique, détection de flux figé et estimation du décalage d'horloge.
 *
 * Pourquoi : l'avantage de la stratégie vient des secondes qui suivent un mouvement du
 * spot, avant que le carnet Polymarket ne se mette à jour. Un spot relu toutes les 10 s
 * par REST arrive souvent après la bataille. Ici chaque trade Binance met le prix à
 * jour, et un événement `move` est émis dès qu'un coin a bougé de `moveBps` depuis la
 * dernière évaluation — la stratégie peut alors réagir immédiatement.
 *
 * Sources (même marché que les bougies du strike → aucun écart USDT/USD introduit) :
 *   1. wss://stream.binance.com:9443   2. wss://data-stream.binance.vision (données seules)
 * En cas d'échec des deux, `price()` renvoie null et la stratégie retombe sur le REST.
 *
 * Horloge : τ (temps restant) est calculé avec l'heure LOCALE. On compare l'heure de
 * réception à l'horodatage Binance de chaque trade ; une médiane > `maxClockSkewMs`
 * signale une horloge serveur déréglée (ou un flux très en retard) → alerte.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export type StreamCoin = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE';

const SYMBOL: Record<StreamCoin, string> = {
  BTC: 'btcusdt', ETH: 'ethusdt', SOL: 'solusdt', XRP: 'xrpusdt', DOGE: 'dogeusdt',
};
const BY_SYMBOL = new Map(Object.entries(SYMBOL).map(([c, s]) => [s.toUpperCase(), c as StreamCoin]));

export const DEFAULT_STREAM_URLS = [
  'wss://stream.binance.com:9443/stream?streams=',
  'wss://data-stream.binance.vision/stream?streams=',
];

export interface SpotStreamOptions {
  coins: readonly StreamCoin[];
  /** Préfixes d'URL essayés dans l'ordre (le nom des flux est ajouté). */
  urls?: string[];
  /** Mouvement (points de base) déclenchant un événement `move`. */
  moveBps?: number;
  /** Aucun message pendant ce délai → reconnexion. */
  staleMs?: number;
  /** Médiane |réception − horodatage| au-delà de laquelle l'horloge est suspecte. */
  maxClockSkewMs?: number;
  now?: () => number;
  log?: (level: 'INFO' | 'WARN', msg: string) => void;
}

export interface LivePrice {
  price: number;
  /** Âge (ms) de la dernière mise à jour, horloge locale. */
  ageMs: number;
  source: string;
}

interface CoinState {
  price: number;
  recvAt: number;
  lastMovePrice: number;
  /** Dernier prix de chaque seconde (horloge locale), ~4 dernières minutes : TWAP partiel. */
  secs: Array<[sec: number, price: number]>;
}
const SECS_KEPT = 240;

/** Extrait (coin, prix, horodatage Binance) d'un message combiné `aggTrade`. Pure. */
export function parseAggTrade(raw: string): { coin: StreamCoin; price: number; eventTime: number } | null {
  try {
    const msg = JSON.parse(raw) as { data?: { e?: string; s?: string; p?: string; E?: number; T?: number } };
    const d = msg?.data;
    if (!d || d.e !== 'aggTrade' || typeof d.s !== 'string') return null;
    const coin = BY_SYMBOL.get(d.s.toUpperCase());
    const price = Number(d.p);
    const eventTime = Number(d.T ?? d.E);
    if (!coin || !(price > 0) || !Number.isFinite(eventTime)) return null;
    return { coin, price, eventTime };
  } catch {
    return null;
  }
}

export class SpotStream extends EventEmitter {
  private readonly coins: readonly StreamCoin[];
  private readonly urls: string[];
  private readonly moveBps: number;
  private readonly staleMs: number;
  private readonly maxClockSkewMs: number;
  private readonly now: () => number;
  private readonly logFn: (level: 'INFO' | 'WARN', msg: string) => void;
  private readonly state = new Map<StreamCoin, CoinState>();
  private readonly skews: number[] = [];
  private ws: WebSocket | null = null;
  private urlIdx = 0;
  private attempt = 0;
  private lastMsgAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private skewWarned = false;
  private connectedUrl = '';

  constructor(opts: SpotStreamOptions) {
    super();
    this.coins = opts.coins;
    this.urls = opts.urls ?? DEFAULT_STREAM_URLS;
    this.moveBps = opts.moveBps ?? 3;
    this.staleMs = opts.staleMs ?? 15_000;
    this.maxClockSkewMs = opts.maxClockSkewMs ?? 2000;
    this.now = opts.now ?? Date.now;
    this.logFn = opts.log ?? (() => undefined);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws && this.lastMsgAt && this.now() - this.lastMsgAt > this.staleMs) {
        this.logFn('WARN', `Flux spot muet depuis ${Math.round((this.now() - this.lastMsgAt) / 1000)} s — reconnexion`);
        this.lastMsgAt = 0;
        this.ws.terminate();
      }
    }, Math.max(1000, Math.floor(this.staleMs / 3)));
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchdog = null;
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    try { ws?.terminate(); } catch { /* déjà fermé */ }
  }

  /** Dernier prix si plus récent que `maxAgeMs`, sinon null. */
  price(coin: string, maxAgeMs = 3000): LivePrice | null {
    const s = this.state.get(coin as StreamCoin);
    if (!s) return null;
    const ageMs = this.now() - s.recvAt;
    if (ageMs > maxAgeMs) return null;
    return { price: s.price, ageMs, source: 'binance-ws' };
  }

  /**
   * Moyenne du prix par seconde sur [fromMs, toMs) — dernier prix de chaque seconde, reporté
   * sur une seconde sans échange : la part déjà acquise du TWAP de règlement. null sans prix
   * connu au début de l'intervalle (tolérance 2 s) ou si l'intervalle est vide.
   */
  meanSince(coin: string, fromMs: number, toMs: number): number | null {
    const s = this.state.get(coin as StreamCoin);
    if (!s || !s.secs.length) return null;
    const from = Math.floor(fromMs / 1000);
    const to = Math.ceil(toMs / 1000);
    if (to <= from) return null;
    let i = 0;
    let price: number | null = null;
    while (i < s.secs.length && s.secs[i][0] < from) { price = s.secs[i][1]; i++; }
    if (price === null && (i >= s.secs.length || s.secs[i][0] > from + 2)) return null;
    let sum = 0;
    let n = 0;
    for (let sec = from; sec < to; sec++) {
      while (i < s.secs.length && s.secs[i][0] <= sec) { price = s.secs[i][1]; i++; }
      if (price === null) continue;
      sum += price;
      n++;
    }
    return n ? sum / n : null;
  }

  /** Médiane (réception locale − horodatage Binance), ms ; null si < 20 mesures. */
  clockSkewMs(): number | null {
    if (this.skews.length < 20) return null;
    const sorted = [...this.skews].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.now() - this.lastMsgAt < this.staleMs;
  }

  private connect(): void {
    if (this.stopped) return;
    const streams = this.coins.map(c => `${SYMBOL[c]}@aggTrade`).join('/');
    const url = this.urls[this.urlIdx % this.urls.length] + streams;
    let opened = false;
    let gotMessage = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 8000 });
    } catch (err) {
      this.scheduleReconnect(`ouverture impossible (${(err as Error).message})`);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      opened = true;
      this.attempt = 0;
      this.connectedUrl = url.split('/stream')[0];
      this.lastMsgAt = this.now();
      this.logFn('INFO', `Flux spot temps réel connecté (${this.connectedUrl})`);
      this.emit('connected', this.connectedUrl);
    });
    ws.on('message', data => {
      gotMessage = true;
      this.onMessage(String(data));
    });
    ws.on('error', () => { /* géré par 'close' */ });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      // Source injoignable, ou ouverte mais muette (proxy, blocage) → source suivante.
      if (!opened || !gotMessage) this.urlIdx++;
      this.scheduleReconnect(opened ? 'connexion fermée' : 'connexion refusée');
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt++;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6));
    if (this.attempt === 1 || this.attempt % 10 === 0) {
      this.logFn('WARN', `Flux spot temps réel : ${reason} — nouvel essai dans ${Math.round(delay / 1000)} s (le bot utilise le REST en attendant)`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onMessage(raw: string): void {
    const t = parseAggTrade(raw);
    if (!t) return;
    const recvAt = this.now();
    this.lastMsgAt = recvAt;
    this.skews.push(recvAt - t.eventTime);
    if (this.skews.length > 200) this.skews.splice(0, this.skews.length - 200);
    const skew = this.clockSkewMs();
    if (skew !== null && Math.abs(skew) > this.maxClockSkewMs && !this.skewWarned) {
      this.skewWarned = true;
      this.emit('clockSkew', skew);
    }

    const sec = Math.floor(recvAt / 1000);
    const s = this.state.get(t.coin);
    if (!s) {
      this.state.set(t.coin, { price: t.price, recvAt, lastMovePrice: t.price, secs: [[sec, t.price]] });
      return;
    }
    s.price = t.price;
    s.recvAt = recvAt;
    const last = s.secs[s.secs.length - 1];
    if (last && last[0] === sec) last[1] = t.price;
    else if (!last || sec > last[0]) {
      s.secs.push([sec, t.price]);
      if (s.secs.length > SECS_KEPT) s.secs.splice(0, s.secs.length - SECS_KEPT);
    }
    const bps = Math.abs(t.price / s.lastMovePrice - 1) * 1e4;
    if (bps >= this.moveBps) {
      s.lastMovePrice = t.price;
      this.emit('move', t.coin, t.price, bps);
    }
  }
}
