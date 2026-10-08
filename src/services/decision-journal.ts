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
import { gunzip, gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
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
  /** Loi du modèle si ce n'est pas la normale (FV_TAILS=t4). */
  tl?: 't4';
  /** Évaluation déclenchée par un MOUVEMENT du spot (et non par le passage régulier) :
   *  gardée pour rejouer les paris, exclue des mesures « modèle vs carnet » et de la
   *  calibration (elle sur-représente les instants juste après un saut, où un carnet en
   *  retard flatte le modèle). */
  mv?: true;
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
  /** Dernière évaluation journalisée (ms) par round et par type de passage. */
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
    // Écart minimal de 80 % de `minIntervalMs` (8 s), séparément pour les passages réguliers
    // et ceux déclenchés par un saut du spot (mv). Avant : 10 s strictes partagées → un
    // passage à 9,98 s du précédent (gigue réseau) ou une évaluation mv intercalée faisait
    // perdre ~1 passage régulier sur 3, surtout juste après un saut. (Des tranches fixes
    // perdent aussi : 30 s et 39,97 s tombent dans la même.)
    // Évaluations « saut du spot » : au plus une toutes les 3 intervalles (30 s) — utiles
    // pour rejouer les paris, mais sans doubler la taille du journal (et la mémoire du rapport).
    const key = r.mv ? `${r.slug}|mv` : r.slug;
    const gap = r.mv ? 3 * this.minIntervalMs : 0.8 * this.minIntervalMs;
    if (r.act !== 'buy' && r.t - (this.last.get(key) ?? -Infinity) < gap) return false;
    this.last.set(key, r.t);
    if (this.last.size > 500) {
      // rounds terminés depuis plus de 15 min : oubliés
      for (const k of this.last.keys()) {
        const s = Number(k.split('|')[0].split('-').pop());
        if (!Number.isFinite(s) || r.t - (s * 1000 + 300_000) > 900_000) this.last.delete(k);
      }
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
      const files = await readdir(this.dir);
      for (const f of files) {
        // Reste d'une compression interrompue (arrêt brutal) : jamais relu, supprimé.
        if (/^decisions-.*\.jsonl\.gz\.tmp$/.test(f)) {
          await unlink(join(this.dir, f)).catch(() => undefined);
          continue;
        }
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
          const content = await readFile(src);
          // Arrêt brutal entre l'écriture de l'archive et la suppression de l'original :
          // l'archive existe déjà avec ce contenu → supprimer l'original, ne PAS recréer une
          // 2e archive identique (le rapport lirait chaque ligne deux fois).
          const gz = `${src}.gz`;
          // toutes les archives de ce jour (`D.jsonl.gz`, `D.1.jsonl.gz`…), pas seulement la 1re
          const sameDay = files.filter(x => x.startsWith(`decisions-${m[1]}`) && x.endsWith('.jsonl.gz'));
          let duplicate = false;
          for (const a of sameDay) {
            const prev = await readFile(join(this.dir, a)).then(b => gunzipAsync(b)).catch(() => null);
            if (prev && prev.equals(content)) { duplicate = true; break; }
          }
          if (duplicate) {
            await unlink(src);
            continue;
          }
          let dst = gz;
          for (let k = 1; existsSync(dst); k++) dst = join(this.dir, `decisions-${m[1]}.${k}.jsonl.gz`);
          const tmp = `${dst}.tmp`;
          await writeFile(tmp, await gzipAsync(content));
          await rename(tmp, dst);
          await unlink(src);
        }
      }
    } catch { /* nettoyage best effort */ }
  }
}
