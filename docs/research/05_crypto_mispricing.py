#!/usr/bin/env python3
"""Piste 2: mispricing des 'above-on-date' (digitals) vs reference externe.

Reference externe GRATUITE:
  - prix spot: Binance /ticker/price
  - volatilite realisee 30j annualisee: Binance /klines (1d)
  - modele lognormal sans drift: P(S_T > K) = Phi( ln(S/K) / (sigma*sqrt(tau)) )
    (tau = temps restant en annees, crypto 365 j/an)

Pour chaque strike on compare:
  - proba modele
  - proba marche (mid) et le cout reel de chaque cote (ask YES / ask NO)
  - EV net d'acheter YES a l'ask, EV net d'acheter NO a l'ask (frais inclus)
Les frais crypto = 0.07 * p * (1-p) (doc Polymarket, taker).

Controle sans modele: monotonie stricte des prix le long des strikes
(violation = arbitrage pur, aucune reference externe necessaire).
"""
import json, time, urllib.request, math, sys, datetime

GAMMA = "https://gamma-api.polymarket.com"
BIN = "https://api.binance.com/api/v3"
FEE_CRYPTO = 0.07
NOW = datetime.datetime.now(datetime.timezone.utc)


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


def spot_and_vol(sym):
    p = get(f"{BIN}/ticker/price?symbol={sym}USDT")
    k = get(f"{BIN}/klines?symbol={sym}USDT&interval=1d&limit=31")
    if not isinstance(p, dict) or "price" not in p or not isinstance(k, list):
        return None, None
    s = float(p["price"])
    cl = [float(x[4]) for x in k]
    rets = [math.log(cl[i] / cl[i - 1]) for i in range(1, len(cl))]
    m = sum(rets) / len(rets)
    var = sum((r - m) ** 2 for r in rets) / (len(rets) - 1)
    return s, math.sqrt(var) * math.sqrt(365)


def parse_ts(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))


def main():
    coins = ["bitcoin", "ethereum", "solana", "xrp"]
    d = get(f"{GAMMA}/events?limit=80&closed=false&order=volume24hr&ascending=false&tag_slug=crypto")
    events = [e for e in (d if isinstance(d, list) else []) if "-above-on-" in str(e.get("slug"))]
    print(f"# {len(events)} events 'above-on-<date>' recuperes\n")

    allgaps = []
    for ev in events:
        slug = ev["slug"]
        coin = slug.split("-above-")[0]
        sym = {"bitcoin": "BTC", "ethereum": "ETH", "solana": "SOL", "xrp": "XRP"}.get(coin)
        if not sym:
            continue
        S, sig = spot_and_vol(sym)
        if not S:
            print(f"[{slug}] spot/vol indisponible"); continue
        end = parse_ts(ev["endDate"])
        tau = (end - NOW).total_seconds() / (365 * 86400)
        if tau <= 0:
            print(f"[{slug}] deja expire"); continue
        print("=" * 96)
        print(f"### {slug}  | {sym} spot={S:,.2f}  vol30j={sig:.1%}  expire dans {tau*365*24:.1f} h (endDate {ev['endDate']})")
        rows = []
        for m in ev.get("markets", []):
            try:
                K = float(str(m.get("groupItemTitle") or "").replace(",", "").strip())
            except Exception:
                continue
            bid, ask = m.get("bestBid"), m.get("bestAsk")
            if bid is None or ask is None:
                continue
            mid = (bid + ask) / 2
            z = math.log(S / K) / (sig * math.sqrt(tau))
            pm = phi(z)
            rows.append((K, bid, ask, mid, pm))
        rows.sort()
        # controle de monotonie (prix decroissant en K)
        viol = 0
        for i in range(1, len(rows)):
            if rows[i][3] > rows[i - 1][3] + 1e-9:
                viol += 1
        print(f"  {'strike':>9} {'bid':>7} {'ask':>7} {'mid_mkt':>8} {'modele':>8} {'ecart':>8} "
              f"{'EV_YES':>9} {'EV_NO':>9}")
        for K, bid, ask, mid, pm in rows:
            fee_y = FEE_CRYPTO * ask * (1 - ask)
            ev_yes = pm * 1 - ask - fee_y
            no_ask = 1 - bid
            fee_n = FEE_CRYPTO * no_ask * (1 - no_ask)
            ev_no = (1 - pm) * 1 - no_ask - fee_n
            allgaps.append((slug, K, mid, pm, mid - pm))
            print(f"  {K:>9,.0f} {bid:>7.3f} {ask:>7.3f} {mid:>8.3f} {pm:>8.3f} {mid-pm:>+8.3f} "
                  f"{ev_yes:>+9.3f} {ev_no:>+9.3f}")
        print(f"  -> violations de monotonie (fenetre d'arb pur): {viol}")

    if allgaps:
        n = len(allgaps)
        gaps = [g[4] for g in allgaps]
        print("\n" + "=" * 96)
        print(f"### SYNTHESE: {n} strikes compares")
        print(f"ecart moyen (marche - modele) = {sum(gaps)/n:+.4f}")
        print(f"ecart absolu moyen            = {sum(abs(x) for x in gaps)/n:.4f}")
        print(f"ecart min/max                 = {min(gaps):+.4f} / {max(gaps):+.4f}")
        big = [g for g in allgaps if abs(g[4]) > 0.05]
        print(f"strikes avec |ecart| > 5 pts  = {len(big)} / {n} ({100*len(big)/n:.1f}%)")
        for g in sorted(big, key=lambda x: -abs(x[4]))[:15]:
            print(f"   {g[0][:44]:44s} K={g[1]:>9,.0f} mkt={g[2]:.3f} modele={g[3]:.3f} ecart={g[4]:+.3f}")


if __name__ == "__main__":
    main()
