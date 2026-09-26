#!/usr/bin/env python3
"""Piste 1b (v2, rapide): arbitrage partition multi-issues via bestAsk Gamma.

Un evenement negRisk=True = issues mutuellement exclusives (exactement une
resout YES). Si la somme des meilleurs ASK de tous les YES est < 1.00,
acheter 1 part de chaque = gain garanti (1 - somme).

On utilise le champ bestAsk de Gamma (pas d'appel orderbook par marche) ->
scan large et rapide. Tous les chiffres viennent de l'API.
"""
import json, time, urllib.request, statistics, sys

GAMMA = "https://gamma-api.polymarket.com"


def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "arb-research/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                return {"__error__": str(e)}
            time.sleep(1.5 * (i + 1))


def main():
    target = int(sys.argv[1]) if len(sys.argv) > 1 else 1500
    events, off = [], 0
    while len(events) < target:
        d = get(f"{GAMMA}/events?limit=100&offset={off}&closed=false&order=volume24hr&ascending=false")
        if not isinstance(d, list) or not d:
            break
        events += d
        if len(d) < 100:
            break
        off += 100
        time.sleep(0.1)
    print(f"# events recuperes: {len(events)}", file=sys.stderr)

    rows = []
    for ev in events:
        if not ev.get("negRisk"):
            continue
        mks = [m for m in (ev.get("markets") or []) if not m.get("closed")]
        asks, titles = [], []
        ok = True
        for m in mks:
            try:
                outc = json.loads(m.get("outcomes") or "[]")
            except Exception:
                ok = False; break
            if len(outc) != 2:
                ok = False; break
            yi = 0 if str(outc[0]).lower() in ("yes", "1", "true") else (
                 1 if str(outc[1]).lower() in ("yes", "1", "true") else None)
            if yi is None:
                ok = False; break
            a = m.get("bestAsk")
            if a is None:
                ok = False; break
            asks.append(float(a))
            titles.append(m.get("groupItemTitle") or m.get("question"))
        if not ok or len(asks) < 3:
            continue
        s = sum(asks)
        rows.append({
            "slug": ev.get("slug"), "title": ev.get("title"),
            "n": len(asks), "sum_yes_ask": round(s, 5), "gain_per_unit": round(1 - s, 5),
            "vol24": ev.get("volume24hr"), "liquidity": ev.get("liquidity"),
            "min_ask": min(asks), "max_ask": max(asks),
            "titles": titles[:50],
        })

    with open("arb_multi.json", "w") as f:
        json.dump(rows, f, indent=1)

    print(f"\n=== {len(rows)} events negRisk a >=3 issues, bestAsk disponible partout ===")
    ss = sorted(r["sum_yes_ask"] for r in rows)
    if ss:
        print(f"somme YES: min={ss[0]:.4f} p05={ss[len(ss)//20]:.4f} p25={ss[len(ss)//4]:.4f} "
              f"median={statistics.median(ss):.4f} p75={ss[3*len(ss)//4]:.4f} max={ss[-1]:.4f}")
        print(f"moyenne={statistics.mean(ss):.4f}")
    arbs = [r for r in rows if r["sum_yes_ask"] < 1.0]
    print(f"\n### negRisk ou somme YES < 1.00 : {len(arbs)} / {len(rows)} "
          f"({100*len(arbs)/max(1,len(rows)):.1f}%)")
    for r in sorted(arbs, key=lambda x: x["sum_yes_ask"])[:30]:
        print(f"  sum={r['sum_yes_ask']:.4f} gain/u={r['gain_per_unit']:+.4f} n={r['n']:3d} "
              f"vol24={round(r['vol24'] or 0)} {str(r['slug'])[:55]}")
    print("\n--- 10 plus basses sommes ---")
    for r in sorted(rows, key=lambda x: x["sum_yes_ask"])[:10]:
        print(f"  sum={r['sum_yes_ask']:.4f} n={r['n']:3d} vol24={round(r['vol24'] or 0)} {str(r['slug'])[:58]}")
    print("\n--- 5 plus hautes sommes (surcote manifeste -> vente) ---")
    for r in sorted(rows, key=lambda x: -x["sum_yes_ask"])[:5]:
        print(f"  sum={r['sum_yes_ask']:.4f} n={r['n']:3d} {str(r['slug'])[:58]}")
    return rows


if __name__ == "__main__":
    main()
