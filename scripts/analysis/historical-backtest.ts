/**
 * Backtest HISTORIQUE : le modèle aurait-il battu les prix Polymarket sur les derniers jours ?
 *
 *   npx tsx scripts/analysis/historical-backtest.ts [--days 2] [--coins BTC,ETH] [--json out.json] [--summary]
 *
 * `--summary` : seulement le résumé Telegram (HTML) avec le verdict (commande /backtest du bot).
 *
 * Réseau requis (Gamma, CLOB prices-history, Binance). Les métadonnées et historiques sont
 * mis en cache dans ~/.polymarket/backtest-cache/ : relancer ne refait pas les requêtes.
 *
 * ⚠️ Limites : l'historique Polymarket est un prix par minute (pas un carnet) ; les asks
 * sont reconstitués (prix + demi-écart) → la section « seuils » est INDICATIVE. La section
 * « modèle vs marché » (Brier) est la plus fiable : c'est elle qui dit s'il y a un edge.
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { entryMinTauSec, fairValueConfigFromEnv } from '../../src/services/fair-value.js';
import { coinsFromEnv } from '../../src/strategy/fair-value-runner.js';
import type { DiscoveryCoin } from '../../src/services/round-discovery.js';
import {
  compareBrier, compareVariantToLive, evaluateRound, toResolvedRecords, VOL_VARIANTS, LIVE_VARIANT, type BacktestPoint, type PricePoint,
} from '../../src/analysis/historical-backtest.js';
import { fetchKlinesRange, fetchPriceHistory, fetchRoundsMeta, mapLimit, type RoundMeta } from '../../src/analysis/historical-data.js';
import {
  applyBlend, blendVerdict, zScaleAdvice, zScaleConflictsWithBlend, byRound, calibration, describeBlend, fitBlend, fitZScale, halves, replay, thresholdGrid,
} from '../../src/analysis/fv-analysis.js';
import { renderBacktestSummary, type BacktestSummary } from '../../src/analysis/report-summary.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAYS = Math.min(30, Math.max(0.1, Number(arg('days') ?? '2') || 2));
const COINS = coinsFromEnv(arg('coins') ?? process.env.FV_COINS) as DiscoveryCoin[];
const cfg = fairValueConfigFromEnv(process.env);
const CACHE_DIR = join(process.env.HOME || homedir(), '.polymarket', 'backtest-cache');
const META = join(CACHE_DIR, 'meta.json');
const HIST = join(CACHE_DIR, 'history.json');
const SYMBOL: Record<string, string> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT' };

const readJson = <T>(p: string, d: T): T => {
  try { return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : d; } catch { return d; }
};
const pct = (x: number | null, d = 1) => (x === null ? '—' : `${(x * 100).toFixed(d)} %`);
/** Résumé Telegram seulement (commande /backtest). */
const SUMMARY = process.argv.includes('--summary');
const say = (s = ''): void => { if (!SUMMARY) console.log(s); };
const num = (x: number | null, d = 4) => (x === null ? '—' : x.toFixed(d));

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const lastSlot = Math.floor((nowSec - 600) / 300) * 300; // rounds terminés depuis ≥ 5 min
  const firstSlot = lastSlot - Math.floor((DAYS * 86_400) / 300) * 300;
  const slots: number[] = [];
  for (let s = firstSlot; s <= lastSlot; s += 300) slots.push(s);
  const wanted = COINS.flatMap(coin => slots.map(slot => ({ slug: `${coin.toLowerCase()}-updown-5m-${slot}`, coin, slot })));
  console.error(`Période : ${new Date(firstSlot * 1000).toISOString()} → ${new Date((lastSlot + 300) * 1000).toISOString()} · ${COINS.join(', ')} · ${wanted.length} rounds`);

  // 1. Métadonnées + issues (cache : seuls les rounds RÉGLÉS sont gardés)
  const meta = readJson<Record<string, RoundMeta>>(META, {});
  const missing = wanted.filter(w => !meta[w.slug]);
  console.error(`Rounds à interroger sur Gamma : ${missing.length} (cache : ${wanted.length - missing.length})`);
  const chunks: typeof missing[] = [];
  for (let i = 0; i < missing.length; i += 20) chunks.push(missing.slice(i, i + 20));
  let done = 0;
  await mapLimit(chunks, 3, async chunk => {
    const got = await fetchRoundsMeta(chunk);
    for (const [slug, m] of got) if (m.upWon !== null) meta[slug] = m;
    done += chunk.length;
    if (done % 500 < 20) console.error(`  Gamma : ${done}/${missing.length}`);
  });
  writeFileSync(META, JSON.stringify(meta));
  const resolved = wanted.filter(w => meta[w.slug]);
  console.error(`Rounds réglés utilisables : ${resolved.length}`);
  if (!resolved.length) { console.error('Aucun round réglé : vérifier l\'accès à gamma-api.polymarket.com.'); process.exit(1); }

  // 2. Historique de prix du token Up (cache)
  // null = l'API a répondu SANS historique (ne pas redemander) ; [] = ancien cache d'un
  // échec réseau (à redemander une fois).
  const hist = readJson<Record<string, PricePoint[] | null>>(HIST, {});
  // Absent, ou vide (anciennes versions mettaient en cache les échecs réseau sous forme de [])
  const needHist = resolved.filter(w => hist[w.slug] !== null && !hist[w.slug]?.length);
  console.error(`Historiques de prix à télécharger : ${needHist.length}`);
  let shownRaw = false;
  let n = 0;
  let failedHist = 0;
  await mapLimit(needHist, 4, async w => {
    let answered = false;
    const pts = await fetchPriceHistory(meta[w.slug].upTokenId, w.slot - 120, w.slot + 300, {
      onRaw: raw => {
        answered = true;
        if (shownRaw) return;
        shownRaw = true;
        console.error(`  Exemple de réponse brute prices-history (${w.slug}) : ${JSON.stringify(raw).slice(0, 300)}`);
      },
    });
    // Échec réseau (aucune réponse) : NE PAS mettre en cache, sinon le round est perdu pour
    // toujours (avant : `[]` en cache, jamais re-téléchargé).
    if (answered) hist[w.slug] = pts.length ? pts : null;
    else failedHist++;
    if (++n % 500 === 0) { console.error(`  prix : ${n}/${needHist.length}`); writeFileSync(HIST, JSON.stringify(hist)); }
  });
  writeFileSync(HIST, JSON.stringify(hist));
  if (failedHist) console.error(`  ⚠️ ${failedHist} historiques non obtenus (réseau) : relancer le script pour les récupérer.`);

  // 3. Bougies Binance + évaluation
  const points: BacktestPoint[] = [];
  for (const coin of COINS) {
    const candles = await fetchKlinesRange(SYMBOL[coin], (firstSlot - 3900) * 1000, (lastSlot + 300) * 1000);
    console.error(`  ${coin} : ${candles.length} bougies 1 min`);
    for (const w of resolved.filter(r => r.coin === coin)) {
      const lo = (w.slot - 3900) * 1000;
      const hi = (w.slot + 300) * 1000;
      const window = candles.filter(c => c.openTimeMs >= lo && c.openTimeMs < hi);
      points.push(...evaluateRound({ slug: w.slug, coin, slotSec: w.slot, upWon: meta[w.slug].upWon as boolean }, window, hist[w.slug] ?? [], cfg));
    }
  }
  const nRounds = new Set(points.map(p => p.slug)).size;
  say(`\n=== Backtest historique : ${nRounds} rounds, ${points.length} points (τ = 240/180/120/60 s) ===\n`);
  const lags = points.map(p => p.lagSec ?? 0).sort((a, b) => a - b);
  if (lags.length) {
    say(`Alignement : le modèle est évalué à l'heure de chaque prix marché, avec la dernière bougie TERMINÉE`
      + ` (spot en retard de ${lags[Math.floor(lags.length / 2)]} s en médiane, ${lags[lags.length - 1]} s au plus) :`
      + ' tout désavantage est pour le modèle.\n');
  }
  if (!points.length) {
    console.error('Aucun point évaluable (historique de prix vide ?). Voir l\'exemple de réponse brute ci-dessus.');
    process.exit(1);
  }

  // A. Modèle vs marché
  say('1) Le modèle prédit-il mieux que les prix Polymarket ? (Brier, plus bas = meilleur ; t < −2 = modèle meilleur)');
  const line = (label: string, c: ReturnType<typeof compareBrier>) =>
    say(`   ${label.padEnd(16)} modèle ${num(c.brierModel)} | marché ${num(c.brierMarket)} | t ${num(c.tDiff, 1)} (${c.rounds} rounds)`);
  line('toutes τ', compareBrier(points));
  for (const tau of [240, 180, 120, 60]) line(`τ = ${tau} s`, compareBrier(points.filter(p => p.tau === tau)));
  for (const coin of COINS) line(coin, compareBrier(points.filter(p => p.coin === coin)));
  const all = compareBrier(points);
  const B: BacktestSummary = {
    days: DAYS, rounds: nRounds,
    all: { rounds: all.rounds, brierModel: all.brierModel, brierMarket: all.brierMarket, t: all.tDiff },
    byTau: [240, 180, 120, 60].map(tau => { const c = compareBrier(points.filter(p => p.tau === tau)); return { tau, rounds: c.rounds, t: c.tDiff }; }),
    current: null, betterVol: null, zScale: null,
    medianLagSec: lags.length ? lags[Math.floor(lags.length / 2)] : null,
  };
  say('   ⚠️ Si le prix historique est un DERNIER PRIX ÉCHANGÉ (et non le milieu du carnet), il peut dater');
  say('   de plusieurs dizaines de secondes sur ces marchés peu actifs : le marché paraît alors moins bon');
  say('   qu\'il ne l\'est et ce test SURESTIME l\'avantage. Confirmer avec le journal en direct (vrais asks).');
  say(all.tDiff !== null && all.tDiff <= -2
    ? '   → le modèle est SIGNIFICATIVEMENT meilleur que le marché : un edge est possible.'
    : all.tDiff !== null && all.tDiff >= 2
      ? '   → le marché prédit significativement mieux : PAS d\'edge, ne pas trader cette stratégie.'
      : '   → pas de différence significative : pas d\'edge démontré.');

  // B. Estimateurs de volatilité
  say('\n2) Estimateur de volatilité (Brier du modèle, plus bas = meilleur ; t apparié vs celui du bot, t ≤ −2 = meilleur)');
  for (const name of Object.keys(VOL_VARIANTS)) {
    if (name === LIVE_VARIANT) {
      say(`   ${name.padEnd(12)} ${num(compareBrier(points, name).brierModel)}   ← utilisé par le bot (FV_VOL_ESTIMATOR=cc)`);
      continue;
    }
    const v = compareVariantToLive(points, name);
    say(`   ${name.padEnd(12)} ${num(v.brierVariant)} vs ${num(v.brierLive)}  t ${num(v.t, 1)} (${v.rounds} rounds)`
      + (name === 'parkinson' || name === 'mélange' ? `   ← FV_VOL_ESTIMATOR=${name === 'parkinson' ? 'parkinson' : 'blend'}` : ''));
  }
  const best = ['parkinson', 'mélange'].map(n => ({ n, ...compareVariantToLive(points, n) })).filter(v => v.t !== null && v.t <= -2).sort((a, b) => (a.t as number) - (b.t as number))[0];
  B.betterVol = best ? best.n : null;
  say(best
    ? `   → ${best.n} prédit significativement mieux sur l'historique : à confirmer en direct (fv-report, section 1c) avant FV_VOL_ESTIMATOR=${best.n === 'parkinson' ? 'parkinson' : 'blend'}.`
    : '   → aucun estimateur ne bat significativement celui du bot : garder FV_VOL_ESTIMATOR=cc.');

  // C. Calibration
  const recs = toResolvedRecords(points, 0.005, cfg.zScale, cfg);
  say('\n3) Calibration (modèle | marché)');
  const calM = calibration(recs, r => r.pUp);
  const calK = calibration(points.map(p => ({ ...recs[0], pUp: p.pMarket, upWon: p.upWon })), r => r.pUp);
  for (let i = 0; i < 10; i++) {
    const m = calM.find(b => Math.abs(b.lo - i / 10) < 1e-9);
    const k = calK.find(b => Math.abs(b.lo - i / 10) < 1e-9);
    if (!m && !k) continue;
    say(`   ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}  modèle ${pct(m?.meanP ?? null)} → ${pct(m?.freqUp ?? null)} (n=${m?.n ?? 0})   marché ${pct(k?.meanP ?? null)} → ${pct(k?.freqUp ?? null)} (n=${k?.n ?? 0})`);
  }
  const rounds = byRound(recs);
  const fit = fitZScale(rounds, 150, cfg.tails);
  const blend = fitBlend(rounds, { minTau: entryMinTauSec(cfg), maxTau: cfg.maxTauSec });
  if (fit) B.zScale = { m: fit.m, lo: fit.lo, hi: fit.hi, current: cfg.zScale };
  if (fit) {
    say(`   Calibration à un paramètre : FV_Z_SCALE optimal ${fit.m} (IC95 ${fit.lo}–${fit.hi})`);
    say(`   ${zScaleAdvice(fit, cfg.zScale, zScaleConflictsWithBlend(blendVerdict(blend, cfg), cfg))}`);
  }

  // C bis. Mélange modèle + marché
  say('\n3b) Mélange modèle + marché (les prix contiennent-ils une information que le modèle ignore ?)');
  for (const l of describeBlend(blend, cfg)) say(l);
  say('   ⚠️ Avec un dernier prix échangé périmé, le marché paraît moins informatif : le poids estimé du');
  say('   marché est alors SOUS-évalué. Confirmer sur le journal en direct (fv-report) avant de régler.');

  // D. Seuils (indicatif) — avec le mélange configuré, comme le bot
  const params = { feeRate: cfg.takerFeeRate, minAsk: cfg.minAsk, maxAsk: cfg.maxAsk, minTau: entryMinTauSec(cfg), maxTau: cfg.maxTauSec, noiseK: cfg.noiseEdgeK };
  const decisionRounds = applyBlend(rounds, cfg.blendModel, cfg.blendMarket);
  const [h1, h2] = halves(decisionRounds);
  say('\n4) Seuils rejoués sur asks RECONSTITUÉS (prix + 0,5 ct, frais inclus) — INDICATIF');
  say('   edge  pmin      n      WR     EV/$      t  | moitié 1   moitié 2');
  for (const r of thresholdGrid(decisionRounds, [0.02, 0.04, 0.06, 0.08, 0.1], [0.5, 0.6, 0.7], params)) {
    if (r.n < 10) continue;
    const a = replay(h1, r.minEdge, r.minProb, params);
    const b = replay(h2, r.minEdge, r.minProb, params);
    const cur = r.minEdge === cfg.minEdge && r.minProb === cfg.minProb ? '  ← réglage actuel' : '';
    say(`   ${r.minEdge.toFixed(2)}  ${r.minProb.toFixed(2)} ${String(r.n).padStart(6)}  ${pct(r.winRate).padStart(7)} ${num(r.evPerDollar).padStart(8)} ${num(r.tStat, 1).padStart(6)}  | ${num(a.evPerDollar, 3).padStart(8)}  ${num(b.evPerDollar, 3).padStart(8)}${cur}`);
  }
  {
    const r = replay(decisionRounds, cfg.minEdge, cfg.minProb, params);
    B.current = {
      minEdge: cfg.minEdge, minProb: cfg.minProb, n: r.n, winRate: r.winRate, ev: r.evPerDollar, t: r.tStat,
      evH1: replay(h1, cfg.minEdge, cfg.minProb, params).evPerDollar, evH2: replay(h2, cfg.minEdge, cfg.minProb, params).evPerDollar,
    };
  }
  say('\n   ⚠️ Les asks réels peuvent être plus chers et peu profonds : un EV positif ici est une condition');
  say('   nécessaire, pas suffisante. La section 1 prime : sans modèle meilleur que le marché, pas d\'edge.');

  const out = arg('json');
  if (out) {
    writeFileSync(out, JSON.stringify({ comparison: all, byTau: [240, 180, 120, 60].map(t => ({ tau: t, ...compareBrier(points.filter(p => p.tau === t)) })), fit, blend }, null, 2));
    say(`\nJSON écrit : ${out}`);
  }
  if (SUMMARY) console.log(renderBacktestSummary(B));
}

main().catch(err => { console.error(err); process.exit(1); });
