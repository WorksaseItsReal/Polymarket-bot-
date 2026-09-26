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
import { analyzeMarket, isEnabled } from './src/deepseek-analyzer.js';
import { getSpotPrice, formatSpotPrice, isSpotCoin, type SpotCoin } from './src/services/spot-price-service.js';

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
  if (state.isPaused && Date.now() < state.pauseUntil) return false;
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
function recordTrade(profit: number, strategy: string) {
  state.tradesExecuted++;
  state.dailyPnL += profit;
  state.monthlyPnL += profit;  // NEW
  state.totalPnL += profit;

  // Track consecutive wins/losses
  if (profit < 0) {
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

function logLearning(e: { roundId?: string; market?: string; side: string; price: number; estGain: number; conf: number; coin?: string; winProb?: number; conditionId?: string; stake?: number }) {
  try {
    // ⚠️ FIX 2026-09-25 : ne JAMAIS écrire les HOLD dans history.json.
    // Avant ce fix : 298 HOLD / 300 entrées (99,3 %) → la fenêtre de 300 ne
    // couvrait que ~4 h et les vrais trades en sortaient, rendant toute analyse
    // historique impossible. Les HOLD sont déjà visibles dans les logs
    // (`🎯 … → HOLD`) et ne portent aucune information de PnL.
    // Seules les décisions BUY/SELL et les résolutions restent dans
    // history.json, que le résolveur PnL lit.
    if (e.side === 'HOLD') return;

    const PATH = (process.env.HOME || '/root') + '/.polymarket/history.json';
    const h: any[] = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf-8')) : [];
    h.push({ ...e, ts: new Date().toISOString(), realized: 0 });
    if (h.length > 300) h.splice(0, h.length - 300);
    mkdirSync((process.env.HOME || '/root') + '/.polymarket', { recursive: true });
    writeFileSync(PATH, JSON.stringify(h, null, 2));
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

// === APPRENTISSAGE AUTO-ADAPTATIF (déterministe, zéro LLM) ===
// Lit history.json et apprend de ses RÉSULTATS RÉELS (TP/SL/résolutions) :
//  - sizing KELLY : fraction de mise optimale f* = p - (1-p)/b, où p = winrate,
//    b = gain_moyen / perte_moyenne (croissance exponentielle optimale).
//  - cooldown : si une coin est en dessous du seuil de survie, on ne mise plus.
//  - fenêtre par bucket de prix : on mesure la winrate par intervalle de prix
//    (0.55-0.60, 0.60-0.65, …) et on recentre la sweet-spot vers les buckets gagnants.
type CoinLearn = { sizeFactor: number; skip: boolean; recent: number; wr: number; pnl: number };
// Fenêtres de prix recommandées (résultat de l'apprentissage global).
type BucketStat = { bucket: string; lo: number; hi: number; n: number; wr: number; score: number };
let learnedMin = 0.58; let learnedMax = 0.65; let learnedBuckets: BucketStat[] = [];
// C6 (2026-09-26) : plafond Kelly ramené de 0.25 → 0.05 tant que n_resolus < 200.
// f* mesuré = 0.0205 → sizeFactor ≈ 1.04. Avec 0.25 la prod tournait à ×1.30/×1.50
// (= 12× la fraction mesurée). Voir docs/STRATEGY-REVIEW.md C6.
const kellyCeil = 0.05;     // jamais plus de 5% du risque sur une mise (prudence, n<200)
const kellyFloor = 0;

function computeCoinLearning(): Record<string, CoinLearn> {
  const out: Record<string, CoinLearn> = {};
  const allPriced: { price: number; realized: number }[] = [];
  try {
    const PATH = (process.env.HOME || '/root') + '/.polymarket/history.json';
    const h: any[] = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf-8')) : [];
    const byCoin: Record<string, any[]> = {};
    for (const t of h) {
      if (!t || !t.coin || t.side === 'HOLD') continue;
      if (typeof t.realized !== 'number') continue;   // seul un résultat final compte
      const price = typeof t.price === 'number' && t.price > 0 ? t.price : 0;
      (byCoin[t.coin] = byCoin[t.coin] || []).push(t);
      if (price > 0) allPriced.push({ price, realized: t.realized || 0 });
    }
    for (const coin of Object.keys(byCoin)) {
      const list = byCoin[coin].slice(-20);           // fenêtre: 20 derniers résolus
      const staff = list.filter(t => t.realized !== 0 && (t.realized > 0 || t.realized < 0));
      const pnl = list.reduce((s, t) => s + (t.realized || 0), 0);
      // ⚠️ ANTI-BLOCAGE (2026-09-26) : le cooldown ne doit JAMAIS être éternel.
      // Une coin en cooldown ne mise plus → ne produit plus de trade résolu → sa
      // fenêtre ne bouge plus → elle restait en cooldown POUR TOUJOURS. Observé en
      // prod : ETH/DOGE/XRP figées, le bot ne misait plus que sur BTC et SOL.
      // Correctif : ne juger la santé que sur des résultats RÉCENTS ; si la coin n'a
      // plus assez de résultats récents, on la ré-autorise pour regénérer l'échantillon.
      const COOLDOWN_MAX_AGE_H = Number(process.env.LEARN_COOLDOWN_AGE_H ?? '') || 6;
      const _nowMs = Date.now();
      const recent = staff.filter(t => {
        const ts = Date.parse(String(t.ts || ''));
        return Number.isFinite(ts) && (_nowMs - ts) <= COOLDOWN_MAX_AGE_H * 3_600_000;
      });
      // Sans assez de résultats RÉCENTS on NE juge PAS : `skip` reste false et la coin
      // peut re-miser. C'est le cœur du correctif : replier sur la fenêtre complète
      // réappliquait le cooldown sur des résultats vieux de 7 à 25 h → blocage éternel.
      const n = recent.length;
      const p = n ? recent.filter(t => t.realized > 0).length / n : 0;
      let sizeFactor = 1;
      let skip = false;
      if (n >= 5) {
        const hWins = recent.filter(t => t.realized > 0);
        const hLosses = recent.filter(t => t.realized < 0);
        const avgWin = hWins.length ? hWins.reduce((s, t) => s + t.realized, 0) / hWins.length : 0;
        const avgLoss = hLosses.length ? Math.abs(hLosses.reduce((s, t) => s + t.realized, 0)) / hLosses.length : 0.5;
        // Kelly : f* = p - (1-p)/b. Si l'espérance est <= 0 → cooldown.
        const b = avgLoss > 0 ? avgWin / avgLoss : 1;
        const edge = p * b - (1 - p);
        if (edge <= 0) {
          skip = true;
        } else {
          let kelly = p - (1 - p) / (b || 1);
          kelly = Math.max(kellyFloor, Math.min(kellyCeil, kelly));
          // Sécurités: ne jamais exploser la mise, levier progressif sur échantillon.
          sizeFactor = 1 + (kelly * 2);   // mise de base = forme déterministe
          if (sizeFactor < 0.5) sizeFactor = 0.65;
          if (sizeFactor > 2) sizeFactor = 2;
          if (n < 10) sizeFactor = Math.min(1.2, sizeFactor); // prudence si peu d'échantillon
        }
      }
      // Affichage = fenêtre complète (information) ; la DÉCISION ne porte que sur le récent.
      const nAll = staff.length;
      const pAll = nAll ? staff.filter(t => t.realized > 0).length / nAll : 0;
      out[coin] = { sizeFactor, skip, recent: nAll, wr: Math.round(pAll * 100), pnl: Math.round(pnl * 100) / 100 };
    }
    // === Apprentissage global : buckets de prix ===
    if (allPriced.length >= 25) {
      const buckets: BucketStat[] = [
        { bucket: '0.55-0.60', lo: 0.55, hi: 0.60, n: 0, wr: 0, score: 0 },
        { bucket: '0.60-0.65', lo: 0.60, hi: 0.65, n: 0, wr: 0, score: 0 },
        { bucket: '0.65-0.70', lo: 0.65, hi: 0.70, n: 0, wr: 0, score: 0 },
        { bucket: '0.70-0.75', lo: 0.70, hi: 0.75, n: 0, wr: 0, score: 0 },
      ];
      for (const { price, realized } of allPriced) {
        const b = buckets.find(x => price >= x.lo && price < x.hi);
        if (b) { b.n++; if (realized > 0) b.wr += 1; }
      }
      for (const b of buckets) if (b.n) b.wr /= b.n;
      // score = WR pondéré par la taille de l'échantillon (prudence sur données faibles)
      for (const b of buckets) {
        b.score = b.n >= 5 ? (b.wr - 0.50) * Math.min(1, b.n / 15) : 0;
      }
      // Recentre la fenêtre sur LES buckets gagnants (score > 0), sinon garde défaut.
      const good = buckets.filter(b => b.score > 0 && b.n >= 5);
      learnedBuckets = buckets;
      if (good.length) {
        const cfgMin = Number(process.env.P_STRONG_MIN ?? '') || 0.58;
        const cfgMax = Number(process.env.P_STRONG_MAX ?? '') || 0.65;
        learnedMin = Math.min(...good.map(b => b.lo));
        learnedMax = Math.max(...good.map(b => b.hi));
        // Fenêtre auto-adaptative BORNÉE par la config .env (C2 2026-09-26).
        // Sans ce clamp, l'apprentissage repoussait le plafond à 0.75-0.80 et
        // annulait P_STRONG_MAX=0.65 (cf. docs/STRATEGY-REVIEW.md C2).
        learnedMin = Math.max(cfgMin, learnedMin);
        learnedMax = Math.min(cfgMax, learnedMax);
      } else {
        learnedMin = (Number(process.env.P_STRONG_MIN ?? '') || 0.58);
        learnedMax = (Number(process.env.P_STRONG_MAX ?? '') || 0.65);
      }
    }
  } catch (err) { log('WARN', `learning: ${(err as Error).message}`); }
  return out;
}
function showLearningSummary(l: Record<string, CoinLearn>) {
  const lines = Object.entries(l).map(([c, v]) =>
    `${c}: WR ${v.wr}% (${v.recent}) ${v.skip ? '❄️ cooldown' : `×${v.sizeFactor.toFixed(2)}`}`
  );
  if (lines.length) log('LEARN', `Auto-adaptation coins → ${lines.join(' | ')}`);
  // montre aussi la fenêtre apprise
  log('LEARN', `Fenêtre apprise → [${learnedMin.toFixed(2)} - ${learnedMax.toFixed(2)}] (étude ${learnedBuckets.map(b => `${b.bucket}:${b.n?Math.round(b.wr*100):0}%`).join(' ')})`);
}

function simulateTrade(profit: number, strategy: string, description: string) {
  if (!CONFIG.dryRun || !state.paper) return;

  state.paper.trades++;
  state.paper.pnl += profit;
  state.paper.balance += profit;

  // Log as a special SIMULATION event
  log('TRADE', `[SIMULATION] ${description} | Est. Profit: $${profit.toFixed(2)}`);
  // Update main PnL so the user sees movement on the dashboard (as requested)
  recordTrade(profit, strategy);
}

// === VENTE au take-profit (paper) ===
// Pour chaque position ouverte, on vérifie le prix live : si le gain projeté
// atteint P_TAKE_PROFIT (défaut 100% = on ne vend plus 1% sous la résolution,
// cf. C3), on clique la position et on lock le gain.
// ⚠️ Le stop-loss (P_STOP_LOSS) de la même boucle est INERTE sur un round
// binaire tout-ou-rien (voir le commentaire détaillé plus bas) : ne pas le
// présenter comme un contrôle de risque.
async function checkPaperTakeProfit(sdk: PolymarketSDK) {
  if (!CONFIG.dryRun || !state.paper || paperOpen.length === 0) return;
  const tpPct = (Number(process.env.P_TAKE_PROFIT ?? '') || 100) / 100;
  const slPct = (Number(process.env.P_STOP_LOSS ?? '') || 40) / 100;
  const stillOpen: typeof paperOpen = [];
  for (const pos of paperOpen) {
    // ⚠️ FIX 2026-09-25 : ne JAMAIS réinterroger l'orderbook d'un round TERMINÉ.
    // Le round est binaire et résolu : ses token ids sont périmés et la requête
    // CLOB renvoie `404 No orderbook exists for the requested token id` (côté
    // lib clob-client → console.error → paperbot.error.log). Avant ce fix, la
    // position restait dans paperOpen pour toujours et était re-demandée toutes
    // les 5 min (1564 occurrences par token, 6 tokens distincts). La résolution
    // du round (PnL) n'est PAS faite ici : elle appartient au résolveur.
    const roundEnd = roundEndMsFromSlug(pos.slug);
    if (roundEnd !== null && Date.now() > roundEnd + 30_000) {
      continue;  // round terminé → position abandonnée au résolveur, plus de requête
    }
    try {
      const ob = await sdk.getOrderbook(pos.conditionId);
      const price = pos.side === 'YES' ? (ob.yes?.bid || pos.entry) : ((ob.no?.bid ?? Math.min(1 - (ob.yes?.bid || pos.entry), 0.999)) || pos.entry);
      // Gain projeté si on vend maintenant : (prix_vente - prix_entrée)
      const gain = price - pos.entry;             // sur 1€ de côté acheté
      const gainPct = (price / pos.entry) - 1;
      // Take-profit ADAPTATIF : on prend le gain dès qu'on a capturé une part
      // significative (30%) du gain MAX possible jusqu'à la fin du round
      // (1/entry - 1). Fixe à % du max → réalisable même sur un entry cher à 0.85.
      const maxGainPct = (1 / pos.entry) - 1;
      const tpReached = maxGainPct > 0 && gainPct >= maxGainPct * tpPct;
      if (tpReached) {
        // On vend : profit = gain sur la part (1/entry actions, vendues à price)
        const profit = (1 / pos.entry) * price - 1;   // gain net sur 1€ de mise
        state.paper.pnl += profit;
        state.paper.balance += profit;
        log('TRADE', `[SIMULATION] 💰 VENTE au take-profit: ${pos.coin} ${pos.side} @ $${price.toFixed(3)} (gain +$${profit.toFixed(2)}, ~${(gainPct*100).toFixed(0)}%) — position clôturée`);
        log('TRADE', `[SIMULATION] VENTE ${pos.coin} ${pos.side} @ $${price.toFixed(3)} (round ${pos.slug || pos.conditionId.slice(0,10)}) — gain réalisé +$${profit.toFixed(2)}`);
        // Marque la sortie dans le history (le résolveur PnL ne re-résoudra pas)
        try {
          const HPATH = (process.env.HOME || '/root') + '/.polymarket/history.json';
          const h: any[] = existsSync(HPATH) ? JSON.parse(readFileSync(HPATH, 'utf-8')) : [];
          const entry = h.find(x => x.conditionId === pos.conditionId && x.side === pos.side && !x.soldTp);
          if (entry) { entry.realized = Math.round(profit * 10000) / 10000; entry.soldTp = true; entry.tpPct = Math.round(gainPct * 100); }
          writeFileSync(HPATH, JSON.stringify(h, null, 2));
        } catch { /* non bloquant */ }
      } else if (gainPct <= -slPct) {
        // ⚠️ STOP-LOSS — INERTE sur un round binaire (documenté, ne pas vendre
        // comme contrôle de risque). Mesure 2026-09-25 sur 63 trades résolus :
        // 20/20 pertes à −1,0000 exactement, ZÉRO perte coupée par ce gate.
        // Un round « Up/Down 5m » est tout-ou-rien : le token ne glisse pas
        // continûment vers un prix de sortie, il vaut ~entry puis paie
        // 1/entry−1 ou −1. Le SEUL levier de perte est le PRIX D'ENTRÉE (filtre
        // d'edge `p > entry`) — pas ce stop. Code conservé car inoffensif
        // (il ne peut se déclencher que sur un orderbook intermédiaire réel).
        const loss = (1 / pos.entry) * price - 1;  // perte nette sur 1€
        state.paper.pnl += loss;
        state.paper.balance += loss;
        log('TRADE', `[SIMULATION] ⛔ STOP-LOSS: ${pos.coin} ${pos.side} @ $${price.toFixed(3)} (perte $${loss.toFixed(2)}, ~${(gainPct*100).toFixed(0)}%) — position coupée`);
        log('TRADE', `[SIMULATION] STOP-LOSS ${pos.coin} ${pos.side} @ $${price.toFixed(3)} (round ${pos.slug || pos.conditionId.slice(0,10)}) — perte limitée $${loss.toFixed(2)}`);
        try {
          const HPATH = (process.env.HOME || '/root') + '/.polymarket/history.json';
          const h: any[] = existsSync(HPATH) ? JSON.parse(readFileSync(HPATH, 'utf-8')) : [];
          const entry = h.find(x => x.conditionId === pos.conditionId && x.side === pos.side && !x.soldTp);
          if (entry) { entry.realized = Math.round(loss * 10000) / 10000; entry.soldTp = true; entry.sl = true; }
          writeFileSync(HPATH, JSON.stringify(h, null, 2));
        } catch { /* non bloquant */ }
      } else {
        stillOpen.push(pos);
      }
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
      const stake = Number(process.env.BET_STAKE ?? '') || 1; // mise simulée (.env BET_STAKE)
      // Taux de profit estimé du signal (leg1: estimatedProfitRate, leg2: expectedProfitRate)
      const profitRate = (s as any).estimatedProfitRate ?? (s as any).expectedProfitRate;
      let estProfit = 0;
      if (typeof profitRate === 'number' && Number.isFinite(profitRate)) {
        estProfit = stake * (profitRate - 1);  // profitRate en ratio (ex 1.08 -> +8%)
      } else if ((s.currentPrice || 0) > 0) {
        // rendement d'une mise de 1€ sur un up/down: si le bon côté gagne, retour = 1/prix
        const p = s.currentPrice || 1;
        estProfit = stake * ((1 / p) - 1);
      }
      const pStr = (s.currentPrice || 0).toFixed(3);
      simulateTrade(estProfit, 'dipArb', `Décision ${s.type} ${side} @ $${pStr} — mise simulée $${stake.toFixed(2)}, gain est. $${estProfit.toFixed(4)} si ${side} gagne (x${((1 / (s.currentPrice || 1))).toFixed(2)})`);
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
// Positions paper ouvertes (achat simulé) — clôturées au take-profit ou à la résolution.
let paperOpen: Array<{ side: string; entry: number; conditionId: string; slug: string; coin: string }> = [];

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

async function setupLLMAnalysis(sdk: PolymarketSDK) {
  const enabled = isEnabled();
  log('INFO', `🤖 DeepSeek LLM analysis module: ${enabled ? 'ENABLED (remote analysis)' : 'DEGRADED (local HOLD — no API key / not enabled)'}`);

  async function runAnalysisLoop() {
    // Respect multi-layer risk gate: no trade activity if broker is halted/paused
    if (!canTrade()) return;

    try {
      // Clôture les positions paper au take-profit (vérifie les gains projetés)
      await checkPaperTakeProfit(sdk);
      // Analyser TUNIQUEMENT les marchés BTC & ETH Up/Down 5m (ceux demandés),
      // pas les "trending" globaux (Fed/ATP).
      const upcoming = (await sdk.dipArb.scanUpcomingMarkets({
        coin: 'all',
        duration: '5m',
        minMinutesUntilEnd: 0,
        maxMinutesUntilEnd: 6,
        limit: 8,
      }) as Array<{ conditionId: string; name: string; underlying: string; durationMinutes: number; slug: string; endTime: Date } | undefined>)
        .filter((m): m is NonNullable<typeof m> => !!m)
        .filter(m => m.underlying === 'BTC' || m.underlying === 'ETH' || m.underlying === 'SOL' || m.underlying === 'XRP' || m.underlying === 'DOGE');

      // === APPRENTISSAGE AUTO-ADAPTATIF (1x par tick, zéro LLM) ===
      // Le bot analyse ses RÉSULTATS RÉELS (TP/SL/résolutions) par coin et
      // ajuste: cooldown (skip) si win rate < 40% sur les 15 derniers,
      // taille ×0.65/×1.10/×1.30 selon la santé de la coin.
      const coinLearn = computeCoinLearning();
      showLearningSummary(coinLearn);

      for (const market of upcoming) {
        if (!market.conditionId) continue;

        try {
          // Prix live du sous-jacent via REST (Binance→Coinbase→Kraken).
          // Le WebSocket Polymarket est mort côté serveur (0 message) : sans ce
          // flux le bot n'avait aucun prix réel. Affiché dans CHAQUE ligne de
          // scan pour prouver que les prix sont vivants.
          const spotCoin = isSpotCoin(market.underlying) ? (market.underlying as SpotCoin) : null;
          const spot = spotCoin ? await getSpotPrice(spotCoin).catch(() => null) : null;
          const spotLine = spotCoin
            ? `📈 ${spotCoin}/USD ${spot ? formatSpotPrice(spotCoin, spot.price) : 'n/a'}`
            : `📈 ${market.underlying}/USD n/a`;

          const orderbook = await sdk.getOrderbook(market.conditionId);

          // --- Filtrage en amont (avant tout appel LLM) ---
          const yes = orderbook.yes;
          const spreadPct = yes.bid > 0 ? (yes.ask - yes.bid) / yes.bid : 1;
          const liquidity = Math.max(
            orderbook.yes.bidDepth,
            orderbook.yes.askDepth,
            orderbook.no.bidDepth,
            orderbook.no.askDepth
          );

          // spread < 15% ET liquidité > 100$ : garde minimale sans bloquer les
          // marchés à orderbook clairsemé (favori extrême). Moins strict qu'avant
          // (5%/1000$) — sinon tous les rounds 5-min passent en HOLD silencieux.
          if (!(spreadPct < 0.15) || !(liquidity > 100)) {
            log('SIGNAL', `   ↳ ${spotLine} · ${market.slug} spread ${(spreadPct * 100).toFixed(1)}% / liq $${liquidity.toFixed(0)} → skip (filtre spread/liquidité)`);
            continue;
          }

          // === ÉCONOMIE D'APPELS LLM (budget 30/jour) ===
          // N'appeler le modèle QUE si l'ordre montre déjà un favori net (edge ≥ seuil).
          // Sinon marché ~50/50 → HOLD direct SANS dépenser un appel (le LLM dirait HOLD de toute façon).
          const _yesAsk = orderbook.yes?.ask || 0.5;
          const _noAsk = orderbook.no?.ask ?? Math.min(1 - _yesAsk, 0.99);
          // Sur Polymarket binaire, le PRIX du token = sa probabilité.
          // Prix du token YES ≈ P(UP), prix du token NO ≈ P(DOWN).
          const _yesImp = _yesAsk;          // proba UP
          const _noImp = _noAsk;            // proba DOWN
          const STRONG_MIN2 = Number(process.env.P_STRONG_MIN ?? '') || 0.58;
          const STRONG_MAX2 = Number(process.env.P_STRONG_MAX ?? '') || 0.65;
          const MIN_PRICE2 = Number(process.env.P_MIN_PRICE ?? '') || 0.25;
          // Sweet spot : favori entre MIN et MAX (≥58% favori, mais jamais écrasant à
          // 0.89+ dont le gain est inutilement petit). Où le gain compense les pertes.
          const _yesIn = _yesImp >= STRONG_MIN2 && _yesImp <= STRONG_MAX2 && _yesAsk >= MIN_PRICE2;
          const _noIn = _noImp >= STRONG_MIN2 && _noImp <= STRONG_MAX2 && _noAsk >= MIN_PRICE2;
          const hasEdge = _yesIn || _noIn;
          if (!hasEdge) {
            // ~50/50 → pas d'edge → HOLD sans appeler le LLM (économie d'appels)
            // ⚠️ ask_YES + ask_NO ≈ 1 + spread : afficher les deux bruts donnait
            // « UP 54% / DOWN 47% » (= 101 %). On normalise pour sommer à 100 %.
            const _totImp = (_yesImp + _noImp) || 1;
            log('SIGNAL',   `   ↳ ${spotLine} · ${market.name?.slice(0, 30)} ~50/50 (UP ${(100 * _yesImp / _totImp).toFixed(0)}% / DOWN ${(100 * _noImp / _totImp).toFixed(0)}%) → HOLD (pas de LLM)`);
            logLearning({ roundId: market.slug || currentRoundId, market: market.name?.slice(0, 40), side: 'HOLD', price: 0, estGain: 0, conf: 0, coin: market.underlying, conditionId: market.conditionId });
            continue;
          }

          // === DÉCISION 100% DÉTERMINISTE (basée uniquement sur l'orderbook) ===
          // Aucun appel LLM ni réseau externe : on mise le CÔTÉ LE PLUS PROBABLE
          // (le favori de l'ordre) dans la fenêtre "sweet spot". Zéro coût LLM,
          // décision stable, winrate lié à la qualité des probabilités du marché.
          if (CONFIG.dryRun && state.paper) {
            const yesAsk = orderbook.yes?.ask || 0.5;
            const noAsk = orderbook.no?.ask ?? Math.min(1 - yesAsk, 0.99);
            // Prix d'un token = sa probabilité. yes.ask ≈ P(UP), no.ask ≈ P(DOWN).
            const yesImp = yesAsk;   // probabilité implicite UP
            const noImp = noAsk;     // probabilité implicite DOWN

            // Comment on décide (sans LLM) :
            //  - On ne mise QUE le favori (côté avec la proba la plus haute) s'il est
            //    dans la fenêtre [STRONG_MIN, STRONG_MAX]. Le favori net gagne plus
            //    souvent que 50% → winrate élevé.
            //  - 0.89+ (favori écrasant) → gain trop petit (+$0.1) → on saute
            //    (ça ne vaut pas le risque d'une perte -$1).
            //  - < 0.58 (~50/50) → pas un vrai favori → on refuse (winrate ≈ 50%).
            let side: 'YES' | 'NO' | null = null;
            let reason = '';
            // Fenêtre sweet-spot : celle APPRISE (auto-adaptative) sinon config .env.
            const STRONG_MIN = learnedMax ? learnedMin : ((Number(process.env.P_STRONG_MIN ?? '') || 0.58));
            const STRONG_MAX = learnedMin ? learnedMax : ((Number(process.env.P_STRONG_MAX ?? '') || 0.65));
            const MIN_PRICE = Number(process.env.P_MIN_PRICE ?? '') || 0.25;
            const yesIn = yesImp >= STRONG_MIN && yesImp <= STRONG_MAX && yesAsk >= MIN_PRICE;
            const noIn = noImp >= STRONG_MIN && noImp <= STRONG_MAX && noAsk >= MIN_PRICE;

            if (yesIn && yesImp >= noImp) {
              side = 'YES'; reason = ' (favori ordre)';
            } else if (noIn) {
              side = 'NO'; reason = ' (favori ordre)';
            } else {
              // Idem : normaliser (ask_YES + ask_NO ≈ 1 + spread → sinon 101 %).
              const _totImp2 = (yesImp + noImp) || 1;
              log('SIGNAL', `   ↳ ${spotLine} · ${market.name?.slice(0, 30)} pas de favori net (UP ${(100 * yesImp / _totImp2).toFixed(0)}% / DOWN ${(100 * noImp / _totImp2).toFixed(0)}%) → PAS de mise`);
              logLearning({ roundId: market.slug || currentRoundId, market: market.name?.slice(0, 40), side: 'HOLD', price: 0, estGain: 0, conf: 0, coin: market.underlying, conditionId: market.conditionId });
            }
            if (side) {
              const buyPrice = side === 'YES' ? yesAsk : noAsk;
              // === APPRENTISSAGE : cooldown automatique ===
              // Si la coin est en "cooldown santé" (espérance négative), on refuse.
              const learn = coinLearn[market.underlying];
              if (learn && learn.skip) {
                log('LEARN', `   ↳ ${market.name?.slice(0, 30)} coin ${market.underlying} en cooldown (WR ${learn.wr}%) → PAS de mise`);
                continue;
              }
              // === FILTRE D'EDGE STRICT (C5 — DÉSACTIVÉ par défaut) ===
              // ⚠️ C5 (2026-09-26) : le `wr` par coin était calculé sur des `realized`
              // FAUX (résolveur PnL cassé, cf. C1 : 44,4 % affiché vs 68,3 % réel) →
              // ce filtre bloquait des coins gagnants. Backtest séquentiel sur les
              // 63 trades : filtre actif = 42 trades, −1,678 € ; sans filtre = 63
              // trades, +0,619 €. Neutralisé derrière EDGE_FILTER_ENABLED (défaut
              // false) pour pouvoir le ré-activer quand les données seront fiables.
              const EDGE_FILTER_ENABLED = (process.env.EDGE_FILTER_ENABLED ?? 'false').toLowerCase() === 'true';
              if (EDGE_FILTER_ENABLED && learn && learn.recent >= 8 && learn.wr > 0) {
                const requiredWr = (buyPrice + 0.10) * 100;   // doit battre prix +10pts
                if (learn.wr < requiredWr) {
                  log('LEARN', `   ↳ ${market.name?.slice(0, 30)} ${market.underlying} WR ${learn.wr}% < edge requis ${requiredWr.toFixed(0)}% (prix $${buyPrice.toFixed(2)}+10pts) → PAS de mise (edge négatif)`);
                  continue;
                }
              }
              // taille auto-adaptée selon la santé de la coin (×0.65 / ×1.10 / ×1.30)
              const sizeFactor = learn ? learn.sizeFactor : 1;
              // ⚠️ AVANT (2026-09-26) : `sizeFactor` était calculé puis affiché dans le
              // message, mais `simulateTrade()` recevait `(1/buyPrice) - 1` — le Kelly
              // auto-adaptatif (×0.65 / ×1.10) n'était donc JAMAIS crédité au PnL :
              // purement cosmétique. On applique maintenant sizeFactor ET la mise de base.
              const BET_STAKE = Number(process.env.BET_STAKE ?? '') || 1;
              // gain si le côté choisi gagne: retour = 1/prix sur la mise
              const estProfit = ((1 / buyPrice) - 1) * sizeFactor * BET_STAKE;
              const conf = side === 'YES' ? yesImp : noImp;
              simulateTrade(estProfit, 'dipArb', `${spotLine} → Décision ${side} @ $${buyPrice.toFixed(3)} (round ${market.slug || market.name?.slice(-22)}, conf ${conf.toFixed(2)}, mise ×${sizeFactor.toFixed(2)})${reason} — gain est. $${estProfit.toFixed(4)} si ${side} gagne (x${(1 / buyPrice).toFixed(2)})`);
              logLearning({ roundId: market.slug || currentRoundId, market: market.name?.slice(0, 40), side, price: buyPrice, estGain: ((1 / buyPrice) - 1) * BET_STAKE, conf, coin: market.underlying, stake: BET_STAKE, conditionId: market.conditionId, winProb: conf });
              // Ouvre la position paper (sera clôturée au take-profit ou résolue à la fin du round)
              paperOpen.push({ side, entry: buyPrice, conditionId: market.conditionId, slug: market.slug || '', coin: market.underlying });
            }
          }
          updateDashboard();
        } catch {
          /* skip market — analyse non bloquante */
        }
      }
    } catch {
      /* trending markets indisponibles — on retente au prochain tick */
    }
  }

  await runAnalysisLoop();
  setInterval(runAnalysisLoop, 5 * 60 * 1000);
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
  await setupLLMAnalysis(sdk);

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
