#!/usr/bin/env python3
"""Piste 1: arbitrage YES+NO sur marches binaires Polymarket.

Methode: pour chaque marche actif (top volume), recuperer les 2 orderbooks CLOB
(YES et NO) et calculer:
  - best_ask_yes + best_ask_no   (acheter les deux cotes -> gain si somme < 1)
  - best_bid_yes + best_bid_no   (vendre les deux cotes -> gain si somme > 1)
Puis mesurer la taille executable (walk du carnet jusqu'a somme >= 1).

Aucune invention: tous les chiffres viennent des reponses API brutes.
"""
import json, time, urllib.request, urllib.parse, sys

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"


def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "arb-research/1.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                return {"__error__": str(e)}
            time.sleep(1.5 * (i + 1))


def fetch_markets(limit_total=300):
    """Marches ouverts tries par volume 24h. Pagination via offset."""
    out, seen = [], set()
    offset = 0
    while len(out) < limit_total:
        url = (f"{GAMMA}/markets?limit=100&offset={offset}"
               f"&closed=false&active=true&order=volume24hr&ascending=false")
        d = get(url)
        if not isinstance(d, list) or not d:
            break
        for m in d:
            cid = m.get("conditionId")
            if cid and cid not in seen:
                seen.add(cid)
                out.append(m)
        if len(d) < 100:
            break
        offset += 100
        time.sleep(0.15)
    return out


def book(token_id):
    d = get(f"{CLOB}/book?token_id={token_id}")
    if not isinstance(d, dict) or "__error__" in d or "asks" not in d:
        return None
    def norm(side):
        # Polymarket renvoie asks du plus cher au moins cher; bids l'inverse.
        rows = []
        for lvl in d.get(side, []):
            try:
                rows.append((float(lvl["price"]), float(lvl["size"])))
            except Exception:
                pass
        return rows
    asks = sorted(norm("asks"))          # prix croissant
    bids = sorted(norm("bids"), reverse=True)  # prix decroissant
    return {"asks": asks, "bids": bids, "ts": d.get("timestamp"),
            "neg_risk": d.get("neg_risk"), "min_order_size": d.get("min_order_size"),
            "tick_size": d.get("tick_size")}


def exec_size(asks_a, asks_b):
    """Quantite max telle que ask_yes(q) + ask_no(q) < 1 (walk simultane).
    On suppose que les carnets se remplissent au prix limite: on cherche
    le plus grand q ou la somme des deux prix (marginal) reste < 1."""
    total = 0.0
    profit = 0.0
    ia = ib = 0
    # avance par petits pas sur les niveaux de prix
    pa = list(asks_a)
    pb = list(asks_b)
    while ia < len(pa) and ib < len(pb):
        p_a, s_a = pa[ia]
        p_b, s_b = pb[ib]
        if p_a + p_b >= 1.0:
            break
        take = min(s_a, s_b)
        if take <= 0:
            break
        total += take
        profit += take * (1.0 - (p_a + p_b))
        pa[ia] = (p_a, s_a - take)
        pb[ib] = (p_b, s_b - take)
        if pa[ia][1] <= 1e-9:
            ia += 1
        if pb[ib][1] <= 1e-9:
            ib += 1
    return total, profit


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    mk = fetch_markets(n)
    print(f"# marches actifs recuperes: {len(mk)}", file=sys.stderr)
    rows = []
    for i, m in enumerate(mk):
        try:
            toks = json.loads(m.get("clobTokenIds") or "[]")
            outc = json.loads(m.get("outcomes") or "[]")
        except Exception:
            continue
        if len(toks) != 2 or len(outc) != 2:
            continue
        # ordre Gamma: outcomes[0] = Yes/1er, toks[0] associe
        ba, bb = book(toks[0]), book(toks[1])
        if not ba or not bb:
            continue
        ask_yes = ba["asks"][0][0] if ba["asks"] else None
        ask_no = bb["asks"][0][0] if bb["asks"] else None
        bid_yes = ba["bids"][0][0] if ba["bids"] else None
        bid_no = bb["bids"][0][0] if bb["bids"] else None
        row = {
            "slug": m.get("slug"),
            "q": m.get("question"),
            "neg_risk": m.get("negRisk"),
            "vol24": m.get("volume24hr"),
            "liq": m.get("liquidityNum") or m.get("liquidity"),
            "ask_yes": ask_yes, "ask_no": ask_no,
            "bid_yes": bid_yes, "bid_no": bid_no,
            "spread_gamma": m.get("spread"),
            "prices": m.get("outcomePrices"),
            "outcomes": outc,
            "end": m.get("endDate"),
        }
        if ask_yes is not None and ask_no is not None:
            row["sum_ask"] = round(ask_yes + ask_no, 6)
            sz, pf = exec_size(ba["asks"], bb["asks"])
            row["exec_size"] = round(sz, 2)
            row["exec_profit"] = round(pf, 4)
        if bid_yes is not None and bid_no is not None:
            row["sum_bid"] = round(bid_yes + bid_no, 6)
        rows.append(row)
        if (i + 1) % 25 == 0:
            print(f"  ... {i+1}/{len(mk)}", file=sys.stderr)
        time.sleep(0.05)

    with open("arb_scan.json", "w") as f:
        json.dump(rows, f, indent=1)

    valid = [r for r in rows if "sum_ask" in r]
    print(f"\n=== SCAN TERMINE: {len(rows)} marches avec 2 carnets, {len(valid)} avec ask des 2 cotes ===")
    arbs = [r for r in valid if r["sum_ask"] < 1.0]
    print(f"Marches ou ask_YES + ask_NO < 1.00 : {len(arbs)} / {len(valid)} "
          f"({100*len(arbs)/max(1,len(valid)):.2f}%)")
    if valid:
        s = sorted(r["sum_ask"] for r in valid)
        import statistics
        print(f"sum_ask  min={s[0]:.4f}  p05={s[len(s)//20]:.4f}  median={statistics.median(s):.4f}  "
              f"max={s[-1]:.4f}  moyenne={statistics.mean(s):.4f}")
    if arbs:
        print("\n--- Détail des écarts capturables ---")
        for r in sorted(arbs, key=lambda x: x["sum_ask"]):
            print(f"  sum={r['sum_ask']:.4f} size_exec={r['exec_size']:.2f} gain_brut={r['exec_profit']:.4f} "
                  f"neg_risk={r['neg_risk']} {r['slug'][:60]}")

    # Reverse: bid_YES + bid_NO > 1
    rb = [r for r in valid if r.get("sum_bid", 0) > 1.0]
    print(f"\nMarches ou bid_YES + bid_NO > 1.00 (vente des 2 cotes) : {len(rb)} / {len(valid)}")
    for r in sorted(rb, key=lambda x: -x["sum_bid"])[:10]:
        print(f"  sum_bid={r['sum_bid']:.4f} {r['slug'][:60]}")
    return rows


if __name__ == "__main__":
    main()
