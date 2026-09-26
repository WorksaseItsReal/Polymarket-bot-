#!/usr/bin/env python3
"""Validation du biais de selection de l'etude favori-outsider.

Hypothese: la liste closed=true&order=endDate DESC sur-echantillonne les marches
resolus AVANT leur endDate nominale (2029, 2028...), et ceux-la sont
disproportionnellement des resolutions YES. On mesure t_last vs endDate.
"""
import json, datetime, statistics

res = [r for r in json.load(open("favlong.json")) if "skip" not in r]
print(f"n={len(res)}")

rows = []
for r in res:
    try:
        end = datetime.datetime.fromisoformat(r["end" ].replace("Z", "+00:00")) if r.get("end") else None
    except Exception:
        end = None
    # 'end' n'existe pas dans v3 -> recalcule depuis t_last seul
    rows.append(r)

# On n'a pas endDate dans favlong v3 ; on le recupere a la volee par lot
import urllib.request, time


def get(url):
    r = urllib.request.Request(url, headers={"User-Agent": "x/1"})
    return json.load(urllib.request.urlopen(r, timeout=25))


cids = [r["cid"] for r in res if "skip" not in r]
gap = []
wr_early = wr_late = 0
n_early = n_late = 0
pm_early = pm_late = 0
for i in range(0, len(cids), 20):
    chunk = cids[i:i+20]
    q = "&".join(f"condition_ids={c}" for c in chunk)
    # Gamma markets accepte un seul condition_ids; on utilise l'endpoint plural
    d = get("https://gamma-api.polymarket.com/markets?" + q)
    if not isinstance(d, list):
        continue
    for m in d:
        cid = m.get("conditionId")
        try:
            end = datetime.datetime.fromisoformat(m["endDate"].replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        rec = next((x for x in res if x.get("cid") == cid), None)
        if not rec:
            continue
        g = (end - rec["t_last"]) / 86400.0   # jours entre dernier trade et endDate
        gap.append((g, rec, m))
    time.sleep(0.1)

print(f"\nendDate recupere pour {len(gap)} marches")
if gap:
    gs = sorted(x[0] for x in gap)
    print(f"ecart (endDate - dernier_trade) en jours: min={gs[0]:.0f} p25={gs[len(gs)//4]:.0f} "
          f"median={statistics.median(gs):.0f} p75={gs[3*len(gs)//4]:.0f} max={gs[-1]:.0f}")
    # marche "normal" = resolue pres de son endDate
    for thr in (1, 7, 30, 90):
        early = [x for x in gap if x[0] > thr]
        late = [x for x in gap if 0 <= x[0] <= thr]
        def stats(gp):
            if not gp:
                return None
            p = [x[1]["p30d"] for x in gp if x[1].get("p30d") is not None]
            w = [x[1]["won0"] for x in gp if x[1].get("p30d") is not None]
            if not p:
                return None
            return (statistics.mean(p), sum(w)/len(w), len(p))
        se = stats(early); sl = stats(late)
        print(f"\n  seuil {thr:>3}j:"
              + (f"\n    resolus BIEN APRES endDate (n={se[2]}): prix_moy={se[0]:.3f} WR={se[1]:.3f} ecart={se[1]-se[0]:+.3f}" if se else "")
              + (f"\n    resolus PRES de endDate      (n={sl[2]}): prix_moy={sl[0]:.3f} WR={sl[1]:.3f} ecart={sl[1]-sl[0]:+.3f}" if sl else ""))
json.dump([{"cid": x[1]["cid"], "slug": x[1].get("slug"), "gap_j": x[0],
            "p30d": x[1].get("p30d"), "won0": x[1]["won0"], "vol": x[1]["vol"]}
           for x in gap], open("enddate_gap.json", "w"), indent=1)
