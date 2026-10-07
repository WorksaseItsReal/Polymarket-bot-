/**
 * Bot with Dashboard - Wrapper that runs the bot with real-time monitoring UI
 * 
 * This file shows HOW to integrate the dashboard with your bot.
 * It imports the dashboard and hooks into the bot's state/logs.
 * 
 * Run with: npx tsx bot-with-dashboard.ts
 * Then open: http://localhost:5173
 */

import 'dotenv/config';
import axios from 'axios';
import { ethers } from 'ethers';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  PolymarketSDK,
  ArbitrageService,
  SwapService,
  type SmartMoneyTrade,
  OnchainService,
} from './src/index.js';
import { CTFClient, isDryRunMode } from './src/clients/ctf-client.js';
import { startDashboard, dashboardEmitter } from './src/dashboard/index.js';
import type { BotState, BotConfig, LogLevel, DipArbSignal, SmartMoneySignal } from './src/dashboard/types.js';
import { addSession, createSessionFromState, type TradeRecord } from './src/dashboard/session-history.js';
import { isSpotCoin, type SpotCoin } from './src/services/spot-price-service.js';
import { computeStake } from './src/services/stake-sizing.js';
import { fairValueConfigFromEnv } from './src/services/fair-value.js';
import { getRoundMarketData } from './src/services/round-market-data.js';
import { computeStats, fetchRoundOutcome, readLedgerShared, type LedgerStats } from './src/services/paper-ledger.js';
import { FairValueRunner, coinsFromEnv, type ScannedMarket } from './src/strategy/fair-value-runner.js';
import { RoundDiscovery } from './src/services/round-discovery.js';
import { SpotStream } from './src/services/spot-stream.js';
import { DecisionJournal } from './src/services/decision-journal.js';
import { MoveScheduler } from './src/strategy/move-scheduler.js';
import { withTimeout } from './src/utils/with-timeout.js';
import { PersistentGuard, evaluateGuard } from './src/strategy/performance-guard.js';
import { ShadowTracker } from './src/strategy/shadow-tracker.js';
import { TelegramClient, telegramConfigFromEnv } from './src/services/telegram.js';
import { isValidTimeZone, msgAlert, msgStartup, msgSummary } from './src/services/telegram-messages.js';

// ============================================================================
// CONFIGURATION (same as bot-config.ts)
// ============================================================================

/** Mode papier : règle unique du projet (isDryRunMode, LIVE seulement si DRY_RUN=false). */
const DRY_RUN = isDryRunMode();
// Le client CLOB (@polymarket/clob-client) appelle axios SANS délai : une réponse qui ne
// vient jamais bloquait la requête pendant des minutes. Délai par défaut pour tout axios.
axios.defaults.timeout = Number(process.env.HTTP_TIMEOUT_MS ?? '') || 10_000;
/** Le process a-t-il été DÉMARRÉ en live ? Le dashboard ne peut jamais passer en LIVE sinon. */
const STARTED_LIVE = !DRY_RUN;
/**
 * Capital de référence UNIQUE. En papier : PAPER_CAPITAL (sinon CAPITAL_USD, sinon 50).
 * Avant : les limites de risque utilisaient CAPITAL_USD (250) et la mise PAPER_CAPITAL
 * (50) — deux capitaux différents pour le même portefeuille.
 */
function positiveEnv(...keys: string[]): number | null {
  for (const k of keys) {
    const v = Number(process.env[k] ?? '');
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

let CONFIG = {
  capital: {
    totalUsd: DRY_RUN ? (positiveEnv('PAPER_CAPITAL', 'CAPITAL_USD') ?? 50) : (positiveEnv('CAPITAL_USD') ?? 250),
    maxPerTradePct: 0.02,  // 🔴 FIXED: Reduced from 3% to 2%
    maxPerMarketPct: 0.10,
    maxTotalExposurePct: 0.30,
    minOrderUsd: 5,
    strategyAllocation: {
      smartMoney: 0.60,
      arbitrage: 0.20,
      dipArb: 0.10,
      directTrades: 0.10,
    },
  },

  risk: {
    // Daily limits
    dailyMaxLossPct: 0.05,  // 🔴 FIXED: Reduced from 8% to 5%
    maxConsecutiveLosses: 6,
    pauseOnBreachMinutes: 60,

    // 🔴 NEW: v3.1 Multi-layer protection
    monthlyMaxLossPct: 0.15,  // 15% monthly limit
    maxDrawdownFromPeak: 0.25,  // 25% drawdown from peak
    totalMaxLossPct: 0.40,  // 40% total loss - permanent halt

    // 🔴 NEW: Dynamic position sizing
    enableDynamicSizing: true,
    minPositionPct: 0.01,  // 1% minimum
    maxPositionPct: 0.05,  // 5% maximum
    lossSizingReduction: 0.20,  // Reduce 20% per loss
    winSizingIncrease: 0.10,  // Increase 10% per win
  },

  smartMoney: {
    enabled: process.env.SMARTMONEY_ENABLED === 'true',
    topN: 20,
    // 🔴 FIXED: Stricter criteria (v3.1)
    minWinRate: 0.60,  // Up from 0.70 to match bot-config (60%+)
    minPnl: 500,       // Up from 70 to $500
    minTrades: 30,     // Up from 15 to 30

    // 🔴 NEW: Quality filters
    minProfitFactor: 1.5,  // Total wins / total losses >= 1.5x
    minConsistencyScore: 0.7,  // Recent performance score
    maxSingleTradeExposure: 0.3,  // Max 30% of PnL from one trade
    checkLastNTrades: 10,  // Analyze last 10 trades

    sizeScale: 0.1,
    maxSizePerTrade: 15,  // Up from 10
    maxSlippage: 0.03,
    minTradeSize: 10,  // Up from 5
    delay: 500,
    customWallets: [
      '0xc2e7800b5af46e6093872b177b7a5e7f0563be51',
      '0x58c3f5d66c95d4c41b093fbdd2520e46b6c9de74',
    ] as string[],
  },

  arbitrage: {
    enabled: process.env.ARBITRAGE_ENABLED === 'true',
    // 🔴 FIXED: Higher profit threshold for gas fees
    profitThreshold: 0.01,  // Up from 0.001 to 1%
    minTradeSize: 20,  // Up from 5 to reduce gas impact
    maxTradeSize: 100,  // Up from 50
    minVolume24h: 5000,
    autoExecute: true,
    enableRebalancer: true,

    // 🔴 NEW: Gas fee accounting
    estimatedGasCostUSD: 0.10,
    minNetProfit: 0.50,
  },

  dipArb: {
    enabled: process.env.DIPARB_ENABLED === 'true',
    coins: ['BTC', 'ETH', 'SOL'] as const,
    shares: 10,
    sumTarget: 0.92,
    autoRotate: true,
    autoExecute: true,
    // 🔴 NEW: Minimum trade value
    minTradeValueUSD: 1.5,  // $1.50 minimum
  },

  onchain: {
    enabled: true,
    autoApprove: true,
    minMatic: 0.5,
  },

  binance: {
    enabled: process.env.TREND_ANALYSIS_ENABLED === 'true',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const,
    interval: '15m' as const,
    trendThreshold: 2,
  },

  directTrading: {
    enabled: false,
    trendFollowing: true,
    minTrendStrength: 0.02,
    // 🔴 NEW: Stop-loss and take-profit
    stopLossPct: 0.15,
    takeProfitPct: 0.25,
    trailingStopPct: 0.10,
    maxHoldDays: 7,
    minRiskReward: 1.5,
  },

  dryRun: DRY_RUN,
};

// ============================================================================
// STATE
// ============================================================================

const state: BotState = {
  startTime: Date.now(),
  dailyPnL: 0,
  totalPnL: 0,
  consecutiveLosses: 0,
  consecutiveWins: 0,  // 🔴 NEW
  tradesExecuted: 0,
  isPaused: false,
  pauseUntil: 0,

  // 🔴 NEW: v3.1 Risk tracking
  monthlyPnL: 0,
  monthStartTime: Date.now(),
  peakCapital: CONFIG.capital.totalUsd,
  currentCapital: CONFIG.capital.totalUsd,
  currentDrawdown: 0,
  permanentlyHalted: false,
  lastDailyReset: Date.now(),

  smartMoneyTrades: 0,
  arbTrades: 0,
  dipArbTrades: 0,
  directTrades: 0,
  arbProfit: 0,
  followedWallets: [],
  positions: [],
  activeArbMarket: null,
  activeDipArbMarket: null,
  splits: 0,
  merges: 0,
  redeems: 0,
  swaps: 0,
  usdcBalance: 0,
  usdcEBalance: 0,
  maticBalance: 0,
  unrealizedPnL: 0,
  btcTrend: 'neutral',
  ethTrend: 'neutral',
  solTrend: 'neutral',

  dipArb: {
    marketName: null,
    underlying: null,
    duration: null,
    endTime: null,
    upPrice: 0,
    downPrice: 0,
    sum: 0,
    status: 'idle',
    lastSignal: null,
    signals: [],
  },

  arbitrage: {
    status: 'idle',
    marketsScanned: 0,
    opportunitiesFound: 0,
    currentMarket: null,
    lastOpportunity: null,
  },

  smartMoneySignals: [],
};

// ============================================================================
// DASHBOARD-AWARE UTILITIES
// ============================================================================

function log(level: LogLevel, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const icons: Record<string, string> = {
    INFO: '📋', WARN: '⚠️', ERROR: '❌', TRADE: '💰', SIGNAL: '🎯',
    ARB: '🔄', WALLET: '👛', CHAIN: '⛓️', SWAP: '💱', BRIDGE: '🌉',
    KLINE: '📊', TREND: '📈',
  };

  // Console output (CLI)
  console.log(`[${timestamp}] ${icons[level] || '•'} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));

  // Dashboard output (WebSocket)
  dashboardEmitter.log(level, message, data);
}

function updateDashboard() {
  dashboardEmitter.updateState(state);
}

// 🔴 FIXED: v3.1 Multi-layer risk management
function canTrade(): boolean {
  // Check if permanently halted
  if (state.permanentlyHalted) {
    if (Date.now() - (state._lastPauseLog || 0) > 60 * 60_000) {
      state._lastPauseLog = Date.now();
      log('ERROR', '🛑 Trading permanently halted - total loss limit reached');
    }
    return false;
  }

  // Pertes du jour / du mois : recalculées sur jours et mois CALENDAIRES (UTC) depuis le
  // registre dans syncRealizedPnl(). Les anciennes remises à zéro « 24 h après le
  // démarrage » pouvaient effacer la perte du jour juste avant ce contrôle : retirées.

  // Update current capital and drawdown
  state.currentCapital = CONFIG.capital.totalUsd + state.totalPnL;
  if (state.currentCapital > state.peakCapital) {
    state.peakCapital = state.currentCapital;
  }
  state.currentDrawdown = (state.peakCapital - state.currentCapital) / state.peakCapital;

  // Check temporary pause
  if (state.isPaused && Date.now() < state.pauseUntil) {
    // ⚠️ FIX 2026-09-27 : ce retour etait MUET. Le bot pouvait rester bloque des
    // heures (voire 7 ou 30 jours selon la couche) sans la moindre ligne de log :
    // impossible de diagnostiquer « le bot ne fait plus rien ». On trace la raison
    // et le temps restant, au maximum une fois par minute.
    const minsLeft = Math.ceil((state.pauseUntil - Date.now()) / 60000);
    if (Date.now() - (state._lastPauseLog || 0) > 60000) {
      state._lastPauseLog = Date.now();
      log('WARN', `⏸️ Trading en pause (risque) — reprise dans ${minsLeft} min `
        + `(pnl=$${state.totalPnL.toFixed(2)} daily=$${state.dailyPnL.toFixed(2)} `
        + `monthly=$${state.monthlyPnL.toFixed(2)} dd=${(state.currentDrawdown * 100).toFixed(1)}% `
        + `capital=$${state.currentCapital.toFixed(2)} pic=$${state.peakCapital.toFixed(2)})`);
      updateDashboard();
    }
    return false;
  }
  if (state.isPaused && Date.now() >= state.pauseUntil) {
    state.isPaused = false;
    log('INFO', 'Bot resumed after cooldown');
    updateDashboard();
  }

  // Layer 1: Daily loss limit
  const dailyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.dailyMaxLossPct;
  if (state.dailyPnL <= -dailyLossLimit) {
    state.isPaused = true;
    state.pauseUntil = Date.now() + CONFIG.risk.pauseOnBreachMinutes * 60 * 1000;
    log('WARN', `Daily loss limit breached: -$${Math.abs(state.dailyPnL).toFixed(2)} (limit: $${dailyLossLimit.toFixed(2)})`);
    alertOnce('daily', `perte du jour ${Math.abs(state.dailyPnL).toFixed(2)} $ ≥ limite ${dailyLossLimit.toFixed(2)} $ : plus de nouvelle position jusqu'à minuit UTC`);
    updateDashboard();
    return false;
  }

  // Layer 2: Monthly loss limit
  const monthlyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.monthlyMaxLossPct;
  if (state.monthlyPnL <= -monthlyLossLimit) {
    log('ERROR', `🛑 Monthly loss limit breached: -$${Math.abs(state.monthlyPnL).toFixed(2)} (limit: $${monthlyLossLimit.toFixed(2)})`);
    state.isPaused = true;
    const n = new Date();
    state.pauseUntil = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1); // jusqu'au 1er du mois prochain
    alertOnce('monthly', `perte du mois ≥ ${monthlyLossLimit.toFixed(2)} $ : plus de nouvelle position jusqu'au 1er du mois prochain (UTC)`);
    updateDashboard();
    return false;
  }

  // Layer 3: Drawdown from peak
  if (state.currentDrawdown >= CONFIG.risk.maxDrawdownFromPeak) {
    log('ERROR', `🛑 Maximum drawdown reached: ${(state.currentDrawdown * 100).toFixed(1)}%`);
    state.isPaused = true;
    state.pauseUntil = Date.now() + (7 * 24 * 60 * 60 * 1000);
    alertOnce('drawdown', `baisse de ${(state.currentDrawdown * 100).toFixed(1)} % depuis le plus haut : nouvelles positions bloquées (le plus haut ne s'efface pas : reprise sur décision manuelle — archiver ~/.polymarket/fv-ledger.json ou ajuster PAPER_CAPITAL)`);
    updateDashboard();
    return false;
  }

  // Layer 4: Total loss - PERMANENT HALT
  const totalLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.totalMaxLossPct;
  if (state.totalPnL <= -totalLossLimit) {
    state.permanentlyHalted = true;
    log('ERROR', '💀 TOTAL LOSS LIMIT REACHED - TRADING PERMANENTLY HALTED');
    alertOnce('halt', `perte totale ≥ ${totalLossLimit.toFixed(2)} $ : trading ARRÊTÉ définitivement (redémarrage manuel requis)`);
    log('ERROR', `Total loss: -$${Math.abs(state.totalPnL).toFixed(2)} (limit: $${totalLossLimit.toFixed(2)})`);
    updateDashboard();
    return false;
  }

  return true;
}

// 🔴 FIXED: Enhanced trade recording with win tracking
/**
 * @param creditPnl false pour une projection (gain espéré) : on compte le trade mais on
 *   ne touche PAS la comptabilite. Seul le resolveur (pnl.json) ecrit le PnL realise.
 */
function recordTrade(profit: number, strategy: string, creditPnl = true) {
  state.tradesExecuted++;
  if (creditPnl) {
    state.dailyPnL += profit;
    state.monthlyPnL += profit;  // NEW
    state.totalPnL += profit;
  }

  // Track consecutive wins/losses (uniquement sur du PnL reel : une projection positive
  // ferait croire a une serie de victoires, cf. consecutiveWins=583/0 releve par l'audit)
  if (!creditPnl) {
    /* projection : pas de serie */
  } else if (profit < 0) {
    state.consecutiveLosses++;
    state.consecutiveWins = 0;
  } else {
    state.consecutiveLosses = 0;
    state.consecutiveWins++;
  }

  if (strategy === 'smartMoney') state.smartMoneyTrades++;
  else if (strategy === 'arbitrage') state.arbTrades++;
  else if (strategy === 'dipArb') state.dipArbTrades++;
  else if (strategy === 'direct') state.directTrades++;

  updateDashboard();
}

function logLearning(e: { roundId?: string; market?: string; side: string; price: number; estGain: number; conf: number; coin?: string; winProb?: number; conditionId?: string; stake?: number; [extra: string]: unknown }) {
  try {
    // ⚠️ FIX 2026-09-25 : ne JAMAIS écrire les HOLD dans history.json.
    // Avant ce fix : 298 HOLD / 300 entrées (99,3 %) → la fenêtre de 300 ne
    // couvrait que ~4 h et les vrais trades en sortaient, rendant toute analyse
    // historique impossible. Les HOLD sont déjà visibles dans les logs
    // (`🎯 … → HOLD`) et ne portent aucune information de PnL.
    // Seules les décisions BUY/SELL et les résolutions restent dans
    // history.json, que le résolveur PnL lit.
    if (e.side === 'HOLD') return;

    const h = readHistory();
    if (h === null) {
      log('WARN', 'learning store: history.json illisible — décision NON journalisée (fichier préservé)');
      return;
    }
    h.push({ ...e, ts: new Date().toISOString(), realized: 0 });
    if (h.length > 300) h.splice(0, h.length - 300);
    mkdirSync(polyDir(), { recursive: true });
    writeFileSync(polyDir() + '/history.json', JSON.stringify(h, null, 2));
  } catch (err) { log('WARN', `learning store: ${(err as Error).message}`); }
}


/** Dossier d'état local du bot (history.json, pnl.json). */
function polyDir(): string {
  return (process.env.HOME || '/root') + '/.polymarket';
}

/**
 * history.json : [] s'il est absent, null s'il existe mais est illisible/tronqué.
 * Un appelant qui ÉCRIT doit s'arrêter sur null : réécrire le fichier à partir d'un
 * tableau vide effacerait tout l'historique des trades.
 */
function readHistory(): any[] | null {
  const path = polyDir() + '/history.json';
  if (!existsSync(path)) return [];
  try {
    const h = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(h) ? h : null;
  } catch {
    return null;
  }
}


// === REGISTRE DES TRADES (src/services/paper-ledger.ts) — source de vérité du PnL ===
// Écrit UNIQUEMENT par la stratégie (src/strategy/fair-value-runner.ts) ; le reste du bot
// ne fait que le lire pour la compta affichée et la porte de risque.
function ledgerPath(): string {
  return polyDir() + '/fv-ledger.json';
}

function ledgerStats(): LedgerStats {
  return computeStats(readLedgerShared(ledgerPath()) ?? []);
}

// === COMMANDES DU DASHBOARD ===
/**
 * Enregistre un gestionnaire de commande dashboard SANS risque pour le process : une
 * charge utile absente/malformée ou une exception (y compris dans un `async`) est
 * journalisée, jamais remontée. Avant : `cmd.payload.enabled` sur un payload absent
 * → rejet de promesse non géré → arrêt de Node 22.
 */
function onDashboardCommand(handler: (cmd: { command: string; payload: any }) => unknown | Promise<unknown>): void {
  dashboardEmitter.on('command', (raw: unknown) => {
    const cmd = (raw && typeof raw === 'object' ? raw : {}) as { command?: unknown; payload?: unknown };
    if (typeof cmd.command !== 'string') return;
    const payload = cmd.payload && typeof cmd.payload === 'object' ? cmd.payload : {};
    Promise.resolve()
      .then(() => handler({ command: cmd.command as string, payload }))
      .catch(err => log('WARN', `Commande dashboard « ${String(cmd.command).slice(0, 40)} » en échec : ${String((err as Error)?.message ?? err).slice(0, 200)}`));
  });
}

// === NOTIFICATIONS TELEGRAM (src/services/telegram.ts) ===
let telegram: TelegramClient | null = null;
const TG_TZ = (() => {
  const tz = process.env.TELEGRAM_TZ || 'Europe/Paris';
  if (isValidTimeZone(tz)) return tz;
  console.warn(`TELEGRAM_TZ="${tz}" n'est pas un fuseau valide — Europe/Paris utilisé.`);
  return 'Europe/Paris';
})();
/** Alerte de risque, au plus une fois toutes les 6 h par motif (pas de spam horaire). */
const lastAlertAt = new Map<string, number>();
function alertOnce(key: string, text: string): void {
  const now = Date.now();
  if (now - (lastAlertAt.get(key) ?? 0) < 6 * 3_600_000) return;
  lastAlertAt.set(key, now);
  notify(msgAlert(text));
}

/** Envoie un message si Telegram est configuré ; ne lève jamais, ne bloque jamais. */
function notify(html: string): void {
  try {
    telegram?.send(html);
  } catch { /* les notifications ne doivent jamais casser le bot */ }
}

function simulateTrade(profit: number, strategy: string, description: string) {
  if (!CONFIG.dryRun || !state.paper) return;

  state.paper.trades++;
  // ⚠️ FIX 2026-09-27 (audit dashboard) : `profit` est le gain ESPERE *si le bon cote
  // gagne*, estime au moment de la decision. Le crediter comme realise faisait monter
  // `totalPnL` a +12 745 $ alors que le PnL reel etait +40,28 $, et rendait les 4
  // couches de risque inertes (aucune perte n'etait jamais debitee). On le trace
  // desormais separement : la projection ne touche plus la comptabilite.
  state.paper.estimatedPnl = (state.paper.estimatedPnl ?? 0) + profit;

  // Log as a special SIMULATION event
  log('TRADE', `[SIMULATION] ${description} | Gain espéré (non réalisé): $${profit.toFixed(2)}`);
  // Compté comme trade, mais SANS credit de PnL : le realise vient du resolveur.
  recordTrade(profit, strategy, false);
}

// ============================================================================
// ============================================================================
// STRATEGIES (simplified versions - copy full implementations from bot-config.ts)
// ============================================================================

let arbService: ArbitrageService | null = null;
let isSmartMoneyInitialized = false;
let isSmartMoneyInitializing = false;

async function setupSmartMoney(sdk: PolymarketSDK) {
  if (CONFIG.smartMoney.enabled) {
    initializeSmartMoney(sdk);
  }
}

async function initializeSmartMoney(sdk: PolymarketSDK) {
  if (isSmartMoneyInitialized || isSmartMoneyInitializing) return;
  isSmartMoneyInitializing = true;

  log('WALLET', 'Setting up Smart Money with quality filtering...');

  const qualified: string[] = [];

  if (CONFIG.smartMoney.customWallets?.length > 0) {
    for (const wallet of CONFIG.smartMoney.customWallets) {
      qualified.push(wallet);
      log('WALLET', `⭐ Custom wallet added: ${wallet.slice(0, 10)}...`);
    }
  }

  try {
    const leaderboard = await sdk.wallets.getLeaderboardByPeriod('week', CONFIG.smartMoney.topN * 2, 'pnl');

    for (const entry of leaderboard) {
      // Check if disabled mid-process to abort early
      if (!CONFIG.smartMoney.enabled && qualified.length === 0) break;

      if (qualified.length >= 10) break; // User limit: Max 10 qualified wallets
      if (qualified.includes(entry.address)) continue;

      const profile = await sdk.wallets.getWalletProfile(entry.address);
      if (!profile) continue;

      const winRate = (profile as any).winRate ?? 0;
      const pnl = entry.pnl ?? 0;
      const trades = profile.tradeCount ?? 0;

      if (winRate >= CONFIG.smartMoney.minWinRate &&
        pnl >= CONFIG.smartMoney.minPnl &&
        trades >= CONFIG.smartMoney.minTrades) {
        qualified.push(entry.address);
        log('WALLET', `✅ Qualified: ${entry.address.slice(0, 10)}... (WR:${(winRate * 100).toFixed(0)}% PnL:$${pnl.toFixed(0)} T:${trades})`);
      }

      await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    log('WARN', `Leaderboard error: ${(err as Error).message}`);
  }

  state.followedWallets = qualified;
  log('WALLET', `Following ${qualified.length} wallets`);
  updateDashboard();

  if (qualified.length > 0) {
    // Subscribe to smart money trades with address filter
    sdk.smartMoney.subscribeSmartMoneyTrades(
      async (trade: SmartMoneyTrade) => {
        if (!CONFIG.smartMoney.enabled) return;
        if (!canTrade()) return;

        // ... (inside setupSmartMoney callback)
        // Add to smart money signals for dashboard
        const signal: SmartMoneySignal = {
          id: `sm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          timestamp: new Date().toISOString(),
          wallet: trade.traderAddress,
          market: trade.marketSlug || 'Unknown',
          side: trade.side as 'BUY' | 'SELL',
          size: trade.size,
          price: trade.price,
        };
        state.smartMoneySignals.unshift(signal);
        if (state.smartMoneySignals.length > 50) {
          state.smartMoneySignals = state.smartMoneySignals.slice(0, 50);
        }

        log('SIGNAL', `Copy trade signal from ${trade.traderAddress.slice(0, 10)}...`, {
          market: trade.marketSlug?.slice(0, 50),
          side: trade.side,
          size: trade.size,
          price: trade.price,
        });
        updateDashboard();

        // EXECUTION LOGIC
        if (CONFIG.dryRun) {
          // ... execution
          simulateTrade(0, 'smartMoney', `Smart Money Copy: ${trade.side} ${trade.size} shares @ ${trade.price}`);
        } else {
          // ... live execution
          // simplified placeholder from original file
          // ...
        }
      },
      // ⚠️ FIX 2026-10-07 : sans ce filtre, le flux d'activité délivrait CHAQUE trade de
      // Polymarket (milliers de lignes de log / minute) au lieu des portefeuilles suivis.
      { filterAddresses: qualified },
    );
  }
  isSmartMoneyInitialized = true;
  isSmartMoneyInitializing = false;
}



async function setupArbitrage(_sdk: PolymarketSDK) {
  // Always setup service and listeners
  log('ARB', 'Setting up Arbitrage Service...');

  state.arbitrage.status = 'idle';
  updateDashboard();

  // Create standalone ArbitrageService (not using SDK wrapper)
  arbService = new ArbitrageService({
    privateKey: CONFIG.dryRun ? undefined : process.env.POLYMARKET_PRIVATE_KEY,
    profitThreshold: CONFIG.arbitrage.profitThreshold,
    minTradeSize: CONFIG.arbitrage.minTradeSize,
    maxTradeSize: CONFIG.arbitrage.maxTradeSize,
    autoExecute: !CONFIG.dryRun && CONFIG.arbitrage.autoExecute,
    enableRebalancer: !CONFIG.dryRun && CONFIG.arbitrage.enableRebalancer,
    enableLogging: true,
  });

  arbService.on('opportunity', (opp) => {
    state.activeArbMarket = opp.market?.name || 'scanning';
    state.arbitrage.opportunitiesFound++;
    state.arbitrage.lastOpportunity = {
      timestamp: new Date().toISOString(),
      type: opp.type as 'long' | 'short',
      profitPct: opp.profitPercent / 100,
      market: opp.market?.name || 'Unknown',
    };
    log('ARB', `Opportunity: ${opp.type.toUpperCase()} +${opp.profitPercent.toFixed(2)}%`);

    // SIMULATION HOOK
    if (CONFIG.dryRun && opp.profitPercent > 0) {
      // Conservative estimate: 10% of max size or min size
      const size = Math.max(CONFIG.arbitrage.minTradeSize, 10);
      const estimatedProfit = size * (opp.profitPercent / 100);
      simulateTrade(estimatedProfit, 'arbitrage', `Arb ${opp.market}`);
    }

    updateDashboard();
  });

  arbService.on('execution', (result) => {
    if (result.success) {
      state.arbProfit += result.profit || 0;
      recordTrade(result.profit || 0, 'arbitrage');
      log('TRADE', `Arb trade executed: +$${(result.profit || 0).toFixed(2)} profit`);
    }
  });

  // Scan for arbitrage opportunities ONLY if enabled
  if (CONFIG.arbitrage.enabled) {
    state.arbitrage.status = 'scanning';
    try {
      const results = await arbService.scanMarkets(
        { minVolume24h: CONFIG.arbitrage.minVolume24h },
        CONFIG.arbitrage.profitThreshold
      );
      state.arbitrage.marketsScanned = results.length;
      const opps = results.filter(r => r.arbType !== 'none');

      if (opps.length > 0) {
        state.activeArbMarket = opps[0].market.name;
        state.arbitrage.currentMarket = opps[0].market.name;
        state.arbitrage.status = 'monitoring';
        await arbService.start(opps[0].market);
        log('ARB', `Started monitoring: ${opps[0].market.name}`);
      } else {
        state.arbitrage.status = 'idle';
        log('ARB', 'No arbitrage opportunities found, will keep scanning...');
      }
      updateDashboard();
    } catch (err) {
      state.arbitrage.status = 'idle';
      log('WARN', `Arbitrage scan error: ${(err as Error).message}`);
      updateDashboard();
    }
  }
}

async function setupDipArb(sdk: PolymarketSDK) {
  // Always setup listeners provided by this function
  log('ARB', 'Setting up DipArb Service...');

  // Configure the DipArb service
  sdk.dipArb.updateConfig({
    shares: CONFIG.dipArb.shares,
    sumTarget: CONFIG.dipArb.sumTarget,
    autoExecute: !CONFIG.dryRun,
    debug: process.env.DIPARB_DEBUG === 'true',
  });

  // Event handlers - listen to orderbookUpdate for live orderbook data
  sdk.dipArb.on('orderbookUpdate', (update: {
    upPrice: number;
    downPrice: number;
    sum: number;
  }) => {
    state.dipArb.upPrice = update.upPrice;
    state.dipArb.downPrice = update.downPrice;
    state.dipArb.sum = update.sum;
    updateDashboard();
  });

  // Listen to 'started' event to sync market details immediately
  sdk.dipArb.on('started', (market: any) => {
    log('ARB', `DipArb Service Started Monitoring: ${market.name}`);
    state.activeDipArbMarket = market.name;
    state.dipArb.marketName = market.name;
    state.dipArb.underlying = market.underlying || 'ETH';
    state.dipArb.duration = `${market.durationMinutes}m`;
    state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
    state.dipArb.status = 'active'; // Force status update
    updateDashboard();

    // Also notify dashboard specifically about status change
    dashboardEmitter.updateStrategyStatus('dipArb', 'active', market.name);
  });

  // Listen to newRound for round changes
  sdk.dipArb.on('newRound', (round: { roundId: string; priceToBeat: number }) => {
    currentRoundId = round.roundId;
    log('ARB', `New round: ${round.roundId}, Price to Beat: ${round.priceToBeat}`);
    updateDashboard();
  });

  // Signal handler - extract data from DipArbLeg1Signal or DipArbLeg2Signal
  sdk.dipArb.on('signal', (s: {
    type: 'leg1' | 'leg2';
    dipSide?: string;
    hedgeSide?: string;
    currentPrice: number;
    source?: string;
    dropPercent?: number;
  }) => {
    const side = s.dipSide || s.hedgeSide || 'UP';
    const signal: DipArbSignal = {
      id: `da-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      type: s.type as DipArbSignal['type'],
      side: side as 'UP' | 'DOWN',
      price: s.currentPrice || 0,
      change: s.dropPercent ? -s.dropPercent * 100 : 0,
    };
    state.dipArb.lastSignal = signal;
    state.dipArb.signals.unshift(signal);
    if (state.dipArb.signals.length > 20) {
      state.dipArb.signals = state.dipArb.signals.slice(0, 20);
    }
    log('SIGNAL', `DipArb: ${s.type} ${side} @ ${s.currentPrice?.toFixed(3)}`);

    // === PAPER SIMULATION: chaque décision = mise simulée de 1€ ===
    // Le bot RÉFLÉCHIT et DÉCIDE, mais n'envoie JAMAIS d'ordre réel.
    // On simule comme s'il misait 1€ pour voir le gain potentiel.
    if (CONFIG.dryRun && state.paper) {
      // === MISE ADAPTATIVE (2026-09-27) : plus de mise fixe ===
      // Meme module pur que l'entree principale (src/services/stake-sizing.ts).
      const _sigHint = ((s as any).estimatedProfitRate ?? (s as any).expectedProfitRate);
      const _entry = Number(s.currentPrice) > 0 && Number(s.currentPrice) < 1 ? Number(s.currentPrice) : 0;
      const _sizeSig = computeStake({
        capital: CONFIG.capital.totalUsd,
        entryPrice: _entry,
        bookProb: typeof _sigHint === 'number' && _sigHint > 1 ? 1 / _sigHint : null,
        consecutiveLosses: state.consecutiveLosses,
        drawdownCurrent: realDrawdownPct(),
        openExposureEur: ledgerStats().openExposure,
        openPositions: ledgerStats().open,
      });
      if (_sizeSig.skipped || !(_sizeSig.stake > 0)) {
        log('LEARN', `   ↳ signal ${s.type} ignoré (pas de mise) : ${_sizeSig.rationale}`);
        updateDashboard();
        return;
      }
      const stake = _sizeSig.stake;
      // Taux de profit estimé du signal (leg1: estimatedProfitRate, leg2: expectedProfitRate)
      const profitRate = (s as any).estimatedProfitRate ?? (s as any).expectedProfitRate;
      let estProfit = 0;
      // ⚠️ FIX 2026-09-27 : `Number.isFinite(0)` est VRAI. Un `estimatedProfitRate`
      // non calculé valait 0 -> `stake * (0 - 1)` = -stake = une PERTE TOTALE de la
      // mise enregistrée pour chaque signal (2 514 signalements mesurés). Le PnL en
      // mémoire s'effondrait, `currentCapital` avec lui, et le garde-fou de drawdown
      // (25 % -> pause 7 JOURS, silencieuse) se déclenchait : le bot arrêtait de
      // trader sans rien logger. Un ratio de profit valide est > 1.
      if (typeof profitRate === 'number' && Number.isFinite(profitRate) && profitRate > 1) {
        estProfit = stake * (profitRate - 1);  // profitRate en ratio (ex 1.08 -> +8%)
      } else if ((s.currentPrice || 0) > 0) {
        // rendement d'une mise de 1€ sur un up/down: si le bon côté gagne, retour = 1/prix
        const p = s.currentPrice || 1;
        estProfit = stake * ((1 / p) - 1);
      }
      const pStr = (s.currentPrice || 0).toFixed(3);
      simulateTrade(estProfit, 'dipArb', `Décision ${s.type} ${side} @ $${pStr} — mise $${stake.toFixed(2)} : ${_sizeSig.rationale}, gain est. $${estProfit.toFixed(4)} si ${side} gagne (x${((1 / (s.currentPrice || 1))).toFixed(2)})`);
    }

    updateDashboard();
  });

  sdk.dipArb.on('execution', (r: any) => {
    if (r.success) {
      const price = r.price ? r.price.toFixed(3) : '??';
      const shares = r.shares ? r.shares.toFixed(1) : '??';
      const market = state.activeDipArbMarket || 'unknown-market';

      switch (r.leg) {
        case 'leg1':
          log('TRADE', `OPEN ${r.side} | ${shares} shares @ $${price} | ${market}`);
          break;
        case 'leg2':
          log('TRADE', `HEDGE ${r.side} | ${shares} shares @ $${price} | Locked Profit`);
          break;
        case 'exit':
          log('TRADE', `CLOSE ${r.side} (Timeout Exit) | ${shares} shares @ $${price}`);
          break;
        case 'merge':
          log('TRADE', `REDEEM | Merged positions for $1.00 payout | ${market}`);
          break;
        default:
          log('TRADE', `DipArb ${r.leg}: ${r.side} @ ${price}`);
      }
      recordTrade(0, 'dipArb');
    } else {
      log('WARN', `DipArb Execution Failed (${r.leg}): ${r.error || 'Unknown error'}`);
    }
  });

  sdk.dipArb.on('rotate', (e: { newMarket: string }) => {
    state.activeDipArbMarket = e.newMarket;
    state.dipArb.marketName = e.newMarket;
    log('ARB', `DipArb rotated to ${e.newMarket}`);
    updateDashboard();
  });

  // Enable auto-rotate if configured — UNIQUEMENT si DipArb est activé. Avant : activé même
  // DipArb désactivé → scan du portefeuille + merge/redeem toutes les 30 s et log en boucle.
  if (CONFIG.dipArb.enabled && CONFIG.dipArb.autoRotate) {
    sdk.dipArb.enableAutoRotate({
      enabled: true,
      underlyings: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'],
      duration: '5m',
      settleStrategy: 'redeem',
      redeemWaitMinutes: 5,
    });
  }

  // Find and start monitoring a market
  if (CONFIG.dipArb.enabled) {
    try {
      const market = await sdk.dipArb.findAndStart({ coin: 'BTC', preferDuration: '5m' });
      if (market) {
        state.activeDipArbMarket = market.name;
        state.dipArb.marketName = market.name;
        state.dipArb.underlying = market.underlying || 'ETH';
        state.dipArb.duration = `${market.durationMinutes}m`;
        // endTime is a Date object, convert to timestamp
        state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
        state.dipArb.status = 'active'; // Force status update
        log('ARB', `DipArb started: ${market.name}`);
      } else {
        log('WARN', 'No DipArb markets found');
      }
      updateDashboard();
    } catch (err) {
      log('WARN', `DipArb setup error: ${(err as Error).message}`);
    }
  }
}

let swapService: SwapService | null = null;
let currentRoundId: string = '';
// Les positions ouvertes vivent dans le registre (fv-ledger.json) : elles survivent à un
// redémarrage et alimentent exposition, sorties anticipées et résolution.

// Paramètres de la stratégie juste valeur (src/services/fair-value.ts, surchargeables par .env).
const FV_CFG = fairValueConfigFromEnv(process.env);
const FV_POLL_MS = Math.min(300, Math.max(5, Number(process.env.FV_POLL_SEC ?? '') || 10)) * 1000;
/** Mouvement du spot (points de base) qui déclenche une évaluation immédiate. */
const FV_MOVE_BPS = Math.min(50, Math.max(1, Number(process.env.FV_MOVE_BPS ?? '') || 3));
let spotStream: SpotStream | null = null;
/** Coins tradés (FV_COINS=BTC,ETH… ; défaut : les 5). */
const FV_COINS = coinsFromEnv(process.env.FV_COINS);
/** Latence d'exécution simulée (ms) : le carnet est relu après ce délai avant de « remplir ». */
const FV_FILL_DELAY_MS = (() => {
  const v = Number(process.env.FV_FILL_DELAY_MS ?? '');
  return (process.env.FV_FILL_DELAY_MS ?? '').trim() !== '' && Number.isFinite(v) && v >= 0 && v <= 10_000 ? v : 1000;
})();
let decisionJournal: DecisionJournal | null = null;
let shadowTracker: ShadowTracker | null = null;
const FV_EXIT_EDGE = (() => {
  const v = Number(process.env.FV_EXIT_EDGE ?? '');
  return Number.isFinite(v) && v >= 0 && v <= 0.5 && (process.env.FV_EXIT_EDGE ?? '').trim() !== '' ? v : FV_CFG.minEdge;
})();

/**
 * Recale la comptabilité AFFICHÉE et la porte de risque sur le PnL RÉALISÉ du registre
 * (fv-ledger.json), seule source de vérité. `state.totalPnL` ne doit jamais contenir de
 * gain espéré : sinon les 4 couches de risque deviennent inertes (cf. audit dashboard).
 */
function syncRealizedPnl() {
  const trades = readLedgerShared(ledgerPath()) ?? [];
  const st = computeStats(trades);
  const v = st.pnl;
  state.totalPnL = v;
  // Pertes du jour / du mois CALENDAIRES (UTC), recalculées à chaque tick depuis le
  // registre : avant, ces compteurs n'étaient jamais alimentés en papier (aucun PnL
  // réalisé ne passait par recordTrade) → limites journalière et mensuelle inertes.
  // Recalcul depuis le registre = insensible à un redémarrage.
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const since = (fromMs: number) => trades
    .filter(t => t.status !== 'open' && typeof t.pnl === 'number' && Date.parse(t.resolvedAt ?? '') >= fromMs)
    .reduce((acc, t) => acc + (t.pnl as number), 0);
  state.dailyPnL = since(dayStart);
  state.monthlyPnL = since(monthStart);
  state.currentCapital = CONFIG.capital.totalUsd + v;
  // Plus haut historique (registre) : un redémarrage ne doit pas effacer le drawdown.
  state.peakCapital = Math.max(state.peakCapital, CONFIG.capital.totalUsd + st.peakPnl, state.currentCapital);
  state.currentDrawdown =
    state.peakCapital > 0 ? Math.max(0, (state.peakCapital - state.currentCapital) / state.peakCapital) : 0;
  if (state.paper) {
    state.paper.pnl = v;
    state.paper.balance = CONFIG.capital.totalUsd + v;
  }
  updateDashboard();
}

/** Baisse actuelle du capital sous son plus haut, en fraction (registre). */
function realDrawdownPct(): number {
  const st = ledgerStats();
  const peakCapital = CONFIG.capital.totalUsd + st.peakPnl;
  return peakCapital > 0 ? Math.min(1, st.drawdownNow / peakCapital) : 0;
}

async function updateBalances() {
  if (CONFIG.dryRun) {
    // SIMULATION: Mock balances
    // Base 10,000 + whatever PnL we've made in this session
    state.usdcEBalance = CONFIG.capital.totalUsd + state.totalPnL;
    state.maticBalance = 100;

    // Only verify once/log sparsely
    if (Math.random() < 0.05) { // Occasional log
      // no-op
    }
    updateDashboard();
    return;
  }

  if (!swapService) return;
  try {
    const balances = await swapService.getBalances();
    let changed = false;

    // Parse balances from TokenBalance array
    for (const b of balances) {
      if (b.symbol === 'MATIC') {
        const val = parseFloat(b.balance);
        if (state.maticBalance !== val) { state.maticBalance = val; changed = true; }
      }
      if (b.symbol === 'USDC') {
        const val = parseFloat(b.balance);
        if (state.usdcBalance !== val) { state.usdcBalance = val; changed = true; }
      }
      if (b.symbol === 'USDC_E') {
        const val = parseFloat(b.balance);
        if (state.usdcEBalance !== val) { state.usdcEBalance = val; changed = true; }
      }
    }

    if (changed) {
      updateDashboard();
      // Optional: Log only on significant changes or debug
      // log('SWAP', 'Balances updated');
    }
  } catch (err) {
    // Silent fail on interval to avoid log spam
  }
}

async function setupSwap() {
  log('SWAP', 'Setting up Wallet & Balance Monitor...');

  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;

    // Create SwapService with signer
    const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org');
    const signer = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY, provider);
    swapService = new SwapService(signer);

    // Initial fetch
    await updateBalances();

    log('SWAP', 'Balances:', {
      matic: state.maticBalance.toFixed(4),
      usdce: `$${state.usdcEBalance.toFixed(2)}`,
    });

    // Check for low USDC.e (Bridged) balance
    if (!CONFIG.dryRun && state.usdcEBalance < 5) {
      log('WARN', `⚠️ Low USDC.e balance ($${state.usdcEBalance.toFixed(2)}). Bot requires USDC.e (Bridged USDC) on Polygon.`);
      log('WARN', `ℹ️ Please deposit USDC.e or swap your Native USDC to USDC.e manually.`);
    }

    // Poll balances every 30 seconds
    setInterval(updateBalances, 30000);

    updateDashboard();
  } catch (err) {
    log('WARN', `Balance setup error: ${(err as Error).message}`);
  }
}

async function setupOnchain() {
  if (!CONFIG.onchain.enabled || CONFIG.dryRun) return;
  log('CHAIN', 'Checking on-chain approvals...');

  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;

    const onchain = new OnchainService({
      privateKey: process.env.POLYMARKET_PRIVATE_KEY,
      rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org',
    });

    if (CONFIG.onchain.autoApprove) {
      log('CHAIN', 'Auto-approving Proxy and Exchange...');
      const result = await onchain.approveAll();

      if (result.allApproved) {
        log('CHAIN', '✅ All approvals ready');
      } else {
        log('WARN', `Approval status: ${result.summary}`);
        // Log individual failures
        result.erc20Approvals.forEach(r => {
          if (!r.success) log('WARN', `❌ ERC20 Approval failed: ${r.contract} - ${r.error}`);
        });
        result.erc1155Approvals.forEach(r => {
          if (!r.success) log('WARN', `❌ ERC1155 Approval failed: ${r.contract} - ${r.error}`);
        });
      }
    } else {
      const status = await onchain.checkAllowances();
      if (!status.tradingReady) {
        log('WARN', 'Missing approvals:', status.issues);
        log('WARN', 'Enable onchain.autoApprove=true to fix automatically');
      } else {
        log('CHAIN', '✅ Approvals verified');
      }
    }
  } catch (err) {
    log('WARN', `Onchain setup error: ${(err as Error).message}`);
  }
}

// ============================================================================
// TELEGRAM — connexion vérifiée au démarrage, bilan périodique
// ============================================================================
async function setupTelegram() {
  const cfg = telegramConfigFromEnv(process.env);
  if (!cfg) {
    log('INFO', '📵 Telegram désactivé (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID absents ou TELEGRAM_ENABLED=false)');
    return;
  }
  const client = new TelegramClient({ ...cfg, log: (level, msg) => log(level, msg) });
  const check = await client.check();
  if (!check.ok) {
    log('ERROR', `📵 Telegram NON connecté : ${check.detail}. Le bot continue sans notifications.`);
    return;
  }
  telegram = client;
  log('INFO', `📨 Telegram ${check.detail}`);
  notify(msgStartup({
    capital: CONFIG.capital.totalUsd, minEdge: FV_CFG.minEdge, minProb: FV_CFG.minProb, feeRate: FV_CFG.takerFeeRate,
    pollSec: FV_POLL_MS / 1000, coins: [...FV_COINS], stats: ledgerStats(),
  }));

  // Bilan périodique, seulement s'il s'est passé quelque chose depuis le précédent.
  const everyMin = Math.min(24 * 60, Math.max(15, Number(process.env.TELEGRAM_SUMMARY_MIN ?? '') || 60));
  let lastKey = '';
  setInterval(() => {
    const st = ledgerStats();
    const sh = shadowTracker?.stats();
    const key = `${st.n}|${st.open}|${sh?.n ?? 0}`;
    if (key === lastKey || (st.n === 0 && st.open === 0 && !sh?.n)) return;
    lastKey = key;
    notify(msgSummary(st, CONFIG.capital.totalUsd, sh));
  }, everyMin * 60_000);
}

// ============================================================================
// STRATÉGIE PRINCIPALE — juste valeur Up/Down 5 min (src/services/fair-value.ts)
// ============================================================================
// Remplace la règle « acheter le favori si son ask ∈ [0,58 ; 0,65] » : mesurée sur
// 1 411 décisions, elle n'a AUCUN edge (marché calibré, WR 63,2 % < prix payé 64,9 %,
// docs/EDGE-VALIDATION.md §5). On n'achète désormais un côté que si la probabilité
// calculée depuis le spot, le strike, la vol et le temps restant dépasse son coût
// RÉEL (VWAP du carnet + frais taker) d'au moins FV_MIN_EDGE. Au plus une entrée par
// round. La décision et ses entrées sont journalisées pour mesurer la calibration.
// === ARRÊT SUR PERFORMANCE RÉELLE (src/strategy/performance-guard.ts) ===
const guardFile = () => new PersistentGuard(polyDir() + '/fv-guard.json');
let guardLoggedAt = 0;
/** Raison de bloquer les entrées, ou null. Évalué à chaque signal (lecture du registre). */
function perfGuard(): string | null {
  const g = guardFile();
  const existing = g.current();
  if (existing) {
    if (Date.now() - guardLoggedAt > 3_600_000) {
      guardLoggedAt = Date.now();
      log('WARN', `🛑 Entrées bloquées : ${existing}. Pour reprendre : supprimer ${polyDir()}/fv-guard.json`);
    }
    return existing;
  }
  const v = evaluateGuard(ledgerStats());
  if (v.warn) {
    log('WARN', `⚠️ ${v.warn}`);
    alertOnce('calibration', `${v.warn} — augmente FV_MIN_EDGE ou analyse le journal (scripts/analysis/fv-report.ts)`);
  }
  if (v.stop) {
    try { g.trip(v.stop, Date.now()); } catch { /* le blocage reste effectif pour cette session */ }
    log('ERROR', `🛑 ARRÊT DE SÉCURITÉ : ${v.stop}. Les nouvelles entrées sont bloquées.`);
    notify(msgAlert(`ARRÊT DE SÉCURITÉ — ${v.stop}. Le bot n'ouvre plus de position (il continue d'observer). Pour reprendre : supprimer ~/.polymarket/fv-guard.json puis redémarrer.`));
    return v.stop;
  }
  return null;
}

async function setupFairValueStrategy(sdk: PolymarketSDK) {
  log('INFO', `📐 Stratégie juste valeur : p_modèle ≥ ${FV_CFG.minProb} et edge ≥ ${(FV_CFG.minEdge * 100).toFixed(1)} pt après frais `
    + `(taker ${FV_CFG.takerFeeRate}), τ ∈ [${FV_CFG.minTauSec}, ${FV_CFG.maxTauSec}] s, ask ∈ [${FV_CFG.minAsk}, ${FV_CFG.maxAsk}], `
    + `loi ${FV_CFG.tails}, sortie si bid net > p_modèle + ${FV_EXIT_EDGE}, scrutation ${FV_POLL_MS / 1000} s`);
  if (!CONFIG.dryRun) {
    log('WARN', 'Stratégie juste valeur : exécution LIVE non implémentée — décisions journalisées, AUCUN ordre envoyé.');
  }
  await setupTelegram();

  const discovery = new RoundDiscovery();
  // Mesure continue « modèle vs carnet » sur tous les rounds observés (bilan Telegram).
  const shadow = new ShadowTracker({ path: polyDir() + '/fv-shadow.json', fetchOutcome: slug => fetchRoundOutcome(slug) });
  shadowTracker = shadow;
  setInterval(() => { void shadow.resolveDue(); }, 30_000).unref?.();
  const journal = (process.env.FV_JOURNAL ?? 'true').toLowerCase() === 'false'
    ? null
    : new DecisionJournal({ dir: polyDir() + '/journal', log: m => log('WARN', m) });
  decisionJournal = journal;
  // Prix spot temps réel (WebSocket Binance) ; sans lui, repli automatique sur le REST.
  const stream = (process.env.FV_SPOT_STREAM ?? 'true').toLowerCase() === 'false'
    ? null
    : new SpotStream({ coins: FV_COINS, moveBps: FV_MOVE_BPS, log: (l, m) => log(l, m) });
  spotStream = stream;
  const runner = new FairValueRunner({
    cfg: FV_CFG,
    exitEdge: FV_EXIT_EDGE,
    ledgerPath: ledgerPath(),
    capital: () => CONFIG.capital.totalUsd,
    now: () => Date.now(),
    canTrade: () => { syncRealizedPnl(); return canTrade(); },
    // Découverte directe par slug (rapide, cache par round) ; l'ancien scan ne sert
    // qu'en repli pour les coins que Gamma n'a pas encore exposés.
    scanMarkets: async () => {
      const found: ScannedMarket[] = await discovery.current(Date.now(), FV_COINS);
      if (found.length >= FV_COINS.length) return found;
      try {
        const scanned = (await withTimeout(sdk.dipArb.scanUpcomingMarkets({
          coin: 'all', duration: '5m', minMinutesUntilEnd: 0, maxMinutesUntilEnd: 6, limit: 12,
        }), 20_000, 'scan des marchés')) as ScannedMarket[];
        const have = new Set(found.map(m => m.conditionId));
        return [...found, ...scanned.filter(m => m && !have.has(m.conditionId))];
      } catch {
        return found;
      }
    },
    marketsRefreshMs: 10_000,
    coins: FV_COINS,
    fillDelayMs: FV_FILL_DELAY_MS,
    // Délai garanti : le client CLOB n'en a aucun, une réponse bloquée figeait la boucle.
    getBook: tokenId => withTimeout(sdk.markets.getTokenOrderbook(tokenId), 8000, 'carnet CLOB'),
    getRoundData: (coin, slot, now) => (isSpotCoin(coin)
      ? getRoundMarketData(coin as SpotCoin, slot, now, stream?.price(coin) ?? null)
      : Promise.resolve(null)),
    fetchOutcome: slug => fetchRoundOutcome(slug),
    notify,
    log: (level, msg) => log(level, msg),
    timeZone: TG_TZ,
    onEvaluation: r => { journal?.record(r); shadow.observe(r); },
    entryBlock: () => perfGuard(),
    onRiskStop: reason => {
      const streak = /pertes consécutives/.test(reason);
      alertOnce(streak ? 'risk-streak' : 'risk-drawdown', streak
        ? `mise suspendue après une série de pertes (${reason.slice(0, 120)}) — reprise automatique quand ces pertes auront plus de 6 h`
        : `mise suspendue : baisse ≥ 20 % depuis le plus haut. Arrêt de risque maintenu jusqu'à décision manuelle (analyser le journal, puis archiver ~/.polymarket/fv-ledger.json ou ajuster PAPER_CAPITAL)`);
    },
    onTradeOpened: e => {
      simulateTrade(e.winProfit, 'dipArb', e.description);
      // Journal historique (lu par les outils externes paperbot-pnl.py / recap).
      logLearning({
        roundId: e.market.slug, market: e.market.name?.slice(0, 40), side: e.trade.side === 'UP' ? 'YES' : 'NO',
        // `price` = coût RÉEL par part (VWAP + frais) : le PnL résolu inclut donc les frais.
        price: Math.round(e.trade.costPerShare * 10000) / 10000,
        estGain: e.winProfit, conf: e.trade.modelProb, winProb: e.trade.modelProb, coin: e.trade.coin, stake: e.trade.stake,
        conditionId: e.trade.id, strategy: 'fair-value', ask: e.ask, feePerShare: e.trade.costPerShare - e.ask,
        modelProb: e.trade.modelProb, edge: e.trade.edge, tauSec: Math.round(e.tauSec),
        spot: e.data.spot, strike: e.data.strike, sigma1m: e.data.sigmaPerSqrtSec * Math.sqrt(60), priceSource: e.data.source,
      });
      updateDashboard();
    },
    onTradeClosed: t => {
      syncRealizedPnl();
      if (t.status !== 'sold') return;
      // Compatibilité des outils externes : une revente est marquée comme avant (soldTp).
      const h = readHistory();
      const entry = h?.find(x => x.conditionId === t.id && !x.soldTp);
      if (h && entry) {
        Object.assign(entry, { realized: Math.round((t.pnl ?? 0) * 10000) / 10000, soldTp: true, exitPrice: t.exitPrice });
        try { writeFileSync(polyDir() + '/history.json', JSON.stringify(h, null, 2)); } catch { /* non bloquant */ }
      }
    },
  });

  // Seul le mode PAPER est implémenté : en LIVE (bascule possible depuis le dashboard)
  // la stratégie n'écrit RIEN — un trade journalisé sans ordre réel fausserait le PnL.
  const tick = (coins?: readonly string[]) => (CONFIG.dryRun && state.paper ? runner.tick(coins) : Promise.resolve(true));
  await tick();
  setInterval(() => { void tick(); }, FV_POLL_MS);

  const startedAt = Date.now();
  // Chien de garde : une boucle bloquée (requête sans fin) ou en échec permanent doit se
  // voir, pas se découvrir des heures plus tard.
  setInterval(() => {
    if (!(CONFIG.dryRun && state.paper)) return;
    const idleMin = (Date.now() - runner.lastTickEndedAt) / 60_000;
    if (runner.lastTickEndedAt && idleMin > 3) {
      log('ERROR', `🐕 Chien de garde : aucun passage de la stratégie terminé depuis ${idleMin.toFixed(1)} min`);
      alertOnce('watchdog-stuck', `la stratégie semble bloquée (aucun passage terminé depuis ${idleMin.toFixed(0)} min) — redémarrer le bot (pm2 restart)`);
    }
    const noMarketsMin = (Date.now() - (runner.lastMarketsFoundAt || startedAt)) / 60_000;
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
    // Réaction immédiate à un mouvement du spot : c'est là que le carnet Polymarket est
    // le plus souvent en retard. Au plus une évaluation par coin toutes les 1,5 s.
    const scheduler = new MoveScheduler({ run: coins => tick(coins) });
    stream.on('move', (coin: string) => scheduler.onMove(coin));
    stream.on('clockSkew', (ms: number) => {
      log('WARN', `⏱️ Horloge suspecte : réception − horodatage Binance = ${ms} ms (médiane). Le temps restant des rounds peut être faux : synchronise l'heure du serveur (NTP).`);
      alertOnce('clock', `horloge du serveur décalée d'environ ${(ms / 1000).toFixed(1)} s par rapport à Binance — active la synchro NTP (timedatectl set-ntp true)`);
    });
    stream.start();
  }
}

async function setupBinanceAnalysis(sdk: PolymarketSDK) {
  if (!CONFIG.binance.enabled) return;
  log('KLINE', 'Setting up Binance K-line analysis...');

  async function analyzeTrend(symbol: 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT'): Promise<'up' | 'down' | 'neutral'> {
    try {
      const klines = await sdk.binance.getKLines(symbol, CONFIG.binance.interval, { limit: 20 });
      if (klines.length < 10) return 'neutral';

      const recent = klines.slice(-5);
      const older = klines.slice(-10, -5);

      const recentAvg = recent.reduce((s, k) => s + k.close, 0) / recent.length;
      const olderAvg = older.reduce((s, k) => s + k.close, 0) / older.length;

      const change = (recentAvg - olderAvg) / olderAvg;

      if (change > CONFIG.binance.trendThreshold / 100) return 'up';
      if (change < -CONFIG.binance.trendThreshold / 100) return 'down';
      return 'neutral';
    } catch {
      return 'neutral';
    }
  }

  async function updateTrends() {
    state.btcTrend = await analyzeTrend('BTCUSDT');
    state.ethTrend = await analyzeTrend('ETHUSDT');
    state.solTrend = await analyzeTrend('SOLUSDT');
    log('TREND', `BTC:${state.btcTrend} ETH:${state.ethTrend} SOL:${state.solTrend}`);
    updateDashboard();
  }

  await updateTrends();
  // (bug corrigé : l'interval était créé DEUX fois → log TREND doublé)
  setInterval(updateTrends, 5 * 60 * 1000);
}

async function setupDirectTrading(sdk: PolymarketSDK) {
  log('INFO', 'Direct trading setup complete - waiting for toggle');

  if (CONFIG.directTrading.enabled) {
    if (CONFIG.dryRun) {
      log('INFO', 'Direct trading enabled (simulation mode)');
    } else {
      log('INFO', 'Direct trading enabled - will place orders based on trend analysis');
    }
  }

  async function checkTrendTrades() {
    if (!CONFIG.directTrading.enabled) return;
    if (!canTrade()) return;

    try {
      const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(5);

      for (const market of trendingMarkets) {
        if (!market.conditionId) continue;

        try {
          const fullMarket = await sdk.getMarket(market.conditionId);
          const yesToken = fullMarket.tokens.find(t => t.outcome === 'Yes');
          const noToken = fullMarket.tokens.find(t => t.outcome === 'No');

          if (!yesToken || !noToken) continue;

          const isCryptoMarket = /btc|bitcoin|eth|ethereum|sol|solana/i.test(market.question || '');

          if (isCryptoMarket && CONFIG.directTrading.trendFollowing) {
            let trend: 'up' | 'down' | 'neutral' = 'neutral';
            if (/btc|bitcoin/i.test(market.question || '')) trend = state.btcTrend;
            else if (/eth|ethereum/i.test(market.question || '')) trend = state.ethTrend;
            else if (/sol|solana/i.test(market.question || '')) trend = state.solTrend;

            if (trend !== 'neutral') {
              // Strategy: 
              // UP -> Expect YES to win -> Buy YES
              // DOWN -> Expect YES to lose -> Buy NO
              const targetToken = trend === 'up' ? yesToken : noToken;
              const side = 'BUY'; // We always BUY the outcome we believe in
              const price = targetToken.price;

              if (CONFIG.dryRun) {
                // Simulate the trade in DRY RUN mode
                simulateTrade(0, 'direct', `Trend signal: ${market.question?.slice(0, 40)}... → ${trend.toUpperCase()} (Buy ${targetToken.outcome}) @ ${price.toFixed(2)}`);
                state.directTrades = (state.directTrades ?? 0) + 1;
                updateDashboard();
              } else {
                // Live Mode Execution
                const amountUsdc = 5; // Fixed small size for testing ($5)

                log('SIGNAL', `Executing Trend Trade: ${trend.toUpperCase()} on ${market.question?.slice(0, 30)}...`);

                sdk.tradingService.createMarketOrder({
                  tokenId: targetToken.tokenId,
                  side: 'BUY',
                  amount: amountUsdc
                }).then(res => {
                  if (res.success) {
                    log('TRADE', `✅ Direct Trade: Bought $${amountUsdc} of ${targetToken.outcome} @ ~${price.toFixed(2)}`);
                    recordTrade(0, 'direct');
                  } else {
                    log('WARN', `❌ Direct Trade failed: ${res.errorMsg}`);
                  }
                });
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      log('WARN', `Direct trading error: ${(err as Error).message}`);
    }
  }

  // Check every 5 minutes
  setInterval(checkTrendTrades, 5 * 60 * 1000);
  // Initial check after 10 seconds (let trends stabilize)
  setTimeout(checkTrendTrades, 10000);
}

async function setupPortfolioManager(sdk: PolymarketSDK) {
  log('INFO', 'Starting Portfolio Manager...');

  // Initial Sync
  try {
    const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());
    state.positions = positions;
    log('WALLET', `Synced ${positions.length} existing positions.`);
    updateDashboard();
  } catch (err: any) {
    log('WARN', `Portfolio Sync failed: ${err.message}`);
  }

  // Periodic Position Sync (Every 30s) — une passe lente ne doit pas en empiler d'autres.
  let syncing = false;
  setInterval(async () => {
    if (syncing) return;
    syncing = true;
    try {
      const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());

      // Enrich positions with market data (to check if won or lost)
      const enrichedPositions = await Promise.all(positions.map(async (pos: any) => {
        try {
          // Use cached market data if available
          const market = await sdk.markets.getMarket(pos.conditionId);
          if (market) {
            pos.marketClosed = market.closed;

            // Enrich with current price for PnL
            // Try to find the token in the market outcomes
            const token = market.tokens.find((t: any) => t.tokenId === pos.asset);

            if (token) {
              pos.isWinner = token.winner || false;
              // Store current price for frontend
              pos.curPrice = token.price || 0;
            }

            // If market is closed but winner info is missing/false, assume lost unless proven otherwise
            if (market.closed && !pos.isWinner) {
              // Double check if ANY token won (if market resolved)
            }
          }
        } catch (e) {
          // Ignore market fetch errors, keep basic pos data
        }
        return pos;
      }));

      // Calculate Unrealized PnL
      let unrealized = 0;
      for (const p of enrichedPositions) {
        const entry = Number(p.avgPrice) || 0;
        const current = Number(p.curPrice) || Number(p.msg_price) || 0;
        const size = Number(p.size) || 0;

        if (current > 0 && size > 0) {
          unrealized += (current - entry) * size;
        }
      }
      state.unrealizedPnL = unrealized;

      // Update Total PnL display to include Unrealized? 
      // User requested "P&L total is still not updating".
      // Usually Total = Realized + Unrealized.
      // But we keep them separate in state, let frontend decide how to show.

      state.positions = enrichedPositions;
      updateDashboard();
    } catch (err: any) {
      log('WARN', `Portfolio sync error: ${err.message}`);
    } finally {
      syncing = false;
    }
  }, 30 * 1000);
}

// === PROCESS : erreurs non gérées et arrêt propre ===
let shuttingDown = false;
/** Arrêt propre : coupe le flux spot, vide la file Telegram et le journal (≤ 5 s). */
async function shutdown(reason: string, code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(code ? 'ERROR' : 'INFO', `Arrêt du bot (${reason})`);
  try { spotStream?.stop(); } catch { /* déjà arrêté */ }
  notify(code ? msgAlert(`bot arrêté sur erreur (${reason}) — PM2 va le relancer`) : `🛑 Bot arrêté (${reason})`);
  await Promise.race([
    Promise.all([telegram?.flush(), decisionJournal?.flush()]),
    new Promise(r => setTimeout(r, 5000)),
  ]);
  process.exit(code);
}

function installProcessHandlers(): void {
  // Un rejet non géré tuait Node 22 (comportement par défaut) : on le journalise et on
  // continue — chaque boucle du bot capture déjà ses propres erreurs.
  process.on('unhandledRejection', (reason) => {
    log('ERROR', `Rejet de promesse non géré : ${String((reason as Error)?.stack ?? reason).slice(0, 400)}`);
  });
  // Une exception synchrone non rattrapée laisse l'état incertain : arrêt propre, PM2 relance.
  process.on('uncaughtException', (err) => {
    log('ERROR', `Exception non rattrapée : ${String(err?.stack ?? err).slice(0, 400)}`);
    void shutdown(`exception : ${String(err?.message ?? err).slice(0, 80)}`, 1);
  });
  process.on('SIGTERM', () => { void shutdown('SIGTERM', 0); });
  process.on('SIGINT', () => { void shutdown('SIGINT', 0); });
}

async function main() {
  installProcessHandlers();
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║          POLYMARKET BOT v3.0 + DASHBOARD                           ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  // Start Dashboard Server — local par défaut (127.0.0.1). Pour y accéder à distance :
  // tunnel SSH (ssh -L 3001:127.0.0.1:3001 serveur), ou DASHBOARD_HOST=0.0.0.0 +
  // DASHBOARD_TOKEN=<secret> puis http://serveur:3001/?token=<secret>.
  const dashPort = Number(process.env.DASHBOARD_PORT ?? '') || 3001;
  const dashHost = process.env.DASHBOARD_HOST || '127.0.0.1';
  startDashboard(dashPort, { host: dashHost, token: process.env.DASHBOARD_TOKEN || undefined });
  console.log(`\n🌐 Dashboard: http://${dashHost === '0.0.0.0' ? '<ip-du-serveur>' : dashHost}:${dashPort}\n`);

  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    log('ERROR', 'POLYMARKET_PRIVATE_KEY not found');
    process.exit(1);
  }

  // Send config to dashboard
  const dashboardConfig: BotConfig = {
    capital: CONFIG.capital,
    risk: CONFIG.risk,
    smartMoney: {
      enabled: CONFIG.smartMoney.enabled,
      topN: CONFIG.smartMoney.topN,
      minWinRate: CONFIG.smartMoney.minWinRate,
      minPnl: CONFIG.smartMoney.minPnl,
      minTrades: CONFIG.smartMoney.minTrades,
      customWallets: CONFIG.smartMoney.customWallets,
    },
    arbitrage: {
      enabled: CONFIG.arbitrage.enabled,
      profitThreshold: CONFIG.arbitrage.profitThreshold,
      autoExecute: CONFIG.arbitrage.autoExecute,
    },
    dipArb: {
      enabled: CONFIG.dipArb.enabled,
      coins: CONFIG.dipArb.coins,
    },
    directTrading: {
      enabled: CONFIG.directTrading.enabled,
    },
    binance: {
      enabled: CONFIG.binance.enabled,
    },
    dryRun: CONFIG.dryRun,
  };
  dashboardEmitter.updateConfig(dashboardConfig);
  dashboardEmitter.updateState(state);

  log('INFO', 'Configuration', {
    binance: CONFIG.binance.enabled,
  });

  // Initialize Paper Wallet if Dry Run
  if (CONFIG.dryRun) {
    state.paper = {
      balance: CONFIG.capital.totalUsd,
      initialBalance: CONFIG.capital.totalUsd,
      pnl: 0,
      trades: 0,
      totalVolume: 0,
    };
    log('INFO', `📝 Paper Trading Activated: capital papier $${CONFIG.capital.totalUsd.toFixed(2)}`);
    updateDashboard();
  }

  const sdk = new PolymarketSDK({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  });
  try {
    await sdk.start({ timeout: 15_000 });
  } catch (err) {
    // La stratégie papier n'utilise ni la clé API CLOB (ordres) ni le WebSocket Polymarket :
    // carnets, marchés et résultats passent par des API publiques. Un échec ici ne doit
    // pas arrêter le bot en papier (avant : exit 1 → boucle de redémarrages PM2).
    if (!CONFIG.dryRun) throw err;
    log('WARN', `Services de trading Polymarket indisponibles au démarrage (${String((err as Error)?.message ?? err).slice(0, 160)}) — `
      + 'sans effet sur la stratégie papier, on continue (le WebSocket se reconnecte seul).');
  }

  log('INFO', `Wallet: ${sdk.tradingService.getAddress()}`);

  // Handle Dashboard Commands (enregistré APRÈS la création du SDK : avant, une bascule
  // reçue pendant le démarrage touchait `sdk` encore non initialisé → ReferenceError).
  onDashboardCommand(async (cmd) => {
    if (cmd.command === 'toggleDryRun') {
      const enable = cmd.payload.enabled; // nouvel état du mode papier (true = papier)
      if (typeof enable !== 'boolean') {
        log('WARN', 'Commande toggleDryRun ignorée : payload.enabled doit être un booléen');
        return;
      }
      if (!enable && !STARTED_LIVE) {
        log('WARN', '🔒 Passage en LIVE refusé : le bot a été démarré en papier (DRY_RUN≠false). '
          + 'Pour trader réellement, redémarre-le explicitement avec DRY_RUN=false.');
        alertOnce('live-refused', 'tentative de passage en LIVE depuis le dashboard refusée (bot démarré en papier)');
        return;
      }
      if (CONFIG.dryRun === !enable) {
        log('INFO', `Switching to ${!enable ? 'LIVE' : 'DRY RUN'} mode... (Requested by user)`);

        // Update Config
        CONFIG.dryRun = !enable; // payload.enabled is "isLive?" or "isDryRun?" - let's assume payload.enabled is the NEW STATE for dryRun? 
        // Wait, usually toggles send the new desired state. 
        // Using "enabled" as "isDryRun enabled"
        CONFIG.dryRun = !!enable;

        // Update State paper wallet
        if (CONFIG.dryRun && !state.paper) {
          state.paper = {
            balance: CONFIG.capital.totalUsd,
            initialBalance: CONFIG.capital.totalUsd,
            pnl: 0,
            trades: 0,
            totalVolume: 0,
          };
        }

        // Re-configure Services

        // 1. Arbitrage Service (Needs restart to update signer/sim mode)
        if (arbService) {
          // Update internal flags if possible without full restart? 
          // ArbitrageService takes readonly config in constructor. Better to re-create.
          await arbService.stop();
          // Re-run setup
          await setupArbitrage(sdk);
        }

        // 2. DipArb (Update config)
        sdk.dipArb.updateConfig({
          autoExecute: !CONFIG.dryRun, // Live = autoExecute true (if config enabled)
        });

        // Emit new config to dashboard
        const newDashboardConfig: BotConfig = {
          capital: CONFIG.capital,
          risk: CONFIG.risk,
          smartMoney: { ...CONFIG.smartMoney },
          arbitrage: { ...CONFIG.arbitrage },
          dipArb: { ...CONFIG.dipArb },
          directTrading: { ...CONFIG.directTrading },
          binance: { ...CONFIG.binance },
          dryRun: CONFIG.dryRun,
        };
        dashboardEmitter.updateConfig(newDashboardConfig);

        log('WARN', `⚠️ BOT MODE CHANGED TO: ${CONFIG.dryRun ? '🧪 DRY RUN' : '🔴 LIVE'}`);
      }
    }
  });

  // Setup all services
  await setupOnchain(); // MUST BE FIRST (Approvals)
  await setupSwap();
  await setupBinanceAnalysis(sdk);
  await setupSmartMoney(sdk);
  await setupArbitrage(sdk);
  await setupDipArb(sdk);
  await setupFairValueStrategy(sdk);

  // Periodic state update
  setInterval(() => {
    updateDashboard();
  }, 5000);

  // Setup Direct Trading
  await setupDirectTrading(sdk);

  // Setup Portfolio Manager (Persistence)
  await setupPortfolioManager(sdk);

  // Listen for commands from dashboard
  onDashboardCommand(async ({ command, payload }) => {
    if (command === 'closePosition') {
      const { tokenId, size } = payload;
      log('TRADE', `Closing position: ${tokenId} (${size} shares)`);

      if (CONFIG.dryRun) {
        log('TRADE', `[SIMULATION] Would sell ${size} shares of ${tokenId}`);
        return;
      }

      try {
        // Estimate PnL before closing (using cached data)
        const position = state.positions.find(p => p.asset === tokenId);
        let estimatedPnL = 0;
        if (position) {
          const entryPrice = Number(position.avgPrice) || 0;
          // Use current market price if available, otherwise assume break-even or roughly current avg
          // Ideally we'd have the live mid-price. 'curPrice' might be in position if enriched.
          const exitPrice = Number((position as any).curPrice) || Number(position.msg_price) || 0;

          if (exitPrice > 0) {
            estimatedPnL = (exitPrice - entryPrice) * size;
          }
        }

        const res = await sdk.tradingService.createMarketOrder({
          tokenId,
          side: 'SELL',
          amount: size,
        });

        if (res.success) {
          log('TRADE', `✅ Position closed: ${size} shares sold`);
          if (estimatedPnL !== 0) {
            recordTrade(estimatedPnL, 'manual');
            log('INFO', `Realized PnL (Est): $${estimatedPnL.toFixed(2)}`);
          }
        } else {
          log('WARN', `❌ Close failed: ${res.errorMsg}`);
        }
      } catch (err: any) {
        log('WARN', `❌ Close error: ${err.message}`);
      }
    }

    if (command === 'toggleStrategy') {
      const { strategy, enabled } = payload;
      const strategyName = strategy as keyof typeof CONFIG;

      if (CONFIG[strategyName] && typeof (CONFIG[strategyName] as any).enabled !== 'undefined') {
        (CONFIG[strategyName] as any).enabled = enabled;
        log('INFO', `⚙️ Strategy ${strategy} ${enabled ? 'ENABLED' : 'DISABLED'}`);

        // Actively Start/Stop Services based on toggle
        try {
          if (strategy === 'dipArb') {
            if (enabled) {
              if (sdk.dipArb.isActive()) {
                log('WARN', `DipArb is already running.`);
              } else {
                log('INFO', `Starting DipArb Service (Scanning for markets)...`);
                await sdk.dipArb.findAndStart();
              }
            } else {
              log('INFO', `Stopping DipArb Service...`);
              await sdk.dipArb.stop();
            }
          } else if (strategy === 'arbitrage') {
            if (enabled) {
              if (arbService) {
                // Update config
                arbService.updateConfig({
                  profitThreshold: CONFIG.arbitrage.profitThreshold,
                  autoExecute: CONFIG.arbitrage.autoExecute,
                });

                if (arbService.isActive()) {
                  log('WARN', `Arbitrage Service is already running.`);
                } else {
                  log('INFO', `Starting Arbitrage Service...`);

                  // Try to scan and start a market if possible
                  try {
                    const results = await arbService.scanMarkets({ minVolume24h: 1000 }, CONFIG.arbitrage.profitThreshold);
                    const best = results.find(r => r.arbType !== 'none') || results[0]; // Pick best or just first to monitor

                    if (best) {
                      await arbService.start(best.market);
                      state.activeArbMarket = best.market.name;
                      state.arbitrage.status = 'monitoring';
                      log('ARB', `Auto-started monitoring: ${best.market.name}`);
                      updateDashboard();
                    } else {
                      state.arbitrage.status = 'idle';
                      log('WARN', 'Arbitrage Service started but no markets found. Will keep scanning in background if configured.');
                      updateDashboard();
                    }
                  } catch (e) {
                    state.arbitrage.status = 'idle';
                    log('WARN', `Arbitrage auto-start failed: ${(e as Error).message}`);
                    updateDashboard();
                  }
                }
              } else {
                log('ERROR', 'Arbitrage Service not initialized. Restart bot.');
              }
            } else {
              log('INFO', `Stopping Arbitrage Service...`);
              if (arbService) {
                await arbService.stop();
                state.arbitrage.status = 'idle';
                updateDashboard();
              }
            }
          } else if (strategy === 'smartMoney') {
            if (enabled) {
              log('INFO', `Initializing Smart Money...`);
              // Call the lazy initializer we created
              initializeSmartMoney(sdk);
            } else {
              log('INFO', `Smart Money monitoring disabled.`);
            }
          } else if (strategy === 'directTrading') {
            if (enabled) {
              log('INFO', `Triggering Direct Trading analysis...`);
              // We can't easily reach the inner function checkTrendTrades from here because it's scoped inside setupDirectTrading.
              // However, checkTrendTrades runs on an interval and checks the config flag. 
              // By enabling the flag, the NEXT interval will pick it up.
              // To be immediate, we'd need to expose it, but simplified "Wait for next cycle" is acceptable or we can just log.
              log('INFO', `Direct Trading will run on next cycle (within 5 min).`);
            }
          }
        } catch (err: any) {
          log('WARN', `Failed to toggle service: ${err.message}`);
        }

        // Broadcast updated config to dashboard
        const dashboardConfig: BotConfig = {
          // ... (rest of config mapping)
          capital: CONFIG.capital,
          risk: CONFIG.risk,
          smartMoney: {
            enabled: CONFIG.smartMoney.enabled,
            topN: CONFIG.smartMoney.topN,
            minWinRate: CONFIG.smartMoney.minWinRate,
            minPnl: CONFIG.smartMoney.minPnl,
            minTrades: CONFIG.smartMoney.minTrades,
            customWallets: CONFIG.smartMoney.customWallets,
          },
          arbitrage: {
            enabled: CONFIG.arbitrage.enabled,
            profitThreshold: CONFIG.arbitrage.profitThreshold,
            autoExecute: CONFIG.arbitrage.autoExecute,
          },
          dipArb: {
            enabled: CONFIG.dipArb.enabled,
            coins: CONFIG.dipArb.coins,
          },
          directTrading: {
            enabled: CONFIG.directTrading.enabled,
          },
          binance: {
            enabled: CONFIG.binance.enabled,
          },
          dryRun: CONFIG.dryRun,
        };
        dashboardEmitter.updateConfig(dashboardConfig);
      } else {
        log('WARN', `Unknown strategy: ${strategy}`);
      }
    }

    if (command === 'redeemPosition') {
      const { conditionId } = payload;
      log('CHAIN', `Redeem requested for: ${conditionId}`);

      if (CONFIG.dryRun) {
        log('CHAIN', `[SIMULATION] Would redeem position ${conditionId}`);
        return;
      }

      try {
        // Create CTFClient instance for on-chain redemption
        const ctfClient = new CTFClient({
          privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
        });

        // 1. Fetch market details to get Token IDs (required for Polymarket CLOB redemption)
        // We use the Gamma API (via sdk.markets or sdk.gammaApi)
        log('CHAIN', `Fetching market details for condition ${conditionId}...`);
        const market = await sdk.markets.getMarket(conditionId);

        if (!market || !market.tokens || market.tokens.length < 2) {
          log('WARN', `❌ Redeem failed: Valid market not found for condition ${conditionId}`);
          return;
        }

        const tokenIds = {
          yesTokenId: market.tokens[0].tokenId,
          noTokenId: market.tokens[1].tokenId,
        };

        log('CHAIN', `Found market: ${market.question} (Tokens: ${tokenIds.yesTokenId.slice(0, 10)}... / ${tokenIds.noTokenId.slice(0, 10)}...)`);

        // 2. Redeem using Polymarket Token IDs
        const result = await ctfClient.redeemByTokenIds(conditionId, tokenIds);

        if (result.success) {
          log('CHAIN', `✅ Redeemed! ${result.tokensRedeemed} tokens → ${result.usdcReceived} USDC`);
          log('CHAIN', `   Tx: ${result.txHash}`);
        } else {
          log('WARN', `❌ Redeem failed`);
        }
      } catch (err: any) {
        log('WARN', `❌ Redeem error: ${err.message}`);
      }
    }
  });

  process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');
    if (arbService) await arbService.stop();
    await sdk.dipArb.stop();
    sdk.stop();
    process.exit(0);
  });

  log('INFO', '🚀 Bot + Dashboard running! Press Ctrl+C to stop.\n');

  // Status Display Loop
  function displayStatus() {
    const runtime = Math.round((Date.now() - state.startTime) / 1000 / 60);

    console.log('\n' + '═'.repeat(70));
    console.log('              POLYMARKET BOT v3.0 STATUS');
    console.log('═'.repeat(70));
    console.log(`  Runtime:        ${runtime} minutes`);
    console.log(`  Mode:           ${CONFIG.dryRun ? '🧪 DRY RUN' : '🔴 LIVE'}`);
    console.log(`  Status:         ${state.isPaused ? '⏸️ PAUSED' : '▶️ ACTIVE'}`);
    console.log('─'.repeat(70));
    console.log('  BALANCES:');
    console.log(`    MATIC:        ${state.maticBalance.toFixed(4)}`);
    console.log(`    USDC:         $${state.usdcBalance.toFixed(2)}`);
    console.log(`    USDC.e:       $${state.usdcEBalance.toFixed(2)}`);
    console.log('─'.repeat(70));
    console.log('  STRATEGIES:');
    console.log(`    Smart Money:  ${state.smartMoneyTrades} trades | ${state.followedWallets.length} wallets`);
    console.log(`    Arbitrage:    ${state.arbTrades} trades`);
    console.log(`    DipArb:       ${state.dipArbTrades} trades`);
    console.log('═'.repeat(70) + '\n');
  }

  // Affichage du panneau de statut : toutes les 5 min (au lieu de 60 s) pour
  // éviter le spam de logs (le panneau fait ~24 lignes → 34 000 lignes/jour).
  setInterval(displayStatus, 5 * 60 * 1000);
  displayStatus(); // Initial call
}

main().catch((err) => {
  console.error('Fatal:', err?.message ?? err);
  console.error(err);
  void shutdown(`erreur fatale : ${String(err?.message ?? err).slice(0, 80)}`, 1);
});
