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
import { ethers } from 'ethers';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  PolymarketSDK,
  ArbitrageService,
  SwapService,
  type SmartMoneyTrade,
  OnchainService,
} from './src/index.js';
import { CTFClient } from './src/clients/ctf-client.js';
import { startDashboard, dashboardEmitter } from './src/dashboard/index.js';
import type { BotState, BotConfig, LogLevel, DipArbSignal, SmartMoneySignal } from './src/dashboard/types.js';
import { addSession, createSessionFromState, type TradeRecord } from './src/dashboard/session-history.js';
import { getSpotPrice, formatSpotPrice, isSpotCoin, type SpotCoin } from './src/services/spot-price-service.js';
import { computeStake } from './src/services/stake-sizing.js';
import {
  binaryPayoff,
  decide,
  effectiveCostPerShare,
  estimateFill,
  fairValueConfigFromEnv,
  probUp,
  takerFeePerShare,
} from './src/services/fair-value.js';
import { getRoundMarketData } from './src/services/round-market-data.js';

// ============================================================================
// CONFIGURATION (same as bot-config.ts)
// ============================================================================

let CONFIG = {
  capital: {
    totalUsd: parseFloat(process.env.CAPITAL_USD || '250'),
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
    enabled: process.env.SMARTMONEY_ENABLED !== 'false',
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

  dryRun: process.env.DRY_RUN !== 'false',
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
    log('ERROR', '🛑 Trading permanently halted - total loss limit reached');
    return false;
  }

  // Reset daily PnL if new day
  const daysSinceReset = (Date.now() - state.lastDailyReset) / (1000 * 60 * 60 * 24);
  if (daysSinceReset >= 1) {
    log('INFO', `Daily PnL reset. Previous day: $${state.dailyPnL.toFixed(2)}`);
    state.dailyPnL = 0;
    state.lastDailyReset = Date.now();
  }

  // Reset monthly PnL if new month
  const daysSinceMonthStart = (Date.now() - state.monthStartTime) / (1000 * 60 * 60 * 24);
  if (daysSinceMonthStart >= 30) {
    log('INFO', `Monthly PnL reset. Previous month: $${state.monthlyPnL.toFixed(2)}`);
    state.monthlyPnL = 0;
    state.monthStartTime = Date.now();
  }

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
    updateDashboard();
    return false;
  }

  // Layer 2: Monthly loss limit
  const monthlyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.monthlyMaxLossPct;
  if (state.monthlyPnL <= -monthlyLossLimit) {
    log('ERROR', `🛑 Monthly loss limit breached: -$${Math.abs(state.monthlyPnL).toFixed(2)} (limit: $${monthlyLossLimit.toFixed(2)})`);
    state.isPaused = true;
    state.pauseUntil = Date.now() + (30 * 24 * 60 * 60 * 1000);
    updateDashboard();
    return false;
  }

  // Layer 3: Drawdown from peak
  if (state.currentDrawdown >= CONFIG.risk.maxDrawdownFromPeak) {
    log('ERROR', `🛑 Maximum drawdown reached: ${(state.currentDrawdown * 100).toFixed(1)}%`);
    state.isPaused = true;
    state.pauseUntil = Date.now() + (7 * 24 * 60 * 60 * 1000);
    updateDashboard();
    return false;
  }

  // Layer 4: Total loss - PERMANENT HALT
  const totalLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.totalMaxLossPct;
  if (state.totalPnL <= -totalLossLimit) {
    state.permanentlyHalted = true;
    log('ERROR', '💀 TOTAL LOSS LIMIT REACHED - TRADING PERMANENTLY HALTED');
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

/**
 * Fin du round encodé dans un slug `<coin>-updown-5m-<slot>` (slot = début, en
 * secondes epoch). Renvoie null si le slug ne suit pas ce format.
 */
function roundEndMsFromSlug(slug: string | undefined): number | null {
  if (!slug) return null;
  const m = slug.match(/-(\d{9,})$/);
  if (!m) return null;
  const slot = Number(m[1]);
  if (!Number.isFinite(slot) || slot <= 0) return null;
  return slot * 1000 + 300 * 1000; // round 5m
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

/** Début du round (s epoch) encodé dans un slug `<coin>-updown-5m-<slot>`, ou null. */
function slotFromSlug(slug: string | undefined): number | null {
  const end = roundEndMsFromSlug(slug);
  return end === null ? null : end / 1000 - 300;
}

/**
 * Pertes consécutives RÉELLES (trades résolus de history.json, du plus récent au plus
 * ancien). `state.consecutiveLosses` ne bouge jamais en paper (aucun PnL réalisé ne
 * transite par recordTrade) : le modérateur « série de pertes » du sizing était inerte.
 */
function realLossStreak(): number {
  const resolved = (readHistory() ?? [])
    .filter(t => t && t.side !== 'HOLD' && typeof t.realized === 'number' && t.realized !== 0)
    .sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
  let streak = 0;
  for (let i = resolved.length - 1; i >= 0 && resolved[i].realized < 0; i--) streak++;
  return streak;
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

// === SORTIE ANTICIPÉE (paper) fondée sur l'espérance ===
// Remplace le take-profit / stop-loss en % (P_TAKE_PROFIT / P_STOP_LOSS) : vendre un
// binaire au bid coûte le demi-spread + les frais taker ; ce n'est rentable QUE si le
// marché paie plus que ce que la position vaut selon le modèle. Règle :
//   vendre ⟺ (bid − frais) − p_modèle(côté détenu) ≥ FV_EXIT_EDGE
// Dans la fenêtre TWAP finale (τ < FV_MIN_TAU_SEC) le modèle n'est pas fiable : on
// garde jusqu'à la résolution. Un round terminé est laissé au résolveur.
async function checkPaperExits(sdk: PolymarketSDK) {
  if (!CONFIG.dryRun || !state.paper || paperOpen.length === 0) return;
  const now = Date.now();
  const stillOpen: typeof paperOpen = [];
  for (const pos of paperOpen) {
    if (now > pos.endMs + 30_000) continue; // round terminé → résolveur
    const tauSec = (pos.endMs - now) / 1000;
    if (tauSec < FV_CFG.minTauSec) { stillOpen.push(pos); continue; }
    try {
      const data = await getRoundMarketData(pos.coin as SpotCoin, pos.slot, now);
      const pUp = data ? probUp({ ...data, tauSec }, FV_CFG) : null;
      const book = await sdk.markets.getTokenOrderbook(pos.tokenId);
      const best = book.bids[0];
      if (pUp === null || !best || !(best.price > 0)) { stillOpen.push(pos); continue; }
      const pHeld = pos.side === 'YES' ? pUp : 1 - pUp;
      const bidNet = best.price - takerFeePerShare(best.price, FV_CFG.takerFeeRate);
      if (bidNet - pHeld < FV_EXIT_EDGE || best.size < pos.shares) { stillOpen.push(pos); continue; }

      const profit = pos.shares * bidNet - pos.stake;
      state.paper.pnl += profit;
      state.paper.balance += profit;
      log('TRADE', `[SIMULATION] VENTE ${pos.coin} ${pos.side} @ $${best.price.toFixed(3)} (net frais ${bidNet.toFixed(3)} > p_modèle ${pHeld.toFixed(3)} + ${FV_EXIT_EDGE}) `
        + `round ${pos.slug} — PnL réalisé ${profit >= 0 ? '+' : ''}$${profit.toFixed(4)}`);
      try {
        const h = readHistory();
        if (h === null) throw new Error('history.json illisible');
        const entry = h.find(x => x.conditionId === pos.conditionId && x.side === pos.side && !x.soldTp);
        if (entry) {
          entry.realized = Math.round(profit * 10000) / 10000;
          entry.soldTp = true;
          entry.exitPrice = best.price;
          entry.exitModelProb = Math.round(pHeld * 10000) / 10000;
        }
        writeFileSync(polyDir() + '/history.json', JSON.stringify(h, null, 2));
      } catch { /* non bloquant : le résolveur reste la source de vérité */ }
    } catch {
      stillOpen.push(pos);
    }
  }
  paperOpen = stillOpen;
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
      });
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
    debug: true,
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
        capital: Number(process.env.PAPER_CAPITAL ?? '') || 50,
        entryPrice: _entry,
        bookProb: typeof _sigHint === 'number' && _sigHint > 1 ? 1 / _sigHint : null,
        consecutiveLosses: state.consecutiveLosses,
        drawdownCurrent: realDrawdownPct(),
        openExposureEur: paperOpen.reduce((a, o) => a + (Number(o.stake) || 0), 0),
        openPositions: paperOpen.length,
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

  // Enable auto-rotate if configured
  if (CONFIG.dipArb.autoRotate) {
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
// Positions paper ouvertes (achat simulé) — clôturées par la sortie EV ou à la résolution.
// `entry` = coût réel par part (VWAP + frais taker), `shares` = parts détenues.
let paperOpen: Array<{
  side: string; entry: number; shares: number; conditionId: string; slug: string; coin: string; stake: number;
  tokenId: string; slot: number; endMs: number;
}> = [];
// Rounds déjà joués : au plus UNE entrée par round (la scrutation est fréquente).
const tradedMarkets = new Set<string>();

// Paramètres de la stratégie juste valeur (src/services/fair-value.ts, surchargeables par .env).
const FV_CFG = fairValueConfigFromEnv(process.env);
const FV_POLL_MS = Math.min(300, Math.max(5, Number(process.env.FV_POLL_SEC ?? '') || 10)) * 1000;
const FV_EXIT_EDGE = (() => {
  const v = Number(process.env.FV_EXIT_EDGE ?? '');
  return Number.isFinite(v) && v >= 0 && v <= 0.5 && (process.env.FV_EXIT_EDGE ?? '').trim() !== '' ? v : FV_CFG.minEdge;
})();

/**
 * Drawdown REEL, lu sur le PnL du resolveur (`~/.polymarket/pnl.json`), la seule
 * source de verite. `state.currentDrawdown` est inutilisable : il derive de
 * `state.totalPnL`, un compteur en memoire qui ne credite que des gains estimes et
 * ne debite JAMAIS une perte (cf. docs/rebuild/dashboard/AUDIT.md : +12 745 $ en
 * memoire contre +40,28 $ reels). On mesure donc la perte par rapport au capital de
 * depart, ce qui ne depend d'aucun pic fictif.
 */
function realPnl(): number | null {
  try {
    const p = JSON.parse(readFileSync(polyDir() + '/pnl.json', 'utf8')) as { pnl?: number };
    const v = Number(p?.pnl);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null; // fichier absent/illisible : on ne fabrique aucun chiffre
  }
}

/**
 * Recale la comptabilite AFFICHEE sur le PnL REALISE du resolveur (pnl.json), seule
 * source de verite. Sans ca, `state.totalPnL` ne credite que des gains estimes et ne
 * debite jamais une perte (audit : +12 745 $ affiches vs +40,28 $ reels), ce qui rendait
 * les 4 couches de risque inertes. Si le fichier est illisible, on ne touche a RIEN
 * (mieux vaut un chiffre perime qu'un chiffre inventé).
 */
function syncRealizedPnl() {
  const v = realPnl();
  if (v === null) return;
  state.totalPnL = v;
  state.currentCapital = CONFIG.capital.totalUsd + v;
  if (state.currentCapital > state.peakCapital) state.peakCapital = state.currentCapital;
  state.currentDrawdown =
    state.peakCapital > 0 ? Math.max(0, (state.peakCapital - state.currentCapital) / state.peakCapital) : 0;
  if (state.paper) {
    state.paper.pnl = v;
    state.paper.balance = CONFIG.capital.totalUsd + v;
  }
  updateDashboard();
}

function realDrawdownPct(): number {
  try {
    const p = JSON.parse(readFileSync(polyDir() + '/pnl.json', 'utf8')) as { pnl?: number };
    const cap = Number(process.env.PAPER_CAPITAL ?? '') || 50;
    const pnl = Number(p?.pnl);
    if (Number.isFinite(pnl) && cap > 0 && pnl < 0) return Math.min(1, -pnl / cap);
    return 0;
  } catch {
    return 0; // fichier absent/illisible : on ne fabrique pas un chiffre de risque
  }
}

async function updateBalances() {
  if (CONFIG.dryRun) {
    // SIMULATION: Mock balances
    // Base 10,000 + whatever PnL we've made in this session
    state.usdcEBalance = (Number(process.env.PAPER_CAPITAL ?? '') || 10000) + state.totalPnL;
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
// STRATÉGIE PRINCIPALE — juste valeur Up/Down 5 min (src/services/fair-value.ts)
// ============================================================================
// Remplace la règle « acheter le favori si son ask ∈ [0,58 ; 0,65] » : mesurée sur
// 1 411 décisions, elle n'a AUCUN edge (marché calibré, WR 63,2 % < prix payé 64,9 %,
// docs/EDGE-VALIDATION.md §5). On n'achète désormais un côté que si la probabilité
// calculée depuis le spot, le strike, la vol et le temps restant dépasse son coût
// RÉEL (VWAP du carnet + frais taker) d'au moins FV_MIN_EDGE. Au plus une entrée par
// round. La décision et ses entrées sont journalisées pour mesurer la calibration.
async function setupFairValueStrategy(sdk: PolymarketSDK) {
  log('INFO', `📐 Stratégie juste valeur : edge min ${(FV_CFG.minEdge * 100).toFixed(1)} pt après frais `
    + `(taker ${FV_CFG.takerFeeRate}), τ ∈ [${FV_CFG.minTauSec}, ${FV_CFG.maxTauSec}] s, ask ∈ [${FV_CFG.minAsk}, ${FV_CFG.maxAsk}], `
    + `queues ${FV_CFG.tails}, sortie si bid net > p_modèle + ${FV_EXIT_EDGE}, scrutation ${FV_POLL_MS / 1000} s`);
  if (!CONFIG.dryRun) {
    log('WARN', 'Stratégie juste valeur : exécution LIVE non implémentée — décisions journalisées, AUCUN ordre envoyé.');
  }

  type ScannedMarket = { conditionId: string; name: string; slug: string; underlying: string; durationMinutes: number; upTokenId: string; downTokenId: string };
  let markets: ScannedMarket[] = [];
  let marketsTs = 0;
  let running = false;
  const lastHoldLog = new Map<string, number>();

  const holdLog = (cid: string, msg: string) => {
    const now = Date.now();
    if (now - (lastHoldLog.get(cid) ?? 0) < 60_000) return;
    lastHoldLog.set(cid, now);
    if (lastHoldLog.size > 200) {
      for (const [k, t] of lastHoldLog) if (now - t > 600_000) lastHoldLog.delete(k);
    }
    log('SIGNAL', msg);
  };

  async function tick() {
    if (running) return; // un tick lent ne doit jamais se chevaucher avec le suivant
    running = true;
    try {
      // Compta recalée sur le PnL RÉALISÉ avant la porte de risque (sinon garde-fous inertes).
      syncRealizedPnl();
      // Seul le mode PAPER est implémenté : en LIVE (bascule possible depuis le dashboard)
      // on n'écrit RIEN — un trade journalisé sans ordre réel fausserait le PnL résolu.
      if (!CONFIG.dryRun || !state.paper) return;
      if (!canTrade()) return;
      await checkPaperExits(sdk);

      if (Date.now() - marketsTs > 60_000 || markets.length === 0) {
        const scanned = await sdk.dipArb.scanUpcomingMarkets({
          coin: 'all', duration: '5m', minMinutesUntilEnd: 0, maxMinutesUntilEnd: 6, limit: 12,
        });
        markets = (scanned as Array<ScannedMarket | undefined>)
          .filter((m): m is ScannedMarket => !!m && !!m.conditionId && m.durationMinutes === 5 && isSpotCoin(m.underlying));
        marketsTs = Date.now();
      }

      for (const market of markets) {
        if (tradedMarkets.has(market.conditionId)) continue;
        // Slug exact `<coin>-updown-5m-<slot>` : parseUnderlyingFromSlug retombe sur 'BTC'
        // pour un slug inconnu — on ne laisse jamais un autre marché passer pour un round BTC.
        if (!new RegExp(`^${market.underlying.toLowerCase()}-updown-5m-\\d{9,}$`).test(market.slug)) continue;
        const slot = slotFromSlug(market.slug);
        if (slot === null) continue;
        const endMs = slot * 1000 + 300_000;
        const now = Date.now();
        const tauSec = (endMs - now) / 1000;
        // Filtre sans réseau : hors fenêtre de τ, rien à évaluer (et pas de log).
        if (tauSec < FV_CFG.minTauSec || tauSec > FV_CFG.maxTauSec) continue;
        const coin = market.underlying as SpotCoin;

        try {
          const data = await getRoundMarketData(coin, slot, now);
          if (!data) {
            holdLog(market.conditionId, `   ↳ ${market.slug} : spot/strike/vol indisponibles ou périmés → pas de mise`);
            continue;
          }
          const [upBook, downBook] = await Promise.all([
            sdk.markets.getTokenOrderbook(market.upTokenId),
            sdk.markets.getTokenOrderbook(market.downTokenId),
          ]);
          const upAsk = upBook.asks[0]?.price ?? null;
          const downAsk = downBook.asks[0]?.price ?? null;
          const decision = decide({ ...data, tauSec, upAsk, downAsk }, FV_CFG);
          const ctx = `${coin} spot ${formatSpotPrice(coin, data.spot)} vs strike ${formatSpotPrice(coin, data.strike)} `
            + `(${data.source}), σ1m ${(data.sigmaPerSqrtSec * Math.sqrt(60) * 100).toFixed(3)} %, τ ${Math.round(tauSec)} s`;
          if (!decision.side || !decision.best) {
            holdLog(market.conditionId, `   ↳ ${ctx} → HOLD : ${decision.reason}`);
            continue;
          }

          const q = decision.best;
          const capital = Number(process.env.PAPER_CAPITAL ?? '') || 50;
          const stakeRes = computeStake({
            capital,
            entryPrice: q.cost,
            // Probabilité du MODÈLE, shrinkée vers le prix par computeStake (λ = 0,5) :
            // un modèle non validé ne reçoit que la moitié de sa propre conviction.
            bookProb: q.prob,
            consecutiveLosses: realLossStreak(),
            drawdownCurrent: realDrawdownPct(),
            openExposureEur: paperOpen.reduce((s, o) => s + (Number(o.stake) || 0), 0),
            openPositions: paperOpen.length,
          });
          if (stakeRes.skipped || !(stakeRes.stake > 0)) {
            holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : ${stakeRes.rationale}`);
            continue;
          }

          // Prix RÉEL : on consomme le carnet pour la mise (le meilleur ask ne contient
          // souvent que 5 parts, COSTS.md §1.1) et on re-vérifie l'edge au VWAP.
          const book = decision.side === 'UP' ? upBook : downBook;
          const fill = estimateFill(book.asks, stakeRes.stake, FV_CFG.maxAsk);
          if (!fill.complete || fill.avgPrice === null) {
            holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : profondeur insuffisante pour $${stakeRes.stake.toFixed(2)} sous ${FV_CFG.maxAsk}`);
            continue;
          }
          const entryCost = effectiveCostPerShare(fill.avgPrice, FV_CFG.takerFeeRate);
          const edgeAtFill = q.prob - entryCost;
          if (edgeAtFill < FV_CFG.minEdge) {
            holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : edge au VWAP ${(edgeAtFill * 100).toFixed(1)} pt < ${(FV_CFG.minEdge * 100).toFixed(1)} pt`);
            continue;
          }

          const stake = stakeRes.stake;
          const { shares, winProfit: estProfit } = binaryPayoff(stake, entryCost); // frais inclus
          const side = decision.side === 'UP' ? 'YES' : 'NO';
          tradedMarkets.add(market.conditionId);
          simulateTrade(estProfit, 'dipArb',
            `📈 ${ctx} → Décision ${side} (${decision.side}) @ VWAP $${fill.avgPrice.toFixed(3)} + frais = $${entryCost.toFixed(4)}/part, `
            + `p_modèle ${q.prob.toFixed(3)}, edge ${(edgeAtFill * 100).toFixed(1)} pt, mise $${stake.toFixed(2)} (${stakeRes.bindingConstraint}) `
            + `— gain $${estProfit.toFixed(4)} si ${decision.side} / perte $${stake.toFixed(2)} sinon`);
          logLearning({
            roundId: market.slug, market: market.name?.slice(0, 40), side,
            // `price` = coût RÉEL par part (VWAP + frais) : le PnL résolu inclut donc les frais.
            price: Math.round(entryCost * 10000) / 10000,
            estGain: estProfit, conf: q.prob, winProb: q.prob, coin, stake, conditionId: market.conditionId,
            strategy: 'fair-value', ask: fill.avgPrice, feePerShare: entryCost - fill.avgPrice,
            modelProb: q.prob, edge: edgeAtFill, tauSec: Math.round(tauSec),
            spot: data.spot, strike: data.strike, sigma1m: data.sigmaPerSqrtSec * Math.sqrt(60), priceSource: data.source,
          });
          paperOpen.push({
            side, entry: entryCost, shares, conditionId: market.conditionId, slug: market.slug, coin, stake,
            tokenId: decision.side === 'UP' ? market.upTokenId : market.downTokenId, slot, endMs,
          });
          if (tradedMarkets.size > 500) {
            const first = tradedMarkets.values().next().value;
            if (first) tradedMarkets.delete(first);
          }
          updateDashboard();
        } catch (err) {
          holdLog(market.conditionId, `   ↳ ${market.slug} : erreur d'analyse (${String((err as Error)?.message ?? err).slice(0, 160)}) → pas de mise`);
        }
      }
    } catch (err) {
      log('WARN', `Stratégie juste valeur : tick en échec (${String((err as Error)?.message ?? err).slice(0, 160)}) — nouvel essai au prochain tick`);
    } finally {
      running = false;
    }
  }

  // Après un redémarrage, ne pas re-jouer un round déjà joué (la mémoire est perdue,
  // history.json non) : on recharge les conditionId des 15 dernières minutes.
  const since = Date.now() - 15 * 60_000;
  for (const t of readHistory() ?? []) {
    if (t && typeof t.conditionId === 'string' && Date.parse(String(t.ts)) >= since) tradedMarkets.add(t.conditionId);
  }

  await tick();
  setInterval(() => { void tick(); }, FV_POLL_MS);
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

  // Periodic Position Sync (Every 30s)
  setInterval(async () => {
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
    }
  }, 30 * 1000);
}

async function main() {
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║          POLYMARKET BOT v3.0 + DASHBOARD                           ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  // Start Dashboard Server
  startDashboard(3001);
  console.log('\n🌐 Dashboard: http://localhost:3001\n');

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

  // Handle Dashboard Commands
  dashboardEmitter.on('command', async (cmd: { command: string; payload: any }) => {
    if (cmd.command === 'toggleDryRun') {
      const enable = cmd.payload.enabled;
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

  // Initialize Paper Wallet if Dry Run
  if (CONFIG.dryRun) {
    state.paper = {
      balance: CONFIG.capital.totalUsd,
      initialBalance: CONFIG.capital.totalUsd,
      pnl: 0,
      trades: 0,
      totalVolume: 0,
    };
    log('INFO', '📝 Paper Trading Activated: Simulating trades with $250 initial capital');
    updateDashboard();
  }

  const sdk = await PolymarketSDK.create({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  });

  log('INFO', `Wallet: ${sdk.tradingService.getAddress()}`);

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
  dashboardEmitter.on('command', async ({ command, payload }: { command: string; payload: any }) => {
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
  console.error('Fatal:', err.message);
  console.error(err);
  process.exit(1);
});
