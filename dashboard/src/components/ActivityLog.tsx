import { useMemo, useState } from 'react';
import type { LogEntry, LogLevel } from '../types';
import { clock } from '../format';

interface Props { logs: LogEntry[] }

const ICON: Record<LogLevel, string> = { INFO: '📋', WARN: '⚠️', ERROR: '❌', TRADE: '💰', SIGNAL: '🎯' };
const STYLE: Record<LogLevel, string> = {
  INFO: 'text-gray-400 bg-gray-500/10 border-gray-500/20',
  WARN: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
  ERROR: 'text-red-400 bg-red-500/10 border-red-500/20',
  TRADE: 'text-green-400 bg-green-500/10 border-green-500/20',
  SIGNAL: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
};
const FILTERS: Array<LogLevel | 'ALL'> = ['ALL', 'TRADE', 'SIGNAL', 'WARN', 'ERROR', 'INFO'];
const LABEL: Record<LogLevel | 'ALL', string> = { ALL: 'tout', TRADE: 'paris', SIGNAL: 'évaluations', WARN: 'avertissements', ERROR: 'erreurs', INFO: 'infos' };

export function ActivityLog({ logs }: Props) {
  const [filter, setFilter] = useState<LogLevel | 'ALL'>('ALL');
  const shown = useMemo(() => (filter === 'ALL' ? logs : logs.filter(l => l.level === filter)), [logs, filter]);
  return (
    <div className="panel flex flex-col h-[420px]">
      <div className="panel-header flex-shrink-0 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-header mb-0">
          <div className="section-header-icon bg-gradient-to-br from-gray-500/20 to-slate-500/20">📋</div>
          Journal <span className="text-sm font-normal text-gray-500 ml-2">({shown.length})</span>
        </h2>
        <div className="flex gap-1">
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)} className={`px-2 py-1 rounded-lg text-xs ${filter === f ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              {LABEL[f]}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body overflow-y-auto flex-1 space-y-1">
        {!shown.length && <div className="text-gray-500 text-sm">rien pour l'instant</div>}
        {shown.map(l => (
          <div key={l.id} className={`rounded-lg border px-2 py-1 text-xs font-mono flex gap-2 ${STYLE[l.level] ?? STYLE.INFO}`}>
            <span className="text-gray-600 flex-shrink-0">{clock(l.timestamp)}</span>
            <span className="flex-shrink-0">{ICON[l.level] ?? '•'}</span>
            <span className="break-words whitespace-pre-wrap">{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
