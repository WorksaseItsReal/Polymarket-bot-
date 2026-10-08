/**
 * doctor.ts — diagnostic d'installation (`npm run doctor`) : ce qui empêcherait le bot de
 * mesurer ou de parier, dit en clair, AVANT de le découvrir après des jours de papier.
 *
 * Trois familles : configuration (.env), fichiers (registre, arrêt de sécurité, interface
 * du dashboard), réseau (Gamma, carnet CLOB, Binance, horloge). Fonctions testables :
 * l'environnement, les chemins et `fetch` sont injectés.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fairValueConfigFromEnv, DEFAULT_FAIR_VALUE_CONFIG } from './fair-value.js';
import { looksLikeBotToken, telegramConfigFromEnv } from './telegram.js';
import { computeStats, readLedgerShared } from './paper-ledger.js';
import { parseRoundTokens, roundSlug, slotStart } from './round-discovery.js';
import { crashSummary } from './crash-guard.js';

export type Level = 'ok' | 'warn' | 'error';
export interface Check {
  level: Level;
  label: string;
  detail: string;
}

type Env = Record<string, string | undefined>;
const ok = (label: string, detail: string): Check => ({ level: 'ok', label, detail });
const warn = (label: string, detail: string): Check => ({ level: 'warn', label, detail });
const err = (label: string, detail: string): Check => ({ level: 'error', label, detail });

const positive = (env: Env, ...keys: string[]) => {
  for (const k of keys) {
    const v = Number(env[k] ?? '');
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
};

/** Mêmes FV_* que lus par le bot ; ceux qui sont ignorés (hors bornes, illisibles). */
const FV_ENV: Array<[string, keyof typeof DEFAULT_FAIR_VALUE_CONFIG]> = [
  ['FV_MIN_EDGE', 'minEdge'], ['FV_MIN_PROB', 'minProb'], ['FV_MIN_TAU_SEC', 'minTauSec'], ['FV_MAX_TAU_SEC', 'maxTauSec'],
  ['FV_MIN_ASK', 'minAsk'], ['FV_MAX_ASK', 'maxAsk'], ['FV_Z_SCALE', 'zScale'], ['FV_BLEND_MODEL', 'blendModel'],
  ['FV_BLEND_MARKET', 'blendMarket'], ['FV_TAKER_FEE_RATE', 'takerFeeRate'], ['FV_BASIS_BPS', 'basisBps'],
  ['FV_STRIKE_NOISE_SEC', 'strikeNoiseSec'], ['FV_TWAP_WINDOW_SEC', 'twapWindowSec'],
];

/**
 * Forme de POLYMARKET_PRIVATE_KEY, décrite SANS jamais la citer. En papier elle ne sert à
 * rien (clé éphémère) ; une faute de frappe passerait sinon inaperçue jusqu'au réel.
 */
function walletKeyCheck(raw: string | undefined, paper: boolean): Check {
  const label = 'Clé du wallet';
  const v = raw ?? '';
  if (!v.trim() || /^(your_|0x\.\.\.|xxx)/i.test(v.trim())) {
    return paper ? ok(label, 'absente : normal en papier (obligatoire en réel)') : err(label, 'absente : obligatoire en réel');
  }
  const t = v.trim();
  const hex = t.replace(/^0x/i, '');
  const problems: string[] = [];
  if (t !== v) problems.push('espaces avant/après (à retirer)');
  const bad = hex.replace(/[0-9a-fA-F]/g, '').length;
  if (bad) problems.push(`${bad} caractère(s) non hexadécimal(aux) (ex. « O » au lieu de « 0 »)`);
  if (hex.length !== 64) problems.push(`${hex.length} caractères au lieu de 64`);
  if (!problems.length || (problems.length === 1 && t !== v)) {
    const note = t !== v ? ' (espaces autour ignorés)' : '';
    return ok(label, paper ? `présente, bonne forme${note} ; en papier elle ne signe rien (clé éphémère)` : `présente, bonne forme${note}`);
  }
  const msg = `mal formée : ${problems.join(', ')}`;
  return paper ? warn(label, `${msg} — sans effet en papier, bloquante en réel`) : err(label, msg);
}

export function configChecks(env: Env): Check[] {
  const out: Check[] = [];
  const paper = (env.DRY_RUN ?? '').trim().toLowerCase() !== 'false';
  out.push(paper ? ok('Mode', 'PAPIER (DRY_RUN) : aucun ordre réel') : err('Mode', 'DRY_RUN=false : mode RÉEL. La stratégie juste valeur n\'envoie aucun ordre, mais les autres stratégies activées le peuvent.'));

  const capital = paper ? positive(env, 'PAPER_CAPITAL', 'CAPITAL_USD') ?? 50 : positive(env, 'CAPITAL_USD') ?? 250;
  const minOrderRaw = (env.FV_MIN_ORDER_USD ?? '').trim();
  // même lecture que le bot (bot-with-dashboard.ts) : [0 ; 100], sinon 1
  const minOrder = minOrderRaw !== '' && Number.isFinite(Number(minOrderRaw)) && Number(minOrderRaw) >= 0 && Number(minOrderRaw) <= 100
    ? Number(minOrderRaw) : 1;
  const maxStake = capital * 0.01;
  out.push(minOrder > 0 && maxStake < minOrder
    ? err('Capital', `${capital} $ : mise max ${maxStake.toFixed(2)} $ (1 %) < minimum Polymarket ${minOrder} $ → AUCUN pari. Mettre PAPER_CAPITAL=250.`)
    : minOrder > 0 && maxStake < 2 * minOrder
      ? warn('Capital', `${capital} $ : mise max ${maxStake.toFixed(2)} $, à peine au-dessus du minimum ${minOrder} $ — 250 $ recommandé.`)
      : ok('Capital', `${capital} $ (mise max ${maxStake.toFixed(2)} $ par pari)`));

  out.push(walletKeyCheck(env.POLYMARKET_PRIVATE_KEY, paper));

  const legacy = ['DIPARB_ENABLED', 'SMARTMONEY_ENABLED', 'ARBITRAGE_ENABLED', 'TREND_ANALYSIS_ENABLED'].filter(k => env[k] === 'true');
  out.push(legacy.length
    ? warn('Anciennes stratégies', `${legacy.join(', ')} activé(s) : elles tournent en parallèle (requêtes, compteurs du dashboard). Les mettre à false sauf besoin précis.`)
    : ok('Anciennes stratégies', 'désactivées'));

  const tg = telegramConfigFromEnv(env);
  if (!tg) out.push(warn('Telegram', 'non configuré (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) : aucune notification.'));
  else if (!looksLikeBotToken(tg.token)) out.push(err('Telegram', 'TELEGRAM_BOT_TOKEN ne ressemble pas à un token @BotFather (123456789:ABC…).'));
  else out.push(ok('Telegram', 'configuré (connexion testée plus bas)'));

  const host = env.DASHBOARD_HOST || '127.0.0.1';
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
  out.push(!local && !env.DASHBOARD_TOKEN
    ? warn('Dashboard', `DASHBOARD_HOST=${host} sans DASHBOARD_TOKEN : le dashboard se repliera sur 127.0.0.1 (tunnel SSH pour y accéder).`)
    : ok('Dashboard', local ? `local (${host})` : `exposé sur ${host}, protégé par jeton`));

  const cfg = fairValueConfigFromEnv(env);
  out.push(botSettingsCheck(env, cfg.minEdge));
  const tails = env.FV_TAILS?.trim();
  const ignoredTails = tails && tails !== 'normal' && tails !== 't4' ? [`FV_TAILS=${tails} (attendu : normal ou t4)`] : [];
  const ignored = [...ignoredTails, ...FV_ENV.filter(([k, f]) => {
    const raw = env[k];
    if (raw === undefined || raw.trim() === '') return false;
    return Number(raw) !== (cfg[f] as number);
  }).map(([k]) => `${k}=${env[k]}`)];
  out.push(ignored.length
    ? warn('Réglages FV', `ignorés (hors bornes ou illisibles, valeur par défaut utilisée) : ${ignored.join(', ')}`)
    : ok('Réglages FV', `edge ≥ ${cfg.minEdge}, p ≥ ${cfg.minProb}, τ ∈ [${cfg.minTauSec}, ${cfg.maxTauSec}] s, confiance ×${cfg.zScale}, mélange ${cfg.blendModel}/${cfg.blendMarket}`));
  return out;
}

/**
 * Réglages lus par bot-with-dashboard.ts (mêmes bornes et mêmes défauts) : une valeur hors
 * bornes est ramenée ou ignorée SANS message côté bot — on le dit ici.
 */
function botSettingsCheck(env: Env, minEdge: number): Check {
  const notes: string[] = [];
  const raw = (k: string) => (env[k] ?? '').trim();
  const clampNote = (k: string, lo: number, hi: number, def: number) => {
    const r = raw(k);
    if (r === '') return;
    const v = Number(r) || def;
    const eff = Math.min(hi, Math.max(lo, v));
    if (!Number.isFinite(Number(r)) || eff !== Number(r)) notes.push(`${k}=${r} → ${eff} (bornes ${lo}–${hi})`);
  };
  clampNote('FV_POLL_SEC', 5, 300, 10);
  clampNote('FV_MOVE_BPS', 1, 50, 3);
  clampNote('TELEGRAM_SUMMARY_MIN', 15, 1440, 60);
  clampNote('FV_JOURNAL_KEEP_DAYS', 1, 365, 30);
  const delay = raw('FV_FILL_DELAY_MS');
  if (delay !== '') {
    const v = Number(delay);
    if (!(Number.isFinite(v) && v >= 0 && v <= 10_000)) notes.push(`FV_FILL_DELAY_MS=${delay} ignoré → 1000`);
    else if (v === 0) notes.push('FV_FILL_DELAY_MS=0 : aucune latence simulée, le papier sera plus optimiste que le réel');
  }
  const exit = raw('FV_EXIT_EDGE');
  if (exit !== '') {
    const v = Number(exit);
    if (!(Number.isFinite(v) && v >= 0 && v <= 0.5)) notes.push(`FV_EXIT_EDGE=${exit} ignoré → ${minEdge}`);
  }
  const coins = raw('FV_COINS');
  if (coins !== '') {
    const known = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
    const wanted = coins.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    const unknown = wanted.filter(c => !known.includes(c));
    if (unknown.length) notes.push(`FV_COINS : ${unknown.join(', ')} inconnu(s), ignoré(s)`);
    if (!wanted.some(c => known.includes(c))) notes.push('FV_COINS sans crypto valide → les 5 sont tradées');
  }
  return notes.length ? warn('Réglages du bot', notes.join(' ; ')) : ok('Réglages du bot', 'valeurs reconnues');
}

export function fileChecks(polyDir: string, repoDir: string, nowMs = Date.now()): Check[] {
  const out: Check[] = [];
  const ledgerPath = join(polyDir, 'fv-ledger.json');
  const trades = readLedgerShared(ledgerPath);
  if (trades === null) out.push(err('Registre', `${ledgerPath} illisible : le bot n'ouvrira aucune position (fichier préservé ; le réparer ou l'archiver).`));
  else {
    const st = computeStats(trades);
    out.push(ok('Registre', existsSync(ledgerPath) ? `${st.n} trades réglés, ${st.open} en cours, PnL ${st.pnl.toFixed(2)} $` : 'pas encore créé (normal au premier lancement)'));
  }
  const guard = join(polyDir, 'fv-guard.json');
  out.push(existsSync(guard)
    ? err('Arrêt de sécurité', `${guard} présent : nouvelles entrées BLOQUÉES (perte significative constatée). Analyser, puis supprimer ce fichier et redémarrer.`)
    : ok('Arrêt de sécurité', 'aucun'));
  const crashes = crashSummary(join(polyDir, 'run-state.json'), nowMs);
  out.push(crashes.last24h
    ? warn('Plantages', `${crashes.last24h} arrêt(s) anormal(aux) en 24 h, dernier il y a ${Math.round((nowMs - (crashes.lastAt as number)) / 60_000)} min : voir paperbot.error.log`)
    : ok('Plantages', 'aucun arrêt anormal en 24 h'));
  out.push(existsSync(join(repoDir, 'dashboard', 'dist', 'index.html'))
    ? ok('Interface du dashboard', 'construite')
    : warn('Interface du dashboard', 'non construite : (cd dashboard && npm install && npm run build)'));
  const jdir = join(polyDir, 'journal');
  if (existsSync(jdir)) {
    let bytes = 0;
    let files = 0;
    for (const f of readdirSync(jdir)) {
      if (!/^decisions-/.test(f)) continue;
      files++;
      try { bytes += statSync(join(jdir, f)).size; } catch { /* fichier disparu */ }
    }
    out.push(ok('Journal des décisions', `${files} fichier(s), ${(bytes / 1e6).toFixed(1)} Mo`));
  } else {
    out.push(warn('Journal des décisions', 'pas encore créé (normal avant le premier passage ; sinon vérifier FV_JOURNAL)'));
  }
  return out;
}

async function get(
  fetchImpl: typeof fetch, url: string, timeoutMs: number, clock: () => number = Date.now,
): Promise<{ status: number; body: unknown; date: string | null; sentAt: number; receivedAt: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sentAt = clock();
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const receivedAt = clock();
    let body: unknown = null;
    try { body = await res.json(); } catch { /* pas du JSON */ }
    return { status: res.status, body, date: res.headers.get('date'), sentAt, receivedAt };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Accès aux API publiques utilisées par la stratégie, et décalage d'horloge. */
export async function networkChecks(
  fetchImpl: typeof fetch, nowMs: number, timeoutMs = 6000, clock: () => number = () => nowMs,
): Promise<Check[]> {
  const out: Check[] = [];
  const slot = slotStart(nowMs);
  const slug = roundSlug('BTC', slot);
  const g = await get(fetchImpl, `https://gamma-api.polymarket.com/events?slug=${slug}`, timeoutMs);
  let upToken: string | null = null;
  if (!g) out.push(err('Polymarket Gamma', 'injoignable : ni découverte des rounds ni règlement possibles (réseau, DNS, pare-feu ?)'));
  else if (g.status !== 200) out.push(err('Polymarket Gamma', `HTTP ${g.status}`));
  else {
    upToken = parseRoundTokens(g.body, 'BTC', slug)?.upTokenId ?? null;
    out.push(upToken ? ok('Polymarket Gamma', `round en cours trouvé (${slug})`) : warn('Polymarket Gamma', `joignable, mais ${slug} pas (encore) listé — réessayer dans une minute`));
  }
  if (upToken) {
    const b = await get(fetchImpl, `https://clob.polymarket.com/book?token_id=${upToken}`, timeoutMs);
    out.push(!b ? err('Carnet CLOB', 'injoignable : aucune évaluation possible')
      : b.status === 200 ? ok('Carnet CLOB', 'carnet du round lu') : err('Carnet CLOB', `HTTP ${b.status}`));
  }
  let binance: { date: string | null; sentAt: number; receivedAt: number } | null = null;
  const main = await get(fetchImpl, 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1', timeoutMs, clock);
  if (main?.status === 200) {
    binance = main;
    out.push(ok('Binance', 'api.binance.com joignable'));
  } else {
    const vision = await get(fetchImpl, 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1', timeoutMs, clock);
    if (vision?.status === 200) {
      binance = vision;
      out.push(warn('Binance', `api.binance.com ${main ? `HTTP ${main.status}${main.status === 451 ? ' (pays bloqué)' : ''}` : 'injoignable'} : repli binance.vision OK (le bot l'utilise automatiquement)`));
    } else {
      out.push(err('Binance', 'ni api.binance.com ni binance.vision : spot dégradé (repli Coinbase), à corriger'));
    }
  }
  if (binance?.date) {
    // Décalage mesuré AUTOUR de cette requête (pas depuis le début du diagnostic : les
    // délais réseau précédents passaient pour un décalage). L'en-tête Date est tronqué à la
    // seconde : le serveur a répondu entre Date et Date + 1 s.
    const server = Date.parse(binance.date) + 500;
    const local = (binance.sentAt + binance.receivedAt) / 2;
    const slack = (binance.receivedAt - binance.sentAt) / 2 + 500;
    const skew = Math.abs(server - local) <= slack ? 0 : server - local - Math.sign(server - local) * slack;
    const central = server - local; // estimation centrale (le bot alerte au-delà de 2 s)
    if (Math.abs(skew) <= 3000 && Math.abs(central) > 2000) {
      out.push(warn('Horloge', `décalage probable d'environ ${(central / 1000).toFixed(1)} s (incertitude ±${(slack / 1000).toFixed(1)} s) : vérifier NTP (timedatectl)`));
      return out;
    }
    out.push(Math.abs(skew) > 3000
      ? err('Horloge', `décalée d'environ ${(skew / 1000).toFixed(0)} s : le temps restant des rounds est faux → activer NTP (timedatectl set-ntp true)`)
      : ok('Horloge', `à l'heure (écart estimé ${(central / 1000).toFixed(1)} s, incertitude ±${(slack / 1000).toFixed(1)} s)`));
  }
  return out;
}

export function summarize(checks: Check[]): { text: string; errors: number; warnings: number } {
  const icon = { ok: '✅', warn: '⚠️ ', error: '❌' } as const;
  const text = checks.map(c => `${icon[c.level]} ${c.label.padEnd(24)} ${c.detail}`).join('\n');
  return { text, errors: checks.filter(c => c.level === 'error').length, warnings: checks.filter(c => c.level === 'warn').length };
}
