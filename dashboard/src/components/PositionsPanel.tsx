import { useEffect, useState } from 'react';
import type { BotState } from '../types';
import { amount, duration, pct } from '../format';

interface Props { state: BotState | null }

/** Paris en cours (registre papier) : mise, coût réel par part, gain si gagné, fin du round. */
export function PositionsPanel({ state }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const positions = state?.fairValue.openPositions ?? [];
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <h2 className="section-header mb-0">
          <div className="section-header-icon bg-gradient-to-br from-green-500/20 to-blue-500/20">🎯</div>
          Paris en cours <span className="text-sm font-normal text-gray-500 ml-2">({positions.length})</span>
        </h2>
      </div>
      <div className="panel-body">
        {!positions.length && <div className="text-gray-500 text-sm">aucun pari ouvert — le bot s'abstient tant que le carnet est juste</div>}
        <div className="space-y-2">
          {positions.map(p => {
            const left = p.endMs - now;
            const winProfit = p.shares - p.stake;
            return (
              <div key={`${p.coin}-${p.endMs}`} className="rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2 text-sm">
                <div className="flex justify-between items-center">
                  <span className="font-semibold">{p.coin} {p.side === 'UP' ? '⬆️ hausse' : '⬇️ baisse'}</span>
                  <span className={`font-mono text-xs ${left < 0 ? 'text-yellow-300' : 'text-gray-400'}`}>{left < 0 ? 'règlement en attente' : `fin dans ${duration(left)}`}</span>
                </div>
                <div className="text-xs text-gray-400 mt-1 font-mono">
                  mise {amount(p.stake)} · {p.costPerShare.toFixed(3).replace('.', ',')} $/part · modèle {pct(p.modelProb)} · si gagné <span className="text-green-400">+{amount(winProfit)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
