#!/usr/bin/env python3
"""Mesure REELLE de la profondeur au meilleur prix (le champ exec_size de
arb_scan.json valait 0 partout parce que l'arb binaire ne se declenche jamais:
il ne mesure PAS la profondeur).

Ici: echantillon de marches actifs, on lit les 2 carnets et on releve la taille
disponible au meilleur ask (et au meilleur bid), plus la taille cumulee dans
les 3 premiers niveaux.
"""
import json, time, urllib.request, statistics

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"


def get(url, tries=3, tout=20):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
            with urllib.request.urlopen(req, timeout=tout) as r:
                return json.load(r)
        except Exception:
            if i == tries - 1:
                return None
            time.sleep(0.6 * (i + 1))


def main():
    mk = []
    for off in (0, 100, 200):
        d = get(f"{GAMMA}/markets?limit=100&offset={off}&closed=false&active=true"
                f"&order=volume24hr&ascending=false")
        if isinstance(d, list):
            mk += d
    print(f"# {len(mk)} marches actifs")

    d_top_ask, d_top_bid, notional_top, h24 = [], [], [], []
    rows = []
    for m in mk:
        try:
            toks = json.loads(m.get("clobTokenIds") or "[]")
            outc = json.loads(m.get("outcomes") or "[]")
        except Exception:
            continue
        if len(toks) != 2:
            continue
        b = get(f"{CLOB}/book?token_id={toks[0]}")
        if not isinstance(b, dict) or "asks" not in b:
            continue
        asks = sorted((float(l["price"]), float(l["size"])) for l in b.get("asks", []))
        bids = sorted(((float(l["price"]), float(l["size"])) for l in b.get("bids", [])),
                      reverse=True)
        if not asks:
            continue
        pa, sa = asks[0]
        top3a = sum(s for _, s in asks[:3])
        pb, sb = (bids[0] if bids else (None, None))
        d_top_ask.append(sa)
        if sb is not None:
            d_top_bid.append(sb)
        notional_top.append(sa * pa)
        v = m.get("volume24hr") or 0
        h24.append(float(v))
        rows.append({"slug": m.get("slug"), "ask": pa, "size_ask": sa,
                     "size_ask_3niv": top3a, "notionnel_top": sa * pa,
                     "vol24": float(v), "tick": m.get("orderPriceMinTickSize")})
        time.sleep(0.03)

    rows.sort(key=lambda r: -r["vol24"])
    print(f"\n# {len(rows)} marches mesures (carnet YES)\n")
    def stats(x, lbl):
        x = sorted(x)
        n = len(x)
        print(f"  {lbl:34s} min={x[0]:>12,.1f} p25={x[n//4]:>12,.1f} median={statistics.median(x):>12,.1f} "
              f"p75={x[3*n//4]:>12,.1f} max={x[-1]:>14,.1f}")
    stats(d_top_ask, "taille dispo au meilleur ask (parts)")
    stats(notional_top, "notionnel au meilleur ask (USDC)")
    if d_top_bid:
        stats(d_top_bid, "taille dispo au meilleur bid (parts)")

    # par tranche de volume
    print("\n# Profondeur (parts au meilleur ask) par tranche de volume 24h")
    for lo, hi, lbl in [(0, 1e3, "< 1k"), (1e3, 1e4, "1k-10k"), (1e4, 1e5, "10k-100k"),
                        (1e5, 1e6, "100k-1M"), (1e6, 1e99, "> 1M")]:
        sub = [r["size_ask"] for r in rows if lo <= r["vol24"] < hi]
        if sub:
            print(f"  {lbl:>9}: n={len(sub):>3} median={statistics.median(sub):>10,.1f} parts "
                  f"({statistics.median([r['notionnel_top'] for r in rows if lo <= r['vol24'] < hi]):>9,.1f} USDC)")

    print("\n# Top 12 marches par volume 24h")
    for r in rows[:12]:
        print(f"  {r['slug'][:46]:46s} ask={r['ask']:.3f} taille_top={r['size_ask']:>10,.1f} "
              f"3niv={r['size_ask_3niv']:>10,.1f} notionnel={r['notionnel_top']:>9,.1f} USDC")
    json.dump(rows, open("depth_sample.json", "w"), indent=1)


if __name__ == "__main__":
    main()
