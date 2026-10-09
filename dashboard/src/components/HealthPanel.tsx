import { useEffect, useState } from 'react';
import type { BotConfig, BotState } from '../types';
import { ago } from '../format';

interface Props { state: BotState | null; config: BotConfig | null }

function Row({ label, value, ok }: { label: string; value: string; ok: boolean | null }) {
  return (
    <div className="flex items-center justify-between text-sm py-1.5 border-b border-white/5 last:border-0">
      <span className="text-gray-400">{label}</span>
      <span className="flex items-center gap-2 font-mono text-xs">
        <span className={`status-dot ${ok === null ? 'status-dot-warning' : ok ? 'status-dot-active' : 'status-dot-error'}`} />
        {value}
      </span>
    </div>
  );
}

/** Santé du process : ce qui, s'il casse, empêche le bot de mesurer ou de parier. */
export function HealthPanel({ state, config }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);
  const h = state?.health;
  const pollSec = config?.pollSec ?? 10;
  const passAge = h ? now - h.lastFullPassAt : 0;
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <h2 className="section-header mb-0">
          <div className="section-header-icon bg-gradient-to-br from-cyan-500/20 to-blue-500/20">🩺</div>
          Santé
        </h2>
      </div>
      <div className="panel-body">
        {!h && <div className="text-gray-500 text-sm">en attente du bot</div>}
        {h && (
          <>
            <Row label="Passage complet de la stratégie" value={h.lastFullPassAt ? ago(h.lastFullPassAt, now) : 'pas encore'} ok={h.lastFullPassAt ? passAge < (2 * pollSec + 60) * 1000 : null} />
            <Row label="Marchés 5 min trouvés" value={h.lastMarketsFoundAt ? ago(h.lastMarketsFoundAt, now) : 'pas encore'} ok={h.lastMarketsFoundAt ? now - h.lastMarketsFoundAt < 5 * 60_000 : null} />
            <Row label="Spot temps réel (Binance)" value={h.spotStream === 'disabled' ? 'désactivé (REST)' : h.spotStream === 'live' ? 'connecté' : 'figé → repli REST'} ok={h.spotStream === 'disabled' ? null : h.spotStream === 'live'} />
            <Row label="Horloge du serveur" value={h.clockSkewMs === null ? 'non mesurée' : `${(h.clockSkewMs / 1000).toFixed(1)} s`} ok={h.clockSkewMs === null ? null : Math.abs(h.clockSkewMs) < 2000} />
            <Row label="Telegram" value={h.telegram === 'connected' ? 'connecté' : h.telegram === 'off' ? 'non configuré' : 'erreur'} ok={h.telegram === 'connected' ? true : h.telegram === 'off' ? null : false} />
            <Row label="Journal des décisions" value={h.journal ? 'actif' : 'désactivé'} ok={h.journal ? true : null} />
            <Row label="Passages en échec consécutifs" value={String(h.consecutiveTickFailures)} ok={h.consecutiveTickFailures < 3} />
          </>
        )}
      </div>
    </div>
  );
}
