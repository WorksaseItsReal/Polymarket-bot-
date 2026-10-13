/**
 * llm-journal.ts — enregistrement de la stratégie llm, HORS du registre des trades.
 *
 *   <data>/llm/decisions.jsonl            une ligne par tentative de décision (abstentions comprises)
 *   <data>/llm/snapshots/<sha256>.json     instantané montré aux agents, un fichier par empreinte
 *   <data>/llm/raw/<AAAA-MM-JJ>/<id>.json.gz  sorties brutes de chaque agent (flux complet)
 *
 * Le trade llm du registre ne porte que `decisionId` : tout le reste se retrouve ici par
 * l'identifiant. Le format de la ligne (`LlmDecisionRecord`) est la source du rapport
 * comparatif (scripts/analysis/fv-report.ts) et de la règle d'arrêt (stop-rule.ts).
 *
 * Écritures en ajout seul (une ligne = un appendFileSync) ; une erreur d'écriture est remontée
 * à l'appelant (journalisée), elle ne bloque jamais les autres stratégies.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { AbstentionCode, AgentRole, UsageInfo } from './types.js';
import type { FinalDecision } from './schema.js';
import type { SimulatedExecution } from './guards.js';

export const LLM_RECORD_VERSION = 1;

/** Exécution simulée (modèle commun : décision, +1 s, carnet relu, frais). */
export type ExecRecord = Pick<SimulatedExecution, 'side' | 'vwap' | 'shares' | 'costUsd' | 'costPerShare'> | null;

export interface LlmStepRecord {
  role: AgentRole;
  code: 'ok' | AbstentionCode;
  latencyMs: number;
  /** Réponse VALIDÉE de l'agent (null si échec). */
  parsed: object | null;
  /** Détail d'échec (sans jeton), ou null. */
  detail: string | null;
  usage: UsageInfo | null;
}

export interface LlmDecisionRecord {
  v: typeof LLM_RECORD_VERSION;
  /** Identifiant de décision (référencé par le trade du registre et par la sortie brute). */
  id: string;
  /** Début de la tentative (ms epoch). */
  t: number;
  round_id: string;
  slotSec: number;
  actif: string;
  conditionId: string;
  /** Campagne de mesure = version du CLI + version des prompts (changement → nouvelle campagne). */
  campaign: string;
  cliVersion: string | null;
  promptVersion: string | null;
  /** Modèles réellement servis (union des agents). */
  models: string[];
  /** Empreinte de l'instantané (snapshots/<hash>.json) ; null si aucun instantané n'a été pris. */
  snapshotHash: string | null;
  /** Secondes depuis le début du round à l'instantané. */
  atSec: number | null;
  /** 'ok' (pari pris) ou motif d'abstention. */
  code: 'ok' | AbstentionCode | string;
  /** Explication lisible du motif. */
  detail: string;
  /** Latence totale des agents (ms) et par agent. */
  latencyMs: number | null;
  steps: LlmStepRecord[];
  /** Décision finale assemblée par le code (null si les agents n'ont pas abouti). */
  final: FinalDecision | null;
  /** P(Up) des agents (= final.proba_estimee), null si absente : sert au Brier. */
  pLlm: number | null;
  /** Décision après garde-fous du code et exécution simulée. */
  exec: {
    code: string;
    side: 'UP' | 'DOWN' | null;
    stakeUsd: number;
    limitPrice: number | null;
    fill: ExecRecord;
    reason: string;
  } | null;
  /** Formule au MÊME instantané, exécutée par le même modèle (règle d'arrêt). */
  formula: {
    pUp: number | null;
    pRaw: number | null;
    side: 'UP' | 'DOWN' | null;
    limitPrice: number | null;
    fill: ExecRecord;
    reason: string;
  } | null;
  /** Sortie brute archivée (chemin relatif à <data>/llm), ou null. */
  raw: string | null;
  /** Trade ouvert au registre, ou null. */
  tradeId: string | null;
}

export function campaignOf(cliVersion: string | null, promptVersion: string | null): string {
  return `cli-${cliVersion ?? 'inconnu'}_${promptVersion ?? 'inconnu'}`;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class LlmJournal {
  constructor(private readonly p: { decisions: string; snapshots: string; raw: string; dir: string }) {}

  /** Une ligne par tentative (abstentions comprises). */
  append(rec: LlmDecisionRecord): void {
    mkdirSync(this.p.dir, { recursive: true });
    appendFileSync(this.p.decisions, `${JSON.stringify(rec)}\n`);
  }

  /** Instantané stocké une fois par empreinte. */
  saveSnapshot(hash: string, json: string): void {
    if (!/^[0-9a-f]{16,128}$/.test(hash)) throw new Error('empreinte d\'instantané invalide');
    mkdirSync(this.p.snapshots, { recursive: true });
    const file = join(this.p.snapshots, `${hash}.json`);
    if (!existsSync(file)) writeFileSync(file, json);
  }

  /** Sorties brutes (flux complet de chaque agent), compressées ; renvoie le chemin relatif. */
  saveRaw(id: string, t: number, steps: Array<{ role: AgentRole; raw: string }>): string {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw new Error('identifiant de décision invalide');
    const sub = day(t);
    const dir = join(this.p.raw, sub);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json.gz`), gzipSync(JSON.stringify({ id, steps })));
    return join('raw', sub, `${id}.json.gz`);
  }

  /** Supprime les dossiers de sorties brutes plus vieux que `keepDays` (jamais les décisions). */
  pruneRaw(nowMs: number, keepDays: number): number {
    if (!existsSync(this.p.raw)) return 0;
    const limit = day(nowMs - keepDays * 86_400_000);
    let n = 0;
    for (const d of readdirSync(this.p.raw)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < limit) {
        rmSync(join(this.p.raw, d), { recursive: true, force: true });
        n++;
      }
    }
    return n;
  }
}
