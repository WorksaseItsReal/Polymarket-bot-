import { useEffect, useState } from 'react';
import type { BotState } from '../types';
import { duration } from '../format';

interface HeaderProps {
  state: BotState | null;
  connected: boolean;
  onHistoryClick: () => void;
}

const LAYER_LABEL: Record<string, string> = {
  daily: 'perte du jour', monthly: 'perte du mois', drawdown: 'baisse depuis le plus haut', total: 'perte totale',
};

export function Header({ state, connected, onHistoryClick }: HeaderProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const risk = state?.risk;
  const block = state?.health.entryBlock ?? null;
  const status = !state
    ? { text: 'en attente du bot', cls: 'bg-gray-500/20 text-gray-300 border-gray-500/30' }
    : risk && !risk.allowed
      ? { text: `⏸️ entrées bloquées · ${LAYER_LABEL[risk.layer ?? ''] ?? risk.layer}`, cls: 'bg-red-500/20 text-red-300 border-red-500/30' }
      : block
        ? { text: `⏸️ entrées bloquées · ${block.slice(0, 60)}`, cls: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30' }
        : { text: '▶️ actif · évalue et parie', cls: 'bg-green-500/20 text-green-300 border-green-500/30' };

  return (
    <header className="border-b border-white/5 bg-poly-card/60 backdrop-blur px-4 py-3">
      <div className="max-w-[1800px] mx-auto flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500/30 to-green-500/30 flex items-center justify-center text-lg">📐</div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Polymarket paper bot — « Up or Down 5 min »</h1>
            <div className="text-xs text-gray-500">
              stratégie juste valeur · {state ? `démarré il y a ${duration(Math.max(0, now - state.startTime))}` : '—'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className={`px-3 py-1 rounded-full border text-xs font-medium ${status.cls}`}>{status.text}</span>
          <span className="flex items-center gap-2 text-xs">
            <span className={`status-dot ${connected ? 'status-dot-active' : 'status-dot-error'}`} />
            {connected ? 'connecté' : 'déconnecté'}
          </span>
          <button onClick={onHistoryClick} className="btn btn-secondary text-xs">Historique des sessions</button>
        </div>
      </div>
    </header>
  );
}
