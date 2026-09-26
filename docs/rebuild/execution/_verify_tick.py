import json, time, sys
sys.path.insert(0, "/root/clawd/Polymarket-bot/docs/rebuild/execution")
import measure_costs as M

now = int(time.time())
slot = now // 300 * 300
# also next slot
for sl in (slot, slot + 300):
    for coin in ("btc", "eth", "sol", "xrp", "doge"):
        m = M.gamma_market(coin, sl)
        if not m:
            continue
        tok = json.loads(m["clobTokenIds"])
        yb = M.book(tok[0])
        nb = M.book(tok[1])
        def info(bk):
            if not bk: return "no-book"
            asks = sorted([(float(x["price"]), float(x["size"])) for x in bk["asks"]])
            bids = sorted([(float(x["price"]), float(x["size"])) for x in bk["bids"]], reverse=True)
            return (f"tick={bk.get('tick_size')} min={bk.get('min_order_size')} "
                    f"bestBid={bids[0] if bids else None} bestAsk={asks[0] if asks else None}")
        print(f"{coin.upper():4} {m['slug']:28} gammaTick={m.get('orderPriceMinTickSize')} "
              f"gammaMin={m.get('orderMinSize')} fee={m.get('feeType')}")
        print(f"     YES {info(yb)}")
        print(f"     NO  {info(nb)}")
