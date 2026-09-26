#!/usr/bin/env python3
"""Piste 3 (v4, echantillon PROPRE): calibration sur marches a endDate reelle.

Correction du biais identifie en v3: la requete closed=true&order=endDate DESC
ne renvoyait que des marches a endDate lointaine (placeholder 2027/2029) resolus
tot -> echantillon non representatif (100% de ce type, cf. enddate_gap.json).

Ici on restreint a une FENETRE D'ENDDATE REELLE dans le passe, avec volume:
  closed=true&end_date_min=...&end_date_max=...
et on prend le prix a J-7 / J-30 / J-60 PAR RAPPORT A endDate (l'instant reel
de resolution), pas par rapport au dernier trade.

Sortie: calibration par tranche -> WR reel vs prix, PnL net de frais.
"""
import json, time, urllib.request, os, sys, math, datetime

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
FEE = 0.04
NOW = datetime.datetime.now(datetime.timezone.utc)
HORIZONS = [1, 2, 3, 7, 14, 30]


def get(url, tries=3, tout=25):
    for i in range(tries):
        try:
            r = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
            with urllib.request.urlopen(r, timeout=tout) as h:
                return json.load(h)
        except Exception as e:
            if i == tries - 1:
                return {"__error__": str(e)}
            time.sleep(0.8 * (i + 1))


def fetch(minvol=2000, days_back=400, maxpages=60):
    dmax = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    dmin = (NOW - datetime.timedelta(days=days_back)).strftime("%Y-%m-%dT%H:%M:%SZ")
    out, seen, off = [], set(), 0
    for _ in range(maxpages):
        d = get(f"{GAMMA}/markets?limit=100&offset={off}&closed=true"
                f"&end_date_min={dmin}&end_date_max={dmax}&order=endDate&ascending=false")
        if not isinstance(d, list) or not d:
            break
        for m in d:
            cid = m.get("conditionId")
            if not cid or cid in seen:
                continue
            seen.add(cid)
            try:
                v = float(m.get("volumeNum") or 0)
            except Exception:
                v = 0
            if v >= minvol:
                out.append(m)
        if len(d) < 100:
            break
        off += 100
        time.sleep(0.08)
    return out


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 400
    mk = fetch()
    print(f"# marches fermes sur endDate reelle (150j), vol>=5000 : {len(mk)}", file=sys.stderr)
    res = json.load(open("favlong_clean.json")) if os.path.exists("favlong_clean.json") else []
    done = {r["cid"] for r in res}
    todo = [m for m in mk if m.get("conditionId") not in done]
    for i, m in enumerate(todo):
        if len(res) >= limit:
            break
        try:
            toks = json.loads(m.get("clobTokenIds") or "[]")
            prices = json.loads(m.get("outcomePrices") or "[]")
            outc = json.loads(m.get("outcomes") or "[]")
        except Exception:
            continue
        if len(toks) != 2 or len(prices) != 2 or len(outc) != 2:
            continue
        if prices[0] not in ("0", "1") or prices[1] not in ("0", "1"):
            continue
        try:
            ende = datetime.datetime.fromisoformat(m["endDate"].replace("Z", "+00:00"))
        except Exception:
            continue
        endts = ende.timestamp()
        h = get(f"{CLOB}/prices-history?market={toks[0]}&interval=max&fidelity=60")
        pts = h.get("history") if isinstance(h, dict) else None
        if not pts or len(pts) < 10:
            continue
        px = {}
        for H in HORIZONS:
            tgt = endts - H * 86400
            cand = [p for p in pts if p["t"] <= tgt]
            px[f"p{H}d"] = cand[-1]["p"] if cand else None
        res.append({"cid": m.get("conditionId"), "slug": m.get("slug"),
                    "q": (m.get("question") or "")[:70], "vol": float(m.get("volumeNum") or 0),
                    "outcome0": outc[0], "won0": 1 if float(prices[0]) == 1.0 else 0,
                    "end": m["endDate"], "n_pts": len(pts),
                    "first_t": pts[0]["t"], "last_t": pts[-1]["t"],
                    "fee_type": m.get("feeType"), **px})
        if (i + 1) % 40 == 0:
            json.dump(res, open("favlong_clean.json", "w"))
            print(f"  ...{i+1}/{len(todo)} -> {len(res)}", file=sys.stderr)
        time.sleep(0.03)
    json.dump(res, open("favlong_clean.json", "w"))

    # filtre: le marche doit avoir commence AVANT la date de reference
    for H in HORIZONS:
        key = f"p{H}d"
        v = [r for r in res if r.get(key) is not None and r["first_t"] <= (datetime.datetime.fromisoformat(r["end"].replace("Z", "+00:00")).timestamp() - H * 86400)]
        print(f"\n{'='*86}\n### HORIZON {H} JOURS AVANT endDate  —  n={len(v)}")
        if len(v) < 15:
            print("  (insuffisant)"); continue
        print(f"{'tranche':>12} {'n':>4} {'prix_moy':>9} {'WR_reel':>8} {'ecart':>8} {'net/part':>9} {'t':>6}")
        for lo, hi in [(0.0, 0.05), (0.05, 0.15), (0.15, 0.30), (0.30, 0.45),
                       (0.45, 0.60), (0.60, 0.75), (0.75, 0.90), (0.90, 0.97), (0.97, 1.01)]:
            b = [r for r in v if lo <= r[key] < hi]
            if len(b) < 4:
                continue
            pm = sum(r[key] for r in b) / len(b)
            wr = sum(r["won0"] for r in b) / len(b)
            vals = [(((1 - r[key]) if r["won0"] else -r[key]) - FEE * r[key] * (1 - r[key])) for r in b]
            mu = sum(vals) / len(vals)
            sd = (sum((x - mu) ** 2 for x in vals) / (len(vals) - 1)) ** 0.5
            t = mu / (sd / math.sqrt(len(vals))) if sd else 0
            print(f"{lo:.2f}-{hi:.2f} {len(b):>4} {pm:>9.3f} {wr:>8.3f} {wr-pm:>+8.3f} {mu:>+9.4f} {t:>6.2f}")
        fv = [r for r in v if r[key] > 0.90]
        ls = [r for r in v if r[key] < 0.10]
        for nm, g in (("FAVORI p>0.90", fv), ("LONGSHOT p<0.10", ls)):
            if len(g) >= 5:
                pm = sum(r[key] for r in g) / len(g)
                wr = sum(r["won0"] for r in g) / len(g)
                vals = [(((1 - r[key]) if r["won0"] else -r[key]) - FEE * r[key] * (1 - r[key])) for r in g]
                mu = sum(vals) / len(vals)
                sd = (sum((x - mu) ** 2 for x in vals) / (len(vals) - 1)) ** 0.5
                t = mu / (sd / math.sqrt(len(vals))) if sd else 0
                print(f"  >> {nm}: n={len(g)} prix={pm:.3f} WR={wr:.3f} ecart={wr-pm:+.3f} "
                      f"net/part={mu:+.4f} t={t:.2f} ROI={100*mu/pm:+.1f}%")


if __name__ == "__main__":
    main()
