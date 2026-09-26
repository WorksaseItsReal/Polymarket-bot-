#!/usr/bin/env python3
"""Piste 1 (version finale): arbitrage multi-issues NET DE FRAIS.

Reprend les evenements negRisk ou somme(ask YES) < 1 (arb_multi.json), puis:
  1. recharge l'evenement et les VRAIS carnets CLOB de chaque jambe
  2. walk simultane de la profondeur avec la contrainte NETTE:
        somme(p_i) + somme(rate_i * p_i * (1-p_i)) < 1
     (frais taker Polymarket = rate * p * (1-p), rate lu dans feeSchedule)
  3. classe la partition: exhaustive (paliers numeriques -> une issue gagne
     TOUJOURS) vs liste d'entites (risque de trou)
  4. calcule le rendement annualise jusqu'a endDate
"""
import json, time, urllib.request, datetime

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
NOW = datetime.datetime.now(datetime.timezone.utc)

RATE = {"politics_fees": 0.04, "finance_prices_fees": 0.04, "mention_fees": 0.04,
        "tech_fees": 0.04, "economics_fees": 0.05, "culture_fees": 0.05,
        "sports_fees_v3": 0.05, "sports_fees_v2": 0.05, "weather_fees": 0.05,
        "other_fees": 0.05, "crypto_fees_v2": 0.07, "zero_fees": 0.0}


def get(url, tries=4, tout=25):
    for i in range(tries):
        try:
            r = urllib.request.Request(url, headers={"User-Agent": "arb/1.0"})
            with urllib.request.urlopen(r, timeout=tout) as h:
                return json.load(h)
        except Exception as e:
            if i == tries - 1:
                return {"__error__": str(e)}
            time.sleep(1.0 * (i + 1))


def book_asks(tok):
    d = get(f"{CLOB}/book?token_id={tok}")
    if not isinstance(d, dict) or "asks" not in d:
        return []
    return sorted((float(x["price"]), float(x["size"])) for x in d["asks"])


def fee_rate(m):
    fs = m.get("feeSchedule") or {}
    if isinstance(fs, dict) and fs.get("rate") is not None:
        return float(fs["rate"])
    return RATE.get(m.get("feeType") or "", 0.05)


def walk(legs):
    """legs: list of (asks, rate). Achat simultane 1 part de chaque jambe.
    Contrainte nette: somme(p) + somme(rate*p*(1-p)) < 1.
    Renvoie (q_max, profit_net_total, profit_net_unitaire)."""
    idx = [0] * len(legs)
    q = prof = 0.0
    while True:
        psum = 0.0
        fees = 0.0
        avail = []
        for i, (asks, rate) in enumerate(legs):
            if idx[i] >= len(asks):
                return q, prof, (prof / q if q else 0)
            p, s = asks[idx[i]]
            psum += p
            fees += rate * p * (1 - p)
            avail.append(s)
        if psum + fees >= 1.0:
            return q, prof, (prof / q if q else 0)
        take = min(avail)
        if take <= 0:
            return q, prof, (prof / q if q else 0)
        q += take
        prof += take * (1.0 - psum - fees)
        for i, (asks, rate) in enumerate(legs):
            p, s = asks[idx[i]]
            if s - take <= 1e-9:
                idx[i] += 1
            else:
                asks[idx[i]] = (p, s - take)


def classify(titles):
    """Heuristique: paliers numeriques complets = exhaustif;
    liste d'entites = risque de trou."""
    import re
    numish = 0
    for t in titles:
        s = str(t)
        if re.search(r"\d", s) or any(k in s.lower() for k in
                                      ("no change", "no prison", "no solution", "other", "none", "greater", "fewer", "less than", "more than", "+")):
            numish += 1
    return numish >= len(titles) - 1


def main():
    cands = [r for r in json.load(open("arb_multi.json")) if r["sum_yes_ask"] < 1.0]
    cands.sort(key=lambda x: x["sum_yes_ask"])
    print(f"# {len(cands)} evenements negRisk avec somme(ask YES) < 1 au moment du scan\n")
    tot_net = 0.0
    rows = []
    for r in cands:
        d = get(f"{GAMMA}/events?slug={r['slug']}")
        if not (isinstance(d, list) and d):
            print(f"[{r['slug']}] introuvable"); continue
        ev = d[0]
        legs = []
        titles = []
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
            titles.append(m.get("groupItemTitle") or m.get("question"))
            legs.append((book_asks(toks[yi]), fee_rate(m)))
            time.sleep(0.04)
        if len(legs) < 3:
            continue
        q, prof, unit = walk([(list(a), rt) for a, rt in legs])
        # endDate
        end = ev.get("endDate") or ev.get("markets", [{}])[0].get("endDate")
        try:
            tte = (datetime.datetime.fromisoformat(end.replace("Z", "+00:00")) - NOW).days
        except Exception:
            tte = None
        ex = classify(titles)
        rows.append({"slug": r["slug"], "n": len(legs), "gross_sum": r["sum_yes_ask"],
                     "q": round(q, 2), "net_total": round(prof, 4), "net_unit": round(unit, 5),
                     "exhaustive": ex, "tte_j": tte,
                     "ann": round(((1 + unit) ** (365 / tte) - 1) * 100, 2) if (tte and tte > 0 and unit > 0) else None})
        tot_net += prof
    rows.sort(key=lambda x: -x["net_total"])
    print(f"{'slug':>52} {'n':>3} {'somme':>7} {'q_max':>9} {'net_total':>10} {'net/unit':>9} {'exh':>4} {'TTE_j':>6} {'ann%':>7}")
    for x in rows:
        print(f"{x['slug'][:52]:>52} {x['n']:>3} {x['gross_sum']:>7.3f} {x['q']:>9.1f} {x['net_total']:>10.4f} "
              f"{x['net_unit']:>9.4f} {str(x['exhaustive']):>5} {str(x['tte_j']):>6} {str(x['ann']):>7}")
    print(f"\nPROFIT NET TOTAL EXECUTABLE (toutes opportunites du scan) = {tot_net:.2f} USDC")
    print(f"Capital necessaire (approx) = {sum(x['q'] * x['gross_sum'] for x in rows):.2f} USDC")
    ex_rows = [x for x in rows if x["exhaustive"] and x["net_total"] > 0]
    print(f"\nDont partitions EXHAUSTIVES rentables: {len(ex_rows)} -> net total "
          f"{sum(x['net_total'] for x in ex_rows):.2f} USDC")
    json.dump(rows, open("arb_final.json", "w"), indent=1)


if __name__ == "__main__":
    main()
