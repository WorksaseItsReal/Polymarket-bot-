/**
 * pipeline.ts — ORCHESTRATEUR déterministe de la stratégie llm (PAPIER uniquement).
 *
 * Trois agents, toujours dans cet ordre : analyste → décideur → sécurité. L'orchestrateur ne
 * décide rien : il transmet (instantané en liste blanche + sorties VALIDÉES des étapes
 * précédentes), valide chaque réponse (`schema.ts`) et assemble la décision finale par le
 * code. Toute anomalie arrête la chaîne avec un code d'abstention, jamais un pari :
 *   - échéance trop proche avant une étape (< MIN_STEP_MS)   → 'apres_echeance', sans appel ;
 *   - échec de l'appel (processus, délai, limite d'usage…)   → le code de l'appel ;
 *   - réponse reçue APRÈS l'échéance                         → 'apres_echeance' (gardée dans
 *     `steps` pour analyse, jamais utilisée) ;
 *   - JSON invalide, clé manquante ou en trop, valeur, règle → le code de validation ;
 *   - décideur en abstention                                 → 'abstention_agent' (avec final,
 *     la sécurité n'est pas appelée) ;
 *   - veto de la sécurité                                    → 'veto' (final en abstention, la
 *     probabilité estimée est gardée pour le Brier).
 *
 * L'appel lui-même (`CallFn`) est injecté : ce module ne lance aucun processus et n'importe
 * aucun module de trading. Les garde-fous du code (risque bloqué, mise minimale ou maximale,
 * prix parti, doublon…) restent à appliquer par l'appelant APRÈS ce pipeline.
 */
import type { AbstentionCode, AgentRole, CallFn, CallOutcome, CallRequest } from './types.js';
import type { Snapshot } from './snapshot.js';
import {
  assembleFinal,
  jsonSchemaFor,
  parseAgentJson,
  validateAnalyse,
  validateDecision,
  validateSecurite,
  type Check,
  type FinalDecision,
} from './schema.js';
import { buildUserMessage, type PayloadByRole } from './prompt-version.js';

/** Délai maximal d'un agent (ms). */
export const DEFAULT_AGENT_TIMEOUT_MS = 45_000;
/** Temps minimal restant avant l'échéance pour lancer une étape (ms). */
export const MIN_STEP_MS = 3_000;

export interface PipelineOptions {
  snapshot: Snapshot;
  call: CallFn;
  /** Échéance absolue (ms, horloge de `now`) : au-delà, aucune réponse n'est utilisée. */
  deadlineAtMs: number;
  /** Horloge (ms). Défaut : Date.now. */
  now?: () => number;
  /** Délai maximal par agent (ms), borné par le temps restant avant l'échéance. */
  agentTimeoutMs?: number;
  /** Taux de frais taker (cohérence prix limite / probabilité du décideur). */
  feeRate: number;
  /** Passer aussi les schémas JSON aux appels (`--json-schema`, couche en plus). */
  jsonSchemas?: boolean;
  /** Version des prompts, recopiée dans le résultat (journal). */
  promptVersion?: string;
}

export interface PipelineStep {
  role: AgentRole;
  outcome: CallOutcome;
  /** Réponse VALIDÉE de l'agent, ou null (échec, réponse hors délai ou invalide). */
  parsed: object | null;
  code: 'ok' | AbstentionCode;
}

export interface PipelineResult {
  code: 'ok' | AbstentionCode;
  final: FinalDecision | null;
  steps: PipelineStep[];
  promptVersion?: string;
}

type StepResult<T> = { ok: true; value: T } | { ok: false; code: AbstentionCode };

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const now = o.now ?? Date.now;
  const agentTimeoutMs = o.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const steps: PipelineStep[] = [];
  const done = (code: 'ok' | AbstentionCode, final: FinalDecision | null = null): PipelineResult => ({
    code,
    final,
    steps,
    ...(o.promptVersion !== undefined ? { promptVersion: o.promptVersion } : {}),
  });

  async function step<R extends AgentRole, T extends object>(
    role: R,
    payload: PayloadByRole[R],
    validate: (obj: Record<string, unknown>) => Check<T>,
  ): Promise<StepResult<T>> {
    const remaining = o.deadlineAtMs - now();
    // Écrit pour échouer aussi sur NaN (échéance ou horloge invalide).
    if (!(remaining >= MIN_STEP_MS)) return { ok: false, code: 'apres_echeance' };
    const req: CallRequest = {
      role,
      stdin: buildUserMessage(role, payload),
      timeoutMs: Math.floor(Math.min(agentTimeoutMs, remaining)),
      ...(o.jsonSchemas ? { jsonSchema: jsonSchemaFor(role) } : {}),
    };

    const t0 = now();
    let outcome: CallOutcome;
    try {
      outcome = await o.call(req);
    } catch (e) {
      outcome = { ok: false, code: 'lancement_impossible', detail: `appel en échec : ${errorText(e)}`, latencyMs: Math.max(0, now() - t0), raw: '', exitCode: null, signal: null };
    }
    if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
      outcome = { ok: false, code: 'resultat_absent', detail: 'appel sans résultat exploitable', latencyMs: Math.max(0, now() - t0), raw: '', exitCode: null, signal: null };
    }

    const record = (code: 'ok' | AbstentionCode, parsed: object | null = null) => steps.push({ role, outcome, parsed, code });
    if (!outcome.ok) {
      record(outcome.code);
      return { ok: false, code: outcome.code };
    }
    if (!(now() <= o.deadlineAtMs)) {
      record('apres_echeance');
      return { ok: false, code: 'apres_echeance' };
    }
    const json = parseAgentJson(outcome.text, outcome.structured);
    if (!json.ok) {
      record(json.code);
      return { ok: false, code: json.code };
    }
    const v = validate(json.value);
    if (!v.ok) {
      record(v.code);
      return { ok: false, code: v.code };
    }
    record('ok', v.value);
    return { ok: true, value: v.value };
  }

  const instantane = o.snapshot;
  const analyse = await step('analyste', { instantane }, validateAnalyse);
  if (!analyse.ok) return done(analyse.code);

  const decision = await step('decideur', { instantane, analyse: analyse.value }, x => validateDecision(x, o.feeRate));
  if (!decision.ok) return done(decision.code);
  if (decision.value.action === 'abstention') {
    return done('abstention_agent', assembleFinal(instantane, analyse.value, decision.value, null));
  }

  const securite = await step('securite', { instantane, analyse: analyse.value, decision: decision.value }, x => validateSecurite(x, decision.value));
  if (!securite.ok) return done(securite.code);

  const final = assembleFinal(instantane, analyse.value, decision.value, securite.value);
  if (securite.value.verdict === 'veto') return done('veto', final);
  // Par construction un achat validé et approuvé reste un achat ; sinon, abstention.
  return done(final.action === 'abstention' ? 'incoherence' : 'ok', final);
}
