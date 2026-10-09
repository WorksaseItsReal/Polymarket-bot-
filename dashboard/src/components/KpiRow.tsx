import type { BotState } from '../types';
import { amount, money, num, pct, pnlClass } from '../format';

interface Props { state: BotState | null }

function Tile({ label, value, sub, cls = 'text-white' }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="glass-card rounded-2xl px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-2xl font-mono font-bold mt-1 ${cls}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

/** Chiffres clés — tous issus du registre papier (toutes sessions), jamais estimés. */
export function KpiRow({ state }: Props) {
  const l = state?.ledger;
  const r = state?.risk;
  const pnl = l?.pnl ?? 0;
  const reliability = l && l.tStat !== null && l.trades >= 30
    ? (Math.abs(l.tStat) >= 2 ? `t = ${num(l.tStat)} · ${l.tStat > 0 ? 'gain' : 'perte'} significatif` : `t = ${num(l.tStat)} · pas encore significatif`)
    : 'trop tôt pour conclure (≥ 30 trades)';
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      <Tile label="Capital papier" value={state ? amount(r?.currentCapital ?? state.capital) : '—'} sub={state ? `départ ${amount(state.capital)}` : undefined} />
      <Tile label="PnL réalisé" value={state ? money(pnl) : '—'} sub={reliability} cls={pnlClass(pnl)} />
      <Tile label="Aujourd'hui (UTC)" value={state ? money(r?.pnlToday ?? 0) : '—'} sub={state ? `ce mois : ${money(r?.pnlMonth ?? 0)}` : undefined} cls={pnlClass(r?.pnlToday ?? 0)} />
      <Tile label="Trades réglés" value={state ? String(l?.trades ?? 0) : '—'} sub={l ? `${l.wins} ✅ / ${l.losses} ❌ · réussite ${pct(l.winRate)}` : undefined} />
      <Tile label="En cours" value={state ? String(l?.open ?? 0) : '—'} sub={l ? `exposition ${amount(l.openExposure)}` : undefined} />
      <Tile label="Baisse depuis le plus haut" value={state ? pct(r?.drawdown ?? 0, 1) : '—'} sub={r ? `plus haut ${amount(r.peakCapital)}` : undefined} cls={(r?.drawdown ?? 0) >= 0.1 ? 'text-yellow-400' : 'text-white'} />
    </div>
  );
}
