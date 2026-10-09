/**
 * Carnet d'ordres CLOB Polymarket — lecture publique, sans clé ni SDK.
 *
 *   GET https://clob.polymarket.com/book?token_id=<id>
 *
 * Remplace `sdk.markets.getTokenOrderbook` (qui exigeait d'instancier tout le SDK : wallet,
 * client signé, limiteurs, caches). Mêmes garde-fous que l'ancien chemin :
 *   - une erreur HTTP (404 « No orderbook exists » pour un round terminé) devient une
 *     exception explicite, jamais un carnet vide pris pour un 50/50 ;
 *   - un carnet SANS AUCUN niveau est une absence de donnée, pas une mesure ;
 *   - niveaux triés : asks du moins cher au plus cher, bids du plus haut au plus bas.
 * Délai : `axios.defaults.timeout` (réglé par le bot) ou `timeoutMs`.
 */
import axios, { type AxiosInstance } from 'axios';
import type { Book } from '../strategy/fair-value-runner.js';
import type { BookLevel } from './fair-value.js';

export const CLOB_HOST = 'https://clob.polymarket.com';

export interface ClobBookOptions {
  host?: string;
  timeoutMs?: number;
  /** Instance axios (tests). Défaut : l'instance globale (interceptée par le faux réseau). */
  http?: AxiosInstance;
}

/** Interprète la réponse `/book` (pure). Lève si elle n'est pas un carnet exploitable. */
export function parseClobBook(data: unknown, tokenId: string, status?: number): Book {
  const d = (data ?? {}) as { error?: unknown; asset_id?: unknown; bids?: unknown; asks?: unknown };
  if (status === 404 || d.error || !d.asset_id) {
    throw new Error(`carnet indisponible (token id périmé ou inconnu) : ${tokenId.slice(0, 18)}…${d.error ? ` — ${String(d.error).slice(0, 80)}` : ''}`);
  }
  const levels = (v: unknown): BookLevel[] => (Array.isArray(v) ? v : [])
    .map((l: { price?: unknown; size?: unknown }) => ({ price: parseFloat(String(l?.price)), size: parseFloat(String(l?.size)) }))
    .filter(l => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size >= 0);
  const bids = levels(d.bids).sort((a, b) => b.price - a.price);
  const asks = levels(d.asks).sort((a, b) => a.price - b.price);
  if (!bids.length && !asks.length) throw new Error(`carnet vide (aucun niveau) : ${tokenId.slice(0, 18)}…`);
  return { bids, asks };
}

export async function fetchClobBook(tokenId: string, o: ClobBookOptions = {}): Promise<Book> {
  const http = o.http ?? axios;
  const res = await http.get(`${(o.host ?? CLOB_HOST).replace(/\/+$/, '')}/book`, {
    params: { token_id: tokenId },
    ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}),
    // Une 404 est une réponse attendue (round terminé) : on la lit, on ne lève pas d'AxiosError.
    validateStatus: s => (s >= 200 && s < 300) || s === 404,
  });
  return parseClobBook(res.data, tokenId, res.status);
}
