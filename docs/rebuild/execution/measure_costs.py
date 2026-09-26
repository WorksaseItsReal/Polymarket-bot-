#!/usr/bin/env python3
"""
measure_costs.py — Mesure LECTURE SEULE du réalisme d'exécution des marchés
Polymarket « Up/Down 5m » (BTC/ETH/SOL/XRP/DOGE).

Aucun ordre, aucune clé, aucune transaction. Uniquement des GET publics.

Sources:
  - Gamma   https://gamma-api.polymarket.com/markets?slug=...
  - CLOB    https://clob.polymarket.com/book?token_id=...   (asks renvoyés du +cher au -cher -> on trie)

Ce que le script mesure, pour chaque coin / chaque round:
  (a) spread réel, profondeur exécutable au meilleur ask, tick, taille min
  (b) prix bot (orderbook.yes.ask / no.ask) vs prix réellement exécutable pour 1€/10€/100€
  (c) coût d'entrée total (% de la mise) = frais taker + demi-spread, et WR break-even

Formule de frais officielle (takers uniquement):
      fee = C × feeRate × p × (1 − p)
  => en % de la mise S (C = S/p):  fee% = feeRate × (1 − p)
  Taux crypto = 0.07.

Usage:
  python3 measure_costs.py snapshot                 # 1 passe
  python3 measure_costs.py watch --minutes 15 --interval 20
  python3 measure_costs.py report                   # agrège le JSONL
"""
import argparse, json, sys, time, urllib.request, urllib.error, statistics, os
from datetime import datetime, timezone

GAMMA = "https://gamma-api.polymarket.com/markets"
CLOB  = "https://clob.polymarket.com/book"
COINS = ["btc", "eth", "sol", "xrp", "doge"]
CRYPTO_FEE_RATE = 0.07           # taker, catégorie crypto (docs.polymarket.com/trading/fees)
OUTDIR = os.path.dirname(os.path.abspath(__file__))
JSONL  = os.path.join(OUTDIR, "snapshots.jsonl")

# Tranche où le bot mise réellement (P_STRONG_MIN..P_STRONG_MAX dans bot-with-dashboard.ts)
BOT_MIN, BOT_MAX = 0.58, 0.65


def http_json(url, tries=3):
    last = Exception("no attempt")
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "measure_costs/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception as e:               # noqa
            last = e
            time.sleep(1.0)
    raise last


def slots_now():
    now = int(time.time())
    cur = now // 300 * 300
    return [cur, cur + 300]              # round courant + round suivant


def gamma_market(coin, slot):
    try:
        d = http_json(f"{GAMMA}?slug={coin}-updown-5m-{slot}")
        return d[0] if d else None
    except Exception:
        return None


def book(token_id):
    try:
        return http_json(f"{CLOB}?token_id={token_id}")
    except Exception:
        return None


def norm_book(bk, side):
    """Renvoie (best_bid, best_ask, levels) où levels = liste triée par prix croissant.
    side='asks' -> prix croissant (le moins cher d'abord, exécutable en premier).
    side='bids' -> prix décroissant (le plus cher d'abord)."""
    if not bk:
        return None, None, []
    rows = [(float(x["price"]), float(x["size"])) for x in bk.get(side, [])]
    rows.sort(key=lambda r: r[0])                      # croissant
    if side == "asks":
        levels = rows
        best_ask = rows[0][0] if rows else None
        best_bid = max((float(x["price"]) for x in bk.get("bids", [])), default=None)
    else:
        levels = list(reversed(rows))
        best_bid = levels[0][0] if levels else None
        best_ask = min((float(x["price"]) for x in bk.get("asks", [])), default=None)
    return best_bid, best_ask, levels


def depth_usdc(levels, price_cap=None, max_usdc=None):
    """Profondeur cumulée (USDC notionnel) disponible dans les `levels` (asks croissants),
    jusqu'à `price_cap` (inclus) et/ou jusqu'à `max_usdc` dépensés."""
    spent, shares = 0.0, 0.0
    for price, size in levels:
        if price_cap is not None and price > price_cap + 1e-12:
            break
        for_this = price * size
        if max_usdc is not None and spent + for_this > max_usdc:
            need = max_usdc - spent
            shares += need / price
            spent = max_usdc
            break
        spent += for_this
        shares += size
        if max_usdc is not None and spent >= max_usdc - 1e-9:
            break
    return spent, shares


def exec_price_for_stake(levels, stake_usdc):
    """Prix moyen d'exécution (VWAP) pour dépenser `stake_usdc` en traversant les asks.
    Renvoie (vwap, rempli_usdc, manque_usdc)."""
    remaining, spent, shares = stake_usdc, 0.0, 0.0
    for price, size in levels:
        avail = price * size
        take = min(avail, remaining)
        shares += take / price
        spent += take
        remaining -= take
        if remaining <= 1e-9:
            break
    if shares <= 0:
        return None, 0.0, stake_usdc
    return spent / shares, spent, remaining


def fee_pct_of_stake(price):
    """frais taker en % de la mise, formule officielle: feeRate*(1-p)."""
    return CRYPTO_FEE_RATE * (1.0 - price) * 100.0


def snapshot_once(tag=""):
    ts = time.time()
    out = {"ts": ts, "iso": datetime.now(timezone.utc).isoformat(), "tag": tag, "coins": {}}
    for coin in COINS:
        for slot in slots_now():
            m = gamma_market(coin, slot)
            if not m:
                continue
            tok = m.get("clobTokenIds")
            if isinstance(tok, str):
                try: tok = json.loads(tok)
                except Exception: tok = None
            if not tok or len(tok) < 2:
                continue
            yes_tok, no_tok = tok[0], tok[1]
            ybk, nbk = book(yes_tok), book(no_tok)
            rec = {
                "slug": m.get("slug"), "slot": slot, "question": m.get("question"),
                "endDate": m.get("endDate"),
                "gamma_bestBid": m.get("bestBid"), "gamma_bestAsk": m.get("bestAsk"),
                "gamma_tick": m.get("orderPriceMinTickSize"), "gamma_min": m.get("orderMinSize"),
                "feeType": m.get("feeType"), "feesEnabled": m.get("feesEnabled"),
                "liquidity": m.get("liquidity"),
                "book_tick": (ybk or {}).get("tick_size"), "book_min": (ybk or {}).get("min_order_size"),
                "yes": {}, "no": {},
            }
            for name, bk_self, bk_other in (("yes", ybk, nbk), ("no", nbk, ybk)):
                bid, ask, asks_lv = norm_book(bk_self, "asks")
                _, _, bids_lv = norm_book(bk_self, "bids")
                depth_top = depth_usdc(asks_lv, price_cap=ask)[0] if ask is not None else None
                depth_reasonable = depth_usdc(asks_lv, price_cap=(ask + 0.02) if ask is not None else None)[0] if ask is not None else None
                ex = {}
                for s in (1.0, 5.0, 10.0, 100.0):
                    vwap, filled, missing = exec_price_for_stake(asks_lv, s) if asks_lv else (None, 0, s)
                    ex[str(int(s))] = {"vwap": vwap, "filled": round(filled, 4), "missing": round(missing, 4)}
                # contre-côté (pour spread croisé token yes/no)
                obid, oask, _ = norm_book(bk_other, "asks")
                rec[name] = {
                    "best_bid": bid, "best_ask": ask,
                    "spread": (ask - bid) if (ask is not None and bid is not None) else None,
                    "mid": ((ask + bid) / 2) if (ask is not None and bid is not None) else None,
                    "depth_usdc_at_best_ask": depth_top,
                    "depth_usdc_within_2c": depth_reasonable,
                    "n_ask_levels": len(asks_lv),
                    "n_bid_levels": len(bids_lv),
                    "top5_asks": asks_lv[:5],
                    "exec": ex,
                    "other_token_best_ask": oask,
                    "other_token_best_bid": obid,
                }
            out["coins"].setdefault(coin, []).append(rec)
    return out


def zone_records(rec):
    """Le bot mise si un côté a un ask dans [0.58,0.65]."""
    for name in ("yes", "no"):
        a = rec[name].get("best_ask")
        if a is not None and BOT_MIN <= a <= BOT_MAX:
            return name, a
    return None, None


def zone_rec(rec):
    """Le bot mise si un côté a un ask dans [0.58,0.65]."""
    for name in ("yes", "no"):
        a = rec[name].get("best_ask")
        if a is not None and BOT_MIN <= a <= BOT_MAX:
            return name, a
    return None, None


def summarize(records):
    print(f"\n{'='*78}\nSNAPSHOTS: {len(records)}\n{'='*78}")
    # spread global
    spreads, depths_top, depths_2c = [], [], []
    per_coin = {}
    zone = []            # (coin, side, ask, spread, depth_top, exec1, exec10, exec100)
    for out in records:
        for coin, recs in out["coins"].items():
            for rec in recs:
                d = per_coin.setdefault(coin, {"spreads": [], "depth_top": [], "n": 0})
                for name in ("yes", "no"):
                    r = rec[name]
                    if r["spread"] is not None and r["best_ask"]:
                        d["spreads"].append(r["spread"])
                        spreads.append(r["spread"])
                        if r["depth_usdc_at_best_ask"] is not None:
                            depths_top.append(r["depth_usdc_at_best_ask"])
                            d["depth_top"].append(r["depth_usdc_at_best_ask"])
                        if r["depth_usdc_within_2c"] is not None:
                            depths_2c.append(r["depth_usdc_within_2c"])
                d["n"] += 1
                side, ask = zone_rec(rec)
                if side:
                    r = rec[side]
                    zone.append({
                        "coin": coin, "side": side, "ask": ask, "spread": r["spread"],
                        "depth_top": r["depth_usdc_at_best_ask"],
                        "e1": r["exec"]["1"]["vwap"], "e5": r["exec"]["5"]["vwap"],
                        "e10": r["exec"]["10"]["vwap"], "e100": r["exec"]["100"]["vwap"],
                        "miss100": r["exec"]["100"]["missing"],
                        "tick": rec.get("book_tick"), "min": rec.get("book_min"),
                    })

    def pct(v, p):
        if not v: return None
        v = sorted(v); k = (len(v) - 1) * p / 100
        f = int(k); c = min(f + 1, len(v) - 1)
        return v[f] + (v[c] - v[f]) * (k - f)

    print("\n--- SPREAD RÉEL (tous côtés, tous marchés échantillonnés) ---")
    print(f"n={len(spreads)}  min={min(spreads):.4f}  "
          f"p10={pct(spreads,10):.4f}  p50={pct(spreads,50):.4f}  "
          f"p90={pct(spreads,90):.4f}  max={max(spreads):.4f}")
    print("\n--- PROFONDEUR USDC AU MEILLEUR ASK ---")
    print(f"n={len(depths_top)}  p10={pct(depths_top,10):.2f}  p50={pct(depths_top,50):.2f}  "
          f"p90={pct(depths_top,90):.2f}  max={max(depths_top):.2f}")
    print(f"(profondeur cumulée à <= best_ask+0.02)  p10={pct(depths_2c,10):.2f}  "
          f"p50={pct(depths_2c,50):.2f}  p90={pct(depths_2c,90):.2f}")
    print("\n--- PAR COIN ---")
    for coin, d in per_coin.items():
        if d["spreads"]:
            print(f"{coin.upper():5} n={d['n']:3}  spread p50={pct(d['spreads'],50):.4f}  "
                  f"depth_top p50={pct(d['depth_top'],50):.2f}  depth_top p10={pct(d['depth_top'],10):.2f}")

    print(f"\n--- DECISION ZONE [0.58, 0.65] : {len(zone)} observations ---")
    for z in zone[:40]:
        print(f"  {z['coin'].upper():4} {z['side']:3} ask={z['ask']:.3f} spread={z['spread']:.4f} "
              f"depth_top=${z['depth_top']:.1f}  vwap1={_f(z['e1'])} vwap5={_f(z['e5'])} "
              f"vwap10={_f(z['e10'])} vwap100={_f(z['e100'])} miss100=${z['miss100']:.0f}")
    return zone, per_coin, spreads, depths_top


def _f(v):
    return "n/a" if v is None else f"{v:.4f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["snapshot", "watch", "report"])
    ap.add_argument("--minutes", type=float, default=15)
    ap.add_argument("--interval", type=float, default=20)
    a = ap.parse_args()

    if a.cmd == "report":          # rien à faire ici: les rapports sont écrits par snapshot/watch
        print("Le rapport est écrit dans COSTS.md / snapshots.jsonl")
        return

    records = []
    if a.cmd == "snapshot":
        records.append(snapshot_once(tag="snapshot"))
    else:
        end = time.time() + a.minutes * 60
        i = 0
        while time.time() < end:
            i += 1
            try:
                records.append(snapshot_once(tag=f"watch{i}"))
            except Exception as e:
                print("err:", e)
            time.sleep(a.interval)

    with open(JSONL, "a") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")

    zone, per_coin, spreads, depths = summarize(records)
    print(f"\nJSONL appendé: {JSONL}  (+{len(records)} snapshots)")


if __name__ == "__main__":
    main()
