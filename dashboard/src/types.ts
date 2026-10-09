/**
 * Types du dashboard — copie conforme de src/dashboard/types.ts (côté bot).
 * L'état est un INSTANTANÉ reconstruit par le bot depuis le registre papier à chaque
 * publication : rien ici n'est un compteur en mémoire.
 */

export type RiskLayer = 'daily' | 'monthly' | 'drawdown' | 'total';

/** Statistiques du registre papier (toutes sessions) : source de vérité du PnL. */
export interface LedgerSnapshot {
  trades: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number | null;
  pnl: number;
  tStat: number | null;
  openExposure: number;
  lossStreak: number;
  maxDrawdown: number;
  /** Calibration : trades dont l'issue du round est connue, réussite et probabilité annoncée. */
  calibN: number;
  calibWinRate: number | null;
  avgModelProb: number | null;
}

export interface RiskLimits {
  dailyMaxLossPct: number;
  monthlyMaxLossPct: number;
  maxDrawdownFromPeak: number;
  totalMaxLossPct: number;
}

export interface RiskSnapshot {
  allowed: boolean;
  layer: RiskLayer | null;
  reason: string | null;
  /** Fin du blocage (ms) ; null = manuel ou définitif. */
  until: number | null;
  currentCapital: number;
  peakCapital: number;
  drawdown: number;
  pnlToday: number;
  pnlMonth: number;
  limits: RiskLimits;
}

export interface OpenPosition {
  coin: string;
  side: 'UP' | 'DOWN';
  stake: number;
  costPerShare: number;
  shares: number;
  modelProb: number;
  endMs: number;
  openedAt: string;
}

export interface LastEvaluation {
  coin: string;
  t: number;
  tau: number;
  pUp: number | null;
  upAsk: number | null;
  downAsk: number | null;
  act: 'hold' | 'buy';
  side?: 'UP' | 'DOWN';
  reason: string;
}

export interface HealthSnapshot {
  spotStream: 'disabled' | 'live' | 'stale';
  clockSkewMs: number | null;
  telegram: 'off' | 'connected' | 'error';
  lastFullPassAt: number;
  lastMarketsFoundAt: number;
  consecutiveTickFailures: number;
  journal: boolean;
  /** Raison hors porte de risque qui bloque les entrées (arrêt de sécurité, horloge…), ou null. */
  entryBlock: string | null;
}

export interface BotState {
  startTime: number;
  capital: number;
  ledger: LedgerSnapshot;
  risk: RiskSnapshot;
  fairValue: {
    shadow: string;
    goLive: string;
    shadowStats: { n: number; tDiff: number | null } | null;
    openPositions: OpenPosition[];
    lastEvaluations: LastEvaluation[];
  };
  health: HealthSnapshot;
  /** Session en cours : paris ouverts, trades réglés et PnL réglé depuis le démarrage. */
  session: { opened: number; settled: number; pnl: number };
}

export interface BotConfig {
  mode: 'paper';
  capital: number;
  coins: string[];
  pollSec: number;
  exitEdge: number;
  fv: {
    minEdge: number;
    noiseEdgeK: number;
    minProb: number;
    minTauSec: number;
    maxTauSec: number;
    minAsk: number;
    maxAsk: number;
    takerFeeRate: number;
    twapWindowSec: number;
    strikeNoiseSec: number;
    basisBps: number;
    zScale: number;
    blendModel: number;
    blendMarket: number;
    tails: 'normal' | 't4';
  };
  risk: RiskLimits;
  fillDelayMs: number;
  minOrderUsd: number;
  spotStream: boolean;
  journal: boolean;
  telegram: boolean;
  timeZone: string;
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'SIGNAL';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

export interface DashboardData {
  state: BotState;
  config: BotConfig;
  logs: LogEntry[];
}

export interface WebSocketMessage {
  type: 'state' | 'log' | 'config' | 'full';
  payload: unknown;
}

/** Trade d'une session (fichier session-history.json ; noms de champs conservés pour les anciens fichiers). */
export interface TradeRecord {
  id: string;
  timestamp: string;
  market: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  profit: number;
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
  trades: TradeRecord[];
}

export interface HistoryData {
  sessions: SessionSummary[];
  totalSessions: number;
  totalProfit: number;
  totalTrades: number;
  overallWinRate: number;
}
