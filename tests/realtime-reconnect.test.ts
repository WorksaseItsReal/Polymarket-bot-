/**
 * tests/realtime-reconnect.test.ts — le flux temps réel Polymarket ne doit JAMAIS
 * reconnecter en rafale (bug de la librairie : reconnexion sans délai sur error ET close).
 * Exécution : `npx tsx --test tests/realtime-reconnect.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { RealtimeServiceV2 } from '../src/services/realtime-service-v2.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function closedPort(): Promise<number> {
  const srv = createServer();
  srv.listen(0);
  await once(srv, 'listening');
  const port = (srv.address() as { port: number }).port;
  srv.close();
  await once(srv, 'close');
  return port;
}

test('port refusé : tentatives espacées (1 s, 2 s…), pas de rafale', async () => {
  const port = await closedPort();
  const rt = new RealtimeServiceV2({ wsHost: `ws://127.0.0.1:${port}`, orderbookSource: 'rest' });
  let connecting = 0;
  rt.on('statusChange', (s: string) => { if (s === 'CONNECTING' || s === 'connecting') connecting++; });
  const origError = console.error;
  console.error = () => undefined; // la librairie journalise chaque échec
  try {
    rt.connect();
    await sleep(2500);
    // t=0 première tentative, t≈1 s, t≈3 s → au plus 3 sur 2,5 s (la librairie seule en faisait des milliers)
    assert.ok(connecting >= 2 && connecting <= 3, `${connecting} tentatives en 2,5 s`);
  } finally {
    rt.disconnect();
    console.error = origError;
  }
  const after = connecting;
  await sleep(1500);
  assert.equal(connecting, after, 'plus aucune tentative après disconnect()');
});

test('serveur qui coupe : reconnexion, puis remise à zéro du délai une fois connecté', async () => {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const port = (wss.address() as { port: number }).port;
  let conns = 0;
  wss.on('connection', c => { conns++; if (conns === 1) setTimeout(() => c.terminate(), 50); });
  const rt = new RealtimeServiceV2({ wsHost: `ws://127.0.0.1:${port}`, orderbookSource: 'rest' });
  const origError = console.error;
  console.error = () => undefined;
  try {
    rt.connect();
    await sleep(1600);
    assert.equal(conns, 2, 'une seule reconnexion après la coupure');
  } finally {
    rt.disconnect();
    console.error = origError;
    wss.close();
  }
});
