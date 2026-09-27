#!/usr/bin/env python3
"""Tableau comparatif Gamma (bestBid/bestAsk/outcomePrices) vs carnet CLOB réel,
au même instant, sur les marchés up/down 5m des 5 coins du bot.
Sortie : markdown + JSON brut."""
import json, subprocess, time, datetime

def curl(u):
    o = subprocess.run(["curl", "-s", "--max-time", "15", u], capture_output=True, text=True).stdout
    try:
        return json.loads(o)
    except Exception:
        return None

def book(tid):
    b = curl(f"https://clob.polymarket.com/book?token_id={tid}")
    if not b or b.get('error'):
        return None
    bids = sorted((float(x['price']) for x in b.get('bids', [])), reverse=True)
    asks = sorted((float(x['price']) for x in b.get('asks', [])))
    return {
        'bid': bids[0] if bids else None,
        'ask': asks[0] if asks else None,
        'nb': len(bids), 'na': len(asks),
        'ts': b.get('timestamp'),
    }

now = int(time.time())
slot = now // 300 * 300
coins = ['btc', 'eth', 'sol', 'xrp', 'doge']
rows = []
for off, label in ((-300, 'round précédent'), (0, 'round en cours'), (300, 'round suivant')):
    for c in coins:
        slug = f"{c}-updown-5m-{slot + off}"
        t_g = time.time()
        d = curl(f"https://gamma-api.polymarket.com/markets?slug={slug}&limit=1")
        lag_g = (time.time() - t_g) * 1000
        if not d:
            continue
        m = d[0]
        toks = json.loads(m.get('clobTokenIds') or '[]')
        op = json.loads(m.get('outcomePrices') or '[]')
        t_c = time.time()
        b0 = book(toks[0]) if toks else None
        b1 = book(toks[1]) if len(toks) > 1 else None
        lag_c = (time.time() - t_c) * 1000
        mid = None
        if b0 and b0['bid'] is not None and b0['ask'] is not None:
            mid = round((b0['bid'] + b0['ask']) / 2, 4)
        rows.append({
            'phase': label, 'slug': slug, 'active': m.get('active'), 'closed': m.get('closed'),
            'g_p0': op[0] if len(op) > 0 else None, 'g_p1': op[1] if len(op) > 1 else None,
            'g_bid': m.get('bestBid'), 'g_ask': m.get('bestAsk'), 'g_last': m.get('lastTradePrice'),
            'c0': b0, 'c1': b1, 'c_mid': mid,
            'lag_gamma_ms': round(lag_g, 1), 'lag_clob_ms': round(lag_c, 1),
        })

out = {'now': now, 'slot': slot,
       'utc': datetime.datetime.utcfromtimestamp(now).isoformat() + 'Z', 'rows': rows}
open('/root/.hermes/cache/scratch/cmp_final.json', 'w').write(json.dumps(out, indent=1))
print(json.dumps(out['utc']), 'rows=', len(rows))
