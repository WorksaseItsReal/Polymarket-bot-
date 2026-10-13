/**
 * late-harvest.ts — « récolte de fin de round » : acheter le favori BLOQUÉ à 0,99 dans les
 * dernières secondes d'un round (papier).
 *
 * Origine (mesurée, pas supposée) : 6 590 rounds 5 min BTC/ETH réels (carnets Polymarket à la
 * seconde, 7–18 août 2026, jeu de données public gensx-x1/polymarket-btc-eth-updown-data ;
 * issue = carnet final). Le pas de prix (0,01) empêche le favori de coter au-delà de 0,99 alors
 * que sa vraie probabilité, en fin de round TWAP, est plus haute :
 *   favori à 0,99 depuis ≥ 6 s, τ entre 30 et 8 s, exécution 1 s plus tard (frais compris) :
 *   n = 4 944, gagné 99,74 %, +0,72 % par pari (t = 9,4) ; positif sur chaque moitié de la
 *   période (+0,58 % / +0,84 %) et sous les deux règles TWAP (30 s : +0,66 %, 60 s : +0,81 %).
 * Ce qui NE marche PAS (mêmes données) : entrer au PREMIER instant où le favori touche 0,99
 * (+0,2 %, non significatif : ces pics se retournent), avant τ = 30 s, ou à 0,97–0,98 (prix
 * libre : juste). D'où la règle de stabilité.
 *
 * Limites : 12 jours d'août, deux cryptos ; une perte coûte ~110 gains ; l'issue « carnet
 * final » n'est pas le règlement officiel. C'est une MESURE en papier, pas une promesse : le
 * registre (strategy = 'late') et le rapport la jugent sur les vrais remplissages.
 *
 * Module PUR (aucune I/O).
 */

export interface HarvestConfig {
  enabled: boolean;
  /** Ask du favori dans [minAsk, maxAsk) : le prix « bloqué » au plafond du pas de 0,01. */
  minAsk: number;
  maxAsk: number;
  /** Fenêtre de temps restant (s). */
  minTauSec: number;
  maxTauSec: number;
  /** Le même côté doit être à ≥ minAsk depuis au moins ce temps (s), sans interruption observée. */
  stableSec: number;
  /** Filtre de désaccord grossier : P(favori) du modèle « fin de round » (TWAP en partie acquis)
   *  au moins égale à ceci quand elle est calculable (flux temps réel) ; sinon carnet seul. */
  minModelProb: number;
  /** Lecture des carnets pendant la fenêtre de récolte (ms) ; 8 s ailleurs dans la dernière minute. */
  checkEveryMs: number;
}

export const DEFAULT_HARVEST_CONFIG: HarvestConfig = {
  enabled: true,
  minAsk: 0.99,
  maxAsk: 0.995,
  minTauSec: 8,
  maxTauSec: 30,
  stableSec: 6,
  minModelProb: 0.9,
  checkEveryMs: 3000,
};

/** Taux de gain historique de la règle (sert de probabilité pour la mise et la calibration). */
export const HARVEST_EXPECTED_WIN = 0.997;

export type HarvestSide = 'UP' | 'DOWN';

/** Côté dont l'ask est « bloqué » dans [minAsk, maxAsk), ou null (aucun, ou les deux : carnet incohérent). */
export function harvestSide(upAsk: number | null, downAsk: number | null, cfg: Pick<HarvestConfig, 'minAsk' | 'maxAsk'>): HarvestSide | null {
  const pinned = (a: number | null) => a !== null && Number.isFinite(a) && a >= cfg.minAsk && a < cfg.maxAsk;
  const up = pinned(upAsk);
  const down = pinned(downAsk);
  if (up === down) return null;
  return up ? 'UP' : 'DOWN';
}

/**
 * Séries « favori bloqué » par marché : début de la série en cours et côté. Une observation
 * d'un autre côté, ou sans côté bloqué, la remet à zéro. Un trou d'observation plus long que
 * `maxGapMs` aussi (on ne sait pas ce qui s'est passé entre-temps).
 */
export class FavoriteStreaks {
  private readonly s = new Map<string, { side: HarvestSide; since: number; last: number }>();

  constructor(private readonly maxGapMs = 12_000) {}

  observe(key: string, side: HarvestSide | null, tMs: number): void {
    const cur = this.s.get(key);
    if (side === null) {
      this.s.delete(key);
      return;
    }
    if (!cur || cur.side !== side || tMs - cur.last > this.maxGapMs || tMs < cur.last) {
      this.s.set(key, { side, since: tMs, last: tMs });
      return;
    }
    cur.last = tMs;
  }

  /** Secondes depuis le début de la série du côté `side` (0 si pas de série de ce côté). */
  stableSec(key: string, side: HarvestSide, tMs: number): number {
    const cur = this.s.get(key);
    return cur && cur.side === side ? Math.max(0, (tMs - cur.since) / 1000) : 0;
  }

  /** Oublie les marchés non observés depuis `maxAgeMs` (rounds terminés). */
  prune(nowMs: number, maxAgeMs = 600_000): void {
    for (const [k, v] of this.s) if (nowMs - v.last > maxAgeMs) this.s.delete(k);
  }

  get size(): number {
    return this.s.size;
  }
}

export interface HarvestInput {
  tauSec: number;
  side: HarvestSide | null;
  stableSec: number;
  /** P(Up) du modèle fin de round, ou null si non calculable. */
  pModelUp: number | null;
}

/** Décision pure : le côté à acheter, ou null avec la raison (lisible). */
export function harvestDecision(i: HarvestInput, cfg: HarvestConfig): { side: HarvestSide | null; reason: string } {
  if (!cfg.enabled) return { side: null, reason: 'récolte désactivée' };
  if (i.side === null) return { side: null, reason: `aucun favori bloqué à ≥ ${cfg.minAsk}` };
  if (i.tauSec > cfg.maxTauSec || i.tauSec < cfg.minTauSec) return { side: null, reason: `τ ${Math.round(i.tauSec)} s hors fenêtre ${cfg.minTauSec}–${cfg.maxTauSec} s` };
  if (i.stableSec < cfg.stableSec) return { side: null, reason: `favori ${i.side} à ≥ ${cfg.minAsk} depuis ${i.stableSec.toFixed(1)} s < ${cfg.stableSec} s` };
  if (i.pModelUp !== null) {
    const pFav = i.side === 'UP' ? i.pModelUp : 1 - i.pModelUp;
    if (pFav < cfg.minModelProb) return { side: null, reason: `modèle en désaccord : P(${i.side}) ${pFav.toFixed(3)} < ${cfg.minModelProb}` };
  }
  return { side: i.side, reason: `favori ${i.side} bloqué à ≥ ${cfg.minAsk} depuis ${i.stableSec.toFixed(0)} s, τ ${Math.round(i.tauSec)} s` };
}

/** Réglages depuis l'environnement (FV_HARVEST*) ; valeurs invalides → défaut + avertissement. */
export function harvestConfigFromEnv(env: Record<string, string | undefined>, warnings: string[] = []): HarvestConfig {
  const c = { ...DEFAULT_HARVEST_CONFIG };
  const raw = (env.FV_HARVEST ?? '').trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(raw)) c.enabled = false;
  else if (raw && !['true', '1', 'yes', 'on'].includes(raw)) warnings.push(`FV_HARVEST=${raw} ignoré (attendu : true ou false) — activé`);
  const num = (key: string, lo: number, hi: number, set: (v: number) => void) => {
    const r = (env[key] ?? '').trim();
    if (!r) return;
    const v = Number(r);
    if (Number.isFinite(v) && v >= lo && v <= hi) set(v);
    else warnings.push(`${key}=${r} ignoré (attendu : nombre entre ${lo} et ${hi})`);
  };
  num('FV_HARVEST_MIN_ASK', 0.9, 0.999, v => { c.minAsk = v; });
  num('FV_HARVEST_MAX_TAU', 5, 60, v => { c.maxTauSec = v; });
  num('FV_HARVEST_MIN_TAU', 3, 60, v => { c.minTauSec = v; });
  num('FV_HARVEST_STABLE_SEC', 0, 30, v => { c.stableSec = v; });
  if (c.minTauSec > c.maxTauSec) {
    warnings.push(`FV_HARVEST_MIN_TAU=${c.minTauSec} > FV_HARVEST_MAX_TAU=${c.maxTauSec} — valeurs par défaut (${DEFAULT_HARVEST_CONFIG.minTauSec}–${DEFAULT_HARVEST_CONFIG.maxTauSec} s)`);
    c.minTauSec = DEFAULT_HARVEST_CONFIG.minTauSec;
    c.maxTauSec = DEFAULT_HARVEST_CONFIG.maxTauSec;
  }
  return c;
}
