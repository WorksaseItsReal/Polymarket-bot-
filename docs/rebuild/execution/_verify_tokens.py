import json, time, sys, urllib.request
sys.path.insert(0, "/root/clawd/Polymarket-bot/docs/rebuild/execution")
import measure_costs as M

coin = sys.argv[1] if len(sys.argv) > 1 else "doge"
now = int(time.time())
for slot in (now // 300 * 300 - 300, now // 300 * 300):
    m = M.gamma_market(coin, slot)
    if not m:
        print("no market", coin, slot); continue
    tok = json.loads(m["clobTokenIds"])
    print("Q:", m["question"], "| slug", m["slug"])
    print("yesTok", tok[0])
    print("noTok ", tok[1])
    print("unique tokens:", len(set(tok)))
    for nm, t in (("yes", tok[0]), ("no", tok[1])):
        b = M.book(t)
        bid, ask, asks = M.norm_book(b, "asks")
        _, _, bids = M.norm_book(b, "bids")
        print(f"  {nm}: bestBid={bid} bestAsk={ask} top_asks={asks[:4]} top_bids={bids[:3]}")
    print()
