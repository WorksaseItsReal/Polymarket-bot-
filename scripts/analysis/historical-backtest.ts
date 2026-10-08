/**
 * Backtest HISTORIQUE : le modèle aurait-il battu les prix Polymarket sur les derniers jours ?
 *
 *   npx tsx scripts/analysis/historical-backtest.ts [--days 2] [--coins BTC,ETH] [--json out.json]
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
import { fairValueConfigFromEnv } from '../../src/services/fair-value.js';
import { coinsFromEnv } from '../../src/strategy/fair-value-runner.js';
import type { DiscoveryCoin } from '../../src/services/round-discovery.js';
import {
  compareBrier, evaluateRound, toResolvedRecords, VOL_VARIANTS, LIVE_VARIANT, type BacktestPoint, type PricePoint,
} from '../../src/analysis/historical-backtest.js';
import { fetchKlinesRange, fetchPriceHistory, fetchRoundsMeta, mapLimit, type RoundMeta } from '../../src/analysis/historical-data.js';
import {
  applyBlend, blendVerdict, zScaleConflictsWithBlend, byRound, calibration, describeBlend, fitBlend, fitZScale, halves, replay, thresholdGrid,
} from '../../src/analysis/fv-analysis.js';

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
  const hist = readJson<Record<string, PricePoint[]>>(HIST, {});
  const needHist = resolved.filter(w => !hist[w.slug]);
  console.error(`Historiques de prix à télécharger : ${needHist.length}`);
  let shownRaw = false;
  let n = 0;
  await mapLimit(needHist, 4, async w => {
    const pts = await fetchPriceHistory(meta[w.slug].upTokenId, w.slot - 120, w.slot + 300, {
      onRaw: raw => {
        if (shownRaw) return;
        shownRaw = true;
        console.error(`  Exemple de réponse brute prices-history (${w.slug}) : ${JSON.stringify(raw).slice(0, 300)}`);
      },
    });
    hist[w.slug] = pts;
    if (++n % 500 === 0) { console.error(`  prix : ${n}/${needHist.length}`); writeFileSync(HIST, JSON.stringify(hist)); }
  });
  writeFileSync(HIST, JSON.stringify(hist));

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
  console.log(`\n=== Backtest historique : ${nRounds} rounds, ${points.length} points (τ = 240/180/120/60 s) ===\n`);
  if (!points.length) { console.log('Aucun point évaluable (historique de prix vide ?). Voir l\'exemple de réponse brute ci-dessus.'); return; }

  // A. Modèle vs marché
  console.log('1) Le modèle prédit-il mieux que les prix Polymarket ? (Brier, plus bas = meilleur ; t < −2 = modèle meilleur)');
  const line = (label: string, c: ReturnType<typeof compareBrier>) =>
    console.log(`   ${label.padEnd(16)} modèle ${num(c.brierModel)} | marché ${num(c.brierMarket)} | t ${num(c.tDiff, 1)} (${c.rounds} rounds)`);
  line('toutes τ', compareBrier(points));
  for (const tau of [240, 180, 120, 60]) line(`τ = ${tau} s`, compareBrier(points.filter(p => p.tau === tau)));
  for (const coin of COINS) line(coin, compareBrier(points.filter(p => p.coin === coin)));
  const all = compareBrier(points);
  console.log('   ⚠️ Si le prix historique est un DERNIER PRIX ÉCHANGÉ (et non le milieu du carnet), il peut dater');
  console.log('   de plusieurs dizaines de secondes sur ces marchés peu actifs : le marché paraît alors moins bon');
  console.log('   qu\'il ne l\'est et ce test SURESTIME l\'avantage. Confirmer avec le journal en direct (vrais asks).');
  console.log(all.tDiff !== null && all.tDiff <= -2
    ? '   → le modèle est SIGNIFICATIVEMENT meilleur que le marché : un edge est possible.'
    : all.tDiff !== null && all.tDiff >= 2
      ? '   → le marché prédit significativement mieux : PAS d\'edge, ne pas trader cette stratégie.'
      : '   → pas de différence significative : pas d\'edge démontré.');

  // B. Estimateurs de volatilité
  console.log('\n2) Estimateur de volatilité (Brier du modèle, plus bas = meilleur)');
  for (const name of Object.keys(VOL_VARIANTS)) {
    const c = compareBrier(points, name);
    console.log(`   ${name.padEnd(12)} ${num(c.brierModel)}${name === LIVE_VARIANT ? '   ← utilisé par le bot' : ''}`);
  }

  // C. Calibration
  const recs = toResolvedRecords(points);
  console.log('\n3) Calibration (modèle | marché)');
  const calM = calibration(recs, r => r.pUp);
  const calK = calibration(points.map(p => ({ ...recs[0], pUp: p.pMarket, upWon: p.upWon })), r => r.pUp);
  for (let i = 0; i < 10; i++) {
    const m = calM.find(b => Math.abs(b.lo - i / 10) < 1e-9);
    const k = calK.find(b => Math.abs(b.lo - i / 10) < 1e-9);
    if (!m && !k) continue;
    console.log(`   ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}  modèle ${pct(m?.meanP ?? null)} → ${pct(m?.freqUp ?? null)} (n=${m?.n ?? 0})   marché ${pct(k?.meanP ?? null)} → ${pct(k?.freqUp ?? null)} (n=${k?.n ?? 0})`);
  }
  const rounds = byRound(recs);
  const fit = fitZScale(rounds);
  const blend = fitBlend(rounds, { minTau: cfg.minTauSec, maxTau: cfg.maxTauSec });
  if (fit) {
    console.log(`   Calibration à un paramètre : multiplicateur ${fit.m} (IC95 ${fit.lo}–${fit.hi})`
      + (fit.lo <= 1 && fit.hi >= 1
        ? ' → compatible avec FV_Z_SCALE actuel'
        : zScaleConflictsWithBlend(blendVerdict(blend, cfg), cfg)
          ? ' → déjà corrigée par le mélange (actif ou proposé en 3b) : ré-estimer le mélange, pas FV_Z_SCALE'
          : ` → essayer FV_Z_SCALE=${Math.round(cfg.zScale * fit.m * 100) / 100}`));
  }

  // C bis. Mélange modèle + marché
  console.log('\n3b) Mélange modèle + marché (les prix contiennent-ils une information que le modèle ignore ?)');
  for (const l of describeBlend(blend, cfg)) console.log(l);
  console.log('   ⚠️ Avec un dernier prix échangé périmé, le marché paraît moins informatif : le poids estimé du');
  console.log('   marché est alors SOUS-évalué. Confirmer sur le journal en direct (fv-report) avant de régler.');

  // D. Seuils (indicatif) — avec le mélange configuré, comme le bot
  const params = { feeRate: cfg.takerFeeRate, minAsk: cfg.minAsk, maxAsk: cfg.maxAsk, minTau: cfg.minTauSec, maxTau: cfg.maxTauSec };
  const decisionRounds = applyBlend(rounds, cfg.blendModel, cfg.blendMarket);
  const [h1, h2] = halves(decisionRounds);
  console.log('\n4) Seuils rejoués sur asks RECONSTITUÉS (prix + 0,5 ct, frais inclus) — INDICATIF');
  console.log('   edge  pmin      n      WR     EV/$      t  | moitié 1   moitié 2');
  for (const r of thresholdGrid(decisionRounds, [0.02, 0.04, 0.06, 0.08, 0.1], [0.5, 0.6, 0.7], params)) {
    if (r.n < 10) continue;
    const a = replay(h1, r.minEdge, r.minProb, params);
    const b = replay(h2, r.minEdge, r.minProb, params);
    const cur = r.minEdge === cfg.minEdge && r.minProb === cfg.minProb ? '  ← réglage actuel' : '';
    console.log(`   ${r.minEdge.toFixed(2)}  ${r.minProb.toFixed(2)} ${String(r.n).padStart(6)}  ${pct(r.winRate).padStart(7)} ${num(r.evPerDollar).padStart(8)} ${num(r.tStat, 1).padStart(6)}  | ${num(a.evPerDollar, 3).padStart(8)}  ${num(b.evPerDollar, 3).padStart(8)}${cur}`);
  }
  console.log('\n   ⚠️ Les asks réels peuvent être plus chers et peu profonds : un EV positif ici est une condition');
  console.log('   nécessaire, pas suffisante. La section 1 prime : sans modèle meilleur que le marché, pas d\'edge.');

  const out = arg('json');
  if (out) {
    writeFileSync(out, JSON.stringify({ comparison: all, byTau: [240, 180, 120, 60].map(t => ({ tau: t, ...compareBrier(points.filter(p => p.tau === t)) })), fit, blend }, null, 2));
    console.log(`\nJSON écrit : ${out}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
