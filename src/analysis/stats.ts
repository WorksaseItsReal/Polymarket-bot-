/**
 * stats.ts — t de Student avec erreurs GROUPÉES.
 *
 * Les 5 cryptos d'un même créneau de 5 min bougent ensemble (corrélation des issues 0,4 à
 * 0,7 mesurée sur l'historique) : les compter comme 5 observations indépendantes gonfle
 * les t (écart-type du t ≈ 1,3–1,4 au lieu de 1 en simulation sous l'hypothèse nulle,
 * soit 2 à 3 fois trop de « significatifs »). Ici, chaque groupe (créneau) compte pour
 * un bloc : estimateur de variance « CR1 » des erreurs groupées. Avec un groupe par
 * observation, on retrouve exactement le t usuel.
 */

export interface ClusteredT {
  n: number;
  clusters: number;
  mean: number | null;
  t: number | null;
}

/** Clé de groupe d'un slug `<coin>-updown-5m-<slot>` : le créneau (sinon le slug lui-même). */
export function slotKey(slug: string): string {
  const last = slug.split('-').pop() ?? slug;
  return /^\d{9,}$/.test(last) ? last : slug;
}

/** Moyenne et t (H0 : moyenne nulle) avec erreurs groupées par `key`. */
export function clusteredMeanT(obs: ReadonlyArray<{ key: string | number; x: number }>): ClusteredT {
  const n = obs.length;
  if (!n) return { n: 0, clusters: 0, mean: null, t: null };
  const mean = obs.reduce((a, o) => a + o.x, 0) / n;
  const resid = new Map<string | number, number>();
  for (const o of obs) resid.set(o.key, (resid.get(o.key) ?? 0) + (o.x - mean));
  const c = resid.size;
  if (c < 2) return { n, clusters: c, mean, t: null };
  let s = 0;
  for (const v of resid.values()) s += v * v;
  const variance = (s / (n * n)) * (c / (c - 1));
  return { n, clusters: c, mean, t: variance > 0 ? mean / Math.sqrt(variance) : null };
}

/**
 * Agrégat INCRÉMENTAL (persistable) pour le même t groupé, quand on ne garde que des
 * sommes : Σ_c (S_c − n_c·μ)² = ΣS_c² − 2μ·Σn_c·S_c + μ²·Σn_c².
 */
export interface ClusterSums {
  n: number;
  sum: number;
  clusters: number;
  sumS2: number;
  sumNS: number;
  sumN2: number;
}

export function clusteredTFromSums(a: ClusterSums): number | null {
  if (a.n < 2 || a.clusters < 2) return null;
  const mu = a.sum / a.n;
  const ss = a.sumS2 - 2 * mu * a.sumNS + mu * mu * a.sumN2;
  const variance = (Math.max(0, ss) / (a.n * a.n)) * (a.clusters / (a.clusters - 1));
  return variance > 0 ? mu / Math.sqrt(variance) : null;
}

/** Ajoute l'observation x au groupe dont l'état courant est (S, k) ; renvoie le nouvel état. */
export function addToClusterSums(a: ClusterSums, group: { S: number; k: number }, x: number): { S: number; k: number } {
  const S1 = group.S + x;
  const k1 = group.k + 1;
  a.n += 1;
  a.sum += x;
  if (group.k === 0) a.clusters += 1;
  a.sumS2 += S1 * S1 - group.S * group.S;
  a.sumNS += k1 * S1 - group.k * group.S;
  a.sumN2 += k1 * k1 - group.k * group.k;
  return { S: S1, k: k1 };
}
