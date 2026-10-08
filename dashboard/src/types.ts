export interface DipArbSignal {
  id: string;
  timestamp: string;
  type: 'dip' | 'surge' | 'leg1' | 'leg2';
  side: 'UP' | 'DOWN';
  price: number;
  change: number;
}

export interface ArbOpportunity {
  timestamp: string;
  type: 'long' | 'short';
  profitPct: number;
  market: string;
}

export interface SmartMoneySignal {
  id: string;
  timestamp: string;
  wallet: string;
  market: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
}

export interface BotState {
  startTime: number;
  dailyPnL: number;
  totalPnL: number;
  consecutiveLosses: number;
  tradesExecuted: number;
  isPaused: boolean;
  pauseUntil: number;
  smartMoneyTrades: number;
  arbTrades: number;
  dipArbTrades: number;
  directTrades: number;
  /** Paris de la stratégie juste valeur (session en cours). */
  fairValueTrades?: number;
  /** Résumé de la stratégie juste valeur (mêmes lignes que le bilan Telegram). */
  fairValueSummary?: {
    shadow: string;
    goLive: string;
    openPositions: Array<{ coin: string; side: 'UP' | 'DOWN'; stake: number; costPerShare: number; endMs: number }>;
  };
  /** Statistiques RÉELLES du registre papier (toutes sessions), source de vérité. */
  ledger?: {
    trades: number;
    wins: number;
    losses: number;
    open: number;
    winRate: number | null;
    pnl: number;
    tStat: number | null;
  };
  arbProfit: number;
  followedWallets: string[];
  activeArbMarket: string | null;
  activeDipArbMarket: string | null;
  splits: number;
  merges: number;
  redeems: number;
  swaps: number;
  usdcBalance: number;
  usdcEBalance: number;
  maticBalance: number;
  unrealizedPnL: number;
  btcTrend: 'up' | 'down' | 'neutral';
  ethTrend: 'up' | 'down' | 'neutral';
  solTrend: 'up' | 'down' | 'neutral';

  // DipArb live data
  dipArb?: {
    marketName: string | null;
    underlying: string | null;
    duration: string | null;
    endTime: number | null;
    upPrice: number;
    status?: 'active' | 'idle' | 'scanning'; // Added status field
    downPrice: number;
    sum: number;
    lastSignal: DipArbSignal | null;
    signals: DipArbSignal[];
  };

  // Arbitrage live data
  arbitrage?: {
    status: 'scanning' | 'monitoring' | 'idle';
    marketsScanned: number;
    opportunitiesFound: number;
    currentMarket: string | null;
    lastOpportunity: ArbOpportunity | null;
  };

  // Smart Money signals
  smartMoneySignals?: SmartMoneySignal[];

  // Portfolio Sync (positions)
  positions?: any[];
}

export interface BotConfig {
  capital: {
    totalUsd: number;
    maxPerTradePct: number;
    maxPerMarketPct: number;
    maxTotalExposurePct: number;
    minOrderUsd: number;
    strategyAllocation: {
      smartMoney: number;
      arbitrage: number;
      dipArb: number;
      directTrades: number;
    };
  };
  risk: {
    dailyMaxLossPct: number;
    maxConsecutiveLosses: number;
    pauseOnBreachMinutes: number;
  };
  smartMoney: {
    enabled: boolean;
    topN: number;
    minWinRate: number;
    minPnl: number;
    minTrades: number;
    customWallets: string[];
  };
  arbitrage: {
    enabled: boolean;
    profitThreshold: number;
    autoExecute: boolean;
  };
  dipArb: {
    enabled: boolean;
    coins: readonly string[];
  };
  directTrading: {
    enabled: boolean;
  };
  binance: {
    enabled: boolean;
  };
  dryRun: boolean;
  /** Adresse du wallet du bot (absente en papier avec une clé éphémère). */
  walletAddress?: string;
}

export type LogLevel =
  | 'INFO'
  | 'WARN'
  | 'ERROR'
  | 'TRADE'
  | 'SIGNAL'
  | 'ARB'
  | 'WALLET'
  | 'CHAIN'
  | 'SWAP'
  | 'BRIDGE'
  | 'KLINE'
  | 'TREND'
  | 'LEARN';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

export interface DashboardData {
  state: BotState | null;
  config: BotConfig | null;
  logs: LogEntry[];
}

// ============= Session History Types =============

export interface TradeRecord {
  id: string;
  timestamp: string;
  strategy: 'smartMoney' | 'arbitrage' | 'dipArb' | 'direct' | 'fairValue';
  market: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  profit: number;
  wallet?: string; // For smart money - which wallet was copied
  txHash?: string;
}

export interface SessionSummary {
  id: string;
  startTime: string;
  endTime: string;
  durationMs: number;

  // P&L
  totalPnL: number;
  startingBalance: number;
  endingBalance: number;

  // Trade stats
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgProfitPerTrade: number;
  largestWin: number;
  largestLoss: number;

  // Strategy breakdown
  strategyStats: {
    smartMoney: { trades: number; profit: number };
    arbitrage: { trades: number; profit: number };
    dipArb: { trades: number; profit: number };
    direct: { trades: number; profit: number };
  };

  // Wallet performance (for smart money)
  walletPerformance: {
    wallet: string;
    trades: number;
    profit: number;
    winRate: number;
  }[];

  // On-chain stats
  onChainOps: {
    splits: number;
    merges: number;
    redeems: number;
    swaps: number;
  };

  // All trades from this session
  trades: TradeRecord[];

  // Config used
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
