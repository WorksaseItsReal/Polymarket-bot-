/**
 * Bot papier « Up or Down 5 min » — câblage reconstruit, sans SDK ni stratégie héritée.
 *
 * Ce fichier ne contient AUCUNE règle de trading : il relie des modules purs et testés
 * (config, porte de risque, modèle, runner, registre, journal, mesure, Telegram, dashboard)
 * et gère le cycle de vie du process (démarrage, arrêt propre, plantages, chiens de garde).
 *
 * Données : tout vit dans ~/.polymarket (voir `dataPaths`). Le registre fv-ledger.json est
 * la seule source de vérité du PnL ; tout ce qui est affiché ou décidé en découle.
 *
 * Mode réel : NON implémenté. `DRY_RUN=false` est refusé au démarrage — aucun ordre ne
 * peut partir de ce programme, et il ne doit jamais faire croire le contraire.
 */
import axios from 'axios';
import { format } from 'node:util';
import { startDashboard, dashboardEmitter } from '../dashboard/index.js';
import type { BotState, BotConfig as DashboardConfig, HealthSnapshot, LastEvaluation, LogLevel } from '../dashboard/types.js';
import { addSession, createFairValueSession } from '../dashboard/session-history.js';
import { isSpotCoin, type SpotCoin } from '../services/spot-price-service.js';
import { MAX_VARIANCE_PCT } from '../services/stake-sizing.js';
import { entryMinTauSec } from '../services/fair-value.js';
import { getRoundMarketData } from '../services/round-market-data.js';
import { fetchRoundOutcome, ledgerStatsShared, readLedgerShared, type LedgerStats, type LedgerTrade } from '../services/paper-ledger.js';
import { FairValueRunner, type ScannedMarket } from '../strategy/fair-value-runner.js';
import { RoundDiscovery } from '../services/round-discovery.js';
import { SpotStream } from '../services/spot-stream.js';
import { DecisionJournal, type DecisionRecord } from '../services/decision-journal.js';
import { MoveScheduler } from '../strategy/move-scheduler.js';
import { withTimeout } from '../utils/with-timeout.js';
import { PersistentGuard, evaluateGuard } from '../strategy/performance-guard.js';
import { ShadowTracker } from '../strategy/shadow-tracker.js';
import { TelegramClient } from '../services/telegram.js';
import { goLiveLine, msgAlert, msgStartup, msgSummary, shadowLine } from '../services/telegram-messages.js';
import { maskPolyHeaders, secretRedactor } from '../services/redact.js';
import { noteStart, noteStop, type StartReport } from '../services/crash-guard.js';
import { fetchClobBook } from '../services/clob-book.js';
import { MIN_SELL_SHARES, capitalWarning, dataPaths, loadBotConfig, type BotConfig } from './config.js';
import { evaluateRisk, type RiskVerdict } from './risk-gate.js';
import { answerCommand } from './telegram-commands.js';

const ICONS: Record<string, string> = { INFO: '📋', WARN: '⚠️', ERROR: '❌', TRADE: '💰', SIGNAL: '🎯' };

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const { config, warnings } = loadBotConfig(env);
  const paths = dataPaths(config.dataDir);

  // --- Sorties masquées : clé privée, jetons, clé d'API d'une URL RPC, en-têtes POLY_*
  // (ethers et clob-client recopient ces valeurs dans leurs erreurs). Voir redact.ts.
  const redact = secretRedactor(env);
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => orig(redact(format(...args)));
  }
  axios.defaults.timeout = config.httpTimeoutMs;
  axios.interceptors.response.use(undefined, (err) => {
    try { maskPolyHeaders(err?.config?.headers); maskPolyHeaders(err?.response?.config?.headers); } catch { /* jamais bloquant */ }
    return Promise.reject(err);
  });

  const log = (level: LogLevel, message: string, data?: unknown): void => {
    console.log(`[${new Date().toISOString()}] ${ICONS[level] ?? '•'} ${message}`);
    if (data !== undefined) console.log(JSON.stringify(data, null, 2));
    let safe = data;
    if (data !== undefined) { try { safe = JSON.parse(redact(JSON.stringify(data))); } catch { /* tel quel */ } }
    dashboardEmitter.log(level, redact(message), safe);
  };

  // --- Cycle de vie ------------------------------------------------------------------
  const startTime = Date.now();
  let shuttingDown = false;
  let telegram: TelegramClient | null = null;
  let telegramStatus: HealthSnapshot['telegram'] = 'off';
  let crashStart: StartReport | null = null;
  let spotStream: SpotStream | null = null;
  let journal: DecisionJournal | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let scheduler: MoveScheduler | null = null;
  let sessionTrades = 0;

  const notify = (html: string): void => { try { telegram?.send(html); } catch { /* jamais bloquant */ } };
  const lastAlertAt = new Map<string, number>();
  /** Alerte Telegram au plus une fois toutes les 6 h par motif. */
  const alertOnce = (key: string, text: string): void => {
    const now = Date.now();
    if (now - (lastAlertAt.get(key) ?? 0) < 6 * 3_600_000) return;
    lastAlertAt.set(key, now);
    notify(msgAlert(text));
  };

  const ledgerStats = (): LedgerStats => ledgerStatsShared(paths.ledger);

  function recordSessionHistory(): void {
    try {
      const recs = (readLedgerShared(paths.ledger) ?? [])
        .filter(t => t.status !== 'open' && typeof t.pnl === 'number' && Date.parse(t.resolvedAt ?? '') >= startTime)
        .slice(-500);
      if (!recs.length && !sessionTrades) return; // redémarrage sans activité : rien à garder
      addSession(createFairValueSession(startTime, config.capital, recs, sessionTrades));
    } catch (err) {
      log('WARN', `Historique de session non enregistré (${String((err as Error)?.message ?? err).slice(0, 120)})`);
    }
  }

  /** Arrêt propre : coupe le flux spot, prévient Telegram, vide la file et le journal (≤ 5 s). */
  async function shutdown(reason: string, code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(code ? 'ERROR' : 'INFO', `Arrêt du bot (${reason})`);
    // Plus aucun passage ne démarre pendant la fenêtre d'arrêt : un règlement arrivé après le
    // bilan de session en serait absent et son message partirait après « Bot arrêté ».
    if (pollTimer) clearInterval(pollTimer);
    scheduler?.stop();
    telegram?.stopPolling();
    try { spotStream?.stop(); } catch { /* déjà arrêté */ }
    // Telegram pas (encore) connecté : arrêt compté mais pas « signalé » (le démarrage suivant le dira).
    const stop = crashStart ? noteStop(paths.runState, code !== 0, Date.now(), process.pid, telegram !== null) : { alert: true, recentCrashes: 0, nextGapMs: 0 };
    if (!code) {
      notify(`🛑 Bot arrêté (${reason})`);
    } else if (stop.alert) {
      const loop = stop.recentCrashes > 1
        ? ` · ${stop.recentCrashes} arrêts sur erreur dans la dernière heure : prochaine alerte au plus tôt dans ${Math.round(stop.nextGapMs / 60_000)} min`
        : '';
      notify(msgAlert(`bot arrêté sur erreur (${reason}) — PM2 va le relancer${loop}`));
    } else if (telegram) {
      log('WARN', `Alerte Telegram d'arrêt non envoyée (${stop.recentCrashes} arrêts sur erreur dans l'heure, déjà signalés).`);
    }
    recordSessionHistory();
    await Promise.race([
      Promise.all([telegram?.flush(), journal?.flush()]),
      new Promise(r => setTimeout(r, 5000)),
    ]);
    process.exit(code);
  }

  process.on('unhandledRejection', (reason) => {
    // Un rejet non géré tuait Node 22 : journalisé, le bot continue (chaque boucle capture ses erreurs).
    log('ERROR', `Rejet de promesse non géré : ${String((reason as Error)?.stack ?? reason).slice(0, 400)}`);
  });
  process.on('uncaughtException', (err) => {
    log('ERROR', `Exception non rattrapée : ${String(err?.stack ?? err).slice(0, 400)}`);
    void shutdown(`exception : ${String(err?.message ?? err).slice(0, 80)}`, 1);
  });
  process.on('SIGTERM', () => { void shutdown('SIGTERM', 0); });
  process.on('SIGINT', () => { void shutdown('SIGINT', 0); });

  // --- Démarrage ---------------------------------------------------------------------
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║     POLYMARKET PAPER BOT — « Up or Down 5 min », juste valeur       ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');
  for (const w of warnings) log('WARN', `Configuration : ${w}`);
  // Garde-fou de plantage AVANT tout refus : sous PM2, un refus répété (config fausse) est une
  // boucle de relance comme une autre — comptée, et ses alertes Telegram espacées.
  crashStart = noteStart(paths.runState);
  if (crashStart.brutal) log('WARN', 'Le lancement précédent s\'est terminé brutalement sans passer par l\'arrêt (mémoire saturée, kill -9, coupure ?) — voir paperbot.error.log.');
  if (crashStart.otherInstance) log('WARN', `Un autre bot semble tourner avec le même dossier ${config.dataDir} : deux bots écriraient le même registre.`);

  if (!config.dryRun) {
    log('ERROR', 'DRY_RUN=false : le mode RÉEL n\'est pas implémenté par ce bot (aucun ordre ne peut partir). Il refuse de démarrer pour ne pas faire croire le contraire. Retirer DRY_RUN=false.');
    // Client Telegram sans vérification préalable : juste de quoi dire « arrêté sur erreur » (espacé).
    if (config.telegram) telegram = new TelegramClient({ ...config.telegram, log: (level, msg) => log(level, msg) });
    await shutdown('DRY_RUN=false refusé : mode réel non implémenté, retirer DRY_RUN=false du .env', 1);
    return;
  }
  const capWarn = capitalWarning(config, MAX_VARIANCE_PCT);
  if (capWarn) log('WARN', capWarn);

  try {
    startDashboard(config.dashboard.port, { host: config.dashboard.host, token: config.dashboard.token ?? undefined });
    const exposed = config.dashboard.host === '0.0.0.0' && !!config.dashboard.token;
    log('INFO', `🌐 Dashboard : http://${exposed ? '<ip-du-serveur>' : config.dashboard.host === '0.0.0.0' ? '127.0.0.1' : config.dashboard.host}:${config.dashboard.port}`);
  } catch (err) {
    // listen() peut lever de façon synchrone (port invalide) : jamais fatal pour un affichage.
    log('ERROR', `Dashboard impossible à démarrer (${String((err as Error)?.message ?? err).slice(0, 120)}) — le bot continue SANS dashboard.`);
  }

  const dashboardConfig: DashboardConfig = {
    mode: 'paper', capital: config.capital, coins: [...config.coins], pollSec: config.pollMs / 1000, exitEdge: config.exitEdge,
    fv: {
      minEdge: config.fv.minEdge, noiseEdgeK: config.fv.noiseEdgeK, minProb: config.fv.minProb, minTauSec: config.fv.minTauSec,
      maxTauSec: config.fv.maxTauSec, minAsk: config.fv.minAsk, maxAsk: config.fv.maxAsk, takerFeeRate: config.fv.takerFeeRate,
      twapWindowSec: config.fv.twapWindowSec, strikeNoiseSec: config.fv.strikeNoiseSec, basisBps: config.fv.basisBps,
      zScale: config.fv.zScale, blendModel: config.fv.blendModel, blendMarket: config.fv.blendMarket, tails: config.fv.tails,
    },
    risk: { ...config.risk }, fillDelayMs: config.fillDelayMs, minOrderUsd: config.minOrderUsd, spotStream: config.spotStream,
    journal: config.journal.enabled, telegram: !!config.telegram, timeZone: config.timeZone,
  };
  dashboardEmitter.updateConfig(dashboardConfig);

  // --- État publié au dashboard (instantané reconstruit à chaque publication) ---------
  let lastRisk: RiskVerdict | null = null;
  let shadow: ShadowTracker | null = null;
  const lastEvals = new Map<string, LastEvaluation>();
  function publishState(): void {
    const st = ledgerStats();
    const trades = readLedgerShared(paths.ledger) ?? [];
    const sh = shadow?.stats();
    const risk = lastRisk ?? evaluateRisk(config.capital, st, trades, config.risk, Date.now());
    const sessionSettled = trades.filter(t => t.status !== 'open' && typeof t.pnl === 'number' && Date.parse(t.resolvedAt ?? '') >= startTime);
    const state: BotState = {
      startTime,
      capital: config.capital,
      ledger: {
        trades: st.n, wins: st.wins, losses: st.losses, open: st.open, winRate: st.winRate, pnl: st.pnl, tStat: st.tStat,
        openExposure: st.openExposure, lossStreak: st.lossStreak, maxDrawdown: st.maxDrawdown,
        calibN: st.calibN, calibWinRate: st.calibWinRate, avgModelProb: st.avgModelProb,
      },
      risk: { ...risk, limits: { ...config.risk } },
      fairValue: {
        shadow: sh ? shadowLine(sh) : 'Modèle vs carnet : mesure non démarrée',
        goLive: goLiveLine(st, sh),
        shadowStats: sh ? { n: sh.n, tDiff: sh.tDiff } : null,
        openPositions: trades.filter(t => t.status === 'open').slice(-20).map(t => ({
          coin: t.coin, side: t.side, stake: t.stake, costPerShare: t.costPerShare, shares: t.shares, modelProb: t.modelProb, endMs: t.endMs, openedAt: t.openedAt,
        })),
        lastEvaluations: [...lastEvals.values()],
      },
      health: {
        spotStream: spotStreamStatus(),
        clockSkewMs: spotStream?.clockSkewMs() ?? null,
        telegram: telegramStatus,
        lastFullPassAt: runnerRef?.lastFullPassAt ?? 0,
        lastMarketsFoundAt: runnerRef?.lastMarketsFoundAt ?? 0,
        consecutiveTickFailures: runnerRef?.consecutiveTickFailures ?? 0,
        journal: !!journal,
        // Calculé à chaque publication (lectures pures) : avant, une valeur mémorisée seulement
        // quand un signal passait la porte de risque — donc figée pendant une pause ou un blocage levé.
        entryBlock: shuttingDown ? 'arrêt du bot en cours' : (clockBlock() ?? guard.current() ?? sessionStop),
      },
      session: { opened: sessionTrades, settled: sessionSettled.length, pnl: sessionSettled.reduce((a, t) => a + (t.pnl as number), 0) },
    };
    dashboardEmitter.updateState(state);
  }
  let runnerRef: FairValueRunner | null = null;
  const spotStreamStatus = (): 'disabled' | 'live' | 'stale' =>
    !spotStream ? 'disabled' : spotStream.isConnected() && config.coins.some(c => spotStream?.price(c)) ? 'live' : 'stale';
  const freshRisk = (): RiskVerdict => evaluateRisk(config.capital, ledgerStats(), readLedgerShared(paths.ledger) ?? [], config.risk, Date.now());
  const openPositions = (): LedgerTrade[] => (readLedgerShared(paths.ledger) ?? []).filter(t => t.status === 'open');

  // --- Porte de risque (registre) -------------------------------------------------------
  let riskLoggedAt = 0;
  let riskLoggedLayer: string | null = null;
  function canTrade(): boolean {
    const now = Date.now();
    const v = evaluateRisk(config.capital, ledgerStats(), readLedgerShared(paths.ledger) ?? [], config.risk, now);
    lastRisk = v;
    if (!v.allowed) {
      // Une ligne au changement de couche, puis une par heure (une pause peut durer des jours).
      if (v.layer !== riskLoggedLayer || now - riskLoggedAt > 3_600_000) {
        riskLoggedAt = now;
        riskLoggedLayer = v.layer;
        log(v.layer === 'daily' ? 'WARN' : 'ERROR', `⏸️ Porte de risque : ${v.reason}${v.until ? ` (reprise ${new Date(v.until).toISOString()})` : ''}`);
      }
      alertOnce(`risk-${v.layer}`, v.layer === 'drawdown'
        ? `${v.reason} — pour reprendre : ARRÊTER le bot, attendre qu'aucune position ne soit ouverte, archiver ~/.polymarket/fv-ledger.json, puis redémarrer`
        : v.layer === 'total' ? `${v.reason} (redémarrage manuel et nouveau registre requis)` : v.reason as string);
    } else if (riskLoggedLayer) {
      riskLoggedLayer = null;
      log('INFO', 'Porte de risque : entrées de nouveau autorisées');
    }
    publishState();
    return v.allowed;
  }

  // --- Garde-fou de performance (calibration, perte significative) -------------------
  const guard = new PersistentGuard(paths.guard);
  let guardLoggedAt = 0;
  let calibLoggedAt = 0;
  let sessionStop: string | null = null;
  function perfGuard(): string | null {
    const existing = guard.current();
    if (existing) {
      if (Date.now() - guardLoggedAt > 3_600_000) {
        guardLoggedAt = Date.now();
        log('WARN', `🛑 Entrées bloquées : ${existing}. Pour reprendre : supprimer ${paths.guard}`);
      }
      return existing;
    }
    if (sessionStop) return sessionStop;
    const v = evaluateGuard(ledgerStats());
    if (v.warn) {
      if (Date.now() - calibLoggedAt > 3_600_000) { calibLoggedAt = Date.now(); log('WARN', `⚠️ ${v.warn}`); }
      alertOnce('calibration', `${v.warn} — augmente FV_MIN_EDGE ou analyse le journal (scripts/analysis/fv-report.ts)`);
    }
    if (v.stop) {
      sessionStop = v.stop; // même si l'écriture échoue : une seule alerte, blocage maintenu
      try { guard.trip(v.stop, Date.now()); } catch { /* blocage effectif pour cette session */ }
      log('ERROR', `🛑 ARRÊT DE SÉCURITÉ : ${v.stop}. Les nouvelles entrées sont bloquées.`);
      notify(msgAlert(`ARRÊT DE SÉCURITÉ — ${v.stop}. Le bot n'ouvre plus de position (il continue d'observer). Pour reprendre : arrêter le bot, supprimer ~/.polymarket/fv-guard.json, puis redémarrer.`));
      return v.stop;
    }
    return null;
  }
  const clockBlock = (): string | null => {
    const skew = spotStream?.clockSkewMs() ?? null;
    return skew !== null && Math.abs(skew) > config.maxClockSkewMs ? `horloge du serveur décalée de ${(skew / 1000).toFixed(1)} s (synchroniser NTP)` : null;
  };

  // --- Telegram ------------------------------------------------------------------------
  function activateTelegram(client: TelegramClient, detail: string): void {
    telegram = client;
    telegramStatus = 'connected';
    log('INFO', `📨 Telegram ${detail}`);
    if (config.telegramCommands) {
      // Commandes de l'opérateur (lecture seule) : /status, /bilan, /risque, /positions, /aide.
      client.startPolling(msg => answerCommand(msg.text, {
        status: () => {
          const now = Date.now();
          const risk = freshRisk();
          return {
            uptimeSec: (now - startTime) / 1000, capital: config.capital, stats: ledgerStats(), risk,
            entryBlock: shuttingDown ? 'arrêt du bot en cours' : (clockBlock() ?? guard.current() ?? sessionStop),
            positions: openPositions(),
            lastFullPassAgoSec: runnerRef?.lastFullPassAt ? (now - runnerRef.lastFullPassAt) / 1000 : null,
            lastMarketsFoundAgoSec: runnerRef?.lastMarketsFoundAt ? (now - runnerRef.lastMarketsFoundAt) / 1000 : null,
            spotStream: spotStreamStatus(), consecutiveTickFailures: runnerRef?.consecutiveTickFailures ?? 0,
            shadow: shadow?.stats(),
          };
        },
        summary: () => ({ stats: ledgerStats(), capital: config.capital, shadow: shadow?.stats() }),
        risk: () => ({ verdict: freshRisk(), limits: config.risk, capital: config.capital }),
        positions: () => ({ positions: openPositions(), nowMs: Date.now(), timeZone: config.timeZone }),
      }, client.chatType));
      log('INFO', '💬 Commandes Telegram écoutées : /status /bilan /risque /positions /aide (TELEGRAM_COMMANDS=false pour couper)');
    }
    if (crashStart && !crashStart.announce) {
      log('WARN', `Message de démarrage Telegram non envoyé : ${crashStart.recentCrashes} arrêts anormaux dans l'heure, alertes espacées.`);
    } else {
      notify(msgStartup({
        capital: config.capital, minEdge: config.fv.minEdge, minProb: config.fv.minProb, feeRate: config.fv.takerFeeRate,
        pollSec: config.pollMs / 1000, coins: [...config.coins], stats: ledgerStats(), warning: capWarn ?? undefined,
        zScale: config.fv.zScale, blendModel: config.fv.blendModel, blendMarket: config.fv.blendMarket,
        noiseK: config.fv.noiseEdgeK,
        restart: crashStart && (crashStart.brutal || crashStart.afterError) ? { brutal: crashStart.brutal, recentCrashes: crashStart.recentCrashes } : undefined,
      }));
    }
    // Bilan périodique : s'il y a de nouveaux trades ; sinon (seule la mesure a avancé) au plus toutes les 6 h.
    let lastTradesKey = '';
    let lastShadowN = 0;
    let lastSentAt = 0;
    setInterval(() => {
      const st = ledgerStats();
      const sh = shadow?.stats();
      const tradesKey = `${st.n}|${st.open}`;
      const tradesChanged = tradesKey !== lastTradesKey;
      const shadowOnly = !tradesChanged && (sh?.n ?? 0) !== lastShadowN && Date.now() - lastSentAt >= 6 * 3_600_000;
      if (!tradesChanged && !shadowOnly) return;
      if (st.n === 0 && st.open === 0 && !sh?.n) return;
      lastTradesKey = tradesKey;
      lastShadowN = sh?.n ?? 0;
      lastSentAt = Date.now();
      notify(msgSummary(st, config.capital, sh));
    }, config.summaryEveryMin * 60_000).unref?.();
  }
  async function setupTelegram(): Promise<void> {
    if (!config.telegram) {
      log('INFO', '📵 Telegram désactivé (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID absents ou TELEGRAM_ENABLED=false)');
      return;
    }
    const client = new TelegramClient({ ...config.telegram, log: (level, msg) => log(level, msg) });
    const check = await client.check();
    if (check.ok) { activateTelegram(client, check.detail); return; }
    log('ERROR', `📵 Telegram NON connecté : ${check.detail}. Le bot continue sans notifications.`);
    telegramStatus = 'error';
    if (!check.retryable) return;
    // Panne passagère au démarrage : nouvel essai toutes les 5 min plutôt que rester muet.
    const retry = setInterval(async () => {
      const again = await client.check();
      if (again.ok) { clearInterval(retry); activateTelegram(client, again.detail); }
      else if (!again.retryable) { clearInterval(retry); log('ERROR', `📵 Telegram : ${again.detail}`); }
    }, 5 * 60_000);
    retry.unref?.();
  }

  // --- Stratégie -------------------------------------------------------------------------
  const fv = config.fv;
  log('INFO', `📐 Stratégie juste valeur : p_modèle ≥ ${fv.minProb} et edge ≥ ${(fv.minEdge * 100).toFixed(1)} pt après frais `
    + `(taker ${fv.takerFeeRate}) + ${fv.noiseEdgeK}·bruit du prix à battre, règlement TWAP ${fv.twapWindowSec} s, `
    + `τ ∈ [${entryMinTauSec(fv)}, ${fv.maxTauSec}] s, ask ∈ [${fv.minAsk}, ${fv.maxAsk}], loi ${fv.tails}, confiance ×${fv.zScale}, `
    + `mélange modèle ${fv.blendModel} / carnet ${fv.blendMarket}, sortie si bid net > p + ${config.exitEdge}, scrutation ${config.pollMs / 1000} s, `
    + `coins ${config.coins.join(', ')}`);
  await setupTelegram();

  const discovery = new RoundDiscovery();
  // Empreinte du modèle MESURÉ (sans le mélange) : si elle change, « modèle vs carnet » repart de zéro.
  const modelKey = JSON.stringify({
    mesure: 2, z: fv.zScale, tails: fv.tails, noise: fv.strikeNoiseSec, basis: fv.basisBps, twap: fv.twapWindowSec,
    strike: fv.twapWindowSec > 0 ? 2 : 1,
  });
  shadow = new ShadowTracker({
    path: paths.shadow, fetchOutcome: slug => fetchRoundOutcome(slug), modelKey, legacyModelKey: 'mesure-1',
    onReset: n => log('WARN', `Réglages du modèle ou définition de la mesure changés : « modèle vs carnet » (${n} rounds) repart de zéro`),
  });
  const shadowRef = shadow;
  setInterval(() => { void shadowRef.resolveDue(); }, 30_000).unref?.();
  journal = config.journal.enabled ? new DecisionJournal({ dir: paths.journalDir, log: m => log('WARN', m), keepDays: config.journal.keepDays }) : null;
  spotStream = config.spotStream
    ? new SpotStream({ coins: config.coins, moveBps: config.moveBps, log: (l, m) => log(l, m), ...(config.spotStreamUrl ? { urls: [config.spotStreamUrl] } : {}) })
    : null;
  const stream = spotStream;

  const runner = new FairValueRunner({
    cfg: fv,
    exitEdge: config.exitEdge,
    ledgerPath: paths.ledger,
    capital: () => config.capital,
    now: () => Date.now(),
    canTrade,
    // Découverte directe par slug (déterministe, cache par round) : aucun scan lourd.
    scanMarkets: async (): Promise<ScannedMarket[]> => discovery.current(Date.now(), config.coins),
    marketsRefreshMs: 10_000,
    coins: config.coins,
    fillDelayMs: config.fillDelayMs,
    minOrderUsd: config.minOrderUsd,
    minSellShares: MIN_SELL_SHARES,
    fullPassEveryMs: Math.round(config.pollMs * 1.5),
    onBelowMinOrder: (stake, min) => alertOnce('min-order', `mise calculée ${stake.toFixed(2)} $ < minimum Polymarket ${min} $ : aucun pari possible avec ce capital papier — monter PAPER_CAPITAL (≥ 250 $ recommandé)`),
    // Délai garanti : une réponse CLOB bloquée figeait la boucle.
    getBook: tokenId => withTimeout(fetchClobBook(tokenId), 8000, 'carnet CLOB'),
    getRoundData: (coin, slot, now) => (isSpotCoin(coin)
      ? getRoundMarketData(coin as SpotCoin, slot, now, () => stream?.price(coin) ?? null, fv.twapWindowSec, fv.volEstimator ?? 'cc',
        (from, to) => stream?.meanSince(coin, from, to) ?? null)
      : Promise.resolve(null)),
    fetchOutcome: slug => fetchRoundOutcome(slug),
    notify,
    log: (level, msg) => log(level, msg),
    timeZone: config.timeZone,
    onEvaluation: (r: DecisionRecord, reason: string) => {
      journal?.record(r);
      shadowRef.observe(r);
      lastEvals.set(r.coin, { coin: r.coin, t: r.t, tau: r.tau, pUp: r.pUp, upAsk: r.upAsk, downAsk: r.downAsk, act: r.act, side: r.side, reason });
    },
    entryBlock: () => (shuttingDown ? 'arrêt du bot en cours' : null) ?? clockBlock() ?? perfGuard(),
    onRiskStop: reason => {
      const streak = /pertes consécutives/.test(reason);
      alertOnce(streak ? 'risk-streak' : 'risk-stake-drawdown', streak
        ? `mise suspendue après une série de pertes (${reason.slice(0, 120)}) — reprise automatique quand ces pertes auront plus de 6 h`
        : `mise suspendue : baisse ≥ 20 % depuis le plus haut. Arrêt de risque maintenu jusqu'à décision manuelle (analyser le journal ; pour repartir : arrêter le bot, archiver ~/.polymarket/fv-ledger.json une fois les positions réglées, redémarrer)`);
    },
    onTradeOpened: () => { sessionTrades++; publishState(); },
    onTradeClosed: (_t: LedgerTrade) => publishState(),
  });

  runnerRef = runner;
  await runner.tick();
  // Passage régulier refusé parce qu'un passage « saut du spot » tient le verrou : nouvel
  // essai toutes les 0,5 s pendant au plus 1,5 s (au-delà, le passage suivant serait trop proche).
  const regularTick = async () => {
    for (let attempt = 0; attempt < 4 && !shuttingDown; attempt++) {
      if (await runner.tick()) return;
      if (attempt < 3) await new Promise(r => setTimeout(r, 500));
    }
  };
  pollTimer = setInterval(() => { void regularTick(); }, config.pollMs);

  // Chien de garde : boucle bloquée, aucun marché, échecs en série — se voir, pas se découvrir des heures après.
  setInterval(() => {
    const idleMin = (Date.now() - runner.lastFullPassAt) / 60_000;
    const stuckMin = Math.max(3, (2 * config.pollMs + 60_000) / 60_000);
    if (runner.lastFullPassAt && idleMin > stuckMin && readLedgerShared(paths.ledger) !== null) {
      log('ERROR', `🐕 Chien de garde : aucun passage complet de la stratégie depuis ${idleMin.toFixed(1)} min`);
      alertOnce('watchdog-stuck', `la stratégie semble bloquée (aucun passage terminé depuis ${idleMin.toFixed(0)} min) — redémarrer le bot (pm2 restart)`);
    }
    const noMarketsMin = (Date.now() - (runner.lastMarketsFoundAt || startTime)) / 60_000;
    if (noMarketsMin > 5) {
      log('ERROR', `🐕 Chien de garde : aucun marché « Up or Down 5 min » trouvé depuis ${noMarketsMin.toFixed(0)} min (Gamma injoignable ?)`);
      alertOnce('watchdog-markets', `aucun marché 5 min trouvé depuis ${noMarketsMin.toFixed(0)} min — vérifier l'accès réseau à gamma-api.polymarket.com`);
    }
    if (runner.consecutiveTickFailures >= 10) {
      log('ERROR', `🐕 Chien de garde : ${runner.consecutiveTickFailures} passages consécutifs en échec`);
      alertOnce('watchdog-failing', `${runner.consecutiveTickFailures} passages consécutifs de la stratégie en échec — voir paperbot.log`);
    }
  }, 60_000).unref?.();

  if (stream) {
    // Réaction immédiate à un mouvement du spot (au plus une évaluation par coin toutes les 1,5 s).
    const sched = new MoveScheduler({ run: coins => runner.tick(coins) });
    scheduler = sched;
    stream.on('move', (coin: string) => sched.onMove(coin));
    stream.on('clockSkew', (ms: number) => {
      log('WARN', `⏱️ Horloge suspecte : réception − horodatage Binance = ${ms} ms (médiane). Le temps restant des rounds peut être faux : synchronise l'heure du serveur (NTP).`);
      alertOnce('clock', `horloge du serveur décalée d'environ ${(ms / 1000).toFixed(1)} s par rapport à Binance — active la synchro NTP (timedatectl set-ntp true)`);
    });
    stream.start();
  }

  // --- Commandes du dashboard : aucune ne change le comportement de ce bot papier --------
  dashboardEmitter.on('command', (raw: unknown) => {
    const cmd = (raw ?? {}) as { command?: unknown };
    const name = String(cmd.command ?? '').slice(0, 40);
    if (name === 'toggleDryRun') {
      log('WARN', '🔒 Passage en LIVE refusé : ce bot est papier uniquement (exécution réelle non implémentée).');
      alertOnce('live-refused', 'tentative de passage en LIVE depuis le dashboard refusée : ce bot est papier uniquement');
    } else {
      log('WARN', `Commande dashboard ignorée (${name || 'vide'}) : ce bot papier n'a ni stratégie héritée ni ordre réel.`);
    }
  });

  setInterval(publishState, 5000).unref?.();
  publishState();
  log('INFO', '🚀 Bot + Dashboard running! Press Ctrl+C to stop.\n');

  // Panneau de statut console toutes les 5 min (pas plus : ~24 lignes par affichage).
  const displayStatus = () => {
    const st = ledgerStats();
    const sh = shadowRef.stats();
    const risk = lastRisk;
    console.log('\n' + '═'.repeat(70));
    console.log(`  Papier « Up or Down 5 min » — ${Math.round((Date.now() - startTime) / 60_000)} min — ${risk && !risk.allowed ? `⏸️ entrées bloquées (${risk.layer})` : '▶️ actif'}`);
    console.log(`  Capital ${config.capital.toFixed(2)} $ → ${(config.capital + st.pnl).toFixed(2)} $ | PnL ${st.pnl >= 0 ? '+' : ''}${st.pnl.toFixed(2)} $ | jour ${risk ? risk.pnlToday.toFixed(2) : '?'} $ | baisse ${risk ? (risk.drawdown * 100).toFixed(1) : '?'} %`);
    console.log(`  Trades ${st.n} (${st.wins} ✅ / ${st.losses} ❌${st.winRate === null ? '' : `, ${(st.winRate * 100).toFixed(0)} %`}) | en cours ${st.open} | session ${sessionTrades}`
      + ` | modèle vs carnet : ${sh.n} rounds${sh.tDiff === null ? '' : `, t ${sh.tDiff.toFixed(1)}`}`);
    console.log('═'.repeat(70) + '\n');
  };
  setInterval(displayStatus, 5 * 60_000).unref?.();
  displayStatus();
}
