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
 * Le registre (fv-ledger.jsonl, ledger-store.ts) est écrit AVANT toute annonce : un trade
 * non enregistré n'est jamais notifié. Chaque modification y ajoute UNE ligne (ouverture,
 * règlement, revente…) : aucun travail proportionnel à l'historique pendant un passage.
 */

import {
  binaryPayoff,
  decide,
  effectiveCostPerShare,
  entryMinTauSec,
  blendNoiseFactor,
  blendWithMarket,
  bookMidUp,
  estimateFill,
  estimateSell,
  maxBuyPriceForEdge,
  probNoiseSd,
  probUp,
  probUpLate,
  type BookLevel,
  type FairValueConfig,
} from '../services/fair-value.js';
import {
  settlePnl,
  strategyOf,
  type LedgerStats,
  type LedgerTrade,
  type RoundOutcome,
  type StrategyKey,
} from '../services/paper-ledger.js';
import { ledgerStore, type LedgerStore } from '../services/ledger-store.js';
import type { DecisionRecord } from '../services/decision-journal.js';
import type { RoundMarketData } from '../services/round-market-data.js';
import { computeStake, MAX_VARIANCE_PCT } from '../services/stake-sizing.js';
import { msgAlert, msgTradeClosed, msgTradeOpened } from '../services/telegram-messages.js';
import { FavoriteStreaks, HARVEST_EXPECTED_WIN, harvestDecision, harvestSide, type HarvestConfig, type HarvestSide } from './late-harvest.js';

export const STRATEGY_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] as const;
/** Sous ce τ, plus de mesure « fin de round » (lecture des carnets trop proche du règlement). */
const LATE_MIN_TAU_SEC = 5;
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
  /** Prix à battre officiel s'il est déjà publié (mesure, journalisé en `ps`). */
  priceToBeat?: number;
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
  /** Chaque évaluation complète (pari ou abstention), pour le journal des décisions.
   *  `reason` : la ligne lisible correspondante (HOLD et pourquoi, ou le pari pris). */
  onEvaluation?: (r: DecisionRecord, reason: string) => void;
  /** Raison de bloquer les NOUVELLES entrées (arrêt de performance), ou null. Les
   *  évaluations continuent d'être journalisées : on garde l'œil sur le marché. */
  entryBlock?: () => string | null;
  /** La mise est tombée à 0 à cause d'un modérateur de risque (drawdown, série de pertes). */
  onRiskStop?: (reason: string) => void;
  /** Récolte de fin de round (late-harvest.ts, papier). Absente ou désactivée = jamais. */
  harvest?: HarvestConfig;
  /** Blocages de la récolte (arrêt du bot, horloge, SON garde-fou de performance), ou null.
   *  Absent : `entryBlock` s'applique aussi à la récolte. */
  harvestBlock?: () => string | null;
}

/** Identifiant de registre d'un trade de récolte (distinct du trade juste valeur du même round). */
export const harvestTradeId = (conditionId: string): string => `${conditionId}|late`;

/** Fenêtre de la série de pertes : 8 pertes d'affilée = pause de 6 h, pas un arrêt définitif. */
export const LOSS_STREAK_WINDOW_MS = 6 * 3_600_000;

const SLUG_RE = /^(btc|eth|sol|xrp|doge)-updown-5m-(\d{9,})$/;
/** Prix lisible dans les logs : 7 chiffres significatifs (BTC 62034.57, DOGE 0.1234568), pas 14 décimales. */
const px = (x: number): string => (Number.isFinite(x) ? String(Number(x.toPrecision(7))) : String(x));

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
  private readonly unresolvedAlerted = new Set<string>();
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
  private lastPauseLog = -Infinity;
  private ledgerBrokenWarned = false;
  /** Séries « favori bloqué à 0,99 » par marché (récolte de fin de round). */
  private readonly streaks = new FavoriteStreaks();
  /** Registre partagé du processus (journal append-only, statistiques incrémentales). */
  private readonly store: LedgerStore;

  constructor(deps: RunnerDeps) {
    this.d = deps;
    this.store = ledgerStore(deps.ledgerPath);
    // Après un redémarrage, ne jamais rejouer un round déjà joué (un round ne se joue que
    // pendant ses 5 minutes : les identifiants des 7 derniers jours suffisent).
    if (this.trades() !== null) for (const id of this.store.recentIds()) this.traded.add(id);
  }

  // ---------------------------------------------------------------- registre

  /**
   * Trades VIVANTS du registre (positions ouvertes, reventes dont l'issue du round reste à
   * relever), en lecture seule ; null si le registre est illisible (alerte une seule fois).
   * L'historique réglé n'est jamais parcouru : les statistiques sont tenues par le registre.
   */
  private trades(): readonly LedgerTrade[] | null {
    const t = this.store.liveTrades();
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

  /**
   * Écrit au registre (une ligne ajoutée). `saved` faux : registre illisible (rien n'est écrit,
   * alerte) ou écriture impossible (journalisée). `result` : ce que renvoie l'opération.
   */
  private write<T>(op: (store: LedgerStore) => T): { saved: boolean; result: T | null } {
    if (this.trades() === null) return { saved: false, result: null }; // illisible : ne rien écrire
    try {
      return { saved: true, result: op(this.store) };
    } catch (err) {
      this.d.log('ERROR', `Registre : écriture impossible (${(err as Error).message})`);
      return { saved: false, result: null };
    }
  }

  stats(): LedgerStats {
    return this.store.stats('total');
  }

  /** Statistiques d'une seule stratégie (messages, séries de pertes, garde-fous). */
  statsFor(key: StrategyKey): LedgerStats {
    return this.store.stats(key);
  }

  /** Dernière ligne lisible par marché (même si le journal l'a tue par throttling). */
  private readonly lastReason = new Map<string, string>();
  /** Dernière mesure « fin de round » par marché (ms). */
  private readonly lateAt = new Map<string, number>();

  private holdLog(id: string, msg: string): void {
    this.lastReason.set(id, msg);
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
    // Rounds encore non réglés 1 h après leur fin : nouvel essai toutes les 5 min (pas 8 s).
    const open = all.filter(t => t.status === 'open' && now > t.endMs + 15_000
      && now - (this.lastResolveTry.get(t.id) ?? -Infinity) >= (now > t.endMs + 3_600_000 ? 300_000 : 8_000));
    // Reventes : simple relevé pour la calibration → peu prioritaire (2 par passage, une
    // fois par minute au plus) pour ne pas allonger le passage quand Gamma est lent.
    const sold = all.filter(t => t.status === 'sold' && t.outcomeUpWon === undefined && now > t.endMs + 15_000
      && now - t.endMs < 2 * 3_600_000 && now - (this.lastResolveTry.get(t.id) ?? -Infinity) >= 60_000).slice(0, 2);
    const due = [...open, ...sold];
    for (const t of due) {
      this.lastResolveTry.set(t.id, now);
      const outcome = await this.d.fetchOutcome(t.slug);
      if (outcome.resolved && t.status === 'sold') {
        this.write(s => s.patch(t.id, { outcomeUpWon: outcome.upWon }));
        this.lastResolveTry.delete(t.id);
        continue;
      }
      if (!outcome.resolved) {
        if (t.status === 'open' && now > t.endMs + 30 * 60_000 && !this.unresolvedWarned.has(t.id)) {
          this.unresolvedWarned.add(t.id);
          this.d.log('WARN', `Round ${t.slug} toujours non réglé 30 min après la fin (${outcome.reason}) — nouvel essai en continu`);
        }
        // Toujours rien après 6 h : la position bloque une place (10 au plus) et de
        // l'exposition ; sans alerte, des rounds jamais réglés finiraient par arrêter les
        // paris sans bruit. Une alerte par trade.
        if (t.status === 'open' && now > t.endMs + 6 * 3_600_000 && !t.unresolvedAlertedAt && !this.unresolvedAlerted.has(t.id)) {
          this.unresolvedAlerted.add(t.id);
          this.write(s => s.patch(t.id, { unresolvedAlertedAt: new Date(now).toISOString() }));
          this.d.notify(msgAlert(`round ${t.slug} toujours non réglé 6 h après la fin (${outcome.reason}) : la position reste comptée comme ouverte. Vérifier le marché sur Polymarket.`));
        }
        continue;
      }
      const won = outcome.upWon === (t.side === 'UP');
      const pnl = settlePnl(t, won);
      const { saved, result: closed } = this.write(s => s.patch(t.id,
        { status: won ? 'won' : 'lost', pnl, resolvedAt: new Date(now).toISOString(), outcomeUpWon: outcome.upWon }, { ifStatus: 'open' }));
      if (!saved || !closed) continue;
      this.unresolvedWarned.delete(t.id);
      this.lastResolveTry.delete(t.id);
      const key = strategyOf(t);
      const late = key === 'late';
      const llm = key === 'llm'; // stratégie llm (papier) : ses trades sont réglés ici comme les autres
      const stats = this.statsFor(key);
      this.d.log('TRADE', `[SIMULATION] ${won ? 'GAGNÉ' : 'PERDU'}${late ? ' (récolte fin de round)' : llm ? ' (llm)' : ''} ${t.coin} ${t.side} (${t.slug}) ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} — `
        + `bilan ${late ? 'récolte' : llm ? 'llm' : 'juste valeur'} ${stats.n} trades, WR ${stats.winRate === null ? '—' : (stats.winRate * 100).toFixed(1) + ' %'}, PnL $${stats.pnl.toFixed(2)}`);
      // Récolte : des centaines de petits gains par jour → aucun message par gain (bilan
      // périodique), mais chaque perte est annoncée (rare, et c'est elle qui compte).
      if (!late || !won) {
        this.d.notify(msgTradeClosed({
          coin: t.coin, side: t.side, slotSec: t.slotSec ?? t.endMs / 1000 - 300, outcome: won ? 'won' : 'lost', pnl, stats, timeZone: this.d.timeZone,
          ...(late ? { strategy: 'late' as const } : llm ? { strategy: 'llm' as const } : {}),
        }));
      }
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
    const candidates: Array<{ pos: LedgerTrade; floor: number; pHeld: number; noiseMargin: number }> = [];
    // Récolte de fin de round : tenue jusqu'au règlement (entrée à τ ≤ 30 s, jamais revendue).
    for (const pos of (this.trades() ?? []).filter(t => t.status === 'open' && strategyOf(t) === 'fv')) {
      const tauSec = (pos.endMs - now) / 1000;
      // En fin de round le modèle n'est pas fiable : on garde jusqu'à la résolution.
      if (tauSec < entryMinTauSec(cfg) || !pos.tokenId || !pos.slotSec) continue;
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
        // Même prudence qu'à l'entrée : un bid au-dessus de notre valeur de moins que notre
        // propre bruit (prix à battre estimé) n'est pas une occasion de revente.
        const noiseMargin = Math.max(0, cfg.noiseEdgeK ?? 0) * probNoiseSd({ ...data!, tauSec }, cfg) * blendNoiseFactor(pUp, pUsed, cfg);
        const floor = pHeld + this.d.exitEdge + noiseMargin; // prix net minimal de l'ordre de vente
        const sale = estimateSell(book.bids, pos.shares, cfg.takerFeeRate, floor);
        if (sale.complete) candidates.push({ pos, floor, pHeld, noiseMargin });
      } catch {
        /* carnet ou flux indisponible : on garde la position */
      }
    }
    if (!candidates.length) return;
    const delay = this.d.fillDelayMs ?? 0;
    if (delay > 0) await (this.d.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(delay);
    const at = this.d.now();
    for (const { pos, floor, pHeld, noiseMargin } of candidates) {
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
        const { saved, result: closed } = this.write(s => s.patch(pos.id,
          { status: 'sold', pnl: profit, resolvedAt: new Date(at).toISOString(), exitPrice }, { ifStatus: 'open' }));
        if (!saved || !closed) continue;
        this.d.log('TRADE', `[SIMULATION] VENTE ${pos.coin} ${pos.side} @ VWAP $${exitPrice.toFixed(3)} (net frais ${netPerShare.toFixed(3)} ≥ p_modèle ${pHeld.toFixed(3)} + ${this.d.exitEdge}${noiseMargin > 5e-4 ? ` + ${noiseMargin.toFixed(3)} bruit` : ''}) `
          + `round ${pos.slug} — PnL réalisé ${profit >= 0 ? '+' : ''}$${profit.toFixed(4)}`);
        this.d.notify(msgTradeClosed({ coin: pos.coin, side: pos.side, slotSec: pos.slotSec as number, outcome: 'sold', pnl: profit, stats: this.statsFor('fv'), timeZone: this.d.timeZone }));
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

  /**
   * Dernière minute du round (τ < fenêtre TWAP). Deux usages, indépendants :
   *  - MESURE (FV_LATE_MEASURE) : une partie du TWAP de règlement est déjà acquise (prix Binance
   *    par seconde) ; P(Up) « fin de round » et le carnet sont journalisés (lt, pl, kn) pour le
   *    rapport (section 1d). La stratégie juste valeur n'y entre jamais ;
   *  - RÉCOLTE (FV_HARVEST, late-harvest.ts) : favori bloqué à ≥ 0,99 depuis ≥ 6 s entre 30 et
   *    8 s de la fin → achat papier au vrai carnet, après la latence simulée.
   * Lecture toutes les 8 s, toutes les 3 s à l'approche de la fenêtre de récolte.
   */
  private async measureLate(market: ScannedMarket, slot: number, endMs: number, gateBlock: string | null = null): Promise<void> {
    const { cfg } = this.d;
    const hv = this.d.harvest;
    const key = market.conditionId;
    const now0 = this.d.now();
    const tau0 = (endMs - now0) / 1000;
    const harvestZone = !!hv?.enabled && !this.traded.has(harvestTradeId(key))
      && tau0 <= hv.maxTauSec + hv.stableSec + hv.checkEveryMs / 1000 + 1 && tau0 >= hv.minTauSec;
    const every = harvestZone ? (hv as HarvestConfig).checkEveryMs : 8000;
    if (now0 - (this.lateAt.get(key) ?? -Infinity) < every) return; // pas de lecture plus serrée que nécessaire
    this.lateAt.set(key, now0);
    if (this.lateAt.size > 200) this.lateAt.clear();
    let rec: DecisionRecord | null = null;
    try {
      let data = await this.d.getRoundData(market.underlying, slot, now0);
      if (!data) return;
      const measure = cfg.lateMeasure !== false && !!data.twapPartial;
      if (!measure && !harvestZone) return; // sans flux temps réel, rien à mesurer
      const [upBook, downBook] = await Promise.all([this.d.getBook(market.upTokenId), this.d.getBook(market.downTokenId)]);
      const now = this.d.now();
      const tauSec = (endMs - now) / 1000;
      if (tauSec < LATE_MIN_TAU_SEC || tauSec >= Math.min(60, cfg.twapWindowSec)) return;
      if (now - now0 > 500) {
        // Carnets lents : spot et part acquise relus à l'instant des carnets (sinon les secondes
        // d'attente seraient comptées comme « connues » : kn + τ ≠ W, probabilité trop sûre).
        const fresh = await this.d.getRoundData(market.underlying, slot, now);
        if (!fresh || (measure && !fresh.twapPartial)) return;
        data = fresh;
      }
      const partial = data.twapPartial ?? null;
      const upBest = bestLevel(upBook.asks, 'ask');
      const downBest = bestLevel(downBook.asks, 'ask');
      const upBid = bestLevel(upBook.bids, 'bid');
      const downBid = bestLevel(downBook.bids, 'bid');
      const pl = partial
        ? probUpLate({ spot: data.spot, strike: data.strike, sigmaPerSqrtSec: data.sigmaPerSqrtSec, tauSec, partialMean: partial.mean, knownSec: partial.knownSec }, cfg)
        : null;
      const pRaw = probUp({ spot: data.spot, strike: data.strike, sigmaPerSqrtSec: data.sigmaPerSqrtSec, tauSec }, cfg);
      // Série « favori bloqué » (observée même hors fenêtre de récolte : la stabilité se mesure avant).
      let fav: HarvestSide | null = null;
      let hs: number | undefined;
      if (hv?.enabled) {
        fav = harvestSide(upBest?.price ?? null, downBest?.price ?? null, hv);
        this.streaks.observe(key, fav, now);
        if (fav) hs = Math.round(this.streaks.stableSec(key, fav, now) * 10) / 10;
      }
      const base: DecisionRecord = {
        t: now, slug: market.slug, coin: market.underlying, tau: Math.round(tauSec * 10) / 10, spot: data.spot, strike: data.strike,
        sig: data.sigmaPerSqrtSec, pUp: pRaw, pRaw, zs: cfg.zScale, lt: true, pl, kn: partial ? Math.round(partial.knownSec) : 0,
        ...(data.sigmaCcPerSqrtSec ? { sc: data.sigmaCcPerSqrtSec } : {}), ...(data.sigmaParkPerSqrtSec ? { sp: data.sigmaParkPerSqrtSec } : {}),
        ...(cfg.tails === 't4' ? { tl: 't4' as const } : {}), ...(cfg.twapWindowSec > 0 ? { tw: cfg.twapWindowSec } : {}),
        ...(hs !== undefined ? { hs } : {}),
        upAsk: upBest?.price ?? null, downAsk: downBest?.price ?? null, upAskSz: upBest?.size ?? null, downAskSz: downBest?.size ?? null,
        upBid: upBid?.price ?? null, downBid: downBid?.price ?? null, upBidSz: upBid?.size ?? null, downBidSz: downBid?.size ?? null,
        src: data.source, act: 'hold',
      };
      if (measure) {
        rec = base;
        this.lastReason.set(key, `${market.underlying} fin de round (τ ${Math.round(tauSec)} s, TWAP acquis ${Math.round(partial!.knownSec)} s) : `
          + `P(hausse) fin de round ${pl === null ? '—' : pl.toFixed(3)} · asks hausse ${upBest ? upBest.price.toFixed(2) : '—'} / baisse ${downBest ? downBest.price.toFixed(2) : '—'} — mesure seulement, jamais d'entrée`);
      }
      if (harvestZone) {
        const trade = await this.tryHarvest(market, slot, endMs, { tauSec, fav, hs: hs ?? 0, pl, upBook, downBook, data, gateBlock });
        if (trade) rec = { ...base, act: 'buy', side: trade.side, stake: trade.stake, hv: true };
      }
    } catch {
      /* mesure silencieuse : ne doit jamais gêner la stratégie */
    } finally {
      if (rec) {
        const reason = this.lastReason.get(key) ?? '';
        try { this.d.onEvaluation?.(rec, reason); } catch { /* idem */ }
      }
    }
  }

  /**
   * Récolte de fin de round : décision (late-harvest.ts), mise, exécution papier après la latence
   * sur le carnet RELU, avec un prix limite sous `maxAsk` ; registre écrit avant toute annonce.
   * Aucun message Telegram à l'ouverture (des centaines par jour) : bilan périodique, et chaque
   * perte annoncée au règlement. Renvoie le trade enregistré, ou null.
   */
  private async tryHarvest(
    market: ScannedMarket, slot: number, endMs: number,
    o: { tauSec: number; fav: HarvestSide | null; hs: number; pl: number | null; upBook: Book; downBook: Book; data: RoundMarketData; gateBlock: string | null },
  ): Promise<LedgerTrade | null> {
    const hv = this.d.harvest as HarvestConfig;
    const { cfg } = this.d;
    const id = harvestTradeId(market.conditionId);
    if (this.traded.has(id)) return null;
    const decision = harvestDecision({ tauSec: o.tauSec, side: o.fav, stableSec: o.hs, pModelUp: o.pl }, hv);
    if (!decision.side) return null;
    const side = decision.side;
    const ctx = `${market.underlying} récolte fin de round : ${decision.reason}`;
    const blockNow = (): string | null => (this.d.harvestBlock ? this.d.harvestBlock() : (this.d.entryBlock?.() ?? null));
    const block = o.gateBlock ?? blockNow();
    if (block) {
      this.holdLog(id, `   ↳ ${ctx} → ignorée : entrées bloquées (${block})`);
      return null;
    }
    const best = bestLevel((side === 'UP' ? o.upBook : o.downBook).asks, 'ask');
    if (!best) return null;
    const now = this.d.now();
    const stats = this.stats();
    const equity = this.d.capital() + stats.pnl;
    const peak = this.d.capital() + stats.peakPnl;
    const stakeRes = computeStake({
      capital: equity,
      entryPrice: effectiveCostPerShare(best.price, cfg.takerFeeRate),
      bookProb: HARVEST_EXPECTED_WIN,
      consecutiveLosses: this.store.recentLossStreak('late', now, LOSS_STREAK_WINDOW_MS),
      drawdownCurrent: peak > 0 ? stats.drawdownNow / peak : 0,
      openExposureEur: stats.openExposure,
      openPositions: stats.open,
      maxConcurrentPositions: 10,
    });
    if (stakeRes.skipped || !(stakeRes.stake > 0)) {
      this.holdLog(id, `   ↳ ${ctx} → PAS de mise : ${stakeRes.rationale}`);
      if (stakeRes.bindingConstraint === 'drawdown' || stakeRes.bindingConstraint === 'série de pertes') this.d.onRiskStop?.(stakeRes.rationale);
      return null;
    }
    const minOrder = this.d.minOrderUsd ?? 0;
    if (stakeRes.stake < minOrder) {
      this.holdLog(id, `   ↳ ${ctx} → PAS de mise : ${stakeRes.stake.toFixed(2)} $ < minimum Polymarket ${minOrder} $`);
      return null;
    }
    const limit = hv.maxAsk - 1e-9;
    const delay = this.d.fillDelayMs ?? 0;
    const tokenId = side === 'UP' ? market.upTokenId : market.downTokenId;
    let book = side === 'UP' ? o.upBook : o.downBook;
    if (delay > 0) {
      await (this.d.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(delay);
      const lateBlock = blockNow();
      if (lateBlock) {
        this.holdLog(id, `   ↳ ${ctx} → PAS de mise : ${lateBlock}`);
        return null;
      }
      book = await this.d.getBook(tokenId); // carnet à l'arrivée de l'ordre
    }
    const fillAt = this.d.now();
    if ((endMs - fillAt) / 1000 < 2) {
      this.holdLog(id, `   ↳ ${ctx} → PAS de mise : ordre arrivé trop près de la fin du round`);
      return null;
    }
    const fill = estimateFill(book.asks, stakeRes.stake, limit, cfg.takerFeeRate);
    if (!fill.complete || fill.avgPrice === null || fill.avgCost === null) {
      this.holdLog(id, `   ↳ ${ctx} → PAS de mise : profondeur insuffisante pour $${stakeRes.stake.toFixed(2)} sous ${hv.maxAsk}`
        + (delay > 0 ? ` (carnet relu ${delay} ms après la décision)` : ''));
      return null;
    }
    const stake = stakeRes.stake;
    const { shares, winProfit } = binaryPayoff(stake, fill.avgCost);
    const trade: LedgerTrade = {
      id, strategy: 'late', slug: market.slug, coin: market.underlying, side, stake, costPerShare: fill.avgCost, shares,
      modelProb: HARVEST_EXPECTED_WIN, edge: HARVEST_EXPECTED_WIN - fill.avgCost, openedAt: new Date(fillAt).toISOString(), endMs,
      status: 'open', pnl: null, tokenId, otherTokenId: side === 'UP' ? market.downTokenId : market.upTokenId, slotSec: slot,
    };
    const finalBlock = blockNow();
    if (finalBlock) {
      this.holdLog(id, `   ↳ ${ctx} → PAS de mise : ${finalBlock}`);
      return null;
    }
    // Refusé (false) si le round est déjà au registre pour cette stratégie.
    const { saved, result: pushed } = this.write(s => s.open(trade));
    if (saved) this.traded.add(id);
    if (!saved || !pushed) return null;
    const description = `🌾 ${ctx} → achat ${side} @ VWAP $${fill.avgPrice.toFixed(3)} + frais = $${fill.avgCost.toFixed(4)}/part, mise $${stake.toFixed(2)}`
      + ` — gain $${winProfit.toFixed(4)} si ${side} / perte $${stake.toFixed(2)} sinon${o.pl === null ? '' : ` · P(modèle fin de round) ${(side === 'UP' ? o.pl : 1 - o.pl).toFixed(4)}`}`;
    this.d.log('TRADE', `[SIMULATION] RÉCOLTE FIN DE ROUND ${market.underlying} ${side} @ $${fill.avgPrice.toFixed(3)} mise $${stake.toFixed(2)} τ ${Math.round(o.tauSec)} s (favori bloqué depuis ${o.hs.toFixed(0)} s) — ${market.slug}`);
    this.lastReason.set(market.conditionId, description);
    this.d.onTradeOpened?.({ trade, market, data: o.data, ask: fill.avgPrice, tauSec: (endMs - fillAt) / 1000, winProfit, description });
    return trade;
  }

  async enterNewTrades(coins?: readonly string[], gateBlock: string | null = null): Promise<void> {
    const { cfg } = this.d;
    await this.refreshMarkets();
    this.streaks.prune(this.d.now());
    const harvestOn = !!this.d.harvest?.enabled;
    for (const market of this.markets) {
      if (coins && !coins.includes(market.underlying)) continue;
      const slot = slotOf(market) as number;
      const endMs = slot * 1000 + 300_000;
      const now = this.d.now();
      let tauSec = (endMs - now) / 1000;
      // Dernière minute = fenêtre de moyenne (τ < W, jamais dans la fenêtre d'entrée qui commence à
      // max(minTau, W)) : mesure, et récolte de fin de round si activée — y compris sur un round
      // déjà joué par la juste valeur (avant : ces rounds étaient exclus de la mesure, un biais).
      if (tauSec < Math.min(60, cfg.twapWindowSec) && tauSec >= LATE_MIN_TAU_SEC && cfg.twapWindowSec > 0 && (cfg.lateMeasure !== false || harvestOn)) {
        await this.measureLate(market, slot, endMs, gateBlock);
        continue;
      }
      if (this.traded.has(market.conditionId)) continue;
      if (tauSec < entryMinTauSec(cfg) || tauSec > cfg.maxTauSec) continue; // aucun appel réseau hors fenêtre
      const coin = market.underlying;
      let rec: DecisionRecord | null = null; // évaluation journalisée (pari ou abstention)
      try {
        let data = await this.d.getRoundData(coin, slot, now);
        if (!data) {
          this.holdLog(market.conditionId, `   ↳ ${market.slug} : spot/strike/vol indisponibles ou périmés → pas de mise`);
          continue;
        }
        const [upBook, downBook] = await Promise.all([this.d.getBook(market.upTokenId), this.d.getBook(market.downTokenId)]);
        // τ recalculé APRÈS les attentes réseau (bougies, carnets) : c'est l'instant où le
        // carnet a été lu qui compte.
        const nowBook = this.d.now();
        tauSec = (endMs - nowBook) / 1000;
        if (tauSec < entryMinTauSec(cfg) || tauSec > cfg.maxTauSec) continue;
        // Carnets lents à venir : le spot lu AVANT eux peut être dépassé (spot revenu,
        // carnet déjà réajusté → on achèterait contre un prix juste). On relit le spot, à
        // l'instant de la lecture des carnets — information disponible à la décision.
        let spotReread = false;
        if (nowBook - now > 500) {
          spotReread = true;
          const fresh = await this.d.getRoundData(coin, slot, nowBook);
          if (!fresh) {
            this.holdLog(market.conditionId, `   ↳ ${market.slug} : spot indisponible après lecture des carnets → pas de mise`);
            continue;
          }
          data = fresh;
        }
        const upBest = bestLevel(upBook.asks, 'ask');
        const downBest = bestLevel(downBook.asks, 'ask');
        const upBid = bestLevel(upBook.bids, 'bid');
        const downBid = bestLevel(downBook.bids, 'bid');
        const decision = decide({ ...data, tauSec, upAsk: upBest?.price ?? null, downAsk: downBest?.price ?? null }, cfg);
        rec = {
          t: now, slug: market.slug, coin, tau: Math.round(tauSec * 10) / 10, spot: data.spot, strike: data.strike,
          sig: data.sigmaPerSqrtSec, pUp: decision.pUp, pRaw: decision.pRaw ?? null, zs: cfg.zScale,
          ...(data.sigmaCcPerSqrtSec ? { sc: data.sigmaCcPerSqrtSec } : {}), ...(data.sigmaParkPerSqrtSec ? { sp: data.sigmaParkPerSqrtSec } : {}),
          ...(market.priceToBeat ? { ps: market.priceToBeat } : {}),
          ...(decision.noiseSdRaw !== undefined ? { ns: Math.round(decision.noiseSdRaw * 1e4) / 1e4 } : {}),
          ...(cfg.tails === 't4' ? { tl: 't4' as const } : {}), ...(cfg.twapWindowSec > 0 ? { tw: cfg.twapWindowSec } : {}),
          ...(coins ? { mv: true as const } : {}), upAsk: upBest?.price ?? null, downAsk: downBest?.price ?? null,
          upAskSz: upBest?.size ?? null, downAskSz: downBest?.size ?? null,
          upBid: upBid?.price ?? null, downBid: downBid?.price ?? null, upBidSz: upBid?.size ?? null, downBidSz: downBid?.size ?? null,
          src: data.source, act: 'hold',
        };
        const ctx = `${coin} spot ${px(data.spot)} vs strike ${px(data.strike)} (${data.source}), `
          + `σ1m ${(data.sigmaPerSqrtSec * Math.sqrt(60) * 100).toFixed(3)} %, τ ${Math.round(tauSec)} s`;
        if (!decision.side || !decision.best) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → HOLD : ${decision.reason}`);
          continue;
        }

        const block = gateBlock ?? this.d.entryBlock?.() ?? null;
        if (block) {
          if (gateBlock) {
            // Pause de risque (peut durer des jours) : une ligne toutes les 10 min au total,
            // pas une par marché et par minute — mais la raison de CHAQUE évaluation est gardée
            // (dashboard « dernière évaluation ») : l'opérateur doit voir POURQUOI rien n'est parié.
            this.lastReason.set(market.conditionId, `${ctx} → signal ${decision.side} ignoré : entrées bloquées (${block})`);
            const t = this.d.now();
            if (t - this.lastPauseLog >= 600_000) {
              this.lastPauseLog = t;
              this.d.log('SIGNAL', `   ↳ signaux ignorés : entrées bloquées (${block}) — l'évaluation et le journal continuent`);
            }
          } else {
            this.holdLog(market.conditionId, `   ↳ ${ctx} → signal ${decision.side} ignoré : entrées bloquées (${block})`);
          }
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
          consecutiveLosses: this.store.recentLossStreak('fv', now, LOSS_STREAK_WINDOW_MS),
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
        const required = decision.requiredEdge ?? cfg.minEdge;
        const limit = Math.min(cfg.maxAsk, maxBuyPriceForEdge(q.prob, required, cfg.takerFeeRate) ?? 0);
        const delay = this.d.fillDelayMs ?? 0;
        if (delay > 0) {
          await (this.d.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(delay);
          // Blocage apparu pendant le trajet de l'ordre (arrêt du bot, garde-fou) : on renonce.
          const lateBlock = this.d.entryBlock?.() ?? null;
          if (lateBlock) {
            this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : ${lateBlock}`);
            continue;
          }
        }
        // Exécution sur un carnet POSTÉRIEUR à l'information utilisée : relu après la latence,
        // et aussi sans latence si le spot a été relu (sinon on achèterait sur un carnet
        // antérieur au mouvement vu par le modèle : biais d'anticipation).
        if (delay > 0 || spotReread) {
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
        if (edgeAtFill < required - 1e-9) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : edge au VWAP ${(edgeAtFill * 100).toFixed(1)} pt < ${(required * 100).toFixed(1)} pt`);
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
        // Dernier contrôle après le DERNIER await (relecture du carnet : jusqu'à 8 s en réel) :
        // un arrêt commencé entre-temps ne doit ni enregistrer ni annoncer ce pari.
        const finalBlock = this.d.entryBlock?.() ?? null;
        if (finalBlock) {
          this.holdLog(market.conditionId, `   ↳ ${ctx} → PAS de mise : ${finalBlock}`);
          continue;
        }
        const { saved, result: pushed } = this.write(s => s.open(trade)); // false : déjà au registre
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
        this.lastReason.set(market.conditionId, description);
        this.d.onTradeOpened?.({ trade, market, data, ask: fill.avgPrice, tauSec, winProfit, description });
      } catch (err) {
        this.holdLog(market.conditionId, `   ↳ ${market.slug} : erreur d'analyse (${String((err as Error)?.message ?? err).slice(0, 160)}) → pas de mise`);
      } finally {
        if (rec) {
          const reason = (this.lastReason.get(market.conditionId) ?? '').replace(/^\s*↳\s*/, '');
          if (this.lastReason.size > 200) this.lastReason.clear();
          try { this.d.onEvaluation?.(rec, reason); } catch { /* le journal ne doit jamais bloquer la stratégie */ }
        }
      }
    }
  }
}
