/**
 * DeepSeek Flash Market Analyzer
 * -------------------------------------------------------------
 * Module autonome d'analyse LLM pour les marchés Polymarket via
 * l'API OpenAI-compatible de DeepSeek (deepseek-chat / deepseek-v4-flash).
 *
 * IMPORTANT — DeepSeek FLASH, PAS Qwen, PAS de cloud Alibaba.
 *
 * MODE DÉGRADÉ 100% LOCAL :
 *  - Si DEEPSEEK_API_KEY est absent/vide OU DEEPSEEK_ANALYZER_ENABLED !== 'true',
 *    le module retourne un HOLD sûr SANS appeler le réseau et SANS lever d'erreur.
 *  - Le bot peut donc tourner en DRY_RUN sans aucune clé.
 *
 * BUDGET QUOTIDIEN :
 *  - Les appels réseau sont comptés dans ~/.polymarket/llm-calls.json.
 *  - Dès que le compteur dépasse DEEPSEEK_MAX_CALLS_PER_DAY (défaut 30),
 *    le module passe en HOLD sans appeler le réseau.
 *
 * Dépendances : uniquement le runtime (fetch natif Node 18+, AbortSignal.timeout).
 * AUCUNE dépendance axios.
 */

import { homedir } from 'os';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export type LLMRecommendation = 'BUY_YES' | 'BUY_NO' | 'HOLD';

export interface MarketAnalysisInput {
  marketId: string;
  /** Structure libre (ProcessedOrderbook du SDK, ou {yes:{ask,bid,depth}, no:{...}}) */
  orderbook?: Record<string, unknown>;
  /** Nouvelles / contexte textuel brut (peut être vide) */
  news?: string;
  /** Historique de prix récent (ex: [{price, ts}]) */
  priceHistory?: Array<{ price: number; ts?: number }>;
  /** Question du marché (utile au modèle) */
  question?: string;
  /** Liquidité estimée en USD (optionnelle, sinon calculée) */
  liquidityUsd?: number;
  /** Spread en % (optionnel, sinon calculé) */
  spreadPct?: number;
}

export interface MarketAnalysisResult {
  recommendation: LLMRecommendation;
  confidence: number; // 0..1
  reasoning: string;
  /** true si la réponse vient du mode dégradé local (pas du réseau) */
  degraded: boolean;
}

// ============================================================================
// Constantes & config env
// ============================================================================

const DEFAULT_MAX_CALLS_PER_DAY = 30;
// Timeout généreux : opencode/zen "réfléchit" (deepseek-v4-flash) => 2-8s.
// Réglable via DEEPSEEK_TIMEOUT_MS.
function timeoutMs(): number {
  const raw = Number(process.env.DEEPSEEK_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}
const DEFAULT_MAX_TOKENS = 6000; // budget réponse deepseek-v4-flash

/** max_tokens plafonné dans [4000, 8000] — réglable via env, défaut 6000. */
function maxTokens(): number {
  const min = Number(process.env.DEEPSEEK_MIN_TOKENS ?? '') || 4000;
  const max = Number(process.env.DEEPSEEK_MAX_TOKENS ?? '') || 8000;
  const raw = Number(process.env.DEEPSEEK_MAX_TOKENS ?? '');
  const v = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_TOKENS;
  return Math.min(max, Math.max(min, v));
}

function apiUrl(): string {
  // Endpoint Hermes (opencode-go / zen) — le même modèle que l'assistant.
  return (
    process.env.DEEPSEEK_API_URL ||
    process.env.DEEPSEEK_BASE_URL ||
    'https://opencode.ai/zen/go/v1/chat/completions'
  );
}

function model(): string {
  return process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
}

/** Session affinity OpenCode (comme Hermes) — dérivée d'un identifiant stable. */
function sessionId(): string {
  const s = (process.env.DEEPSEEK_SESSION_ID || 'paperbot').trim();
  return /^sess-[\w-]+$/.test(s) ? s : `sess-${s.replace(/[^\w-]/g, '')}`;
}

function apiKey(): string {
  // Clé opencode-go (Hermes) en priorité, sinon clé DeepSeek directe
  return (
    process.env.OPENCODE_GO_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    ''
  ).trim();
}

function maxCallsPerDay(): number {
  const raw = Number(process.env.DEEPSEEK_MAX_CALLS_PER_DAY ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_CALLS_PER_DAY;
}

function budgetFile(): string {
  const dir = join(homedir(), '.polymarket');
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore chmod/permission issues — on retombera sur HOLD sécurisé */
    }
  }
  return join(dir, 'llm-calls.json');
}

// ============================================================================
// Détection du mode dégradé
// ============================================================================

/** true si le module est activé ET possède une clé (sinon mode local dégradé). */
export function isEnabled(): boolean {
  const flag = process.env.DEEPSEEK_ANALYZER_ENABLED?.trim().toLowerCase();
  const key = apiKey();
  return flag === 'true' && key.length > 0;
}

/** Retourne un HOLD dégradé sans erreur ni requête réseau. */
function hold(reason: string): MarketAnalysisResult {
  return { recommendation: 'HOLD', confidence: 0.0, reasoning: reason, degraded: true };
}

// ============================================================================
// Budget quotidien (fichier JSON)
// ============================================================================

interface BudgetState {
  date: string; // YYYY-MM-DD
  calls: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readBudget(): BudgetState {
  try {
    const f = budgetFile();
    if (!existsSync(f)) return { date: today(), calls: 0 };
    const parsed = JSON.parse(readFileSync(f, 'utf-8')) as BudgetState;
    if (!parsed || typeof parsed.date !== 'string' || typeof parsed.calls !== 'number') {
      return { date: today(), calls: 0 };
    }
    // Nouveau jour → reset
    if (parsed.date !== today()) return { date: today(), calls: 0 };
    return { date: parsed.date, calls: parsed.calls };
  } catch {
    return { date: today(), calls: 0 };
  }
}

function writeBudget(calls: number): void {
  try {
    writeFileSync(budgetFile(), JSON.stringify({ date: today(), calls }, null, 2));
  } catch {
    /* échec d'écriture non bloquant : HOLD sûr de toute façon */
  }
}

function budgetRemaining(): { ok: boolean; used: number; max: number } {
  const max = maxCallsPerDay();
  const used = readBudget().calls;
  return { ok: used < max, used, max };
}

// ============================================================================
// Helpers de parsing/validation
// ============================================================================

/** Confiance minimale pour accepter un BUY (sinon HOLD). Réglable via DEEPSEEK_MIN_CONF, défaut 0.50.
 * Apprentissage : ajusté selon le PnL des dernières décisions simulées (~/.polymarket/history.json).
 * Si le bot perd, il remonte le seuil (plus prudent) ; s'il gagne, il le garde bas (continue). */
export function minConf(): number {
  const raw = Number(process.env.DEEPSEEK_MIN_CONF ?? '');
  const base = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.5;
  try {
    const fs = require('fs') as typeof import('fs');
    const PATH = process.env.HOME + '/.polymarket/history.json';
    if (fs.existsSync(PATH)) {
      const h = JSON.parse(fs.readFileSync(PATH, 'utf-8'));
      const rec = h.slice(-8); // dernière fenêtre de décisions
      if (rec.length >= 3) {
        const pnl = rec.reduce((a: number, r: any) => a + (Number(r.realized) || 0), 0);
        // pertes récentes → plus de prudence (jusqu'à +0.20) ; gains → retour au seuil de base
        return Math.min(0.7, Math.max(0.35, base - Math.min(Math.max(pnl, -2), 2) * 0.10));
      }
    }
  } catch { /* ignore — on garde le seuil de base */ }
  return base;
}

function clampConfidence(c: unknown): number {
  const n = Number(c);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Extraction robuste d'un objet JSON depuis la réponse (tous cas de figure). */
function extractRecommendation(content: string): {
  recommendation: LLMRecommendation;
  confidence: number;
  reasoning: string;
} {
  let obj: unknown;

  // 1) Le contenu entier est déjà du JSON
  try {
    obj = JSON.parse(content);
  } catch {
    obj = null;
  }

  // 2) Extraire le premier bloc JSON {...} du texte (le modèle a pu bavarder)
  if (!obj || typeof obj !== 'object') {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        obj = JSON.parse(content.slice(start, end + 1));
      } catch {
        obj = null;
      }
    }
  }

  if (!obj || typeof obj !== 'object') {
    return { recommendation: 'HOLD', confidence: 0.2, reasoning: 'Réponse non-JSON du modèle' };
  }

  const r = (obj as Record<string, unknown>);
  const rec = String(r.recommendation ?? '').toUpperCase();
  const recommendation: LLMRecommendation =
    rec === 'BUY_YES' || rec === 'BUY_NO' || rec === 'HOLD' ? rec : 'HOLD';
  const confidence = clampConfidence(r.confidence);
  const reasoning = String(r.reasoning ?? '').slice(0, 1200) || 'Pas de justification fournie';

  return { recommendation, confidence, reasoning };
}

// ============================================================================
// Analyse d'un marché (entrée publique)
// ============================================================================

/**
 * Analyse un marché via DeepSeek Flash.
 * JAMAIS de rejet : en cas d'erreur réseau/timeout/JSON/budget → HOLD sûr.
 */
export async function analyzeMarket(
  input: MarketAnalysisInput
): Promise<MarketAnalysisResult> {
  // --- MODE DÉGRADÉ LOCAL (pas de clé / pas activé) ---
  if (!isEnabled()) {
    return hold(
      'DEEPSEEK_ANALYZER_ENABLED non défini ou clé API absente → analyse LLM désactivée (HOLD local).'
    );
  }

  // --- BUDGET QUOTIDIEN ---
  const budget = budgetRemaining();
  if (!budget.ok) {
    return hold(
      `Budget DeepSeek quotidien épuisé (${budget.used}/${budget.max} appels) → HOLD local.`
    );
  }

  // --- Préparation du prompt ---
  const prompt = buildPrompt(input);

  const body = {
    model: model(),
    messages: [
      {
        role: 'system',
        content:
          'Tu es un analyste de marchés prédictifs (Polymarket). ' +
          'Réponds UNIQUEMENT en JSON valide : {"recommendation":"BUY_YES"|"BUY_NO"|"HOLD","confidence":0.0-1.0,"reasoning":"<texte court>"}. ' +
          "Préfère HOLD quand les données sont insuffisantes ou l'edge incertain. Confiance < 0.6 = HOLD.",
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: maxTokens(),
  } as Record<string, unknown>;

  // deepseek-chat accepte response_format json_object (openai-compatible)
  if (supportsJsonObject(model())) {
    body.response_format = { type: 'json_object' };
  }

  const controller = AbortSignal.timeout(timeoutMs());

  let parsed: { recommendation: LLMRecommendation; confidence: number; reasoning: string };
  try {
    const res = await fetch(apiUrl(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey()}`,
            // Session affinity OpenCode (comme Hermes) pour le routage/cache
            'x-opencode-session': sessionId(),
            'HTTP-Referer': 'https://hermes-agent.nousresearch.com',
            'X-Title': 'Hermes Agent',
            'User-Agent': 'HermesAgent/PolymarketPaperbot',
          },
          body: JSON.stringify(body),
          signal: controller,
        });

    if (!res.ok) {
      return hold(`DeepSeek API HTTP ${res.status} → HOLD local.`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    parsed = extractRecommendation(content);
  } catch {
    // timeout réseau ou parse : jamais de crash
    return hold('Erreur réseau/timeout DeepSeek → HOLD local.');
  }

  // Comptabiliser UNIQUEMENT les appels réellement partis sur le réseau
  writeBudget(budget.used + 1);

  // Garde-fou : confiance trop faible → HOLD
  if (parsed.recommendation !== 'HOLD' && parsed.confidence < minConf()) {
    parsed.recommendation = 'HOLD';
    parsed.reasoning = `${parsed.reasoning} [confiance ${parsed.confidence.toFixed(2)} < ${minConf().toFixed(2)} → HOLD par prudence]`;
  }

  return { ...parsed, degraded: false };
}

// ============================================================================
// Helpers internes
// ============================================================================

/** deepseek-chat / deepseek-reasoner acceptent le mode JSON. */
function supportsJsonObject(m: string): boolean {
  return /deepseek/i.test(m);
}

function extractOrderbookFields(ob: Record<string, unknown> | undefined): {
  yesAsk: number;
  yesBid: number;
  noAsk: number;
  noBid: number;
  yesDepth: number;
  noDepth: number;
} {
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const yes = (ob?.yes ?? {}) as Record<string, unknown>;
  const no = (ob?.no ?? {}) as Record<string, unknown>;
  return {
    yesAsk: num(yes.ask),
    yesBid: num(yes.bid),
    noAsk: num(no.ask),
    noBid: num(no.bid),
    yesDepth: num(yes.askDepth ?? yes.bidDepth ?? 0),
    noDepth: num(no.askDepth ?? no.bidDepth ?? 0),
  };
}

function buildPrompt(input: MarketAnalysisInput): string {
  const frags: string[] = [];

  if (input.question) frags.push(`Marché: ${input.question}`);
  frags.push(`Market ID: ${input.marketId}`);

  const ob = extractOrderbookFields(input.orderbook as Record<string, unknown> | undefined);
  if (ob.yesAsk > 0 || ob.yesBid > 0) {
    const spread = input.spreadPct ?? (ob.yesAsk > 0 && ob.yesBid > 0
      ? (ob.yesAsk - ob.yesBid) / ob.yesBid
      : 0);
    const liquidity = input.liquidityUsd ?? Math.max(ob.yesDepth, ob.noDepth);
    frags.push(
      `Orderbook: YES bid=${ob.yesBid.toFixed(3)} ask=${ob.yesAsk.toFixed(3)} | NO bid=${ob.noBid.toFixed(3)} ask=${ob.noAsk.toFixed(3)} | spread=${(spread * 100).toFixed(2)}% | liquidite≈$${liquidity.toFixed(2)}`
    );
  } else if (input.orderbook) {
    frags.push(`Orderbook: ${JSON.stringify(input.orderbook).slice(0, 600)}`);
  }

  if (input.priceHistory && input.priceHistory.length > 0) {
    const recent = input.priceHistory.slice(-20);
    frags.push(
      `Prix recent: ${recent.map((p) => p.price.toFixed(3)).join(', ')}`
    );
  }

  if (input.news) frags.push(`News/Contexte: ${input.news.slice(0, 1000)}`);

  return frags.join('\n');
}