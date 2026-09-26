import json, time, sys
sys.path.insert(0, "/root/clawd/Polymarket-bot/docs/rebuild/execution")
import measure_costs as M

hits = []
dur = float(sys.argv[1]) if len(sys.argv) > 1 else 300
end = time.time() + dur
tick = 0
while time.time() < end:
    tick += 1
    for coin in M.COINS:
        for slot in M.slots_now():
            m = M.gamma_market(coin, slot)
            if not m:
                continue
            tok = json.loads(m["clobTokenIds"])
            for name, t in (("yes", tok[0]), ("no", tok[1])):
                bk = M.book(t)
                bid, ask, asks = M.norm_book(bk, "asks")
                if ask is None or not (0.56 <= ask <= 0.67):
                    continue
                d_t, _ = M.depth_usdc(asks, price_cap=ask)
                d2, _ = M.depth_usdc(asks, price_cap=ask + 0.02)
                e5, _, _ = M.exec_price_for_stake(asks, 5)
                e10, _, _ = M.exec_price_for_stake(asks, 10)
                e100, _, miss = M.exec_price_for_stake(asks, 100)
                hits.append({
                    "t": int(time.time()), "coin": coin, "side": name, "slot": slot,
                    "ask": ask, "bid": bid, "spread": round(ask - bid, 4) if bid else None,
                    "depth_top": round(d_t, 2), "depth_2c": round(d2, 2),
                    "vwap5": e5, "vwap10": e10, "vwap100": e100, "miss100": miss,
                    "asks": asks[:5],
                })
    time.sleep(8)

print("ZONE HITS", len(hits))
for h in hits:
    r = lambda v: "n/a" if v is None else f"{v:.4f}"
    print(f"{h['coin'].upper():4} {h['side']:3} ask={h['ask']:.2f} spread={h['spread']} "
          f"dep_top=${h['depth_top']} dep2c=${h['depth_2c']} "
          f"VWAP5={r(h['vwap5'])} VWAP10={r(h['vwap10'])} VWAP100={r(h['vwap100'])} miss100=${h['miss100']:.0f} "
          f"{h['asks']}")
json.dump(hits, open("/root/clawd/Polymarket-bot/docs/rebuild/execution/zone_58_65.json", "w"), indent=1)
