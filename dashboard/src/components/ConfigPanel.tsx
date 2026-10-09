import type { BotConfig } from '../types';
import { amount, pct } from '../format';

interface Props { config: BotConfig | null }

/** Réglages en vigueur (lecture seule : ils viennent du .env du bot). */
export function ConfigPanel({ config }: Props) {
  if (!config) return <div className="text-gray-500 text-sm">en attente du bot</div>;
  const f = config.fv;
  const rows: Array<[string, string]> = [
    ['Capital papier', amount(config.capital)],
    ['Coins', config.coins.join(', ')],
    ['Scrutation', `${config.pollSec} s (+ réaction aux mouvements du spot)`],
    ['Entrée si P(côté) ≥', pct(f.minProb)],
    ['Edge minimal après frais', `${(f.minEdge * 100).toFixed(1)} pt + ${f.noiseEdgeK} × bruit du prix à battre`],
    ['Revente anticipée si bid net ≥ p + ', `${(config.exitEdge * 100).toFixed(1)} pt (+ marge de bruit)`],
    ['Fenêtre d\'entrée (temps restant)', `${Math.max(f.minTauSec, f.twapWindowSec)} s à ${f.maxTauSec} s`],
    ['Ask achetable', `${f.minAsk} à ${f.maxAsk}`],
    ['Frais taker', `${f.takerFeeRate} × p × (1 − p) par part`],
    ['Règlement', `moyenne Chainlink ${f.twapWindowSec} s (prix à battre : minute précédant l'ouverture)`],
    ['Incertitudes', `prix à battre ${f.strikeNoiseSec} s de variance · écart de flux ${f.basisBps} bps`],
    ['Calibration', `confiance ×${f.zScale} · mélange modèle ${f.blendModel} / carnet ${f.blendMarket} · loi ${f.tails}`],
    ['Latence d\'ordre simulée', `${config.fillDelayMs} ms`],
    ['Ordre minimal', amount(config.minOrderUsd)],
    ['Limites de perte', `jour ${pct(config.risk.dailyMaxLossPct)} · mois ${pct(config.risk.monthlyMaxLossPct)} · baisse ${pct(config.risk.maxDrawdownFromPeak)} · totale ${pct(config.risk.totalMaxLossPct)}`],
    ['Flux spot temps réel', config.spotStream ? 'activé' : 'désactivé'],
    ['Journal des décisions', config.journal ? 'activé' : 'désactivé'],
    ['Telegram', config.telegram ? `configuré (fuseau ${config.timeZone})` : 'non configuré'],
  ];
  return (
    <div className="glass-card rounded-2xl p-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 py-1 border-b border-white/5">
          <span className="text-gray-400">{k}</span>
          <span className="font-mono text-gray-200 text-right">{v}</span>
        </div>
      ))}
    </div>
  );
}
