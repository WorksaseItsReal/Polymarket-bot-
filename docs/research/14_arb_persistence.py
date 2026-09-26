#!/usr/bin/env python3
"""Duree de vie de l'arbitrage de partition: re-mesure des candidats
apres le scan initial (question 'est-il capturable / combien de temps dure-t-il')."""
import json, time, urllib.request, datetime

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
NOW = datetime.datetime.now(datetime.timezone.utc)

SLUGS = ["how-many-tropical-cyclones-will-make-landfall-in-china-during-2026-20260805184236864",
         "which-millennium-prize-problem-will-ai-solve-next",
         "maduro-prison-time-527",
         "us-tariff-rate-on-china-on-december-31-2026",
         "argentina-annual-inflation-2026",
         "china-annual-inflation-2026"]


def get(u, t=25):
    for i in range(3):
        try:
            r = urllib.request.Request(u, headers={"User-Agent": "x/1"})
            return json.load(urllib.request.urlopen(r, timeout=t))
        except Exception:
            time.sleep(1)


def asks(tok):
    d = get(f"{CLOB}/book?token_id={tok}")
    if not isinstance(d, dict) or "asks" not in d:
        return []
    return sorted((float(x["price"]), float(x["size"])) for x in d["asks"])


print(f"# re-scan a {NOW.isoformat()}")
print(f"# {'slug':>52} {'n':>3} {'somme_ask':>10} {'somme_bid':>10} {'<1 ?':>6}")
res = []
for s in SLUGS:
    d = get(f"{GAMMA}/events?slug={s}")
    if not (isinstance(d, list) and d):
        print("introuvable", s); continue
    ev = d[0]
    assert s == ev["slug"], "identite non verifiee"
    asks_list, bids_list = [], []
    for m in ev.get("markets", []):
        if m.get("closed"):
            continue
        try:
            outc = json.loads(m.get("outcomes") or "[]")
            toks = json.loads(m.get("clobTokenIds") or "[]")
        except Exception:
            continue
        if len(outc) != 2 or len(toks) != 2:
            continue
        yi = 0 if str(outc[0]).lower() == "yes" else (1 if str(outc[1]).lower() == "yes" else None)
        if yi is None:
            continue
        b = get(f"{CLOB}/book?token_id={toks[yi]}")
        la = sorted((float(x["price"]), float(x["size"])) for x in b.get("asks", [])) if isinstance(b, dict) else []
        lb = sorted(((float(x["price"]), float(x["size"])) for x in b.get("bids", [])), reverse=True) if isinstance(b, dict) else []
        if la:
            asks_list.append(la[0][0])
        if lb:
            bids_list.append(lb[0][0])
        time.sleep(0.03)
    if len(asks_list) < 3:
        continue
    sa, sb = sum(asks_list), sum(bids_list)
    res.append((s, len(asks_list), sa, sb))
    print(f"  {s[:52]:>52} {len(asks_list):>3} {sa:>10.4f} {sb:>10.4f} {'OUI' if sa<1 else 'non':>6}")

# comparaison avec le scan initial
init = {r["slug"]: r["sum_yes_ask"] for r in json.load(open("arb_multi.json"))}
print(f"\n{'slug':>52} {'somme_initial':>14} {'somme_maintenant':>17} {'delta':>8}")
for s, n, sa, sb in res:
    if s in init:
        print(f"  {s[:52]:>52} {init[s]:>14.4f} {sa:>17.4f} {sa-init[s]:>+8.4f}")
json.dump([{"slug": s, "n": n, "sum_ask": sa, "sum_bid": sb, "ts": NOW.isoformat()} for s, n, sa, sb in res],
          open("arb_persist.json", "w"), indent=1)
