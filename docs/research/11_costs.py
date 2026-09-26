#!/usr/bin/env python3
"""Piste 4: couts reels sur Polymarket (frais + spread + profondeur).

1. Table des frais taker (doc: fee = rate * p * (1-p)) par categorie.
2. Cout d'un aller-retour (entree + sortie) a mi-parcours = 2*spread/2 + 2*frais.
3. Statistiques de spread et profondeur mesurees (arb_scan.json + CLOB).
"""
import json, statistics
from collections import Counter

print("### 1. Frais taker par categorie (formule officielle fee = C * rate * p * (1-p))")
RATES = [("Politics / Finance / Tech / Mentions", 0.04),
         ("Economics / Culture / Weather / Other", 0.05),
         ("Sports", 0.05),
         ("Crypto (dont Up/Down 5m)", 0.07),
         ("Geopolitics / world events", 0.0)]
print(f"{'categorie':>40} {'rate':>5} {'frais@0.50':>11} {'frais@0.10':>11} {'frais@0.90':>11} {'equiv.@0.50':>11}")
for nm, r in RATES:
    f50 = r * 0.5 * 0.5
    print(f"{nm:>40} {r:>5.2f} {f50:>11.4f} {r*0.1*0.9:>11.4f} {r*0.9*0.1:>11.4f} {100*f50/0.5:>10.2f}%")

print("\n### 2. Cout total d'entree (frais + demi-spread) selon le prix d'achat")
print("(spread suppose de 1 cent = 0.01, tick 0.001 mesure; demi-spread = 0.005)")
print(f"{'prix':>6} | " + " | ".join(f"{nm[:12]:>14}" for nm, _ in [("crypto 0.07", 0.07), ("sports 0.05", 0.05), ("politics 0.04", 0.04)]))
for p in [0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.80, 0.90, 0.95]:
    cells = []
    for _, r in [("", 0.07), ("", 0.05), ("", 0.04)]:
        fee = r * p * (1 - p)
        tot = fee + 0.005
        cells.append(f"{tot:.4f} ({100*tot/p:>5.2f}%)")
    print(f"{p:>6.2f} | " + " | ".join(f"{c:>18}" for c in cells))

print("\n### 3. Spread mesure (Gamma) sur 274 marches binaires actifs")
rows = json.load(open("arb_scan.json"))
v = [r for r in rows if "sum_ask" in r and r.get("spread_gamma") is not None]
sp = [r["spread_gamma"] for r in v]
print(f"n={len(v)} median={statistics.median(sp):.4f} moyenne={statistics.mean(sp):.4f} "
      f"min={min(sp)} max={max(sp)}")
c = Counter(sp)
frac_tight = sum(1 for x in sp if x <= 0.002) / len(sp)
frac_1c = sum(1 for x in sp if x <= 0.010) / len(sp)
print(f"part avec spread <= 0.002 : {100*frac_tight:.1f}%")
print(f"part avec spread <= 0.010 : {100*frac_1c:.1f}%")
print("distribution:", dict(sorted(c.items(), key=lambda x: x[0])[:10]), "...")

print("\n### 4. Plancher structurel de l'arbitre binaire YES+NO")
s = sorted(r["sum_ask"] for r in v)
print(f"min(ask_YES+ask_NO) = {s[0]:.4f} sur {len(s)} marches")
print(f"marches sous 1.0000 : {sum(1 for x in s if x < 1.0)}")
print(f"marches exactement a 1.001 (2 demi-ticks) : {sum(1 for x in s if abs(x-1.001)<1e-6)}")
print(f"marches a 1.010 (spread 1 cent plein)     : {sum(1 for x in s if abs(x-1.010)<1e-6)}")
print("=> acheter les deux cotes coute TOUJOURS >= 1 tick (0.001) : pas d'arb binaire possible.")
