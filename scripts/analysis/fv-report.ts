/**
 * Rapport d'analyse du journal des décisions (stratégie juste valeur).
 *
 *   npx tsx scripts/analysis/fv-report.ts [--dir ~/.polymarket/journal] [--days 7] [--json out.json] [--summary]
 *
 * 1. lit les évaluations journalisées (decisions-*.jsonl) ;
 * 2. règle chaque round via Gamma `events?slug=` (cache ~/.polymarket/outcomes-cache.json) ;
 * 3. répond, dans l'ordre : le modèle bat-il le marché (Brier) ? est-il calibré ?
 *    quels seuils auraient rapporté, et est-ce stable sur les deux moitiés ?
 *
 * `--summary` : seulement le résumé Telegram (HTML) avec le verdict — c'est ce que la
 * commande /rapport du bot exécute.
 *
 * Lecture seule sur le journal ; écrit uniquement le cache des résultats.
 */
import 'dotenv/config';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { JOURNAL_FILE_RE, type DecisionRecord } from '../../src/services/decision-journal.js';
import { gunzipSync } from 'node:zlib';
import { fetchRoundOutcome } from '../../src/services/paper-ledger.js';
import { entryMinTauSec, fairValueConfigFromEnv } from '../../src/services/fair-value.js';
import {
  applyBlend, blendVerdict, zScaleConflictsWithBlend, bookStats, brier, byRound, calibration, compareModelBook, compareOfficialStrike, compareProbs, compareSigmaEstimators, describeBlend, fitBlend, lateRounds,
  fitZScale, halves, marketProbUp, normalizeZScale, rawModelProb, replay, zScaleAdvice,
  liveStrikeAvailability, strikeVsOfficial, thresholdGrid, type ResolvedRecord, type ScanParams, type ScanResult,
} from '../../src/analysis/fv-analysis.js';
import { renderJournalSummary, solid, T_BEST, type JournalSummary, type ReplayLine } from '../../src/analysis/report-summary.js';
import { harvestReplay, harvestTaken } from '../../src/analysis/fv-analysis.js';
import { harvestConfigFromEnv } from '../../src/strategy/late-harvest.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const POLY = join(process.env.HOME || homedir(), '.polymarket');
const DIR = arg('dir') ?? join(POLY, 'journal');
const DAYS = Math.min(90, Math.max(0.1, Number(arg('days') ?? '30') || 30));
/** Résumé Telegram seulement (commande /rapport). */
const SUMMARY = process.argv.includes('--summary');
const say = (s = ''): void => { if (!SUMMARY) console.log(s); };

/** Rejeu d'un couple de seuils avec ses deux moitiés chronologiques (stabilité). */
function replayLine(rounds: ResolvedRecord[][], minEdge: number, minProb: number, p: ScanParams): ReplayLine & { r: ScanResult } {
  const r = replay(rounds, minEdge, minProb, p);
  const [a, b] = halves(rounds);
  return {
    r, n: r.n, winRate: r.winRate, ev: r.evPerDollar, t: r.tStat,
    evH1: replay(a, minEdge, minProb, p).evPerDollar, evH2: replay(b, minEdge, minProb, p).evPerDollar,
  };
}
const CACHE = join(POLY, 'outcomes-cache.json');
/** Prix à battre / final publiés par Polymarket (eventMetadata), lus avec le résultat. */
const PRICES_CACHE = join(POLY, 'round-prices-cache.json');
const cfg = fairValueConfigFromEnv(process.env);

const pct = (x: number | null, d = 1) => (x === null ? '—' : `${(x * 100).toFixed(d)} %`);
const num = (x: number | null, d = 3) => (x === null ? '—' : x.toFixed(d));

/** Chaînes partagées : chaque ligne relue crée sinon sa propre copie du slug et du coin. */
const strings = new Map<string, string>();
const intern = (x: string) => strings.get(x) ?? (strings.set(x, x), x);

/** Seuls les champs utiles à l'analyse : un journal de 30 jours ≈ 1 million de lignes. */
function slim(r: DecisionRecord): DecisionRecord {
  return {
    // strike et sig gardés : comparaison avec le prix à battre publié par Polymarket (section 0)
    // spot gardé (hors fin de round) : probabilités recalculées avec un autre σ (1c) ou le prix
    // à battre officiel (0c) ; sc, sp seulement quand les deux σ existent —
    // un journal de 30 jours ≈ 1 million de lignes, chaque champ compte.
    t: r.t, slug: intern(r.slug), coin: intern(r.coin), tau: r.tau, spot: r.lt ? 0 : r.spot, strike: r.strike, sig: r.sig, pUp: r.pUp, pRaw: r.pRaw, zs: r.zs,
    ...(r.sc && r.sp && !r.lt ? { sc: r.sc, sp: r.sp } : {}), ...(r.tw ? { tw: r.tw } : {}),
    ...(r.lt ? { lt: true as const, pl: r.pl ?? null, kn: r.kn, ...(r.hs !== undefined ? { hs: r.hs } : {}), ...(r.hv ? { hv: true as const } : {}) } : {}), // fin de round (1d, 1e)
    ...(r.ps ? { ps: r.ps } : {}), // prix à battre officiel lu en direct (section 0)
    upAsk: r.upAsk, downAsk: r.downAsk, upAskSz: r.upAskSz, downAskSz: null, upBid: r.upBid, src: '', act: r.act === 'buy' ? 'buy' : 'hold',
    // GARDER mv (exclusion des mesures) et tl (loi du modèle) : sans eux, le filtre des
    // évaluations « saut du spot » et la conversion t4 étaient silencieusement inopérants.
    ...(r.side ? { side: r.side } : {}), ...(r.mv ? { mv: true as const } : {}), ...(r.tl ? { tl: r.tl } : {}),
    ...(r.ns ? { ns: r.ns } : {}), // bruit du modèle : edge exigé du rejeu = celui du bot
  };
}

function readJournal(): DecisionRecord[] {
  if (!existsSync(DIR)) {
    if (SUMMARY) {
      // /rapport sur un bot tout neuf : réponse lisible plutôt qu'un « échec »
      console.log(`📊 <b>Rapport edge</b>\nPas encore de journal (${DIR.replace(/&/g, '&amp;').replace(/</g, '&lt;')}) : le bot l'écrit dès ses premières évaluations (FV_JOURNAL≠false). Réessayer dans quelques heures.`);
      process.exit(0);
    }
    console.error(`Aucun journal dans ${DIR} (le bot écrit decisions-*.jsonl quand FV_JOURNAL≠false).`);
    process.exit(1);
  }
  const since = Date.now() - DAYS * 86_400_000;
  const out: DecisionRecord[] = [];
  let bad = 0;
  let otherModel = 0;
  for (const f of readdirSync(DIR).filter(f => JOURNAL_FILE_RE.test(f)).sort()) {
    // jours révolus compressés (.jsonl.gz) par le bot ; un fichier qui disparaît pendant la
    // lecture (compression en cours par le bot) est simplement ignoré
    let raw: Buffer;
    try { raw = readFileSync(join(DIR, f)); } catch { continue; }
    const text = f.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as DecisionRecord;
        if (typeof r.slug !== 'string' || !Number.isFinite(r.t) || r.t < since) continue;
        // Autre définition du modèle (règlement ponctuel vs TWAP, strike différent) : ses
        // probabilités ne sont pas comparables à celles du modèle en vigueur.
        if ((r.tw ?? 0) !== cfg.twapWindowSec) { otherModel++; continue; }
        out.push(slim(r));
      } catch { bad++; }
    }
  }
  if (bad) console.error(`(${bad} lignes illisibles ignorées)`);
  if (otherModel) {
    console.error(`(${otherModel} évaluations d'un autre modèle ignorées : fenêtre TWAP ≠ ${cfg.twapWindowSec} s — `
      + 'évaluations faites avant le passage au règlement TWAP, ou FV_TWAP_WINDOW_SEC différent)');
  }
  return out;
}

async function resolveAll(slugs: string[]): Promise<{ outcomes: Map<string, boolean>; prices: Record<string, [number | null, number | null]> }> {
  const readJson = <T>(f: string, d: T): T => (existsSync(f) ? (() => { try { return JSON.parse(readFileSync(f, 'utf8')) as T; } catch { return d; } })() : d);
  const cache = readJson<Record<string, boolean>>(CACHE, {});
  const prices = readJson<Record<string, [number | null, number | null]>>(PRICES_CACHE, {});
  const todo = slugs.filter(s => !(s in cache) && Number(s.split('-').pop()) * 1000 + 360_000 < Date.now());
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const slug = todo.shift() as string;
      const o = await fetchRoundOutcome(slug);
      if (o.resolved) {
        cache[slug] = o.upWon;
        if (o.priceToBeat || o.finalPrice) prices[slug] = [o.priceToBeat ?? null, o.finalPrice ?? null];
      }
      if (++done % 50 === 0) process.stderr.write(`  rounds réglés : ${done}\n`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache));
  writeFileSync(PRICES_CACHE, JSON.stringify(prices));
  return { outcomes: new Map(Object.entries(cache)), prices };
}

async function main() {
  const records = readJournal();
  if (records.length > 600_000) {
    console.error(`(journal volumineux : ${records.length} évaluations — en cas de manque de mémoire, réduire --days`
      + ' ou lancer avec NODE_OPTIONS=--max-old-space-size=2048)');
  }
  const { outcomes, prices } = await resolveAll([...new Set(records.map(r => r.slug))]);
  // Issue ajoutée EN PLACE (objets fraîchement lus, propres à ce script) : pas de copie.
  const resolved: ResolvedRecord[] = [];
  for (const r of records) {
    if (!outcomes.has(r.slug)) continue;
    (r as ResolvedRecord).upWon = outcomes.get(r.slug) as boolean;
    resolved.push(r as ResolvedRecord);
  }
  // Toutes les évaluations ramenées au FV_Z_SCALE actuel (un journal peut couvrir un
  // changement de réglage), puis probabilité de décision recalculée avec le mélange actuel :
  // le rapport juge le réglage EN VIGUEUR, pas un mélange de réglages passés.
  const rounds = normalizeZScale(byRound(resolved), cfg.zScale, cfg.tails);
  if (resolved.some(r => r.zs === undefined) && cfg.zScale !== 1) {
    console.error('(évaluations sans réglage enregistré : supposées faites avec FV_Z_SCALE=1)');
  }
  const decisionRounds = applyBlend(rounds, cfg.blendModel, cfg.blendMarket);
  // Mesures (modèle vs carnet, mélange, calibration) : passages RÉGULIERS seulement. Les
  // évaluations déclenchées par un saut du spot restent pour le rejeu des paris (ce sont de
  // vraies occasions), mais sur-représenteraient les instants favorables au modèle.
  // Mesures : passages réguliers seulement (ni « saut du spot », ni « fin de round », section 1d).
  const measureRounds = rounds.map(l => l.filter(r => !r.mv && !r.lt)).filter(l => l.length);
  const evals = measureRounds.flat();
  const lateCount = records.filter(r => r.lt).length;
  say(`\n=== Journal : ${records.length - lateCount} évaluations${lateCount ? ` (+ ${lateCount} mesures fin de round)` : ''}, ${new Set(records.map(r => r.slug)).size} rounds, ${rounds.length} rounds réglés ===\n`);
  // Résumé Telegram (--summary), rempli au fil des sections.
  const S: JournalSummary = {
    days: DAYS, evaluations: records.length - lateCount, lateMeasures: lateCount, rounds: rounds.length,
    model: { rounds: 0, brierModel: null, brierMarket: null, t: null },
    current: { minEdge: cfg.minEdge, minProb: cfg.minProb, n: 0, winRate: null, ev: null, t: null, evH1: null, evH2: null },
    best: null, late: null, vol: null, strike: null, zScale: null, buys: null,
  };
  if (!rounds.length) {
    if (SUMMARY) console.log(renderJournalSummary(S));
    return;
  }

  // 0. Notre prix à battre (estimé) vs celui de Polymarket, s'il est publié dans Gamma.
  const checks = rounds.flatMap(l => {
    const r = l[0];
    const p = prices[r.slug];
    return p && p[0] ? [{ coin: r.coin, slotSec: Number(r.slug.split('-').pop()), est: r.strike, sig: r.sig, ptb: p[0], final: p[1] ?? undefined, upWon: r.upWon }] : [];
  });
  if (!checks.length) {
    say('0) Prix à battre : Polymarket ne le publie pas dans Gamma (eventMetadata.priceToBeat) pour ces rounds — comparaison impossible.\n');
  } else {
    const sc = strikeVsOfficial(checks, cfg.strikeNoiseSec);
    say(`0) Prix à battre : notre estimation (bougie de la minute précédant l'ouverture) vs Polymarket (${checks.length} rounds)`);
    for (const c of sc.coins) {
      say(`   ${c.coin.padEnd(5)} n=${String(c.n).padStart(5)}  écart moyen ${num(c.meanBps, 1).padStart(6)} bps  dispersion ${num(c.sdBps, 1).padStart(5)} bps`
        + `  | corrigé d'un écart glissant (1 h) ${num(c.sdResidBps, 1).padStart(5)} bps  | bruit supposé ${num(c.assumedBps, 1)} bps`);
    }
    if (sc.consistency.n) {
      say(`   cohérence « prix final ≥ prix à battre ⇔ Up » : ${pct(sc.consistency.agree / sc.consistency.n)} (n=${sc.consistency.n}) — sous 99 %, ces champs ne signifient pas ce qu'on croit`);
    }
    say('   Dispersion corrigée nettement sous la dispersion brute → lire le prix officiel améliorerait le modèle (et réduirait la marge de bruit).\n');
  }
  // 0b. Prix à battre officiel DISPONIBLE PENDANT le round ? (prérequis pour l'utiliser en direct)
  const live = liveStrikeAvailability(measureRounds, prices);
  if (live.rounds) {
    say(`0b) Prix à battre officiel en direct : présent dans ${pct(live.withPs / live.rounds)} des rounds (${live.withPs}/${live.rounds})`
      + (live.medianDelaySec === null ? '' : `, publié au plus tard ~${Math.round(live.medianDelaySec)} s après l'ouverture (médiane)`)
      + (live.compared ? ` ; identique à la valeur publiée au règlement dans ${pct(live.same / live.compared)} des cas (n=${live.compared})` : '') + '.');
    say(live.withPs / live.rounds >= 0.95 && (!live.compared || live.same / live.compared >= 0.99)
      ? '   → disponible et stable : l\'utiliser en direct est envisageable (corriger l\'écart Chainlink/Binance de la section 0 d\'abord).\n'
      : '   → pas assez disponible ou pas stable : continuer d\'estimer le prix à battre depuis les bougies.\n');
  }
  // 0c. Le modèle prédirait-il mieux avec le prix à battre officiel (corrigé de l'écart glissant) ?
  const off = compareOfficialStrike(measureRounds, prices, cfg, { minTau: entryMinTauSec(cfg), maxTau: cfg.maxTauSec });
  if (off.rounds) {
    say(`0c) Modèle avec le prix à battre officiel (corrigé de l'écart Binance/Chainlink des 12 rounds précédents) vs estimé :`
      + ` Brier ${num(off.brierA, 4)} | ${num(off.brierB, 4)} | t ${num(off.t, 1)} (n=${off.rounds} rounds ; t ≤ −2 = officiel meilleur)`);
    say(off.t !== null && off.t <= -2
      ? '   → le prix officiel améliore SIGNIFICATIVEMENT le modèle : candidat FV_STRIKE_SOURCE=official (si 0b le dit disponible en direct).\n'
      : '   → pas de gain significatif : garder le prix à battre estimé.\n');
  }
  S.strike = live.rounds || off.rounds
    ? { rounds: live.rounds, withPs: live.withPs, compared: live.compared, same: live.same, tOfficial: off.t, officialRounds: off.rounds }
    : null;

  // 1. Modèle vs marché : appariée (mêmes évaluations), chaque round pesant 1, modèle SEUL
  // (avant mélange), t groupé par créneau (les 5 cryptos d'un round sont corrélées).
  const cmp = compareModelBook(measureRounds, { minTau: entryMinTauSec(cfg), maxTau: cfg.maxTauSec });
  S.model = { rounds: cmp.rounds, brierModel: cmp.brierModel, brierMarket: cmp.brierMarket, t: cmp.t };
  const bm = { n: cmp.rounds, score: cmp.brierModel };
  const bk = { n: cmp.rounds, score: cmp.brierMarket };
  say('1) Le modèle prédit-il mieux que le carnet ? (Brier, plus bas = meilleur ; t ≤ −2 = modèle meilleur)');
  say(`   par round (fenêtre d'entrée)   : modèle ${num(cmp.brierModel, 4)} | carnet ${num(cmp.brierMarket, 4)}`
    + ` | t ${num(cmp.t, 1)} (n=${cmp.rounds} rounds)`);
  const am = brier(evals, rawModelProb);
  const ak = brier(evals, marketProbUp);
  say(`   toutes les évaluations         : modèle ${num(am.score, 4)} | carnet ${num(ak.score, 4)} (n=${am.n}, corrélées au sein d'un round)`);
  if (cmp.t !== null) {
    say(cmp.t <= -2
      ? '   → le modèle bat SIGNIFICATIVEMENT le carnet : un edge est possible (à confirmer par les seuils sur les deux moitiés).'
      : cmp.t >= 2
        ? '   → le carnet prédit significativement mieux : PAS d\'edge, quel que soit le seuil.'
        : '   → pas de différence significative : aucun edge démontré à ce stade.');
  }

  // 1c. Estimateur de volatilité : clôture-à-clôture (réglage par défaut) vs Parkinson vs mélange
  const sg = compareSigmaEstimators(measureRounds, cfg, { minTau: entryMinTauSec(cfg), maxTau: cfg.maxTauSec });
  say(`\n1c) Volatilité : clôture-à-clôture (cc) vs Parkinson (plus haut/plus bas) vs mélange — réglage actuel FV_VOL_ESTIMATOR=${cfg.volEstimator ?? 'cc'}`);
  if (sg.rounds) S.vol = { rounds: sg.rounds, tPark: sg.tPark, tBlend: sg.tBlend, current: `FV_VOL_ESTIMATOR=${cfg.volEstimator ?? 'cc'}` };
  if (!sg.rounds) {
    say('   pas encore d\'évaluations avec les deux σ journalisées (champs sc/sp, écrits depuis cette version du bot).');
  } else {
    say(`   Brier par round : cc ${num(sg.brierCc, 4)} | parkinson ${num(sg.brierPark, 4)} (t ${num(sg.tPark, 1)}) | mélange ${num(sg.brierBlend, 4)} (t ${num(sg.tBlend, 1)}) — n=${sg.rounds} rounds (t ≤ −2 = meilleur que cc)`);
    const best = sg.tPark !== null && sg.tPark <= -2 && (sg.tBlend === null || sg.tPark <= sg.tBlend) ? 'parkinson' : sg.tBlend !== null && sg.tBlend <= -2 ? 'blend' : null;
    say(best
      ? `   → ${best} prédit SIGNIFICATIVEMENT mieux : candidat FV_VOL_ESTIMATOR=${best} (à confirmer sur les deux moitiés avant de changer).`
      : '   → pas de différence significative : garder cc (le rebond bid/ask gonfle Parkinson sur les petits cours).');
  }

  // 1d. Dernière minute du round : P(Up) avec la part acquise du TWAP, contre le carnet, et
  // les entrées hypothétiques (jamais prises par le bot).
  const late = lateRounds(rounds);
  say(`\n1d) Fin de round (τ < ${cfg.twapWindowSec} s, TWAP de règlement en partie acquis) — mesure seulement : le bot n'y entre JAMAIS`);
  if (!late.length) {
    say('   pas encore de mesures (flux spot temps réel requis ; champs lt/pl écrits depuis cette version du bot).');
  } else {
    const lp = { feeRate: cfg.takerFeeRate, minAsk: cfg.minAsk, maxAsk: cfg.maxAsk, minTau: 5, maxTau: cfg.twapWindowSec, noiseK: 0 };
    const lateRegular = lateRounds(rounds.map(l => l.filter(r => !r.mv)).filter(l => l.length)); // sans les passages « saut du spot »
    const lc = compareProbs(lateRegular, r => r.pUp, marketProbUp, { minTau: 5, maxTau: cfg.twapWindowSec });
    say(`   P(Up) fin de round vs carnet : Brier ${num(lc.brierA, 4)} | ${num(lc.brierB, 4)} | t ${num(lc.t, 1)} (n=${lc.rounds} rounds ; t ≤ −2 = le modèle voit mieux que le carnet)`);
    const lr = replayLine(late, cfg.minEdge, cfg.minProb, lp);
    S.late = { n: lr.n, winRate: lr.winRate, ev: lr.ev, t: lr.t, evH1: lr.evH1, evH2: lr.evH2, tModel: lc.t, rounds: lc.rounds };
    say(`   entrées hypothétiques (seuils actuels, sans marge de bruit, remplies au meilleur ask) : n=${lr.n}  WR ${pct(lr.winRate)}  EV/$ ${num(lr.ev, 4)}  t ${num(lr.t, 1)}  | moitiés ${num(lr.evH1, 3)} / ${num(lr.evH2, 3)}`);
    const promising = solid(lr);
    say(promising
      ? '   → un edge SEMBLE exister en fin de round (deux moitiés positives). Avant d\'y entrer : latence réelle de remplissage, Chainlink ≠ Binance, profondeur — à étudier, pas à activer.'
      : '   → rien de démontré en fin de round (ou pas assez de rounds).');
  }

  // 1e. Récolte de fin de round (favori bloqué à 0,99) : paris pris et règle rejouée
  const hcfg = harvestConfigFromEnv(process.env);
  const ho = { minAsk: hcfg.minAsk, maxAsk: hcfg.maxAsk, minTau: hcfg.minTauSec, maxTau: hcfg.maxTauSec, stableSec: hcfg.stableSec, feeRate: cfg.takerFeeRate };
  say(`\n1e) Récolte fin de round (favori bloqué à ≥ ${hcfg.minAsk} depuis ≥ ${hcfg.stableSec} s, τ ${hcfg.maxTauSec}→${hcfg.minTauSec} s) — ${hcfg.enabled ? 'ACTIVE en papier' : 'désactivée (FV_HARVEST=true pour l\'activer)'}`);
  const toLine = (f: (rs: ResolvedRecord[][]) => ScanResult, rs: ResolvedRecord[][]): ReplayLine | null => {
    if (!rs.length) return null;
    const all = f(rs);
    if (!all.n) return null;
    const [a, b] = halves(rs);
    return { n: all.n, winRate: all.winRate, ev: all.evPerDollar, t: all.tStat, evH1: f(a).evPerDollar, evH2: f(b).evPerDollar };
  };
  const lateAll = rounds.map(l => l.filter(r => r.lt)).filter(l => l.length);
  const hReplay = toLine(rs => harvestReplay(rs, ho), lateAll);
  const hTaken = toLine(rs => harvestTaken(rs.flat(), cfg.takerFeeRate), rounds.map(l => l.filter(r => r.hv)).filter(l => l.length));
  const hFmt = (l: ReplayLine | null) => (l ? `n=${l.n}  WR ${pct(l.winRate, 2)}  EV/$ ${num(l.ev, 4)}  t ${num(l.t, 1)}  | moitiés ${num(l.evH1, 4)} / ${num(l.evH2, 4)}` : 'aucun');
  say(`   paris pris (papier, au meilleur ask de la décision) : ${hFmt(hTaken)}`);
  say(`   règle rejouée sur les mesures de fin de round      : ${hFmt(hReplay)}`);
  say('   Historique (carnets réels août 2026) : +0,72 %/pari, gagné 99,74 %. Un gain moyen bien plus bas ou un t ≤ −2 → couper FV_HARVEST.');
  S.harvest = { enabled: hcfg.enabled, taken: hTaken, replay: hReplay };

  // 1b. Mélange modèle + carnet
  say('\n1b) Mélange modèle + carnet (le carnet contient-il une information que le modèle ignore ?)');
  const params = { feeRate: cfg.takerFeeRate, minAsk: cfg.minAsk, maxAsk: cfg.maxAsk, minTau: entryMinTauSec(cfg), maxTau: cfg.maxTauSec, noiseK: cfg.noiseEdgeK };
  const blend = fitBlend(measureRounds, { minTau: entryMinTauSec(cfg), maxTau: cfg.maxTauSec });
  for (const line of describeBlend(blend, cfg)) say(line);
  if (blend?.oos) {
    // mêmes rounds que la moitié de validation du mélange (aucun round vu à l'estimation)
    const h2Slugs = new Set(halves(measureRounds)[1].map(l => l[0].slug));
    const h2 = rounds.filter(l => h2Slugs.has(l[0].slug));
    const raw = replay(applyBlend(h2, 1, 0), cfg.minEdge, cfg.minProb, params);
    const mixed = replay(applyBlend(h2, blend.oos.a, blend.oos.b), cfg.minEdge, cfg.minProb, params);
    say(`     seuils actuels sur la 2e moitié : modèle seul EV/$ ${num(raw.evPerDollar, 4)} (n=${raw.n})`
      + ` | mélange EV/$ ${num(mixed.evPerDollar, 4)} (n=${mixed.n})`);
  }

  // 2. Calibration
  say('\n2) Calibration du modèle seul (toutes évaluations)');
  say('   tranche     n      p moyen   Up réel');
  for (const b of calibration(evals, rawModelProb)) {
    say(`   ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(6)}   ${pct(b.meanP)}   ${pct(b.freqUp)}`);
  }

  // 2b. Réglage de calibration suggéré
  const fit = fitZScale(measureRounds, 150, cfg.tails);
  if (fit) S.zScale = { m: fit.m, lo: fit.lo, hi: fit.hi, current: cfg.zScale };
  if (fit) {
    say(`\n2b) Calibration (un paramètre, ${fit.n} rounds) : FV_Z_SCALE optimal ${fit.m} (IC95 ${fit.lo}–${fit.hi})`);
    say(`   ${zScaleAdvice(fit, cfg.zScale, zScaleConflictsWithBlend(blendVerdict(blend, cfg), cfg))}`);
  }

  // 3. Seuils (probabilité utilisée par le bot, mélange compris s'il est configuré)
  const edges = [0, 0.02, 0.04, 0.06, 0.08, 0.1];
  const probs = [0.5, 0.55, 0.6, 0.65, 0.7, 0.8];
  const [h1, h2] = halves(decisionRounds);
  say('\n3) Seuils rejoués (1 pari/round au meilleur ask, frais inclus) — EV par 1 $ misé');
  say('   edge  pmin     n     WR      EV/$     t   | moitié 1 EV   moitié 2 EV');
  for (const r of thresholdGrid(decisionRounds, edges, probs, params)) {
    if (r.n < 10) continue;
    const a = replay(h1, r.minEdge, r.minProb, params);
    const b = replay(h2, r.minEdge, r.minProb, params);
    const cur = r.minEdge === cfg.minEdge && r.minProb === cfg.minProb ? '  ← réglage actuel' : '';
    say(`   ${r.minEdge.toFixed(2)}  ${r.minProb.toFixed(2)} ${String(r.n).padStart(6)}  ${pct(r.winRate).padStart(7)} ${num(r.evPerDollar, 4).padStart(8)} ${num(r.tStat, 1).padStart(5)}  |  ${num(a.evPerDollar, 4).padStart(8)} (n=${a.n})  ${num(b.evPerDollar, 4).padStart(8)} (n=${b.n})${cur}`);
  }
  const cur = replayLine(decisionRounds, cfg.minEdge, cfg.minProb, params);
  S.current = { minEdge: cfg.minEdge, minProb: cfg.minProb, n: cur.n, winRate: cur.winRate, ev: cur.ev, t: cur.t, evH1: cur.evH1, evH2: cur.evH2 };
  // Meilleur couple STABLE (deux moitiés > 0, n ≥ 100) ; le résumé rappelle le seuil de Bonferroni.
  let best: JournalSummary['best'] = null;
  for (const e of edges) {
    for (const q of probs) {
      const l = replayLine(decisionRounds, e, q, params);
      if (solid(l, 0) && (!best || (l.ev ?? -1) > (best.ev ?? -1))) best = { minEdge: e, minProb: q, tested: edges.length * probs.length, n: l.n, winRate: l.winRate, ev: l.ev, t: l.t, evH1: l.evH1, evH2: l.evH2 };
    }
  }
  S.best = best;
  say(`\n   ⚠️ ${edges.length * probs.length} couples testés : un t < ${String(T_BEST).replace('.', ',')} sur le meilleur couple peut être du hasard (Bonferroni).`);
  say('   Ne retenir un réglage que s\'il est positif sur LES DEUX moitiés.');

  // 3b. Où est l'avantage ? (réglage actuel, par coin et par temps restant)
  const fmtRow = (label: string, rs: typeof decisionRounds) => {
    const r = replay(rs, cfg.minEdge, cfg.minProb, params);
    const [a, b] = halves(rs);
    const ra = replay(a, cfg.minEdge, cfg.minProb, params);
    const rb = replay(b, cfg.minEdge, cfg.minProb, params);
    say(`   ${label.padEnd(12)} n=${String(r.n).padStart(5)}  WR ${pct(r.winRate).padStart(7)}  EV/$ ${num(r.evPerDollar, 4).padStart(8)}  t ${num(r.tStat, 1).padStart(5)}  | moitiés ${num(ra.evPerDollar, 3)} / ${num(rb.evPerDollar, 3)}`);
  };
  say(`\n3b) Réglage actuel (edge ${cfg.minEdge}, pmin ${cfg.minProb}) par coin`);
  for (const coin of [...new Set(resolved.map(r => r.coin))].sort()) {
    fmtRow(coin, decisionRounds.filter(l => l[0].coin === coin));
  }
  say('    … et par temps restant au moment de l\'évaluation (s)');
  for (const [lo, hi] of [[60, 90], [90, 150], [150, 210], [210, 270]]) {
    const rs = decisionRounds.map(l => l.filter(r => r.tau >= lo && r.tau < hi)).filter(l => l.length);
    fmtRow(`τ ${lo}-${hi}`, rs);
  }
  // Marge de bruit (prix à battre estimé) : la seule façon de la régler est de la rejouer sur
  // les vraies données. Si k = 0 gagne sur LES DEUX moitiés, la marge est trop prudente.
  say(`    … et selon la marge de bruit FV_NOISE_EDGE_K (actuelle : ${cfg.noiseEdgeK})`);
  if (!resolved.some(r => r.ns)) say('      (journal sans bruit enregistré : marge non rejouable)');
  else {
    for (const k of [0, 0.75, 1.5, 2.5]) {
      const p2 = { ...params, noiseK: k };
      const r = replay(decisionRounds, cfg.minEdge, cfg.minProb, p2);
      const [a, b] = halves(decisionRounds);
      const ra = replay(a, cfg.minEdge, cfg.minProb, p2);
      const rb = replay(b, cfg.minEdge, cfg.minProb, p2);
      say(`   ${`k = ${k}`.padEnd(12)} n=${String(r.n).padStart(5)}  WR ${pct(r.winRate).padStart(7)}  EV/$ ${num(r.evPerDollar, 4).padStart(8)}  t ${num(r.tStat, 1).padStart(5)}  | moitiés ${num(ra.evPerDollar, 3)} / ${num(rb.evPerDollar, 3)}${k === cfg.noiseEdgeK ? '  ← réglage actuel' : ''}`);
    }
  }

  // 3c. Carnet : coût d'un aller-retour et profondeur
  const books = bookStats(records.filter(r => !r.lt)); // carnets lus à τ < 60 s (près du règlement) exclus
  if (books.length) {
    say('\n3c) Carnet du token Up (écart achat/vente, profondeur au meilleur ask)');
    for (const b of books) {
      say(`   ${b.coin.padEnd(5)} n=${String(b.n).padStart(6)}  écart médian ${(b.medianSpread * 100).toFixed(1)} ct`
        + `  | taille médiane ${b.medianAskSize === null ? '—' : b.medianAskSize.toFixed(0)} parts`
        + `  | carnets miroirs ${pct(b.mirrorShare, 0)}`);
    }
    say('   Un écart large rend la revente coûteuse ; une taille faible limite la mise réellement exécutable.');
  }

  // 4. Trades réellement pris
  const buys = resolved.filter(r => r.act === 'buy' && r.side);
  if (buys.length) {
    const wins = buys.filter(r => (r.side === 'UP') === r.upWon).length;
    say(`\n4) Paris réellement pris : ${buys.length}, gagnés ${wins} (${pct(wins / buys.length)})`);
    S.buys = { n: buys.length, wins };
  }

  const out = arg('json');
  if (out) {
    writeFileSync(out, JSON.stringify({ brierModel: bm, brierMarket: bk, blend, calibration: calibration(evals, rawModelProb), grid: thresholdGrid(decisionRounds, edges, probs, params) }, null, 2));
    say(`\nJSON écrit : ${out}`);
  }
  if (SUMMARY) console.log(renderJournalSummary(S));
}

main().catch(err => { console.error(err); process.exit(1); });
