/**
 * Configuration du bot papier « Up or Down 5 min » — lue UNE fois, au même endroit, par le
 * bot et par le diagnostic (`npm run doctor`). Avant : chaque variable était relue à sa
 * façon dans le point d'entrée, et le doctor devait en recopier les règles.
 *
 * Toute valeur absente ou invalide garde son défaut et produit un AVERTISSEMENT lisible
 * (jamais un 0 silencieux) : `warnings` est affiché au démarrage et par le doctor.
 *
 * Module PUR : aucune I/O, aucune horloge.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fairValueConfigFromEnv, type FairValueConfig } from '../services/fair-value.js';
import { STRATEGY_COINS, coinsFromEnv, type StrategyCoin } from '../strategy/fair-value-runner.js';
import { isValidTimeZone } from '../services/telegram-messages.js';
import { looksLikeBotToken, telegramConfigFromEnv } from '../services/telegram.js';

export type Env = Record<string, string | undefined>;

/** Parts minimales d'un ordre Polymarket : en dessous, une revente anticipée n'est pas exécutable. */
export const MIN_SELL_SHARES = 5;

/** Limites de perte de la porte de risque (fractions du capital de départ). */
export interface RiskLimits {
  /** Perte du jour calendaire (UTC) : plus d'entrée jusqu'à minuit UTC. */
  dailyMaxLossPct: number;
  /** Perte du mois calendaire (UTC) : plus d'entrée jusqu'au 1er du mois suivant. */
  monthlyMaxLossPct: number;
  /** Baisse depuis le plus haut : plus d'entrée jusqu'à décision manuelle. */
  maxDrawdownFromPeak: number;
  /** Perte totale : arrêt définitif des entrées. */
  totalMaxLossPct: number;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  dailyMaxLossPct: 0.05,
  monthlyMaxLossPct: 0.15,
  maxDrawdownFromPeak: 0.25,
  totalMaxLossPct: 0.40,
};

export interface BotConfig {
  /** DRY_RUN tel que lu (`false` = demande de mode réel, que ce bot REFUSE : non implémenté). */
  dryRun: boolean;
  /** Capital papier de référence (USDC). */
  capital: number;
  fv: FairValueConfig;
  /** Marge de revente anticipée (bid net − p_modèle). Défaut : FV_MIN_EDGE. */
  exitEdge: number;
  /** Passage régulier de la stratégie (ms). */
  pollMs: number;
  /** Mouvement du spot (points de base) qui déclenche une évaluation immédiate. */
  moveBps: number;
  coins: readonly StrategyCoin[];
  /** Achat minimal accepté par Polymarket (USDC) ; 0 = pas de contrôle. */
  minOrderUsd: number;
  /** Latence d'exécution simulée (ms) : le carnet est relu après ce délai. */
  fillDelayMs: number;
  /** Flux spot temps réel (WebSocket Binance) ; sinon REST seul. */
  spotStream: boolean;
  journal: { enabled: boolean; keepDays: number };
  risk: RiskLimits;
  /** Au-delà de ce décalage d'horloge (ms), τ est trop faux : entrées bloquées. */
  maxClockSkewMs: number;
  telegram: { token: string; chatId: string } | null;
  /** Période du bilan Telegram (min). */
  summaryEveryMin: number;
  /** Répondre aux commandes Telegram (/status, /bilan…) du chat configuré. */
  telegramCommands: boolean;
  timeZone: string;
  dashboard: { port: number; host: string; token: string | null };
  /** Délai HTTP par défaut (ms) pour axios (carnets CLOB). */
  httpTimeoutMs: number;
  /** Dossier d'état (~/.polymarket) : registre, journal, mesure, garde-fous. */
  dataDir: string;
}

/** Nombre dans [lo, hi], sinon défaut + avertissement. `''` ou absent = défaut sans bruit. */
function num(env: Env, key: string, def: number, lo: number, hi: number, warnings: string[]): number {
  const raw = (env[key] ?? '').trim();
  if (raw === '') return def;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= lo && v <= hi) return v;
  warnings.push(`${key}=${raw} ignoré (attendu : nombre entre ${lo} et ${hi}) — valeur par défaut ${def}`);
  return def;
}

function bool(env: Env, key: string, def: boolean, warnings: string[]): boolean {
  const raw = (env[key] ?? '').trim().toLowerCase();
  if (raw === '') return def;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  warnings.push(`${key}=${raw} ignoré (attendu : true ou false) — valeur par défaut ${def}`);
  return def;
}

/** Même règle que partout dans le projet : réel UNIQUEMENT si DRY_RUN=false. */
export function isDryRun(env: Env): boolean {
  return (env.DRY_RUN ?? '').trim().toLowerCase() !== 'false';
}

export function loadBotConfig(env: Env = process.env): { config: BotConfig; warnings: string[] } {
  const warnings: string[] = [];
  const dryRun = isDryRun(env);

  // Capital de référence UNIQUE : PAPER_CAPITAL, sinon CAPITAL_USD, sinon 50 $ (le doctor
  // avertit sous 100 $ : la mise de 1 % n'atteint pas le minimum Polymarket).
  // Le repli est calculé d'abord pour que l'avertissement d'un PAPER_CAPITAL invalide cite la
  // valeur réellement utilisée (CAPITAL_USD ou 50), pas « 0 ».
  const capital = num(env, 'PAPER_CAPITAL', num(env, 'CAPITAL_USD', 50, 0.01, 1e9, warnings), 0.01, 1e9, warnings);

  const fv = fairValueConfigFromEnv(env);
  // Les FV_* invalides sont ramenés au défaut par fairValueConfigFromEnv : on le dit.
  for (const [key, field, lo, hi] of [
    ['FV_MIN_EDGE', 'minEdge', 0, 0.5], ['FV_NOISE_EDGE_K', 'noiseEdgeK', 0, 5], ['FV_MIN_PROB', 'minProb', 0, 0.99],
    ['FV_MIN_TAU_SEC', 'minTauSec', 0, 300], ['FV_MAX_TAU_SEC', 'maxTauSec', 0, 300], ['FV_MIN_ASK', 'minAsk', 0.01, 0.99],
    ['FV_MAX_ASK', 'maxAsk', 0.01, 0.99], ['FV_Z_SCALE', 'zScale', 0.3, 2], ['FV_BLEND_MODEL', 'blendModel', 0, 3],
    ['FV_BLEND_MARKET', 'blendMarket', 0, 3], ['FV_TAKER_FEE_RATE', 'takerFeeRate', 0, 0.5], ['FV_BASIS_BPS', 'basisBps', 0, 100],
    ['FV_STRIKE_NOISE_SEC', 'strikeNoiseSec', 0, 120], ['FV_TWAP_WINDOW_SEC', 'twapWindowSec', 0, 60],
  ] as const) {
    const raw = (env[key] ?? '').trim();
    if (raw !== '' && Number(raw) !== fv[field]) {
      warnings.push(`${key}=${raw} ignoré (attendu : nombre entre ${lo} et ${hi}, fenêtre τ non vide) — valeur utilisée ${fv[field]}`);
    }
  }
  const tails = (env.FV_TAILS ?? '').trim();
  if (tails && tails !== 'normal' && tails !== 't4') warnings.push(`FV_TAILS=${tails} ignoré (attendu : normal ou t4) — normal`);
  const ve = (env.FV_VOL_ESTIMATOR ?? '').trim();
  if (ve && !['cc', 'parkinson', 'blend'].includes(ve)) warnings.push(`FV_VOL_ESTIMATOR=${ve} ignoré (attendu : cc, parkinson ou blend) — cc`);
  const lm = (env.FV_LATE_MEASURE ?? '').trim().toLowerCase();
  if (lm && lm !== 'true' && lm !== 'false') warnings.push(`FV_LATE_MEASURE=${lm} ignoré (attendu : true ou false) — true`);

  const coinsRaw = (env.FV_COINS ?? '').trim();
  const coins = coinsFromEnv(coinsRaw);
  const asked = coinsRaw ? coinsRaw.split(',').map(c => c.trim().toUpperCase()).filter(Boolean) : [];
  const unknown = asked.filter(c => !(STRATEGY_COINS as readonly string[]).includes(c));
  if (unknown.length) {
    // Chaque coin inconnu est nommé (avant : silence tant qu'un coin au moins était reconnu).
    warnings.push(`FV_COINS=${coinsRaw} : ${unknown.join(', ')} inconnu${unknown.length > 1 ? 's' : ''} (coins possibles : ${STRATEGY_COINS.join(', ')})`
      + (asked.length === unknown.length ? ' — les 5 sont utilisés' : ` — coins utilisés : ${coins.join(', ')}`));
  }

  const tz = (env.TELEGRAM_TZ ?? '').trim() || 'Europe/Paris';
  const timeZone = isValidTimeZone(tz) ? tz : 'Europe/Paris';
  if (timeZone !== tz) warnings.push(`TELEGRAM_TZ=${tz} n'est pas un fuseau valide — Europe/Paris`);

  // Port : entier obligatoire (server.listen(3001.5) lève de façon synchrone, pas via 'error').
  let port = num(env, 'DASHBOARD_PORT', 3001, 1, 65535, warnings);
  if (!Number.isInteger(port)) {
    warnings.push(`DASHBOARD_PORT=${(env.DASHBOARD_PORT ?? '').trim()} ignoré (attendu : entier entre 1 et 65535) — valeur par défaut 3001`);
    port = 3001;
  }

  const telegram = telegramConfigFromEnv(env);
  if (telegram && !looksLikeBotToken(telegram.token)) {
    warnings.push('TELEGRAM_BOT_TOKEN ne ressemble pas à un token @BotFather (123456789:ABC…) : la connexion échouera');
  }

  // Limites de perte : réglables, mais une hiérarchie absurde (mois < jour, total < baisse)
  // rendrait une couche inerte sans qu'on le voie → défauts.
  const risk: RiskLimits = {
    dailyMaxLossPct: num(env, 'DAILY_MAX_LOSS_PCT', DEFAULT_RISK_LIMITS.dailyMaxLossPct, 0.005, 0.9, warnings),
    monthlyMaxLossPct: num(env, 'MONTHLY_MAX_LOSS_PCT', DEFAULT_RISK_LIMITS.monthlyMaxLossPct, 0.005, 0.9, warnings),
    maxDrawdownFromPeak: num(env, 'MAX_DRAWDOWN_PCT', DEFAULT_RISK_LIMITS.maxDrawdownFromPeak, 0.01, 0.9, warnings),
    totalMaxLossPct: num(env, 'TOTAL_MAX_LOSS_PCT', DEFAULT_RISK_LIMITS.totalMaxLossPct, 0.01, 0.95, warnings),
  };
  if (!(risk.dailyMaxLossPct <= risk.monthlyMaxLossPct && risk.monthlyMaxLossPct <= risk.totalMaxLossPct && risk.maxDrawdownFromPeak <= risk.totalMaxLossPct)) {
    warnings.push(`limites de perte incohérentes (jour ${risk.dailyMaxLossPct} ≤ mois ${risk.monthlyMaxLossPct} ≤ totale ${risk.totalMaxLossPct}, baisse ${risk.maxDrawdownFromPeak} ≤ totale attendus) — défauts utilisés`);
    Object.assign(risk, DEFAULT_RISK_LIMITS);
  }

  const host = (env.DASHBOARD_HOST ?? '').trim() || '127.0.0.1';
  const token = (env.DASHBOARD_TOKEN ?? '').trim() || null;

  const config: BotConfig = {
    dryRun,
    capital,
    fv,
    exitEdge: num(env, 'FV_EXIT_EDGE', fv.minEdge, 0, 0.5, warnings),
    pollMs: num(env, 'FV_POLL_SEC', 10, 5, 300, warnings) * 1000,
    moveBps: num(env, 'FV_MOVE_BPS', 3, 1, 50, warnings),
    coins,
    minOrderUsd: num(env, 'FV_MIN_ORDER_USD', 1, 0, 100, warnings),
    fillDelayMs: num(env, 'FV_FILL_DELAY_MS', 1000, 0, 10_000, warnings),
    spotStream: bool(env, 'FV_SPOT_STREAM', true, warnings),
    journal: { enabled: bool(env, 'FV_JOURNAL', true, warnings), keepDays: num(env, 'FV_JOURNAL_KEEP_DAYS', 30, 1, 365, warnings) },
    risk,
    maxClockSkewMs: 5000,
    telegram,
    summaryEveryMin: num(env, 'TELEGRAM_SUMMARY_MIN', 60, 15, 24 * 60, warnings),
    telegramCommands: bool(env, 'TELEGRAM_COMMANDS', true, warnings),
    timeZone,
    dashboard: { port, host, token },
    httpTimeoutMs: num(env, 'HTTP_TIMEOUT_MS', 10_000, 1000, 120_000, warnings),
    dataDir: join((env.HOME ?? '').trim() || homedir(), '.polymarket'),
  };
  return { config, warnings };
}

/** Plafond de mise (1 % du capital) face au minimum d'ordre Polymarket : avertissement, ou null. */
export function capitalWarning(c: Pick<BotConfig, 'capital' | 'minOrderUsd'>, maxStakePct: number): string | null {
  const maxStake = c.capital * maxStakePct;
  if (!(c.minOrderUsd > 0)) return null;
  if (maxStake < c.minOrderUsd) {
    return `capital papier ${c.capital} $ : mise max ${maxStake.toFixed(2)} $ (${(maxStakePct * 100).toFixed(0)} %) < minimum Polymarket ${c.minOrderUsd} $ — aucun pari ne sera pris. Monter PAPER_CAPITAL (≥ 250 $ recommandé).`;
  }
  if (maxStake < 2 * c.minOrderUsd) {
    return `capital papier ${c.capital} $ : mise max ${maxStake.toFixed(2)} $, à peine au-dessus du minimum Polymarket ${c.minOrderUsd} $ — la moindre perte (ou réduction après drawdown) bloquera les paris. 250 $ recommandé.`;
  }
  return null;
}

/** Chemins des fichiers d'état, tous sous `dataDir`. */
export function dataPaths(dataDir: string) {
  return {
    ledger: join(dataDir, 'fv-ledger.json'),
    guard: join(dataDir, 'fv-guard.json'),
    shadow: join(dataDir, 'fv-shadow.json'),
    runState: join(dataDir, 'run-state.json'),
    journalDir: join(dataDir, 'journal'),
  };
}
