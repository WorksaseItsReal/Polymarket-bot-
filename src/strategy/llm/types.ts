/**
 * types.ts — types partagés de la stratégie llm (PAPIER uniquement).
 * Toute anomalie se traduit par un code d'abstention : jamais un pari.
 */
export type AgentRole = 'analyste' | 'decideur' | 'securite';

export type AbstentionCode =
  // couche processus (claude-runner)
  | 'lancement_impossible' | 'timeout' | 'apres_echeance' | 'code_sortie' | 'signal'
  | 'sortie_trop_grande' | 'flux_invalide' | 'resultat_absent' | 'resultat_erreur'
  | 'limite_usage' | 'authentification' | 'isolation'
  // couche décision (schémas, cohérence)
  | 'json_invalide' | 'champ_manquant' | 'champ_inattendu' | 'valeur_invalide' | 'incoherence'
  | 'veto' | 'abstention_agent'
  // garde-fous du code et ordonnancement
  | 'bloque_risque' | 'mise_sous_minimum' | 'prix_parti' | 'marche_a_bouge' | 'deja_parie'
  | 'budget_heure' | 'budget_jour' | 'pause' | 'desactive' | 'occupe' | 'fenetre_recolte'
  | 'actif_non_active' | 'hors_echantillon' | 'jeton_absent' | 'version_cli';

export interface UsageInfo {
  numTurns?: number;
  durationMs?: number;
  durationApiMs?: number;
  totalCostUsd?: number;
  modelUsage?: Record<string, unknown>;
  /** Modèles réellement servis (clés de modelUsage, ou modèle de l'événement init). */
  models: string[];
}

export type CallOutcome =
  | { ok: true; text: string; structured: unknown | null; usage: UsageInfo; cliVersion: string | null; latencyMs: number; raw: string }
  | { ok: false; code: AbstentionCode; detail: string; latencyMs: number; raw: string; exitCode: number | null; signal: string | null };

export interface CallRequest {
  role: AgentRole;
  /** Message utilisateur (instructions + données JSON), envoyé sur stdin. */
  stdin: string;
  timeoutMs: number;
  /** Schéma JSON optionnel passé à --json-schema (couche en plus ; la validation fait foi côté code). */
  jsonSchema?: object;
}

export type CallFn = (req: CallRequest) => Promise<CallOutcome>;
