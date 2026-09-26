import json, time, sys
sys.path.insert(0, "/root/clawd/Polymarket-bot/docs/rebuild/execution")
import measure_costs as M

hits = []
dur = float(sys.argv[1]) if len(sys.argv) > 1 else 170
end = time.time() + dur
while time.time() < end:
    for coin in M.COINS:
        for slot in M.slots_now():
            m = M.gamma_market(coin, slot)
            if not m:
                continue
            tok = m.get("clobTokenIds")
            if isinstance(tok, str):
                try:
                    tok = json.loads(tok)
                except Exception:
                    tok = None
            if not tok or len(tok) < 2:
                continue
            for name, t in (("yes", tok[0]), ("no", tok[1])):
                bk = M.book(t)
                bid, ask, asks = M.norm_book(bk, "asks")
                if ask is None:
                    continue
                if 0.50 <= ask <= 0.75:
                    d_t, _ = M.depth_usdc(asks, price_cap=ask)
                    d2, _ = M.depth_usdc(asks, price_cap=ask + 0.02)
                    e5, _, _ = M.exec_price_for_stake(asks, 5)
                    e10, _, _ = M.exec_price_for_stake(asks, 10)
                    e100, _, miss = M.exec_price_for_stake(asks, 100)
                    hits.append((round(time.time()), coin, name, slot, round(bid, 4), round(ask, 4),
                                 round(d_t, 2), round(d2, 2),
                                 round(e5 or 0, 4), round(e10 or 0, 4), round(e100 or 0, 4), round(miss, 1),
                                 str(asks[:4])))
    time.sleep(12)

print("HITS", len(hits))
for h in hits:
    print(h)
json.dump(hits, open("/root/clawd/Polymarket-bot/docs/rebuild/execution/zone_hits.json", "w"))
