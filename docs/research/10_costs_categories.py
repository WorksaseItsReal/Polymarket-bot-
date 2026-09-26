#!/usr/bin/env python3
"""Controle final du biais (piste 3) par CATEGORIE + agregation des COUTS (piste 4).

Objectif 1: le biais favori-outsider est-il homogene par categorie de marche, ou
concentre sur des clusters crypto/FDV (ladders) qui biaiseraient l'echantillon ?
On regroupe par feeType (proxy de categorie) et par type de question.

Objectif 2: chiffrer les couts reels a partir du scan d'orderbooks (arb_scan.json):
 - spread median observe (en cents) par categorie
 - cout aller-retour (spread + frais taker) en % du capital
 - profondeur disponible au meilleur prix
"""
import json, statistics, math
from collections import defaultdict

FEE_CAT = {"crypto_fees_v2": 0.07, "sports_fees_v3": 0.05, "economics_fees": 0.05,
           "culture_fees": 0.05, "weather_fees": 0.05, "other_fees": 0.05,
           "politics_fees": 0.04, "tech_fees": 0.04, "finance_fees": 0.04,
           "mentions_fees": 0.04, "zero_fees": 0.0}


def main():
    print("=" * 88)
    print("PARTIE A — Biais favori-outsider par categorie (marches resolus)")
    print("=" * 88)
    res = [r for r in json.load(open("favlong.json")) if "skip" not in r and r.get("p30d") is not None]
    by = defaultdict(list)
    for r in res:
        by[r.get("fee_type") or "inconnu"].append(r)
    print(f"{'categorie':>18} {'n':>5} {'prix_moy':>9} {'WR_reel':>8} {'ecart':>8} {'t':>6}")
    for cat, g in sorted(by.items(), key=lambda x: -len(x[1])):
        if len(g) < 8:
            continue
        pm = statistics.mean(r["p30d"] for r in g)
        wr = statistics.mean(r["won0"] for r in g)
        vals = [((1 - r["p30d"]) if r["won0"] else -r["p30d"]) for r in g]
        mu = statistics.mean(vals)
        sd = statistics.pstdev(vals)
        t = mu / (sd / math.sqrt(len(vals))) if sd else 0
        print(f"{cat:>18} {len(g):>5} {pm:>9.4f} {wr:>8.4f} {wr-pm:>+8.4f} {t:>6.2f}")

    # sous-echantillon hors ladders FDV/paliers crypto
    def is_ladder(r):
        s = str(r.get("slug") or "").lower()
        return ("fdv-above" in s) or ("-above-" in s) or ("price-will" in s)
    lad = [r for r in res if is_ladder(r)]
    oth = [r for r in res if not is_ladder(r)]
    print(f"\n-- Separation ladders de prix ('above'/'fdv') vs le reste --")
    for nm, g in (("LADDERS (above/fdv)", lad), ("AUTRES (evenements discrets)", oth)):
        if len(g) < 5:
            print(f"  {nm}: n={len(g)}"); continue
        pm = statistics.mean(r["p30d"] for r in g)
        wr = statistics.mean(r["won0"] for r in g)
        vals = [((1 - r["p30d"]) if r["won0"] else -r["p30d"]) for r in g]
        mu = statistics.mean(vals)
        sd = statistics.pstdev(vals)
        t = mu / (sd / math.sqrt(len(vals))) if sd else 0
        print(f"  {nm:32s} n={len(g):>4} prix={pm:.4f} WR={wr:.4f} ecart={wr-pm:+.4f} t={t:.2f}")

    print("\n" + "=" * 88)
    print("PARTIE B — Couts reels observes (scan d'orderbooks)")
    print("=" * 88)
    rows = json.load(open("arb_scan.json"))
    v = [r for r in rows if "sum_ask" in r]
    sp = [r["spread_gamma"] for r in v if r.get("spread_gamma") is not None]
    print(f"Marches scannes: {len(v)}")
    if sp:
        sps = sorted(sp)
        print(f"spread observe (en cents de prix, soit % du notionnel a p=0.5):")
        print(f"  min={sps[0]:.3f} p25={sps[len(sps)//4]:.3f} median={statistics.median(sps):.3f} "
              f"p75={sps[3*len(sps)//4]:.3f} max={sps[-1]:.3f}")
        # cout aller-retour au pire / median, prix ~0.5
        med = statistics.median(sps)
        print(f"\nCout d'un aller-retour (entree puis sortie) a prix ~0.50:")
        print(f"  spread median {med:.3f} -> {100*med:.2f}% du prix paye")
        for cat, rate in FEE_CAT.items():
            if rate == 0:
                print(f"  {cat:>16}: frais 0 -> cout A/R = {100*med:.2f}%")
            else:
                fee = 2 * rate * 0.5 * 0.5  # aller + retour, p=0.5
                print(f"  {cat:>16}: frais taker A/R {100*fee:.2f}% + spread {100*med:.2f}% "
                      f"= {100*(fee+med):.2f}% du capital")
    # profondeur au meilleur ask pour les 2 cotes (sum_ask)
    ssums = sorted(r["sum_ask"] for r in v)
    print(f"\nSomme ask_YES + ask_NO sur {len(v)} marches binaires:")
    print(f"  minimum observe = {ssums[0]:.4f}  (0 marche sous 1.0000)")
    print(f"  median          = {statistics.median(ssums):.4f}")
    print(f"  => cout minimal structurel de couvrir les 2 cotes = {100*(ssums[0]-1):.2f}%")
    # exec size disponible
    sizes = [r.get("exec_size") for r in v if r.get("exec_size")]
    if sizes:
        print(f"\nProfondeur executee au meilleur prix (parts):")
        print(f"  median={statistics.median(sizes):.1f} min={min(sizes):.1f} max={max(sizes):.1f}")
    deep = [r for r in v if (r.get("exec_size") or 0) > 100]
    print(f"  marches avec >100 parts dispo au top: {len(deep)} / {len(v)}")


if __name__ == "__main__":
    main()
