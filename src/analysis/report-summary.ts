/**
 * report-summary.ts — résumés COURTS des deux rapports (journal en direct, backtest
 * historique) pour Telegram, avec un verdict en clair.
 *
 * Pourquoi : les rapports complets font 80 lignes et se lancent en SSH ; les décisions
 * (y a-t-il un edge ? quel réglage changer ?) dépendent de leurs chiffres. `/rapport` et
 * `/backtest` les calculent sur le serveur et envoient ce résumé (≤ 4 096 caractères).
 *
 * Fonctions PURES : les chiffres viennent des scripts (fv-report.ts, historical-backtest.ts).
 * HTML Telegram : seuls <b> et des nombres sont émis (aucun texte externe ; le nom de campagne
 * llm est réduit à [A-Za-z0-9._-]).
 */
import { STOP_RULE, type StopLook, type StopVerdict } from '../strategy/llm/stop-rule.js';

export interface ReplayLine {
  n: number;
  winRate: number | null;
  /** PnL moyen par 1 $ misé. */
  ev: number | null;
  t: number | null;
  evH1: number | null;
  evH2: number | null;
}

export interface Thresholds {
  minEdge: number;
  minProb: number;
}

export interface JournalSummary {
  days: number;
  evaluations: number;
  lateMeasures: number;
  /** Rounds réglés (toutes évaluations confondues). */
  rounds: number;
  /** Modèle seul vs carnet, fenêtre d'entrée, apparié par round (t ≤ −2 = modèle meilleur). */
  model: { rounds: number; brierModel: number | null; brierMarket: number | null; t: number | null };
  current: ReplayLine & Thresholds;
  /** Meilleur couple de seuils positif sur les deux moitiés (null si aucun). */
  best: (ReplayLine & Thresholds & { tested: number }) | null;
  late: (ReplayLine & { tModel: number | null; rounds: number }) | null;
  vol: { rounds: number; tPark: number | null; tBlend: number | null; current: string } | null;
  strike: { rounds: number; withPs: number; compared: number; same: number; tOfficial: number | null; officialRounds: number } | null;
  zScale: { m: number; lo: number; hi: number; current: number } | null;
  buys: { n: number; wins: number } | null;
  /** Récolte de fin de round : paris pris (papier) et règle rejouée sur le journal. */
  harvest?: { enabled: boolean; taken: ReplayLine | null; replay: ReplayLine | null } | null;
  /** Stratégie llm (papier) contre la formule : absent sans décision llm sur la période (résumé inchangé). */
  llm?: LlmSummary | null;
}

/**
 * Stratégie llm contre la formule évaluée au MÊME instantané et exécutée par le même modèle
 * (llm-report.ts) : campagne la plus récente.
 */
export interface LlmSummary {
  /** Campagne (version du CLI + version des prompts). */
  campaign: string;
  /** Décisions de la campagne sur la période (abstentions comprises). */
  attempts: number;
  /** Décisions appariées réglées sur la période (P(Up) formule valide). */
  paired: number;
  /** Paris réglés de chaque côté parmi elles, et gain moyen pour 1 $ par pari (frais compris). */
  llmBets: number;
  formulaBets: number;
  llmGainPerBet: number | null;
  formulaGainPerBet: number | null;
  /** Brier sur les paires où les deux P(Up) sont valides. */
  brier: { n: number; llm: number | null; formula: number | null };
  /** Règle d'arrêt pré-enregistrée (stop-rule.ts), sur TOUTE la campagne. */
  stop: { n: number; look: StopLook; verdict: StopVerdict; deltaBrier: number | null; zBrier: number | null; deltaGain: number | null; zGain: number | null };
}

export interface BacktestSummary {
  days: number;
  rounds: number;
  all: { rounds: number; brierModel: number | null; brierMarket: number | null; t: number | null };
  byTau: Array<{ tau: number; rounds: number; t: number | null }>;
  current: (ReplayLine & Thresholds) | null;
  /** Estimateur de volatilité significativement meilleur que celui du bot (null : aucun). */
  betterVol: string | null;
  zScale: { m: number; lo: number; hi: number; current: number } | null;
  medianLagSec: number | null;
}

export type VerdictLevel = 'early' | 'negative' | 'none' | 'lead' | 'edge';

export interface Verdict {
  level: VerdictLevel;
  text: string;
}

/** Rounds réglés minimum avant de conclure (≈ 8 h de marché à 5 cryptos ; groupés par créneau). */
export const MIN_ROUNDS_VERDICT = 500;
/** Couple de seuils retenu : t ≥ 2,9 (Bonferroni sur 36 couples), n ≥ 100, deux moitiés > 0. */
export const T_BEST = 2.9;

// ---------------------------------------------------------------- formatage (fr)

const dec = (x: number, d: number) => x.toFixed(d).replace('.', ',');
const signed = (x: number, d: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${dec(Math.abs(x), d)}`;
const tFmt = (t: number | null) => (t === null ? '—' : signed(t, 1));
const evFmt = (ev: number | null) => (ev === null ? '—' : `${signed(ev * 100, 1)} %/$`);
const pctFmt = (x: number | null) => (x === null ? '—' : `${dec(x * 100, 0)} %`);
const int = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const halvesFmt = (r: Pick<ReplayLine, 'evH1' | 'evH2'>) => `moitiés ${evFmt(r.evH1)} / ${evFmt(r.evH2)}`;
/** « 0 round réglé », « 1 pari », « 2 paris » : forme plurielle à partir de 2 (règle française). */
const count = (n: number, one: string, many: string) => `${int(n)} ${Math.abs(n) >= 2 ? many : one}`;

function replayFmt(r: ReplayLine): string {
  if (!r.n) return 'aucun pari';
  return `${count(r.n, 'pari', 'paris')} · ${pctFmt(r.winRate)} gagnés · ${evFmt(r.ev)} (t ${tFmt(r.t)}) · ${halvesFmt(r)}`;
}

const thrFmt = (t: Thresholds) => `edge ≥ ${dec(t.minEdge * 100, 0)} pt, proba ≥ ${dec(t.minProb * 100, 0)} %`;

/** Positif, significatif et stable : n ≥ 100, t ≥ tMin, les deux moitiés > 0. */
export function solid(r: ReplayLine | null | undefined, tMin = 2): boolean {
  return !!r && r.n >= 100 && (r.t ?? 0) >= tMin && (r.evH1 ?? 0) > 0 && (r.evH2 ?? 0) > 0 && (r.ev ?? 0) > 0;
}

// ---------------------------------------------------------------- journal en direct

/** Verdict de la récolte de fin de round (paris papier réellement pris), en une phrase ; '' si trop peu. */
export function harvestNote(s: Pick<JournalSummary, 'harvest'>): string {
  const h = s.harvest?.taken;
  if (!h || h.n < 30) return '';
  if (solid(h)) return ` Récolte fin de round : rentable en papier (${evFmt(h.ev)}, t ${tFmt(h.t)}, ${count(h.n, 'pari', 'paris')}, deux moitiés positives) — à confirmer sur ≥ 2 semaines.`;
  if ((h.t ?? 0) <= -2) return ` Récolte fin de round : PERD en papier (${evFmt(h.ev)}, t ${tFmt(h.t)}) → la couper (FV_HARVEST=false).`;
  return ` Récolte fin de round : ${count(h.n, 'pari', 'paris')}, ${evFmt(h.ev)} (t ${tFmt(h.t)}) — pas encore concluant.`;
}

export function journalVerdict(s: JournalSummary): Verdict {
  const v = journalVerdictMain(s);
  return { ...v, text: v.text + harvestNote(s) };
}

function journalVerdictMain(s: JournalSummary): Verdict {
  if (s.model.rounds < MIN_ROUNDS_VERDICT) {
    return { level: 'early', text: `⏳ Trop tôt : ${int(s.model.rounds)} rounds comparables, il en faut ≥ ${MIN_ROUNDS_VERDICT} (quelques heures à 5 cryptos). Rester en papier.` };
  }
  if ((s.model.t ?? 0) >= 2) {
    return { level: 'negative', text: '❌ Le carnet prédit mieux que le modèle : PAS d\'edge dans la fenêtre d\'entrée. Ne pas passer en réel.' };
  }
  const lead = solid(s.late) ? ` Piste : dernière minute (${evFmt(s.late!.ev)}, t ${tFmt(s.late!.t)}) — à étudier, jamais jouée.` : '';
  if ((s.model.t ?? 0) <= -2 && solid(s.current)) {
    return { level: 'edge', text: `✅ Edge probable au réglage actuel (${evFmt(s.current.ev)}, t ${tFmt(s.current.t)}, deux moitiés positives). À confirmer sur ≥ 2 semaines avant tout argent réel.${lead}` };
  }
  if (lead) return { level: 'lead', text: `🔎 Pas d'edge démontré au réglage actuel.${lead}` };
  return { level: 'none', text: '⏳ Pas d\'edge démontré : rester en papier et laisser tourner.' };
}

// ---------------------------------------------------------------- stratégie llm (papier)

/** Nom de campagne réduit à [A-Za-z0-9._-] : texte venu du journal, jamais de HTML. */
const campaignFmt = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 48) || '?';
const lookFmt = (l: StopLook) => (l === 'final' ? `final (${int(STOP_RULE.nFinal)})` : `intermédiaire (${int(STOP_RULE.nIntermediaire)})`);

const STOP_FMT: Readonly<Record<StopVerdict, (st: LlmSummary['stop']) => string>> = {
  insuffisant: st => `⏳ insuffisant (${int(st.n)}/${int(STOP_RULE.nIntermediaire)} décisions appariées)`,
  non_concluant: st => `🔎 non concluant au regard ${lookFmt(st.look)} → prolonger (${int(st.n)}/${int(STOP_RULE.nFinal)})`,
  succes: st => `✅ succès au regard ${lookFmt(st.look)} : llm meilleur que la formule (papier seulement)`,
  echec: st => `❌ échec au regard ${lookFmt(st.look)} : garder la formule`,
};

/** Lignes llm du résumé : paris et gains contre la formule, Brier apparié, règle d'arrêt. */
export function llmSummaryLines(l: LlmSummary): string[] {
  const st = l.stop;
  const b4 = (x: number | null) => (x === null ? '—' : dec(x, 4));
  return [
    `<b>llm vs formule</b> (papier, même instantané · campagne ${campaignFmt(l.campaign)}) : ${count(l.attempts, 'décision', 'décisions')}`,
    `   paris réglés : llm ${int(l.llmBets)} (${evFmt(l.llmGainPerBet)} par pari) · formule ${int(l.formulaBets)} (${evFmt(l.formulaGainPerBet)} par pari)`
      + ` · sur ${count(l.paired, 'décision appariée', 'décisions appariées')}`,
    `   Brier apparié : llm ${b4(l.brier.llm)} vs formule ${b4(l.brier.formula)} (${count(l.brier.n, 'paire', 'paires')}, plus bas = meilleur)`,
    `   Règle d'arrêt (toute la campagne) : ${STOP_FMT[st.verdict](st)} · ΔBrier ${st.deltaBrier === null ? '—' : signed(st.deltaBrier, 4)} (z ${tFmt(st.zBrier)})`
      + ` · ΔGain ${evFmt(st.deltaGain)} par décision (z ${tFmt(st.zGain)})`,
  ];
}

export function renderJournalSummary(s: JournalSummary): string {
  const L: string[] = [];
  L.push(`📊 <b>Rapport edge — ${int(s.days)} dernier${s.days >= 2 ? 's' : ''} jour${s.days >= 2 ? 's' : ''}</b>`);
  L.push(`${count(s.rounds, 'round réglé', 'rounds réglés')} · ${count(s.evaluations, 'évaluation', 'évaluations')}${s.lateMeasures ? ` (+ ${int(s.lateMeasures)} fin de round)` : ''}`);
  if (!s.rounds) {
    L.push('', 'Aucun round réglé dans le journal pour cette période : laisser tourner le bot (journal FV_JOURNAL activé).');
    if (s.llm) L.push('', ...llmSummaryLines(s.llm));
    return L.join('\n');
  }
  const m = s.model;
  const better = m.t === null ? 'pas assez de données' : m.t <= -2 ? 'OUI (significatif)' : m.t >= 2 ? 'NON, le carnet est meilleur' : 'pas de différence significative';
  L.push('', `<b>Le modèle bat-il le carnet ?</b> ${better}`);
  L.push(`   erreur (Brier) modèle ${m.brierModel === null ? '—' : dec(m.brierModel, 4)} vs carnet ${m.brierMarket === null ? '—' : dec(m.brierMarket, 4)} · t ${tFmt(m.t)} (≤ −2 requis) · ${int(m.rounds)} rounds`);
  L.push('', `<b>Réglage actuel</b> (${thrFmt(s.current)}) rejoué au meilleur ask :`);
  L.push(`   ${replayFmt(s.current)}`);
  if (s.best && (s.best.minEdge !== s.current.minEdge || s.best.minProb !== s.current.minProb)) {
    L.push(`<b>Meilleur réglage testé</b> (${thrFmt(s.best)}) : ${evFmt(s.best.ev)} (t ${tFmt(s.best.t)}, n=${int(s.best.n)}) · ${halvesFmt(s.best)}`);
    L.push(`   ${s.best.tested} couples testés : ne compte que si t ≥ ${dec(T_BEST, 1)} (sinon hasard probable).`);
  }
  if (s.late) {
    L.push('', `<b>Dernière minute</b> (mesurée, jamais jouée) : modèle vs carnet t ${tFmt(s.late.tModel)} (${int(s.late.rounds)} rounds)`);
    L.push(`   entrées hypothétiques : ${replayFmt(s.late)}`);
  }
  if (s.harvest && (s.harvest.enabled || s.harvest.taken?.n || s.harvest.replay?.n)) {
    L.push('', `<b>Récolte fin de round</b> (favori bloqué à 0,99, ${s.harvest.enabled ? 'active en papier' : 'désactivée'}) :`);
    L.push(`   pris : ${s.harvest.taken ? replayFmt(s.harvest.taken) : 'aucun pari'}`);
    if (s.harvest.replay) L.push(`   règle rejouée sur le journal : ${replayFmt(s.harvest.replay)}`);
  }
  if (s.vol && s.vol.rounds) {
    const best = (s.vol.tPark ?? 0) <= -2 ? 'Parkinson meilleur' : (s.vol.tBlend ?? 0) <= -2 ? 'mélange meilleur' : 'garder le réglage';
    L.push(`<b>Volatilité</b> (${s.vol.current}) : Parkinson t ${tFmt(s.vol.tPark)}, mélange t ${tFmt(s.vol.tBlend)} → ${best}`);
  }
  if (s.strike && s.strike.rounds) {
    const st = s.strike;
    L.push(`<b>Prix à battre officiel</b> : lu en direct dans ${pctFmt(st.withPs / st.rounds)} des rounds`
      + (st.compared ? `, identique au règlement ${pctFmt(st.same / st.compared)}` : '')
      + (st.officialRounds ? ` · modèle avec prix officiel t ${tFmt(st.tOfficial)} (${int(st.officialRounds)} rounds, ≤ −2 = mieux)` : ''));
  }
  if (s.zScale) {
    const z = s.zScale;
    const inside = z.current >= z.lo && z.current <= z.hi;
    L.push(`<b>Calibration</b> : FV_Z_SCALE optimal ${dec(z.m, 2)} (IC95 ${dec(z.lo, 2)}–${dec(z.hi, 2)}), actuel ${dec(z.current, 2)}${inside ? ' ✓' : ' → à revoir'}`);
  }
  if (s.buys && s.buys.n) L.push(`<b>Paris papier pris</b> : ${int(s.buys.n)}, gagnés ${pctFmt(s.buys.wins / s.buys.n)}`);
  if (s.llm) L.push('', ...llmSummaryLines(s.llm));
  L.push('', `<b>Verdict</b> : ${journalVerdict(s).text}`);
  return L.join('\n');
}

// ---------------------------------------------------------------- backtest historique

export function backtestVerdict(s: BacktestSummary): Verdict {
  if (s.all.rounds < MIN_ROUNDS_VERDICT) {
    return { level: 'early', text: `⏳ Trop peu de rounds évaluables (${int(s.all.rounds)}) : relancer avec plus de jours (/backtest 3).` };
  }
  const t = s.all.t ?? 0;
  if (t >= 2) return { level: 'negative', text: '❌ Les prix Polymarket prédisaient mieux que le modèle : pas d\'edge sur l\'historique.' };
  if (t <= -2) {
    return solid(s.current)
      ? { level: 'edge', text: '✅ Modèle meilleur que les prix historiques ET seuils actuels rentables (asks reconstitués). Piste sérieuse — à confirmer en direct (/rapport).' }
      : { level: 'lead', text: '🔎 Modèle meilleur que les prix historiques, mais seuils actuels pas rentables de façon stable. Les prix historiques peuvent être périmés : confirmer en direct (/rapport).' };
  }
  return { level: 'none', text: '⏳ Pas de différence significative avec le marché : pas d\'edge démontré.' };
}

export function renderBacktestSummary(s: BacktestSummary): string {
  const L: string[] = [];
  L.push(`🧪 <b>Backtest historique — ${dec(s.days, s.days % 1 ? 1 : 0)} jour${s.days >= 2 ? 's' : ''}</b>`);
  L.push(`${count(s.rounds, 'round réglé', 'rounds réglés')} Polymarket rejoué${s.rounds >= 2 ? 's' : ''} (prix par minute + bougies Binance)`);
  const a = s.all;
  L.push('', `<b>Le modèle bat-il les prix Polymarket ?</b> ${a.t === null ? 'pas assez de données' : a.t <= -2 ? 'OUI (significatif)' : a.t >= 2 ? 'NON, le marché est meilleur' : 'pas de différence significative'}`);
  L.push(`   Brier modèle ${a.brierModel === null ? '—' : dec(a.brierModel, 4)} vs marché ${a.brierMarket === null ? '—' : dec(a.brierMarket, 4)} · t ${tFmt(a.t)} · ${int(a.rounds)} rounds`);
  if (s.byTau.length) L.push(`   par temps restant : ${s.byTau.map(x => `${x.tau} s t ${tFmt(x.t)}`).join(' · ')}`);
  if (s.current) {
    L.push('', `<b>Réglage actuel</b> (${thrFmt(s.current)}), asks reconstitués — indicatif :`);
    L.push(`   ${replayFmt(s.current)}`);
  }
  L.push(`<b>Volatilité</b> : ${s.betterVol ? `${s.betterVol} prédit mieux (à confirmer en direct)` : 'aucun estimateur ne bat celui du bot'}`);
  if (s.zScale) {
    const z = s.zScale;
    L.push(`<b>Calibration</b> : FV_Z_SCALE optimal ${dec(z.m, 2)} (IC95 ${dec(z.lo, 2)}–${dec(z.hi, 2)}), actuel ${dec(z.current, 2)}`);
  }
  if (s.medianLagSec !== null) L.push(`<i>Spot du modèle en retard de ${int(s.medianLagSec)} s (médiane) sur le prix marché : désavantage pour le modèle.</i>`);
  L.push('', `<b>Verdict</b> : ${backtestVerdict(s).text}`);
  return L.join('\n');
}
