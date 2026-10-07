/**
 * (2) DIMENSIONNEMENT DE MISE — plafonds, bornes et cas dégénérés.
 *
 * Logique RÉELLE exercée :
 *
 *  A. `calculatePositionSize(baseSize)` dans bot-config.ts (réduction sur série de
 *     pertes, hausse plafonnée sur série de gains, puis plancher/plafond
 *     `minPositionPct`/`maxPositionPct`).
 *
 * (L'ancienne section B — clamp `sizeFactor` de bot-with-dashboard.ts — a été retirée
 * avec le code qu'elle testait : la mise du bot principal vient de `computeStake`,
 * couvert par tests/stake-sizing.test.ts.)
 *
 * Plus les PLAFONDS de configuration (maxPerTradePct, maxPerMarketPct,
 * maxTotalExposurePct) extraits du source : ils doivent rester ≤ leurs bornes
 * historiques — un relèvement accidentel doit casser ce fichier.
 *
 * LIMITE : bot-config.ts n'est PAS importable (leur top-level démarre le
 * SDK/WebSocket). On extrait le texte et on l'évalue via `new Function` dans un
 * scope neuf — voir REPORT-v2.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_CONFIG_SRC,
  BOT_SRC,
  extractFunction,
  extractNumber,
  extractFrom,
  stripTsAnnotations,
} from './harness-v2.ts';

// ===========================================================================
// A. calculatePositionSize() — code réel de bot-config.ts
// ===========================================================================

/** CONFIG.risk réel, lu dans le source (jamais réécrit à la main). */
const RISK = {
  enableDynamicSizing:
    extractFrom(BOT_CONFIG_SRC, /enableDynamicSizing:\s*(true|false)/, 'enableDynamicSizing')
      .match(/(true|false)/)![1] === 'true',
  minPositionPct: extractNumber(BOT_CONFIG_SRC, /minPositionPct: [\d.]+,/, 'minPositionPct'),
  maxPositionPct: extractNumber(BOT_CONFIG_SRC, /maxPositionPct: [\d.]+,/, 'maxPositionPct'),
  lossSizingReduction: extractNumber(
    BOT_CONFIG_SRC, /lossSizingReduction: [\d.]+,/, 'lossSizingReduction',
  ),
  winSizingIncrease: extractNumber(
    BOT_CONFIG_SRC, /winSizingIncrease: [\d.]+,/, 'winSizingIncrease',
  ),
};

function calcSize(baseSize: number, consecutiveLosses = 0, consecutiveWins = 0): number {
  const src = stripTsAnnotations(extractFunction(BOT_CONFIG_SRC, 'calculatePositionSize'));
  const CONFIG = { risk: RISK };
  const state = { consecutiveLosses, consecutiveWins };
  const log = () => undefined;
  const fn = new Function(
    'CONFIG', 'state', 'log',
    `${src}\nreturn calculatePositionSize;`,
  ) as (c: unknown, s: unknown, l: unknown) => (b: number) => number;
  return fn(CONFIG, state, log)(baseSize);
}

test('le plafond de mise par trade respecte sa borne de conception', () => {
  // maxPerTradePct = 2 % du capital (abaissé depuis 3 %) : ne doit pas remonter.
  const maxPerTradePct = extractNumber(BOT_SRC, /maxPerTradePct: [\d.]+,/, 'maxPerTradePct');
  const maxPerMarketPct = extractNumber(BOT_SRC, /maxPerMarketPct: [\d.]+,/, 'maxPerMarketPct');
  const maxTotalExposurePct = extractNumber(
    BOT_SRC, /maxTotalExposurePct: [\d.]+,/, 'maxTotalExposurePct',
  );
  assert.ok(maxPerTradePct > 0 && maxPerTradePct <= 0.02, `maxPerTradePct ≤ 2 %, obtenu ${maxPerTradePct}`);
  assert.ok(maxPerMarketPct > 0 && maxPerMarketPct <= 0.10, `maxPerMarketPct ≤ 10 %, obtenu ${maxPerMarketPct}`);
  assert.ok(
    maxTotalExposurePct > 0 && maxTotalExposurePct <= 0.30,
    `exposition simultanée ≤ 30 %, obtenu ${maxTotalExposurePct}`,
  );
  // Cohérence : le plafond par trade ne peut pas dépasser l'exposition totale.
  assert.ok(maxPerTradePct <= maxTotalExposurePct, 'un trade ne peut excéder l’exposition totale');
});

test('une mise de base > plafond est ramenée au plafond, jamais au-delà', () => {
  assert.equal(calcSize(1.0), RISK.maxPositionPct, 'base 100 % → ramenée à maxPositionPct');
  assert.equal(calcSize(0.5), RISK.maxPositionPct, 'base 50 % → ramenée à maxPositionPct');
  assert.equal(calcSize(RISK.maxPositionPct + 0.01), RISK.maxPositionPct, 'juste au-dessus → plafonnée');
});

test('une mise de base sous le plancher est remontée au plancher, jamais à 0', () => {
  assert.equal(calcSize(0.0001), RISK.minPositionPct, 'base minuscule → minPositionPct');
  assert.equal(calcSize(0), RISK.minPositionPct, 'base 0 → minPositionPct');
  assert.ok(calcSize(0) > 0, 'une mise de 0 (round gratuit) n’est jamais émise');
});

test('aucune mise n’est NÉGATIVE, quelle que soit l’entrée finie', () => {
  const entrees = [-5, -0.01, 0, 1e-9, 0.01, 0.05, 0.5, 1, 10, 1e6];
  for (const b of entrees) {
    const s = calcSize(b);
    assert.ok(Number.isFinite(s), `base=${b} → mise finie, obtenu ${s}`);
    assert.ok(s >= 0, `base=${b} → mise ≥ 0, obtenu ${s}`);
    assert.ok(s >= RISK.minPositionPct - 1e-12, `base=${b} → mise ≥ plancher, obtenu ${s}`);
    assert.ok(s <= RISK.maxPositionPct + 1e-12, `base=${b} → mise ≤ plafond, obtenu ${s}`);
  }
});

test('une série de pertes réduit la mise mais ne la fait pas sortir des bornes', () => {
  const base = RISK.maxPositionPct;
  let precedente = Infinity;
  for (const pertes of [0, 1, 2, 3, 4, 6, 10, 50, 1000]) {
    const s = calcSize(base, pertes, 0);
    assert.ok(s >= RISK.minPositionPct - 1e-12 && s <= RISK.maxPositionPct + 1e-12,
      `pertes=${pertes} : ${s} hors [${RISK.minPositionPct}, ${RISK.maxPositionPct}]`);
    assert.ok(Number.isFinite(s), `pertes=${pertes} : mise non finie (${s})`);
    assert.ok(s <= precedente + 1e-12, `pertes=${pertes} : la mise ne doit pas AUGMENTER en perdant (${s} > ${precedente})`);
    precedente = s;
  }
});

test('une série de gains ne fait jamais dépasser le plafond', () => {
  for (const gains of [0, 1, 3, 4, 8, 20, 1000]) {
    const s = calcSize(RISK.maxPositionPct, 0, gains);
    assert.ok(s <= RISK.maxPositionPct + 1e-12, `gains=${gains} : ${s} > plafond`);
    assert.ok(Number.isFinite(s), `gains=${gains} : mise non finie`);
  }
});

test('GAP : une mise de base NaN ou infinie — Infinity est plafonnée, NaN NE L’EST PAS', () => {
  // Characterization (comportement RÉEL d’aujourd’hui) — voir REPORT-v2.md.
  assert.ok(Number.isFinite(calcSize(Infinity)), 'un baseSize infini est ramené au plafond');
  assert.equal(calcSize(Infinity), RISK.maxPositionPct, 'Infinity → maxPositionPct');
  // Math.min(plafond, NaN) = NaN : les bornes ne rattrapent PAS un NaN.
  assert.ok(
    Number.isNaN(calcSize(NaN)),
    'CONSTAT : un baseSize NaN traverse le plancher/plafond sans être rattrapé (trou de robustesse)',
  );
});
