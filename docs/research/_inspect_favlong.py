#!/usr/bin/env python3
"""Inspection: pourquoi un contrat price 0.45-0.60 gagne-t-il 80% du temps ?
On regarde les lignes reelles + leur duree de vie et leur categorie."""
import json, statistics

res = json.load(open("favlong.json"))
v = [r for r in res if r.get("p30d") is not None and "skip" not in r]
print(f"n(p30d)={len(v)}")

for lo, hi in [(0.45, 0.60), (0.30, 0.45), (0.75, 0.88)]:
    b = [r for r in v if lo <= r["p30d"] < hi]
    if not b:
        continue
    wr = sum(r["won0"] for r in b) / len(b)
    print(f"\n=== bucket {lo}-{hi} (n={len(b)}, WR={wr:.3f}, prix_moy={statistics.mean(r['p30d'] for r in b):.3f}) ===")
    # repartition par mot-cle de slug
    from collections import Counter
    def cat(s):
        s = str(s)
        for k in ("nfl", "nba", "mlb", "nhl", "cfb", "cbb", "soccer", "epl", "ucl",
                  "bitcoin", "ethereum", "solana", "xrp", "fed", "election", "trump",
                  "open", "winner", "vs-"):
            if k in s:
                return k
        return s.split("-")[0][:14]
    c = Counter(cat(r["slug"]) for r in b)
    print("  categories:", c.most_common(10))
    print("  span_j median:", statistics.median(r["span_j"] for r in b))
    for r in sorted(b, key=lambda x: x["p30d"])[:8]:
        print(f"    p30d={r['p30d']:.3f} won={r['won0']} span={r['span_j']:>6.1f}j vol={r['vol']:>10.0f} "
              f"fee={r.get('fee_type')} | {str(r['q'])[:58]}")

# global: distribution des categories dans tout l'echantillon
from collections import Counter
def cat(s):
    s = str(s)
    for k in ("nfl", "nba", "mlb", "nhl", "cfb", "cbb", "soccer", "epl", "ucl",
              "bitcoin", "ethereum", "solana", "xrp", "fed", "election", "trump"):
        if k in s:
            return k
    return "autre"
print("\n=== composition de l'echantillon p30d ===")
print(Counter(cat(r["slug"]) for r in v).most_common())
print("\n=== WR par categorie (p30d, toutes tranches) ===")
for k in set(cat(r["slug"]) for r in v):
    sub = [r for r in v if cat(r["slug"]) == k]
    if len(sub) < 10:
        continue
    pm = statistics.mean(r["p30d"] for r in sub)
    wr = sum(r["won0"] for r in sub) / len(sub)
    print(f"  {k:12s} n={len(sub):>4} prix_moy={pm:.3f} WR={wr:.3f} ecart={wr-pm:+.3f} "
          f"PnL/part={statistics.mean((1-r['p30d']) if r['won0'] else -r['p30d'] for r in sub):+.4f}")
