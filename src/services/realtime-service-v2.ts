/**
 * RealtimeService V2
 *
 * Comprehensive real-time data service using official @polymarket/real-time-data-client.
 *
 * Supports ALL available topics:
 * - clob_market: price_change, agg_orderbook, last_trade_price, tick_size_change, market_created, market_resolved
 * - clob_user: order, trade (requires authentication)
 * - activity: trades, orders_matched
 * - crypto_prices: update (BTC, ETH, etc.)
 * - equity_prices: update (AAPL, etc.)
 * - comments: comment_created, comment_removed, reaction_created, reaction_removed
 * - rfq: request_*, quote_*
 */

import { EventEmitter } from 'events';
import {
  RealTimeDataClient,
  type Message,
  type ClobApiKeyCreds,
  ConnectionStatus,
} from '@polymarket/real-time-data-client';
import type { PriceUpdate, BookUpdate, Orderbook, OrderbookLevel } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

export interface RealtimeServiceConfig {
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Ping interval in ms (default: 5000) */
  pingInterval?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;

  /**
   * Source de l'orderbook marché.
   *   - 'auto' (défaut) : REST /book en source GARANTIE + une sonde WS clob_market
   *     bornée (détecte une éventuelle réactivation du canal).
   *   - 'rest' : REST uniquement, aucun message clob_market envoyé.
   *   - 'ws'   : WS uniquement (ancien comportement, mesure : MORT).
   */
  orderbookSource?: 'auto' | 'ws' | 'rest';
  /** Base de l'API CLOB (défaut: https://clob.polymarket.com) */
  clobHost?: string;
  /** Intervalle de polling REST /book en ms (défaut: 2000) */
  restPollIntervalMs?: number;
  /** Timeout d'une requête REST /book en ms (défaut: 5000) */
  restRequestTimeoutMs?: number;
  /**
   * Délai maximal (ms) d'attente d'une frame WS clob_market avant de déclarer
   * le canal MORT et de purger définitivement les souscriptions clob_market
   * (défaut: 8000). C'est ce qui met fin au spam de réponses 400.
   */
  wsOrderbookProbeMs?: number;
  /** Backoff exponentiel de base du polling REST en ms (défaut: 2000, plafond 60000) */
  restBackoffBaseMs?: number;
}

// Market data types
/**
 * Extended orderbook snapshot from WebSocket with additional trading parameters.
 * Extends the base Orderbook type from core/types.ts.
 */
export interface OrderbookSnapshot extends Orderbook {
  /** Token ID (ERC-1155 token identifier, required in WebSocket context) */
  tokenId: string;
  /** @deprecated Use tokenId instead */
  assetId: string;
  /** Market condition ID (required in WebSocket context) */
  market: string;
  /** Tick size for price rounding */
  tickSize: string;
  /** Minimum order size */
  minOrderSize: string;
  /** Hash for change detection (required in WebSocket context) */
  hash: string;
}

export interface LastTradeInfo {
  assetId: string;
  price: number;
  side: 'BUY' | 'SELL';
  size: number;
  timestamp: number;
}

export interface PriceChange {
  assetId: string;
  changes: Array<{ price: string; size: string }>;
  timestamp: number;
}

export interface TickSizeChange {
  assetId: string;
  oldTickSize: string;
  newTickSize: string;
  timestamp: number;
}

export interface MarketEvent {
  conditionId: string;
  type: 'created' | 'resolved';
  data: Record<string, unknown>;
  timestamp: number;
}

// User data types (requires authentication)
export interface UserOrder {
  orderId: string;
  market: string;
  asset: string;
  side: 'BUY' | 'SELL';
  price: number;
  originalSize: number;
  matchedSize: number;
  eventType: 'PLACEMENT' | 'UPDATE' | 'CANCELLATION';
  timestamp: number;
}

export interface UserTrade {
  tradeId: string;
  market: string;
  outcome: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  status: 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';
  timestamp: number;
  transactionHash?: string;
}

// Activity types
/**
 * Activity trade from WebSocket
 *
 * 实测验证 (2025-12-28)：proxyWallet 和 name 是顶层字段，不在 trader 对象里
 */
export interface ActivityTrade {
  /** Token ID (用于下单) */
  asset: string;
  /** Market condition ID */
  conditionId: string;
  /** Event slug */
  eventSlug: string;
  /** Market slug (可用于过滤) */
  marketSlug: string;
  /** Outcome (Yes/No) */
  outcome: string;
  /** Trade price */
  price: number;
  /** Trade side */
  side: 'BUY' | 'SELL';
  /** Trade size in shares */
  size: number;
  /** Timestamp (Unix seconds) */
  timestamp: number;
  /** Transaction hash */
  transactionHash: string;

  // ========== 交易者信息 ==========

  /**
   * Trader info object - 用于 Copy Trading 过滤目标钱包
   *
   * 注意: 实测验证 (2025-12-28) 数据结构为:
   * {
   *   trader: { name: "username", address: "0x..." }
   * }
   * 而非顶层 proxyWallet
   */
  trader?: {
    /** 交易者用户名 */
    name?: string;
    /** 交易者钱包地址 - Copy Trading 过滤关键字段！ */
    address?: string;
  };
}

// External price types
export interface CryptoPrice {
  symbol: string;
  price: number;
  timestamp: number;
}

export interface EquityPrice {
  symbol: string;
  price: number;
  timestamp: number;
}

// Comment types
export interface Comment {
  id: string;
  parentEntityId: number;
  parentEntityType: 'Event' | 'Series';
  content?: string;
  author?: string;
  timestamp: number;
}

export interface Reaction {
  id: string;
  commentId: string;
  type: string;
  author?: string;
  timestamp: number;
}

// RFQ types
export interface RFQRequest {
  id: string;
  market: string;
  side: 'BUY' | 'SELL';
  size: number;
  status: 'created' | 'edited' | 'canceled' | 'expired';
  timestamp: number;
}

export interface RFQQuote {
  id: string;
  requestId: string;
  price: number;
  size: number;
  status: 'created' | 'edited' | 'canceled' | 'expired';
  timestamp: number;
}

// Subscription types
export interface Subscription {
  id: string;
  topic: string;
  type: string;
  unsubscribe: () => void;
}

export interface MarketSubscription extends Subscription {
  tokenIds: string[];
}

// Event handler types
export interface MarketDataHandlers {
  onOrderbook?: (book: OrderbookSnapshot) => void;
  onPriceChange?: (change: PriceChange) => void;
  onLastTrade?: (trade: LastTradeInfo) => void;
  onTickSizeChange?: (change: TickSizeChange) => void;
  onMarketEvent?: (event: MarketEvent) => void;
  onError?: (error: Error) => void;
}

export interface UserDataHandlers {
  onOrder?: (order: UserOrder) => void;
  onTrade?: (trade: UserTrade) => void;
  onError?: (error: Error) => void;
}

export interface ActivityHandlers {
  onTrade?: (trade: ActivityTrade) => void;
  onError?: (error: Error) => void;
}

export interface CryptoPriceHandlers {
  onPrice?: (price: CryptoPrice) => void;
  onError?: (error: Error) => void;
}

export interface EquityPriceHandlers {
  onPrice?: (price: EquityPrice) => void;
  onError?: (error: Error) => void;
}

// ============================================================================
// RealtimeServiceV2 Implementation
// ============================================================================

export class RealtimeServiceV2 extends EventEmitter {
  private client: RealTimeDataClient | null = null;
  private config: RealtimeServiceConfig & {
    orderbookSource: 'auto' | 'ws' | 'rest';
    clobHost: string;
    restPollIntervalMs: number;
    restRequestTimeoutMs: number;
    wsOrderbookProbeMs: number;
    restBackoffBaseMs: number;
  };
  private subscriptions: Map<string, Subscription> = new Map();
  private subscriptionIdCounter = 0;
  private connected = false;

  // ==========================================================================
  // REST /book fallback state (canal WS `clob_market` mesuré MORT)
  // ==========================================================================
  /** Tokens actuellement interrogés en REST, et les souscriptions qui les référencent. */
  private restTokens: Map<string, Set<string>> = new Map();
  /** Dernier hash émis par token (dédup WS/REST : on n'émet qu'au changement). */
  private orderbookLastHash: Map<string, string> = new Map();
  /** Timer du poller REST unique. */
  private restPollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Backoff courant du polling REST (ms), 0 = pas de backoff. */
  private restBackoffMs = 0;
  /** Nombre d'échecs consécutifs du polling REST. */
  private restFailureStreak = 0;
  /** Dernière cause d'échec REST (bornée). */
  private restLastError = '';
  /** Horodatage du dernier avertissement REST (pour re-log périodique borné). */
  private restWarnedAt = 0;
  /** Horodatage de la dernière frame orderbook reçue (toutes sources). */
  private lastOrderbookAt = 0;
  /** Compteurs d'observabilité. */
  private restRequestsOk = 0;
  private restRequestsFailed = 0;

  // ==========================================================================
  // WS clob_market liveness probe
  // ==========================================================================
  /** true dès que le serveur a délivré au moins une frame orderbook par WS. */
  private wsOrderbookFrameSeen = false;
  /** true = canal WS clob_market déclaré MORT → plus jamais de souscription. */
  private clobMarketWsDead = false;
  /** Sonde de vivacité du canal WS. */
  private wsProbeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Nombre de souscriptions clob_market envoyées (observabilité). */
  private wsOrderbookSendAttempts = 0;

  // Store subscription messages for reconnection
  private subscriptionMessages: Map<string, { subscriptions: Array<{ topic: string; type: string; filters?: string; clob_auth?: ClobApiKeyCreds }> }> = new Map();

  // Caches
  private priceCache: Map<string, PriceUpdate> = new Map();
  private bookCache: Map<string, OrderbookSnapshot> = new Map();
  private lastTradeCache: Map<string, LastTradeInfo> = new Map();

  constructor(config: RealtimeServiceConfig = {}) {
    super();
    this.config = {
      autoReconnect: config.autoReconnect ?? true,
      pingInterval: config.pingInterval ?? 5000,
      debug: config.debug ?? false,
      orderbookSource: config.orderbookSource ?? 'auto',
      clobHost: (config.clobHost ?? 'https://clob.polymarket.com').replace(/\/+$/, ''),
      restPollIntervalMs: config.restPollIntervalMs ?? 2000,
      restRequestTimeoutMs: config.restRequestTimeoutMs ?? 5000,
      wsOrderbookProbeMs: config.wsOrderbookProbeMs ?? 8000,
      restBackoffBaseMs: config.restBackoffBaseMs ?? 2000,
    };
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Connect to WebSocket server
   */
  connect(): this {
    if (this.client) {
      this.log('Already connected or connecting');
      return this;
    }

    this.client = new RealTimeDataClient({
      onConnect: this.handleConnect.bind(this),
      onMessage: this.handleMessage.bind(this),
      onStatusChange: this.handleStatusChange.bind(this),
      autoReconnect: this.config.autoReconnect,
      pingInterval: this.config.pingInterval,
    });

    this.client.connect();
    return this;
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.stopRestPoller();
    if (this.client) {
      this.client.disconnect();
      this.client = null;
      this.connected = false;
      this.subscriptions.clear();
      this.subscriptionMessages.clear();  // Clear reconnection list
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  // ============================================================================
  // Market Data Subscriptions (orderbook)
  //
  // ✅ MISE À JOUR 2026-09-26 — canal WS `clob_market` MORT (mesuré), bascule REST.
  //
  // Mesure reproductible (harnais ws-harness.mts / ws-probe.mts) : le serveur
  // `wss://ws-live-data.polymarket.com/` rejette TOUS les types clob_market
  // (agg_orderbook, price_change, last_trade_price, tick_size_change,
  // market_resolved, « * ») avec exactement :
  //   {"body":{"message":"CLOB messages are not supported anymore, please visit
  //    https://discord.com/channels/... to learn more"},"statusCode":400}
  // et ne délivre AUCUNE frame orderbook (0 message en 9 s de souscription).
  //
  // Source de remplacement PROUVÉE : REST `GET /book?token_id=<id>` en polling
  // (mesuré : 40/40 succès, 0 % d'erreur, p50 34 ms, p90 45 ms, ~3,5 Ko/frame).
  //
  // Stratégie :
  //   • 'auto' (défaut) : le polling REST démarre IMMÉDIATEMENT (aucune fenêtre
  //     sans données) et une sonde WS bornée vérifie une éventuelle réactivation
  //     du canal.
  //   • Dès que la sonde expire sans frame → le canal est déclaré MORT, ses
  //     souscriptions mémorisées sont PURGÉES (plus jamais renvoyées, y compris
  //     après reconnexion) → fin du spam de réponses 400.
  //   • Les émissions passent par `emitOrderbook()`, qui déduplique par `hash` :
  //     la forme de l'événement `orderbook` reste IDENTIQUE (OrderbookSnapshot
  //     avec tokenId ET assetId), donc DipArbService et ArbitrageService ne
  //     changent pas.
  // ============================================================================

  /**
   * Subscribe to market data (orderbook, prices, trades)
   * @param tokenIds - Array of token IDs to subscribe to
   * @param handlers - Event handlers
   */
  subscribeMarkets(tokenIds: string[], handlers: MarketDataHandlers = {}): MarketSubscription {
    const subId = `market_${++this.subscriptionIdCounter}`;
    const filterStr = JSON.stringify(tokenIds);

    const wantRest = this.config.orderbookSource !== 'ws';
    const wantWs = this.config.orderbookSource !== 'rest' && !this.clobMarketWsDead;

    // Subscribe to all market data types — SEULEMENT si le canal WS n'est pas
    // déclaré mort (sinon on ne renvoie plus rien : fin du bruit 400).
    const subscriptions = [
      { topic: 'clob_market', type: 'agg_orderbook', filters: filterStr },
      { topic: 'clob_market', type: 'price_change', filters: filterStr },
      { topic: 'clob_market', type: 'last_trade_price', filters: filterStr },
      { topic: 'clob_market', type: 'tick_size_change', filters: filterStr },
    ];

    const subMsg = { subscriptions };
    let wsSent = false;
    if (wantWs) {
      this.sendSubscription(subMsg);
      this.subscriptionMessages.set(subId, subMsg);  // Store for reconnection
      this.wsOrderbookSendAttempts++;
      wsSent = true;
      this.armWsOrderbookProbe();
    }

    // REST /book : source garantie de l'orderbook (canal WS mort).
    if (wantRest) {
      this.addRestTokens(tokenIds, subId);
    }

    // Register handlers
    const orderbookHandler = (book: OrderbookSnapshot) => {
      if (tokenIds.includes(book.assetId)) {
        handlers.onOrderbook?.(book);
      }
    };

    const priceChangeHandler = (change: PriceChange) => {
      if (tokenIds.includes(change.assetId)) {
        handlers.onPriceChange?.(change);
      }
    };

    const lastTradeHandler = (trade: LastTradeInfo) => {
      if (tokenIds.includes(trade.assetId)) {
        handlers.onLastTrade?.(trade);
      }
    };

    const tickSizeHandler = (change: TickSizeChange) => {
      if (tokenIds.includes(change.assetId)) {
        handlers.onTickSizeChange?.(change);
      }
    };

    this.on('orderbook', orderbookHandler);
    this.on('priceChange', priceChangeHandler);
    this.on('lastTrade', lastTradeHandler);
    this.on('tickSizeChange', tickSizeHandler);

    const subscription: MarketSubscription = {
      id: subId,
      topic: 'clob_market',
      type: '*',
      tokenIds,
      unsubscribe: () => {
        this.off('orderbook', orderbookHandler);
        this.off('priceChange', priceChangeHandler);
        this.off('lastTrade', lastTradeHandler);
        this.off('tickSizeChange', tickSizeHandler);
        // N'envoyer un « unsubscribe » que si un « subscribe » WS a réellement
        // été émis (sinon ≈ bruit inutile vers un canal mort).
        if (wsSent && !this.clobMarketWsDead) {
          this.sendUnsubscription({ subscriptions });
        }
        this.removeRestTokens(tokenIds, subId);
        this.subscriptions.delete(subId);
        this.subscriptionMessages.delete(subId);  // Remove from reconnection list
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  /**
   * Subscribe to a single market (YES + NO tokens)
   * Also emits derived price updates compatible with old API
   */
  subscribeMarket(
    yesTokenId: string,
    noTokenId: string,
    handlers: MarketDataHandlers & {
      onPriceUpdate?: (update: PriceUpdate) => void;
      onBookUpdate?: (update: BookUpdate) => void;
      onPairUpdate?: (update: { yes: PriceUpdate; no: PriceUpdate; spread: number }) => void;
    } = {}
  ): MarketSubscription {
    let lastYesUpdate: PriceUpdate | undefined;
    let lastNoUpdate: PriceUpdate | undefined;

    const checkPairUpdate = () => {
      if (lastYesUpdate && lastNoUpdate && handlers.onPairUpdate) {
        handlers.onPairUpdate({
          yes: lastYesUpdate,
          no: lastNoUpdate,
          spread: lastYesUpdate.price + lastNoUpdate.price,
        });
      }
    };

    return this.subscribeMarkets([yesTokenId, noTokenId], {
      onOrderbook: (book) => {
        handlers.onOrderbook?.(book);

        // Convert to BookUpdate for backward compatibility
        if (handlers.onBookUpdate) {
          const bookUpdate: BookUpdate = {
            assetId: book.assetId,
            bids: book.bids,
            asks: book.asks,
            timestamp: book.timestamp,
          };
          handlers.onBookUpdate(bookUpdate);
        }

        // Calculate derived price (Polymarket display logic)
        const priceUpdate = this.calculateDerivedPrice(book.assetId, book);
        if (priceUpdate) {
          this.priceCache.set(book.assetId, priceUpdate);

          if (book.assetId === yesTokenId) {
            lastYesUpdate = priceUpdate;
          } else if (book.assetId === noTokenId) {
            lastNoUpdate = priceUpdate;
          }

          handlers.onPriceUpdate?.(priceUpdate);
          this.emit('priceUpdate', priceUpdate);
          checkPairUpdate();
        }
      },
      onLastTrade: (trade) => {
        handlers.onLastTrade?.(trade);
        this.lastTradeCache.set(trade.assetId, trade);

        // Recalculate derived price with new last trade
        const book = this.bookCache.get(trade.assetId);
        if (book) {
          const priceUpdate = this.calculateDerivedPrice(trade.assetId, book);
          if (priceUpdate) {
            this.priceCache.set(trade.assetId, priceUpdate);

            if (trade.assetId === yesTokenId) {
              lastYesUpdate = priceUpdate;
            } else if (trade.assetId === noTokenId) {
              lastNoUpdate = priceUpdate;
            }

            handlers.onPriceUpdate?.(priceUpdate);
            this.emit('priceUpdate', priceUpdate);
            checkPairUpdate();
          }
        }
      },
      onPriceChange: handlers.onPriceChange,
      onTickSizeChange: handlers.onTickSizeChange,
      onError: handlers.onError,
    });
  }

  /**
   * Subscribe to market lifecycle events (creation, resolution)
   */
  subscribeMarketEvents(handlers: { onMarketEvent?: (event: MarketEvent) => void }): Subscription {
    const subId = `market_event_${++this.subscriptionIdCounter}`;

    const subscriptions = [
      { topic: 'clob_market', type: 'market_created' },
      { topic: 'clob_market', type: 'market_resolved' },
    ];

    this.sendSubscription({ subscriptions });

    const handler = (event: MarketEvent) => handlers.onMarketEvent?.(event);
    this.on('marketEvent', handler);

    const subscription: Subscription = {
      id: subId,
      topic: 'clob_market',
      type: 'lifecycle',
      unsubscribe: () => {
        this.off('marketEvent', handler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // User Data Subscriptions (clob_user) - Requires Authentication
  // ============================================================================

  /**
   * Subscribe to user order and trade events
   * @param credentials - CLOB API credentials
   * @param handlers - Event handlers
   */
  subscribeUserEvents(credentials: ClobApiKeyCreds, handlers: UserDataHandlers = {}): Subscription {
    const subId = `user_${++this.subscriptionIdCounter}`;

    const subscriptions = [
      { topic: 'clob_user', type: '*', clob_auth: credentials },
    ];

    this.sendSubscription({ subscriptions });

    const orderHandler = (order: UserOrder) => handlers.onOrder?.(order);
    const tradeHandler = (trade: UserTrade) => handlers.onTrade?.(trade);

    this.on('userOrder', orderHandler);
    this.on('userTrade', tradeHandler);

    const subscription: Subscription = {
      id: subId,
      topic: 'clob_user',
      type: '*',
      unsubscribe: () => {
        this.off('userOrder', orderHandler);
        this.off('userTrade', tradeHandler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // Activity Subscriptions (trades, orders_matched)
  // ============================================================================

  /**
   * Subscribe to trading activity for a market or event
   * @param filter - Event or market slug (optional - if empty, subscribes to all activity)
   * @param handlers - Event handlers
   */
  subscribeActivity(
    filter: { eventSlug?: string; marketSlug?: string } = {},
    handlers: ActivityHandlers = {}
  ): Subscription {
    const subId = `activity_${++this.subscriptionIdCounter}`;

    // Build filter object with snake_case keys (as expected by the server)
    // Only include filters if we have actual filter values
    const hasFilter = filter.eventSlug || filter.marketSlug;
    const filterObj: Record<string, string> = {};
    if (filter.eventSlug) filterObj.event_slug = filter.eventSlug;
    if (filter.marketSlug) filterObj.market_slug = filter.marketSlug;

    // Create subscription objects - only include filters field if we have filters
    const subscriptions = hasFilter
      ? [
          { topic: 'activity', type: 'trades', filters: JSON.stringify(filterObj) },
          { topic: 'activity', type: 'orders_matched', filters: JSON.stringify(filterObj) },
        ]
      : [
          { topic: 'activity', type: 'trades' },
          { topic: 'activity', type: 'orders_matched' },
        ];

    this.sendSubscription({ subscriptions });

    const handler = (trade: ActivityTrade) => handlers.onTrade?.(trade);
    this.on('activityTrade', handler);

    const subscription: Subscription = {
      id: subId,
      topic: 'activity',
      type: '*',
      unsubscribe: () => {
        this.off('activityTrade', handler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  /**
   * Subscribe to ALL trading activity across all markets (no filtering)
   * This is useful for Copy Trading - monitoring Smart Money across the platform
   * @param handlers - Event handlers
   */
  subscribeAllActivity(handlers: ActivityHandlers = {}): Subscription {
    return this.subscribeActivity({}, handlers);
  }

  // ============================================================================
  // Crypto Price Subscriptions
  // ============================================================================

  /**
   * Subscribe to crypto price updates
   * @param symbols - Array of symbols (e.g., ['BTCUSDT', 'ETHUSDT'])
   * @param handlers - Event handlers
   */
  subscribeCryptoPrices(symbols: string[], handlers: CryptoPriceHandlers = {}): Subscription {
    const subId = `crypto_${++this.subscriptionIdCounter}`;

    // Subscribe to each symbol
    const subscriptions = symbols.map(symbol => ({
      topic: 'crypto_prices',
      type: 'update',
      filters: JSON.stringify({ symbol }),
    }));

    this.sendSubscription({ subscriptions });

    const handler = (price: CryptoPrice) => {
      if (symbols.includes(price.symbol)) {
        handlers.onPrice?.(price);
      }
    };
    this.on('cryptoPrice', handler);

    const subscription: Subscription = {
      id: subId,
      topic: 'crypto_prices',
      type: 'update',
      unsubscribe: () => {
        this.off('cryptoPrice', handler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  /**
   * Subscribe to Chainlink crypto prices
   * @param symbols - Array of symbols (e.g., ['ETH/USD', 'BTC/USD'])
   */
  subscribeCryptoChainlinkPrices(symbols: string[], handlers: CryptoPriceHandlers = {}): Subscription {
    const subId = `crypto_chainlink_${++this.subscriptionIdCounter}`;

    const subscriptions = symbols.map(symbol => ({
      topic: 'crypto_prices_chainlink',
      type: 'update',
      filters: JSON.stringify({ symbol }),
    }));

    const subMsg = { subscriptions };
    this.sendSubscription(subMsg);
    this.subscriptionMessages.set(subId, subMsg);  // Store for reconnection

    const handler = (price: CryptoPrice) => {
      if (symbols.includes(price.symbol)) {
        handlers.onPrice?.(price);
      }
    };
    this.on('cryptoChainlinkPrice', handler);

    const subscription: Subscription = {
      id: subId,
      topic: 'crypto_prices_chainlink',
      type: 'update',
      unsubscribe: () => {
        this.off('cryptoChainlinkPrice', handler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
        this.subscriptionMessages.delete(subId);  // Remove from reconnection list
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // Equity Price Subscriptions
  // ============================================================================

  /**
   * Subscribe to equity price updates
   * @param symbols - Array of symbols (e.g., ['AAPL', 'GOOGL'])
   * @param handlers - Event handlers
   */
  subscribeEquityPrices(symbols: string[], handlers: EquityPriceHandlers = {}): Subscription {
    const subId = `equity_${++this.subscriptionIdCounter}`;

    const subscriptions = symbols.map(symbol => ({
      topic: 'equity_prices',
      type: 'update',
      filters: JSON.stringify({ symbol }),
    }));

    this.sendSubscription({ subscriptions });

    const handler = (price: EquityPrice) => {
      if (symbols.includes(price.symbol)) {
        handlers.onPrice?.(price);
      }
    };
    this.on('equityPrice', handler);

    const subscription: Subscription = {
      id: subId,
      topic: 'equity_prices',
      type: 'update',
      unsubscribe: () => {
        this.off('equityPrice', handler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // Comments Subscriptions
  // ============================================================================

  /**
   * Subscribe to comment and reaction events
   */
  subscribeComments(
    filter: { parentEntityId: number; parentEntityType: 'Event' | 'Series' },
    handlers: {
      onComment?: (comment: Comment) => void;
      onReaction?: (reaction: Reaction) => void;
    } = {}
  ): Subscription {
    const subId = `comments_${++this.subscriptionIdCounter}`;
    const filterStr = JSON.stringify({
      parentEntityID: filter.parentEntityId,
      parentEntityType: filter.parentEntityType,
    });

    const subscriptions = [
      { topic: 'comments', type: 'comment_created', filters: filterStr },
      { topic: 'comments', type: 'comment_removed', filters: filterStr },
      { topic: 'comments', type: 'reaction_created', filters: filterStr },
      { topic: 'comments', type: 'reaction_removed', filters: filterStr },
    ];

    this.sendSubscription({ subscriptions });

    const commentHandler = (comment: Comment) => handlers.onComment?.(comment);
    const reactionHandler = (reaction: Reaction) => handlers.onReaction?.(reaction);

    this.on('comment', commentHandler);
    this.on('reaction', reactionHandler);

    const subscription: Subscription = {
      id: subId,
      topic: 'comments',
      type: '*',
      unsubscribe: () => {
        this.off('comment', commentHandler);
        this.off('reaction', reactionHandler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // RFQ Subscriptions
  // ============================================================================

  /**
   * Subscribe to RFQ (Request for Quote) events
   */
  subscribeRFQ(handlers: {
    onRequest?: (request: RFQRequest) => void;
    onQuote?: (quote: RFQQuote) => void;
  } = {}): Subscription {
    const subId = `rfq_${++this.subscriptionIdCounter}`;

    const subscriptions = [
      { topic: 'rfq', type: 'request_created' },
      { topic: 'rfq', type: 'request_edited' },
      { topic: 'rfq', type: 'request_canceled' },
      { topic: 'rfq', type: 'request_expired' },
      { topic: 'rfq', type: 'quote_created' },
      { topic: 'rfq', type: 'quote_edited' },
      { topic: 'rfq', type: 'quote_canceled' },
      { topic: 'rfq', type: 'quote_expired' },
    ];

    this.sendSubscription({ subscriptions });

    const requestHandler = (request: RFQRequest) => handlers.onRequest?.(request);
    const quoteHandler = (quote: RFQQuote) => handlers.onQuote?.(quote);

    this.on('rfqRequest', requestHandler);
    this.on('rfqQuote', quoteHandler);

    const subscription: Subscription = {
      id: subId,
      topic: 'rfq',
      type: '*',
      unsubscribe: () => {
        this.off('rfqRequest', requestHandler);
        this.off('rfqQuote', quoteHandler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // Cache Access
  // ============================================================================

  /**
   * Get cached derived price for an asset
   */
  getPrice(assetId: string): PriceUpdate | undefined {
    return this.priceCache.get(assetId);
  }

  /**
   * Get all cached prices
   */
  getAllPrices(): Map<string, PriceUpdate> {
    return new Map(this.priceCache);
  }

  /**
   * Get cached orderbook for an asset
   */
  getBook(assetId: string): OrderbookSnapshot | undefined {
    return this.bookCache.get(assetId);
  }

  /**
   * Get cached last trade for an asset
   */
  getLastTrade(assetId: string): LastTradeInfo | undefined {
    return this.lastTradeCache.get(assetId);
  }

  // ============================================================================
  // Subscription Management
  // ============================================================================

  /**
   * Get all active subscriptions
   */
  getActiveSubscriptions(): Subscription[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Unsubscribe from all
   */
  unsubscribeAll(): void {
    for (const sub of this.subscriptions.values()) {
      sub.unsubscribe();
    }
    this.subscriptions.clear();
    this.subscriptionMessages.clear();  // Clear reconnection list
    this.restTokens.clear();
    this.orderbookLastHash.clear();
    this.stopRestPoller();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private handleConnect(client: RealTimeDataClient): void {
    this.connected = true;
    this.log('Connected to WebSocket server');

    // Re-subscribe to all active subscriptions on reconnect.
    // ⚠️ Les souscriptions `clob_market` sont purgées dès que le canal est
    // déclaré mort (voir onWsOrderbookProbeTimeout) → aucune n'est renvoyée ici.
    if (this.subscriptionMessages.size > 0) {
      this.log(`Re-subscribing to ${this.subscriptionMessages.size} subscriptions...`);
      for (const [subId, msg] of this.subscriptionMessages) {
        if (this.clobMarketWsDead && msg.subscriptions.some((s) => s.topic === 'clob_market')) {
          this.subscriptionMessages.delete(subId);
          continue;
        }
        this.log(`Re-subscribing: ${subId}`);
        this.client?.subscribe(msg);
      }
    }

    this.emit('connected');
  }

  private handleStatusChange(status: ConnectionStatus): void {
    this.log(`Connection status: ${status}`);

    if (status === ConnectionStatus.DISCONNECTED) {
      this.connected = false;
      this.emit('disconnected');
    } else if (status === ConnectionStatus.CONNECTED) {
      this.connected = true;
    }

    this.emit('statusChange', status);
  }

  private handleMessage(client: RealTimeDataClient, message: Message): void {
    this.log(`Received: ${message.topic}:${message.type}`);

    const payload = message.payload as Record<string, unknown>;

    switch (message.topic) {
      case 'clob_market':
        this.handleMarketMessage(message.type, payload, message.timestamp);
        break;

      case 'clob_user':
        this.handleUserMessage(message.type, payload, message.timestamp);
        break;

      case 'activity':
        this.handleActivityMessage(message.type, payload, message.timestamp);
        break;

      case 'crypto_prices':
        this.handleCryptoPriceMessage(payload, message.timestamp);
        break;

      case 'crypto_prices_chainlink':
        this.handleCryptoChainlinkPriceMessage(payload, message.timestamp);
        break;

      case 'equity_prices':
        this.handleEquityPriceMessage(payload, message.timestamp);
        break;

      case 'comments':
        this.handleCommentMessage(message.type, payload, message.timestamp);
        break;

      case 'rfq':
        this.handleRFQMessage(message.type, payload, message.timestamp);
        break;

      default:
        this.log(`Unknown topic: ${message.topic}`);
    }
  }

  private handleMarketMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    switch (type) {
      case 'agg_orderbook': {
        const book = this.parseOrderbook(payload, timestamp);
        // Le canal WS a délivré une frame orderbook : la sonde de vivacité est
        // satisfaite (le canal n'est donc PAS mort).
        this.wsOrderbookFrameSeen = true;
        this.emitOrderbook(book);
        break;
      }

      case 'price_change': {
        const change = this.parsePriceChange(payload, timestamp);
        this.emit('priceChange', change);
        break;
      }

      case 'last_trade_price': {
        const trade = this.parseLastTrade(payload, timestamp);
        this.lastTradeCache.set(trade.assetId, trade);
        this.emit('lastTrade', trade);
        break;
      }

      case 'tick_size_change': {
        const change = this.parseTickSizeChange(payload, timestamp);
        this.emit('tickSizeChange', change);
        break;
      }

      case 'market_created':
      case 'market_resolved': {
        const event: MarketEvent = {
          conditionId: payload.condition_id as string || '',
          type: type === 'market_created' ? 'created' : 'resolved',
          data: payload,
          timestamp,
        };
        this.emit('marketEvent', event);
        break;
      }
    }
  }

  private handleUserMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    if (type === 'order') {
      const order: UserOrder = {
        orderId: payload.order_id as string || '',
        market: payload.market as string || '',
        asset: payload.asset as string || '',
        side: payload.side as 'BUY' | 'SELL',
        price: Number(payload.price) || 0,
        originalSize: Number(payload.original_size) || 0,
        matchedSize: Number(payload.matched_size) || 0,
        eventType: payload.event_type as 'PLACEMENT' | 'UPDATE' | 'CANCELLATION',
        timestamp,
      };
      this.emit('userOrder', order);
    } else if (type === 'trade') {
      const trade: UserTrade = {
        tradeId: payload.trade_id as string || '',
        market: payload.market as string || '',
        outcome: payload.outcome as string || '',
        price: Number(payload.price) || 0,
        size: Number(payload.size) || 0,
        side: payload.side as 'BUY' | 'SELL',
        status: payload.status as 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED',
        timestamp,
        transactionHash: payload.transaction_hash as string | undefined,
      };
      this.emit('userTrade', trade);
    }
  }

  private handleActivityMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    const trade: ActivityTrade = {
      asset: payload.asset as string || '',
      conditionId: payload.conditionId as string || '',
      eventSlug: payload.eventSlug as string || '',
      marketSlug: payload.slug as string || '',
      outcome: payload.outcome as string || '',
      price: Number(payload.price) || 0,
      side: payload.side as 'BUY' | 'SELL',
      size: Number(payload.size) || 0,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
      transactionHash: payload.transactionHash as string || '',
      trader: {
        name: payload.name as string | undefined,
        address: payload.proxyWallet as string | undefined,
      },
    };
    this.emit('activityTrade', trade);
  }

  private handleCryptoPriceMessage(payload: Record<string, unknown>, timestamp: number): void {
    const price: CryptoPrice = {
      symbol: payload.symbol as string || '',
      price: Number(payload.value) || 0,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
    };
    this.emit('cryptoPrice', price);
  }

  private handleCryptoChainlinkPriceMessage(payload: Record<string, unknown>, timestamp: number): void {
    const price: CryptoPrice = {
      symbol: payload.symbol as string || '',
      price: Number(payload.value) || 0,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
    };
    this.emit('cryptoChainlinkPrice', price);
  }

  private handleEquityPriceMessage(payload: Record<string, unknown>, timestamp: number): void {
    const price: EquityPrice = {
      symbol: payload.symbol as string || '',
      price: Number(payload.value) || 0,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
    };
    this.emit('equityPrice', price);
  }

  private handleCommentMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    if (type.includes('comment')) {
      const comment: Comment = {
        id: payload.id as string || '',
        parentEntityId: payload.parentEntityID as number || 0,
        parentEntityType: payload.parentEntityType as 'Event' | 'Series',
        content: payload.content as string | undefined,
        author: payload.author as string | undefined,
        timestamp,
      };
      this.emit('comment', comment);
    } else if (type.includes('reaction')) {
      const reaction: Reaction = {
        id: payload.id as string || '',
        commentId: payload.commentId as string || '',
        type: payload.type as string || '',
        author: payload.author as string | undefined,
        timestamp,
      };
      this.emit('reaction', reaction);
    }
  }

  private handleRFQMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    if (type.startsWith('request_')) {
      const status = type.replace('request_', '') as 'created' | 'edited' | 'canceled' | 'expired';
      const request: RFQRequest = {
        id: payload.id as string || '',
        market: payload.market as string || '',
        side: payload.side as 'BUY' | 'SELL',
        size: Number(payload.size) || 0,
        status,
        timestamp,
      };
      this.emit('rfqRequest', request);
    } else if (type.startsWith('quote_')) {
      const status = type.replace('quote_', '') as 'created' | 'edited' | 'canceled' | 'expired';
      const quote: RFQQuote = {
        id: payload.id as string || '',
        requestId: payload.request_id as string || '',
        price: Number(payload.price) || 0,
        size: Number(payload.size) || 0,
        status,
        timestamp,
      };
      this.emit('rfqQuote', quote);
    }
  }

  // Parsers

  private parseOrderbook(payload: Record<string, unknown>, timestamp: number): OrderbookSnapshot {
    const bidsRaw = payload.bids as Array<{ price: string; size: string }> || [];
    const asksRaw = payload.asks as Array<{ price: string; size: string }> || [];

    // Sort bids descending, asks ascending
    const bids = bidsRaw
      .map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .sort((a, b) => b.price - a.price);

    const asks = asksRaw
      .map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .sort((a, b) => a.price - b.price);

    const tokenId = payload.asset_id as string || '';
    return {
      tokenId,
      assetId: tokenId, // Backward compatibility
      market: payload.market as string || '',
      bids,
      asks,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
      tickSize: payload.tick_size as string || '0.01',
      minOrderSize: payload.min_order_size as string || '1',
      hash: payload.hash as string || '',
    };
  }

  private parsePriceChange(payload: Record<string, unknown>, timestamp: number): PriceChange {
    const changes = payload.price_changes as Array<{ price: string; size: string }> || [];
    return {
      assetId: payload.asset_id as string || '',
      changes,
      timestamp,
    };
  }

  private parseLastTrade(payload: Record<string, unknown>, timestamp: number): LastTradeInfo {
    return {
      assetId: payload.asset_id as string || '',
      price: parseFloat(payload.price as string) || 0,
      side: payload.side as 'BUY' | 'SELL' || 'BUY',
      size: parseFloat(payload.size as string) || 0,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
    };
  }

  private parseTickSizeChange(payload: Record<string, unknown>, timestamp: number): TickSizeChange {
    return {
      assetId: payload.asset_id as string || '',
      oldTickSize: payload.old_tick_size as string || '',
      newTickSize: payload.new_tick_size as string || '',
      timestamp,
    };
  }

  /**
   * Calculate derived price using Polymarket's display logic:
   * - If spread <= 0.10: use midpoint
   * - If spread > 0.10: use last trade price
   */
  private calculateDerivedPrice(assetId: string, book: OrderbookSnapshot): PriceUpdate | null {
    if (book.bids.length === 0 || book.asks.length === 0) {
      return null;
    }

    const bestBid = book.bids[0].price;
    const bestAsk = book.asks[0].price;
    const spread = bestAsk - bestBid;
    const midpoint = (bestBid + bestAsk) / 2;

    const lastTrade = this.lastTradeCache.get(assetId);
    const lastTradePrice = lastTrade?.price ?? midpoint;

    // Polymarket display logic
    const displayPrice = spread <= 0.10 ? midpoint : lastTradePrice;

    return {
      assetId,
      price: displayPrice,
      midpoint,
      spread,
      timestamp: book.timestamp,
    };
  }

  /**
   * Émet un orderbook en dédupliquant par `hash` (une frame identique n'est
   * jamais réémise). La forme émise est un `OrderbookSnapshot` complet
   * (`tokenId` ET `assetId` renseignés) — strictement identique à l'ancien
   * chemin WS, donc les consommateurs (DipArbService, ArbitrageService) ne
   * voient aucune différence de contrat.
   */
  private emitOrderbook(book: OrderbookSnapshot): void {
    if (!book.assetId) return;
    if (book.hash && this.orderbookLastHash.get(book.assetId) === book.hash) {
      return; // carnet inchangé → pas d'émission redondante
    }
    if (book.hash) this.orderbookLastHash.set(book.assetId, book.hash);
    this.bookCache.set(book.assetId, book);
    this.lastOrderbookAt = Date.now();
    this.emit('orderbook', book);
  }

  // ==========================================================================
  // REST /book polling (source d'orderbook garantie)
  // ==========================================================================

  /** Démarre (ou réveille) la sonde de vivacité du canal WS clob_market. */
  private armWsOrderbookProbe(): void {
    if (this.wsProbeTimer || this.clobMarketWsDead || this.wsOrderbookFrameSeen) return;
    this.wsProbeTimer = setTimeout(() => this.onWsOrderbookProbeTimeout(), this.config.wsOrderbookProbeMs);
    if (typeof this.wsProbeTimer === 'object' && this.wsProbeTimer && 'unref' in this.wsProbeTimer) {
      (this.wsProbeTimer as { unref: () => void }).unref();
    }
  }

  /**
   * La sonde a expiré sans qu'aucune frame orderbook WS ne soit arrivée :
   * le canal `clob_market` est MORT (confirmé par la réponse 400 du serveur).
   * On purge définitivement ses souscriptions pour ne plus jamais les renvoyer
   * (y compris après reconnexion) → fin du spam. Le REST assure les données.
   */
  private onWsOrderbookProbeTimeout(): void {
    this.wsProbeTimer = null;
    if (this.wsOrderbookFrameSeen || this.clobMarketWsDead) return;

    this.clobMarketWsDead = true;

    // Purge des souscriptions clob_market mémorisées (ne seront plus renvoyées).
    let purged = 0;
    for (const [id, msg] of Array.from(this.subscriptionMessages.entries())) {
      if (msg.subscriptions.some((s) => s.topic === 'clob_market')) {
        this.subscriptionMessages.delete(id);
        purged++;
      }
    }

    // Garantir une source de données : le REST (sauf si l'utilisateur a
    // explicitement demandé 'ws' seul).
    if (this.config.orderbookSource === 'auto') {
      if (this.restTokens.size > 0) this.ensureRestPoller();
    }

    this.warn(
      `canal WS 'clob_market' MORT (aucune frame orderbook en ${this.config.wsOrderbookProbeMs} ms ; ` +
        `le serveur répond 400 « CLOB messages are not supported anymore »). ` +
        `Bascule DÉFINITIVE sur REST /book (poll ${this.config.restPollIntervalMs} ms). ` +
        `${purged} souscription(s) clob_market purgée(s), plus aucun envoi. ` +
        `envoyées=${this.wsOrderbookSendAttempts}.`
    );

    // Vérifier qu'une source fournit bien des carnets.
    if (this.config.orderbookSource !== 'ws') this.ensureRestPoller();
  }

  /** Ajoute des tokens au polling REST (référencés par une souscription). */
  private addRestTokens(tokenIds: string[], subId: string): void {
    for (const t of tokenIds) {
      if (!t) continue;
      let refs = this.restTokens.get(t);
      if (!refs) {
        refs = new Set<string>();
        this.restTokens.set(t, refs);
      }
      refs.add(subId);
    }
    this.ensureRestPoller();
  }

  /** Retire les références d'une souscription ; supprime le token s'il n'est plus utilisé. */
  private removeRestTokens(tokenIds: string[], subId: string): void {
    for (const t of tokenIds) {
      const refs = this.restTokens.get(t);
      if (!refs) continue;
      refs.delete(subId);
      if (refs.size === 0) {
        this.restTokens.delete(t);
        this.orderbookLastHash.delete(t);
      }
    }
    if (this.restTokens.size === 0) this.stopRestPoller();
  }

  /** (Re)démarre le poller REST s'il y a des tokens et qu'il ne tourne pas. */
  private ensureRestPoller(): void {
    if (this.restPollTimer || this.restTokens.size === 0) return;
    this.restBackoffMs = 0;
    this.scheduleRestPoll(0);
    this.log(`REST /book polling démarré (${this.restTokens.size} token(s), ${this.config.restPollIntervalMs} ms)`);
  }

  private scheduleRestPoll(delayMs: number): void {
    if (this.restTokens.size === 0) {
      this.restPollTimer = null;
      return;
    }
    this.restPollTimer = setTimeout(() => {
      void this.restPollOnce();
    }, Math.max(0, delayMs));
    if (this.restPollTimer && 'unref' in this.restPollTimer) {
      (this.restPollTimer as { unref: () => void }).unref();
    }
  }

  /** Arrête le poller REST et réinitialise son état. */
  private stopRestPoller(): void {
    if (this.restPollTimer) {
      clearTimeout(this.restPollTimer);
      this.restPollTimer = null;
    }
    this.restBackoffMs = 0;
    this.restFailureStreak = 0;
  }

  /**
   * Une passe de polling : interroge `GET /book?token_id=` pour chaque token.
   * Échec total ⇒ backoff exponentiel + UN SEUL avertissement (re-log borné
   * toutes les 5 min), au lieu d'une erreur par requête.
   */
  private async restPollOnce(): Promise<void> {
    if (this.restTokens.size === 0) {
      this.restPollTimer = null;
      return;
    }

    const tokens = Array.from(this.restTokens.keys());
    let failures = 0;

    await Promise.all(
      tokens.map(async (tokenId) => {
        try {
          const book = await this.fetchRestBook(tokenId);
          if (book) {
            this.restRequestsOk++;
            this.emitOrderbook(book);
          } else {
            failures++;
            this.restRequestsFailed++;
          }
        } catch (err) {
          failures++;
          this.restRequestsFailed++;
          this.restLastError = this.brief(err);
        }
      })
    );

    const total = tokens.length;
    if (failures > 0 && failures === total) {
      // Échec TOTAL de la passe → backoff.
      this.restFailureStreak++;
      this.restBackoffMs = Math.min(
        this.restBackoffMs > 0 ? this.restBackoffMs * 2 : this.config.restBackoffBaseMs,
        60000
      );
      const now = Date.now();
      // Un seul message, puis au maximum un rappel toutes les 5 minutes.
      if (this.restWarnedAt === 0 || now - this.restWarnedAt >= 300000) {
        this.restWarnedAt = now;
        this.warn(
          `REST /book en échec total (${this.restFailureStreak} passe(s) consécutive(s)) → ` +
            `backoff ${this.restBackoffMs} ms. Dernière cause: ${this.restLastError || 'inconnue'}`
        );
      }
    } else {
      if (this.restBackoffMs > 0) {
        this.warn(
          `REST /book rétabli (${this.restFailureStreak} échec(s) consécutif(s) surmonté(s)). ` +
            `ok=${this.restRequestsOk} failed=${this.restRequestsFailed}`
        );
      }
      this.restBackoffMs = 0;
      this.restFailureStreak = 0;
      this.restWarnedAt = 0;
    }

    this.scheduleRestPoll(this.config.restPollIntervalMs + this.restBackoffMs);
  }

  /** Récupère un carnet via REST et le normalise au format OrderbookSnapshot. */
  private async fetchRestBook(tokenId: string): Promise<OrderbookSnapshot | null> {
    const url = `${this.config.clobHost}/book?token_id=${encodeURIComponent(tokenId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.restRequestTimeoutMs);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        asset_id?: string;
        market?: string;
        timestamp?: string | number;
        hash?: string;
        tick_size?: string | number;
        min_order_size?: string | number;
        bids?: Array<{ price: string; size: string }>;
        asks?: Array<{ price: string; size: string }>;
      };

      if (!json || !Array.isArray(json.bids) || !Array.isArray(json.asks)) return null;

      // ⚠️ L'API REST renvoie les asks du PLUS CHER au moins cher : il faut
      // trier (bids décroissant, asks croissant) pour un top-of-book correct,
      // exactement comme le faisait parseOrderbook() côté WS.
      const bids = json.bids
        .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
        .sort((a, b) => b.price - a.price);
      const asks = json.asks
        .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
        .sort((a, b) => a.price - b.price);

      const assetId = json.asset_id || tokenId;
      return {
        tokenId: assetId, // DipArbService lit `book.tokenId`
        assetId, // les handlers filtrent sur `book.assetId`
        market: json.market || '',
        bids,
        asks,
        timestamp: this.normalizeTimestamp(json.timestamp),
        tickSize: json.tick_size != null ? String(json.tick_size) : '0.01',
        minOrderSize: json.min_order_size != null ? String(json.min_order_size) : '1',
        hash: json.hash || '',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ==========================================================================
  // Observabilité / hygiène de log
  // ==========================================================================

  /** Snapshot d'état du service temps réel (diagnostic REST/WS). */
  getDataFeedStats(): {
    orderbookSource: 'auto' | 'ws' | 'rest';
    wsOrderbookDead: boolean;
    wsOrderbookFrameSeen: boolean;
    wsSendAttempts: number;
    restTokens: number;
    restPolling: boolean;
    restBackoffMs: number;
    restOk: number;
    restFailed: number;
    lastOrderbookAgoMs: number | null;
  } {
    return {
      orderbookSource: this.config.orderbookSource,
      wsOrderbookDead: this.clobMarketWsDead,
      wsOrderbookFrameSeen: this.wsOrderbookFrameSeen,
      wsSendAttempts: this.wsOrderbookSendAttempts,
      restTokens: this.restTokens.size,
      restPolling: this.restPollTimer !== null,
      restBackoffMs: this.restBackoffMs,
      restOk: this.restRequestsOk,
      restFailed: this.restRequestsFailed,
      lastOrderbookAgoMs: this.lastOrderbookAt ? Date.now() - this.lastOrderbookAt : null,
    };
  }

  /**
   * ✅ Hygiène de log : formate une erreur en UNE ligne bornée.
   * Même esprit que `errStr()` de dip-arb-service.ts. Les erreurs ethers v5
   * embarquent `transaction={…}` / `error={…}` → jusqu'à ~7 Ko par ligne.
   */
  private brief(value: unknown, maxLen = 240): string {
    const raw = (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim();
    if (raw.length <= maxLen) return raw;
    const suffix = `…[+${raw.length - maxLen}]`;
    return raw.slice(0, Math.max(0, maxLen - suffix.length)) + suffix;
  }

  /** Avertissement TOUJOURS visible (indépendant du flag `debug`). */
  private warn(message: string): void {
    console.warn(`[RealtimeService] ${message}`);
  }

  private sendSubscription(msg: { subscriptions: Array<{ topic: string; type: string; filters?: string; clob_auth?: ClobApiKeyCreds }> }): void {
    if (this.client && this.connected) {
      this.client.subscribe(msg);
    } else {
      this.log('Cannot subscribe: not connected');
    }
  }

  private sendUnsubscription(msg: { subscriptions: Array<{ topic: string; type: string; filters?: string }> }): void {
    if (this.client && this.connected) {
      this.client.unsubscribe(msg);
    }
  }

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[RealtimeService] ${message}`);
    }
  }

  /**
   * Normalize timestamp to milliseconds
   * Polymarket WebSocket returns timestamps in seconds, need to convert to milliseconds
   */
  private normalizeTimestamp(ts: unknown): number {
    if (typeof ts === 'string') {
      const parsed = parseInt(ts, 10);
      if (isNaN(parsed)) return Date.now();
      // If timestamp is in seconds (< 1e12), convert to milliseconds
      return parsed < 1e12 ? parsed * 1000 : parsed;
    }
    if (typeof ts === 'number') {
      // If timestamp is in seconds (< 1e12), convert to milliseconds
      return ts < 1e12 ? ts * 1000 : ts;
    }
    return Date.now();
  }
}
