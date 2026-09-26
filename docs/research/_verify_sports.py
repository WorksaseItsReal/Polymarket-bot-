#!/usr/bin/env python3
"""Verification manuelle des marches sportifs a prix d'ouverture 0.45-0.60
(W R mesure 72% a un prix de 0.50). On affiche l'identite et l'historique
brut pour trouver l'origine de l'ecart."""
import json, urllib.request, datetime, time

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"


def get(u, t=25):
    r = urllib.request.Request(u, headers={"User-Agent": "x/1"})
    return json.load(urllib.request.urlopen(r, timeout=t))


d = json.load(open("favlong_sports.json"))
b = [r for r in d if r.get("p_6h") is not None and 0.45 <= r["p_6h"] < 0.60]
print(f"bucket 0.45-0.60 a l'ouverture: n={len(b)}, WR={sum(r['won0'] for r in b)/len(b):.3f}\n")

for r in b[:6]:
    m = get(f"{GAMMA}/markets?slug={r['slug']}")
    if not (isinstance(m, list) and m):
        print("introuvable", r["slug"]); continue
    m = m[0]
    assert m.get("slug") == r["slug"], f"IDENTITE NON VERIFIEE {m.get('slug')} != {r['slug']}"
    print(f"--- {r['slug']}")
    print(f"    question   : {str(m.get('question'))[:80]}")
    print(f"    outcomes   : {m.get('outcomes')}   prices finaux: {m.get('outcomePrices')}")
    print(f"    bestBid/Ask: {m.get('bestBid')}/{m.get('bestAsk')}  vol={m.get('volumeNum')}")
    print(f"    endDate    : {m.get('endDate')}   umaStatus={str(m.get('umaResolutionStatuses'))[:50]}")
    toks = json.loads(m.get("clobTokenIds") or "[]")
    h = get(f"{CLOB}/prices-history?market={toks[0]}&interval=max&fidelity=60")
    pts = (h or {}).get("history") or []
    print(f"    historique toks[0]: {len(pts)} pts")
    if pts:
        f = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%m-%d %H:%M")
        print(f"      premier: {f(pts[0]['t'])} p={pts[0]['p']}   dernier: {f(pts[-1]['t'])} p={pts[-1]['p']}")
        mid = pts[len(pts)//2]
        print(f"      milieu : {f(mid['t'])} p={mid['p']}")
        print(f"      won0={r['won0']}  -> p_6h(stocke)={r['p_6h']}  p_close(stocke)={r['p_close']}")
    time.sleep(0.1)
