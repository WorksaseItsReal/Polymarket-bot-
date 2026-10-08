/**
 * tests/telegram.test.ts — client Telegram (faux serveur) et messages.
 * Exécution : `npx tsx --test tests/telegram.test.ts`
 *
 * Aucun appel réseau réel : `fetchImpl` simule l'API Bot de Telegram, `sleep` est
 * instantané. On vérifie les diagnostics de connexion, la gestion des limites, le
 * repli texte brut, l'expurgation du token et la lisibilité des messages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TelegramClient,
  htmlToPlain,
  looksLikeBotToken,
  splitMessage,
  telegramConfigFromEnv,
} from '../src/services/telegram.ts';
import {
  escapeHtml,
  money,
  msgAlert,
  msgStartup,
  msgSummary,
  msgTradeClosed,
  msgTradeOpened,
  reliability,
  roundWindow,
  spotPrice,
} from '../src/services/telegram-messages.ts';
import { computeStats, type LedgerTrade } from '../src/services/paper-ledger.ts';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';

type Call = { method: string; body: Record<string, unknown>; url: string };

function fakeTelegram(handler: (method: string, body: Record<string, unknown>, n: number) => { status?: number; json: unknown } | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = u.split('/').pop() as string;
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body, url: u });
    const r = handler(method, body, calls.length);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ok = (result: unknown = {}) => ({ json: { ok: true, result } });
const fail = (status: number, description: string, extra: Record<string, unknown> = {}) =>
  ({ status, json: { ok: false, error_code: status, description, ...extra } });

function client(fetchImpl: typeof fetch, logs: string[] = [], sleeps: number[] = []) {
  return new TelegramClient({
    token: TOKEN, chatId: '42', fetchImpl, minIntervalMs: 0,
    sleep: async ms => { sleeps.push(ms); },
    log: (_l, m) => logs.push(m),
  });
}

test('config : absente, désactivée ou complète', () => {
  assert.equal(telegramConfigFromEnv({}), null);
  assert.equal(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN }), null, 'chat manquant');
  assert.equal(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '1', TELEGRAM_ENABLED: 'false' }), null);
  assert.deepEqual(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: ` ${TOKEN} `, TELEGRAM_CHAT_ID: ' -1001 ' }), { token: TOKEN, chatId: '-1001' });
  assert.equal(looksLikeBotToken(TOKEN), true);
  assert.equal(looksLikeBotToken('mon-token'), false);
});

test('check : connexion OK → nom du bot et du chat', async () => {
  const { fetchImpl, calls } = fakeTelegram(m => (m === 'getMe' ? ok({ username: 'paper_bot' }) : ok({ title: 'Trading', type: 'group' })));
  const r = await client(fetchImpl).check();
  assert.equal(r.ok, true);
  assert.match(r.detail, /@paper_bot → « Trading » \(group\)/);
  assert.deepEqual(calls.map(c => c.method), ['getMe', 'getChat']);
  assert.equal(calls[1].body.chat_id, '42');
});

test('check : diagnostics clairs (token refusé, chat introuvable, bot bloqué, réseau, token mal formé)', async () => {
  let r = await client(fakeTelegram(() => fail(401, 'Unauthorized')).fetchImpl).check();
  assert.equal(r.ok, false);
  assert.match(r.detail, /@BotFather/);

  r = await client(fakeTelegram(m => (m === 'getMe' ? ok({ username: 'paper_bot' }) : fail(400, 'Bad Request: chat not found'))).fetchImpl).check();
  assert.equal(r.ok, false);
  assert.match(r.detail, /envoie \/start à @paper_bot/);

  r = await client(fakeTelegram(m => (m === 'getMe' ? ok({ username: 'paper_bot' }) : fail(403, 'Forbidden: bot was blocked by the user'))).fetchImpl).check();
  assert.match(r.detail, /bloqué/);

  r = await client(fakeTelegram(() => new Error(`connect ETIMEDOUT https://api.telegram.org/bot${TOKEN}/getMe`)).fetchImpl).check();
  assert.equal(r.ok, false);
  assert.ok(!r.detail.includes(TOKEN), 'le token ne fuit jamais dans un diagnostic');
  assert.match(r.detail, /injoignable/);

  const blocked = (async () => new Response('Forbidden by proxy', { status: 403 })) as typeof fetch;
  r = await client(blocked).check();
  assert.match(r.detail, /bloqué sur ce serveur .*pare-feu ou proxy/);

  const bad = new TelegramClient({ token: 'pas-un-token', chatId: '1', fetchImpl: (async () => { throw new Error('ne doit pas être appelé'); }) as typeof fetch });
  assert.match((await bad.check()).detail, /mal formé/);
});

test('send : HTML, ordre conservé, respect de retry_after (429)', async () => {
  const sleeps: number[] = [];
  const { fetchImpl, calls } = fakeTelegram((_m, _b, n) => (n === 1 ? fail(429, 'Too Many Requests', { parameters: { retry_after: 3 } }) : ok()));
  const c = client(fetchImpl, [], sleeps);
  c.send('<b>un</b>');
  c.send('deux');
  await c.flush();
  assert.deepEqual(calls.map(x => x.body.text), ['<b>un</b>', '<b>un</b>', 'deux']);
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.ok(sleeps.includes(3000), 'attend retry_after secondes');
  assert.equal(c.stats.sent, 2);
});

test('send : HTML refusé → renvoi en texte brut ; erreur définitive → abandon sans boucle', async () => {
  const { fetchImpl, calls } = fakeTelegram((_m, b) =>
    b.parse_mode ? fail(400, "Bad Request: can't parse entities: unclosed tag") : ok());
  const c = client(fetchImpl);
  c.send('<b>PnL &lt; 0</b');
  await c.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.parse_mode, undefined);
  assert.equal(calls[1].body.text, 'PnL < 0</b');
  assert.equal(c.stats.sent, 1);

  const logs: string[] = [];
  const dead = fakeTelegram(() => fail(400, 'Bad Request: chat not found'));
  const c2 = client(dead.fetchImpl, logs);
  c2.send('x');
  await c2.flush();
  assert.equal(dead.calls.length, 1, 'pas de nouvel essai sur une erreur définitive');
  assert.equal(c2.stats.failed, 1);
  assert.match(logs[0], /chat not found/);
});

test('send : erreur réseau → 4 essais avec attente croissante, token expurgé du log', async () => {
  const logs: string[] = [];
  const sleeps: number[] = [];
  const { fetchImpl, calls } = fakeTelegram(() => new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`));
  const c = client(fetchImpl, logs, sleeps);
  c.send('x');
  await c.flush();
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.equal(c.stats.failed, 1);
  assert.ok(logs.every(l => !l.includes(TOKEN)));
  assert.match(logs[0], /\*\*\*/);
});

test('send : panne serveur 502 passagère → nouvel essai puis succès', async () => {
  const { fetchImpl, calls } = fakeTelegram((_m, _b, n) => (n === 1 ? fail(502, 'Bad Gateway') : ok()));
  const c = client(fetchImpl);
  c.send('x');
  await c.flush();
  assert.equal(calls.length, 2);
  assert.equal(c.stats.sent, 1);
});

test('send : file bornée, message trop long découpé', async () => {
  const { fetchImpl, calls } = fakeTelegram(() => ok());
  const c = new TelegramClient({ token: TOKEN, chatId: '1', fetchImpl, minIntervalMs: 0, maxQueue: 3, sleep: async () => undefined });
  for (let i = 0; i < 6; i++) c.send(`m${i}`);
  await c.flush();
  assert.ok(c.stats.dropped >= 1, 'les plus anciens sont abandonnés au-delà de la borne');
  assert.equal(calls[calls.length - 1].body.text, 'm5', 'le plus récent est toujours envoyé');
  const long = Array.from({ length: 300 }, (_, i) => `ligne ${i} ${'x'.repeat(20)}`).join('\n');
  const parts = splitMessage(long);
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 4096));
  assert.equal(parts.join('\n'), long);
  assert.equal(htmlToPlain('<b>a &amp; b</b>'), 'a & b');
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const noJunk = (s: string) => {
  for (const bad of ['NaN', 'undefined', 'null', 'Infinity', '[object']) assert.ok(!s.includes(bad), `« ${bad} » dans : ${s}`);
  assert.ok(s.length < 4096);
};

function stats(pnls: number[], open = 0) {
  const trades: LedgerTrade[] = pnls.map((p, i) => ({
    id: String(i), slug: 's', coin: 'BTC', side: 'UP', stake: 1, costPerShare: 0.6, shares: 1.66, modelProb: 0.68,
    edge: 0.08, openedAt: '2026-10-07T10:00:00Z', endMs: 0, status: p > 0 ? 'won' : 'lost', pnl: p,
    resolvedAt: `2026-10-07T10:${String(i % 60).padStart(2, '0')}:00Z`,
  }));
  for (let i = 0; i < open; i++) trades.push({ ...trades[0], id: `o${i}`, status: 'open', pnl: null });
  return computeStats(trades);
}

test('formats : montants signés, prix lisibles, heure de Paris', () => {
  assert.equal(money(0.4237), '+0,42 $');
  assert.equal(money(-1), '−1,00 $');
  assert.equal(money(0), '0,00 $');
  assert.equal(spotPrice(62345.1), '62 345,10 $');
  assert.equal(spotPrice(0.123456), '0,12346 $');
  // slot 1790000100 = 2026-09-21T14:15:00Z → 16:15 à Paris (UTC+2)
  assert.equal(roundWindow(1_790_000_100, 'Europe/Paris'), '16:15 → 16:20');
  assert.equal(escapeHtml('<a & b>'), '&lt;a &amp; b&gt;');
});

test('message de nouveau pari : tout ce qu\'il faut pour comprendre, rien d\'autre', () => {
  const m = msgTradeOpened({
    coin: 'BTC', side: 'UP', slotSec: 1_790_000_100, tauSec: 130, strike: 62345.1, spot: 62401.5,
    modelProb: 0.78, costPerShare: 0.6612, edge: 0.1188, stake: 0.5, winProfit: 0.2562, timeZone: 'Europe/Paris',
  });
  noJunk(m);
  assert.match(m, /NOUVEAU PARI — BTC ⬆️ HAUSSE/);
  assert.match(m, /16:15 → 16:20 · fin dans 2 min 10 s/);
  assert.match(m, /Prix à battre : 62 345,10 \$ · actuel : 62 401,50 \$ \(\+0,090 %\)/);
  assert.match(m, /Chance de gagner \(modèle\) : <b>78 %<\/b>/);
  assert.match(m, /Si gagné : <b>\+0,26 \$<\/b> · si perdu : <b>−0,50 \$<\/b>/);
});

test('messages de résultat, bilan, démarrage et alerte', () => {
  const st = stats([0.6, 0.6, -1, 0.6], 1);
  const won = msgTradeClosed({ coin: 'ETH', side: 'DOWN', slotSec: 1_790_000_100, outcome: 'won', pnl: 0.6, stats: st, timeZone: 'Europe/Paris' });
  noJunk(won);
  assert.match(won, /✅ <b>GAGNÉ<\/b> — ETH ⬇️ BAISSE · <b>\+0,60 \$<\/b>/);
  assert.match(won, /Bilan : 4 trades · 3 ✅ \/ 1 ❌ \(75 %\) · PnL \+0,80 \$/);
  const lost = msgTradeClosed({ coin: 'SOL', side: 'UP', slotSec: 1_790_000_100, outcome: 'lost', pnl: -1, stats: st });
  assert.match(lost, /❌ <b>PERDU<\/b>/);

  const sum = msgSummary(st, 50);
  noJunk(sum);
  assert.match(sum, /Trades terminés : 4 \(3 ✅ \/ 1 ❌\) · en cours : 1/);
  assert.match(sum, /Taux de réussite : 75 % · côté choisi gagnant à l'issue du round : 75 % pour 68 % annoncés par le modèle/);
  assert.match(sum, /capital : 50,80 \$/);
  assert.match(sum, /trop tôt pour conclure/);

  const start = msgStartup({ capital: 50, minEdge: 0.04, minProb: 0.6, feeRate: 0.07, pollSec: 10, coins: ['BTC', 'ETH'], stats: stats([]) });
  noJunk(start);
  assert.match(start, /mode PAPIER/);
  assert.match(start, /aucun trade pour l'instant/);
  assert.doesNotMatch(start, /Calibration/, 'modèle brut : rien à signaler');
  const tuned = msgStartup({ capital: 50, minEdge: 0.04, minProb: 0.6, feeRate: 0.07, pollSec: 10, coins: ['BTC'], stats: stats([]), zScale: 0.9, blendModel: 0.8, blendMarket: 0.3 });
  noJunk(tuned);
  assert.match(tuned, /Calibration : confiance du modèle ×0,9 · mélange modèle 0,8 \/ carnet 0,3/);
  assert.equal(msgAlert('a < b'), '⚠️ <b>ALERTE</b> — a &lt; b');
});

test('fiabilité : un PnL positif sur peu de trades n\'est jamais présenté comme une preuve', () => {
  assert.match(reliability({ n: 15, tStat: 3 }), /trop tôt/);
  assert.match(reliability({ n: 120, tStat: 2.5 }), /pas encore significatif/);
  assert.match(reliability({ n: 250, tStat: 2.4 }), /significatif ✅/);
  assert.match(reliability({ n: 250, tStat: -2.4 }), /perte statistiquement significative/);
});

test('fuseau invalide : jamais d\'exception, repli UTC signalé', () => {
  assert.equal(roundWindow(1_790_000_100, 'Mars/Olympus'), '14:15 → 14:20 UTC');
  noJunk(msgTradeClosed({ coin: 'BTC', side: 'UP', slotSec: 1_790_000_100, outcome: 'won', pnl: 1, stats: stats([1]), timeZone: 'pas/un/fuseau' }));
});

test('check : seules les pannes passagères sont marquées « à réessayer »', async () => {
  const blocked = (async () => new Response('Forbidden by proxy', { status: 403 })) as typeof fetch;
  assert.equal((await client(blocked).check()).retryable, true, 'proxy/pare-feu');
  assert.equal((await client(fakeTelegram(() => new Error('ECONNRESET')).fetchImpl).check()).retryable, true, 'réseau');
  assert.equal((await client(fakeTelegram(() => fail(502, 'Bad Gateway')).fetchImpl).check()).retryable, true, '5xx');
  assert.ok(!(await client(fakeTelegram(() => fail(401, 'Unauthorized')).fetchImpl).check()).retryable, 'token refusé : définitif');
  assert.ok(!(await client(fakeTelegram(m => (m === 'getMe' ? ok({ username: 'b' }) : fail(400, 'Bad Request: chat not found'))).fetchImpl).check()).retryable, 'chat introuvable : définitif');
});
