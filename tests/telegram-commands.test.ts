/**
 * tests/telegram-commands.test.ts — réponses aux commandes Telegram (/status, /bilan, /risque,
 * /positions, /aide) : textes lisibles, sans « undefined », à partir de données fournies.
 * Exécution : `npx tsx --test tests/telegram-commands.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerCommand, parseCommand, type CommandProviders } from '../src/bot/telegram-commands.ts';
import { DEFAULT_RISK_LIMITS } from '../src/bot/config.ts';
import type { RiskVerdict } from '../src/bot/risk-gate.ts';
import { computeStats, type LedgerTrade } from '../src/services/paper-ledger.ts';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const allowed: RiskVerdict = { allowed: true, layer: null, reason: null, until: null, currentCapital: 250, peakCapital: 250, drawdown: 0, pnlToday: 0, pnlMonth: 0 };
const blocked: RiskVerdict = { ...allowed, allowed: false, layer: 'daily', reason: 'perte du jour 13,00 $ ≥ limite 12,50 $ : plus d\'entrée jusqu\'à minuit UTC', until: NOW + 3_600_000, currentCapital: 237, pnlToday: -13, pnlMonth: -13, drawdown: 0.052 };
const openTrade: LedgerTrade = {
  id: 'c1', slug: 'btc-updown-5m-1790000100', coin: 'BTC', side: 'UP', stake: 10, costPerShare: 0.517, shares: 19.34, modelProb: 0.7, edge: 0.18,
  openedAt: new Date(NOW - 60_000).toISOString(), endMs: NOW + 130_000, status: 'open', pnl: null,
};

function providers(over: Partial<{ risk: RiskVerdict; positions: LedgerTrade[]; entryBlock: string | null }> = {}): CommandProviders {
  const risk = over.risk ?? allowed;
  const positions = over.positions ?? [];
  const stats = computeStats([]);
  return {
    status: () => ({
      uptimeSec: 3725, capital: 250, stats, risk, entryBlock: over.entryBlock ?? null, positions,
      lastFullPassAgoSec: 7, lastMarketsFoundAgoSec: 7, spotStream: 'live', consecutiveTickFailures: 0,
    }),
    summary: () => ({ stats, capital: 250 }),
    risk: () => ({ verdict: risk, limits: DEFAULT_RISK_LIMITS, capital: 250 }),
    positions: () => ({ positions, nowMs: NOW, timeZone: 'UTC' }),
  };
}
const noJunk = (s: string | null) => { assert.ok(s); assert.doesNotMatch(s, /undefined|NaN|null|\[object/, s); return s; };

test('parseCommand : « /status@MonBot 1 » → status, texte libre → null', () => {
  assert.equal(parseCommand('/status'), 'status');
  assert.equal(parseCommand('  /Status@MonBot arg'), 'status');
  assert.equal(parseCommand('/aide\n'), 'aide');
  assert.equal(parseCommand('bonjour'), null);
  assert.equal(parseCommand('/'), null);
});

test('/status : entrées autorisées, capital, trades, positions, santé ; bloqué = raison affichée', () => {
  const s = noJunk(answerCommand('/status', providers()));
  assert.match(s, /^🤖 <b>ÉTAT<\/b> — bot papier en marche depuis 62 min 05 s/);
  assert.match(s, /Entrées : ▶️ autorisées/);
  assert.match(s, /Capital : 250,00 \$ \(départ 250,00 \$\) · PnL 0,00 \$ · jour 0,00 \$ · baisse 0,0 %/);
  assert.match(s, /Trades : 0 trade · 0 ✅ \/ 0 ❌ \(—\)/);
  assert.match(s, /Positions ouvertes : 0\n/);
  assert.match(s, /Marchés : passage complet il y a 7 s · rounds trouvés il y a 7 s/);
  assert.match(s, /Spot temps réel : connecté/);
  const b = noJunk(answerCommand('/status', providers({ risk: blocked })));
  assert.match(b, /Entrées : ⏸️ bloquées — perte du jour 13,00 \$ ≥ limite 12,50 \$/);
  assert.match(b, /jour −13,00 \$ · baisse 5,2 %/);
  const g = noJunk(answerCommand('/status', providers({ entryBlock: 'horloge du serveur décalée de 7.0 s (synchroniser NTP)' })));
  assert.match(g, /⏸️ bloquées — horloge du serveur décalée/);
  const p = noJunk(answerCommand('/status', providers({ positions: [openTrade] })));
  assert.match(p, /Positions ouvertes : 1 \(exposition 10,00 \$\)/);
});

test('/risque : les quatre limites, chiffrées, et l\'état', () => {
  const s = noJunk(answerCommand('/risque', providers()));
  assert.match(s, /PORTE DE RISQUE<\/b> — ▶️ entrées autorisées/);
  assert.match(s, /Perte du jour \(UTC\) : 0,00 \$ \/ limite −12,50 \$ \(reprise à minuit UTC\)/);
  assert.match(s, /Perte du mois \(UTC\) : 0,00 \$ \/ limite −37,50 \$/);
  assert.match(s, /Baisse depuis le plus haut \(250,00 \$\) : 0,0 % \/ limite 25 %/);
  assert.match(s, /Perte totale : 0,00 \$ \/ limite −100,00 \$ \(arrêt définitif\)/);
  const b = noJunk(answerCommand('/risk', providers({ risk: blocked })));
  assert.match(b, /⏸️ perte du jour 13,00 \$/);
  assert.match(b, /Perte du jour \(UTC\) : −13,00 \$/);
  assert.match(b, /Perte totale : −13,00 \$/);
});

test('/positions : aucune, puis une position lisible (côté, mise, prix, modèle, fin, gain)', () => {
  assert.equal(answerCommand('/positions', providers()), '📂 Aucune position ouverte');
  const s = noJunk(answerCommand('/paris', providers({ positions: [openTrade] })));
  assert.match(s, /POSITIONS OUVERTES<\/b> \(1\) · exposition 10,00 \$/);
  assert.match(s, /BTC ⬆️ HAUSSE · mise 10,00 \$ à 0,517 \$\/part · modèle 70 % · round 11:57 → 12:02 · fin dans 2 min 10 s · si gagné \+9,34 \$/);
});

test('/bilan, /aide, /start, inconnue, texte libre (privé = aide, groupe = silence)', () => {
  assert.match(noJunk(answerCommand('/bilan', providers())), /📊 <b>BILAN<\/b>/);
  assert.match(noJunk(answerCommand('/aide', providers())), /^ℹ️ <b>COMMANDES<\/b>\n\/status — /);
  assert.match(noJunk(answerCommand('/start', providers())), /COMMANDES/);
  assert.match(noJunk(answerCommand('/status@MonBot', providers())), /ÉTAT/);
  assert.match(noJunk(answerCommand('/foo', providers())), /^Commande inconnue : \/foo\nℹ️/);
  assert.match(noJunk(answerCommand('salut', providers(), 'private')), /COMMANDES/);
  assert.equal(answerCommand('salut', providers(), 'supergroup'), null, 'pas de réponse au bavardage d\'un groupe');
  assert.equal(answerCommand('salut', providers()), null, 'type de chat inconnu : silence');
});
