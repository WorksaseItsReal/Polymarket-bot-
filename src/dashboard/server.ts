/**
 * Dashboard Server - Express + WebSocket server for real-time monitoring
 * 
 * Usage:
 *   import { startDashboard } from './src/dashboard/server.js';
 *   startDashboard(3001);
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { dashboardEmitter } from './state-emitter.js';
import type { WebSocketMessage } from './types.js';
import { loadHistory, getSession } from './session-history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;

function broadcast(message: WebSocketMessage): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      // ⚠️ `send()` peut lever si la socket est fermée entre le test de
      // `readyState` et l'appel. Sans ce try/catch, l'exception remonte dans le
      // handler synchrone de `dashboardEmitter.emit('state', …)` — donc dans le
      // chemin d'appel de `updateState()` côté bot, et peut interrompre une
      // itération de la boucle de trading. Un problème d'affichage ne doit
      // JAMAIS pouvoir casser le bot.
      try {
        client.send(data);
      } catch (err) {
        console.error('[Dashboard] send failed:', (err as Error).message);
      }
    }
  });
}

export interface DashboardOptions {
  /** Interface d'écoute. Défaut 127.0.0.1 : le dashboard n'est PAS exposé au réseau. */
  host?: string;
  /** Jeton exigé (?token=…) pour l'API et le WebSocket. Obligatoire pour accepter des
   *  commandes quand le dashboard écoute ailleurs qu'en local. */
  token?: string;
}

/** Hôte local (boucle) ? */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Comparaison en temps constant (le jeton ne doit pas fuiter par la durée). */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Une page web d'un AUTRE site ne doit pas pouvoir piloter le bot depuis le navigateur
 * de l'opérateur (WebSocket non soumis au CORS). On accepte : pas d'Origin (client non
 * navigateur) ou un Origin du même nom d'hôte que la requête (ports libres : mode dev).
 */
export function originAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true;
  try {
    const o = new URL(origin).hostname;
    const h = new URL(`http://${hostHeader ?? ''}`).hostname;
    return !!h && o === h;
  } catch {
    return false;
  }
}

export function startDashboard(port = 3001, opts: DashboardOptions = {}): http.Server {
  const host = opts.host || '127.0.0.1';
  const token = opts.token || '';
  // Commandes (bascule de mode, fermeture de position…) : autorisées en local, ou avec jeton.
  const commandsAllowed = isLoopback(host) || !!token;
  if (!commandsAllowed) {
    console.warn(`[Dashboard] Écoute sur ${host} SANS DASHBOARD_TOKEN : lecture seule, commandes refusées.`);
  }
  const tokenOk = (url: URL) => !token || sameToken(url.searchParams.get('token') ?? '', token);

  server = http.createServer((req, res) => {
    // Une requête malformée ne doit JAMAIS faire tomber le bot (avant : `new URL` levait
    // dans le handler → exception non rattrapée → arrêt du process).
    try {
      handleHttp(req, res);
    } catch (err) {
      try {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad request' }));
      } catch { /* socket déjà fermée */ }
      console.error('[Dashboard] requête rejetée :', (err as Error).message);
    }
  });

  const handleHttp = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // Pas d'en-tête CORS : le dashboard est servi par ce même serveur (même origine).
    // Avant : `Access-Control-Allow-Origin: *` laissait n'importe quel site lire l'état.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);
    if (url.pathname.startsWith('/api/') && !tokenOk(url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token requis' }));
      return;
    }

    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getFullData()));
      return;
    }

    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getState()));
      return;
    }

    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getConfig()));
      return;
    }

    if (url.pathname === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getLogs()));
      return;
    }

    // History API endpoints
    if (url.pathname === '/api/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadHistory()));
      return;
    }

    if (url.pathname.startsWith('/api/history/')) {
      const sessionId = url.pathname.replace('/api/history/', '');
      const session = getSession(sessionId);
      if (session) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
      }
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    // Serve static files from dashboard/dist
    const distPath = path.resolve(__dirname, '../../dashboard/dist');
    const filePath = path.resolve(distPath, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    const insideDist = filePath === distPath || filePath.startsWith(distPath + path.sep);

    // Check if file exists (jamais en dehors de dashboard/dist)
    if (insideDist && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback - serve index.html for all other routes
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };

  wss = new WebSocketServer({
    server,
    verifyClient: (info: { origin?: string; req: http.IncomingMessage }) => {
      try {
        const url = new URL(info.req.url || '/', 'http://localhost');
        return originAllowed(info.origin, info.req.headers.host) && tokenOk(url);
      } catch {
        return false;
      }
    },
  });
  // Erreur du serveur WS (ex. port déjà pris) : journalisée, jamais fatale.
  wss.on('error', (err) => {
    console.error('[Dashboard] WebSocket server error:', err.message);
  });
  server.on('error', (err) => {
    console.error(`[Dashboard] Impossible d'écouter sur ${host}:${port} (${err.message}) — le bot continue SANS dashboard.`);
  });

  wss.on('connection', (ws) => {
    console.log('[Dashboard] Client connected');

    // Send full state on connect
    ws.send(JSON.stringify({
      type: 'full',
      payload: dashboardEmitter.getFullData(),
    } as WebSocketMessage));

    // Handle incoming messages (commands)
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message?.type === 'command' && !commandsAllowed) {
          console.warn('[Dashboard] Commande refusée : dashboard exposé sans DASHBOARD_TOKEN (lecture seule).');
          return;
        }
        if (message?.type === 'command' && typeof message.command === 'string') {
          console.log(`[Dashboard] Command received: ${message.command}`, message.payload);
          dashboardEmitter.emit('command', { command: message.command, payload: message.payload });
        }
      } catch (e) {
        console.error('[Dashboard] Failed to parse message:', e);
      }
    });

    ws.on('close', () => {
      console.log('[Dashboard] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[Dashboard] WebSocket error:', err.message);
    });
  });

  // Subscribe to state changes
  dashboardEmitter.on('state', (state) => {
    broadcast({ type: 'state', payload: state });
  });

  dashboardEmitter.on('log', (entry) => {
    broadcast({ type: 'log', payload: entry });
  });

  dashboardEmitter.on('config', (config) => {
    broadcast({ type: 'config', payload: config });
  });

  server.listen(port, host, () => {
    console.log(`[Dashboard] Server running at http://${host}:${port}${token ? ' (jeton requis : ?token=…)' : ''}`);
  });

  return server;
}

export function stopDashboard(): Promise<void> {
  return new Promise((resolve) => {
    if (wss) {
      wss.close();
      wss = null;
    }
    if (server) {
      server.close(() => {
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export { dashboardEmitter };
