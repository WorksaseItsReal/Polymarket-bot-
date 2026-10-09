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
import { entryMinTauSec } from './fair-value.js';
import { MAX_VARIANCE_PCT } from './stake-sizing.js';
import { computeStats, readLedgerShared } from './paper-ledger.js';
import { parseRoundTokens, roundSlug, slotStart } from './round-discovery.js';
import { crashSummary } from './crash-guard.js';
import { capitalWarning, loadBotConfig, type Env } from '../bot/config.js';

export type Level = 'ok' | 'warn' | 'error';
export interface Check {
  level: Level;
  label: string;
  detail: string;
}

const ok = (label: string, detail: string): Check => ({ level: 'ok', label, detail });
const warn = (label: string, detail: string): Check => ({ level: 'warn', label, detail });
const err = (label: string, detail: string): Check => ({ level: 'error', label, detail });

/**
 * Configuration : la MÊME lecture que le bot (src/bot/config.ts), donc les mêmes valeurs
 * effectives et les mêmes avertissements — rien n'est recopié ici.
 */
export function configChecks(env: Env): Check[] {
  const out: Check[] = [];
  const { config: c, warnings } = loadBotConfig(env);
  out.push(c.dryRun
    ? ok('Mode', 'PAPIER (DRY_RUN) : aucun ordre réel')
    : err('Mode', 'DRY_RUN=false : le mode RÉEL n\'est pas implémenté, le bot refusera de démarrer. Retirer DRY_RUN=false.'));

  const capWarn = capitalWarning(c, MAX_VARIANCE_PCT);
  out.push(capWarn
    ? (/aucun pari/.test(capWarn) ? err('Capital', capWarn) : warn('Capital', capWarn))
    : ok('Capital', `${c.capital} $ (mise max ${(c.capital * MAX_VARIANCE_PCT).toFixed(2)} $ par pari)`));

  const legacy = ['DIPARB_ENABLED', 'SMARTMONEY_ENABLED', 'ARBITRAGE_ENABLED', 'TREND_ANALYSIS_ENABLED', 'DEEPSEEK_ANALYZER_ENABLED', 'POLYMARKET_PRIVATE_KEY']
    .filter(k => (env[k] ?? '').trim() !== '' && (env[k] ?? '').trim() !== 'your_private_key_here');
  if (legacy.length) out.push(warn('Variables obsolètes', `${legacy.join(', ')} : sans effet depuis la reconstruction (plus de stratégie héritée, de LLM ni de wallet dans le bot) — à retirer du .env.`));

  out.push(!c.telegram
    ? warn('Telegram', 'non configuré (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) : aucune notification.')
    : warnings.some(w => w.startsWith('TELEGRAM_BOT_TOKEN'))
      ? err('Telegram', 'TELEGRAM_BOT_TOKEN ne ressemble pas à un token @BotFather (123456789:ABC…).')
      : ok('Telegram', 'configuré (connexion testée plus bas)'));

  const local = ['127.0.0.1', '::1', 'localhost'].includes(c.dashboard.host);
  out.push(!local && !c.dashboard.token
    ? warn('Dashboard', `DASHBOARD_HOST=${c.dashboard.host} sans DASHBOARD_TOKEN : le dashboard se repliera sur 127.0.0.1 (tunnel SSH pour y accéder).`)
    : ok('Dashboard', local ? `local (${c.dashboard.host})` : `exposé sur ${c.dashboard.host}, protégé par jeton`));

  // Règlement TWAP 60 s depuis août 2026 : un modèle ponctuel est faux (strike et variance).
  if (c.fv.twapWindowSec !== 60) {
    out.push(warn('Règlement', `FV_TWAP_WINDOW_SEC=${c.fv.twapWindowSec} : Polymarket règle les rounds 5 min sur la moyenne Chainlink des 60 s (fin et prix à battre) depuis août 2026 — retirer ce réglage (défaut 60).`));
  }
  if ((c.fv.noiseEdgeK ?? 0) === 0) {
    out.push(warn('Marge de bruit', 'FV_NOISE_EDGE_K=0 : le bot parie aussi sur des écarts que son propre bruit (prix à battre estimé) explique — en simulation (30 000 rounds), 13 % des rounds joués à −5 % par pari contre un carnet juste (écart et frais payés pour rien).'));
  }
  if (c.fillDelayMs === 0) out.push(warn('Latence simulée', 'FV_FILL_DELAY_MS=0 : aucune latence simulée, le papier sera plus optimiste que le réel.'));

  const ignored = warnings.filter(w => !w.startsWith('TELEGRAM_BOT_TOKEN'));
  out.push(ignored.length
    ? warn('Réglages', `valeurs ignorées ou ramenées : ${ignored.join(' ; ')}`)
    : ok('Réglages', `edge ≥ ${c.fv.minEdge} + ${c.fv.noiseEdgeK}·bruit, p ≥ ${c.fv.minProb}, τ ∈ [${entryMinTauSec(c.fv)}, ${c.fv.maxTauSec}] s, TWAP ${c.fv.twapWindowSec} s, `
      + `confiance ×${c.fv.zScale}, mélange ${c.fv.blendModel}/${c.fv.blendMarket}, ${c.coins.join(',')}, scrutation ${c.pollMs / 1000} s, `
      + `limites jour ${c.risk.dailyMaxLossPct} / mois ${c.risk.monthlyMaxLossPct} / baisse ${c.risk.maxDrawdownFromPeak} / totale ${c.risk.totalMaxLossPct}`));
  return out;
}

/**
 * Version de Node : PM2 lance le bot par `node --import tsx` (ecosystem.config.cjs), option
 * reconnue à partir de Node 20.6 — en dessous, le bot ne démarrerait plus sous PM2.
 */
export function runtimeChecks(nodeVersion: string = process.versions.node): Check[] {
  const [maj, min] = nodeVersion.split('.').map(Number);
  const okVersion = maj > 20 || (maj === 20 && min >= 6);
  return [okVersion
    ? ok('Node.js', `v${nodeVersion}`)
    : err('Node.js', `v${nodeVersion} : Node ≥ 20.6 requis (PM2 lance le bot par « node --import tsx »). Mettre Node à jour (22 LTS recommandé).`)];
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
