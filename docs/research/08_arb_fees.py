#!/usr/bin/env python3
"""Piste 1 (version finale): arbitrage multi-issues NET DE FRAIS.

Reprend les evenements negRisk dont la somme des YES est < 1, mais:
 - recalcule la profondeur executable sur les VRAIS carnets CLOB (walk simultane)
 - applique les frais taker reels: fee = rate * p * (1-p) par part (doc Polymarket)
   rate par categorie: geopolitique 0, politics/tech/finance 0.04, sports/economics/
   culture/weather/other 0.05, crypto 0.07 -- lu depuis feeSchedule du marche.
 - verifie que la partition est EXHAUSTIVE (sinon 'somme<1' n'est pas un arbitrage):
   classes de partitions: bandes numeriques, oui/non explicite, liste de candidats.
   Un evenement 'liste de candidats' sans jambe 'aucun/other' est SIGNALE comme trou.

Sortie: par evenement, q_max, profit brut, frais, profit net, rendement annualise
(horizon = endDate).
"""
import json, time, urllib.request, datetime, math

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
NOW = datetime.datetime.now(datetime.timezone.utc)
CAT_RATE = {"zero_fees": 0.0, "geopolitics": 0.0, "politics_fees": 0.04,
            "tech_fees": 0.04, "finance_fees": 0.04, "mentions_fees": 0.04,
            "sports_fees_v3": 0.05, "economics_fees": 0.05, "culture_fees": 0.05,
            "weather_fees": 0.05, "other_fees": 0.05, "crypto_fees_v2": 0.07}


def get(url, tries=3, tout=25):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "research/1.0"})
            with urllib.request.urlopen(req, timeout=tout) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                return {"__error__": str(e)}
            time.sleep(0.7 * (i + 1))


def asks(token):
    d = get(f"{CLOB}/book?token_id={token}")
    if not isinstance(d, dict) or "asks" not in d:
        return []
    return sorted((float(l["price"]), float(l["size"])) for l in d["asks"])


def classify(markets):
    """Retourne (classe, trou_potentiel)."""
    titles = [str(m.get("groupItemTitle") or m.get("question") or "") for m in markets]
    tl = [t.lower() for t in titles]
    if any(("no solution" in t) or ("none" in t) or ("other" in t) or ("no prison" in t)
           or ("no change" in t) or ("fewer than" in t) or ("greater than" in t) for t in tl):
        return "partition explicite (jambe 'aucun/borne' presente)", False
    # bandes numeriques -> exhaustif par construction
    numeric = 0
    for t in titles:
        s = t.replace("%", "").replace(",", "").replace("$", "").strip()
        if any(c.isdigit() for c in s):
            numeric += 1
    if numeric == len(titles) and len(titles) >= 3:
        return "bandes numeriques (exhaustives par construction)", False
    return "liste de candidats SANS jambe 'aucun/other'", True


def main():
    rows = json.load(open("arb_multi.json"))
    tops = sorted([r for r in rows if r["sum_yes_ask"] < 1.0], key=lambda x: x["sum_yes_ask"])
    print(f"# {len(tops)} evenements negRisk avec somme YES < 1 (scan Gamma)\n")
    out = []
    for r in tops:
        ev = get(f"{GAMMA}/events?slug={r['slug']}")
        if not isinstance(ev, list) or not ev:
            continue
        ev = ev[0]
        mks = [m for m in ev.get("markets", []) if not m.get("closed")]
        cls, hole = classify(mks)
        end = datetime.datetime.fromisoformat(ev["endDate"].replace("Z", "+00:00"))
        tau_y = (end - NOW).total_seconds() / (365 * 86400)
        books, fees, rate = [], 0.0, None
        for m in mks:
            try:
                outc = json.loads(m.get("outcomes") or "[]")
                toks = json.loads(m.get("clobTokenIds") or "[]")
            except Exception:
                continue
            if len(outc) != 2:
                continue
            yi = 0 if str(outc[0]).lower() == "yes" else 1
            books.append(asks(toks[yi]))
            if rate is None:
                rate = CAT_RATE.get(m.get("feeType"), 0.05)
            time.sleep(0.04)
        if not books or any(not b for b in books):
            continue
        # walk simultane
        idx = [0] * len(books)
        q = prof = 0.0
        while True:
            psum = 0.0
            avail = []
            for i, b in enumerate(books):
                if idx[i] >= len(b):
                    psum = 99
                    break
                p, s = b[idx[i]]
                psum += p
                avail.append(s)
            if psum >= 1.0:
                break
            take = min(avail)
            if take <= 0:
                break
            q += take
            prof += take * (1.0 - psum)
            # frais sur cette tranche
            for i, b in enumerate(books):
                p, s = b[idx[i]]
                fees += take * rate * p * (1 - p)
                if s - take <= 1e-9:
                    idx[i] += 1
                else:
                    b[idx[i]] = (p, s - take)
        if q <= 0:
            continue
        net = prof - fees
        roi = net / sum(b[min(idx[i], len(b)-1)][0] for i, b in enumerate(books) if b) if q else 0
        out.append({"slug": r["slug"], "title": ev.get("title"), "n": len(mks),
                    "gamma_sum": r["sum_yes_ask"], "q_max": round(q, 2),
                    "gross": round(prof, 4), "fees": round(fees, 4), "net": round(net, 4),
                    "rate": rate, "cls": cls, "hole": hole,
                    "endDate": ev.get("endDate"), "horizon_m": round(tau_y * 12, 1),
                    "roi_pct": round(100 * net / max(1e-9, q * (r["sum_yes_ask"] + 0.0)), 2)})
        print(f"{r['slug'][:52]:52s} n={len(mks):>3} sum={r['sum_yes_ask']:.4f} "
              f"q={q:>8.1f} brut={prof:>7.3f} frais={fees:>6.3f} NET={net:>7.3f} "
              f"rate={rate} horizon={tau_y*12:.0f}m trou={'OUI' if hole else 'non'}")
    json.dump(out, open("arb_multi_final.json", "w"), indent=1)
    tot_g = sum(o["gross"] for o in out)
    tot_f = sum(o["fees"] for o in out)
    tot_n = sum(o["net"] for o in out)
    print(f"\n### TOTAL sur {len(out)} evenements capturables")
    print(f"  profit brut executable = {tot_g:.2f} USDC")
    print(f"  frais taker            = {tot_f:.2f} USDC ({100*tot_f/max(1e-9,tot_g):.0f}% du brut)")
    print(f"  profit NET             = {tot_n:.2f} USDC")
    print(f"  trous de partition detectes: {sum(1 for o in out if o['hole'])}/{len(out)}")
    for o in sorted(out, key=lambda x: -x["net"])[:12]:
        print(f"   net={o['net']:>+7.3f} q={o['q_max']:>8.1f} {o['roi_pct']:>6.1f}% roi~ "
              f"{o['horizon_m']:>4}m {'TROU' if o['hole'] else '    '} {o['slug'][:44]}")


if __name__ == "__main__":
    main()
