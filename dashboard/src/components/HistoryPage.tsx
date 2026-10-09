import { useEffect, useState } from 'react';
import type { HistoryData, SessionSummary } from '../types';
import { apiUrl } from '../hooks/useWebSocket';
import { amount, dateTime, duration, money, pnlClass } from '../format';

interface Props { onBack: () => void }

/** Sessions passées (session-history.json) : PnL réglé pendant chaque session, trades, réussite. */
export function HistoryPage({ onBack }: Props) {
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(apiUrl('/api/history'))
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: HistoryData) => setHistory(d))
      .catch(() => setError('Historique indisponible — le bot tourne-t-il ?'));
  }, []);

  const open = async (id: string) => {
    try {
      const r = await fetch(apiUrl(`/api/history/${encodeURIComponent(id)}`));
      if (r.ok) setSelected(await r.json());
    } catch { /* affichage seulement */ }
  };

  return (
    <div className="min-h-screen bg-poly-dark text-white">
      <header className="border-b border-white/5 px-4 py-3 flex items-center gap-3">
        <button onClick={onBack} className="btn btn-secondary text-xs">← Retour</button>
        <h1 className="text-lg font-semibold">Historique des sessions</h1>
      </header>
      <main className="p-4 max-w-[1400px] mx-auto space-y-4">
        {error && <div className="text-red-400 text-sm">{error}</div>}
        {history && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              ['Sessions', String(history.totalSessions)],
              ['PnL cumulé', money(history.totalProfit)],
              ['Trades', String(history.totalTrades)],
              ['Réussite', history.totalTrades ? `${history.overallWinRate.toFixed(0)} %` : '—'],
            ].map(([k, v]) => (
              <div key={k} className="glass-card rounded-2xl px-4 py-3">
                <div className="text-[11px] uppercase tracking-wider text-gray-500">{k}</div>
                <div className="text-xl font-mono font-bold mt-1">{v}</div>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="panel">
            <div className="panel-header"><h2 className="section-header mb-0">Sessions</h2></div>
            <div className="panel-body space-y-2">
              {history && !history.sessions.length && <div className="text-gray-500 text-sm">aucune session enregistrée (le bilan est écrit à l'arrêt du bot, s'il y a eu de l'activité)</div>}
              {history?.sessions.map(s => (
                <button key={s.id} onClick={() => open(s.id)} className={`w-full text-left rounded-xl border px-3 py-2 text-sm ${selected?.id === s.id ? 'bg-white/10 border-white/20' : 'bg-white/[0.03] border-white/5 hover:bg-white/5'}`}>
                  <div className="flex justify-between">
                    <span>{dateTime(s.startTime)} · {duration(s.durationMs)}</span>
                    <span className={`font-mono ${pnlClass(s.totalPnL)}`}>{money(s.totalPnL)}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">{s.totalTrades} trades · {s.wins} ✅ / {s.losses} ❌ · {amount(s.startingBalance)} → {amount(s.endingBalance)}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="panel">
            <div className="panel-header"><h2 className="section-header mb-0">Détail</h2></div>
            <div className="panel-body">
              {!selected && <div className="text-gray-500 text-sm">choisir une session</div>}
              {selected && (
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2 font-mono text-xs text-gray-300">
                    <div>PnL : <span className={pnlClass(selected.totalPnL)}>{money(selected.totalPnL)}</span></div>
                    <div>moyen / trade : {money(selected.avgProfitPerTrade)}</div>
                    <div>meilleur : {money(selected.largestWin)}</div>
                    <div>pire : {money(selected.largestLoss)}</div>
                  </div>
                  <div className="space-y-1 max-h-[420px] overflow-y-auto">
                    {selected.trades.map(t => (
                      <div key={t.id} className="flex justify-between font-mono text-xs rounded-lg bg-white/[0.03] px-2 py-1">
                        <span className="text-gray-400">{dateTime(t.timestamp)} · {t.market}</span>
                        <span className={pnlClass(t.profit)}>{money(t.profit)}</span>
                      </div>
                    ))}
                    {!selected.trades.length && <div className="text-gray-500 text-xs">aucun trade réglé pendant cette session</div>}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
