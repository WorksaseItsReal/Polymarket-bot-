#!/usr/bin/env python3
"""Test decisif: le biais survit-il quand on ne garde qu'UNE observation par
evenement independant ?

Probleme: un 'ladder' (ex: bitcoin above 72k/74k/.../92k le meme jour) produit
~10 lignes qui partagent UNE seule realisation du sous-jacent. Ces lignes ne
sont pas independantes -> les t-stats bruts sont gonfles.

Methode: clusteriser par famille d'evenement (prefixe de slug, strikes/chiffres
retires). Ne garder que le marche de plus gros volume du cluster. Recalculer la
calibration. Comparer avec le resultat brut.
"""
import json, statistics, math, re
from collections import defaultdict


def cluster_key(slug):
    s = str(slug or "").lower()
    # retire les nombres (strikes) et les dates/suffixes longs
    s = re.sub(r"\d[\d,\.]*", "#", s)
    s = re.sub(r"-#", "#", s)
    toks = [t for t in s.split("-") if t]
    return "-".join(toks[:6])


def calib(rows, key, label):
    rows = [r for r in rows if r.get(key) is not None]
    if len(rows) < 4:
        print(f"  {label:38s} n={len(rows):>4} (trop peu)")
        return None
    pm = statistics.mean(r[key] for r in rows)
    wr = statistics.mean(r["won0"] for r in rows)
    vals = [((1 - r[key]) if r["won0"] else -r[key]) for r in rows]
    mu = statistics.mean(vals)
    sd = statistics.pstdev(vals)
    t = mu / (sd / math.sqrt(len(vals))) if sd else 0
    print(f"  {label:38s} n={len(rows):>4} prix={pm:.4f} WR={wr:.4f} ecart={wr-pm:+.4f} t={t:>5.2f}")
    return wr - pm


def main():
    res = [r for r in json.load(open("favlong.json")) if "skip" not in r and r.get("p30d") is not None]
    print(f"# base brute: {len(res)} lignes\n")

    cl = defaultdict(list)
    for r in res:
        cl[cluster_key(r.get("slug"))].append(r)
    print(f"# clusters d'evenements distincts: {len(cl)}")
    sizes = sorted((len(v) for v in cl.values()), reverse=True)
    print(f"# tailles de cluster: max={sizes[0]} median={statistics.median(sizes):.0f} "
          f"clusters de taille 1: {sum(1 for s in sizes if s == 1)}\n")

    for key in ["p7d", "p30d", "p60d"]:
        print(f"### horizon {key}")
        calib(res, key, "BRUT (toutes les lignes)")
        # une obs par cluster: plus gros volume
        one = [max(v, key=lambda r: r["vol"]) for v in cl.values()]
        calib(one, key, "1 obs/cluster (plus gros volume)")
        # moyenne intra-cluster puis t-test sur les clusters
        clmeans = []
        for v in cl.values():
            vs = [r for r in v if r.get(key) is not None]
            if not vs:
                continue
            pm = statistics.mean(r[key] for r in vs)
            wr = statistics.mean(r["won0"] for r in vs)
            clmeans.append((pm, wr, len(vs)))
        if clmeans:
            n = len(clmeans)
            pm = statistics.mean(x[0] for x in clmeans)
            wr = statistics.mean(x[1] for x in clmeans)
            diffs = [x[1] - x[0] for x in clmeans]
            mu = statistics.mean(diffs)
            sd = statistics.pstdev(diffs)
            t = mu / (sd / math.sqrt(n)) if sd else 0
            print(f"  {'moyenne intra-cluster (n=clusters)':38s} n={n:>4} prix={pm:.4f} "
                  f"WR={wr:.4f} ecart={wr-pm:+.4f} t={t:>5.2f}")

    print("\n### Detail: 12 plus gros clusters")
    for k, v in sorted(cl.items(), key=lambda x: -len(x[1]))[:12]:
        pm = statistics.mean(r["p30d"] for r in v)
        wr = statistics.mean(r["won0"] for r in v)
        print(f"  {len(v):>3} lignes | prix={pm:.3f} WR={wr:.3f} ecart={wr-pm:+.3f} | {k[:46]}")


if __name__ == "__main__":
    main()
