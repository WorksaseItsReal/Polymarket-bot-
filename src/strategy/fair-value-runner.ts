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
  effectiveCostPerShare,
  estimateFill,
  estimateSell,
  probUp,
  type BookLevel,
  type FairValueConfig,
} from '../services/fair-value.js';
import {
  computeStats,
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
import { computeStake } from '../services/stake-sizing.js';
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
  /** La mise calculée est sous le minimum exécutable (capital papier trop petit). */
  onBelowMinOrder?: (stake: number, minOrderUsd: number) => void;
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
  private lastExitCheck = 0;
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

  /** Trades du registre ; null si le fichier est illisible (alerte une seule fois). */
  private trades(): LedgerTrade[] | null {
    const t = loadLedger(this.d.ledgerPath);
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
    const trades = this.trades();
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
    return computeStats(readLedgerShared(this.d.ledgerPath) ?? []);
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
      // c'est là que la vitesse compte. Règlements et sorties passent au tick de fond.
      if (!coins) await this.resolveFinishedRounds();
      if (this.trades() === null) return true;
      // Les sorties AVANT la porte de risque : vendre réduit le risque, une pause ne doit
      // pas empêcher de sortir d'une position.
      if (!coins) await this.checkExits();
      if (!this.d.canTrade()) return true;
      await this.enterNewTrades(coins);
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
    const due = (this.trades() ?? []).filter(t => t.status === 'open' && now > t.endMs + 15_000
      && now - (this.lastResolveTry.get(t.id) ?? -Infinity) >= 10_000);
    for (const t of due) {
      this.lastResolveTry.set(t.id, now);
      const outcome = await this.d.fetchOutcome(t.slug);
      if (!outcome.resolved) {
        if (now > t.endMs + 30 * 60_000 && !this.unresolvedWarned.has(t.id)) {
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
          Object.assign(x, { status: won ? 'won' : 'lost', pnl, resolvedAt: new Date(now).toISOString() });
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

  /** Revend une position si (bid − frais) dépasse sa valeur modèle d'au moins exitEdge. */
  async checkExits(): Promise<void> {
    const { cfg } = this.d;
    const now = this.d.now();
    // Les ticks déclenchés par le spot peuvent être rapprochés : la revue des sorties
    // (un carnet par position) est bornée à une fois toutes les 5 s.
    if (now - this.lastExitCheck < 5000) return;
    this.lastExitCheck = now;
    for (const pos of (this.trades() ?? []).filter(t => t.status === 'open')) {
      const tauSec = (pos.endMs - now) / 1000;
      // En fin de round le modèle n'est pas fiable : on garde jusqu'à la résolution.
      if (tauSec < cfg.minTauSec || !pos.tokenId || !pos.slotSec) continue;
      try {
        // Valeur de la position selon le modèle, et produit NET d'une vente au marché.
        const valueAndSale = async (atMs: number) => {
          const data = await this.d.getRoundData(pos.coin, pos.slotSec as number, atMs);
          const tau = (pos.endMs - atMs) / 1000;
          const pUp = data && tau > 0 ? probUp({ ...data, tauSec: tau }, cfg) : null;
          if (pUp === null) return null;
          const sale = estimateSell((await this.d.getBook(pos.tokenId as string)).bids, pos.shares, cfg.takerFeeRate);
          if (!sale.complete || sale.avgPrice === null) return null;
          const pHeld = pos.side === 'UP' ? pUp : 1 - pUp;
          return { pHeld, sale, netPerShare: sale.netProceeds / pos.shares };
        };
        let v = await valueAndSale(now);
        if (!v || v.netPerShare - v.pHeld < this.d.exitEdge) continue;
        // Même latence simulée qu'à l'entrée : un bid « trop beau » est souvent un prix en
        // retard qui aura disparu quand l'ordre arrive. On revalide sur le carnet relu.
        const delay = this.d.fillDelayMs ?? 0;
        let at = now;
        if (delay > 0) {
          await (this.d.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(delay);
          at = this.d.now();
          v = await valueAndSale(at);
          if (!v || v.netPerShare - v.pHeld < this.d.exitEdge) continue;
        }
        const { pHeld, sale, netPerShare } = v;
        const exitPrice = sale.avgPrice as number;
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
        this.d.log('TRADE', `[SIMULATION] VENTE ${pos.coin} ${pos.side} @ VWAP $${exitPrice.toFixed(3)} (net frais ${netPerShare.toFixed(3)} > p_modèle ${pHeld.toFixed(3)} + ${this.d.exitEdge}) `
          + `round ${pos.slug} — PnL réalisé ${profit >= 0 ? '+' : ''}$${profit.toFixed(4)}`);
        this.d.notify(msgTradeClosed({ coin: pos.coin, side: pos.side, slotSec: pos.slotSec, outcome: 'sold', pnl: profit, stats: this.stats(), timeZone: this.d.timeZone }));
        this.d.onTradeClosed?.(closed);
      } catch {
        /* carnet ou flux indisponible : on garde la position */
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

  async enterNewTrades(coins?: readonly string[]): Promise<void> {
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
        const bestAsk = (b: Book) => b.asks
          .filter(l => l.price > 0 && l.size > 0)
          .reduce<BookLevel | null>((m, l) => (m === null || l.price < m.price ? l : m), null);
        const upBest = bestAsk(upBook);
        const downBest = bestAsk(downBook);
        const decision = decide({ ...data, tauSec, upAsk: upBest?.price ?? null, downAsk: downBest?.price ?? null }, cfg);
        rec = {
          t: now, slug: market.slug, coin, tau: Math.round(tauSec * 10) / 10, spot: data.spot, strike: data.strike,
          sig: data.sigmaPerSqrtSec, pUp: decision.pUp, upAsk: upBest?.price ?? null, downAsk: downBest?.price ?? null,
          upAskSz: upBest?.size ?? null, downAskSz: downBest?.size ?? null, src: data.source, act: 'hold',
        };
        const ctx = `${coin} spot ${data.spot} vs strike ${data.strike} (${data.source}), `
          + `σ1m ${(data.sigmaPerSqrtSec * Math.sqrt(60) * 100).toFixed(3)} %, τ ${Math.round(tauSec)} s`;
        if (!decision.side || !decision.best) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → HOLD : ${decision.reason}`);
          continue;
        }

        const block = this.d.entryBlock?.() ?? null;
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
          // Probabilité du MODÈLE, shrinkée de moitié vers le prix par computeStake (λ = 0,5).
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
          this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : ${stakeRes.stake.toFixed(2)} $ < minimum Polymarket ${minOrder} $ (capital papier trop petit pour un ordre réel)`);
          this.d.onBelowMinOrder?.(stakeRes.stake, minOrder);
          continue;
        }

        // Prix RÉEL : la mise consomme le carnet niveau par niveau ; l'edge est re-vérifié au VWAP.
        let book = decision.side === 'UP' ? upBook : downBook;
        // Latence d'exécution simulée : en réel l'ordre arrive après la décision, et les
        // prix en retard sont souvent déjà pris. On relit le carnet après `fillDelayMs` et
        // on n'exécute QUE sur ce carnet-là (sinon le papier gonfle les gains).
        const delay = this.d.fillDelayMs ?? 0;
        // Probabilité au moment de l'exécution : si le spot a bougé pendant la latence, c'est
        // elle qui compte (et non celle de la décision).
        let pFill = q.prob;
        if (delay > 0) {
          await (this.d.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(delay);
          const atFill = this.d.now();
          const [bookFill, dataFill] = await Promise.all([
            this.d.getBook(decision.side === 'UP' ? market.upTokenId : market.downTokenId),
            this.d.getRoundData(coin, slot, atFill),
          ]);
          book = bookFill;
          const pUpFill = dataFill ? probUp({ ...dataFill, tauSec: (endMs - atFill) / 1000 }, cfg) : null;
          if (pUpFill === null) {
            this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : données indisponibles au moment de l'exécution`);
            continue;
          }
          pFill = decision.side === 'UP' ? pUpFill : 1 - pUpFill;
        }
        const fill = estimateFill(book.asks, stakeRes.stake, cfg.maxAsk);
        if (!fill.complete || fill.avgPrice === null) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : profondeur insuffisante pour $${stakeRes.stake.toFixed(2)} sous ${cfg.maxAsk}`);
          continue;
        }
        const entryCost = effectiveCostPerShare(fill.avgPrice, cfg.takerFeeRate);
        const edgeAtFill = pFill - entryCost;
        if (edgeAtFill < cfg.minEdge) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : edge au VWAP ${(edgeAtFill * 100).toFixed(1)} pt < ${(cfg.minEdge * 100).toFixed(1)} pt`
            + (delay > 0 ? ` (carnet relu ${delay} ms après la décision : opportunité disparue)` : ''));
          continue;
        }

        const stake = stakeRes.stake;
        const { shares, winProfit } = binaryPayoff(stake, entryCost);
        const trade: LedgerTrade = {
          id: market.conditionId, slug: market.slug, coin, side: decision.side, stake, costPerShare: entryCost, shares,
          modelProb: pFill, edge: edgeAtFill, openedAt: new Date(now).toISOString(), endMs, status: 'open', pnl: null,
          tokenId: decision.side === 'UP' ? market.upTokenId : market.downTokenId, slotSec: slot,
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
          + `p_modèle ${pFill.toFixed(3)}, edge ${(edgeAtFill * 100).toFixed(1)} pt, mise $${stake.toFixed(2)} (${stakeRes.bindingConstraint}) `
          + `— gain $${winProfit.toFixed(4)} si ${decision.side} / perte $${stake.toFixed(2)} sinon`;
        this.d.notify(msgTradeOpened({
          coin, side: decision.side, slotSec: slot, tauSec, strike: data.strike, spot: data.spot,
          modelProb: pFill, costPerShare: entryCost, edge: edgeAtFill, stake, winProfit, timeZone: this.d.timeZone,
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
