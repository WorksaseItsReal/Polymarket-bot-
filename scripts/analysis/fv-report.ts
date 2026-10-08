/**
 * Rapport d'analyse du journal des décisions (stratégie juste valeur).
 *
 *   npx tsx scripts/analysis/fv-report.ts [--dir ~/.polymarket/journal] [--days 7] [--json out.json]
 *
 * 1. lit les évaluations journalisées (decisions-*.jsonl) ;
 * 2. règle chaque round via Gamma `events?slug=` (cache ~/.polymarket/outcomes-cache.json) ;
 * 3. répond, dans l'ordre : le modèle bat-il le marché (Brier) ? est-il calibré ?
 *    quels seuils auraient rapporté, et est-ce stable sur les deux moitiés ?
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
import { fairValueConfigFromEnv } from '../../src/services/fair-value.js';
import {
  applyBlend, blendVerdict, zScaleConflictsWithBlend, bookStats, brier, byRound, calibration, compareModelBook, describeBlend, fitBlend,
  fitZScale, halves, marketProbUp, normalizeZScale, rawModelProb, replay, zScaleAdvice,
  thresholdGrid, type ResolvedRecord,
} from '../../src/analysis/fv-analysis.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const POLY = join(process.env.HOME || homedir(), '.polymarket');
const DIR = arg('dir') ?? join(POLY, 'journal');
const DAYS = Number(arg('days') ?? '30');
const CACHE = join(POLY, 'outcomes-cache.json');
const cfg = fairValueConfigFromEnv(process.env);

const pct = (x: number | null, d = 1) => (x === null ? '—' : `${(x * 100).toFixed(d)} %`);
const num = (x: number | null, d = 3) => (x === null ? '—' : x.toFixed(d));

/** Chaînes partagées : chaque ligne relue crée sinon sa propre copie du slug et du coin. */
const strings = new Map<string, string>();
const intern = (x: string) => strings.get(x) ?? (strings.set(x, x), x);

/** Seuls les champs utiles à l'analyse : un journal de 30 jours ≈ 1 million de lignes. */
function slim(r: DecisionRecord): DecisionRecord {
  return {
    t: r.t, slug: intern(r.slug), coin: intern(r.coin), tau: r.tau, spot: 0, strike: 0, sig: 0, pUp: r.pUp, pRaw: r.pRaw, zs: r.zs,
    upAsk: r.upAsk, downAsk: r.downAsk, upAskSz: r.upAskSz, downAskSz: null, upBid: r.upBid, src: '', act: r.act === 'buy' ? 'buy' : 'hold',
    ...(r.side ? { side: r.side } : {}),
  };
}

function readJournal(): DecisionRecord[] {
  if (!existsSync(DIR)) {
    console.error(`Aucun journal dans ${DIR} (le bot écrit decisions-*.jsonl quand FV_JOURNAL≠false).`);
    process.exit(1);
  }
  const since = Date.now() - DAYS * 86_400_000;
  const out: DecisionRecord[] = [];
  let bad = 0;
  for (const f of readdirSync(DIR).filter(f => JOURNAL_FILE_RE.test(f)).sort()) {
    // jours révolus compressés (.jsonl.gz) par le bot
    const raw = readFileSync(join(DIR, f));
    const text = f.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as DecisionRecord;
        if (typeof r.slug === 'string' && Number.isFinite(r.t) && r.t >= since) out.push(slim(r));
      } catch { bad++; }
    }
  }
  if (bad) console.error(`(${bad} lignes illisibles ignorées)`);
  return out;
}

async function resolveAll(slugs: string[]): Promise<Map<string, boolean>> {
  const cache: Record<string, boolean> = existsSync(CACHE) ? (() => { try { return JSON.parse(readFileSync(CACHE, 'utf8')); } catch { return {}; } })() : {};
  const todo = slugs.filter(s => !(s in cache) && Number(s.split('-').pop()) * 1000 + 360_000 < Date.now());
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const slug = todo.shift() as string;
      const o = await fetchRoundOutcome(slug);
      if (o.resolved) cache[slug] = o.upWon;
      if (++done % 50 === 0) process.stderr.write(`  rounds réglés : ${done}\n`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache));
  return new Map(Object.entries(cache));
}

async function main() {
  const records = readJournal();
  const outcomes = await resolveAll([...new Set(records.map(r => r.slug))]);
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
  const evals = rounds.flat();
  console.log(`\n=== Journal : ${records.length} évaluations, ${new Set(records.map(r => r.slug)).size} rounds, ${rounds.length} rounds réglés ===\n`);
  if (!rounds.length) return;

  // 1. Modèle vs marché : appariée (mêmes évaluations), chaque round pesant 1, modèle SEUL
  // (avant mélange), t groupé par créneau (les 5 cryptos d'un round sont corrélées).
  const cmp = compareModelBook(rounds, { minTau: cfg.minTauSec, maxTau: cfg.maxTauSec });
  const bm = { n: cmp.rounds, score: cmp.brierModel };
  const bk = { n: cmp.rounds, score: cmp.brierMarket };
  console.log('1) Le modèle prédit-il mieux que le carnet ? (Brier, plus bas = meilleur ; t ≤ −2 = modèle meilleur)');
  console.log(`   par round (fenêtre d'entrée)   : modèle ${num(cmp.brierModel, 4)} | carnet ${num(cmp.brierMarket, 4)}`
    + ` | t ${num(cmp.t, 1)} (n=${cmp.rounds} rounds)`);
  const am = brier(evals, rawModelProb);
  const ak = brier(evals, marketProbUp);
  console.log(`   toutes les évaluations         : modèle ${num(am.score, 4)} | carnet ${num(ak.score, 4)} (n=${am.n}, corrélées au sein d'un round)`);
  if (cmp.t !== null) {
    console.log(cmp.t <= -2
      ? '   → le modèle bat SIGNIFICATIVEMENT le carnet : un edge est possible (à confirmer par les seuils sur les deux moitiés).'
      : cmp.t >= 2
        ? '   → le carnet prédit significativement mieux : PAS d\'edge, quel que soit le seuil.'
        : '   → pas de différence significative : aucun edge démontré à ce stade.');
  }

  // 1b. Mélange modèle + carnet
  console.log('\n1b) Mélange modèle + carnet (le carnet contient-il une information que le modèle ignore ?)');
  const params = { feeRate: cfg.takerFeeRate, minAsk: cfg.minAsk, maxAsk: cfg.maxAsk, minTau: cfg.minTauSec, maxTau: cfg.maxTauSec };
  const blend = fitBlend(rounds, { minTau: cfg.minTauSec, maxTau: cfg.maxTauSec });
  for (const line of describeBlend(blend, cfg)) console.log(line);
  if (blend?.oos) {
    const h2 = halves(rounds)[1];
    const raw = replay(applyBlend(h2, 1, 0), cfg.minEdge, cfg.minProb, params);
    const mixed = replay(applyBlend(h2, blend.oos.a, blend.oos.b), cfg.minEdge, cfg.minProb, params);
    console.log(`     seuils actuels sur la 2e moitié : modèle seul EV/$ ${num(raw.evPerDollar, 4)} (n=${raw.n})`
      + ` | mélange EV/$ ${num(mixed.evPerDollar, 4)} (n=${mixed.n})`);
  }

  // 2. Calibration
  console.log('\n2) Calibration du modèle seul (toutes évaluations)');
  console.log('   tranche     n      p moyen   Up réel');
  for (const b of calibration(evals, rawModelProb)) {
    console.log(`   ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(6)}   ${pct(b.meanP)}   ${pct(b.freqUp)}`);
  }

  // 2b. Réglage de calibration suggéré
  const fit = fitZScale(rounds, 150, cfg.tails);
  if (fit) {
    console.log(`\n2b) Calibration (un paramètre, ${fit.n} rounds) : FV_Z_SCALE optimal ${fit.m} (IC95 ${fit.lo}–${fit.hi})`);
    console.log(`   ${zScaleAdvice(fit, cfg.zScale, zScaleConflictsWithBlend(blendVerdict(blend, cfg), cfg))}`);
  }

  // 3. Seuils (probabilité utilisée par le bot, mélange compris s'il est configuré)
  const edges = [0, 0.02, 0.04, 0.06, 0.08, 0.1];
  const probs = [0.5, 0.55, 0.6, 0.65, 0.7, 0.8];
  const [h1, h2] = halves(decisionRounds);
  console.log('\n3) Seuils rejoués (1 pari/round au meilleur ask, frais inclus) — EV par 1 $ misé');
  console.log('   edge  pmin     n     WR      EV/$     t   | moitié 1 EV   moitié 2 EV');
  for (const r of thresholdGrid(decisionRounds, edges, probs, params)) {
    if (r.n < 10) continue;
    const a = replay(h1, r.minEdge, r.minProb, params);
    const b = replay(h2, r.minEdge, r.minProb, params);
    const cur = r.minEdge === cfg.minEdge && r.minProb === cfg.minProb ? '  ← réglage actuel' : '';
    console.log(`   ${r.minEdge.toFixed(2)}  ${r.minProb.toFixed(2)} ${String(r.n).padStart(6)}  ${pct(r.winRate).padStart(7)} ${num(r.evPerDollar, 4).padStart(8)} ${num(r.tStat, 1).padStart(5)}  |  ${num(a.evPerDollar, 4).padStart(8)} (n=${a.n})  ${num(b.evPerDollar, 4).padStart(8)} (n=${b.n})${cur}`);
  }
  console.log('\n   ⚠️ 36 couples testés : un t < 2,9 sur le meilleur couple peut être du hasard (Bonferroni).');
  console.log('   Ne retenir un réglage que s\'il est positif sur LES DEUX moitiés.');

  // 3b. Où est l'avantage ? (réglage actuel, par coin et par temps restant)
  const fmtRow = (label: string, rs: typeof decisionRounds) => {
    const r = replay(rs, cfg.minEdge, cfg.minProb, params);
    const [a, b] = halves(rs);
    const ra = replay(a, cfg.minEdge, cfg.minProb, params);
    const rb = replay(b, cfg.minEdge, cfg.minProb, params);
    console.log(`   ${label.padEnd(12)} n=${String(r.n).padStart(5)}  WR ${pct(r.winRate).padStart(7)}  EV/$ ${num(r.evPerDollar, 4).padStart(8)}  t ${num(r.tStat, 1).padStart(5)}  | moitiés ${num(ra.evPerDollar, 3)} / ${num(rb.evPerDollar, 3)}`);
  };
  console.log(`\n3b) Réglage actuel (edge ${cfg.minEdge}, pmin ${cfg.minProb}) par coin`);
  for (const coin of [...new Set(resolved.map(r => r.coin))].sort()) {
    fmtRow(coin, decisionRounds.filter(l => l[0].coin === coin));
  }
  console.log('    … et par temps restant au moment de l\'évaluation (s)');
  for (const [lo, hi] of [[45, 90], [90, 150], [150, 210], [210, 270]]) {
    const rs = decisionRounds.map(l => l.filter(r => r.tau >= lo && r.tau < hi)).filter(l => l.length);
    fmtRow(`τ ${lo}-${hi}`, rs);
  }

  // 3c. Carnet : coût d'un aller-retour et profondeur
  const books = bookStats(records);
  if (books.length) {
    console.log('\n3c) Carnet du token Up (écart achat/vente, profondeur au meilleur ask)');
    for (const b of books) {
      console.log(`   ${b.coin.padEnd(5)} n=${String(b.n).padStart(6)}  écart médian ${(b.medianSpread * 100).toFixed(1)} ct`
        + `  | taille médiane ${b.medianAskSize === null ? '—' : b.medianAskSize.toFixed(0)} parts`
        + `  | carnets miroirs ${pct(b.mirrorShare, 0)}`);
    }
    console.log('   Un écart large rend la revente coûteuse ; une taille faible limite la mise réellement exécutable.');
  }

  // 4. Trades réellement pris
  const buys = resolved.filter(r => r.act === 'buy' && r.side);
  if (buys.length) {
    const wins = buys.filter(r => (r.side === 'UP') === r.upWon).length;
    console.log(`\n4) Paris réellement pris : ${buys.length}, gagnés ${wins} (${pct(wins / buys.length)})`);
  }

  const out = arg('json');
  if (out) {
    writeFileSync(out, JSON.stringify({ brierModel: bm, brierMarket: bk, blend, calibration: calibration(evals, rawModelProb), grid: thresholdGrid(decisionRounds, edges, probs, params) }, null, 2));
    console.log(`\nJSON écrit : ${out}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
