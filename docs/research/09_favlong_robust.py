#!/usr/bin/env python3
"""Robustesse du biais favori-outsider (piste 3).

Le resultat brut (marche sous-estime systematiquement la proba de l'issue 0)
peut venir d'un artefact de selection. Tests:
 1. Calibration GLOBALE par horizon: moyenne des prix vs taux de realisation.
 2. Composition: les plus gros clusters d'evenements (par prefixe de slug).
 3. Robustesse: marche dont le dernier trade est proche de endDate (cotations
    'vivantes' jusqu'au bout) vs marche arrete tot (t_last << endDate).
 4. Test sur les marches de SPORT uniquement (categorie la plus liquide).
 5. Sensibilite au niveau de volume (>=2000 vs >=50000).
"""
import json, datetime, statistics, math

NOW = datetime.datetime.now(datetime.timezone.utc)


def main():
    res = json.load(open("favlong.json"))
    v = [r for r in res if "skip" not in r and r.get("p30d") is not None]
    print(f"# base: {len(res)} marches, {len(v)} avec >=30j d'historique\n")

    def calib(rows, key, label):
        rows = [r for r in rows if r.get(key) is not None]
        if len(rows) < 5:
            print(f"  {label}: n={len(rows)} (trop peu)"); return
        pm = statistics.mean(r[key] for r in rows)
        wr = statistics.mean(r["won0"] for r in rows)
        vals = [((1 - r[key]) if r["won0"] else -r[key]) for r in rows]
        mu = statistics.mean(vals)
        sd = statistics.pstdev(vals) if len(vals) > 1 else 0
        t = mu / (sd / math.sqrt(len(vals))) if sd else 0
        print(f"  {label}: n={len(rows):>4} prix_moy={pm:.4f} WR_reel={wr:.4f} "
              f"ecart={wr-pm:+.4f} PnL_net/part={mu:+.4f} t={t:.2f}")

    print("### 1. Calibration globale par horizon (tous marches)")
    for k in ["p1d", "p7d", "p30d", "p60d", "p90d"]:
        calib(v, k, k)

    print("\n### 2. Composition (top clusters par prefixe de slug)")
    from collections import Counter
    c = Counter()
    for r in v:
        s = str(r.get("slug") or "")
        parts = s.split("-")
        c["-".join(parts[:3])] += 1
    for k, n in c.most_common(12):
        sub = [r for r in v if str(r.get("slug") or "").startswith(k)]
        pm = statistics.mean(r["p30d"] for r in sub)
        wr = statistics.mean(r["won0"] for r in sub)
        print(f"  {n:>4}x {k[:50]:50s} prix_moy={pm:.3f} WR={wr:.3f} ecart={wr-pm:+.3f}")

    print("\n### 3. Separation marche arrete tot vs cotation vivante jusqu'a endDate")
    def parse(x):
        try:
            return datetime.datetime.fromisoformat(x.replace("Z", "+00:00"))
        except Exception:
            return None
    alive, dead = [], []
    for r in v:
        e = parse(r.get("endDate") or "")
        if not e:
            continue
        gap = (e - datetime.datetime.fromtimestamp(r["t_last"], datetime.timezone.utc)).total_seconds() / 86400
        (alive if abs(gap) <= 7 else dead).append(r)
    calib(alive, "p30d", "dernier trade < 7j de endDate (n vivant)")
    calib(dead, "p30d", "dernier trade > 7j avant endDate (n arrete tot)")

    print("\n### 4. Sensibilite au volume (a p30d)")
    calib([r for r in v if r["vol"] >= 2000 and r["vol"] < 20000], "p30d", "vol 2k-20k")
    calib([r for r in v if r["vol"] >= 20000 and r["vol"] < 200000], "p30d", "vol 20k-200k")
    calib([r for r in v if r["vol"] >= 200000], "p30d", "vol >=200k")

    print("\n### 5. Favoris vs longshots, par horizon (test direct)")
    for k in ["p1d", "p7d", "p30d", "p60d", "p90d"]:
        fv = [r for r in v if r.get(k) is not None and r[k] > 0.90]
        ls = [r for r in v if r.get(k) is not None and r[k] < 0.10]
        md = [r for r in v if r.get(k) is not None and 0.30 <= r[k] <= 0.75]

        def summ(g):
            if not g:
                return "n=0"
            pm = statistics.mean(r[k] for r in g)
            wr = statistics.mean(r["won0"] for r in g)
            return f"n={len(g):>3} prix={pm:.3f} WR={wr:.3f} ecart={wr-pm:+.3f}"

        print(f"  {k}: favoris>0.90 {summ(fv)}")
        print(f"  {k}: milieu .30-.75 {summ(md)}")
        print(f"  {k}: longshots<0.10 {summ(ls)}")


if __name__ == "__main__":
    main()
