#!/usr/bin/env python3
"""extra_checks.py — contrôles complémentaires pour EDGE.md.

1. Validation croisée re-résolution vs `realized` enregistré par le bot.
2. Split de régime temporel (avant/après le correctif de résolution du
   2026-09-25T21:31, cf. audit dans cumulative.json).
3. Faux positifs attendus par multiple-comparaisons.
4. Cohérence avec pnl.json (chiffre revendiqué par le bot).

Lecture seule sur /root/.polymarket. Ne dépend que de measure_edge.py
(cache edge_resolutions_cache.json).
"""
import json
import math
import os

HOME = os.environ.get("HOME", "/root")
POLY = os.path.join(HOME, ".polymarket")
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "edge_resolutions_cache.json")

SRCS = [
    os.path.join(POLY, "history.json"),
    os.path.join(POLY, "archive", "2026-09-18", "history.json"),
    os.path.join(POLY, "archive", "2026-09-25", "history.json"),
]
COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE"]


def load_rows():
    trades = {}
    for p in SRCS:
        for e in json.load(open(p)):
            if (e.get("side") in ("YES", "NO") and e.get("roundId")
                    and isinstance(e.get("price"), (int, float)) and e["price"] > 0
                    and e.get("coin")):
                trades.setdefault(e["roundId"], e)
    res = json.load(open(CACHE))
    rows = []
    for rid, t in trades.items():
        r = res.get(rid, {})
        if r.get("status") != "resolved":
            continue
        win = (r["up"] and t["side"] == "YES") or ((not r["up"]) and t["side"] == "NO")
        rows.append({**t, "win": win,
                     "pnl": (1 - t["price"]) / t["price"] if win else -1.0})
    return rows


def tstat(xs):
    n = len(xs)
    m = sum(xs) / n
    sd = (sum((x - m) ** 2 for x in xs) / (n - 1)) ** 0.5 if n > 1 else float("nan")
    se = sd / math.sqrt(n)
    return n, m, sd, se, (m / se if se > 0 else float("nan")), sum(xs)


def main():
    rows = load_rows()
    print(f"Trades résolus : {len(rows)}\n")

    print("=" * 70)
    print("1. VALIDATION CROISÉE (re-résolution vs realized enregistré)")
    print("=" * 70)
    agree = disagree = checked = 0
    for r in rows:
        br = r.get("realized")
        if isinstance(br, (int, float)) and not isinstance(br, bool) and br != 0:
            checked += 1
            if (br > 0) == r["win"]:
                agree += 1
            else:
                disagree += 1
                print(f"  DISCORDANT {r['roundId']} {r['coin']} {r['side']} "
                      f"p={r['price']} bot={br} hold-to-expiry_win={r['win']} "
                      f"soldTp={r.get('soldTp')} sl={r.get('sl')}")
    print(f"  {checked} comparables | {agree} concordants | {disagree} discordants "
          f"({disagree/checked*100:.1f}%)")

    print()
    print("=" * 70)
    print("2. SPLIT DE RÉGIME TEMPOREL (correctif de résolution 2026-09-25T21:31)")
    print("=" * 70)
    cut = "2026-09-25T21:31"
    for lab, f in [("AVANT correctif", lambda t: (t.get("ts") or "") < cut),
                   ("APRÈS correctif", lambda t: (t.get("ts") or "") >= cut)]:
        xs = [r["pnl"] for r in rows if f(r)]
        if not xs:
            continue
        n, m, sd, se, t, tot = tstat(xs)
        print(f"  {lab:16s} n={n:>3d} WR={sum(1 for x in xs if x>0)/n*100:5.1f}% "
              f"mean={m:+.4f}€ sd={sd:.4f} t={t:+.2f} total={tot:+.3f}€")

    print()
    print("=" * 70)
    print("3. MULTIPLE-COMPARAISONS (faux positifs attendus à |t|>2)")
    print("=" * 70)
    for k, lab in [(5, "5 coins"), (5, "5 tranches"), (10, "5 coins + 5 tranches")]:
        p = 1 - 0.9545 ** k
        print(f"  {lab:24s} : P(>=1 faux positif à |t|>2) = {p*100:.1f}%")

    print()
    print("=" * 70)
    print("4. COHÉRENCE AVEC pnl.json (chiffre revendiqué par le bot)")
    print("=" * 70)
    pj = json.load(open(os.path.join(POLY, "pnl.json")))
    print(f"  pnl.json : trades={pj.get('trades')} wins={pj.get('wins')} "
          f"losses={pj.get('losses')} win_rate={pj.get('win_rate')}% "
          f"pnl={pj.get('pnl')}€ pending={pj.get('pending')}")
    xs = [r["pnl"] for r in rows]
    n, m, sd, se, t, tot = tstat(xs)
    print(f"  hold-to-expiry recalculé : n={n} pnl_total={tot:+.3f}€ t={t:+.2f}")
    print(f"  as-executed recalculé    : n={n} "
          f"pnl_total={sum(r['realized'] for r in rows if isinstance(r.get('realized'),(int,float)) and not isinstance(r.get('realized'),bool) and r['realized']!=0):+.3f}€")
    print(f"  Écart pnl.json(total) vs hold-to-expiry : "
          f"{pj.get('pnl',0)-tot:+.3f}€")


if __name__ == "__main__":
    main()
