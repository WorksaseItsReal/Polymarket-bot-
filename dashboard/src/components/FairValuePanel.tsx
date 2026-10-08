import type { BotState } from '../types';

interface FairValuePanelProps {
  state: BotState | null;
}

const money = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;

/**
 * Stratégie juste valeur (celle qui tourne) : résultats RÉELS du registre papier, mesure
 * « modèle vs carnet » et critères à remplir avant d'envisager l'argent réel — les mêmes
 * lignes que le bilan Telegram.
 */
export function FairValuePanel({ state }: FairValuePanelProps) {
  const ledger = state?.ledger;
  const summary = state?.fairValueSummary;
  const now = Date.now();
  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="section-header mb-0">
          <div className="section-header-icon bg-gradient-to-br from-blue-500/20 to-green-500/20">📐</div>
          Stratégie juste valeur (papier)
        </h2>
      </div>
      <div className="panel-body space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold font-mono text-white">{ledger?.trades ?? 0}</div>
            <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Trades réglés</div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-purple-400">
              {ledger?.winRate != null ? `${(ledger.winRate * 100).toFixed(0)}%` : '—'}
            </div>
            <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Réussite</div>
          </div>
          <div>
            <div className={`text-2xl font-bold font-mono ${(ledger?.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {money(ledger?.pnl ?? 0)}
            </div>
            <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">PnL réalisé</div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-gray-300">
              {ledger?.tStat != null ? ledger.tStat.toFixed(2) : '—'}
            </div>
            <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">t (≥ 2 = significatif)</div>
          </div>
        </div>
        <div className="text-sm text-gray-300 leading-relaxed">{summary?.shadow ?? '—'}</div>
        <div className="text-sm text-gray-300 leading-relaxed">{summary?.goLive ?? '—'}</div>
        {summary && summary.openPositions.length > 0 && (
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Positions ouvertes</div>
            <div className="space-y-1">
              {summary.openPositions.map((p, i) => (
                <div key={i} className="flex justify-between text-sm font-mono text-gray-300">
                  <span>{p.coin} {p.side === 'UP' ? '⬆️' : '⬇️'}</span>
                  <span>${p.stake.toFixed(2)} @ {p.costPerShare.toFixed(3)}</span>
                  <span className="text-gray-500">fin dans {Math.max(0, Math.round((p.endMs - now) / 1000))} s</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
