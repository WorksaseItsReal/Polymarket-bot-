import type { BotState } from '../types';
import { num, pct } from '../format';

interface Props { state: BotState | null }

/**
 * La stratégie qui tourne : calibration réelle, mesure « modèle vs carnet » et critères à
 * remplir avant d'envisager l'argent réel — les mêmes lignes que le bilan Telegram.
 */
export function FairValuePanel({ state }: Props) {
  const l = state?.ledger;
  const fv = state?.fairValue;
  const sh = fv?.shadowStats ?? null;
  const shadowCls = !sh || sh.tDiff === null || sh.n < 500 ? 'text-gray-300' : sh.tDiff <= -2 ? 'text-green-400' : sh.tDiff >= 2 ? 'text-red-400' : 'text-yellow-300';
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <h2 className="section-header mb-0">
          <div className="section-header-icon bg-gradient-to-br from-blue-500/20 to-green-500/20">📐</div>
          Le modèle voit-il quelque chose que le marché ne voit pas ?
        </h2>
      </div>
      <div className="panel-body space-y-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Modèle vs carnet (tous les rounds observés)</div>
          <div className={`font-mono text-sm ${shadowCls}`}>{fv?.shadow ?? '—'}</div>
          <div className="text-xs text-gray-500 mt-1">
            t ≤ −2 sur ≥ 500 rounds : le modèle prédit mieux que les prix Polymarket → continuer. t ≥ +2 : le carnet prédit mieux → aucun réglage ne rendra la stratégie rentable.
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Avant le réel</div>
          <div className="font-mono text-sm text-gray-200 whitespace-pre-wrap">{fv?.goLive ?? '—'}</div>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-xl font-mono font-bold">{l ? String(l.calibN) : '—'}</div>
            <div className="text-[11px] uppercase tracking-wider text-gray-500 mt-1">trades à issue connue</div>
          </div>
          <div>
            <div className="text-xl font-mono font-bold">{pct(l?.calibWinRate)}</div>
            <div className="text-[11px] uppercase tracking-wider text-gray-500 mt-1">côté choisi gagnant</div>
          </div>
          <div>
            <div className="text-xl font-mono font-bold">{pct(l?.avgModelProb)}</div>
            <div className="text-[11px] uppercase tracking-wider text-gray-500 mt-1">annoncé par le modèle</div>
          </div>
        </div>
        <div className="text-xs text-gray-500">
          Calibration : le taux de réussite doit rejoindre la probabilité annoncée. Une réussite nettement en dessous = modèle trop confiant (le garde-fou bloque les entrées si c'est significatif).
          {l && l.tStat !== null && <span> · PnL par trade : t = {num(l.tStat)} sur {l.trades} trades.</span>}
        </div>
      </div>
    </div>
  );
}
