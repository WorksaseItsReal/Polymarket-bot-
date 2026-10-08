/**
 * decision-journal.ts — journal JSONL de TOUTES les évaluations de la stratégie.
 *
 * Pourquoi : à ~1 trade par heure, juger le modèle sur les seuls trades prend des
 * semaines. Chaque évaluation (pari OU abstention) contient tout ce qu'il faut pour
 * rejouer la décision plus tard : spot, strike, σ, τ, P(Up), asks et profondeur. Une
 * fois les rounds réglés, `scripts/analysis/fv-report.ts` mesure la calibration du
 * modèle face au marché et le PnL qu'aurait donné chaque couple de seuils, sur des
 * milliers de rounds par jour.
 *
 * Fichiers : `<dir>/decisions-AAAA-MM-JJ.jsonl` (UTC), une ligne par évaluation, au
 * plus une toutes les `minIntervalMs` par round (sauf les paris, toujours écrits).
 * Les fichiers plus vieux que `keepDays` sont supprimés. Écriture asynchrone en file :
 * une panne disque ne bloque ni ne fait planter la stratégie.
 */

import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const DAY_MS = 86_400_000;

/** Fichiers du journal : `decisions-AAAA-MM-JJ.jsonl`, compressés ensuite en `.jsonl.gz`
 *  (avec un suffixe numérique si une archive du même jour existe déjà). */
export const JOURNAL_FILE_RE = /^decisions-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.jsonl(\.gz)?$/;

export interface DecisionRecord {
  /** Horodatage (ms epoch). */
  t: number;
  slug: string;
  coin: string;
  /** Temps restant (s). */
  tau: number;
  spot: number;
  strike: number;
  /** Volatilité par √seconde. */
  sig: number;
  /** Probabilité de « Up » utilisée pour décider (après mélange éventuel avec le marché). */
  pUp: number | null;
  /** Probabilité du modèle seul (avant mélange) ; absente des anciens journaux. */
  pRaw?: number | null;
  /** FV_Z_SCALE en vigueur (absent des anciens journaux = 1) : l'analyse ramène toutes les
   *  évaluations au même réglage avant d'estimer quoi que ce soit. */
  zs?: number;
  upAsk: number | null;
  downAsk: number | null;
  /** Taille (parts) au meilleur ask. */
  upAskSz: number | null;
  downAskSz: number | null;
  /** Meilleurs bids et tailles (absents des anciens journaux) : spread réel, analyse maker. */
  upBid?: number | null;
  downBid?: number | null;
  upBidSz?: number | null;
  downBidSz?: number | null;
  /** Source du spot (ex. binance+ws). */
  src: string;
  /** 'buy' si un pari a été pris, sinon 'hold'. */
  act: 'buy' | 'hold';
  side?: 'UP' | 'DOWN';
  stake?: number;
}

export interface DecisionJournalOptions {
  dir: string;
  minIntervalMs?: number;
  keepDays?: number;
  log?: (msg: string) => void;
}

export function journalFileName(tMs: number): string {
  return `decisions-${new Date(tMs).toISOString().slice(0, 10)}.jsonl`;
}

export class DecisionJournal {
  private readonly dir: string;
  private readonly minIntervalMs: number;
  private readonly keepDays: number;
  private readonly log: (msg: string) => void;
  private readonly last = new Map<string, number>();
  private queue: Array<[file: string, line: string]> = [];
  private writing: Promise<void> | null = null;
  private errorLogged = false;
  private lastCleanupDay = '';

  constructor(opts: DecisionJournalOptions) {
    this.dir = opts.dir;
    this.minIntervalMs = opts.minIntervalMs ?? 10_000;
    this.keepDays = opts.keepDays ?? 30;
    this.log = opts.log ?? (() => undefined);
  }

  /** Enregistre une évaluation (non bloquant). Renvoie true si elle a été retenue. */
  record(r: DecisionRecord): boolean {
    if (r.act !== 'buy' && r.t - (this.last.get(r.slug) ?? -Infinity) < this.minIntervalMs) return false;
    this.last.set(r.slug, r.t);
    if (this.last.size > 500) {
      for (const [k, t] of this.last) if (r.t - t > 900_000) this.last.delete(k);
    }
    this.queue.push([journalFileName(r.t), JSON.stringify(r)]);
    if (!this.writing) this.writing = this.drain().finally(() => { this.writing = null; });
    return true;
  }

  /** Attend la fin des écritures en cours (arrêt propre, tests). */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue;
      this.queue = [];
      const byFile = new Map<string, string[]>();
      for (const [file, line] of batch) (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(line);
      for (const [file, lines] of byFile) {
        try {
          await mkdir(this.dir, { recursive: true });
          await appendFile(join(this.dir, file), lines.join('\n') + '\n');
          this.errorLogged = false;
        } catch (err) {
          if (!this.errorLogged) {
            this.errorLogged = true;
            this.log(`journal des décisions : écriture impossible (${(err as Error).message}) — lignes perdues, la stratégie continue`);
          }
        }
        const day = file.slice(10, 20);
        if (day !== this.lastCleanupDay) {
          this.lastCleanupDay = day;
          await this.cleanup(Date.parse(day));
        }
      }
    }
  }

  private async cleanup(todayMs: number): Promise<void> {
    if (!Number.isFinite(todayMs)) return;
    try {
      for (const f of await readdir(this.dir)) {
        const m = JOURNAL_FILE_RE.exec(f);
        if (!m) continue;
        const age = todayMs - Date.parse(m[1]);
        if (age > this.keepDays * DAY_MS) {
          await unlink(join(this.dir, f));
          continue;
        }
        // Jours révolus (≥ 2 jours : plus aucune ligne n'y sera ajoutée) : compressés, ~10×
        // plus petits, ce qui permet de garder des semaines de mesure (~12 Mo/jour sinon).
        if (!m[2] && age >= 2 * DAY_MS) {
          const src = join(this.dir, f);
          let dst = `${src}.gz`;
          for (let k = 1; existsSync(dst); k++) dst = join(this.dir, `decisions-${m[1]}.${k}.jsonl.gz`);
          const tmp = `${dst}.tmp`;
          await writeFile(tmp, await gzipAsync(await readFile(src)));
          await rename(tmp, dst);
          await unlink(src);
        }
      }
    } catch { /* nettoyage best effort */ }
  }
}
