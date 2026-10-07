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
import type { DecisionRecord } from '../../src/services/decision-journal.js';
import { fetchRoundOutcome } from '../../src/services/paper-ledger.js';
import { fairValueConfigFromEnv } from '../../src/services/fair-value.js';
import {
  brier, byRound, calibration, fitZScale, halves, marketProbUp, replay, thresholdGrid, type ResolvedRecord,
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

function readJournal(): DecisionRecord[] {
  if (!existsSync(DIR)) {
    console.error(`Aucun journal dans ${DIR} (le bot écrit decisions-*.jsonl quand FV_JOURNAL≠false).`);
    process.exit(1);
  }
  const since = Date.now() - DAYS * 86_400_000;
  const out: DecisionRecord[] = [];
  let bad = 0;
  for (const f of readdirSync(DIR).filter(f => /^decisions-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as DecisionRecord;
        if (typeof r.slug === 'string' && Number.isFinite(r.t) && r.t >= since) out.push(r);
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
  const resolved: ResolvedRecord[] = records
    .filter(r => outcomes.has(r.slug))
    .map(r => ({ ...r, upWon: outcomes.get(r.slug) as boolean }));
  const rounds = byRound(resolved);
  console.log(`\n=== Journal : ${records.length} évaluations, ${new Set(records.map(r => r.slug)).size} rounds, ${rounds.length} rounds réglés ===\n`);
  if (!rounds.length) return;

  // 1. Modèle vs marché (une évaluation par round : la première, pour ne pas sur-pondérer)
  const first = rounds.map(l => l[0]);
  const bm = brier(first, r => r.pUp);
  const bk = brier(first, marketProbUp);
  console.log('1) Le modèle prédit-il mieux que le carnet ? (Brier, plus bas = meilleur)');
  console.log(`   1re évaluation de chaque round : modèle ${num(bm.score, 4)} | carnet ${num(bk.score, 4)} (n=${bm.n} rounds)`);
  const am = brier(resolved, r => r.pUp);
  const ak = brier(resolved, marketProbUp);
  console.log(`   toutes les évaluations         : modèle ${num(am.score, 4)} | carnet ${num(ak.score, 4)} (n=${am.n}, corrélées au sein d'un round)`);
  if (bm.score !== null && bk.score !== null) {
    console.log(bm.score < bk.score
      ? '   → le modèle bat le carnet sur cet échantillon : un edge est POSSIBLE.'
      : '   → le carnet prédit au moins aussi bien : PAS d\'edge exploitable, quel que soit le seuil.');
  }

  // 2. Calibration
  console.log('\n2) Calibration du modèle (toutes évaluations)');
  console.log('   tranche     n      p moyen   Up réel');
  for (const b of calibration(resolved, r => r.pUp)) {
    console.log(`   ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${String(b.n).padStart(6)}   ${pct(b.meanP)}   ${pct(b.freqUp)}`);
  }

  // 2b. Réglage de calibration suggéré
  const fit = fitZScale(rounds);
  if (fit) {
    const suggested = Math.round(cfg.zScale * fit.m * 100) / 100;
    const ok = fit.lo <= 1 && fit.hi >= 1;
    console.log(`\n2b) Calibration (un paramètre, ${fit.n} rounds) : multiplicateur optimal ${fit.m} (IC95 ${fit.lo}–${fit.hi})`);
    console.log(ok
      ? `   → compatible avec le réglage actuel (FV_Z_SCALE=${cfg.zScale}) : rien à changer.`
      : `   → le modèle est ${fit.m < 1 ? 'SUR-confiant' : 'SOUS-confiant'} : essayer FV_Z_SCALE=${suggested} (actuel ${cfg.zScale}), puis re-mesurer.`);
  }

  // 3. Seuils
  const params = { feeRate: cfg.takerFeeRate, minAsk: cfg.minAsk, maxAsk: cfg.maxAsk, minTau: cfg.minTauSec, maxTau: cfg.maxTauSec };
  const edges = [0, 0.02, 0.04, 0.06, 0.08, 0.1];
  const probs = [0.5, 0.55, 0.6, 0.65, 0.7, 0.8];
  const [h1, h2] = halves(rounds);
  console.log('\n3) Seuils rejoués (1 pari/round au meilleur ask, frais inclus) — EV par 1 $ misé');
  console.log('   edge  pmin     n     WR      EV/$     t   | moitié 1 EV   moitié 2 EV');
  for (const r of thresholdGrid(rounds, edges, probs, params)) {
    if (r.n < 10) continue;
    const a = replay(h1, r.minEdge, r.minProb, params);
    const b = replay(h2, r.minEdge, r.minProb, params);
    const cur = r.minEdge === cfg.minEdge && r.minProb === cfg.minProb ? '  ← réglage actuel' : '';
    console.log(`   ${r.minEdge.toFixed(2)}  ${r.minProb.toFixed(2)} ${String(r.n).padStart(6)}  ${pct(r.winRate).padStart(7)} ${num(r.evPerDollar, 4).padStart(8)} ${num(r.tStat, 1).padStart(5)}  |  ${num(a.evPerDollar, 4).padStart(8)} (n=${a.n})  ${num(b.evPerDollar, 4).padStart(8)} (n=${b.n})${cur}`);
  }
  console.log('\n   ⚠️ 36 couples testés : un t < 2,9 sur le meilleur couple peut être du hasard (Bonferroni).');
  console.log('   Ne retenir un réglage que s\'il est positif sur LES DEUX moitiés.');

  // 3b. Où est l'avantage ? (réglage actuel, par coin et par temps restant)
  const fmtRow = (label: string, rs: typeof rounds) => {
    const r = replay(rs, cfg.minEdge, cfg.minProb, params);
    const [a, b] = halves(rs);
    const ra = replay(a, cfg.minEdge, cfg.minProb, params);
    const rb = replay(b, cfg.minEdge, cfg.minProb, params);
    console.log(`   ${label.padEnd(12)} n=${String(r.n).padStart(5)}  WR ${pct(r.winRate).padStart(7)}  EV/$ ${num(r.evPerDollar, 4).padStart(8)}  t ${num(r.tStat, 1).padStart(5)}  | moitiés ${num(ra.evPerDollar, 3)} / ${num(rb.evPerDollar, 3)}`);
  };
  console.log(`\n3b) Réglage actuel (edge ${cfg.minEdge}, pmin ${cfg.minProb}) par coin`);
  for (const coin of [...new Set(resolved.map(r => r.coin))].sort()) {
    fmtRow(coin, rounds.filter(l => l[0].coin === coin));
  }
  console.log('    … et par temps restant au moment de l\'évaluation (s)');
  for (const [lo, hi] of [[45, 90], [90, 150], [150, 210], [210, 270]]) {
    const rs = rounds.map(l => l.filter(r => r.tau >= lo && r.tau < hi)).filter(l => l.length);
    fmtRow(`τ ${lo}-${hi}`, rs);
  }

  // 4. Trades réellement pris
  const buys = resolved.filter(r => r.act === 'buy' && r.side);
  if (buys.length) {
    const wins = buys.filter(r => (r.side === 'UP') === r.upWon).length;
    console.log(`\n4) Paris réellement pris : ${buys.length}, gagnés ${wins} (${pct(wins / buys.length)})`);
  }

  const out = arg('json');
  if (out) {
    writeFileSync(out, JSON.stringify({ brierModel: bm, brierMarket: bk, calibration: calibration(resolved, r => r.pUp), grid: thresholdGrid(rounds, edges, probs, params) }, null, 2));
    console.log(`\nJSON écrit : ${out}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
