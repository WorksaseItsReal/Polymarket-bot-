/**
 * Session History Service
 * Saves and loads trading session history to/from a JSON file
 */

import { existsSync, renameSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Types
export interface TradeRecord {
  id: string;
  timestamp: string;
  strategy: 'smartMoney' | 'arbitrage' | 'dipArb' | 'direct' | 'fairValue';
  market: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  profit: number;
  wallet?: string;
  txHash?: string;
}

export interface SessionSummary {
  id: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  totalPnL: number;
  startingBalance: number;
  endingBalance: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgProfitPerTrade: number;
  largestWin: number;
  largestLoss: number;
  strategyStats: {
    smartMoney: { trades: number; profit: number };
    arbitrage: { trades: number; profit: number };
    dipArb: { trades: number; profit: number };
    direct: { trades: number; profit: number };
  };
  walletPerformance: {
    wallet: string;
    trades: number;
    profit: number;
    winRate: number;
  }[];
  onChainOps: {
    splits: number;
    merges: number;
    redeems: number;
    swaps: number;
  };
  trades: TradeRecord[];
  dryRun: boolean;
  strategies: {
    smartMoney: boolean;
    arbitrage: boolean;
    dipArb: boolean;
    direct: boolean;
  };
}

export interface HistoryData {
  sessions: SessionSummary[];
  totalSessions: number;
  totalProfit: number;
  totalTrades: number;
  overallWinRate: number;
}

// History file path
const DATA_DIR = join(__dirname, '../../data');
const HISTORY_FILE = join(DATA_DIR, 'session-history.json');

/**
 * Ensure data directory exists
 */
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Load history from file
 */
export function loadHistory(): HistoryData {
  ensureDataDir();
  
  if (!existsSync(HISTORY_FILE)) {
    return emptyHistory();
  }

  try {
    const data = readFileSync(HISTORY_FILE, 'utf-8');
    const parsed = JSON.parse(data) as Partial<HistoryData> | null;
    // ⚠️ Le fichier peut être tronqué (kill pendant un write), édité à la main
    // ou hérité d'un ancien format. Sans normalisation, `history.sessions.reduce`
    // dans `addSession` lève et plus AUCUNE session n'est jamais enregistrée.
    return normalizeHistory(parsed);
  } catch (error) {
    console.error('[SessionHistory] Error loading history:', error);
    return emptyHistory();
  }
}

/** Historique vide (objet neuf à chaque appel). */
function emptyHistory(): HistoryData {
  return {
    sessions: [],
    totalSessions: 0,
    totalProfit: 0,
    totalTrades: 0,
    overallWinRate: 0,
  };
}

/**
 * FAIL-SAFE : force la forme attendue. Toute partie manquante ou d'un mauvais
 * type est remplacée par une valeur neutre au lieu de propager `undefined`.
 */
function normalizeHistory(raw: Partial<HistoryData> | null): HistoryData {
  if (!raw || typeof raw !== 'object') return emptyHistory();

  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  const totalTrades = sessions.reduce((sum, s) => sum + (Number(s?.totalTrades) || 0), 0);
  const totalWins = sessions.reduce((sum, s) => sum + (Number(s?.wins) || 0), 0);

  return {
    sessions,
    totalSessions: sessions.length,
    totalProfit: sessions.reduce((sum, s) => sum + (Number(s?.totalPnL) || 0), 0),
    totalTrades,
    overallWinRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
  };
}

/**
 * Save history to file
 */
export function saveHistory(history: HistoryData): void {
  ensureDataDir();
  
  try {
    // Écriture atomique : un arrêt pendant l'écriture ne laisse jamais un fichier tronqué.
    const tmp = `${HISTORY_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(history, null, 2));
    renameSync(tmp, HISTORY_FILE);
    console.log('[SessionHistory] History saved successfully');
  } catch (error) {
    console.error('[SessionHistory] Error saving history:', error);
  }
}

/**
 * Add a new session to history
 */
export function addSession(session: SessionSummary): void {
  // Fichier présent mais illisible : on ne l'écrase pas (avant : un fichier tronqué était
  // remplacé par la seule nouvelle session, tout l'historique perdu). On le met de côté.
  if (existsSync(HISTORY_FILE)) {
    try {
      JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    } catch (e) {
      // Mis de côté seulement s'il est CORROMPU ; une erreur de lecture passagère (fichiers
      // ouverts, droits) ne doit pas faire disparaître un historique valide.
      if (!(e instanceof SyntaxError)) {
        console.error('[SessionHistory] historique illisible pour le moment, session non enregistrée :', (e as Error).message);
        return;
      }
      try {
        renameSync(HISTORY_FILE, `${HISTORY_FILE}.illisible-${Date.now()}`);
      } catch (err) {
        console.error('[SessionHistory] historique corrompu non déplaçable, session non enregistrée :', (err as Error).message);
        return;
      }
    }
  }
  const history = loadHistory();
  
  // Add session at the beginning (newest first)
  history.sessions.unshift(session);
  
  // Recalculate totals
  history.totalSessions = history.sessions.length;
  history.totalProfit = history.sessions.reduce((sum, s) => sum + s.totalPnL, 0);
  history.totalTrades = history.sessions.reduce((sum, s) => sum + s.totalTrades, 0);
  
  const totalWins = history.sessions.reduce((sum, s) => sum + s.wins, 0);
  history.overallWinRate = history.totalTrades > 0 ? (totalWins / history.totalTrades) * 100 : 0;
  
  // Keep only last 100 sessions to prevent file from growing too large
  if (history.sessions.length > 100) {
    history.sessions = history.sessions.slice(0, 100);
  }
  
  saveHistory(history);
}

/**
 * Create a session summary from current bot state
 */
export function createSessionFromState(
  startTime: number,
  state: {
    totalPnL: number;
    tradesExecuted: number;
    smartMoneyTrades: number;
    arbTrades: number;
    dipArbTrades: number;
    directTrades: number;
    arbProfit: number;
    followedWallets: string[];
    splits: number;
    merges: number;
    redeems: number;
    swaps: number;
    usdcBalance: number;
    usdcEBalance: number;
  },
  config: {
    dryRun: boolean;
    smartMoney: { enabled: boolean };
    arbitrage: { enabled: boolean };
    dipArb: { enabled: boolean };
    directTrading: { enabled: boolean };
  },
  trades: TradeRecord[] = []
): SessionSummary {
  const endTime = Date.now();
  const durationMs = endTime - startTime;
  
  // Calculate wins/losses from trades
  const wins = trades.filter(t => t.profit > 0).length;
  const losses = trades.filter(t => t.profit < 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  // Si le détail des trades n'est pas fourni, `trades.length` vaut 0 alors que
  // `state.tradesExecuted` peut être > 0 → on retombe sur ce dernier pour que
  // « P&L moyen par trade » ne soit pas silencieusement affiché à 0.
  const tradeCount = trades.length > 0 ? trades.length : state.tradesExecuted;
  const avgProfitPerTrade = tradeCount > 0 ? state.totalPnL / tradeCount : 0;
  const largestWin = trades.length > 0 ? Math.max(...trades.map(t => t.profit), 0) : 0;
  const largestLoss = trades.length > 0 ? Math.min(...trades.map(t => t.profit), 0) : 0;
  
  // Calculate wallet performance
  const walletMap = new Map<string, { trades: number; profit: number; wins: number }>();
  trades.filter(t => t.wallet).forEach(t => {
    const existing = walletMap.get(t.wallet!) || { trades: 0, profit: 0, wins: 0 };
    existing.trades++;
    existing.profit += t.profit;
    if (t.profit > 0) existing.wins++;
    walletMap.set(t.wallet!, existing);
  });
  
  const walletPerformance = Array.from(walletMap.entries()).map(([wallet, data]) => ({
    wallet,
    trades: data.trades,
    profit: data.profit,
    winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
  })).sort((a, b) => b.profit - a.profit);
  
  // Calculate strategy profits (estimated from trade counts if no detailed data)
  const strategyStats = {
    smartMoney: { 
      trades: state.smartMoneyTrades, 
      profit: trades.filter(t => t.strategy === 'smartMoney').reduce((s, t) => s + t.profit, 0) 
    },
    arbitrage: { 
      trades: state.arbTrades, 
      profit: state.arbProfit 
    },
    dipArb: { 
      trades: state.dipArbTrades, 
      profit: trades.filter(t => t.strategy === 'dipArb').reduce((s, t) => s + t.profit, 0) 
    },
    direct: { 
      trades: state.directTrades, 
      profit: trades.filter(t => t.strategy === 'direct').reduce((s, t) => s + t.profit, 0) 
    },
  };
  
  const startingBalance = state.usdcBalance + state.usdcEBalance - state.totalPnL;
  
  return {
    id: `session-${startTime}`,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    durationMs,
    totalPnL: state.totalPnL,
    startingBalance: Math.max(0, startingBalance),
    endingBalance: state.usdcBalance + state.usdcEBalance,
    totalTrades: state.tradesExecuted,
    wins,
    losses,
    winRate,
    avgProfitPerTrade,
    largestWin,
    largestLoss,
    strategyStats,
    walletPerformance,
    onChainOps: {
      splits: state.splits,
      merges: state.merges,
      redeems: state.redeems,
      swaps: state.swaps,
    },
    trades,
    dryRun: config.dryRun,
    strategies: {
      smartMoney: config.smartMoney.enabled,
      arbitrage: config.arbitrage.enabled,
      dipArb: config.dipArb.enabled,
      direct: config.directTrading.enabled,
    },
  };
}

/**
 * Get history summary (without full trade details for lighter response)
 */
export function getHistorySummary(): HistoryData {
  const history = loadHistory();
  
  // Return sessions without full trade arrays for lighter response
  return {
    ...history,
    sessions: history.sessions.map(s => ({
      ...s,
      trades: [], // Don't include full trades in summary
    })),
  };
}

/**
 * Get a specific session with full details
 */
export function getSession(sessionId: string): SessionSummary | null {
  const history = loadHistory();
  return history.sessions.find(s => s.id === sessionId) || null;
}

/**
 * Delete a session
 */
export function deleteSession(sessionId: string): boolean {
  const history = loadHistory();
  const index = history.sessions.findIndex(s => s.id === sessionId);
  
  if (index === -1) return false;
  
  history.sessions.splice(index, 1);
  
  // Recalculate totals
  history.totalSessions = history.sessions.length;
  history.totalProfit = history.sessions.reduce((sum, s) => sum + s.totalPnL, 0);
  history.totalTrades = history.sessions.reduce((sum, s) => sum + s.totalTrades, 0);
  
  const totalWins = history.sessions.reduce((sum, s) => sum + s.wins, 0);
  history.overallWinRate = history.totalTrades > 0 ? (totalWins / history.totalTrades) * 100 : 0;
  
  saveHistory(history);
  return true;
}

/**
 * Clear all history
 */
export function clearHistory(): void {
  saveHistory({
    sessions: [],
    totalSessions: 0,
    totalProfit: 0,
    totalTrades: 0,
    overallWinRate: 0,
  });
}
