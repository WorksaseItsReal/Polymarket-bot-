/**
 * (3) FRAÎCHEUR DES DONNÉES — une valeur par défaut n'est PAS une mesure.
 *
 * Règle : une donnée ABSENTE (undefined / null / champ manquant) ne doit jamais
 * être confondue avec une mesure qui VAUT réellement une valeur — en particulier
 * 0.5, qui est une probabilité parfaitement légitime (marché à 50/50). Confondre
 * les deux fait « décider » sur une donnée qui n'existe pas.
 *
 * On teste trois comportements RÉELS, sans les caricaturer :
 *
 *  1. `orderbook.yes?.ask || 0.5` (bot-with-dashboard.ts) — l'opérateur `||`
 *     s'effondre sur TOUTE valeur falsy : `undefined` ET `0` deviennent 0.5.
 *     C'est le TROU : absent et « vrai 0.5 » sont indistinguables. On l'épingle.
 *  2. `orderbook.no?.ask ?? …` — l'opérateur `??` ne se replie QUE sur
 *     null/undefined : un `ask` valant réellement 0 est PRÉSERVÉ. Ici, absent et
 *     valeur réelle sont bien distinguables. On le prouve.
 *  3. `typeof t.realized !== 'number'` (apprentissage) — une mesure ABSENTE est
 *     rejetée, une mesure valant réellement 0 est conservée. Distinguable.
 *
 * Plus `fmt_live()` (paperbot-recap.py) : un prix live ABSENT s'affiche « n/a »,
 * jamais remplacé par un prix par défaut maquillé en mesure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFromBot,
  evalExtracted,
  pySourcesAvailable,
  runHarnessV2,
} from './harness-v2.ts';

// ---------------------------------------------------------------------------
// 1. `yes.ask || 0.5` — le trou documenté
// ---------------------------------------------------------------------------

const YES_ASK_RE = /const _yesAsk = orderbook\.yes\?\.ask \|\| 0\.5;/;

function yesAsk(orderbook: { yes?: { ask?: number } }): number {
  const stmt = extractFromBot(YES_ASK_RE, 'yes.ask || 0.5 (prix d’ask YES)');
  return evalExtracted(stmt, ['orderbook'], [orderbook], '_yesAsk') as number;
}

test('CONSTAT : `yes.ask || 0.5` rend absent et « vrai 0.5 » INDISTINGUABLES', () => {
  const absent = yesAsk({ yes: {} });                  // champ manquant
  const undef = yesAsk({ yes: { ask: undefined } });   // undefined explicite
  const nul = yesAsk({ yes: { ask: null as unknown as number } }); // null
  const vraiDemi = yesAsk({ yes: { ask: 0.5 } });      // mesure RÉELLE de 0.5
  const vraiZero = yesAsk({ yes: { ask: 0 } });        // mesure réelle de 0

  assert.equal(absent, 0.5, 'absent → replié sur 0.5 (défaut)');
  assert.equal(undef, 0.5, 'undefined → 0.5');
  assert.equal(nul, 0.5, 'null → 0.5');
  assert.equal(vraiDemi, 0.5, 'mesure réelle 0.5');
  assert.equal(vraiZero, 0.5, 'un ask RÉEL de 0 est écrasé par le défaut');
  // Le trou : les quatre sorties sont identiques — impossible de savoir si l'on
  // lit une mesure ou un défaut. Le test échouera si un jour la distinction est
  // introduite (et il faudra alors le retourner en test positif).
  assert.equal(absent, vraiDemi, 'CONSTAT : absent et vrai 0.5 sont confondus (trou de fraîcheur)');
});

// ---------------------------------------------------------------------------
// 2. `no.ask ?? …` — distinguable (le code le fait correctement ici)
// ---------------------------------------------------------------------------

const NO_ASK_RE =
  /const _noAsk = orderbook\.no\?\.ask \?\? Math\.min\(1 - _yesAsk, 0\.99\);/;

function noAsk(orderbook: { no?: { ask?: number } }, _yesAsk: number): number {
  const stmt = extractFromBot(NO_ASK_RE, 'no.ask ?? min(1 − yesAsk, 0.99)');
  return evalExtracted(stmt, ['orderbook', '_yesAsk'], [orderbook, _yesAsk], '_noAsk') as number;
}

test('`no.ask ?? défaut` PRÉSERVE une mesure réelle de 0 (distinguable de l’absence)', () => {
  const zeroReel = noAsk({ no: { ask: 0 } }, 0.5);
  const absent = noAsk({ no: {} }, 0.5);
  assert.equal(zeroReel, 0, 'un ask NO valant réellement 0 est conservé tel quel');
  assert.notEqual(zeroReel, absent, 'valeur réelle 0 ≠ valeur de repli : DISTINGUABLE');
  assert.ok(Math.abs(absent - Math.min(1 - 0.5, 0.99)) < 1e-12, 'absent → repli calculé');
  // Une mesure réelle de 0,5 n’est jamais remplacée par le repli non plus.
  const demi = noAsk({ no: { ask: 0.5 } }, 0.2);
  assert.equal(demi, 0.5, 'mesure réelle 0.5 préservée');
  assert.notEqual(demi, Math.min(1 - 0.2, 0.99), '0.5 réel ≠ repli 0.8');
});

// ---------------------------------------------------------------------------
// 3. `typeof t.realized !== 'number'` — mesuré vs non mesuré
// ---------------------------------------------------------------------------

const REALIZED_GUARD_RE = /if \(typeof t\.realized !== 'number'\) continue;/;

/** true si l'entrée porte une mesure de realized exploitable. */
function realizedIsMeasured(t: unknown): boolean {
  const stmt = extractFromBot(REALIZED_GUARD_RE, 'typeof t.realized !== "number"');
  const js = stmt.replace('continue;', 'return false;');
  const fn = new Function('t', `${js}\nreturn true;`);
  return (fn as (x: unknown) => boolean)(t);
}

test('une mesure ABSENTE est distinguable d’une mesure valant réellement 0 ou 0.5', () => {
  assert.equal(realizedIsMeasured({}), false, 'champ realized absent → PAS une mesure');
  assert.equal(realizedIsMeasured({ realized: undefined }), false, 'undefined → PAS une mesure');
  assert.equal(realizedIsMeasured({ realized: null }), false, 'null → PAS une mesure');
  assert.equal(realizedIsMeasured({ realized: '0.5' }), false, 'chaîne → PAS une mesure');
  assert.equal(realizedIsMeasured({ realized: NaN }), true, 'NaN EST un number (limite connue)');
  assert.equal(realizedIsMeasured({ realized: 0 }), true, 'zéro RÉEL est une mesure');
  assert.equal(realizedIsMeasured({ realized: 0.5 }), true, '0.5 RÉEL est une mesure');
  // Distinguabilité exigée : absent ≠ valeur réelle.
  assert.notEqual(
    realizedIsMeasured({}),
    realizedIsMeasured({ realized: 0.5 }),
    'absent et 0.5 réel doivent être distinguables',
  );
});

// ---------------------------------------------------------------------------
// 4. Défaut de configuration qui écrase un 0 légitime
// ---------------------------------------------------------------------------

const OLD_STAKE_RE = /const stake = Number\(process\.env\.BET_STAKE \?\? ''\) \|\| 1;/;
const NEW_STAKE_RE = /const stake = _sizeSig\.stake;/;

test('la mise figée du .env (qui écrasait un 0 légitime) a disparu', () => {
  // AVANT (2026-09-27) : `const stake = Number(process.env.BET_STAKE ?? '') || 1` — un
  // `BET_STAKE=0` était écrasé par le défaut 1, donc il était impossible de demander
  // explicitement une mise nulle. La mise passe désormais par `computeStake`
  // (`src/services/stake-sizing.ts`) : un edge nul renvoie 0 et le trade est SAUTÉ,
  // au lieu d'être forcé à 1.
  assert.throws(
    () => extractFromBot(OLD_STAKE_RE, 'ancienne lecture BET_STAKE'),
    'la lecture figée de BET_STAKE ne doit plus exister (chemin DipArb)',
  );
  assert.match(
    extractFromBot(NEW_STAKE_RE, 'nouvelle source de la mise (DipArb)'),
    /_sizeSig\.stake/,
  );
});

// ---------------------------------------------------------------------------
// 5. live_price() / best_ask() — une mesure absente reste None (jamais inventée)
// ---------------------------------------------------------------------------

type Freshness = {
  live_absent: null;
  live_vide: null;
  live_present: number;
  live_demi_reel: number;
  ask_carnet_vide: null;
  ask_sans_cle: null;
  ask_min: number;
  ask_demi_reel: number;
  ask_prix_nul_ignore: number;
  ask_illisible: null;
};

test('une mesure live ABSENTE vaut None, JAMAIS un prix par défaut inventé', {
  skip: pySourcesAvailable ? false : 'sources réelles absentes — test skippé, jamais simulé',
}, () => {
  const r = runHarnessV2<Freshness>('fmt-live');
  // Absence de réponse de la source : None des deux côtés.
  assert.equal(r.live_absent, null, 'live_price sans réponse → None');
  assert.equal(r.live_vide, null, 'live_price réponse vide → None');
  // Présence : la valeur réelle est rendue telle quelle.
  assert.equal(r.live_present, 100000, 'live_price réponse valide → la valeur');
  // Distinguabilité exigée : une mesure RÉELLE de 0.5 ≠ absence.
  assert.equal(r.live_demi_reel, 0.5, 'une mesure réelle de 0,5 est conservée');
  assert.notEqual(r.live_demi_reel, r.live_absent, 'mesure 0,5 ≠ absence : DISTINGUABLE');
});

test('best_ask : carnet indisponible → None ; jamais remplacé par défaut (0.5 ou autre)', {
  skip: pySourcesAvailable ? false : 'sources réelles absentes — test skippé, jamais simulé',
}, () => {
  const r = runHarnessV2<Freshness>('fmt-live');
  assert.equal(r.ask_carnet_vide, null, 'carnet vide → None (on n’invente pas 0,5)');
  assert.equal(r.ask_sans_cle, null, 'carnet sans « asks » → None');
  assert.equal(r.ask_illisible, null, 'prix illisible → None');
  // Carnet valide : on prend l’offre la MOINS chère (celle qu’on paie réellement).
  assert.equal(r.ask_min, 0.5, 'asks 0,80 / 0,50 / 0,65 → 0,50 (tri croissant puis [0])');
  assert.equal(r.ask_prix_nul_ignore, 0.6, 'un prix null est ignoré sans casser la lecture');
  // Distinguabilité : un vrai ask de 0,5 ≠ un carnet indisponible.
  assert.equal(r.ask_demi_reel, 0.5, 'ask réel de 0,5 lu tel quel');
  assert.notEqual(r.ask_demi_reel, r.ask_carnet_vide, 'ask 0,5 réel ≠ carnet indisponible : DISTINGUABLE');
  assert.notEqual(r.ask_min, r.ask_carnet_vide, 'un ask mesuré n’est jamais égal à l’absence');
});
