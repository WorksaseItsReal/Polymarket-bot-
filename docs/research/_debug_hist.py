#!/usr/bin/env python3
"""Debug: pourquoi prices-history ne renvoie rien sur les marches resolus ?"""
import json, urllib.request, calendar, datetime


def get(u):
    r = urllib.request.Request(u, headers={"User-Agent": "x/1"})
    return json.load(urllib.request.urlopen(r, timeout=20))


d = get("https://gamma-api.polymarket.com/markets?limit=5&closed=true&order=endDate&ascending=false")
for m in d:
    print("---", m.get("slug"), "| endDate:", m.get("endDate"), "| vol:", m.get("volumeNum"),
          "| prices:", m.get("outcomePrices"), "| umaStatus:", (m.get("umaResolutionStatuses") or "")[:40])
    toks = json.loads(m.get("clobTokenIds") or "[]")
    print("   tok0:", (toks[0][:32] if toks else None), "| tick:", m.get("orderPriceMinTickSize"))
    try:
        s = (m.get("endDate") or "").replace("Z", "+00:00")
        end = calendar.timegm(datetime.datetime.fromisoformat(s).utctimetuple())
        print("   end_ts:", end, datetime.datetime.utcfromtimestamp(end), "UTC")
        h = get(f"https://clob.polymarket.com/prices-history?market={toks[0]}&startTs={end-4*86400}&endTs={end-3600}&fidelity=60")
        pts = h.get("history", [])
        print("   fenetre 4j->1h avant fin: pts=", len(pts),
              (pts[0], pts[-1]) if pts else "")
        # essai sans bornes
        h2 = get(f"https://clob.polymarket.com/prices-history?market={toks[0]}&interval=max&fidelity=1440")
        p2 = h2.get("history", [])
        print("   interval=max: pts=", len(p2), (p2[0], p2[-1]) if p2 else "")
    except Exception as e:
        print("   ERR", repr(e))
