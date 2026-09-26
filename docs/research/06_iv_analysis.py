#!/usr/bin/env python3
"""Piste 2b: volatilite implicite de Polymarket vs reference externe.

Pour chaque marche 'Bitcoin/Ethereum above $K on <date>' (digital europeen,
resolution au close Binance 12:00 ET = 16:00 UTC), on inverse le modele
lognormal pour obtenir la vol implicite de Polymarket:

    mid = Phi( ln(S/K) / (sigma*sqrt(tau)) )
    => sigma = ln(S/K) / (Phi^-1(mid) * sqrt(tau))

References externes GRATUITES:
  - Deribit DVOL (vol implicite des options BTC/ETH, 30j) : reference de marche
  - Vol realisee Binance (7/30j)
  - Spot: Binance (/ticker/price) et Deribit index_price (cross-check)

Sortie: distribution de (IV_Polymarket - DVOL) par coin, et les strategies naives.
"""
import json, time, urllib.request, math, datetime, statistics

GAMMA = "https://gamma-api.polymarket.com"
BIN = "https://api.binance.com/api/v3"
DERI = "https://www.deribit.com/api/v2/public"
FEE = {"BTC": 0.07, "ETH": 0.07, "SOL": 0.07, "XRP": 0.07}
NOW = datetime.datetime.now(datetime.timezone.utc)


def get(url, tries=3, tout=25, raw=False):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
            with urllib.request.urlopen(req, timeout=tout) as r:
                return r.read() if raw else json.load(r)
        except Exception as e:
            if i == tries - 1:
                return {"__error__": str(e)}
            time.sleep(0.8 * (i + 1))


def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def phi_inv(p):
    """Inverse normale standard (Acklam)."""
    if p <= 0 or p >= 1:
        return None
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5
    r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


def realized_vol(sym):
    k = get(f"{BIN}/klines?symbol={sym}USDT&interval=1d&limit=91")
    if not isinstance(k, list):
        return {}
    cl = [float(x[4]) for x in k]
    out = {}
    for w in (7, 30):
        r = [math.log(cl[i] / cl[i-1]) for i in range(len(cl) - w, len(cl))]
        m = sum(r) / len(r)
        v = sum((x - m) ** 2 for x in r) / (len(r) - 1)
        out[w] = math.sqrt(v) * math.sqrt(365)
    return out


def dvol(cur):
    end = int(time.time() * 1000)
    start = end - 3 * 86400 * 1000
    d = get(f"{DERI}/get_volatility_index_data?currency={cur}&start_timestamp={start}"
            f"&end_timestamp={end}&resolution=3600")
    try:
        data = d["result"]["data"]
        return data[-1][4] / 100.0
    except Exception:
        return None


def main():
    maps = {"bitcoin": ("BTC", "BTC"), "ethereum": ("ETH", "ETH"),
            "solana": ("SOL", None), "xrp": ("XRP", None)}
    d = get(f"{GAMMA}/events?limit=100&closed=false&order=volume24hr&ascending=false&tag_slug=crypto")
    events = [e for e in (d if isinstance(d, list) else []) if "-above-on-" in str(e.get("slug"))]

    refs = {}
    for coin, (sym, dcur) in maps.items():
        S = get(f"{BIN}/ticker/price?symbol={sym}USDT")
        s = float(S["price"]) if isinstance(S, dict) and "price" in S else None
        rv = realized_vol(sym)
        dv = dvol(dcur) if dcur else None
        refs[coin] = {"spot": s, "rv7": rv.get(7), "rv30": rv.get(30), "dvol": dv}
    print("### References externes")
    for c, r in refs.items():
        dvs = f"{100*r['dvol']:.1f}%" if r["dvol"] else "n/a"
        rvs = f"{100*r['rv30']:.1%}" if r["rv30"] else "n/a"
        print(f"  {c:9s} spot={r['spot']:>12,.2f}  rv30={rvs:>7}  DVOL={dvs}")

    rows = []
    for ev in events:
        coin = ev["slug"].split("-above-")[0]
        if coin not in refs:
            continue
        R = refs[coin]
        S = R["spot"]
        end = datetime.datetime.fromisoformat(ev["endDate"].replace("Z", "+00:00"))
        tau = (end - NOW).total_seconds() / (365 * 86400)
        if tau <= 0 or not S:
            continue
        ref_vol = R["dvol"] or R["rv30"]
        for m in ev.get("markets", []):
            try:
                K = float(str(m.get("groupItemTitle") or "").replace(",", "").strip())
            except Exception:
                continue
            bid, ask = m.get("bestBid"), m.get("bestAsk")
            if bid is None or ask is None:
                continue
            mid = (bid + ask) / 2
            # IV Polymarket a partir du mid (guarder des mid extremes)
            iv = None
            z = phi_inv(mid)
            if z and abs(z) > 1e-6 and tau > 0:
                denom = z * math.sqrt(tau)
                if denom != 0:
                    iv = math.log(S / K) / denom
            if iv is None or iv <= 0:
                continue
            # EV des deux cotes avec les vraies limites + frais
            f_y = FEE["BTC"] * ask * (1 - ask)
            no_ask = 1 - bid
            f_n = FEE["BTC"] * no_ask * (1 - no_ask)
            pm = phi(math.log(S / K) / (ref_vol * math.sqrt(tau)))
            ev_yes = pm - ask - f_y
            ev_no = (1 - pm) - no_ask - f_n
            rows.append({"coin": coin, "slug": ev["slug"], "K": K, "mid": mid,
                         "bid": bid, "ask": ask, "iv": iv, "ref_vol": ref_vol,
                         "dvol": R["dvol"], "rv30": R["rv30"], "tau_h": tau * 365 * 24,
                         "pm_ref": pm, "ev_yes": ev_yes, "ev_no": ev_no})

    print(f"\n### {len(rows)} strikes exploitables avec IV inversee\n")
    for coin in maps:
        sub = [r for r in rows if r["coin"] == coin and r["dvol"]]
        if not sub:
            sub = [r for r in rows if r["coin"] == coin]
        if not sub:
            continue
        ivs = [r["iv"] for r in sub]
        diffs = [r["iv"] - r["ref_vol"] for r in sub]
        print(f"[{coin.upper()}] n={len(sub)} | IV Polymarket mediane={statistics.median(ivs):.1%} "
              f"| reference={statistics.median([r['ref_vol'] for r in sub]):.1%} "
              f"| ecart median={statistics.median(diffs)*100:+.2f} pts")

    print("\n### Strikes ou un cote a un EV positif net de frais (ref = DVOL/vol realisee)")
    act = [r for r in rows if r["ev_yes"] > 0.02 or r["ev_no"] > 0.02]
    act.sort(key=lambda r: -max(r["ev_yes"], r["ev_no"]))
    for r in act[:20]:
        side = "YES" if r["ev_yes"] > r["ev_no"] else "NO"
        print(f"  {r['coin']:8s} {r['slug'][:40]:40s} K={r['K']:>9,.0f} mid={r['mid']:.3f} "
              f"IV={r['iv']:.1%} ref={r['ref_vol']:.1%} dT={r['tau_h']:>5.1f}h -> {side} EV~{max(r['ev_yes'],r['ev_no']):+.3f}")
    print(f"\nTotal strikes avec |EV| > 2 pts: {len(act)} / {len(rows)} "
          f"({100*len(act)/max(1,len(rows)):.1f}%)")
    json.dump(rows, open("iv_analysis.json", "w"), indent=1)


if __name__ == "__main__":
    main()
