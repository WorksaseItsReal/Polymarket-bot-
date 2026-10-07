/**
 * (3) FRAÎCHEUR DES DONNÉES — une valeur par défaut n'est PAS une mesure.
 *
 * Règle : une donnée ABSENTE (undefined / null / champ manquant) ne doit jamais
 * être confondue avec une mesure qui VAUT réellement une valeur — en particulier
 * 0.5, qui est une probabilité parfaitement légitime (marché à 50/50). Confondre
 * les deux fait « décider » sur une donnée qui n'existe pas.
 *
 * On teste des comportements RÉELS, sans les caricaturer :
 *
 *  1. `upBook.asks[0]?.price ?? null` (stratégie juste valeur, bot-with-dashboard.ts) :
 *     un ask absent reste null, une mesure réelle de 0,5 est préservée ; `decide()`
 *     refuse de trader sur un ask absent. (L'ancien `yes.ask || 0.5`, qui confondait
 *     les deux, a été supprimé avec la stratégie « fenêtre favori ».)
 *  3. Série de pertes : seul un `realized` numérique NON NUL est un résultat ;
 *     absent ou 0 (PENDING) n'est jamais compté comme une perte.
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
import { decide } from '../src/services/fair-value.ts';

// ---------------------------------------------------------------------------
// 1. Asks du carnet : `asks[0]?.price ?? null` — absent ≠ valeur réelle
// ---------------------------------------------------------------------------
// L'ancien `orderbook.yes?.ask || 0.5` (trou documenté : absent et « vrai 0,5 »
// confondus) a disparu avec la stratégie « fenêtre favori ». La stratégie juste
// valeur lit le meilleur ask avec `?? null`, et `decide()` refuse tout ask absent.

const UP_ASK_RE = /const upAsk = upBook\.asks\[0\]\?\.price \?\? null;/;

function upAsk(upBook: { asks: Array<{ price: number }> }): number | null {
  const stmt = extractFromBot(UP_ASK_RE, 'upBook.asks[0]?.price ?? null');
  return evalExtracted(stmt, ['upBook'], [upBook], 'upAsk') as number | null;
}

test('ask absent → null (jamais un prix inventé) ; une mesure réelle est préservée', () => {
  assert.equal(upAsk({ asks: [] }), null, 'carnet sans ask → null');
  assert.equal(upAsk({ asks: [{ price: 0.5 }] }), 0.5, 'mesure réelle 0.5 préservée');
  assert.notEqual(upAsk({ asks: [] }), upAsk({ asks: [{ price: 0.5 }] }), 'absent et 0.5 réel DISTINGUABLES');
});

test('decide() ne trade JAMAIS sur un ask absent', () => {
  const base = { spot: 100.2, strike: 100, sigmaPerSqrtSec: 0.0005 / Math.sqrt(60), tauSec: 120 };
  assert.equal(decide({ ...base, upAsk: null, downAsk: null }).side, null);
  // Côté UP absent : le modèle (très UP) ne peut pas se rabattre sur un faux prix.
  const d = decide({ ...base, upAsk: null, downAsk: 0.3 });
  assert.notEqual(d.side, 'UP');
});

// ---------------------------------------------------------------------------
// 3. Série de pertes : un trade non résolu (`realized` absent ou 0) n'est PAS une perte
// ---------------------------------------------------------------------------

const STREAK_FILTER_RE = /\.filter\(t => t && t\.side !== 'HOLD' && typeof t\.realized === 'number' && t\.realized !== 0\)/;

function countsAsResolved(t: unknown): boolean {
  const stmt = extractFromBot(STREAK_FILTER_RE, 'filtre des trades résolus (série de pertes)');
  const body = stmt.replace(/^\.filter\(/, '').replace(/\)$/, '');
  const fn = new Function('x', `return Boolean((${body})(x));`);
  return (fn as (x: unknown) => boolean)(t);
}

test('une mesure ABSENTE ou PENDING n’entre pas dans la série de pertes', () => {
  assert.equal(countsAsResolved({ side: 'YES' }), false, 'realized absent → non résolu');
  assert.equal(countsAsResolved({ side: 'YES', realized: null }), false, 'null → non résolu');
  assert.equal(countsAsResolved({ side: 'YES', realized: '0.5' }), false, 'chaîne → non résolu');
  assert.equal(countsAsResolved({ side: 'YES', realized: 0 }), false, '0 = PENDING, jamais une perte');
  assert.equal(countsAsResolved({ side: 'HOLD', realized: -1 }), false, 'HOLD ignoré');
  assert.equal(countsAsResolved({ side: 'NO', realized: -0.5 }), true, 'perte réelle comptée');
  assert.equal(countsAsResolved({ side: 'YES', realized: 0.4 }), true, 'gain réel compté');
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
