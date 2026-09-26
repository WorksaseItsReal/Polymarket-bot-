#!/usr/bin/env python3
"""
measure_edge.py — mesure de l'edge RÉEL du paperbot Polymarket « Up or Down 5m ».

Pourquoi ce script re-résout tout au lieu de lire `realized` :
  le champ `realized` de history.json est corrompu par un bug de résolution
  historique (cf. audit dans /root/.polymarket/cumulative.json :
  `gamma-api/markets?condition_id=` ignore le filtre → tous les YES enregistrés
  perdants, tous les NO gagnants). On re-résout donc CHAQUE round de façon
  indépendante à partir de la source officielle (Gamma events?slug=), et on
  vérifie systématiquement que le slug retourné == le slug demandé.

Source des trades : union de
  /root/.polymarket/history.json
  /root/.polymarket/archive/2026-09-18/history.json
  /root/.polymarket/archive/2026-09-25/history.json
dédupliquée par roundId, en ne gardant que les décisions YES/NO (les HOLD ne
portent aucune information de PnL).

Modèle de PnL (mise = 1 €) :
  gain si le côté acheté gagne : (1 - p) / p      (p = prix d'entrée du côté)
  perte si le côté acheté perd : -1

Sorties : stats par coin, stats par tranche de prix d'entrée, t-stats, IC95,
et le nombre de trades requis pour atteindre |t| > 2.

Usage :  python3 measure_edge.py [--refresh] [--json]
  --refresh  ignore le cache de résolutions et re-interroge l'API
  --json     émet aussi un dump JSON machine-lisible
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

HOME = os.environ.get("HOME", "/root")
POLY = os.path.join(HOME, ".polymarket")
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "edge_resolutions_cache.json")

HISTORY_SOURCES = [
    os.path.join(POLY, "history.json"),
    os.path.join(POLY, "archive", "2026-09-18", "history.json"),
    os.path.join(POLY, "archive", "2026-09-25", "history.json"),
]

GAMMA = "https://gamma-api.polymarket.com/events"
COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE"]
BUCKETS = [
    ("<0.55", 0.0, 0.55),
    ("0.55-0.60", 0.55, 0.60),
    ("0.60-0.65", 0.60, 0.65),
    ("0.65-0.70", 0.65, 0.70),
    ("0.70-0.75", 0.70, 0.75),
    ("0.75+", 0.75, 1.01),
]


# --------------------------------------------------------------------------
# 1. Chargement du ledger de trades
# --------------------------------------------------------------------------
def load_trades():
    trades: dict[str, dict] = {}
    per_source: dict[str, str] = {}
    for path in HISTORY_SOURCES:
        if not os.path.exists(path):
            per_source[path] = "ABSENT"
            continue
        try:
            data = json.load(open(path))
        except Exception as e:  # noqa: BLE001
            per_source[path] = f"ERREUR {e}"
            continue
        n_new = 0
        for e in data:
            if not isinstance(e, dict):
                continue
            side = e.get("side")
            if side not in ("YES", "NO"):
                continue
            rid = e.get("roundId")
            price = e.get("price")
            coin = e.get("coin")
            if not rid or not isinstance(price, (int, float)) or price <= 0 or not coin:
                continue
            if rid not in trades:
                trades[rid] = {
                    "roundId": rid,
                    "coin": coin,
                    "side": side,
                    "price": float(price),
                    "ts": e.get("ts"),
                    "conditionId": e.get("conditionId"),
                    "bot_realized": e.get("realized"),
                }
                n_new += 1
        per_source[path] = f"{len(data)} entrées, {n_new} nouveaux trades YES/NO"
    return trades, per_source


# --------------------------------------------------------------------------
# 2. Résolution via Gamma events?slug=
# --------------------------------------------------------------------------
def slot_from_slug(slug: str) -> int | None:
    m = slug.rsplit("-", 1)
    if len(m) != 2:
        return None
    try:
        return int(m[1])
    except ValueError:
        return None


def resolve_slug(slug: str) -> dict:
    """Retourne {status, up: bool|None, slug_ok: bool, raw: ...}."""
    out = {"slug": slug, "status": "error", "up": None, "slug_ok": False}
    q = urllib.parse.urlencode({"slug": slug, "limit": 1})
    url = f"{GAMMA}?{q}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "measure-edge/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        out["status"] = f"http_error:{type(e).__name__}"
        return out
    if not data:
        out["status"] = "not_found"
        return out
    ev = data[0]
    returned = ev.get("slug")
    out["slug_ok"] = (returned == slug)
    if not out["slug_ok"]:
        out["status"] = f"slug_mismatch:{returned}"
        return out
    for m in ev.get("markets", []):
        prices = m.get("outcomePrices")
        if isinstance(prices, str):
            try:
                prices = json.loads(prices)
            except Exception:  # noqa: BLE001
                continue
        outcomes = m.get("outcomes")
        if isinstance(outcomes, str):
            try:
                outcomes = json.loads(outcomes)
            except Exception:  # noqa: BLE001
                outcomes = None
        if not prices or len(prices) < 2:
            continue
        try:
            p0, p1 = float(prices[0]), float(prices[1])
        except (TypeError, ValueError):
            continue
        closed = bool(m.get("closed"))
        if not closed or abs(p0 - p1) < 0.5:
            out["status"] = "unresolved"
            return out
        # outcomes[0] == "Up" : YES (Up) gagne si p0 == 1
        out["up"] = (p0 > p1)
        out["status"] = "resolved"
        out["outcomes"] = outcomes
        return out
    out["status"] = "no_market_data"
    return out


def resolve_all(trades: dict[str, dict], refresh: bool) -> dict[str, dict]:
    cache = {}
    if os.path.exists(CACHE) and not refresh:
        try:
            cache = json.load(open(CACHE))
        except Exception:  # noqa: BLE001
            cache = {}
    todo = [r for r in trades if r not in cache or cache[r].get("status") != "resolved"]
    print(f"[resolve] {len(trades)} rounds, {len(trades) - len(todo)} en cache, "
          f"{len(todo)} à interroger", file=sys.stderr)
    for i, rid in enumerate(todo, 1):
        res = resolve_slug(rid)
        cache[rid] = res
        if i % 25 == 0 or i == len(todo):
            print(f"[resolve] {i}/{len(todo)}", file=sys.stderr)
        time.sleep(0.12)
    with open(CACHE, "w") as fh:
        json.dump(cache, fh, indent=1)
    return cache


# --------------------------------------------------------------------------
# 3. Statistiques
# --------------------------------------------------------------------------
def realized_of(price: float, win: bool) -> float:
    return (1.0 - price) / price if win else -1.0


def stats(samples: list[float], wins: int) -> dict:
    """samples = liste des PnL par trade. wins = nombre de gains (realized>0)."""
    n = len(samples)
    if n == 0:
        return {"n": 0}
    mean = sum(samples) / n
    if n > 1:
        var = sum((x - mean) ** 2 for x in samples) / (n - 1)  # échantillon
        sd = math.sqrt(var)
    else:
        sd = float("nan")
    se = sd / math.sqrt(n) if n > 0 and sd == sd else float("nan")
    t = mean / se if se and se == se and se > 0 else float("nan")
    return {
        "n": n,
        "wins": wins,
        "wr": wins / n,
        "mean": mean,
        "sd": sd,
        "se": se,
        "t": t,
        "total": sum(samples),
    }


def avg_gain_loss(samples: list[float]) -> tuple[float, float, float]:
    g = [x for x in samples if x > 0]
    l = [x for x in samples if x < 0]
    ag = sum(g) / len(g) if g else 0.0
    al = abs(sum(l) / len(l)) if l else 0.0
    b = ag / al if al > 0 else float("nan")
    return ag, al, b


def ci95_total(s: dict) -> tuple[float, float]:
    if s["n"] == 0 or s["sd"] != s["sd"]:
        return (float("nan"), float("nan"))
    half = 1.96 * s["sd"] * math.sqrt(s["n"])
    return (s["total"] - half, s["total"] + half)


def n_for_t2(s: dict) -> float:
    """n tel que |t| = 2 avec le mu et sigma observés (par trade)."""
    if s["n"] == 0 or s["mean"] == 0 or s["sd"] != s["sd"]:
        return float("nan")
    return (2.0 * s["sd"] / s["mean"]) ** 2


def breakeven_wr(b: float) -> float:
    return 1.0 / (1.0 + b) if b == b and b > 0 else float("nan")


# --------------------------------------------------------------------------
# 4. Rapport
# --------------------------------------------------------------------------
def main() -> None:
    refresh = "--refresh" in sys.argv
    emit_json = "--json" in sys.argv

    trades, per_source = load_trades()
    print("=" * 78)
    print("SOURCES DU LEDGER DE TRADES")
    print("=" * 78)
    for path, desc in per_source.items():
        print(f"  {path}\n      -> {desc}")
    print(f"  TOTAL trades YES/NO uniques (par roundId) : {len(trades)}")

    res = resolve_all(trades, refresh)

    # assembler les trades résolus
    rows = []
    status_counts = Counter()
    for rid, tr in trades.items():
        r = res.get(rid, {})
        status_counts[r.get("status", "missing")] += 1
        if r.get("status") != "resolved" or r.get("up") is None:
            continue
        win = (r["up"] and tr["side"] == "YES") or ((not r["up"]) and tr["side"] == "NO")
        pnl = realized_of(tr["price"], win)
        rows.append({**tr, "win": win, "pnl": pnl, "up": r["up"]})

    print()
    print("=" * 78)
    print("RÉSOLUTION (re-résolution indépendante via Gamma events?slug=)")
    print("=" * 78)
    for k, v in sorted(status_counts.items()):
        print(f"  {k:20s} : {v}")
    print(f"  TRADES RÉSOLUS RETENUS : {len(rows)}")

    # validation croisée contre le realized enregistré par le bot (si numérique)
    agree = disagree = checked = 0
    for r in rows:
        br = r.get("bot_realized")
        if isinstance(br, (int, float)) and not isinstance(br, bool) and br != 0:
            checked += 1
            if (br > 0) == r["win"]:
                agree += 1
            else:
                disagree += 1
    print(f"  Validation croisée vs realized enregistré (non nul) : "
          f"{checked} comparables, {agree} concordants, {disagree} discordants")

    if not rows:
        print("\nAUCUN TRADE RÉSOLU — impossible de mesurer l'edge.")
        return

    pnls = [r["pnl"] for r in rows]
    overall = stats(pnls, sum(1 for r in rows if r["win"]))
    ag, al, b = avg_gain_loss(pnls)
    lo, hi = ci95_total(overall)

    # ---------- (a) PAR COIN ----------
    print()
    print("=" * 78)
    print("(a) EDGE PAR COIN  (mise 1€, re-résolution indépendante)")
    print("=" * 78)
    print(f"{'coin':6s} {'n':>4s} {'WR':>7s} {'BE_WR':>7s} {'mean€':>8s} "
          f"{'sd':>7s} {'se':>7s} {'t':>7s} {'total€':>8s}")
    by_coin = {}
    for coin in COINS:
        sub = [r["pnl"] for r in rows if r["coin"] == coin]
        if not sub:
            print(f"{coin:6s} {0:>4d}   (aucun trade)")
            continue
        s = stats(sub, sum(1 for x in sub if x > 0))
        _, _, bb = avg_gain_loss(sub)
        by_coin[coin] = s
        print(f"{coin:6s} {s['n']:>4d} {s['wr']*100:>6.1f}% "
              f"{breakeven_wr(bb)*100:>6.1f}% {s['mean']:>+8.4f} "
              f"{s['sd']:>7.4f} {s['se']:>7.4f} {s['t']:>+7.2f} {s['total']:>+8.4f}")

    # ---------- (b) PAR TRANCHE DE PRIX ----------
    print()
    print("=" * 78)
    print("(b) EDGE PAR TRANCHE DE PRIX D'ENTRÉE")
    print("=" * 78)
    print(f"{'tranche':10s} {'n':>4s} {'WR':>7s} {'BE_WR=1/(1+b)':>14s} "
          f"{'b':>6s} {'mean€':>8s} {'sd':>7s} {'t':>7s} {'total€':>8s} {'IC95 total':>22s}")
    by_bucket = {}
    for name, lo_, hi_ in BUCKETS:
        sub = [r["pnl"] for r in rows if lo_ <= r["price"] < hi_]
        if not sub:
            print(f"{name:10s} {0:>4d}   (aucun trade)")
            continue
        s = stats(sub, sum(1 for x in sub if x > 0))
        agb, alb, bb = avg_gain_loss(sub)
        cl, ch = ci95_total(s)
        by_bucket[name] = s
        print(f"{name:10s} {s['n']:>4d} {s['wr']*100:>6.1f}% "
              f"{breakeven_wr(bb)*100:>13.1f}% {bb:>6.3f} {s['mean']:>+8.4f} "
              f"{s['sd']:>7.4f} {s['t']:>+7.2f} {s['total']:>+8.4f} "
              f"  [{cl:>+7.2f},{ch:>+7.2f}]")

    # ---------- (b2) par coin x tranche (grossier) ----------
    print()
    print("=" * 78)
    print("(b2) n PAR COIN × TRANCHE (détail de la couverture)")
    print("=" * 78)
    hdr = f"{'coin':6s} " + " ".join(f"{n:>10s}" for n, _, _ in BUCKETS)
    print(hdr)
    for coin in COINS:
        cells = []
        for name, lo_, hi_ in BUCKETS:
            c = sum(1 for r in rows if r["coin"] == coin and lo_ <= r["price"] < hi_)
            cells.append(f"{c:>10d}")
        print(f"{coin:6s} " + " ".join(cells))

    # distribution des prix
    print()
    print("Distribution des prix d'entrée (tous coins) :")
    pcs = Counter(round(r["price"], 2) for r in rows)
    for p in sorted(pcs):
        print(f"  {p:.2f} : {pcs[p]}")

    # ---------- (c) PUISSANCE ----------
    print()
    print("=" * 78)
    print("(c) PUISSANCE STATISTIQUE")
    print("=" * 78)
    print(f"  Global : n={overall['n']}  mean={overall['mean']:+.4f}€  "
          f"sd={overall['sd']:.4f}€  se={overall['se']:.4f}€  t={overall['t']:+.3f}")
    print(f"  IC95 du PnL TOTAL observé : [{lo:+.2f}€, {hi:+.2f}€]  "
          f"(total point = {overall['total']:+.2f}€)")
    print(f"  WR break-even global (b={b:.3f}) = {breakeven_wr(b)*100:.1f}%  "
          f"| WR observé = {overall['wr']*100:.1f}%")
    nreq = n_for_t2(overall)
    print(f"  n requis pour |t|>2 aux mu/sigma mesurés : {nreq:.0f} "
          f"(actuel {overall['n']})  -> "
          f"{'ATTEINT' if overall['n'] >= nreq else 'PAS ENCORE ATTEINT'}")
    print()
    print("  Détail par coin (t et n requis) :")
    for coin, s in by_coin.items():
        print(f"    {coin:5s} n={s['n']:>3d} t={s['t']:>+6.2f} "
              f"n_requis={n_for_t2(s):>7.0f}  "
              f"{'SIGNIFICATIF' if abs(s['t']) > 2 else 'non significatif'}")
    print()
    print("  Détail par tranche (t et n requis) :")
    for name, s in by_bucket.items():
        print(f"    {name:10s} n={s['n']:>3d} t={s['t']:>+6.2f} "
              f"n_requis={n_for_t2(s):>7.0f}  "
              f"{'SIGNIFICATIF' if abs(s['t']) > 2 else 'non significatif'}")

    # ---------- (d) RECOMMANDATION ----------
    print()
    print("=" * 78)
    print("(d) RECOMMANDATION (dérivée des mesures ci-dessus)")
    print("=" * 78)
    print(f"{'tranche':10s} {'n':>4s} {'WR':>7s} {'BE=p':>7s} {'edge(pp)':>9s} "
          f"{'t':>7s}  verdict")
    for name, lo_, hi_ in BUCKETS:
        sub = [r for r in rows if lo_ <= r["price"] < hi_]
        if not sub:
            continue
        vals = [r["pnl"] for r in sub]
        s = stats(vals, sum(1 for x in vals if x > 0))
        be = sum(r["price"] for r in sub) / len(sub)
        edge_pp = (s["wr"] - be) * 100
        if abs(s["t"]) > 2 and edge_pp > 0:
            verdict = "PROUVÉ positif"
        elif edge_pp > 3:
            verdict = "indice positif (NON significatif)"
        elif edge_pp < -3:
            verdict = "indice négatif (NON significatif)"
        else:
            verdict = "neutre / break-even"
        print(f"{name:10s} {len(sub):>4d} {s['wr']*100:>6.1f}% {be*100:>6.1f}% "
              f"{edge_pp:>+8.1f}  {s['t']:>+6.2f}  {verdict}")

    print()
    print(f"{'coin':6s} {'n':>4s} {'WR':>7s} {'BE=p':>7s} {'edge(pp)':>9s} {'t':>7s}  verdict")
    for coin in COINS:
        sub = [r for r in rows if r["coin"] == coin]
        if not sub:
            continue
        vals = [r["pnl"] for r in sub]
        s = stats(vals, sum(1 for x in vals if x > 0))
        be = sum(r["price"] for r in sub) / len(sub)
        edge_pp = (s["wr"] - be) * 100
        if abs(s["t"]) > 2 and edge_pp > 0:
            verdict = "PROUVÉ positif (MAIS multiple-comparaisons)"
        elif edge_pp > 3:
            verdict = "indice positif (NON significatif)"
        elif edge_pp < -3:
            verdict = "indice négatif (NON significatif)"
        else:
            verdict = "neutre / break-even"
        print(f"{coin:6s} {len(sub):>4d} {s['wr']*100:>6.1f}% {be*100:>6.1f}% "
              f"{edge_pp:>+8.1f}  {s['t']:>+6.2f}  {verdict}")

    print()
    print("  Fenêtres candidates (hold-to-expiry) :")
    cands = [
        ("[0.58,0.70)", lambda r: 0.58 <= r["price"] < 0.70),
        ("[0.70,0.75)", lambda r: 0.70 <= r["price"] < 0.75),
        ("[0.75,1.01)", lambda r: r["price"] >= 0.75),
        ("[0.60,0.75)", lambda r: 0.60 <= r["price"] < 0.75),
        ("[0.58,1.01) drop[0.65,0.70)", lambda r: not (0.65 <= r["price"] < 0.70)),
    ]
    for nm, sel in cands:
        sub = [r for r in rows if sel(r)]
        if not sub:
            continue
        vals = [r["pnl"] for r in sub]
        s = stats(vals, sum(1 for x in vals if x > 0))
        be = sum(r["price"] for r in sub) / len(sub)
        print(f"    {nm:26s} n={len(sub):>3d} WR={s['wr']*100:>5.1f}% "
              f"BE={be*100:>5.1f}% edge={(s['wr']-be)*100:>+5.1f}pp "
              f"t={s['t']:>+5.2f} total={s['total']:>+7.3f}")

    # ---------- (e) AS-EXECUTED vs HOLD-TO-EXPIRY ----------
    print()
    print("=" * 78)
    print("(e) AS-EXECUTED (realized du bot) vs HOLD-TO-EXPIRY (re-résolu)")
    print("=" * 78)
    exec_vals = []
    for r in rows:
        br = r.get("bot_realized")
        if isinstance(br, (int, float)) and not isinstance(br, bool) and br != 0:
            exec_vals.append(br)
    if exec_vals:
        es = stats(exec_vals, sum(1 for x in exec_vals if x > 0))
        print(f"  as-executed      n={es['n']} mean={es['mean']:+.4f}€ "
              f"total={es['total']:+.3f}€ WR={es['wr']*100:.1f}%")
        print(f"  hold-to-expiry   n={overall['n']} mean={overall['mean']:+.4f}€ "
              f"total={overall['total']:+.3f}€ WR={overall['wr']*100:.1f}%")
        print("  (l'écart vient des sorties anticipées TP/SL : le bot encaisse plus tôt "
              "que l'expiration)")
    else:
        print("  aucun realized numérique exploitable")

    if emit_json:
        dump = {
            "sources": per_source,
            "n_trades_total": len(trades),
            "status_counts": status_counts,
            "n_resolved": len(rows),
            "validation": {"checked": checked, "agree": agree, "disagree": disagree},
            "overall": overall,
            "overall_ci95_total": [lo, hi],
            "breakeven_wr": breakeven_wr(b),
            "b": b,
            "n_for_t2": nreq,
            "by_coin": by_coin,
            "by_bucket": by_bucket,
        }
        out = os.path.join(HERE, "edge_results.json")
        with open(out, "w") as fh:
            json.dump(dump, fh, indent=2)
        print(f"\n[json] -> {out}")


if __name__ == "__main__":
    main()
