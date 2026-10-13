/**
 * llm-strategy.ts — stratégie « llm » (PAPIER uniquement) : trois agents Claude (analyste →
 * décideur → sécurité) appelés par un orchestrateur DÉTERMINISTE (pipeline.ts), puis les
 * garde-fous du CODE (guards.ts), qui ont le dernier mot.
 *
 * Indépendante du moteur formule/récolte : son propre minuteur, son propre capital papier
 * (portée 'llm' du registre, exclue du total), ses propres limites. Une panne, une exception,
 * un CLI absent ne touchent ni les décisions ni le registre des autres stratégies : tout échec
 * produit une ABSTENTION ENREGISTRÉE (llm-journal.ts), jamais un pari.
 *
 * Une décision au plus par round et par actif activé, à `decisionAtSec` après le début du
 * round, échéance `deadlineSec` ; rounds tirés uniformément sur la journée quand le plafond
 * journalier ne permet pas de décider à chaque round. La formule est évaluée au MÊME instantané
 * et exécutée par le MÊME modèle (décision, +1 s, carnet relu, frais) : comparaison appariée.
 */
import { createHash, randomBytes } from 'node:crypto';
import { decide, maxBuyPriceForEdge, type FairValueConfig } from '../../services/fair-value.js';
import type { RoundMarketData } from '../../services/round-market-data.js';
import type { LedgerStore } from '../../services/ledger-store.js';
import type { LedgerTrade } from '../../services/paper-ledger.js';
import { evaluateRisk } from '../../bot/risk-gate.js';
import type { RiskLimits } from '../../bot/config.js';
import { MAX_VARIANCE_PCT } from '../../services/stake-sizing.js';
import { bestLevel, slotOf, type Book, type ScannedMarket } from '../fair-value-runner.js';
import type { CallFn, AbstentionCode } from './types.js';
import { buildSnapshot, canonicalJson, snapshotHash, type Level } from './snapshot.js';
import { runPipeline } from './pipeline.js';
import { applyGuards, EXECUTION_LATENCY_MS, llmStakeCapUsd, simulateExecution } from './guards.js';
import type { CallBudget } from './budget.js';
import type { LlmState, PauseEvent } from './llm-state.js';
import { campaignOf, type LlmDecisionRecord, type LlmJournal } from './llm-journal.js';
import type { LlmConfig } from './llm-config.js';
import { ROUND_SEC } from './llm-config.js';

export interface LlmStrategyDeps {
  cfg: LlmConfig;
  fv: FairValueConfig;
  risk: RiskLimits;
  ledger: LedgerStore;
  journal: LlmJournal;
  budget: CallBudget;
  state: LlmState;
  call: CallFn;
  promptVersion: string | null;
  /** Version du CLI vérifiée au démarrage (null : binaire figé introuvable ou autre version). */
  cliVersion: () => string | null;
  /** Jeton utilisable (fichier 0600, non expiré) ? Sinon le motif lisible. */
  tokenProblem: () => string | null;
  minOrderUsd: number;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  markets: () => Promise<ScannedMarket[]>;
  getBook: (tokenId: string) => Promise<Book>;
  getRoundData: (coin: string, slotSec: number, nowMs: number) => Promise<RoundMarketData | null>;
  /** Blocages globaux du bot (arrêt en cours, horloge, registre verrouillé), ou null. */
  globalBlock: () => string | null;
  notify: (html: string) => void;
  log: (level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE', msg: string) => void;
}

const levels = (l: ReadonlyArray<{ price: number; size: number }>): Level[] => l.map(x => [x.price, x.size] as const);
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Tirage uniforme et déterministe d'un round (même résultat après redémarrage). */
export function inSample(coin: string, slotSec: number, rate: number): boolean {
  if (rate >= 1) return true;
  const h = createHash('sha256').update(`${coin}:${slotSec}`).digest();
  return h.readUInt32BE(0) / 2 ** 32 < rate;
}

export class LlmStrategy {
  private readonly d: LlmStrategyDeps;
  private readonly attempted = new Set<string>();
  private inFlight = false;
  private running = false;
  private latencies: number[] = [];
  lastDecision: { at: number; code: string; detail: string } | null = null;

  constructor(deps: LlmStrategyDeps) {
    this.d = deps;
  }

  /** Taux d'échantillonnage : plafond journalier / rounds par jour des actifs activés. */
  sampleRate(): number {
    return Math.min(1, this.d.cfg.maxPerDay / (288 * Math.max(1, this.d.cfg.coins.length)));
  }

  latencyStats(): { n: number; p50: number | null; p95: number | null; max: number | null } {
    const a = [...this.latencies].sort((x, y) => x - y);
    const q = (p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
    return { n: a.length, p50: q(0.5), p95: q(0.95), max: a.length ? a[a.length - 1] : null };
  }

  /** Appelé chaque seconde par l'app : ne bloque jamais (la décision tourne à part). */
  async tick(): Promise<void> {
    if (this.running || this.inFlight) return;
    this.running = true;
    try {
      const now = this.d.now();
      const markets = await this.d.markets();
      for (const m of markets) {
        if (!this.d.cfg.coins.includes(m.underlying)) continue;
        const slot = slotOf(m);
        if (slot === null) continue;
        const startMs = slot * 1000;
        const at = (now - startMs) / 1000;
        if (at < this.d.cfg.decisionAtSec || at > this.d.cfg.decisionAtSec + 20) continue;
        const key = `${m.conditionId}`;
        if (this.attempted.has(key)) continue;
        this.attempted.add(key);
        if (this.attempted.size > 500) this.attempted.delete(this.attempted.values().next().value as string);
        if (!inSample(m.underlying, slot, this.sampleRate())) continue;
        this.inFlight = true;
        // Hors du tick : la décision dure des dizaines de secondes.
        void this.decideRound(m, slot).catch(err => {
          this.d.log('ERROR', `llm : erreur interne (${String((err as Error)?.message ?? err).slice(0, 200)}) — abstention`);
        }).finally(() => { this.inFlight = false; });
        break; // un round à la fois
      }
    } catch (err) {
      this.d.log('WARN', `llm : tick en échec (${String((err as Error)?.message ?? err).slice(0, 160)})`);
    } finally {
      this.running = false;
    }
  }

  private onPause(ev: PauseEvent | null): void {
    if (!ev) return;
    const until = new Date(ev.pausedUntil).toISOString().slice(11, 16);
    this.d.notify(`⏸️ <b>llm en pause</b> jusqu'à ${until} UTC — ${ev.reason}`);
    this.d.log('WARN', `llm en pause jusqu'à ${new Date(ev.pausedUntil).toISOString()} : ${ev.reason}`);
  }

  /** Une tentative de décision complète ; écrit TOUJOURS exactement une ligne de décision. */
  async decideRound(m: ScannedMarket, slot: number): Promise<void> {
    const d = this.d;
    const t0 = d.now();
    const id = `llm-${slot}-${m.underlying.toLowerCase()}-${randomBytes(3).toString('hex')}`;
    const cli = d.cliVersion();
    const rec: LlmDecisionRecord = {
      v: 1, id, t: t0, round_id: m.slug, slotSec: slot, actif: m.underlying, conditionId: m.conditionId,
      campaign: campaignOf(cli, d.promptVersion), cliVersion: cli, promptVersion: d.promptVersion, models: [],
      snapshotHash: null, atSec: null, code: 'ok', detail: '', latencyMs: null, steps: [], final: null, pLlm: null,
      exec: null, formula: null, raw: null, tradeId: null,
    };
    const abstain = (code: AbstentionCode | string, detail: string) => {
      rec.code = code;
      rec.detail = detail;
    };
    try {
      await this.attempt(m, slot, rec, abstain);
    } catch (err) {
      abstain('lancement_impossible', `erreur interne : ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    } finally {
      try { d.journal.append(rec); } catch (err) { d.log('ERROR', `llm : décision non enregistrée (${(err as Error).message})`); }
      this.lastDecision = { at: t0, code: String(rec.code), detail: rec.detail };
      d.log(rec.code === 'ok' ? 'TRADE' : 'INFO', `llm ${m.slug} : ${rec.code === 'ok' ? 'PARI' : `abstention (${rec.code})`} ${rec.detail}`);
    }
  }

  private async attempt(m: ScannedMarket, slot: number, rec: LlmDecisionRecord, abstain: (c: AbstentionCode | string, detail: string) => void): Promise<void> {
    const d = this.d;
    const startMs = slot * 1000;
    const endMs = startMs + ROUND_SEC * 1000;
    const deadlineAtMs = startMs + d.cfg.deadlineSec * 1000;
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

    // 1. Disponibilité : on/off/pause, jeton, version figée du CLI, budget (décompté au lancement).
    const can = d.state.canRun(d.now());
    if (!can.ok) return abstain(can.code, can.detail);
    if (can.resumed) d.notify(`▶️ <b>llm reprend</b> après la pause (${can.resumed.reason ?? 'fin de pause'})`);
    const tok = d.tokenProblem();
    if (tok) return abstain('jeton_absent', tok);
    if (!rec.cliVersion) return abstain('version_cli', 'binaire du CLI figé introuvable ou autre version (LLM_CLI_VERSION)');
    const block = d.globalBlock();
    if (block) return abstain('bloque_risque', block);
    const b = d.budget.tryConsume(d.now());
    if (!b.ok) return abstain(b.code, b.detail);

    // 2. Instantané : données du round, carnets, formule, risque du capital llm.
    const tSnap = d.now();
    const data = await d.getRoundData(m.underlying, slot, tSnap);
    if (!data) return abstain('flux_invalide', 'spot/strike/vol indisponibles');
    const [upBook, downBook] = await Promise.all([d.getBook(m.upTokenId), d.getBook(m.downTokenId)]);
    const tauSec = (endMs - d.now()) / 1000;
    const upAsk = bestLevel(upBook.asks, 'ask')?.price ?? null;
    const downAsk = bestLevel(downBook.asks, 'ask')?.price ?? null;
    const fvDec = decide({ ...data, tauSec, upAsk, downAsk }, d.fv);
    const llmStats = d.ledger.stats('llm');
    const cal = d.ledger.calendarPnl(tSnap, 'llm');
    const risk = evaluateRisk(d.cfg.paperCapital, llmStats, cal, d.risk, tSnap);
    const equity = d.cfg.paperCapital + llmStats.pnl;
    const riskRoom = Math.max(0, d.cfg.paperCapital * d.risk.dailyMaxLossPct + Math.min(0, cal.today));
    const stakeCap = llmStakeCapUsd({ maxStakeUsd: d.cfg.maxStakeUsd, strategyCapUsd: equity * MAX_VARIANCE_PCT, riskRoomUsd: riskRoom });
    const snapshot = buildSnapshot({
      roundId: m.slug, coin: m.underlying, startMs, endMs, nowMs: tSnap,
      open: data.strike, spot: data.spot, sigmaPerSqrtSec: data.sigmaPerSqrtSec,
      formulaPUp: fvDec.pUp, formulaPUpRaw: fvDec.pRaw ?? null,
      book: { up: { asks: levels(upBook.asks), bids: levels(upBook.bids) }, down: { asks: levels(downBook.asks), bids: levels(downBook.bids) } },
      feeRate: d.fv.takerFeeRate, minOrderUsd: d.minOrderUsd,
      risk: { capitalUsd: r6(equity), maxStakeUsd: r6(stakeCap), pnlTodayUsd: r6(cal.today), dailyLimitUsd: r6(d.cfg.paperCapital * d.risk.dailyMaxLossPct), blocked: !risk.allowed },
      openPositions: d.ledger.openTrades().map(t => ({ coin: t.coin, side: t.side, stakeUsd: t.stake, strategy: t.strategy ?? 'fv' })),
    });
    rec.snapshotHash = snapshotHash(snapshot);
    rec.atSec = Math.round((tSnap - startMs) / 100) / 10;
    try { d.journal.saveSnapshot(rec.snapshotHash, canonicalJson(snapshot)); } catch { /* l'empreinte reste dans la décision */ }

    // 3. Formule au MÊME instantané, exécutée par le MÊME modèle (+1 s, carnet relu, frais).
    const formulaExec = (async () => {
      const side = fvDec.side;
      const q = fvDec.best;
      if (!side || !q) return { pUp: fvDec.pUp, pRaw: fvDec.pRaw ?? null, side: null, limitPrice: null, fill: null, reason: fvDec.reason };
      const limit = Math.min(d.fv.maxAsk, maxBuyPriceForEdge(q.prob, fvDec.requiredEdge ?? d.fv.minEdge, d.fv.takerFeeRate) ?? 0);
      await sleep(EXECUTION_LATENCY_MS);
      const book = await d.getBook(side === 'UP' ? m.upTokenId : m.downTokenId);
      const exec = simulateExecution(side, Math.max(stakeCap, d.minOrderUsd), limit, book.asks, d.fv.takerFeeRate, d.minOrderUsd);
      const fill = exec ? { side: exec.side, vwap: exec.vwap, shares: exec.shares, costUsd: exec.costUsd, costPerShare: exec.costPerShare } : null;
      return { pUp: fvDec.pUp, pRaw: fvDec.pRaw ?? null, side, limitPrice: limit, fill, reason: exec ? 'exécutée' : 'prix parti ou profondeur insuffisante' };
    })().catch(err => ({ pUp: fvDec.pUp, pRaw: fvDec.pRaw ?? null, side: null, limitPrice: null, fill: null, reason: `erreur : ${String((err as Error)?.message ?? err).slice(0, 120)}` }));

    // 4. Agents (orchestrateur déterministe).
    const res = await runPipeline({
      snapshot, call: d.call, deadlineAtMs, now: d.now, agentTimeoutMs: d.cfg.agentTimeoutSec * 1000,
      feeRate: d.fv.takerFeeRate, jsonSchemas: d.cfg.jsonSchemas, promptVersion: d.promptVersion ?? undefined,
    });
    rec.formula = await formulaExec;
    rec.latencyMs = res.steps.reduce((a, s) => a + (s.outcome.latencyMs || 0), 0);
    rec.steps = res.steps.map(s => ({
      role: s.role, code: s.code, latencyMs: s.outcome.latencyMs, parsed: s.parsed,
      detail: s.outcome.ok ? null : s.outcome.detail, usage: s.outcome.ok ? s.outcome.usage : null,
    }));
    rec.models = [...new Set(res.steps.flatMap(s => (s.outcome.ok ? s.outcome.usage.models : [])))];
    rec.final = res.final;
    rec.pLlm = res.final ? res.final.proba_estimee : null;
    try { rec.raw = d.journal.saveRaw(rec.id, rec.t, res.steps.map(s => ({ role: s.role, raw: s.outcome.raw }))); } catch { /* sortie brute perdue : la décision reste */ }
    if (res.code === 'ok' || res.code === 'veto' || res.code === 'abstention_agent') {
      d.state.recordSuccess();
      if (rec.latencyMs !== null) { this.latencies.push(rec.latencyMs); if (this.latencies.length > 500) this.latencies.shift(); }
    } else {
      this.onPause(d.state.recordFailure(res.code, d.now()));
    }
    if (res.code !== 'ok' || !res.final) {
      const why = res.steps.find(s => s.code !== 'ok');
      return abstain(res.code, why ? `${why.role} : ${why.outcome.ok ? why.code : why.outcome.detail}` : 'aucune décision');
    }
    const f = res.final;
    if (f.action === 'abstention') return abstain(f.securite?.verdict === 'veto' ? 'veto' : 'abstention_agent', f.raison);

    // 5. Garde-fous du code après la décision : +1 s, carnet relu, formule recalculée.
    await sleep(EXECUTION_LATENCY_MS);
    const side = f.action === 'acheter_up' ? 'UP' : 'DOWN';
    const tExec = d.now();
    const fresh = await d.getRoundData(m.underlying, slot, tExec);
    const [upNow, downNow] = await Promise.all([d.getBook(m.upTokenId), d.getBook(m.downTokenId)]);
    const fvNow = fresh ? decide({ ...fresh, tauSec: (endMs - tExec) / 1000, upAsk: bestLevel(upNow.asks, 'ask')?.price ?? null, downAsk: bestLevel(downNow.asks, 'ask')?.price ?? null }, d.fv) : null;
    const pSide = (p: number | null) => (p === null ? NaN : side === 'UP' ? p : 1 - p);
    const riskNow = evaluateRisk(d.cfg.paperCapital, d.ledger.stats('llm'), d.ledger.calendarPnl(tExec, 'llm'), d.risk, tExec);
    const tradeId = `${m.conditionId}|llm`;
    const g = applyGuards(
      { action: f.action, probaUp: f.proba_estimee, prixLimite: f.prix_limite as number, miseUsd: f.mise_usd as number },
      {
        riskAllowed: riskNow.allowed && d.globalBlock() === null && tExec <= deadlineAtMs + 5_000,
        alreadyBetThisRound: d.ledger.recentIds().includes(tradeId),
        stakeCapUsd: stakeCap, minOrderUsd: d.minOrderUsd, feeRate: d.fv.takerFeeRate, maxAsk: d.fv.maxAsk, minEdge: d.fv.minEdge,
        asksNow: (side === 'UP' ? upNow : downNow).asks,
        formulaPSideAtSnapshot: pSide(fvDec.pUp), formulaPSideNow: pSide(fvNow?.pUp ?? null), staleDrop: d.cfg.staleDrop,
      },
    );
    const fill = g.fill ? { side, vwap: g.fill.vwap, shares: g.fill.shares, costUsd: g.fill.costUsd, costPerShare: g.fill.costPerShare } as const : null;
    rec.exec = { code: g.code, side: g.side, stakeUsd: g.stakeUsd, limitPrice: g.limitPrice, fill, reason: g.reason };
    if (g.code !== 'ok' || !g.fill) return abstain(g.code, g.reason);

    // 6. Pari papier au registre (portée 'llm', capital séparé), puis annonce.
    const p = side === 'UP' ? f.proba_estimee : 1 - f.proba_estimee;
    const trade: LedgerTrade = {
      id: tradeId, strategy: 'llm', decisionId: rec.id, slug: m.slug, coin: m.underlying, side,
      stake: g.fill.costUsd, costPerShare: g.fill.costPerShare, shares: g.fill.shares, modelProb: p, edge: p - g.fill.costPerShare,
      openedAt: new Date(tExec).toISOString(), endMs, status: 'open', pnl: null,
      tokenId: side === 'UP' ? m.upTokenId : m.downTokenId, otherTokenId: side === 'UP' ? m.downTokenId : m.upTokenId, slotSec: slot,
    };
    const block2 = d.globalBlock();
    if (block2) return abstain('bloque_risque', block2);
    let opened = false;
    try { opened = d.ledger.open(trade); } catch (err) { return abstain('bloque_risque', `registre : ${(err as Error).message}`); }
    if (!opened) return abstain('deja_parie', 'round déjà au registre pour llm');
    rec.tradeId = tradeId;
    abstain('ok', `${side} @ ${g.fill.costPerShare.toFixed(4)}/part frais compris, mise ${g.fill.costUsd.toFixed(2)} $, P(Up) agents ${f.proba_estimee.toFixed(3)} vs formule ${fvDec.pUp === null ? '—' : fvDec.pUp.toFixed(3)}`);
    d.notify(`🤖 <b>llm (papier)</b> — ${m.underlying} ${side} · mise ${g.fill.costUsd.toFixed(2)} $ à ${g.fill.vwap.toFixed(3)} (+ frais)\nP(Up) agents ${f.proba_estimee.toFixed(2)} · formule ${fvDec.pUp === null ? '—' : fvDec.pUp.toFixed(2)}\n${f.raison.slice(0, 200).replace(/</g, '&lt;')}`);
  }
}
