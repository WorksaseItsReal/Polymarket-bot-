/**
 * shadow-tracker.ts — « le modèle prédit-il mieux que le carnet ? », mesuré en continu.
 *
 * Pour chaque round observé (tradé ou non), on garde la PREMIÈRE évaluation complète :
 * P(Up) du modèle et P(Up) implicite du carnet (milieu des asks). Une fois le round
 * réglé, on ajoute au bilan l'erreur quadratique (Brier) de chacun. La différence
 * appariée d = Brier(modèle) − Brier(carnet) et sa t-stat disent si le modèle est
 * SIGNIFICATIVEMENT meilleur (d < 0) — condition nécessaire pour gagner de l'argent.
 *
 * Seuls des agrégats (sommes) sont persistés : fichier minuscule, survit aux redémarrages.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DecisionRecord } from '../services/decision-journal.js';
import type { RoundOutcome } from '../services/paper-ledger.js';
import { marketProbUp, rawModelProb } from '../analysis/fv-analysis.js';

export interface ShadowAggregate {
  n: number;
  sumModel: number;
  sumMarket: number;
  /** Σ d et Σ d², d = (pModèle − y)² − (pCarnet − y)² */
  sumD: number;
  sumD2: number;
}

export interface ShadowStats {
  n: number;
  brierModel: number | null;
  brierMarket: number | null;
  /** t-stat de la différence (négative = modèle meilleur). */
  tDiff: number | null;
}

interface Pending {
  endMs: number;
  pModel: number;
  pMarket: number;
}

export interface ShadowOptions {
  path: string;
  fetchOutcome: (slug: string) => Promise<RoundOutcome>;
  now?: () => number;
  /** Rounds en attente au maximum (borne mémoire). */
  maxPending?: number;
  /** Résolutions réseau au maximum par appel de resolveDue(). */
  perCall?: number;
}

const EMPTY: ShadowAggregate = { n: 0, sumModel: 0, sumMarket: 0, sumD: 0, sumD2: 0 };

export function shadowStats(a: ShadowAggregate): ShadowStats {
  if (!a.n) return { n: 0, brierModel: null, brierMarket: null, tDiff: null };
  const mean = a.sumD / a.n;
  let tDiff: number | null = null;
  if (a.n >= 2) {
    const v = (a.sumD2 - a.n * mean * mean) / (a.n - 1);
    if (v > 0) tDiff = mean / Math.sqrt(v / a.n);
  }
  return { n: a.n, brierModel: a.sumModel / a.n, brierMarket: a.sumMarket / a.n, tDiff };
}

export class ShadowTracker {
  private readonly o: Required<Omit<ShadowOptions, 'path' | 'fetchOutcome'>> & Pick<ShadowOptions, 'path' | 'fetchOutcome'>;
  private readonly pending = new Map<string, Pending>();
  private agg: ShadowAggregate;
  private resolving = false;

  constructor(opts: ShadowOptions) {
    this.o = { now: Date.now, maxPending: 200, perCall: 5, ...opts };
    this.agg = { ...EMPTY };
    try {
      if (existsSync(opts.path)) {
        const a = JSON.parse(readFileSync(opts.path, 'utf8')) as Partial<ShadowAggregate>;
        if ([a.n, a.sumModel, a.sumMarket, a.sumD, a.sumD2].every(x => typeof x === 'number' && Number.isFinite(x))) {
          this.agg = a as ShadowAggregate;
        }
      }
    } catch { /* fichier illisible : on repart de zéro, sans l'écraser tant que rien n'est mesuré */ }
  }

  /** Retient la première évaluation exploitable de chaque round. */
  observe(r: DecisionRecord): void {
    // Modèle SEUL : avec un mélange actif, pUp contient déjà le carnet et la comparaison
    // « modèle vs carnet » serait truquée.
    const pModel = rawModelProb(r);
    if (this.pending.has(r.slug) || pModel === null) return;
    const pMarket = marketProbUp(r);
    if (pMarket === null) return;
    const slot = Number(r.slug.split('-').pop());
    if (!Number.isFinite(slot)) return;
    if (this.pending.size >= this.o.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(r.slug, { endMs: slot * 1000 + 300_000, pModel, pMarket });
  }

  /** Règle les rounds terminés (au plus `perCall` requêtes). Ne lève jamais. */
  async resolveDue(): Promise<void> {
    if (this.resolving) return;
    this.resolving = true;
    try {
      const now = this.o.now();
      let calls = 0;
      let changed = false;
      for (const [slug, p] of [...this.pending]) {
        if (now < p.endMs + 60_000) continue;
        if (now > p.endMs + 3_600_000) {
          this.pending.delete(slug); // jamais réglé en 1 h : abandonné
          continue;
        }
        if (calls++ >= this.o.perCall) break;
        let out: RoundOutcome;
        try {
          out = await this.o.fetchOutcome(slug);
        } catch {
          continue;
        }
        if (!out.resolved) continue;
        const y = out.upWon ? 1 : 0;
        const bm = (p.pModel - y) ** 2;
        const bk = (p.pMarket - y) ** 2;
        const d = bm - bk;
        this.agg = {
          n: this.agg.n + 1,
          sumModel: this.agg.sumModel + bm,
          sumMarket: this.agg.sumMarket + bk,
          sumD: this.agg.sumD + d,
          sumD2: this.agg.sumD2 + d * d,
        };
        this.pending.delete(slug);
        changed = true;
      }
      if (changed) this.persist();
    } finally {
      this.resolving = false;
    }
  }

  stats(): ShadowStats {
    return shadowStats(this.agg);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.o.path), { recursive: true });
      const tmp = `${this.o.path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.agg));
      renameSync(tmp, this.o.path);
    } catch { /* mesure en mémoire conservée ; nouvel essai au prochain round */ }
  }
}
