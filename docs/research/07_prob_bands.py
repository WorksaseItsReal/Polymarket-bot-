#!/usr/bin/env python3
"""Piste 2c (version rigoureuse): comparer la probabilite implicite du marche
pour un MOUVEMENT de taille donnee (+/-d%) a une reference externe.

Pourquoi: comparer les IV strike par strike est trompeur (le marche a un smile
et une mediane d'IV qui ne veut rien dire). On interpole donc la fonction
P(S_T > K) du marche et on l'evalue a K = S*(1+d) pour d = 1,2,3,5,8 %.

Reference: lognormal, sigma = DVOL Deribit (BTC/ETH) ou vol realisee 30j
(Binance) pour SOL/XRP (Deribit ne cote pas d'options SOL/XRP: verifie, la
liste d'options renvoie []).

Sortie: pour chaque coin, ecart moyen (proba marche - proba reference) par bande.
Un ecart positif = le marche surcote ce mouvement (=> acheter NO / vendre).
"""
import json, time, urllib.request, math, datetime, statistics

GAMMA = "https://gamma-api.polymarket.com"
BIN = "https://api.binance.com/api/v3"
DERI = "https://www.deribit.com/api/v2/public"
NOW = datetime.datetime.now(datetime.timezone.utc)
BANDS = [0.01, 0.02, 0.03, 0.05, 0.08]


def get(url, tries=3, tout=25):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
            with urllib.request.urlopen(req, timeout=tout) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                return {"__error__": str(e)}
            time.sleep(0.8 * (i + 1))


def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def dvol(cur):
    end = int(time.time() * 1000)
    d = get(f"{DERI}/get_volatility_index_data?currency={cur}&start_timestamp={end-3*86400*1000}"
            f"&end_timestamp={end}&resolution=3600")
    try:
        return d["result"]["data"][-1][4] / 100.0
    except Exception:
        return None


def rvol(sym, w=30):
    k = get(f"{BIN}/klines?symbol={sym}USDT&interval=1d&limit={w+2}")
    if not isinstance(k, list):
        return None
    cl = [float(x[4]) for x in k]
    r = [math.log(cl[i] / cl[i-1]) for i in range(1, len(cl))]
    m = sum(r) / len(r)
    v = sum((x - m) ** 2 for x in r) / (len(r) - 1)
    return math.sqrt(v) * math.sqrt(365)


def interp(pts, K):
    pts = sorted(pts)
    if K <= pts[0][0]:
        return pts[0][1]
    if K >= pts[-1][0]:
        return pts[-1][1]
    for i in range(1, len(pts)):
        k0, p0 = pts[i-1]
        k1, p1 = pts[i]
        if k0 <= K <= k1:
            if k1 == k0:
                return (p0 + p1) / 2
            w = (K - k0) / (k1 - k0)
            return p0 + w * (p1 - p0)
    return pts[-1][1]


def main():
    meta = {
        "bitcoin": ("BTC", "BTC"),
        "ethereum": ("ETH", "ETH"),
        "solana": ("SOL", None),
        "xrp": ("XRP", None),
    }
    S_ = {}
    for coin, (sym, dcur) in meta.items():
        p = get(f"{BIN}/ticker/price?symbol={sym}USDT")
        s = float(p["price"]) if isinstance(p, dict) and "price" in p else None
        dv = dvol(dcur) if dcur else None
        rv = rvol(sym, 30)
        ref = dv or rv
        S_[coin] = {"spot": s, "dvol": dv, "rv30": rv, "ref": ref, "src": "DVOL" if dv else "rv30"}
        dvs = f"{100*dv:.1f}%" if dv else "n/a"
        print(f"REF {coin:9s} spot={s:>12,.2f} DVOL={dvs:>7} rv30={100*rv:.1f}% -> reference={100*ref:.1f}% ({S_[coin]['src']})")

    d = get(f"{GAMMA}/events?limit=100&closed=false&order=volume24hr&ascending=false&tag_slug=crypto")
    events = [e for e in (d if isinstance(d, list) else []) if "-above-on-" in str(e.get("slug"))]

    obs = []   # (coin, band, diff, tau_h, K, mid, refp, is_up)
    for ev in events:
        coin = ev["slug"].split("-above-")[0]
        if coin not in S_ or not S_[coin]["spot"]:
            continue
        R = S_[coin]
        Sp = R["spot"]
        end = datetime.datetime.fromisoformat(ev["endDate"].replace("Z", "+00:00"))
        tau = (end - NOW).total_seconds() / (365 * 86400)
        if tau <= 0:
            continue
        pts = []
        for m in ev.get("markets", []):
            try:
                K = float(str(m.get("groupItemTitle") or "").replace(",", "").strip())
            except Exception:
                continue
            bid, ask = m.get("bestBid"), m.get("bestAsk")
            if bid is None or ask is None:
                continue
            pts.append((K, (bid + ask) / 2))
        if len(pts) < 3:
            continue
        sd = R["ref"] * math.sqrt(tau)
        for d_ in BANDS:
            for sgn, lbl in ((+1, "up"), (-1, "down")):
                K = Sp * (1 + sgn * d_)
                mk = interp(pts, K)
                ref = phi(math.log(Sp / K) / sd)
                obs.append({"coin": coin, "band": d_, "dir": lbl, "diff": mk - ref,
                            "tau_h": tau * 365 * 24, "K": K, "mid": mk, "refp": ref,
                            "src": R["src"]})

    print(f"\n### {len(obs)} observations (marche vs reference), par bande de mouvement")
    print(f"{'coin':>9} {'dir':>5} {'bande':>6} {'n':>4} {'proba_mkt':>10} {'proba_ref':>10} {'ecart':>8}")
    agg = {}
    for coin in meta:
        for dirn in ("up", "down"):
            for b in BANDS:
                sub = [o for o in obs if o["coin"] == coin and o["dir"] == dirn and o["band"] == b]
                if len(sub) < 3:
                    continue
                mm = statistics.mean(o["mid"] for o in sub)
                mr = statistics.mean(o["refp"] for o in sub)
                agg[(coin, dirn, b)] = (len(sub), mm, mr, mm - mr)
                print(f"{coin:>9} {dirn:>5} {b*100:>5.0f}% {len(sub):>4} {mm:>10.4f} {mr:>10.4f} {mm-mr:>+8.4f}")

    print("\n### Synthese par coin (ecart moyen toutes bandes, pondere par n)")
    for coin in meta:
        subs = [v for k, v in agg.items() if k[0] == coin]
        if not subs:
            continue
        n = sum(v[0] for v in subs)
        wdiff = sum(v[0] * v[3] for v in subs) / n
        ref = S_[coin]["ref"]
        # ecart relatif: marche vs ref en points de vol annualises
        print(f"  {coin:9s} src={S_[coin]['src']:>5} ref={100*ref:5.1f}%  n={n:>3}  "
              f"ecart moyen proba={wdiff:+.4f}")
    json.dump(obs, open("prob_bands.json", "w"), indent=1)


if __name__ == "__main__":
    main()
