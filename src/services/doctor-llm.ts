/**
 * doctor-llm.ts — diagnostic de la stratégie llm (PAPIER) pour `npm run doctor`.
 *
 * Désactivée (défaut) : une seule ligne. Activée : binaire du CLI à la version FIGÉE, jeton
 * (date d'expiration CALCULÉE affichée, avertissement à ≤ 30 jours, erreur s'il est absent,
 * mal protégé ou expiré), prompts présents, sonde réelle réussie pour la campagne en place,
 * mise à jour automatique du CLI coupée. Lecture seule ; les accès externes sont injectés.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from './doctor.js';
import { loadBotConfig, type Env } from '../bot/config.js';
import { cliBinaryPath, llmPaths } from '../strategy/llm/llm-config.js';
import { campaignOf } from '../strategy/llm/llm-journal.js';
import { tokenPaths, tokenStatus } from '../strategy/llm/token.js';
import { AGENTS_SUBDIR, promptVersion } from '../strategy/llm/prompt-version.js';

const ok = (label: string, detail: string): Check => ({ level: 'ok', label, detail });
const warn = (label: string, detail: string): Check => ({ level: 'warn', label, detail });
const err = (label: string, detail: string): Check => ({ level: 'error', label, detail });

export interface LlmDoctorDeps {
  env: Env;
  /** Dossier personnel (HOME) du compte qui lance le bot. */
  home: string;
  repoDir: string;
  nowMs: number;
  /** Version annoncée par le binaire (`--version`), ou null. */
  readCliVersion: (bin: string) => string | null;
}

const TRUE = ['1', 'true', 'yes', 'on'];
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Mise à jour automatique coupée dans ~/.claude/settings.json (env DISABLE_AUTOUPDATER ou DISABLE_UPDATES) ? */
export function autoUpdateDisabled(home: string): boolean | null {
  const f = join(home, '.claude', 'settings.json');
  if (!existsSync(f)) return false;
  try {
    const s = JSON.parse(readFileSync(f, 'utf8')) as { env?: Record<string, unknown> };
    const v = (k: string) => String(s.env?.[k] ?? '').trim().toLowerCase();
    return TRUE.includes(v('DISABLE_AUTOUPDATER')) || TRUE.includes(v('DISABLE_UPDATES'));
  } catch {
    return null;
  }
}

export function llmChecks(d: LlmDoctorDeps): Check[] {
  const L = 'Stratégie llm';
  const asked = TRUE.includes((d.env.LLM_ENABLED ?? '').trim().toLowerCase());
  const { config } = loadBotConfig({ ...d.env, HOME: d.home });
  const cfg = config.llm;
  if (!asked) return [ok(L, 'désactivée (défaut ; LLM_ENABLED=true pour la brancher)')];
  if (!cfg.enabled) return [err(L, 'LLM_ENABLED=true mais stratégie INDISPONIBLE : voir l\'avertissement de configuration ci-dessus (version du CLI, échéance)')];

  const out: Check[] = [];
  // CLI figé
  const bin = cliBinaryPath(cfg, d.home) as string;
  const v = existsSync(bin) ? d.readCliVersion(bin) : null;
  if (v === cfg.cliVersion) out.push(ok('llm — CLI', `${bin} → ${v} (version figée)`));
  else out.push(err('llm — CLI', `${bin} ${existsSync(bin) ? `annonce ${v ?? 'rien'}` : 'introuvable'} au lieu de ${cfg.cliVersion} : installer cette version (curl -fsSL https://claude.ai/install.sh | bash -s ${cfg.cliVersion}) ou corriger LLM_CLI_VERSION / LLM_CLI_PATH`));
  const au = autoUpdateDisabled(d.home);
  if (au === true) out.push(ok('llm — mises à jour du CLI', 'automatiques coupées (~/.claude/settings.json)'));
  else out.push(warn('llm — mises à jour du CLI', `${au === null ? '~/.claude/settings.json illisible' : 'mise à jour automatique ACTIVE'} : la version figée peut être supprimée après deux mises à jour → ajouter "env": {"DISABLE_AUTOUPDATER": "1"} dans ~/.claude/settings.json`));

  // Jeton : date d'expiration calculée (enregistrement + 1 an), alerte à 30 jours
  const tp = tokenPaths(join(d.home, '.polymarket', 'llm'));
  const ts = tokenStatus(tp, d.nowMs);
  const exp = ts.expiresAt ? `expire le ${day(ts.expiresAt)}${ts.daysLeft !== null ? ` (dans ${ts.daysLeft} j)` : ''}, date calculée : enregistrement + 1 an` : 'date d\'expiration inconnue';
  if (ts.state === 'ok') out.push(ok('llm — jeton', exp));
  else if (ts.state === 'expire_bientot') out.push(warn('llm — jeton', `${exp} — renouveler : claude setup-token, puis npm run llm:token`));
  else out.push(err('llm — jeton', /setup-token/.test(ts.detail) ? ts.detail : `${ts.detail} (nouveau jeton : claude setup-token)`));

  // Prompts et sonde réelle de la campagne
  let pv: string | null = null;
  try { pv = promptVersion(join(d.repoDir, 'agents-runtime', AGENTS_SUBDIR)); } catch (e) {
    out.push(err('llm — prompts', `définitions d'agents illisibles (${(e as Error).message})`));
  }
  if (pv) out.push(ok('llm — prompts', pv));
  if (pv && v === cfg.cliVersion) {
    const campaign = campaignOf(v, pv);
    const f = join(llmPaths(config.dataDir).probe, `${campaign}.json`);
    let probe: { ok?: unknown; at?: unknown; latencyMs?: { p50?: unknown; max?: unknown } } | null = null;
    try { probe = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; } catch { probe = null; }
    if (probe?.ok === true) {
      const s = (x: unknown) => (typeof x === 'number' ? `${(x / 1000).toFixed(1)} s` : '—');
      out.push(ok('llm — sonde', `réussie (${String(probe.at ?? '?')}) · latence médiane ${s(probe.latencyMs?.p50)}, max ${s(probe.latencyMs?.max)} · campagne ${campaign}`));
    } else {
      out.push(warn('llm — sonde', `${probe ? 'en échec' : 'absente'} pour la campagne ${campaign} : lancer npm run llm:probe (vrais appels) — /llm on est refusé d'ici là`));
    }
  }
  return out;
}
