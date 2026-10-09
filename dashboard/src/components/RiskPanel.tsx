import type { BotState, RiskLayer } from '../types';
import { amount, dateTime, money, pct } from '../format';

interface Props { state: BotState | null }

/** Les quatre couches de perte, recalculées depuis le registre à chaque passage. */
export function RiskPanel({ state }: Props) {
  const r = state?.risk;
  const cap = state?.capital ?? 0;
  const rows: Array<{ key: RiskLayer; label: string; value: number; limit: number; valueText: string; limitText: string; until: string }> = r ? [
    { key: 'daily', label: 'Perte du jour (UTC)', value: -r.pnlToday, limit: cap * r.limits.dailyMaxLossPct, valueText: money(r.pnlToday), limitText: `−${amount(cap * r.limits.dailyMaxLossPct)}`, until: 'jusqu\'à minuit UTC' },
    { key: 'monthly', label: 'Perte du mois (UTC)', value: -r.pnlMonth, limit: cap * r.limits.monthlyMaxLossPct, valueText: money(r.pnlMonth), limitText: `−${amount(cap * r.limits.monthlyMaxLossPct)}`, until: 'jusqu\'au 1er du mois' },
    { key: 'drawdown', label: 'Baisse depuis le plus haut', value: r.drawdown, limit: r.limits.maxDrawdownFromPeak, valueText: pct(r.drawdown, 1), limitText: pct(r.limits.maxDrawdownFromPeak), until: 'décision manuelle' },
    { key: 'total', label: 'Perte totale', value: -(r.currentCapital - cap), limit: cap * r.limits.totalMaxLossPct, valueText: money(r.currentCapital - cap), limitText: `−${amount(cap * r.limits.totalMaxLossPct)}`, until: 'définitif' },
  ] : [];
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <h2 className="section-header mb-0">
          <div className="section-header-icon bg-gradient-to-br from-red-500/20 to-yellow-500/20">🛡️</div>
          Porte de risque
        </h2>
      </div>
      <div className="panel-body space-y-3">
        {!r && <div className="text-gray-500 text-sm">en attente du bot</div>}
        {r && (
          <div className={`rounded-xl px-3 py-2 text-sm border ${r.allowed ? 'bg-green-500/10 border-green-500/20 text-green-300' : 'bg-red-500/10 border-red-500/20 text-red-300'}`}>
            {r.allowed ? '▶️ nouvelles entrées autorisées' : `⏸️ ${r.reason}`}
            {r.until && <div className="text-xs text-gray-400 mt-1">reprise : {dateTime(r.until)}</div>}
          </div>
        )}
        {rows.map(row => {
          const used = row.limit > 0 ? Math.min(1, Math.max(0, row.value / row.limit)) : 0;
          const hit = r?.layer === row.key;
          return (
            <div key={row.key}>
              <div className="flex justify-between text-xs mb-1">
                <span className={hit ? 'text-red-300 font-medium' : 'text-gray-300'}>{row.label}</span>
                <span className="font-mono text-gray-400">{row.valueText} / {row.limitText}</span>
              </div>
              <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div className={`h-full rounded-full ${used >= 1 ? 'progress-gradient-red' : used >= 0.6 ? 'progress-gradient-yellow' : 'progress-gradient-green'}`} style={{ width: `${used * 100}%` }} />
              </div>
              <div className="text-[11px] text-gray-600 mt-0.5">si atteinte : plus d'entrée {row.until}</div>
            </div>
          );
        })}
        {state?.health.entryBlock && (
          <div className="rounded-xl px-3 py-2 text-xs border bg-yellow-500/10 border-yellow-500/20 text-yellow-200">
            Entrées aussi bloquées par : {state.health.entryBlock}
          </div>
        )}
        <div className="text-[11px] text-gray-600">
          Les positions ouvertes restent suivies, réglées et revendues : seule l'ouverture de nouveaux paris est bloquée.
        </div>
      </div>
    </div>
  );
}
