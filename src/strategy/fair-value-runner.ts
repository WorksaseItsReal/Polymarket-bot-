/**
 * fair-value-runner.ts — boucle de la stratégie juste valeur (paper), testable.
 *
 * Toutes les entrées/sorties sont INJECTÉES (scan des marchés, carnets, données spot,
 * résolution, horloge, notifications, porte de risque) : le même code tourne dans le bot
 * et dans les tests de bout en bout (tests/fair-value-runner.test.ts), sans réseau.
 *
 * Un tick, dans cet ordre :
 *   1. résoudre les rounds terminés (même en pause : sinon le PnL et la levée de pause
 *      restent figés) ;
 *   2. porte de risque (`canTrade`) ;
 *   3. sorties anticipées si le marché paie plus que la position ne vaut ;
 *   4. nouvelles entrées : au plus une par round, décision `decide()`, mise
 *      `computeStake()`, exécution simulée au VWAP du carnet, re-contrôle de l'edge.
 * Le registre (fv-ledger.json) est écrit AVANT toute annonce : un trade non enregistré
 * n'est jamais notifié.
 */

import {
  binaryPayoff,
  decide,
  blendWithMarket,
  bookMidUp,
  estimateFill,
  estimateSell,
  maxBuyPriceForEdge,
  probUp,
  type BookLevel,
  type FairValueConfig,
} from '../services/fair-value.js';
import {
  ledgerStatsShared,
  loadLedger,
  readLedgerShared,
  recentLossStreak,
  saveLedger,
  settlePnl,
  type LedgerStats,
  type LedgerTrade,
  type RoundOutcome,
} from '../services/paper-ledger.js';
import type { DecisionRecord } from '../services/decision-journal.js';
import type { RoundMarketData } from '../services/round-market-data.js';
import { computeStake, MAX_VARIANCE_PCT } from '../services/stake-sizing.js';
import { msgAlert, msgTradeClosed, msgTradeOpened } from '../services/telegram-messages.js';

export const STRATEGY_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] as const;
export type StrategyCoin = (typeof STRATEGY_COINS)[number];

/** Coins tradés, depuis une liste « BTC,ETH » (env FV_COINS). Vide/invalide → tous. */
export function coinsFromEnv(raw: string | undefined): StrategyCoin[] {
  const wanted = (raw ?? '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
  const valid = STRATEGY_COINS.filter(c => wanted.includes(c));
  return valid.length ? valid : [...STRATEGY_COINS];
}

export interface ScannedMarket {
  conditionId: string;
  name?: string;
  slug: string;
  underlying: string;
  durationMinutes: number;
  upTokenId: string;
  downTokenId: string;
}

export interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface TradeOpenedEvent {
  trade: LedgerTrade;
  market: ScannedMarket;
  data: RoundMarketData;
  ask: number;
  tauSec: number;
  winProfit: number;
  /** Ligne de journal lisible (contexte + décision). */
  description: string;
}

export interface RunnerDeps {
  cfg: FairValueConfig;
  /** Marge de sortie anticipée (bid net − p_modèle). */
  exitEdge: number;
  ledgerPath: string;
  capital: () => number;
  now: () => number;
  /** Porte de risque du bot (pause, limites). */
  canTrade: () => boolean;
  scanMarkets: () => Promise<ScannedMarket[]>;
  /** Mise minimale exécutable (USDC). Polymarket refuse un achat au marché < 1 $ : un pari
   *  papier plus petit ne serait pas reproductible en réel. 0 = pas de contrôle. */
  minOrderUsd?: number;
  /** La mise est sous le minimum exécutable À CAUSE DU CAPITAL (1 % du capital actuel
   *  < minimum) — pas à cause d'un plafond temporaire (exposition, drawdown). */
  onBelowMinOrder?: (stake: number, minOrderUsd: number) => void;
  /** Parts minimales pour une revente anticipée (Polymarket refuse les petits ordres ;
   *  en dessous on garde jusqu'au règlement). 0 = pas de contrôle. */
  minSellShares?: number;
  /** Un tick sur mouvement fait aussi règlements + sorties si le dernier passage complet
   *  date de plus de ça (ms) : le tick de fond peut perdre la course à chaque fois. */
  fullPassEveryMs?: number;
  /** Délai simulé entre décision et exécution (ms) ; le carnet est relu après. 0 = aucun. */
  fillDelayMs?: number;
  /** Attente injectable (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Coins autorisés (défaut : les 5). */
  coins?: readonly string[];
  /** Âge max de la liste des marchés (ms, défaut 60 s). Toujours rafraîchie à chaque
   *  nouveau round, pour ne jamais manquer le début de la fenêtre d'entrée. */
  marketsRefreshMs?: number;
  getBook: (tokenId: string) => Promise<Book>;
  getRoundData: (coin: string, slotSec: number, nowMs: number) => Promise<RoundMarketData | null>;
  fetchOutcome: (slug: string) => Promise<RoundOutcome>;
  notify: (html: string) => void;
  log: (level: 'INFO' | 'WARN' | 'ERROR' | 'SIGNAL' | 'TRADE', msg: string) => void;
  timeZone?: string;
  /** Rappels optionnels (journal historique, compteurs du dashboard). */
  onTradeOpened?: (e: TradeOpenedEvent) => void;
  onTradeClosed?: (t: LedgerTrade) => void;
  /** Chaque évaluation complète (pari ou abstention), pour le journal des décisions. */
  onEvaluation?: (r: DecisionRecord) => void;
  /** Raison de bloquer les NOUVELLES entrées (arrêt de performance), ou null. Les
   *  évaluations continuent d'être journalisées : on garde l'œil sur le marché. */
  entryBlock?: () => string | null;
  /** La mise est tombée à 0 à cause d'un modérateur de risque (drawdown, série de pertes). */
  onRiskStop?: (reason: string) => void;
}

/** Fenêtre de la série de pertes : 8 pertes d'affilée = pause de 6 h, pas un arrêt définitif. */
export const LOSS_STREAK_WINDOW_MS = 6 * 3_600_000;

const SLUG_RE = /^(btc|eth|sol|xrp|doge)-updown-5m-(\d{9,})$/;

/** Meilleur niveau d'un côté du carnet (prix le plus bas pour les asks, le plus haut pour les bids). */
export function bestLevel(levels: BookLevel[], side: 'ask' | 'bid'): BookLevel | null {
  let best: BookLevel | null = null;
  for (const l of levels) {
    if (!(l.price > 0 && l.price < 1 && l.size > 0)) continue;
    if (best === null || (side === 'ask' ? l.price < best.price : l.price > best.price)) best = l;
  }
  return best;
}

/** Début du round (s) si le slug est EXACTEMENT `<coin>-updown-5m-<slot>` du bon coin. */
export function slotOf(market: Pick<ScannedMarket, 'slug' | 'underlying'>): number | null {
  const m = SLUG_RE.exec(market.slug);
  if (!m || m[1] !== market.underlying.toLowerCase()) return null;
  const slot = Number(m[2]);
  return Number.isFinite(slot) && slot > 0 ? slot : null;
}

export class FairValueRunner {
  private readonly d: RunnerDeps;
  private readonly traded = new Set<string>();
  private readonly lastHoldLog = new Map<string, number>();
  private readonly unresolvedWarned = new Set<string>();
  /** Dernière tentative de règlement par trade (Gamma interrogé au plus toutes les 10 s). */
  private readonly lastResolveTry = new Map<string, number>();
  /** Fin du dernier passage COMPLET (règlements + sorties), pour le chien de garde. */
  lastFullPassAt = 0;
  private markets: ScannedMarket[] = [];
  private marketsTs = 0;
  private marketsSlot = -1;
  private running = false;
  /** Fin du dernier tick (ms) et échecs consécutifs : alimentent le chien de garde. */
  lastTickEndedAt = 0;
  consecutiveTickFailures = 0;
  /** Dernière fois qu'au moins un marché 5 min a été trouvé (0 = jamais). */
  lastMarketsFoundAt = 0;
  private ledgerBrokenWarned = false;

  constructor(deps: RunnerDeps) {
    this.d = deps;
    // Après un redémarrage, ne jamais rejouer un round déjà joué.
    for (const t of this.trades() ?? []) this.traded.add(t.id);
  }

  // ---------------------------------------------------------------- registre

  /**
   * Trades du registre, en LECTURE SEULE (copie partagée et gelée, relue seulement si le
   * fichier change) ; null si le fichier est illisible (alerte une seule fois). Avant :
   * copie profonde à chaque lecture — 33 ms par passage à 5 000 trades, 190 ms à 20 000,
   * boucle d'événements bloquée d'autant.
   */
  private trades(): readonly LedgerTrade[] | null {
    const t = readLedgerShared(this.d.ledgerPath);
    if (t === null) {
      if (!this.ledgerBrokenWarned) {
        this.ledgerBrokenWarned = true;
        this.d.log('ERROR', `Registre ${this.d.ledgerPath} illisible : aucune position ne sera ouverte avant réparation (fichier préservé)`);
        this.d.notify(msgAlert('registre des trades illisible — le bot ne prend plus de position jusqu\'à réparation'));
      }
      return null;
    }
    this.ledgerBrokenWarned = false;
    return t;
  }

  private update(fn: (trades: LedgerTrade[]) => void): boolean {
    if (this.trades() === null) return false; // illisible : alerte, et surtout ne rien écraser
    const trades = loadLedger(this.d.ledgerPath); // copie modifiable, seulement pour écrire
    if (trades === null) return false;
    fn(trades);
    try {
      saveLedger(this.d.ledgerPath, trades);
      return true;
    } catch (err) {
      this.d.log('ERROR', `Registre : écriture impossible (${(err as Error).message})`);
      return false;
    }
  }

  stats(): LedgerStats {
    return ledgerStatsShared(this.d.ledgerPath);
  }

  private holdLog(id: string, msg: string): void {
    const now = this.d.now();
    if (now - (this.lastHoldLog.get(id) ?? 0) < 60_000) return;
    this.lastHoldLog.set(id, now);
    if (this.lastHoldLog.size > 200) {
      for (const [k, t] of this.lastHoldLog) if (now - t > 600_000) this.lastHoldLog.delete(k);
    }
    this.d.log('SIGNAL', msg);
  }

  // ---------------------------------------------------------------- tick

  /**
   * Un passage complet. `coins` restreint les ENTRÉES à ces coins (tick déclenché par un
   * mouvement du spot) ; résolution et sorties portent toujours sur tout le registre.
   * Renvoie false si un tick était déjà en cours (rien n'a été fait).
   */
  async tick(coins?: readonly string[]): Promise<boolean> {
    if (this.running) return false; // un tick lent ne chevauche jamais le suivant
    this.running = true;
    try {
      // Un tick déclenché par un mouvement du spot (`coins` fourni) va droit aux entrées :
      // c'est là que la vitesse compte. Règlements et sorties passent au tick de fond —
      // sauf si celui-ci n'a pas pu passer depuis trop longtemps (verrou pris par les ticks
      // sur mouvement en période agitée).
      const full = !coins || (this.d.fullPassEveryMs !== undefined && this.d.now() - this.lastFullPassAt >= this.d.fullPassEveryMs);
      if (full) await this.resolveFinishedRounds();
      if (this.trades() === null) return true;
      // Les sorties AVANT la porte de risque : vendre réduit le risque, une pause ne doit
      // pas empêcher de sortir d'une position.
      if (full) {
        await this.checkExits();
        this.lastFullPassAt = this.d.now();
      }
      // Porte de risque fermée : les ÉVALUATIONS continuent (journal, mesure « modèle vs
      // carnet », marchés rafraîchis pour le chien de garde) ; seules les entrées sont
      // bloquées. Avant, une pause coupait la mesure précisément pendant les mauvaises
      // périodes, ce qui flattait le verdict.
      await this.enterNewTrades(coins, this.d.canTrade() ? null : 'pause de risque');
      this.consecutiveTickFailures = 0;
    } catch (err) {
      this.consecutiveTickFailures++;
      this.d.log('WARN', `Stratégie juste valeur : tick en échec (${String((err as Error)?.message ?? err).slice(0, 160)}) — nouvel essai au prochain tick`);
    } finally {
      this.running = false;
      this.lastTickEndedAt = this.d.now();
    }
    return true;
  }

  /** Règle les trades dont le round est terminé et annonce le résultat. */
  async resolveFinishedRounds(): Promise<void> {
    const now = this.d.now();
    // Ouverts à régler, et reventes dont on relève l'issue du round (calibration, sans
    // toucher au PnL). Gamma est réinterrogé au plus toutes les 8 s par trade (< période
    // du tick de fond, pour ne pas sauter un passage sur une gigue de minuterie).
    for (const [id, at] of this.lastResolveTry) if (now - at > 3 * 3_600_000) this.lastResolveTry.delete(id);
    const all = this.trades() ?? [];
    const open = all.filter(t => t.status === 'open' && now > t.endMs + 15_000
      && now - (this.lastResolveTry.get(t.id) ?? -Infinity) >= 8_000);
    // Reventes : simple relevé pour la calibration → peu prioritaire (2 par passage, une
    // fois par minute au plus) pour ne pas allonger le passage quand Gamma est lent.
    const sold = all.filter(t => t.status === 'sold' && t.outcomeUpWon === undefined && now > t.endMs + 15_000
      && now - t.endMs < 2 * 3_600_000 && now - (this.lastResolveTry.get(t.id) ?? -Infinity) >= 60_000).slice(0, 2);
    const due = [...open, ...sold];
    for (const t of due) {
      this.lastResolveTry.set(t.id, now);
      const outcome = await this.d.fetchOutcome(t.slug);
      if (outcome.resolved && t.status === 'sold') {
        this.update(trades => {
          const x = trades.find(y => y.id === t.id);
          if (x) x.outcomeUpWon = outcome.upWon;
        });
        this.lastResolveTry.delete(t.id);
        continue;
      }
      if (!outcome.resolved) {
        if (t.status === 'open' && now > t.endMs + 30 * 60_000 && !this.unresolvedWarned.has(t.id)) {
          this.unresolvedWarned.add(t.id);
          this.d.log('WARN', `Round ${t.slug} toujours non réglé 30 min après la fin (${outcome.reason}) — nouvel essai en continu`);
        }
        continue;
      }
      const won = outcome.upWon === (t.side === 'UP');
      const pnl = settlePnl(t, won);
      let closed: LedgerTrade | null = null;
      const saved = this.update(trades => {
        const x = trades.find(y => y.id === t.id && y.status === 'open');
        if (x) {
          Object.assign(x, { status: won ? 'won' : 'lost', pnl, resolvedAt: new Date(now).toISOString(), outcomeUpWon: outcome.upWon });
          closed = x;
        }
      });
      if (!saved || !closed) continue;
      this.unresolvedWarned.delete(t.id);
      this.lastResolveTry.delete(t.id);
      const stats = this.stats();
      this.d.log('TRADE', `[SIMULATION] ${won ? 'GAGNÉ' : 'PERDU'} ${t.coin} ${t.side} (${t.slug}) ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} — `
        + `bilan ${stats.n} trades, WR ${stats.winRate === null ? '—' : (stats.winRate * 100).toFixed(1) + ' %'}, PnL $${stats.pnl.toFixed(2)}`);
      this.d.notify(msgTradeClosed({
        coin: t.coin, side: t.side, slotSec: t.slotSec ?? t.endMs / 1000 - 300, outcome: won ? 'won' : 'lost', pnl, stats, timeZone: this.d.timeZone,
      }));
      this.d.onTradeClosed?.(closed);
    }
  }

  /**
   * Revend une position si (bid − frais) dépasse sa valeur modèle d'au moins exitEdge.
   * Modèle d'exécution : la décision (et donc le prix plancher net) est prise avec les
   * données de l'instant t ; l'ordre arrive après `fillDelayMs` et ne touche que les bids
   * au-dessus du plancher. On ne réévalue PAS le modèle après le délai (ce serait voir
   * l'avenir). Un seul délai pour toutes les positions candidates.
   */
  async checkExits(): Promise<void> {
    const { cfg } = this.d;
    const now = this.d.now();
    const minShares = this.d.minSellShares ?? 0;
    const candidates: Array<{ pos: LedgerTrade; floor: number; pHeld: number }> = [];
    for (const pos of (this.trades() ?? []).filter(t => t.status === 'open')) {
      const tauSec = (pos.endMs - now) / 1000;
      // En fin de round le modèle n'est pas fiable : on garde jusqu'à la résolution.
      if (tauSec < cfg.minTauSec || !pos.tokenId || !pos.slotSec) continue;
      if (pos.shares < minShares) continue; // trop petit pour un ordre de vente réel
      try {
        const data = await this.d.getRoundData(pos.coin, pos.slotSec, now);
        const pUp = data ? probUp({ ...data, tauSec }, cfg) : null;
        if (pUp === null) continue;
        const book = await this.d.getBook(pos.tokenId);
        // Même probabilité qu'à l'entrée, même formule : avec un mélange actif, prix du
        // carnet = milieu entre l'ask Up et 1 − l'ask Down (il faut donc l'autre carnet,
        // lu seulement dans ce cas : sans mélange, aucun appel de plus).
        let marketUp: number | null = null;
        if ((cfg.blendMarket ?? 0) !== 0) {
          // Token opposé enregistré à l'entrée (indépendant de la liste des marchés, vide
          // après un redémarrage tant que les entrées sont bloquées) ; anciens trades : liste.
          const m = pos.otherTokenId ? null : this.markets.find(x => x.slug === pos.slug);
          const otherId = pos.otherTokenId ?? (m ? (pos.side === 'UP' ? m.downTokenId : m.upTokenId) : null);
          if (!otherId) continue; // round introuvable : on garde la position
          const heldAsk = bestLevel(book.asks, 'ask')?.price ?? null;
          const otherAsk = bestLevel((await this.d.getBook(otherId)).asks, 'ask')?.price ?? null;
          marketUp = pos.side === 'UP' ? bookMidUp(heldAsk, otherAsk) : bookMidUp(otherAsk, heldAsk);
        }
        const pUsed = blendWithMarket(pUp, marketUp, cfg);
        if (pUsed === null) continue;
        const pHeld = pos.side === 'UP' ? pUsed : 1 - pUsed;
        const floor = pHeld + this.d.exitEdge; // prix net minimal de l'ordre de vente
        const sale = estimateSell(book.bids, pos.shares, cfg.takerFeeRate, floor);
        if (sale.complete) candidates.push({ pos, floor, pHeld });
      } catch {
        /* carnet ou flux indisponible : on garde la position */
      }
    }
    if (!candidates.length) return;
    const delay = this.d.fillDelayMs ?? 0;
    if (delay > 0) await (this.d.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(delay);
    const at = this.d.now();
    for (const { pos, floor, pHeld } of candidates) {
      try {
        // Carnet relu à l'arrivée de l'ordre : seuls les bids au-dessus du plancher comptent.
        const sale = estimateSell((await this.d.getBook(pos.tokenId as string)).bids, pos.shares, cfg.takerFeeRate, floor);
        if (!sale.complete || sale.avgPrice === null) {
          this.d.log('SIGNAL', `   ↳ revente ${pos.coin} ${pos.side} abandonnée : bids sous le plancher ${floor.toFixed(3)} à l'arrivée de l'ordre`);
          continue;
        }
        const exitPrice = sale.avgPrice;
        const netPerShare = sale.netProceeds / pos.shares;
        const profit = sale.netProceeds - pos.stake;
        let closed: LedgerTrade | null = null;
        const saved = this.update(trades => {
          const x = trades.find(y => y.id === pos.id && y.status === 'open');
          if (x) {
            Object.assign(x, { status: 'sold', pnl: profit, resolvedAt: new Date(at).toISOString(), exitPrice });
            closed = x;
          }
        });
        if (!saved || !closed) continue;
        this.d.log('TRADE', `[SIMULATION] VENTE ${pos.coin} ${pos.side} @ VWAP $${exitPrice.toFixed(3)} (net frais ${netPerShare.toFixed(3)} ≥ p_modèle ${pHeld.toFixed(3)} + ${this.d.exitEdge}) `
          + `round ${pos.slug} — PnL réalisé ${profit >= 0 ? '+' : ''}$${profit.toFixed(4)}`);
        this.d.notify(msgTradeClosed({ coin: pos.coin, side: pos.side, slotSec: pos.slotSec as number, outcome: 'sold', pnl: profit, stats: this.stats(), timeZone: this.d.timeZone }));
        this.d.onTradeClosed?.(closed);
      } catch {
        /* carnet indisponible : on garde la position */
      }
    }
  }

  private async refreshMarkets(): Promise<void> {
    const now = this.d.now();
    const slot = Math.floor(now / 300_000);
    const fresh = now - this.marketsTs <= (this.d.marketsRefreshMs ?? 60_000);
    if (fresh && slot === this.marketsSlot && this.markets.length) return;
    this.marketsSlot = slot;
    const scanned = await this.d.scanMarkets();
    this.markets = (Array.isArray(scanned) ? scanned : []).filter(
      m => !!m && !!m.conditionId && m.durationMinutes === 5 && (this.d.coins ?? STRATEGY_COINS).includes(m.underlying) && slotOf(m) !== null,
    );
    this.marketsTs = now;
    if (this.markets.length) this.lastMarketsFoundAt = now;
  }

  async enterNewTrades(coins?: readonly string[], gateBlock: string | null = null): Promise<void> {
    const { cfg } = this.d;
    await this.refreshMarkets();
    for (const market of this.markets) {
      if (coins && !coins.includes(market.underlying)) continue;
      if (this.traded.has(market.conditionId)) continue;
      const slot = slotOf(market) as number;
      const endMs = slot * 1000 + 300_000;
      const now = this.d.now();
      let tauSec = (endMs - now) / 1000;
      if (tauSec < cfg.minTauSec || tauSec > cfg.maxTauSec) continue; // aucun appel réseau hors fenêtre
      const coin = market.underlying;
      let rec: DecisionRecord | null = null; // évaluation journalisée (pari ou abstention)
      try {
        const data = await this.d.getRoundData(coin, slot, now);
        if (!data) {
          this.holdLog(market.conditionId, `   ↳ ${market.slug} : spot/strike/vol indisponibles ou périmés → pas de mise`);
          continue;
        }
        const [upBook, downBook] = await Promise.all([this.d.getBook(market.upTokenId), this.d.getBook(market.downTokenId)]);
        // τ recalculé APRÈS les attentes réseau (bougies, carnets) : c'est l'instant où le
        // carnet a été lu qui compte.
        const nowBook = this.d.now();
        tauSec = (endMs - nowBook) / 1000;
        if (tauSec < cfg.minTauSec || tauSec > cfg.maxTauSec) continue;
        const upBest = bestLevel(upBook.asks, 'ask');
        const downBest = bestLevel(downBook.asks, 'ask');
        const upBid = bestLevel(upBook.bids, 'bid');
        const downBid = bestLevel(downBook.bids, 'bid');
        const decision = decide({ ...data, tauSec, upAsk: upBest?.price ?? null, downAsk: downBest?.price ?? null }, cfg);
        rec = {
          t: now, slug: market.slug, coin, tau: Math.round(tauSec * 10) / 10, spot: data.spot, strike: data.strike,
          sig: data.sigmaPerSqrtSec, pUp: decision.pUp, pRaw: decision.pRaw ?? null, zs: cfg.zScale, upAsk: upBest?.price ?? null, downAsk: downBest?.price ?? null,
          upAskSz: upBest?.size ?? null, downAskSz: downBest?.size ?? null,
          upBid: upBid?.price ?? null, downBid: downBid?.price ?? null, upBidSz: upBid?.size ?? null, downBidSz: downBid?.size ?? null,
          src: data.source, act: 'hold',
        };
        const ctx = `${coin} spot ${data.spot} vs strike ${data.strike} (${data.source}), `
          + `σ1m ${(data.sigmaPerSqrtSec * Math.sqrt(60) * 100).toFixed(3)} %, τ ${Math.round(tauSec)} s`;
        if (!decision.side || !decision.best) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → HOLD : ${decision.reason}`);
          continue;
        }

        const block = gateBlock ?? this.d.entryBlock?.() ?? null;
        if (block) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → signal ${decision.side} ignoré : entrées bloquées (${block})`);
          continue;
        }

        const q = decision.best;
        const stats = this.stats();
        const initialCapital = this.d.capital();
        // Mise sur le capital ACTUEL (départ + PnL réalisé), pas sur le capital de départ :
        // après des pertes, « 1 % » doit rester 1 % de ce qui reste.
        const equity = initialCapital + stats.pnl;
        const peakCapital = initialCapital + stats.peakPnl;
        const stakeRes = computeStake({
          capital: equity,
          entryPrice: q.cost,
          // Probabilité de décision (modèle, ou mélange modèle/carnet s'il est configuré), shrinkée
          // de moitié vers le prix par computeStake (λ = 0,5) — prudence voulue, même si elle se cumule
          // avec le mélange.
          bookProb: q.prob,
          consecutiveLosses: recentLossStreak(readLedgerShared(this.d.ledgerPath) ?? [], now, LOSS_STREAK_WINDOW_MS),
          drawdownCurrent: peakCapital > 0 ? stats.drawdownNow / peakCapital : 0,
          openExposureEur: stats.openExposure,
          openPositions: stats.open,
          // Deux rounds de 5 coins peuvent se chevaucher (le round fini attend son règlement
          // Gamma) : 10 positions, l'exposition restant plafonnée à 10 % du capital.
          maxConcurrentPositions: 10,
        });
        if (stakeRes.skipped || !(stakeRes.stake > 0)) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : ${stakeRes.rationale}`);
          if (stakeRes.bindingConstraint === 'drawdown' || stakeRes.bindingConstraint === 'série de pertes') {
            this.d.onRiskStop?.(stakeRes.rationale);
          }
          continue;
        }
        const minOrder = this.d.minOrderUsd ?? 0;
        if (stakeRes.stake < minOrder) {
          // Cause structurelle (1 % du capital actuel sous le minimum) ou temporaire
          // (budget d'exposition restant, réduction après drawdown/série de pertes) ?
          const structural = equity * MAX_VARIANCE_PCT < minOrder;
          this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : ${stakeRes.stake.toFixed(2)} $ < minimum Polymarket ${minOrder} $ `
            + (structural ? '(capital papier trop petit pour un ordre réel)' : `(mise réduite : ${stakeRes.bindingConstraint})`));
          if (structural) this.d.onBelowMinOrder?.(stakeRes.stake, minOrder);
          continue;
        }

        // Prix RÉEL : la mise consomme le carnet niveau par niveau ; l'edge est re-vérifié au VWAP.
        let book = decision.side === 'UP' ? upBook : downBook;
        // Latence d'exécution simulée : en réel l'ordre arrive après la décision, et les
        // prix en retard sont souvent déjà pris. On relit le carnet après `fillDelayMs` et
        // on n'exécute QUE sur ce carnet-là (sinon le papier gonfle les gains).
        // Ordre envoyé À LA DÉCISION avec un prix limite qui garantit l'edge minimal selon
        // l'information de cet instant (q.prob). Il arrive après `fillDelayMs` et ne prend
        // que les asks sous la limite. On ne réévalue PAS le modèle après le délai : un vrai
        // ordre ne peut pas « voir » le mouvement du spot pendant son trajet (biais
        // d'anticipation qui flattait le papier).
        const limit = Math.min(cfg.maxAsk, maxBuyPriceForEdge(q.prob, cfg.minEdge, cfg.takerFeeRate) ?? 0);
        const delay = this.d.fillDelayMs ?? 0;
        if (delay > 0) {
          await (this.d.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(delay);
          book = await this.d.getBook(decision.side === 'UP' ? market.upTokenId : market.downTokenId);
        }
        const fillAt = this.d.now();
        const fill = estimateFill(book.asks, stakeRes.stake, limit, cfg.takerFeeRate);
        if (!fill.complete || fill.avgPrice === null || fill.avgCost === null) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : profondeur insuffisante pour $${stakeRes.stake.toFixed(2)} sous la limite ${limit.toFixed(3)}`
            + (delay > 0 ? ` (carnet relu ${delay} ms après la décision : opportunité disparue ?)` : ''));
          continue;
        }
        const entryCost = fill.avgCost; // coût exact par part, frais inclus niveau par niveau
        const edgeAtFill = q.prob - entryCost;
        if (edgeAtFill < cfg.minEdge - 1e-9) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : edge au VWAP ${(edgeAtFill * 100).toFixed(1)} pt < ${(cfg.minEdge * 100).toFixed(1)} pt`);
          continue;
        }

        const stake = stakeRes.stake;
        const { shares, winProfit } = binaryPayoff(stake, entryCost);
        const trade: LedgerTrade = {
          id: market.conditionId, slug: market.slug, coin, side: decision.side, stake, costPerShare: entryCost, shares,
          modelProb: q.prob, edge: edgeAtFill, openedAt: new Date(fillAt).toISOString(), endMs, status: 'open', pnl: null,
          tokenId: decision.side === 'UP' ? market.upTokenId : market.downTokenId,
          otherTokenId: decision.side === 'UP' ? market.downTokenId : market.upTokenId, slotSec: slot,
        };
        let pushed = false;
        const saved = this.update(trades => {
          if (!trades.some(t => t.id === trade.id)) {
            trades.push(trade);
            pushed = true;
          }
        });
        if (saved) this.traded.add(market.conditionId); // déjà présent ou ajouté : round joué
        if (!saved || !pushed) {
          // Jamais d'annonce d'un trade non enregistré (ni en double s'il l'était déjà).
          this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : ${saved ? 'round déjà présent au registre' : 'registre non enregistrable'}`);
          continue;
        }
        if (this.traded.size > 2000) {
          const first = this.traded.values().next().value;
          if (first) this.traded.delete(first);
        }
        const description = `📈 ${ctx} → Décision ${decision.side} @ VWAP $${fill.avgPrice.toFixed(3)} + frais = $${entryCost.toFixed(4)}/part, `
          + `p_modèle ${q.prob.toFixed(3)}, edge ${(edgeAtFill * 100).toFixed(1)} pt, mise $${stake.toFixed(2)} (${stakeRes.bindingConstraint}) `
          + `— gain $${winProfit.toFixed(4)} si ${decision.side} / perte $${stake.toFixed(2)} sinon`;
        this.d.notify(msgTradeOpened({
          coin, side: decision.side, slotSec: slot, tauSec, strike: data.strike, spot: data.spot,
          modelProb: q.prob, costPerShare: entryCost, edge: edgeAtFill, stake, winProfit, timeZone: this.d.timeZone,
        }));
        rec = { ...(rec as DecisionRecord), act: 'buy', side: decision.side, stake };
        this.d.onTradeOpened?.({ trade, market, data, ask: fill.avgPrice, tauSec, winProfit, description });
      } catch (err) {
        this.holdLog(market.conditionId, `   ↳ ${market.slug} : erreur d'analyse (${String((err as Error)?.message ?? err).slice(0, 160)}) → pas de mise`);
      } finally {
        if (rec) {
          try { this.d.onEvaluation?.(rec); } catch { /* le journal ne doit jamais bloquer la stratégie */ }
        }
      }
    }
  }
}
