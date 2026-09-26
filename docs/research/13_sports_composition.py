#!/usr/bin/env python3
"""Confirmation: la tranche 0.45-0.60 a l'ouverture est-elle dominee par des
sous-marches derives (totals, handicaps, completed-match) plutot que par les
vrais marches 'vainqueur' ? Un sous-marche illiquide ouvre a ~0.50 par defaut."""
import json
from collections import Counter

d = json.load(open("favlong_sports.json"))
b = [r for r in d if r.get("p_6h") is not None and 0.45 <= r["p_6h"] < 0.60]
print(f"bucket 0.45-0.60 ouverture: n={len(b)}, WR={sum(r['won0'] for r in b)/len(b):.3f}")


def kind(s):
    s = str(s)
    if "completed-match" in s:
        return "completed-match"
    for k in ("total-", "totals-", "handicap", "winner", "spread", "first-half", "player-"):
        if k in s:
            return k.rstrip("-")
    return "principal(vainqueur)"


c = Counter(kind(r["slug"]) for r in b)
print("  types:", c.most_common())
print("\n  detail:")
for r in sorted(b, key=lambda x: x["slug"])[:30]:
    print(f"    {kind(r['slug']):22s} p_open={r['p_6h']:.3f} won={r['won0']} {r['slug'][:58]}")

# ecart par type
print("\n=== WR vs prix d'ouverture par type de marche ===")
for t in set(kind(r["slug"]) for r in d):
    sub = [r for r in d if kind(r["slug"]) == t and r.get("p_6h") is not None]
    if len(sub) < 5:
        continue
    import statistics
    pm = statistics.mean(r["p_6h"] for r in sub)
    wr = sum(r["won0"] for r in sub) / len(sub)
    print(f"  {t:24s} n={len(sub):>3} prix_moy={pm:.3f} WR={wr:.3f} ecart={wr-pm:+.3f}")

# marche principal seulement
main = [r for r in d if kind(r["slug"]) == "principal(vainqueur)" and r.get("p_6h") is not None]
print(f"\n=== MARCHE PRINCIPAL (vainqueur) seulement: n={len(main)} ===")
import statistics
if len(main) >= 8:
    print(f"  prix_moy={statistics.mean(r['p_6h'] for r in main):.3f} "
          f"WR={sum(r['won0'] for r in main)/len(main):.3f} "
          f"ecart={sum(r['won0'] for r in main)/len(main)-statistics.mean(r['p_6h'] for r in main):+.3f}")
    for lo, hi in [(0.0, 0.35), (0.35, 0.50), (0.50, 0.65), (0.65, 1.01)]:
        bb = [r for r in main if lo <= r["p_6h"] < hi]
        if len(bb) < 3:
            continue
        pm = statistics.mean(r["p_6h"] for r in bb)
        wr = sum(r["won0"] for r in bb) / len(bb)
        print(f"    {lo:.2f}-{hi:.2f} n={len(bb):>3} prix={pm:.3f} WR={wr:.3f} ecart={wr-pm:+.3f}")
