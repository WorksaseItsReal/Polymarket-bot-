#!/usr/bin/env python3
"""Analyse complementaire: calibration sportive sur le prix d'OUVERTURE
(p_6h = premier point de l'historique) plutot que le prix de cloture
(qui est deja converge vers le resultat)."""
import json, math, statistics
from collections import Counter

d = json.load(open("favlong_sports.json"))
print(f"n={len(d)}")
for key, lbl in (("p_6h", "prix d'OUVERTURE (1er point)"), ("p_close", "prix de CLOTURE")):
    v = [r for r in d if r.get(key) is not None]
    print(f"\n=== {lbl} — n={len(v)} ===")
    print(f"{'tranche':>12} {'n':>4} {'prix_moy':>9} {'WR_reel':>8} {'ecart':>8} {'net/part':>9} {'t':>6}")
    for lo, hi in [(0.0, 0.10), (0.10, 0.30), (0.30, 0.45), (0.45, 0.60),
                   (0.60, 0.75), (0.75, 0.90), (0.90, 1.01)]:
        b = [r for r in v if lo <= r[key] < hi]
        if len(b) < 5:
            continue
        pm = statistics.mean(r[key] for r in b)
        wr = sum(r["won0"] for r in b) / len(b)
        vals = [(((1 - r[key]) if r["won0"] else -r[key]) - 0.05 * r[key] * (1 - r[key])) for r in b]
        mu = statistics.mean(vals)
        sd = (sum((x - mu) ** 2 for x in vals) / (len(vals) - 1)) ** 0.5
        t = mu / (sd / math.sqrt(len(vals))) if sd else 0
        print(f"{lo:.2f}-{hi:.2f} {len(b):>4} {pm:>9.3f} {wr:>8.3f} {wr-pm:>+8.3f} {mu:>+9.4f} {t:>6.2f}")
    for nm, g in (("FAVORI>0.60", [r for r in v if r[key] > 0.60]),
                  ("OUTSIDER<0.30", [r for r in v if r[key] < 0.30])):
        if len(g) >= 8:
            pm = statistics.mean(r[key] for r in g)
            wr = sum(r["won0"] for r in g) / len(g)
            vals = [(((1 - r[key]) if r["won0"] else -r[key]) - 0.05 * r[key] * (1 - r[key])) for r in g]
            mu = statistics.mean(vals)
            sd = (sum((x - mu) ** 2 for x in vals) / (len(vals) - 1)) ** 0.5
            t = mu / (sd / math.sqrt(len(vals))) if sd else 0
            print(f"  >> {nm}: n={len(g)} prix={pm:.3f} WR={wr:.3f} ecart={wr-pm:+.3f} "
                  f"net/part={mu:+.4f} t={t:.2f} ROI={100*mu/pm:+.1f}%")

# distribution des sportifs par competition
print("\n=== composition ===")
print(Counter(str(r["slug"]).split("-")[0] for r in d).most_common(10))
