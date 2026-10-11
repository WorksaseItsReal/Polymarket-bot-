/**
 * tests/report-summary.test.ts — résumés Telegram des rapports (/rapport, /backtest) et verdicts,
 * et la mesure « prix à battre officiel corrigé vs estimé » (section 0c).
 * Exécution : `npx tsx --test tests/report-summary.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backtestVerdict, journalVerdict, renderBacktestSummary, renderJournalSummary, solid, type BacktestSummary, type JournalSummary,
} from '../src/analysis/report-summary.ts';
import { compareOfficialStrike, correctedOfficialStrike, correctedOfficialStrikes, type ResolvedRecord } from '../src/analysis/fv-analysis.ts';

const base: JournalSummary = {
  days: 3, evaluations: 52_300, lateMeasures: 8100, rounds: 4210,
  model: { rounds: 3980, brierModel: 0.2311, brierMarket: 0.2287, t: 1.2 },
  current: { minEdge: 0.04, minProb: 0.6, n: 182, winRate: 0.61, ev: -0.021, t: -0.6, evH1: -0.03, evH2: -0.01 },
  best: { minEdge: 0.06, minProb: 0.7, tested: 36, n: 120, winRate: 0.7, ev: 0.012, t: 1.1, evH1: 0.008, evH2: 0.015 },
  late: { n: 420, winRate: 0.93, ev: 0.018, t: 2.4, evH1: 0.02, evH2: 0.015, tModel: -3.1, rounds: 900 },
  vol: { rounds: 3900, tPark: -0.4, tBlend: -0.2, current: 'FV_VOL_ESTIMATOR=cc' },
  strike: { rounds: 3980, withPs: 3900, compared: 3800, same: 3800, tOfficial: -2.5, officialRounds: 3700 },
  zScale: { m: 0.92, lo: 0.85, hi: 1, current: 1 },
  buys: { n: 182, wins: 111 },
};

const wellFormed = (html: string) => {
  assert.doesNotMatch(html, /undefined|NaN|null|\[object/, html);
  for (const tag of ['b', 'i', 'pre']) {
    assert.equal((html.match(new RegExp(`<${tag}>`, 'g')) ?? []).length, (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length, `balises <${tag}> équilibrées`);
  }
  assert.doesNotMatch(html.replace(/<\/?(b|i|pre)>/g, ''), /[<>]/, 'aucun autre chevron (HTML Telegram)');
  assert.ok(html.length < 4096, `un seul message Telegram (${html.length} car.)`);
};

test('verdict du journal : trop tôt, carnet meilleur, edge, piste fin de round, rien', () => {
  assert.equal(journalVerdict({ ...base, model: { ...base.model, rounds: 120 } }).level, 'early');
  assert.equal(journalVerdict({ ...base, model: { ...base.model, t: 2.3 } }).level, 'negative');
  const edge = { ...base, model: { ...base.model, t: -2.4 }, current: { ...base.current, ev: 0.03, t: 2.6, evH1: 0.02, evH2: 0.04 } };
  assert.equal(journalVerdict(edge).level, 'edge');
  assert.match(journalVerdict(edge).text, /≥ 2 semaines/);
  assert.equal(journalVerdict(base).level, 'lead', 'fin de round solide, réglage actuel non');
  assert.match(journalVerdict(base).text, /dernière minute/);
  assert.equal(journalVerdict({ ...base, late: null }).level, 'none');
  // une moitié négative ou n < 100 : pas « solide »
  assert.equal(solid({ ...base.late!, evH2: -0.001 }), false);
  assert.equal(solid({ ...base.late!, n: 99 }), false);
  assert.equal(journalVerdict({ ...base, model: { ...base.model, t: -2.4 } }).level, 'lead', 'modèle meilleur mais seuils non rentables');
});

test('résumé du journal : toutes les sections, lisible, un seul message ; vide = message clair', () => {
  const s = renderJournalSummary(base);
  wellFormed(s);
  assert.match(s, /^📊 <b>Rapport edge — 3 derniers jours<\/b>/);
  assert.match(s, /4 210 rounds réglés · 52 300 évaluations \(\+ 8 100 fin de round\)/);
  assert.match(s, /Le modèle bat-il le carnet \?<\/b> pas de différence significative/);
  assert.match(s, /0,2311 vs carnet 0,2287 · t \+1,2/);
  assert.match(s, /182 paris · 61 % gagnés · −2,1 %\/\$ \(t −0,6\) · moitiés −3,0 %\/\$ \/ −1,0 %\/\$/);
  assert.match(s, /Meilleur réglage testé<\/b> \(edge ≥ 6 pt, proba ≥ 70 %\)/);
  assert.match(s, /36 couples testés : ne compte que si t ≥ 2,9/);
  assert.match(s, /Dernière minute<\/b>[^\n]*t −3,1/);
  assert.match(s, /Volatilité<\/b> \(FV_VOL_ESTIMATOR=cc\)[^\n]*garder le réglage/);
  assert.match(s, /Prix à battre officiel<\/b> : lu en direct dans 98 %[^\n]*identique au règlement 100 %[^\n]*t −2,5/);
  assert.match(s, /FV_Z_SCALE optimal 0,92 \(IC95 0,85–1,00\), actuel 1,00 ✓/);
  assert.match(s, /<b>Verdict<\/b> : 🔎/);
  const empty = renderJournalSummary({ ...base, rounds: 0, evaluations: 0, lateMeasures: 0, days: 1 });
  wellFormed(empty);
  assert.match(empty, /dernier jour<\/b>/);
  assert.match(empty, /Aucun round réglé/);
  const sparse = renderJournalSummary({ ...base, best: null, late: null, vol: null, strike: null, zScale: null, buys: null, model: { rounds: 0, brierModel: null, brierMarket: null, t: null }, current: { ...base.current, n: 0, winRate: null, ev: null, t: null, evH1: null, evH2: null } });
  wellFormed(sparse);
  assert.match(sparse, /aucun pari/);
  assert.match(sparse, /Trop tôt/);
});

test('backtest : verdicts et résumé lisible', () => {
  const b: BacktestSummary = {
    days: 2, rounds: 2800, all: { rounds: 2800, brierModel: 0.214, brierMarket: 0.209, t: 2.6 },
    byTau: [{ tau: 240, rounds: 2800, t: 1.1 }, { tau: 60, rounds: 2700, t: 3.0 }],
    current: { minEdge: 0.04, minProb: 0.6, n: 300, winRate: 0.6, ev: -0.05, t: -2.1, evH1: -0.04, evH2: -0.06 },
    betterVol: null, zScale: { m: 0.9, lo: 0.8, hi: 1.02, current: 1 }, medianLagSec: 35,
  };
  assert.equal(backtestVerdict(b).level, 'negative');
  assert.equal(backtestVerdict({ ...b, all: { ...b.all, rounds: 100 } }).level, 'early');
  assert.equal(backtestVerdict({ ...b, all: { ...b.all, t: -2.5 } }).level, 'lead');
  assert.equal(backtestVerdict({ ...b, all: { ...b.all, t: -2.5 }, current: { ...b.current!, ev: 0.02, t: 2.2, evH1: 0.01, evH2: 0.03 } }).level, 'edge');
  assert.equal(backtestVerdict({ ...b, all: { ...b.all, t: 0.3 } }).level, 'none');
  const s = renderBacktestSummary(b);
  wellFormed(s);
  assert.match(s, /^🧪 <b>Backtest historique — 2 jours<\/b>/);
  assert.match(s, /NON, le marché est meilleur/);
  assert.match(s, /240 s t \+1,1 · 60 s t \+3,0/);
  assert.match(s, /en retard de 35 s/);
  wellFormed(renderBacktestSummary({ ...b, days: 0.5, current: null, zScale: null, medianLagSec: null, all: { rounds: 0, brierModel: null, brierMarket: null, t: null }, byTau: [] }));
});

// ---------------------------------------------------------------- 0c : prix à battre officiel

/** Générateur pseudo-aléatoire reproductible (mulberry32) + loi normale (Box-Muller). */
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

/**
 * Rounds simulés à règlement TWAP 60 s, évalués à τ = 120 s : notre strike estimé a une erreur
 * de `estNoiseBps` ; le prix officiel = vrai strike décalé de −5 bps (USDT vs USD, constant).
 */
function simulate(estNoiseBps: number, n: number, seed: number) {
  const g = rng(seed);
  const sig = 0.9e-4;
  const rounds: ResolvedRecord[][] = [];
  const prices: Record<string, [number | null, number | null]> = {};
  for (let i = 0; i < n; i++) {
    const slot = 1_790_000_100 + i * 300;
    const slug = `btc-updown-5m-${slot}`;
    const K = 60_000 * Math.exp(0.002 * g());
    const x = sig * Math.sqrt(180) * g(); // depuis l'ouverture jusqu'à τ = 120 s
    const y = sig * Math.sqrt(120 - 40) * g(); // reste du TWAP final
    const est = K * Math.exp((estNoiseBps / 1e4) * g());
    prices[slug] = [K * Math.exp(-5e-4), null];
    const r = {
      t: slot * 1000 + 180_000, slug, coin: 'BTC', tau: 120, spot: K * Math.exp(x), strike: est, sig, tw: 60, zs: 1,
      pUp: 0.5, pRaw: 0.5, upAsk: null, downAsk: null, upAskSz: null, downAskSz: null, src: 'binance', act: 'hold', upWon: x + y >= 0,
    } as ResolvedRecord;
    rounds.push([r]);
  }
  return { rounds, prices };
}

test('0c : prix officiel corrigé de l\'écart glissant meilleur quand notre estimation est bruitée ; neutre sinon', () => {
  const noisy = simulate(8, 3000, 7);
  const c = compareOfficialStrike(noisy.rounds, noisy.prices, { strikeNoiseSec: 3, basisBps: 2 });
  assert.equal(c.rounds, 2997, 'les 3 premiers rounds servent à amorcer la correction');
  assert.ok((c.brierA as number) < (c.brierB as number), `officiel ${c.brierA} < estimé ${c.brierB}`);
  assert.ok((c.t as number) < -2, `significatif : t ${c.t}`);
  const exact = simulate(0, 3000, 11);
  const e = compareOfficialStrike(exact.rounds, exact.prices, { strikeNoiseSec: 3, basisBps: 2 });
  assert.ok(Math.abs(e.t as number) < 3, `estimation déjà exacte : pas d'écart notable (t ${e.t})`);
  // Sans correction, le décalage de 5 bps biaiserait le modèle : la correction l'annule
  assert.ok(Math.abs((e.brierA as number) - (e.brierB as number)) < 0.003);
});

test('correction glissante : ≥ 3 rounds précédents, 12 au plus, jamais le round lui-même', () => {
  assert.equal(correctedOfficialStrike(100, [0.001, 0.001]), null);
  assert.ok(Math.abs((correctedOfficialStrike(100, [0.001, 0.001, 0.001]) as number) - 100 * Math.exp(0.001)) < 1e-9);
  const gaps = [...Array(20).fill(0.05), ...Array(12).fill(0.001)];
  assert.ok(Math.abs((correctedOfficialStrike(100, gaps) as number) - 100 * Math.exp(0.001)) < 1e-9, 'seulement les 12 derniers');
  assert.equal(correctedOfficialStrike(0, [0, 0, 0]), null);
  // Aucune information future : le strike corrigé d'un round ne dépend pas de sa propre
  // estimation (ni de l'ordre des rounds en entrée) ; le round suivant, si.
  const a = simulate(8, 40, 3);
  const b = simulate(8, 40, 3);
  b.rounds[30][0].strike *= 1.01; // estimation aberrante pour le round 30 seulement
  const ka = correctedOfficialStrikes(a.rounds, a.prices);
  const kb = correctedOfficialStrikes([...b.rounds].reverse(), b.prices);
  const slug = (i: number) => a.rounds[i][0].slug;
  assert.equal(ka.size, 37);
  assert.equal(ka.get(slug(30)), kb.get(slug(30)), 'round 30 : correction sans sa propre estimation');
  assert.notEqual(ka.get(slug(31)), kb.get(slug(31)), 'round 31 : correction avec celle du round 30');
  assert.equal(ka.get(slug(2)), undefined, 'moins de 3 rounds précédents : pas de prix corrigé');
});
