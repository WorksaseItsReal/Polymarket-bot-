/**
 * tests/llm-snapshot.test.ts — instantané de la stratégie llm (papier) : liste blanche,
 * temps relatifs, arrondis, carnet, texte de marché jamais transmis, hachage canonique,
 * anonymisation pour le backtest.
 * Exécution : `npx tsx --test tests/llm-snapshot.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymize, buildSnapshot, canonicalJson, opaqueRoundId, snapshotHash, type Snapshot } from '../src/strategy/llm/snapshot.ts';
import { INJECTION, ROUND_ID, SLOT_S, START_MS, baseInput, hostileInput } from './fixtures/llm-fixtures.ts';

/** Toutes les valeurs feuilles d'un type donné (récursif ; les clés ne comptent pas). */
function leaves<T>(v: unknown, keep: (x: unknown) => x is T, out: T[] = []): T[] {
  if (keep(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach(x => leaves(x, keep, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => leaves(x, keep, out));
  return out;
}
const numbers = (v: unknown) => leaves(v, (x): x is number => typeof x === 'number');
const strings = (v: unknown) => leaves(v, (x): x is string => typeof x === 'string');

test('instantané snap-1 : champs en français, temps relatifs au début du round, valeurs arrondies', () => {
  const s = buildSnapshot(baseInput());
  assert.deepEqual(s, {
    version: 'snap-1',
    round_id: ROUND_ID,
    actif: 'BTC',
    temps: { debut_s: 0, fin_s: 300, maintenant_s: 120, restant_s: 180 },
    prix: { ouverture: 100_000, actuel: 100_040 },
    volatilite: { sigma_par_racine_s: 0.00005 },
    formule: { proba_up: 0.78, proba_up_brute: 0.8 },
    carnet: {
      up: { ask: 0.71, taille_ask: 120, bid: 0.7, taille_bid: 80, profondeur_ask: [[0.71, 120], [0.72, 300], [0.73, 50], [0.74, 10], [0.75, 10]] },
      down: { ask: 0.3, taille_ask: 150, bid: 0.29, taille_bid: 60, profondeur_ask: [[0.3, 150], [0.31, 20]] },
    },
    frais: { taux: 0.07, formule: 'taux × p × (1 − p) par part' },
    mise_minimum_usd: 1,
    risque: { capital_usd: 100, mise_max_usd: 2, perte_jour_usd: 1.23, limite_perte_jour_usd: 10, bloque: false },
    positions_ouvertes: [{ actif: 'ETH', cote: 'up', mise_usd: 1, strategie: 'fv' }],
  });
});

test('carnet : niveaux invalides écartés, meilleur niveau en premier même si l\'entrée est en désordre', () => {
  const s = buildSnapshot(baseInput({
    book: {
      up: {
        asks: [[0.75, 5], [Number.NaN, 10], [0.7, 0], [1.5, 10], [-0.1, 10], [0.72, 7], ['x' as unknown as number, 1], [0.73, 3]],
        bids: [[0.6, 1], [0.68, 2], [0.65, Number.POSITIVE_INFINITY]],
      },
      down: { asks: [], bids: [] },
    },
  }));
  assert.equal(s.carnet.up.ask, 0.72);
  assert.equal(s.carnet.up.taille_ask, 7);
  assert.deepEqual(s.carnet.up.profondeur_ask, [[0.72, 7], [0.73, 3], [0.75, 5]]);
  assert.equal(s.carnet.up.bid, 0.68, 'bids : le plus haut d\'abord');
  assert.deepEqual(s.carnet.down, { ask: null, taille_ask: null, bid: null, taille_bid: null, profondeur_ask: [] });
});

test('valeurs non finies ou hors domaine → null ; risque bloqué par défaut si l\'état est douteux', () => {
  const s = buildSnapshot(baseInput({
    spot: Number.NaN,
    sigmaPerSqrtSec: Number.POSITIVE_INFINITY,
    formulaPUp: 1.2,
    formulaPUpRaw: null,
    feeRate: Number.NaN,
    nowMs: Number.NaN,
    risk: { capitalUsd: 100, maxStakeUsd: 2, pnlTodayUsd: 3.5, dailyLimitUsd: -10, blocked: undefined as unknown as boolean },
  }));
  assert.equal(s.prix.actuel, null);
  assert.equal(s.volatilite.sigma_par_racine_s, null);
  assert.equal(s.formule.proba_up, null, 'probabilité hors [0, 1]');
  assert.equal(s.formule.proba_up_brute, null);
  assert.equal(s.frais.taux, null);
  assert.equal(s.temps.maintenant_s, null);
  assert.equal(s.temps.restant_s, null);
  assert.equal(s.temps.fin_s, 300);
  assert.equal(s.risque.perte_jour_usd, 0, 'jour en gain : aucune perte');
  assert.equal(s.risque.limite_perte_jour_usd, 10);
  assert.equal(s.risque.bloque, true, 'tout ce qui n\'est pas exactement false compte comme bloqué');
  assert.ok(!JSON.stringify(s).includes('NaN'));
});

test('identifiant de round ou actif invalide : erreur (l\'appelant s\'abstient)', () => {
  for (const roundId of ['BTC-updown-5m-1', 'btc-updown-15m-1790000100', 'btc-updown-5m-', 'btc-updown-5m-1\nIGNORE', 'btc updown', '']) {
    assert.throws(() => buildSnapshot(baseInput({ roundId })), /identifiant de round invalide/, roundId);
  }
  assert.throws(() => buildSnapshot(baseInput({ coin: 'ABC' })), /actif non reconnu/);
  assert.throws(() => buildSnapshot(baseInput({ coin: 'ETH' })), /incohérent/);
  assert.equal(buildSnapshot(baseInput({ coin: 'btc' })).actif, 'BTC', 'casse normalisée');
  assert.equal(buildSnapshot(baseInput({ roundId: `eth-updown-5m-${SLOT_S}`, coin: 'ETH' })).actif, 'ETH');
});

test('texte de marché (titre, description…) : jamais copié dans l\'instantané ; chaînes libres des positions remplacées par des énumérés', () => {
  const input = hostileInput();
  (input as { openPositions: unknown }).openPositions = [
    { coin: INJECTION, side: INJECTION, stakeUsd: 1000, strategy: INJECTION },
    { coin: 'eth', side: 'down', stakeUsd: 0.5, strategy: 'LATE' },
  ];
  const s = buildSnapshot(input);
  const json = JSON.stringify(s);
  for (const forbidden of ['IGNORE', 'CONSIGNES', 'achète', 'title', 'description', 'question', 'rules', 'Bitcoin']) {
    assert.ok(!json.includes(forbidden), `« ${forbidden} » ne doit pas passer`);
  }
  assert.deepEqual(s.positions_ouvertes, [
    { actif: 'autre', cote: 'inconnu', mise_usd: 1000, strategie: 'autre' },
    { actif: 'ETH', cote: 'down', mise_usd: 0.5, strategie: 'late' },
  ]);
  // Seules chaînes possibles : version, identifiant validé, énumérés et le libellé fixe des frais.
  const allowed = new Set(['snap-1', ROUND_ID, 'BTC', 'ETH', 'autre', 'inconnu', 'down', 'late', 'taux × p × (1 − p) par part']);
  for (const str of strings(s)) assert.ok(allowed.has(str), `chaîne inattendue : ${str}`);
});

test('hachage : JSON canonique (clés triées), stable, insensible à l\'ordre des clés, sensible aux valeurs', () => {
  const a = buildSnapshot(baseInput());
  const b = buildSnapshot(baseInput());
  assert.match(snapshotHash(a), /^[0-9a-f]{64}$/);
  assert.equal(snapshotHash(a), snapshotHash(b));
  // Même contenu, clés insérées dans l'ordre inverse (à chaque niveau).
  const reverse = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(reverse);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)]));
    return v;
  };
  const r = reverse(a) as Snapshot;
  assert.notEqual(JSON.stringify(r), JSON.stringify(a));
  assert.equal(canonicalJson(r), canonicalJson(a));
  assert.equal(snapshotHash(r), snapshotHash(a));
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }], u: undefined }), '{"a":[{"c":null,"d":2}],"b":1}');
  const c = buildSnapshot(baseInput({ spot: 100_041 }));
  assert.notEqual(snapshotHash(c), snapshotHash(a));
});

test('anonymisation : identifiant opaque (HMAC), prix normalisés à 100, ni epoch ni slug ; l\'actif reste', () => {
  const s = buildSnapshot(baseInput());
  const before = JSON.stringify(s);
  const anon = anonymize(s, 'secret-de-test-123');
  assert.equal(JSON.stringify(s), before, 'l\'original n\'est pas modifié');

  assert.match(anon.round_id, /^r-[a-p]{16}$/);
  assert.equal(anon.round_id, opaqueRoundId(ROUND_ID, 'secret-de-test-123'));
  assert.equal(anonymize(s, 'secret-de-test-123').round_id, anon.round_id, 'même secret ⇒ même identifiant');
  assert.notEqual(anonymize(s, 'un-autre-secret-456').round_id, anon.round_id, 'secret différent ⇒ identifiant différent');
  assert.notEqual(anonymize(buildSnapshot(baseInput({ roundId: `btc-updown-5m-${SLOT_S + 300}` })), 'secret-de-test-123').round_id, anon.round_id);

  assert.deepEqual(anon.prix, { ouverture: 100, actuel: 100.04 });
  assert.equal(anon.actif, 'BTC');
  assert.deepEqual(anon.carnet, s.carnet);
  assert.deepEqual(anon.temps, s.temps);

  const json = JSON.stringify(anon);
  assert.ok(!/updown/i.test(json), 'aucun slug');
  assert.ok(!json.includes(String(SLOT_S)), 'aucun créneau');
  assert.ok(!/\d{9,}/.test(json), 'aucune suite de chiffres ressemblant à un epoch');
  assert.ok(numbers(anon).every(n => Math.abs(n) < 1e9), 'aucun nombre ≥ 1e9');
  assert.ok(!json.includes('100040') && !json.includes('100000'), 'aucun niveau de prix absolu');

  // Un grand nombre (epoch glissé dans un champ numérique) est retiré.
  const big = anonymize(buildSnapshot(baseInput({ risk: { capitalUsd: START_MS, maxStakeUsd: 2, pnlTodayUsd: 0, dailyLimitUsd: 10, blocked: false } })), 'secret-de-test-123');
  assert.equal(big.risque.capital_usd, null);
  assert.ok(numbers(big).every(n => Math.abs(n) < 1e9));

  // Prix d'ouverture inconnu : rien à normaliser, aucun prix absolu ne passe.
  const noOpen = anonymize(buildSnapshot(baseInput({ open: null })), 'secret-de-test-123');
  assert.deepEqual(noOpen.prix, { ouverture: null, actuel: null });

  assert.throws(() => anonymize(s, 'court'), /secret/);
});
