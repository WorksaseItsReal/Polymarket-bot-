#!/usr/bin/env python3
"""Jointure locale cid -> endDate (une seule passe de listing) pour mesurer
le biais 'resolu tot' de l'echantillon favori-outsider."""
import json, urllib.request, time, datetime, statistics


def get(url):
    for i in range(3):
        try:
            r = urllib.request.Request(url, headers={"User-Agent": "x/1"})
            return json.load(urllib.request.urlopen(r, timeout=25))
        except Exception:
            time.sleep(1)


res = [r for r in json.load(open("favlong.json")) if "skip" not in r]
want = {r["cid"]: r for r in res}
print(f"marches de l'echantillon: {len(want)}")

endmap = {}
off = 0
for _ in range(45):
    d = get(f"https://gamma-api.polymarket.com/markets?limit=100&offset={off}&closed=true&order=endDate&ascending=false")
    if not isinstance(d, list) or not d:
        break
    for m in d:
        cid = m.get("conditionId")
        if cid in want:
            endmap[cid] = m.get("endDate")
    off += 100
print(f"endDate trouve pour {len(endmap)} / {len(want)}")

rows = []
for cid, r in want.items():
    es = endmap.get(cid)
    if not es:
        continue
    try:
        end = datetime.datetime.fromisoformat(es.replace("Z", "+00:00")).timestamp()
    except Exception:
        continue
    gap = (end - r["t_last"]) / 86400.0
    rows.append({"cid": cid, "slug": r["slug"], "gap_j": gap, "p30d": r.get("p30d"),
                 "p7d": r.get("p7d"), "won0": r["won0"], "vol": r["vol"], "end": es})

json.dump(rows, open("enddate_gap.json", "w"), indent=1)
gs = sorted(x["gap_j"] for x in rows)
print(f"\necart (endDate - dernier_trade) jours: n={len(gs)}")
print(f"  min={gs[0]:.0f}  p10={gs[len(gs)//10]:.0f}  p25={gs[len(gs)//4]:.0f}  median={statistics.median(gs):.0f}  "
      f"p75={gs[3*len(gs)//4]:.0f}  p90={gs[9*len(gs)//10]:.0f}  max={gs[-1]:.0f}")
frac_early = sum(1 for g in gs if g > 30) / len(gs)
print(f"  part des marches resolus >30j avant leur endDate nominale: {100*frac_early:.1f}%")


def stat(sub, key="p30d"):
    x = [r for r in sub if r.get(key) is not None]
    if len(x) < 5:
        return None
    pm = statistics.mean(r[key] for r in x)
    wr = sum(r["won0"] for r in x) / len(x)
    return (len(x), pm, wr, wr - pm)


print("\n### Comparaison: marches resolus TRES tot vs pres de leur endDate")
for thr in (30, 90, 180, 365):
    early = [r for r in rows if r["gap_j"] > thr]
    near = [r for r in rows if -2 <= r["gap_j"] <= 30]
    se, sn = stat(early), stat(near)
    print(f"  seuil {thr:>3}j:")
    if se:
        print(f"    resolu tot  (gap>{thr:>3}j, n={se[0]:>3}): p30d moy={se[1]:.3f} WR={se[2]:.3f} ecart={se[3]:+.3f}")
    if sn:
        print(f"    resolu tard (0..30j,   n={sn[0]:>3}): p30d moy={sn[1]:.3f} WR={sn[2]:.3f} ecart={sn[3]:+.3f}")

print("\n### Tranches de prix sur le sous-echantillon 'resolu pres de endDate' (0..30j)")
near = [r for r in rows if -2 <= r["gap_j"] <= 30 and r.get("p30d") is not None]
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
