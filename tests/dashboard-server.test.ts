/**
 * tests/dashboard-server.test.ts — le dashboard ne doit ni faire tomber le bot, ni se
 * laisser piloter depuis un autre site ou le réseau sans jeton.
 * Exécution : `npx tsx --test tests/dashboard-server.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { dashboardEmitter, originAllowed, startDashboard, stopDashboard } from '../src/dashboard/server.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rawRequest(port: number, raw: string): Promise<string> {
  const sock = connect(port, '127.0.0.1');
  await once(sock, 'connect');
  sock.write(raw);
  let data = '';
  sock.on('data', d => { data += d; });
  await Promise.race([once(sock, 'end'), sleep(1000)]);
  sock.destroy();
  return data;
}

test('originAllowed : même hôte (tout port) ou client non navigateur, jamais un autre site', () => {
  assert.equal(originAllowed(undefined, '127.0.0.1:3001'), true);
  assert.equal(originAllowed('http://127.0.0.1:3001', '127.0.0.1:3001'), true);
  assert.equal(originAllowed('http://127.0.0.1:5173', '127.0.0.1:3001'), true, 'mode dev vite');
  assert.equal(originAllowed('https://evil.example', '127.0.0.1:3001'), false);
  assert.equal(originAllowed('pas une url', '127.0.0.1:3001'), false);
});

test('requête malformée → 400, le serveur (et donc le bot) reste debout', async () => {
  const srv = startDashboard(0, { host: '127.0.0.1' });
  await once(srv, 'listening');
  const port = (srv.address() as { port: number }).port;
  try {
    const bad = await rawRequest(port, 'GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.match(bad, /^HTTP\/1\.1 400/);
    const enc = await rawRequest(port, 'GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.match(enc, /^HTTP\/1\.1 (400|404)/);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'plus de CORS *');
    const trav = await rawRequest(port, 'GET /../../package.json HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.doesNotMatch(trav, /"name": "@catalyst-team\/poly-sdk"/, 'aucun fichier hors dashboard/dist');
  } finally {
    await stopDashboard();
  }
});

test('WebSocket : Origin étranger refusé ; jeton exigé ; commandes relayées au bot', async () => {
  const srv = startDashboard(0, { host: '127.0.0.1', token: 's3cret' });
  await once(srv, 'listening');
  const port = (srv.address() as { port: number }).port;
  const cmds: unknown[] = [];
  const onCmd = (c: unknown) => cmds.push(c);
  dashboardEmitter.on('command', onCmd);
  const open = (path: string, origin?: string) => new Promise<boolean>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
  try {
    assert.equal(await open('/'), false, 'sans jeton');
    assert.equal(await open('/?token=faux'), false, 'mauvais jeton');
    assert.equal(await open('/?token=s3cret', 'https://evil.example'), false, 'autre site');
    assert.equal(await open('/?token=s3cret', `http://127.0.0.1:${port}`), true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state?token=s3cret`)).status, 200);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=s3cret`);
    await once(ws, 'open');
    ws.send('pas du json');
    ws.send(JSON.stringify({ type: 'command', command: 'toggleDryRun', payload: { enabled: true } }));
    await sleep(100);
    ws.close();
    assert.deepEqual(cmds, [{ command: 'toggleDryRun', payload: { enabled: true } }]);
  } finally {
    dashboardEmitter.off('command', onCmd);
    await stopDashboard();
  }
});

test('exposé au réseau SANS jeton : lecture seule, commandes refusées', async () => {
  const srv = startDashboard(0, { host: '0.0.0.0' });
  await once(srv, 'listening');
  const port = (srv.address() as { port: number }).port;
  const cmds: unknown[] = [];
  const onCmd = (c: unknown) => cmds.push(c);
  dashboardEmitter.on('command', onCmd);
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'command', command: 'toggleDryRun', payload: { enabled: false } }));
    await sleep(100);
    ws.close();
    assert.deepEqual(cmds, []);
  } finally {
    console.warn = warn;
    dashboardEmitter.off('command', onCmd);
    await stopDashboard();
  }
});

test('port déjà pris : erreur journalisée, pas de crash', async () => {
  const a = startDashboard(0, { host: '127.0.0.1' });
  await once(a, 'listening');
  const port = (a.address() as { port: number }).port;
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...m: unknown[]) => { errs.push(m.join(' ')); };
  try {
    const b = startDashboard(port, { host: '127.0.0.1' });
    await sleep(200);
    assert.ok(errs.some(e => /Impossible d'écouter/.test(e)), errs.join('\n'));
    b.close();
  } finally {
    console.error = orig;
    a.close();
  }
});
