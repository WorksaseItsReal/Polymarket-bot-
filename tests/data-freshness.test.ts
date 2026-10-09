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
 *  1. Boucle juste valeur (src/strategy/fair-value-runner.ts) : un ask absent ou
 *     dégénéré (prix/taille nuls) reste null, jamais un prix par défaut ; `decide()`
 *     refuse de trader sur un ask absent. (L'ancien `yes.ask || 0.5`, qui confondait
 *     les deux, a été supprimé avec la stratégie « fenêtre favori ».)
 *  3. Série de pertes (registre fv-ledger.json) : seul un trade résolu avec un PnL
 *     numérique compte ; un trade ouvert ou un PnL NaN n'est jamais une perte.
 *
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FAIR_VALUE_CONFIG, decide } from '../src/services/fair-value.ts';
import { FairValueRunner } from '../src/strategy/fair-value-runner.ts';
import { computeStats, loadLedger, type LedgerTrade } from '../src/services/paper-ledger.ts';

// ---------------------------------------------------------------------------
// 1. Asks du carnet : absent → null, jamais un prix inventé
// ---------------------------------------------------------------------------
// L'ancien `orderbook.yes?.ask || 0.5` (absent et « vrai 0,5 » confondus) a disparu avec
// la stratégie « fenêtre favori ». La boucle juste valeur (src/strategy/fair-value-runner.ts)
// prend le meilleur ask parmi les niveaux valides, ou null ; `decide()` refuse null.

test('carnet sans ask (ou niveaux à prix/taille nuls) : aucun pari, jamais un prix par défaut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-'));
  const ledgerPath = join(dir, 'fv-ledger.json');
  const slot = 1_790_000_100;
  const runner = new FairValueRunner({
    cfg: DEFAULT_FAIR_VALUE_CONFIG, exitEdge: 0.04, ledgerPath, capital: () => 50,
    now: () => (slot + 180) * 1000, canTrade: () => true,
    scanMarkets: async () => [{ conditionId: '0x1', slug: `btc-updown-5m-${slot}`, underlying: 'BTC', durationMinutes: 5, upTokenId: 'U', downTokenId: 'D' }],
    // Le modèle voit UP très probable, mais le carnet UP est vide / dégénéré.
    getBook: async id => (id === 'U' ? { asks: [{ price: 0, size: 100 }, { price: 0.5, size: 0 }], bids: [] } : { asks: [], bids: [] }),
    getRoundData: async () => ({ spot: 100.2, strike: 100, sigmaPerSqrtSec: 0.0006 / Math.sqrt(60), source: 't', candleAgeMs: 0 }),
    fetchOutcome: async () => ({ resolved: false, reason: '' }),
    notify: () => undefined, log: () => undefined,
  });
  await runner.tick();
  assert.deepEqual(loadLedger(ledgerPath), [], 'aucun trade sur un ask absent');
});

test('decide() ne trade JAMAIS sur un ask absent', () => {
  const base = { spot: 100.2, strike: 100, sigmaPerSqrtSec: 0.0005 / Math.sqrt(60), tauSec: 120 };
  assert.equal(decide({ ...base, upAsk: null, downAsk: null }).side, null);
  // Côté UP absent : le modèle (très UP) ne peut pas se rabattre sur un faux prix.
  const d = decide({ ...base, upAsk: null, downAsk: 0.3 });
  assert.notEqual(d.side, 'UP');
});

// ---------------------------------------------------------------------------
// 3. Série de pertes : un trade OUVERT ou sans PnL numérique n'est PAS une perte
// ---------------------------------------------------------------------------
// La série de pertes (modérateur de mise) vient du registre fv-ledger.json via
// computeStats (src/services/paper-ledger.ts).

function streakOf(entries: Array<Partial<LedgerTrade>>): number {
  const base: LedgerTrade = {
    id: '', slug: 's', coin: 'BTC', side: 'UP', stake: 1, costPerShare: 0.6, shares: 1.6, modelProb: 0.7, edge: 0.05,
    openedAt: '2026-10-07T10:00:00Z', endMs: 0, status: 'lost', pnl: -1,
  };
  return computeStats(entries.map((e, i) => ({ ...base, id: String(i), resolvedAt: `2026-10-07T10:0${i}:00Z`, ...e }))).lossStreak;
}

test('une mesure ABSENTE ou un trade OUVERT n’entre pas dans la série de pertes', () => {
  assert.equal(streakOf([{ pnl: -1 }, { pnl: -1 }]), 2, 'deux pertes réelles');
  assert.equal(streakOf([{ pnl: -1 }, { status: 'open', pnl: null }]), 1, 'un trade ouvert n\'est pas une perte');
  assert.equal(streakOf([{ pnl: -1 }, { pnl: NaN }]), 1, 'PnL NaN ignoré, jamais compté');
  assert.equal(streakOf([{ pnl: -1 }, { status: 'won', pnl: 0.5 }]), 0, 'un gain remet la série à zéro');
  assert.equal(streakOf([]), 0);
});
