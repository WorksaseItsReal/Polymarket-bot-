#!/usr/bin/env python3
"""Piste 3 (v3): biais favori-outsider a HORIZONS CONTROLES.

Le point cle: mesurer la calibration 1 jour avant la resolution ne prouve rien
(le prix a deja converge). Ce qui est exploitable, c'est la calibration a
30 / 60 / 90 jours de la fin.

Methode:
 - t_last = dernier point de l'historique journalier complet (proxy de la
   resolution: un marche cesse de coter a la resolution, que l'endDate Gamma
   soit fiable ou non).
 - prix a H jours = dernier point <= t_last - H*86400.
 - issue = outcomePrices[0]=="1".
 - garde les marches dont l'historique couvre au moins H jours.
 - par horizon: tranches de prix -> WR reel, ecart, PnL/part, t.

Frais (doc Polymarket): fee_taker = C * rate * p * (1-p), applique a l'achat.
Le PnL net est calcule en deduisant ce frais.
"""
import json, time, urllib.request, os, sys, math

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
HORIZONS = [1, 7, 30, 60, 90]
FEE_RATE = 0.04  # prudence: politics/economics/culture = 0.04-0.05


def get(url, tries=3, tout=25):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "arb-research/1.0"})
            with urllib.request.urlopen(req, timeout=tout) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                return {"__error__": str(e)}
            time.sleep(0.8 * (i + 1))


def fetch_resolved(maxpages=40, minvol=2000):
    out, seen, off = [], set(), 0
    for _ in range(maxpages):
        d = get(f"{GAMMA}/markets?limit=100&offset={off}&closed=true&order=endDate&ascending=false")
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
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 800
    mk = fetch_resolved()
    print(f"# marches resolus vol>=2000 listes: {len(mk)}", file=sys.stderr)
    res = json.load(open("favlong.json")) if os.path.exists("favlong.json") else []
    done = {r["cid"] for r in res}
    todo = [m for m in mk if m.get("conditionId") not in done]
    print(f"# deja {len(res)}, a traiter {len(todo)}", file=sys.stderr)
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
        h = get(f"{CLOB}/prices-history?market={toks[0]}&interval=max&fidelity=1440")
        pts = h.get("history") if isinstance(h, dict) else None
        if not pts or len(pts) < 5:
            res.append({"cid": m.get("conditionId"), "slug": m.get("slug"), "skip": 1})
            continue
        t_last = pts[-1]["t"]
        px = {}
        for H in HORIZONS:
            ref = None
            for pt in reversed(pts):
                if pt["t"] <= t_last - H * 86400:
                    ref = pt["p"]
                    break
            px[f"p{H}d"] = ref
        res.append({
            "cid": m.get("conditionId"), "slug": m.get("slug"),
            "q": (m.get("question") or "")[:70], "vol": float(m.get("volumeNum") or 0),
            "outcome0": outc[0], "won0": 1 if float(prices[0]) == 1.0 else 0,
            "p_last": pts[-1]["p"], "t_last": t_last,
            "n_pts": len(pts), "span_j": round((pts[-1]["t"] - pts[0]["t"]) / 86400, 1),
            "fee_type": m.get("feeType"), **px,
        })
        if (i + 1) % 50 == 0:
            json.dump(res, open("favlong.json", "w"))
            print(f"  ...{i+1}/{len(todo)} -> {len(res)}", file=sys.stderr)
        time.sleep(0.03)
    json.dump(res, open("favlong.json", "w"))
    report(res)


def report(res):
    for H in HORIZONS:
        key = f"p{H}d"
        v = [r for r in res if r.get(key) is not None and "skip" not in r]
        print(f"\n{'='*84}\n### HORIZON {H} JOUR(S) AVANT LA FIN  —  n={len(v)} marches exploitables")
        if len(v) < 10:
            print("  (echantillon insuffisant)"); continue
        buckets = [(0.00, 0.03), (0.03, 0.07), (0.07, 0.15), (0.15, 0.30),
                   (0.30, 0.45), (0.45, 0.60), (0.60, 0.75), (0.75, 0.88),
                   (0.88, 0.95), (0.95, 0.99), (0.99, 1.01)]
        print(f"{'tranche':>12} {'n':>5} {'prix_moy':>9} {'WR_reel':>8} {'ecart':>8} "
              f"{'gross/part':>10} {'net/part':>9} {'t':>6}")
        for lo, hi in buckets:
            b = [r for r in v if lo <= r[key] < hi]
            if len(b) < 5:
                continue
            n = len(b)
            pm = sum(r[key] for r in b) / n
            wr = sum(r["won0"] for r in b) / n
            vals, grosses = [], []
            for r in b:
                p = r[key]
                gross = (1 - p) if r["won0"] else -p
                fee = FEE_RATE * p * (1 - p)      # frais taker a l'achat
                grosses.append(gross)
                vals.append(gross - fee)
            mu = sum(vals) / n
            gmu = sum(grosses) / n
            sd = (sum((x - mu) ** 2 for x in vals) / (n - 1)) ** 0.5 if n > 1 else 0
            t = mu / (sd / math.sqrt(n)) if sd > 0 else 0
            print(f"{lo:.2f}-{hi:.2f} {n:>5} {pm:>9.3f} {wr:>8.3f} {wr-pm:>+8.3f} "
                  f"{gmu:>10.4f} {mu:>+9.4f} {t:>6.2f}")
        # strategies naives
        fv = [r for r in v if r[key] > 0.90]
        ls = [r for r in v if r[key] < 0.10]
        for nm, g in (("acheter FAVORI p>0.90", fv), ("acheter LONGSHOT p<0.10", ls)):
            if len(g) >= 5:
                n = len(g)
                pm = sum(r[key] for r in g) / n
                wr = sum(r["won0"] for r in g) / n
                vals = [(((1 - r[key]) if r["won0"] else -r[key]) - FEE_RATE * r[key] * (1 - r[key])) for r in g]
                mu = sum(vals) / n
                sd = (sum((x - mu) ** 2 for x in vals) / (n - 1)) ** 0.5
                t = mu / (sd / math.sqrt(n)) if sd > 0 else 0
                print(f"  >> {nm}: n={n} prix_moy={pm:.4f} WR_reel={wr:.4f} "
                      f"ecart={wr-pm:+.4f} PnL_net/part={mu:+.4f} t={t:.2f} "
                      f"ROI={100*mu/pm:+.1f}%")
    # repartition
    v = [r for r in res if r.get("p30d") is not None and "skip" not in r]
    print(f"\n=== base totale: {len([r for r in res if 'skip' not in r])} marches avec historique; "
          f"{len(v)} couvrent >=30 jours ===")


if __name__ == "__main__":
    main()
