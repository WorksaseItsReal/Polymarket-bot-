import { useEffect, useState } from 'react';
import type { BotConfig, BotState } from '../types';
import { ago, pct } from '../format';

interface Props { state: BotState | null; config: BotConfig | null }

/** Dernière évaluation de chaque coin : probabilité du modèle, asks du carnet, décision et raison. */
export function EvaluationsPanel({ state, config }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);
  const coins = config?.coins ?? ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
  const byCoin = new Map((state?.fairValue.lastEvaluations ?? []).map(e => [e.coin, e]));
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <h2 className="section-header mb-0">
          <div className="section-header-icon bg-gradient-to-br from-purple-500/20 to-blue-500/20">🔍</div>
          Dernière évaluation par coin
        </h2>
      </div>
      <div className="panel-body space-y-2">
        {coins.map(coin => {
          const e = byCoin.get(coin);
          if (!e) {
            return (
              <div key={coin} className="rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2 text-sm flex justify-between">
                <span className="font-semibold">{coin}</span><span className="text-gray-500 text-xs">pas encore évalué</span>
              </div>
            );
          }
          const isBuy = e.act === 'buy';
          return (
            <div key={coin} className={`rounded-xl border px-3 py-2 text-sm ${isBuy ? 'bg-green-500/10 border-green-500/20' : 'bg-white/[0.03] border-white/5'}`}>
              <div className="flex justify-between items-center">
                <span className="font-semibold">{coin} <span className="text-gray-500 font-normal text-xs">τ {Math.round(e.tau)} s · {ago(e.t, now)}</span></span>
                <span className={`text-xs font-medium ${isBuy ? 'text-green-300' : 'text-gray-400'}`}>{isBuy ? `PARI ${e.side === 'UP' ? '⬆️' : '⬇️'}` : 'abstention'}</span>
              </div>
              <div className="font-mono text-xs text-gray-400 mt-1">
                P(hausse) modèle {pct(e.pUp)} · ask hausse {e.upAsk === null ? '—' : e.upAsk.toFixed(2)} · ask baisse {e.downAsk === null ? '—' : e.downAsk.toFixed(2)}
              </div>
              <div className="text-xs text-gray-500 mt-1 break-words">{e.reason}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
