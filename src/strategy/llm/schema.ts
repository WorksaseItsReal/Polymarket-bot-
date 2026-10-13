/**
 * schema.ts — validation STRICTE des réponses des agents de la stratégie llm (PAPIER
 * uniquement), écrite à la main (aucune dépendance).
 *
 * Chaque réponse doit être UN objet JSON aux clés exactes :
 *   - clé inconnue          → 'champ_inattendu' (ex. une « recommandation » de l'analyste) ;
 *   - clé absente           → 'champ_manquant' ;
 *   - type, borne, énum     → 'valeur_invalide' ;
 *   - règles entre champs   → 'incoherence' ;
 *   - pas un objet JSON     → 'json_invalide'.
 * Toute anomalie est une ABSTENTION (code), jamais un pari. Les schémas JSON (draft-07)
 * exportés sont générés depuis les MÊMES spécifications de champs : ils servent de couche
 * en plus (`--json-schema`) ; la validation de ce module fait foi.
 *
 * La décision finale est assemblée ICI, par le code (`assembleFinal`), jamais par un agent :
 * un veto ou l'absence de verdict de sécurité donne toujours une abstention, et les agents
 * en aval ne peuvent que RÉDUIRE la mise.
 *
 * Module PUR (aucune I/O).
 */
import type { AbstentionCode, AgentRole } from './types.js';
import type { Snapshot } from './snapshot.js';

/** Version des schémas : entre dans la version des prompts (`promptVersion`). */
export const SCHEMA_VERSION = 'sch-1';

export type Check<T> = { ok: true; value: T } | { ok: false; code: AbstentionCode; detail: string };

const ok = <T>(value: T): Check<T> => ({ ok: true, value });
const fail = <T>(code: AbstentionCode, detail: string): Check<T> => ({ ok: false, code, detail });

// ---------------------------------------------------------------------------
// Types des réponses
// ---------------------------------------------------------------------------

export interface Analyse {
  tendance: 'hausse' | 'baisse' | 'neutre';
  ecart_relatif: number;
  z: number;
  proba_formule_up: number;
  proba_carnet_up: number | null;
  liquidite: 'bonne' | 'faible' | 'insuffisante';
  spread_up: number | null;
  spread_down: number | null;
  risques: string[];
  observations: string;
}

export type DecisionAction = 'acheter_up' | 'acheter_down' | 'abstention';

export interface Decision {
  action: DecisionAction;
  /** P(Up gagne), TOUJOURS (même en abstention) : sert à la calibration (Brier). */
  proba_estimee: number;
  prix_limite: number | null;
  mise_usd: number | null;
  raison: string;
  desaccord_formule: string | null;
}

export interface Securite {
  verdict: 'ok' | 'veto';
  motifs: string[];
  mise_ajustee: number | null;
}

/** Sortie finale, assemblée par le code. `securite` est null quand l'agent sécurité n'a pas
 *  été appelé (décideur en abstention). */
export interface FinalDecision {
  round_id: string;
  actif: string;
  action: DecisionAction;
  proba_estimee: number;
  prix_limite: number | null;
  mise_usd: number | null;
  raison: string;
  analyse: Analyse;
  securite: Securite | null;
}

// ---------------------------------------------------------------------------
// Spécifications de champs (source unique : validateur ET schéma JSON)
// ---------------------------------------------------------------------------

type FieldSpec =
  | { t: 'enum'; values: readonly string[] }
  | { t: 'number'; min?: number; max?: number; exclusiveMin?: boolean; exclusiveMax?: boolean; nullable?: boolean }
  | { t: 'string'; maxLen: number; nullable?: boolean }
  | { t: 'strings'; maxItems: number; maxLen: number };

type ObjectSpec = Readonly<Record<string, FieldSpec>>;

const PROBA: FieldSpec = { t: 'number', min: 0, max: 1 };

export const ANALYSE_SPEC: ObjectSpec = {
  tendance: { t: 'enum', values: ['hausse', 'baisse', 'neutre'] },
  ecart_relatif: { t: 'number' },
  z: { t: 'number' },
  proba_formule_up: PROBA,
  proba_carnet_up: { ...PROBA, nullable: true },
  liquidite: { t: 'enum', values: ['bonne', 'faible', 'insuffisante'] },
  spread_up: { t: 'number', nullable: true },
  spread_down: { t: 'number', nullable: true },
  risques: { t: 'strings', maxItems: 5, maxLen: 150 },
  observations: { t: 'string', maxLen: 300 },
};

export const DECISION_SPEC: ObjectSpec = {
  action: { t: 'enum', values: ['acheter_up', 'acheter_down', 'abstention'] },
  proba_estimee: PROBA,
  prix_limite: { t: 'number', min: 0, max: 1, exclusiveMin: true, exclusiveMax: true, nullable: true },
  mise_usd: { t: 'number', min: 0, exclusiveMin: true, nullable: true },
  raison: { t: 'string', maxLen: 300 },
  desaccord_formule: { t: 'string', maxLen: 300, nullable: true },
};

export const SECURITE_SPEC: ObjectSpec = {
  verdict: { t: 'enum', values: ['ok', 'veto'] },
  motifs: { t: 'strings', maxItems: 5, maxLen: 200 },
  mise_ajustee: { t: 'number', min: 0, exclusiveMin: true, nullable: true },
};

const SPECS: Record<AgentRole, ObjectSpec> = { analyste: ANALYSE_SPEC, decideur: DECISION_SPEC, securite: SECURITE_SPEC };

// ---------------------------------------------------------------------------
// Validation générique
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Longueur en caractères (points de code, comme `maxLength` des schémas JSON). */
const charLen = (s: string) => [...s].length;

function fieldError(key: string, v: unknown, f: FieldSpec): string | null {
  if (v === null) return f.t !== 'enum' && f.t !== 'strings' && f.nullable ? null : `${key} : null interdit`;
  switch (f.t) {
    case 'enum':
      return typeof v === 'string' && f.values.includes(v) ? null : `${key} : valeur hors énumération (${f.values.join(' | ')})`;
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${key} : nombre fini attendu`;
      if (f.min !== undefined && (f.exclusiveMin ? !(v > f.min) : !(v >= f.min))) return `${key} : ${v} hors bornes`;
      if (f.max !== undefined && (f.exclusiveMax ? !(v < f.max) : !(v <= f.max))) return `${key} : ${v} hors bornes`;
      return null;
    }
    case 'string':
      if (typeof v !== 'string') return `${key} : chaîne attendue`;
      return charLen(v) <= f.maxLen ? null : `${key} : plus de ${f.maxLen} caractères`;
    case 'strings':
      if (!Array.isArray(v)) return `${key} : liste de chaînes attendue`;
      if (v.length > f.maxItems) return `${key} : plus de ${f.maxItems} éléments`;
      for (const s of v) {
        if (typeof s !== 'string') return `${key} : liste de chaînes attendue`;
        if (charLen(s) > f.maxLen) return `${key} : élément de plus de ${f.maxLen} caractères`;
      }
      return null;
  }
}

/** Clés exactes : inconnue → champ_inattendu, absente → champ_manquant, valeur → valeur_invalide. */
function checkObject(obj: unknown, spec: ObjectSpec, what: string): Check<Record<string, unknown>> {
  if (!isPlainObject(obj)) return fail('json_invalide', `${what} : objet JSON attendu`);
  const extra = Object.keys(obj).filter(k => !Object.prototype.hasOwnProperty.call(spec, k));
  if (extra.length) return fail('champ_inattendu', `${what} : clé(s) inattendue(s) ${extra.slice(0, 5).map(k => JSON.stringify(k.slice(0, 40))).join(', ')}`);
  const missing = Object.keys(spec).filter(k => !Object.prototype.hasOwnProperty.call(obj, k));
  if (missing.length) return fail('champ_manquant', `${what} : clé(s) manquante(s) ${missing.join(', ')}`);
  for (const [k, f] of Object.entries(spec)) {
    const err = fieldError(k, obj[k], f);
    if (err) return fail('valeur_invalide', `${what} : ${err}`);
  }
  return ok(obj);
}

// ---------------------------------------------------------------------------
// Lecture du JSON d'un agent
// ---------------------------------------------------------------------------

/** Seul habillage toléré : un bloc ```json … ``` (ou ``` … ```) entourant TOUT le texte. */
const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/**
 * Objet JSON d'une réponse d'agent. La sortie structurée (`--json-schema`) prime si elle est
 * présente ; sinon le texte entier doit être UN objet JSON (éventuellement dans un seul bloc
 * ```json). Tout le reste (prose autour, tableau, plusieurs objets) → 'json_invalide'.
 */
export function parseAgentJson(text: unknown, structured: unknown): Check<Record<string, unknown>> {
  if (structured !== null && structured !== undefined) {
    return isPlainObject(structured) ? ok(structured) : fail('json_invalide', 'sortie structurée : objet JSON attendu');
  }
  if (typeof text !== 'string') return fail('json_invalide', 'réponse texte absente');
  let t = text.trim();
  const m = FENCE_RE.exec(t);
  if (m) t = m[1].trim();
  if (!t.startsWith('{')) return fail('json_invalide', 'la réponse n\'est pas un objet JSON seul');
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return fail('json_invalide', 'JSON illisible');
  }
  return isPlainObject(v) ? ok(v) : fail('json_invalide', 'objet JSON attendu');
}

// ---------------------------------------------------------------------------
// Validateurs par rôle
// ---------------------------------------------------------------------------

/** Frais taker par part au prix p : taux · p · (1 − p). */
export function feePerShare(p: number, feeRate: number): number {
  return feeRate * p * (1 - p);
}

/** Tolérance numérique des règles de cohérence. */
const EPS = 1e-9;

/** Analyste : analyse structurée, AUCUNE recommandation (toute clé en plus est rejetée). */
export function validateAnalyse(obj: unknown): Check<Analyse> {
  return checkObject(obj, ANALYSE_SPEC, 'analyste') as Check<Analyse>;
}

/**
 * Décideur. Cohérence : abstention ⇒ prix_limite et mise_usd null ; achat ⇒ les deux
 * présents ; coût par part (prix_limite + frais) ≤ probabilité du côté choisi
 * (P(Up) pour acheter_up, 1 − P(Up) pour acheter_down).
 */
export function validateDecision(obj: unknown, feeRate: number): Check<Decision> {
  const c = checkObject(obj, DECISION_SPEC, 'décideur');
  if (!c.ok) return c;
  const d = c.value as unknown as Decision;
  if (d.action === 'abstention') {
    if (d.prix_limite !== null || d.mise_usd !== null) return fail('incoherence', 'décideur : abstention avec prix_limite ou mise_usd non null');
    return ok(d);
  }
  if (d.prix_limite === null || d.mise_usd === null) return fail('incoherence', `décideur : ${d.action} sans prix_limite ou sans mise_usd`);
  const pSide = d.action === 'acheter_up' ? d.proba_estimee : 1 - d.proba_estimee;
  const cost = d.prix_limite + feePerShare(d.prix_limite, feeRate);
  // Comparaison écrite pour échouer si un terme n'est pas un nombre (taux de frais invalide).
  if (!(cost <= pSide + EPS)) {
    return fail('incoherence', `décideur : coût ${cost.toFixed(4)} (prix limite + frais) > probabilité du côté ${pSide.toFixed(4)}`);
  }
  return ok(d);
}

/** Sécurité : verdict ok/veto ; ne peut que RÉDUIRE la mise (mise_ajustee ≤ mise du décideur). */
export function validateSecurite(obj: unknown, decision: Pick<Decision, 'mise_usd'>): Check<Securite> {
  const c = checkObject(obj, SECURITE_SPEC, 'sécurité');
  if (!c.ok) return c;
  const s = c.value as unknown as Securite;
  if (s.mise_ajustee !== null) {
    if (decision.mise_usd === null) return fail('incoherence', 'sécurité : mise_ajustee sans mise du décideur');
    if (!(s.mise_ajustee <= decision.mise_usd + EPS)) return fail('incoherence', `sécurité : mise_ajustee ${s.mise_ajustee} > mise du décideur ${decision.mise_usd} (seule une réduction est permise)`);
  }
  return ok(s);
}

// ---------------------------------------------------------------------------
// Assemblage final (par le code)
// ---------------------------------------------------------------------------

/**
 * Décision finale. Un achat n'est retenu QUE si la sécurité a rendu 'ok' ; veto ou verdict
 * absent ⇒ abstention (prix et mise null), la probabilité estimée étant gardée pour le
 * Brier. Mise finale = min(mise du décideur, mise_ajustee si présente).
 */
export function assembleFinal(
  snapshot: Pick<Snapshot, 'round_id' | 'actif'>,
  analyse: Analyse,
  decision: Decision,
  securite: Securite | null,
): FinalDecision {
  const buy = decision.action !== 'abstention' && securite !== null && securite.verdict === 'ok'
    && decision.prix_limite !== null && decision.mise_usd !== null;
  let mise: number | null = null;
  if (buy) mise = securite.mise_ajustee !== null ? Math.min(decision.mise_usd as number, securite.mise_ajustee) : decision.mise_usd;
  return {
    round_id: snapshot.round_id,
    actif: snapshot.actif,
    action: buy ? decision.action : 'abstention',
    proba_estimee: decision.proba_estimee,
    prix_limite: buy ? decision.prix_limite : null,
    mise_usd: mise,
    raison: decision.raison,
    analyse,
    securite: securite ? { verdict: securite.verdict, motifs: [...securite.motifs], mise_ajustee: securite.mise_ajustee } : null,
  };
}

// ---------------------------------------------------------------------------
// Schémas JSON (draft-07), générés depuis les mêmes spécifications
// ---------------------------------------------------------------------------

function fieldSchema(f: FieldSpec): Record<string, unknown> {
  switch (f.t) {
    case 'enum':
      return { type: 'string', enum: [...f.values] };
    case 'number': {
      const s: Record<string, unknown> = { type: f.nullable ? ['number', 'null'] : 'number' };
      if (f.min !== undefined) s[f.exclusiveMin ? 'exclusiveMinimum' : 'minimum'] = f.min;
      if (f.max !== undefined) s[f.exclusiveMax ? 'exclusiveMaximum' : 'maximum'] = f.max;
      return s;
    }
    case 'string':
      return { type: f.nullable ? ['string', 'null'] : 'string', maxLength: f.maxLen };
    case 'strings':
      return { type: 'array', items: { type: 'string', maxLength: f.maxLen }, maxItems: f.maxItems };
  }
}

function objectSchema(title: string, spec: ObjectSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(spec)) properties[k] = fieldSchema(f);
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title,
    type: 'object',
    additionalProperties: false,
    required: Object.keys(spec),
    properties,
  };
}

export const ANALYSE_JSON_SCHEMA = objectSchema('analyste', ANALYSE_SPEC);
export const DECISION_JSON_SCHEMA = objectSchema('decideur', DECISION_SPEC);
export const SECURITE_JSON_SCHEMA = objectSchema('securite', SECURITE_SPEC);

/** Schéma JSON du rôle (pour `--json-schema`). Les règles entre champs restent au code. */
export function jsonSchemaFor(role: AgentRole): Record<string, unknown> {
  return role === 'analyste' ? ANALYSE_JSON_SCHEMA : role === 'decideur' ? DECISION_JSON_SCHEMA : SECURITE_JSON_SCHEMA;
}

/** Clés attendues pour un rôle (ordre de la spécification). */
export function expectedKeys(role: AgentRole): string[] {
  return Object.keys(SPECS[role]);
}
