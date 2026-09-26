#!/usr/bin/env python3
"""Piste 3 (v5): calibration sur marchés SPORTIFS resolus (moneylines).

Les moneylines sportives sont le terrain classique du biais favori-outsider.
On restreint a des marches a endDate REELLE passee (fin de match), volume>=500,
et on prend le prix a la CLOTURE (dernier point avant endDate = la 'ligne finale').

Sortie: WR reel par tranche de prix de cloture + PnL net de frais.
"""
import json, time, urllib.request, os, sys, math, datetime

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
NOW = datetime.datetime.now(datetime.timezone.utc)
RATE = {"sports_fees_v3": 0.05, "sports_fees_v2": 0.05, "sports_fees": 0.05}


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


def fetch(days_back=400, minvol=500, maxpages=80):
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
            ft = m.get("feeType") or ""
            slug = str(m.get("slug") or "")
            if not (ft.startswith("sports") or any(k in slug for k in
                    ("atp-", "wta-", "itf-", "cs2-", "nba-", "nfl-", "mlb-", "nhl-",
                     "ucl-", "epl-", "laliga-", "seriea-", "bundesliga-", "uel-"))):
                continue
            try:
                v = float(m.get("volumeNum") or 0)
            except Exception:
                v = 0
            if v >= minvol:
                out.append(m)
        if len(d) < 100:
            break
        off += 100
        time.sleep(0.07)
    return out


def main():
    mk = fetch()
    print(f"# marches sportifs resolus (endDate reelle, vol>=500): {len(mk)}", file=sys.stderr)
    res = json.load(open("favlong_sports.json")) if os.path.exists("favlong_sports.json") else []
    done = {r["cid"] for r in res}
    todo = [m for m in mk if m.get("conditionId") not in done]
    print(f"# a traiter: {len(todo)}", file=sys.stderr)
    for i, m in enumerate(todo):
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
            endts = datetime.datetime.fromisoformat(m["endDate"].replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        h = get(f"{CLOB}/prices-history?market={toks[0]}&interval=max&fidelity=60")
        pts = h.get("history") if isinstance(h, dict) else None
        if not pts or len(pts) < 5:
            continue
        # prix a la cloture = dernier point <= endDate
        pre = [p for p in pts if p["t"] <= endts]
        if not pre:
            continue
        # marche doit exister au moins 6h avant la fin
        if pts[0]["t"] > endts - 6 * 3600:
            continue
        res.append({"cid": m.get("conditionId"), "slug": m.get("slug"),
                    "vol": float(m.get("volumeNum") or 0),
                    "won0": 1 if float(prices[0]) == 1.0 else 0,
                    "p_close": pre[-1]["p"], "p_6h": pre[0]["p"],
                    "n": len(pts), "end": m["endDate"], "fee_type": m.get("feeType")})
        if (i + 1) % 40 == 0:
            json.dump(res, open("favlong_sports.json", "w"))
            print(f"  ...{i+1}/{len(todo)} -> {len(res)}", file=sys.stderr)
        time.sleep(0.03)
    json.dump(res, open("favlong_sports.json", "w"))
    report(res)


def report(res):
    v = [r for r in res if r.get("p_close") is not None]
    print(f"\n=== {len(v)} marches sportifs resolus avec prix de cloture ===")
    if len(v) < 20:
        print("(insuffisant)"); return
    print(f"{'tranche':>12} {'n':>4} {'prix_moy':>9} {'WR_reel':>8} {'ecart':>8} {'net/part':>9} {'t':>6}")
    for lo, hi in [(0.0, 0.10), (0.10, 0.25), (0.25, 0.40), (0.40, 0.55),
                   (0.55, 0.70), (0.70, 0.85), (0.85, 0.95), (0.95, 1.01)]:
        b = [r for r in v if lo <= r["p_close"] < hi]
        if len(b) < 5:
            continue
        pm = sum(r["p_close"] for r in b) / len(b)
        wr = sum(r["won0"] for r in b) / len(b)
        rate = RATE.get(b[0]["fee_type"] or "", 0.05)
        vals = [(((1 - r["p_close"]) if r["won0"] else -r["p_close"]) - rate * r["p_close"] * (1 - r["p_close"])) for r in b]
        mu = sum(vals) / len(vals)
        sd = (sum((x - mu) ** 2 for x in vals) / (len(vals) - 1)) ** 0.5
        t = mu / (sd / math.sqrt(len(vals))) if sd else 0
        print(f"{lo:.2f}-{hi:.2f} {len(b):>4} {pm:>9.3f} {wr:>8.3f} {wr-pm:>+8.3f} {mu:>+9.4f} {t:>6.2f}")
    fv = [r for r in v if r["p_close"] > 0.70]
    ls = [r for r in v if r["p_close"] < 0.30]
    for nm, g in (("FAVORI p>0.70", fv), ("OUTSIDER p<0.30", ls)):
        if len(g) >= 8:
            pm = sum(r["p_close"] for r in g) / len(g)
            wr = sum(r["won0"] for r in g) / len(g)
            rate = RATE.get(g[0]["fee_type"] or "", 0.05)
            vals = [(((1 - r["p_close"]) if r["won0"] else -r["p_close"]) - rate * r["p_close"] * (1 - r["p_close"])) for r in g]
            mu = sum(vals) / len(vals)
            sd = (sum((x - mu) ** 2 for x in vals) / (len(vals) - 1)) ** 0.5
            t = mu / (sd / math.sqrt(len(vals))) if sd else 0
            print(f"  >> {nm}: n={len(g)} prix={pm:.3f} WR={wr:.3f} ecart={wr-pm:+.3f} "
                  f"net/part={mu:+.4f} t={t:.2f} ROI={100*mu/pm:+.1f}%")


if __name__ == "__main__":
    main()
