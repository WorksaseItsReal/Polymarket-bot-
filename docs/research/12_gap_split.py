#!/usr/bin/env python3
"""Test final: le biais favori-outsider vient-il des marches 'resolus tot' ?

Le fichier enddate_gap.json (jointure locale cid -> endDate) donne
gap_j = endDate_nominale - dernier_trade (en jours).
Si gap_j est grand, le marche a cesse de coter bien avant sa date de fin
nominale: la 'vraie' resolution est proche de t_last.

Troisieme hypothese a trancher: le prix 'p30d' (30j avant t_last) est-il
un vrai prix a 30j de la resolution, ou un prix fige tardivement ?

On compare la calibration sur les sous-echantillons par taille de gap.
"""
import json, statistics, math


def calib(rows, key, label):
    x = [r for r in rows if r.get(key) is not None]
    if len(x) < 5:
        print(f"  {label:44s} n={len(x):>4} (trop peu)")
        return
    pm = statistics.mean(r[key] for r in x)
    wr = statistics.mean(r["won0"] for r in x)
    vals = [((1 - r[key]) if r["won0"] else -r[key]) for r in x]
    mu = statistics.mean(vals)
    sd = statistics.pstdev(vals)
    t = mu / (sd / math.sqrt(len(vals))) if sd else 0
    print(f"  {label:44s} n={len(x):>4} prix={pm:.4f} WR={wr:.4f} ecart={wr-pm:+.4f} t={t:>5.2f}")


def main():
    rows = json.load(open("enddate_gap.json"))
    print(f"# {len(rows)} marches joints\n")
    gs = sorted(r["gap_j"] for r in rows)
    n = len(gs)
    print("### Distribution de gap_j = endDate nominale - dernier trade (jours)")
    print(f"  min={gs[0]:.0f}  p10={gs[n//10]:.0f}  p25={gs[n//4]:.0f}  median={statistics.median(gs):.0f}  "
          f"p75={gs[3*n//4]:.0f}  p90={gs[9*n//10]:.0f}  max={gs[-1]:.0f}")
    print(f"  part avec gap_j > 30 j : {100*sum(1 for g in gs if g > 30)/n:.1f}%")

    print("\n### Calibration a p30d selon le gap")
    calib(rows, "p30d", "TOUS")
    calib([r for r in rows if r["gap_j"] <= 30], "p30d", "gap <= 30 j (cotation vivante)")
    calib([r for r in rows if 30 < r["gap_j"] <= 180], "p30d", "gap 30-180 j")
    calib([r for r in rows if r["gap_j"] > 180], "p30d", "gap > 180 j (resolu tres tot)")

    print("\n### Calibration a p7d selon le gap (horizon plus court = moins de derive)")
    calib(rows, "p7d", "TOUS")
    calib([r for r in rows if r["gap_j"] <= 30], "p7d", "gap <= 30 j")

    print("\n### Sous-echantillon 'cotation vivante' (gap<=30j): tranches de prix a p30d")
    near = [r for r in rows if r["gap_j"] <= 30 and r.get("p30d") is not None]
    print(f"n={len(near)}")
    for lo, hi in [(0.0, 0.05), (0.05, 0.15), (0.15, 0.30), (0.30, 0.45), (0.45, 0.60),
                   (0.60, 0.75), (0.75, 0.90), (0.90, 1.01)]:
        b = [r for r in near if lo <= r["p30d"] < hi]
        if len(b) < 4:
            continue
        pm = statistics.mean(r["p30d"] for r in b)
        wr = sum(r["won0"] for r in b) / len(b)
        pnl = statistics.mean(((1 - r["p30d"]) if r["won0"] else -r["p30d"]) for r in b)
        print(f"  {lo:.2f}-{hi:.2f} n={len(b):>3} prix={pm:.3f} WR={wr:.3f} ecart={wr-pm:+.3f} PnL/part={pnl:+.4f}")


if __name__ == "__main__":
    main()
