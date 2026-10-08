import { useState, useEffect, useCallback, useRef } from 'react';
import type { BotState, BotConfig, LogEntry, DashboardData } from '../types';

interface WebSocketMessage {
  type: 'state' | 'log' | 'config' | 'full';
  payload: unknown;
}

// Connect to same host:port when served by bot, or port 3001 for dev.
// Jeton éventuel (DASHBOARD_TOKEN côté bot) : repris de l'URL de la page (?token=…).
export const DASHBOARD_TOKEN = new URLSearchParams(window.location.search).get('token') ?? '';
const TOKEN_QS = DASHBOARD_TOKEN ? `?token=${encodeURIComponent(DASHBOARD_TOKEN)}` : '';
const WS_URL = (window.location.port === '5173'
  ? `ws://${window.location.hostname}:3001`
  : `ws://${window.location.host}`) + TOKEN_QS;
/** Base de l'API du bot (même hôte que la page, ou :3001 en dev). */
export const API_BASE = window.location.port === '5173'
  ? `http://${window.location.hostname}:3001`
  : `${window.location.protocol}//${window.location.host}`;
export const apiUrl = (path: string) => `${API_BASE}${path}${TOKEN_QS}`;
const MAX_LOGS = 200;

export function useWebSocket() {
  const [state, setState] = useState<BotState | null>(null);
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        console.log('[Dashboard] Connected to bot');
        setConnected(true);
        setError(null);
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);

          switch (message.type) {
            case 'full': {
              const data = message.payload as DashboardData;
              if (data.state) setState(data.state);
              if (data.config) setConfig(data.config);
              if (data.logs) setLogs(data.logs.slice(0, MAX_LOGS));
              break;
            }
            case 'state':
              setState(message.payload as BotState);
              break;
            case 'config':
              setConfig(message.payload as BotConfig);
              break;
            case 'log':
              setLogs((prev) => {
                const newLogs = [message.payload as LogEntry, ...prev];
                return newLogs.slice(0, MAX_LOGS);
              });
              break;
          }
        } catch (e) {
          console.error('[Dashboard] Failed to parse message:', e);
        }
      };

      ws.onclose = () => {
        // Socket remplacée ou composant démonté : ne pas reconnecter (avant : une fermeture
        // tardive relançait une 2e connexion → chaque journal affiché deux fois).
        if (wsRef.current !== ws) return;
        console.log('[Dashboard] Disconnected, reconnecting...');
        setConnected(false);
        wsRef.current = null;

        reconnectTimeoutRef.current = window.setTimeout(() => {
          connect();
        }, 3000);
      };

      ws.onerror = () => {
        setError('Connection failed. Is the bot running?');
        setConnected(false);
      };

      wsRef.current = ws;
    } catch (e) {
      setError(`Failed to connect: ${e}`);
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const ws = wsRef.current;
      wsRef.current = null; // avant close() : son onclose saura qu'il ne doit pas reconnecter
      ws?.close();
    };
  }, [connect]);

  const sendCommand = (command: string, payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'command', command, payload }));
    } else {
      console.error('[Dashboard] Cannot send command, WebSocket not connected');
    }
  };

  return { state, config, logs, connected, error, sendCommand };
}
