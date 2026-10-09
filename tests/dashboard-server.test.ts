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
import { dashboardEmitter, hostAllowed, originAllowed, startDashboard, stopDashboard } from '../src/dashboard/server.ts';

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
    const bad = await rawRequest(port, 'GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    assert.match(bad, /^HTTP\/1\.1 400/);
    const enc = await rawRequest(port, 'GET /%E0%A4%A HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    assert.match(enc, /^HTTP\/1\.1 (400|404)/);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'plus de CORS *');
    const trav = await rawRequest(port, 'GET /../../package.json HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
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

test('exposé au réseau SANS jeton : repli sur l\'écoute locale (rien n\'est lisible depuis le réseau)', async () => {
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...m: unknown[]) => { warns.push(m.join(' ')); };
  try {
    const srv = startDashboard(0, { host: '0.0.0.0' });
    await once(srv, 'listening');
    assert.equal((srv.address() as { address: string }).address, '127.0.0.1');
    assert.ok(warns.some(w => /exige DASHBOARD_TOKEN/.test(w)));
  } finally {
    console.warn = warn;
    await stopDashboard();
  }
});

test('DNS rebinding : sans jeton, un en-tête Host étranger est refusé (HTTP et WebSocket)', async () => {
  assert.equal(hostAllowed('127.0.0.1:3001', false), true);
  assert.equal(hostAllowed('localhost:3001', false), true);
  assert.equal(hostAllowed('[::1]:3001', false), true);
  assert.equal(hostAllowed('attacker.example', false), false);
  assert.equal(hostAllowed(undefined, false), false);
  assert.equal(hostAllowed('attacker.example', true), true, 'avec jeton, le jeton protège');
  const srv = startDashboard(0, { host: '127.0.0.1' });
  await once(srv, 'listening');
  const port = (srv.address() as { port: number }).port;
  const cmds: unknown[] = [];
  const onCmd = (c: unknown) => cmds.push(c);
  dashboardEmitter.on('command', onCmd);
  try {
    const http = await rawRequest(port, 'GET /api/status HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n');
    assert.match(http, /^HTTP\/1\.1 403/);
    const ok = await rawRequest(port, `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.match(ok, /^HTTP\/1\.1 200/);
    const opened = await new Promise<boolean>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Host: 'attacker.example' }, origin: 'http://attacker.example' });
      ws.on('open', () => { ws.send(JSON.stringify({ type: 'command', command: 'toggleDryRun', payload: { enabled: false } })); setTimeout(() => { ws.close(); resolve(true); }, 50); });
      ws.on('error', () => resolve(false));
    });
    assert.equal(opened, false);
    assert.deepEqual(cmds, []);
  } finally {
    dashboardEmitter.off('command', onCmd);
    await stopDashboard();
  }
});

test('message WebSocket géant refusé (pas de blocage de la boucle d\'événements)', async () => {
  const srv = startDashboard(0, { host: '127.0.0.1' });
  await once(srv, 'listening');
  const port = (srv.address() as { port: number }).port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    await once(ws, 'open');
    const closed = once(ws, 'close');
    ws.send('x'.repeat(100_000));
    const [code] = await closed;
    assert.equal(code, 1009, 'message trop gros');
  } finally {
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

test('stopDashboard : se termine même avec un client WebSocket encore connecté', async () => {
  const srv = startDashboard(0, { host: '127.0.0.1' });
  await once(srv, 'listening');
  const port = (srv.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await once(ws, 'open');
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('stopDashboard bloqué par un client connecté')), 3000); });
  try {
    await Promise.race([stopDashboard(), guard]);
  } finally {
    clearTimeout(timer);
  }
  await Promise.race([once(ws, 'close'), sleep(1000)]);
  assert.notEqual(ws.readyState, WebSocket.OPEN, 'client coupé par l\'arrêt');
});
