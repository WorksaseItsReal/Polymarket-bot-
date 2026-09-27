/**
 * Data API Client for Polymarket
 * Handles: positions, activity, trades, leaderboard
 */

import { RateLimiter, ApiType } from '../core/rate-limiter.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { CACHE_TTL } from '../core/unified-cache.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';

/** User-Agent explicite : certains edges rejettent les clients sans UA (403). */
const HTTP_USER_AGENT = 'polymarket-bot/1.0 (+https://polymarket.com)';

/** Timeout réseau par défaut (ms). Un `fetch` sans timeout bloque indéfiniment. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Nombre total de tentatives (1 = pas de retry). */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * `fetch` JSON avec TIMEOUT + RETRY/BACKOFF (même contrat que gamma-api).
 *
 * ⚠️ AUDIT DONNÉES 2026-09-27 : avant, un `fetch()` nu pouvait (a) rester bloqué
 * indéfiniment (pas de timeout), (b) transformer un 429 « usage limit reached »
 * ou un 5xx en erreur immédiate côté appelant — et, par ricochet, en réponse
 * vide silencieuse (cf. `assertArray`).
 */
async function fetchJsonWithRetry(
  url: string,
  opts: { timeoutMs?: number; maxAttempts?: number; label?: string } = {}
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const label = opts.label ?? url;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': HTTP_USER_AGENT },
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const err = PolymarketError.fromHttpError(response.status, body);
        if (response.status === 429 && attempt < maxAttempts) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 30_000)
              : Math.min(500 * 2 ** (attempt - 1), 8_000);
          lastError = err;
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        if (err.retryable && attempt < maxAttempts) {
          lastError = err;
          await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** (attempt - 1), 8_000)));
          continue;
        }
        throw err;
      }

      return await response.json();
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      if (aborted) {
        lastError = new PolymarketError(
          ErrorCode.TIMEOUT,
          `${label} : timeout après ${timeoutMs} ms`,
          true
        );
      } else if (err instanceof PolymarketError) {
        if (!err.retryable) throw err;
        lastError = err;
      } else {
        lastError = new PolymarketError(
          ErrorCode.NETWORK_ERROR,
          `${label} : ${(err as Error)?.message ?? String(err)}`,
          true,
          err as Error
        );
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** (attempt - 1), 8_000)));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error(`${label} : échec après ${maxAttempts} tentatives`);
}

/**
 * Vérifie qu'une réponse Data API est bien un TABLEAU.
 *
 * ⚠️ AUDIT DONNÉES 2026-09-27 — mode de défaillance grave corrigé ici : les
 * normalisateurs faisaient `if (!Array.isArray(data)) return []`. Une réponse
 * d'ERREUR (objet JSON du type `{"error":"usage limit reached"}`) devenait donc
 * un tableau vide parfaitement légitime pour l'appelant : « aucune position »,
 * « aucun trade », « pas de K-line » — une PANNE déguisée en MESURE. On préfère
 * une erreur explicite : l'appelant la traite (retry/skip) au lieu de raisonner
 * sur du vide.
 */
function assertArray(data: unknown, context: string): unknown[] {
  if (!Array.isArray(data)) {
    throw new PolymarketError(
      ErrorCode.INVALID_RESPONSE,
      `${context} : réponse non-tableau (${typeof data}) — refus de la convertir en [] silencieux`
    );
  }
  return data;
}

// ===== Types =====

export interface Position {
  // Wallet identifier
  proxyWallet?: string;

  // Core identifiers
  asset: string; // ERC-1155 Token ID
  conditionId: string;
  outcome: string;
  outcomeIndex: number;

  // Position data
  size: number;
  avgPrice: number;
  curPrice?: number;
  totalBought?: number;

  // Value calculations
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number; // Unrealized PnL
  percentPnl?: number;
  realizedPnl?: number;
  percentRealizedPnl?: number;

  // Market metadata (from API)
  title: string;
  slug?: string;
  icon?: string;
  eventId?: string;
  eventSlug?: string;

  // Opposite side info (for binary markets)
  oppositeOutcome?: string;
  oppositeAsset?: string;

  // Status fields (from API)
  redeemable?: boolean;
  mergeable?: boolean;
  endDate?: string;
  negativeRisk?: boolean;
}

export interface Activity {
  // Transaction type
  type: 'TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM' | 'REWARD' | 'CONVERSION';
  side: 'BUY' | 'SELL';

  // Trade data
  size: number;
  price: number;
  usdcSize?: number;

  // Market identifiers
  asset: string;
  conditionId: string;
  outcome: string;
  outcomeIndex?: number;

  // Transaction info
  timestamp: number;
  transactionHash: string;

  // Market metadata (from API)
  title?: string;
  slug?: string;

  // Trader info (from API - returned as "name")
  name?: string;
}

export interface Trade {
  // Identifiers (id is optional - not always returned by API)
  id?: string;
  market: string; // conditionId (may come as "conditionId" from API)
  asset: string;

  // Trade data
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  outcome: string;
  outcomeIndex: number;

  // Transaction info
  timestamp: number;
  transactionHash: string;
  proxyWallet?: string;

  // Market metadata (from API)
  title?: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;

  // Trader info (from API)
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
  profileImageOptimized?: string;
}

/**
 * Leaderboard entry from Polymarket Data API
 *
 * @see https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings
 *
 * Note: API 只返回 rank, proxyWallet, userName, vol, pnl, profileImage, xUsername, verifiedBadge
 * positions 和 trades 字段 API 通常返回 null，需要调用 Profile API 获取详细数据
 */
export interface LeaderboardEntry {
  /** 钱包地址 (从 proxyWallet 标准化) */
  address: string;

  /** 排名 (从 string 转为 number) */
  rank: number;
  /** 盈亏 (USDC) */
  pnl: number;
  /** 交易量 (USDC, 从 vol 重命名) */
  volume: number;

  /** 用户名 */
  userName?: string;
  /** Twitter 用户名 */
  xUsername?: string;
  /** 是否已验证 */
  verifiedBadge?: boolean;
  /** 头像 URL */
  profileImage?: string;

  /** 持仓数量 (API 通常返回 null，需要 Profile API) */
  positions?: number;
  /** 交易次数 (API 通常返回 null，需要 Profile API) */
  trades?: number;
}

/**
 * Leaderboard result from Polymarket Data API
 *
 * @see https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings
 *
 * ## 设计说明
 * Polymarket API 返回纯数组，不包含分页元数据 (无 total, offset, limit)。
 * 本接口添加辅助字段以方便前端分页:
 * - `hasMore`: 推断值，当 entries.length === request.limit 时为 true
 * - `request`: 请求参数回显，方便计算页码
 *
 * ## 为什么不返回 total?
 * 因为 API 不提供，我们不伪造。用 hasMore 来判断是否有下一页。
 */
export interface LeaderboardResult {
  /** API 返回的排行榜条目 */
  entries: LeaderboardEntry[];
  /** 是否可能有更多数据 (entries.length === request.limit) */
  hasMore: boolean;
  /** 请求参数回显，方便前端分页计算 */
  request: {
    offset: number;
    limit: number;
  };
}

// ===== Leaderboard Parameters =====

/**
 * Time period for leaderboard filtering
 */
export type LeaderboardTimePeriod = 'DAY' | 'WEEK' | 'MONTH' | 'ALL';

/**
 * Ordering criteria for leaderboard
 */
export type LeaderboardOrderBy = 'PNL' | 'VOL';

/**
 * Market category for leaderboard filtering
 */
export type LeaderboardCategory =
  | 'OVERALL'
  | 'POLITICS'
  | 'SPORTS'
  | 'CRYPTO'
  | 'CULTURE'
  | 'MENTIONS'
  | 'WEATHER'
  | 'ECONOMICS'
  | 'TECH'
  | 'FINANCE';

/**
 * Leaderboard query parameters
 * @see https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings
 */
export interface LeaderboardParams {
  /** Time period for leaderboard results (default: DAY) */
  timePeriod?: LeaderboardTimePeriod;
  /** Ordering criteria (default: PNL) */
  orderBy?: LeaderboardOrderBy;
  /** Market category filter (default: OVERALL) */
  category?: LeaderboardCategory;
  /** Max number of traders to return (1-50, default: 25) */
  limit?: number;
  /** Starting index for pagination (0-1000, default: 0) */
  offset?: number;
  /** Filter by specific user address */
  user?: string;
  /** Filter by username */
  userName?: string;
}

// ===== Parameter Types (P0/P1/P2 Gap Analysis) =====

/**
 * Activity query parameters
 * @see https://docs.polymarket.com/developers/misc-endpoints/data-api-activity
 */
export interface ActivityParams {
  /** Maximum number of results (0-500, default: 100) */
  limit?: number;
  /** Pagination offset (0-10000) */
  offset?: number;
  /** Start timestamp (Unix seconds) - filter activities after this time */
  start?: number;
  /** End timestamp (Unix seconds) - filter activities before this time */
  end?: number;
  /** Activity type filter */
  type?: 'TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM' | 'REWARD' | 'CONVERSION';
  /** Trade side filter */
  side?: 'BUY' | 'SELL';
  /** Market condition IDs to filter */
  market?: string[];
  /** Event IDs to filter */
  eventId?: number[];
  /** Sort field */
  sortBy?: 'TIMESTAMP' | 'TOKENS' | 'CASH';
  /** Sort direction */
  sortDirection?: 'ASC' | 'DESC';
}

/**
 * Positions query parameters
 * @see https://docs.polymarket.com/developers/misc-endpoints/data-api-get-positions
 */
export interface PositionsParams {
  /** Maximum number of results (0-500, default: 100) */
  limit?: number;
  /** Pagination offset (0-10000) */
  offset?: number;
  /** Market condition IDs to filter */
  market?: string[];
  /** Event IDs to filter */
  eventId?: number[];
  /** Minimum position size to include (default: 1) */
  sizeThreshold?: number;
  /** Only return redeemable positions */
  redeemable?: boolean;
  /** Only return mergeable positions */
  mergeable?: boolean;
  /** Search by title */
  title?: string;
  /** Sort field */
  sortBy?: 'CURRENT' | 'INITIAL' | 'TOKENS' | 'CASHPNL' | 'PERCENTPNL' | 'TITLE' | 'RESOLVING' | 'PRICE' | 'AVGPRICE';
  /** Sort direction */
  sortDirection?: 'ASC' | 'DESC';
}

/**
 * Trades query parameters
 */
export interface TradesParams {
  /** Maximum number of results (default: 500) */
  limit?: number;
  /** Market condition ID to filter */
  market?: string;
  /** User wallet address to filter */
  user?: string;
  /** Only return taker trades */
  takerOnly?: boolean;
  /** Filter by cash or token amount */
  filterType?: 'CASH' | 'TOKENS';
  /** Minimum amount threshold */
  filterAmount?: number;
  /** Trade side filter */
  side?: 'BUY' | 'SELL';
  /** Start timestamp (Unix milliseconds) - filter trades after this time */
  startTimestamp?: number;
  /** End timestamp (Unix milliseconds) - filter trades before this time */
  endTimestamp?: number;
}

/**
 * Closed positions query parameters
 * @see https://docs.polymarket.com/api-reference/core/get-closed-positions-for-a-user
 */
export interface ClosedPositionsParams {
  /** Maximum number of results (0-50, default: 10) */
  limit?: number;
  /** Pagination offset (0-100000) */
  offset?: number;
  /** Market condition IDs to filter */
  market?: string[];
  /** Event IDs to filter */
  eventId?: number[];
  /** Search by title (max 100 chars) */
  title?: string;
  /** Sort field */
  sortBy?: 'REALIZEDPNL' | 'TITLE' | 'PRICE' | 'AVGPRICE' | 'TIMESTAMP';
  /** Sort direction */
  sortDirection?: 'ASC' | 'DESC';
}

/**
 * Closed position entry
 */
export interface ClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;

  // Trade data
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;  // Settlement price (0 or 1)
  timestamp: number;

  // Market info
  title: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
}

/**
 * Holders query parameters
 */
export interface HoldersParams {
  /** Market condition ID (required) */
  market: string;
  /** Maximum number of results */
  limit?: number;
}

/**
 * Account value response
 */
export interface AccountValue {
  user: string;
  value: number;
}

/**
 * Market holder entry
 */
export interface MarketHolder {
  proxyWallet: string;
  size: number;
  outcome: string;
  value?: number;
  userName?: string;
  profileImage?: string;
}

// ===== Client =====

export class DataApiClient {
  constructor(
    private rateLimiter: RateLimiter,
    private cache: UnifiedCache
  ) {}

  // ===== Wallet-related =====

  /**
   * Get positions for a wallet address
   *
   * @param address - Wallet address
   * @param params - Query parameters (P0/P1: limit, offset, sortBy, sortDirection, market, etc.)
   *
   * @example
   * ```typescript
   * // Get all positions
   * const positions = await client.getPositions(address);
   *
   * // Get positions sorted by PnL (highest first)
   * const topPnl = await client.getPositions(address, {
   *   sortBy: 'CASHPNL',
   *   sortDirection: 'DESC',
   *   limit: 10,
   * });
   *
   * // Get only redeemable positions
   * const redeemable = await client.getPositions(address, { redeemable: true });
   * ```
   */
  async getPositions(address: string, params?: PositionsParams): Promise<Position[]> {
    return this.rateLimiter.execute(ApiType.DATA_API, async () => {
      const query = new URLSearchParams({ user: address });

      // P0: limit, offset
      if (params?.limit !== undefined) query.set('limit', String(params.limit));
      if (params?.offset !== undefined) query.set('offset', String(params.offset));

      // P1: sortBy, sortDirection, market
      if (params?.sortBy) query.set('sortBy', params.sortBy);
      if (params?.sortDirection) query.set('sortDirection', params.sortDirection);
      if (params?.market) {
        params.market.forEach((m) => query.append('market', m));
      }
      if (params?.eventId) {
        params.eventId.forEach((id) => query.append('eventId', String(id)));
      }

      // P1: sizeThreshold, redeemable, mergeable, title
      if (params?.sizeThreshold !== undefined) query.set('sizeThreshold', String(params.sizeThreshold));
      if (params?.redeemable !== undefined) query.set('redeemable', String(params.redeemable));
      if (params?.mergeable !== undefined) query.set('mergeable', String(params.mergeable));
      if (params?.title) query.set('title', params.title);

      const data = await fetchJsonWithRetry(`${DATA_API_BASE}/positions?${query}`, {
        label: `GET /positions?${query}`,
      });
      return this.normalizePositions(assertArray(data, 'GET /positions'));
    });
  }

  /**
   * Get closed positions for a wallet address
   *
   * @param address - Wallet address
   * @param params - Query parameters
   *
   * @example
   * ```typescript
   * // Get closed positions sorted by realized PnL
   * const closed = await client.getClosedPositions(address);
   *
   * // Get recent settlements
   * const recent = await client.getClosedPositions(address, {
   *   sortBy: 'TIMESTAMP',
   *   sortDirection: 'DESC',
   *   limit: 20,
   * });
   * ```
   */
  async getClosedPositions(address: string, params?: ClosedPositionsParams): Promise<ClosedPosition[]> {
    return this.rateLimiter.execute(ApiType.DATA_API, async () => {
      const query = new URLSearchParams({ user: address });

      // Pagination
      if (params?.limit !== undefined) query.set('limit', String(params.limit));
      if (params?.offset !== undefined) query.set('offset', String(params.offset));

      // Filters
      if (params?.market) {
        params.market.forEach((m) => query.append('market', m));
      }
      if (params?.eventId) {
        params.eventId.forEach((id) => query.append('eventId', String(id)));
      }
      if (params?.title) query.set('title', params.title);

      // Sorting
      if (params?.sortBy) query.set('sortBy', params.sortBy);
      if (params?.sortDirection) query.set('sortDirection', params.sortDirection);

      const data = await fetchJsonWithRetry(`${DATA_API_BASE}/closed-positions?${query}`, {
        label: `GET /closed-positions?${query}`,
      });
      return this.normalizeClosedPositions(assertArray(data, 'GET /closed-positions'));
    });
  }

  /**
   * Get activity for a wallet address
   *
   * @param address - Wallet address
   * @param params - Query parameters (P0: start, end, offset; P1: market, sortBy, etc.)
   *
   * @example
   * ```typescript
   * // Get recent activity
   * const activity = await client.getActivity(address, { limit: 50 });
   *
   * // Get activity in a time range (Unix seconds)
   * const dayAgo = Math.floor(Date.now() / 1000) - 86400;
   * const recent = await client.getActivity(address, {
   *   start: dayAgo,
   *   limit: 100,
   * });
   *
   * // Paginate through all activity
   * const page2 = await client.getActivity(address, { offset: 100, limit: 100 });
   * ```
   */
  async getActivity(address: string, params?: ActivityParams): Promise<Activity[]> {
    return this.rateLimiter.execute(ApiType.DATA_API, async () => {
      const query = new URLSearchParams({ user: address });

      // Basic params
      query.set('limit', String(params?.limit ?? 100));

      // P0: offset, start, end (time filtering and pagination)
      if (params?.offset !== undefined) query.set('offset', String(params.offset));
      if (params?.start !== undefined) query.set('start', String(params.start));
      if (params?.end !== undefined) query.set('end', String(params.end));

      // P1: type, side, market, eventId
      if (params?.type) query.set('type', params.type);
      if (params?.side) query.set('side', params.side);
      if (params?.market) {
        params.market.forEach((m) => query.append('market', m));
      }
      if (params?.eventId) {
        params.eventId.forEach((id) => query.append('eventId', String(id)));
      }

      // P2: sortBy, sortDirection
      if (params?.sortBy) query.set('sortBy', params.sortBy);
      if (params?.sortDirection) query.set('sortDirection', params.sortDirection);

      const data = await fetchJsonWithRetry(`${DATA_API_BASE}/activity?${query}`, {
        label: `GET /activity?${query}`,
      });
      return this.normalizeActivities(assertArray(data, 'GET /activity'));
    });
  }

  /**
   * Get all activity for a wallet (auto-pagination)
   *
   * **⚠️ IMPORTANT: API Limitation**
   * The Polymarket API has a hard offset limit of 10,000. This means:
   * - Maximum ~10,500 records can be retrieved via offset pagination
   * - For active traders, this may only cover a few hours of history
   * - Use `start` and `end` params for time-based filtering to access older data
   *
   * @param address - Wallet address
   * @param params - Query parameters (use `start`/`end` for time filtering)
   * @param maxItems - Maximum items to fetch (default: 10000, capped by API offset limit)
   *
   * @example
   * ```typescript
   * // Get all recent activity (limited by API offset)
   * const allActivity = await client.getAllActivity(address);
   *
   * // Get activity for a specific time window (recommended for complete history)
   * const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
   * const weekActivity = await client.getAllActivity(address, { start: oneWeekAgo });
   * ```
   */
  async getAllActivity(
    address: string,
    params?: Omit<ActivityParams, 'offset' | 'limit'>,
    maxItems = 10000
  ): Promise<Activity[]> {
    const all: Activity[] = [];
    const limit = 500; // Max allowed by API
    const API_OFFSET_LIMIT = 10000; // Hard limit from Polymarket API
    let offset = 0;

    while (all.length < maxItems && offset < API_OFFSET_LIMIT) {
      const page = await this.getActivity(address, { ...params, limit, offset });
      all.push(...page);
      if (page.length < limit) break; // No more data
      offset += limit;
    }

    // Warn if we hit the API offset limit
    if (offset >= API_OFFSET_LIMIT && all.length >= API_OFFSET_LIMIT) {
      console.warn(
        `[DataApiClient] Hit API offset limit (${API_OFFSET_LIMIT}). ` +
          'Use time filtering (start/end params) to access older activity data.'
      );
    }

    return all.slice(0, maxItems);
  }

  // ===== Trade-related =====

  /**
   * Get recent trades
   *
   * @param params - Query parameters (P2: user, side, takerOnly, etc.)
   *
   * @example
   * ```typescript
   * // Get market trades
   * const trades = await client.getTrades({ market: conditionId, limit: 100 });
   *
   * // Get user trades (P2)
   * const userTrades = await client.getTrades({ user: address, limit: 50 });
   *
   * // Get only buy trades
   * const buys = await client.getTrades({ market: conditionId, side: 'BUY' });
   * ```
   */
  async getTrades(params?: TradesParams): Promise<Trade[]> {
    return this.rateLimiter.execute(ApiType.DATA_API, async () => {
      const query = new URLSearchParams();
      // Request more if we need to filter by time (to ensure we get enough after filtering)
      const requestLimit = (params?.startTimestamp || params?.endTimestamp)
        ? Math.min((params?.limit ?? 500) * 3, 1000)
        : (params?.limit ?? 500);
      query.set('limit', String(requestLimit));

      // Basic filters
      if (params?.market) query.set('market', params.market);

      // P2: user filter
      if (params?.user) query.set('user', params.user);

      // P2: additional filters
      if (params?.side) query.set('side', params.side);
      if (params?.takerOnly !== undefined) query.set('takerOnly', String(params.takerOnly));
      if (params?.filterType) query.set('filterType', params.filterType);
      if (params?.filterAmount !== undefined) query.set('filterAmount', String(params.filterAmount));

      const data = await fetchJsonWithRetry(`${DATA_API_BASE}/trades?${query}`, {
        label: `GET /trades?${query}`,
      });
      let trades = this.normalizeTrades(assertArray(data, 'GET /trades'));

      // Apply timestamp filters client-side (API may not support these directly)
      if (params?.startTimestamp) {
        trades = trades.filter(t => t.timestamp >= params.startTimestamp!);
      }
      if (params?.endTimestamp) {
        trades = trades.filter(t => t.timestamp <= params.endTimestamp!);
      }

      // ⚠️ AUDIT DONNÉES : le filtrage par fenêtre temporelle est fait COTÉ CLIENT
      // sur les `requestLimit` trades les plus récents (≤1000). Si la fenêtre
      // demandée est plus ancienne que ce lot, le résultat est vide — un vide
      // TOTALEMENT SILENCIEUX (K-lines « absentes » au lieu de « hors fenêtre »).
      if (trades.length === 0 && (params?.startTimestamp || params?.endTimestamp)) {
        console.warn(
          `[DataApiClient] getTrades: 0 trade après filtrage temporel ` +
            `(start=${params.startTimestamp ?? '-'}, end=${params.endTimestamp ?? '-'}) ` +
            `sur ${requestLimit} trades les plus récents — fenêtre probablement trop ancienne.`
        );
      }

      // Apply limit after filtering
      if (params?.limit && trades.length > params.limit) {
        trades = trades.slice(0, params.limit);
      }

      return trades;
    });
  }

  /**
   * Get trades for a specific market
   */
  async getTradesByMarket(conditionId: string, limit = 500): Promise<Trade[]> {
    return this.getTrades({ market: conditionId, limit });
  }

  /**
   * Get trades for a specific user (P2)
   */
  async getTradesByUser(address: string, params?: Omit<TradesParams, 'user'>): Promise<Trade[]> {
    return this.getTrades({ ...params, user: address });
  }

  // ===== Leaderboard =====

  /**
   * Fetch leaderboard entries from Polymarket Data API
   *
   * @see https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings
   *
   * ## API 返回字段
   * 原始 API 只返回以下字段:
   * - rank (string) - 排名
   * - proxyWallet (string) - 钱包地址
   * - userName (string) - 用户名
   * - vol (number) - 交易量
   * - pnl (number) - 盈亏
   * - profileImage (string) - 头像 URL
   * - xUsername (string | null) - Twitter 用户名
   * - verifiedBadge (boolean) - 是否已验证
   *
   * ## API 不返回的字段
   * 以下字段需要调用 Profile API 获取:
   * - tradeCount, buyCount, sellCount
   * - positionCount, winRate
   * - unrealizedPnl (需要从 positions 计算)
   *
   * ## 分页说明
   * - API 返回纯数组，无 total 字段
   * - hasMore 是推断值: entries.length === limit 时为 true
   * - request 是请求参数回显，方便前端分页
   *
   * @param params - Query parameters
   * @param params.timePeriod - Time period: 'DAY', 'WEEK', 'MONTH', 'ALL' (default: 'ALL')
   * @param params.orderBy - Order by: 'PNL', 'VOL' (default: 'PNL')
   * @param params.category - Category filter (default: 'OVERALL')
   * @param params.limit - Max entries per page (1-50, default: 50)
   * @param params.offset - Pagination offset (0-1000, default: 0)
   *
   * @example
   * ```typescript
   * // Get this week's top traders by PnL
   * const result = await client.fetchLeaderboard({ timePeriod: 'WEEK', limit: 20 });
   * console.log(result.entries);   // actual traders from API
   * console.log(result.hasMore);   // true if may have more data
   * console.log(result.request);   // { offset: 0, limit: 20 }
   *
   * // Pagination
   * const page2 = await client.fetchLeaderboard({ timePeriod: 'WEEK', limit: 20, offset: 20 });
   * ```
   */
  async fetchLeaderboard(params?: LeaderboardParams): Promise<LeaderboardResult> {
    const {
      timePeriod = 'ALL',
      orderBy = 'PNL',
      category = 'OVERALL',
      limit = 50,
      offset = 0,
      user,
      userName,
    } = params || {};

    const cacheKey = `leaderboard:${timePeriod}:${orderBy}:${category}:${offset}:${limit}`;

    return this.cache.getOrSet(cacheKey, CACHE_TTL.LEADERBOARD, async () => {
      const query = new URLSearchParams({
        timePeriod,
        orderBy,
        category,
        limit: String(limit),
        offset: String(offset),
      });

      if (user) query.set('user', user);
      if (userName) query.set('userName', userName);

      return this.rateLimiter.execute(ApiType.DATA_API, async () => {
        const data = await fetchJsonWithRetry(
          `${DATA_API_BASE}/v1/leaderboard?${query}`,
          { label: `GET /v1/leaderboard?${query}` }
        );

        const entries = this.normalizeLeaderboardEntries(assertArray(data, 'GET /v1/leaderboard'));

        return {
          entries,
          hasMore: entries.length === limit,
          request: { offset, limit },
        };
      });
    });
  }

  /**
   * Get all leaderboard entries up to a max count
   */
  async getAllLeaderboard(maxEntries = 500): Promise<LeaderboardEntry[]> {
    const all: LeaderboardEntry[] = [];
    let offset = 0;
    const limit = 50;

    while (all.length < maxEntries) {
      const result = await this.fetchLeaderboard({ limit, offset });
      all.push(...result.entries);
      if (!result.hasMore) break;
      offset += limit;
    }

    return all.slice(0, maxEntries);
  }

  // ===== Value & Holders (P1/P2) =====

  /**
   * Get account total value (P1)
   *
   * @param address - Wallet address
   * @param markets - Optional: filter by specific markets
   *
   * @example
   * ```typescript
   * const { value } = await client.getAccountValue(address);
   * console.log(`Total account value: $${value.toFixed(2)}`);
   * ```
   */
  async getAccountValue(address: string, markets?: string[]): Promise<AccountValue> {
    return this.rateLimiter.execute(ApiType.DATA_API, async () => {
      const query = new URLSearchParams({ user: address });
      if (markets) {
        markets.forEach((m) => query.append('market', m));
      }

      const data = await fetchJsonWithRetry(`${DATA_API_BASE}/value?${query}`, {
        label: `GET /value?${query}`,
      });

      // API returns array: [{ user, value }]
      // ⚠️ AUDIT DONNÉES : ne plus convertir une réponse non-tableau en
      // `{ user, value: 0 }` (valeur inventée = « ce wallet ne vaut rien »).
      const rows = assertArray(data, 'GET /value') as Array<{ user: string; value: number }>;
      if (rows.length > 0) {
        return {
          user: String(rows[0].user),
          value: Number(rows[0].value) || 0,
        };
      }
      // Tableau vide = réponse réelle « aucune valeur » (≠ panne, qui lève).
      return { user: address, value: 0 };
    });
  }

  /**
   * Get market holders (P2)
   *
   * Returns top holders for a specific market. Note: This endpoint can timeout
   * for large markets.
   *
   * @param params - Query parameters (market is required)
   *
   * @example
   * ```typescript
   * const holders = await client.getMarketHolders({
   *   market: conditionId,
   *   limit: 20,
   * });
   * ```
   */
  async getMarketHolders(params: HoldersParams): Promise<MarketHolder[]> {
    return this.rateLimiter.execute(ApiType.DATA_API, async () => {
      const query = new URLSearchParams({ market: params.market });
      if (params.limit !== undefined) query.set('limit', String(params.limit));

      const data = await fetchJsonWithRetry(`${DATA_API_BASE}/holders?${query}`, {
        label: `GET /holders?${query}`,
      });
      return this.normalizeHolders(assertArray(data, 'GET /holders'));
    });
  }

  // ===== Data Normalization =====

  private normalizePositions(data: unknown[]): Position[] {
    assertArray(data, 'normalizePositions');
    return data.map((item) => {
      const p = item as Record<string, unknown>;
      return {
        // Wallet identifier
        proxyWallet: p.proxyWallet !== undefined ? String(p.proxyWallet) : undefined,

        // Core identifiers
        asset: String(p.asset || ''),
        conditionId: String(p.conditionId || ''),
        outcome: String(p.outcome || ''),
        // Only use outcomeIndex if provided by API - don't infer from outcome name
        // (non-binary markets have arbitrary outcome names)
        outcomeIndex: typeof p.outcomeIndex === 'number' ? p.outcomeIndex : 0,

        // Position data
        size: Number(p.size),
        avgPrice: Number(p.avgPrice),
        curPrice: p.curPrice !== undefined ? Number(p.curPrice) : undefined,
        totalBought: p.totalBought !== undefined ? Number(p.totalBought) : undefined,

        // Value calculations
        initialValue:
          p.initialValue !== undefined ? Number(p.initialValue) : undefined,
        currentValue:
          p.currentValue !== undefined ? Number(p.currentValue) : undefined,
        cashPnl: p.cashPnl !== undefined ? Number(p.cashPnl) : undefined,
        percentPnl:
          p.percentPnl !== undefined ? Number(p.percentPnl) : undefined,
        realizedPnl:
          p.realizedPnl !== undefined ? Number(p.realizedPnl) : undefined,
        percentRealizedPnl:
          p.percentRealizedPnl !== undefined ? Number(p.percentRealizedPnl) : undefined,

        // Market metadata
        title: String(p.title || ''),
        slug: p.slug !== undefined ? String(p.slug) : undefined,
        icon: p.icon !== undefined ? String(p.icon) : undefined,
        eventId: p.eventId !== undefined ? String(p.eventId) : undefined,
        eventSlug: p.eventSlug !== undefined ? String(p.eventSlug) : undefined,

        // Opposite side info
        oppositeOutcome: p.oppositeOutcome !== undefined ? String(p.oppositeOutcome) : undefined,
        oppositeAsset: p.oppositeAsset !== undefined ? String(p.oppositeAsset) : undefined,

        // Status fields
        redeemable: p.redeemable !== undefined ? Boolean(p.redeemable) : undefined,
        mergeable: p.mergeable !== undefined ? Boolean(p.mergeable) : undefined,
        endDate: p.endDate !== undefined ? String(p.endDate) : undefined,
        negativeRisk: p.negativeRisk !== undefined ? Boolean(p.negativeRisk) : undefined,
      };
    });
  }

  private normalizeClosedPositions(data: unknown[]): ClosedPosition[] {
    assertArray(data, 'normalizeClosedPositions');
    return data.map((item) => {
      const p = item as Record<string, unknown>;
      return {
        proxyWallet: String(p.proxyWallet || ''),
        asset: String(p.asset || ''),
        conditionId: String(p.conditionId || ''),

        // Trade data
        avgPrice: Number(p.avgPrice) || 0,
        totalBought: Number(p.totalBought) || 0,
        realizedPnl: Number(p.realizedPnl) || 0,
        curPrice: Number(p.curPrice) || 0,
        timestamp: this.normalizeTimestamp(p.timestamp),

        // Market info
        title: String(p.title || ''),
        slug: p.slug !== undefined ? String(p.slug) : undefined,
        icon: p.icon !== undefined ? String(p.icon) : undefined,
        eventSlug: p.eventSlug !== undefined ? String(p.eventSlug) : undefined,
        outcome: String(p.outcome || ''),
        // Only use outcomeIndex if provided by API - don't infer from outcome name
        outcomeIndex: typeof p.outcomeIndex === 'number' ? p.outcomeIndex : 0,
        oppositeOutcome: p.oppositeOutcome !== undefined ? String(p.oppositeOutcome) : undefined,
        oppositeAsset: p.oppositeAsset !== undefined ? String(p.oppositeAsset) : undefined,
        endDate: p.endDate !== undefined ? String(p.endDate) : undefined,
      };
    });
  }

  private normalizeActivities(data: unknown[]): Activity[] {
    assertArray(data, 'normalizeActivities');
    return data.map((item) => {
      const a = item as Record<string, unknown>;
      return {
        // Transaction type
        type: String(a.type) as Activity['type'],
        side: String(a.side) as Activity['side'],

        // Trade data
        size: Number(a.size),
        price: Number(a.price),
        usdcSize:
          a.usdcSize !== undefined
            ? Number(a.usdcSize)
            : Number(a.size) * Number(a.price),

        // Market identifiers
        asset: String(a.asset || ''),
        conditionId: String(a.conditionId || ''),
        outcome: String(a.outcome || ''),
        outcomeIndex:
          a.outcomeIndex !== undefined ? Number(a.outcomeIndex) : undefined,

        // Transaction info
        timestamp: this.normalizeTimestamp(a.timestamp),
        transactionHash: String(a.transactionHash || ''),

        // Market metadata
        title: a.title !== undefined ? String(a.title) : undefined,
        slug: a.slug !== undefined ? String(a.slug) : undefined,

        // Trader info
        name: a.name !== undefined ? String(a.name) : undefined,
      };
    });
  }

  private normalizeTrades(data: unknown[]): Trade[] {
    assertArray(data, 'normalizeTrades');
    return data.map((item) => {
      const t = item as Record<string, unknown>;
      return {
        // Identifiers
        id: t.id !== undefined ? String(t.id) : undefined,
        market: String(t.market || t.conditionId || ''),
        asset: String(t.asset || ''),

        // Trade data
        side: String(t.side) as Trade['side'],
        price: Number(t.price),
        size: Number(t.size),
        outcome: String(t.outcome || ''),
        // Only use outcomeIndex if provided by API - don't infer from outcome name
        outcomeIndex: typeof t.outcomeIndex === 'number' ? t.outcomeIndex : 0,

        // Transaction info
        timestamp: this.normalizeTimestamp(t.timestamp),
        transactionHash: String(t.transactionHash || ''),
        proxyWallet:
          t.proxyWallet !== undefined ? String(t.proxyWallet) : undefined,

        // Market metadata
        title: t.title !== undefined ? String(t.title) : undefined,
        slug: t.slug !== undefined ? String(t.slug) : undefined,
        icon: t.icon !== undefined ? String(t.icon) : undefined,
        eventSlug: t.eventSlug !== undefined ? String(t.eventSlug) : undefined,

        // Trader info
        name: t.name !== undefined ? String(t.name) : undefined,
        pseudonym: t.pseudonym !== undefined ? String(t.pseudonym) : undefined,
        bio: t.bio !== undefined ? String(t.bio) : undefined,
        profileImage: t.profileImage !== undefined ? String(t.profileImage) : undefined,
        profileImageOptimized: t.profileImageOptimized !== undefined ? String(t.profileImageOptimized) : undefined,
      };
    });
  }

  private normalizeTimestamp(ts: unknown): number {
    if (typeof ts === 'number') {
      // If timestamp is in seconds, convert to milliseconds
      return ts < 1e12 ? ts * 1000 : ts;
    }
    if (typeof ts === 'string') {
      const num = parseInt(ts, 10);
      return num < 1e12 ? num * 1000 : num;
    }
    return Date.now();
  }

  private normalizeLeaderboardEntries(data: unknown[]): LeaderboardEntry[] {
    assertArray(data, 'normalizeLeaderboardEntries');
    return data.map((item) => {
      const e = item as Record<string, unknown>;
      return {
        // Wallet identifier
        address: String(e.proxyWallet || e.address || ''),

        // Ranking data
        rank: typeof e.rank === 'number' ? e.rank : parseInt(String(e.rank), 10) || 0,
        pnl: Number(e.pnl) || 0,
        volume: Number(e.vol || e.volume) || 0,

        // User profile
        userName: e.userName !== undefined ? String(e.userName) : undefined,
        xUsername: e.xUsername !== undefined ? String(e.xUsername) : undefined,
        verifiedBadge: Boolean(e.verifiedBadge),
        profileImage: e.profileImage !== undefined ? String(e.profileImage) : undefined,

        // Activity counts (optional - API often returns null)
        positions: e.positions != null ? Number(e.positions) : undefined,
        trades: e.trades != null ? Number(e.trades) : undefined,
      };
    });
  }

  private normalizeHolders(data: unknown[]): MarketHolder[] {
    assertArray(data, 'normalizeHolders');

    // The API returns grouped by token: [{ token, holders: [...] }, { token, holders: [...] }]
    // We need to flatten this and normalize each holder
    const result: MarketHolder[] = [];

    for (const item of data) {
      const tokenGroup = item as Record<string, unknown>;

      // Check if this is the grouped format (has 'holders' array)
      if (Array.isArray(tokenGroup.holders)) {
        for (const holder of tokenGroup.holders as Record<string, unknown>[]) {
          result.push({
            proxyWallet: String(holder.proxyWallet || holder.address || ''),
            size: Number(holder.amount || holder.size) || 0,
            // Map outcomeIndex to outcome name (0 = Yes/Up, 1 = No/Down)
            outcome: holder.outcomeIndex === 0 ? 'Yes' : holder.outcomeIndex === 1 ? 'No' : String(holder.outcome || ''),
            value: holder.value !== undefined ? Number(holder.value) : undefined,
            userName: holder.name !== undefined ? String(holder.name) : (holder.userName !== undefined ? String(holder.userName) : undefined),
            profileImage: holder.profileImage !== undefined ? String(holder.profileImage) : undefined,
          });
        }
      } else {
        // Fallback: flat format (for backwards compatibility)
        const h = tokenGroup;
        result.push({
          proxyWallet: String(h.proxyWallet || h.address || ''),
          size: Number(h.amount || h.size) || 0,
          outcome: h.outcomeIndex === 0 ? 'Yes' : h.outcomeIndex === 1 ? 'No' : String(h.outcome || ''),
          value: h.value !== undefined ? Number(h.value) : undefined,
          userName: h.name !== undefined ? String(h.name) : (h.userName !== undefined ? String(h.userName) : undefined),
          profileImage: h.profileImage !== undefined ? String(h.profileImage) : undefined,
        });
      }
    }

    return result;
  }
}
