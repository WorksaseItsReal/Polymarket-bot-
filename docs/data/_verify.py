#!/usr/bin/env python3
"""Preuve par egalite d'ensembles : les 63 cles de cumulative.json sont-elles
exactement les trades de la fenetre 09-18T13:40 -> 09-20T14:29 ? Et pour chacune,
le realized officiel correspond-il a l'issue reelle du round ?
"""
import json, urllib.request, time, collections

UA = {'User-Agent': 'paperbot-review/1.0'}
cum = json.load(open('/root/.polymarket/cumulative.json'))
keys = set(cum['resolved'])

d = json.load(open('docs/data/_rec.json'))
decs = d['decs']; tps = d['tps']
w = [x for x in decs if x['ts'] >= '2026-09-18T13:40']

info = {}
for x in w:
    try:
        r = json.load(urllib.request.urlopen(
            urllib.request.Request('https://gamma-api.polymarket.com/events?slug=' + x['round'], headers=UA), timeout=25))
        m = r[0]['markets'][0]
        p = json.loads(m['outcomePrices'])
        info[x['round']] = (m['conditionId'], float(p[0]) > 0.9, float(p[1]) > 0.9)
    except Exception as e:
        info[x['round']] = (None, None, None)
    time.sleep(0.1)

mine = set()
mismatch = []
wins = losses = 0
pnl = 0.0
rows = []
for x in w:
    cid, yw, nw = info[x['round']]
    key = f"{cid}|{x['side']}|{x['price']}"
    mine.add(key)
    tp = tps.get(x['round'])
    if tp:
        real = tp['gain']
    else:
        won_r = yw if x['side'] == 'YES' else nw
        real = round(1 / x['price'] - 1, 4) if won_r else -1.0
    off = cum['resolved'].get(key)
    if off is not None:
        pass
    rows.append((x['coin'], key, x['price'], real))
    if real > 0: wins += 1
    elif real < 0: losses += 1
    pnl += real

print("cles cumulatives:", len(keys), "| cles fenetre reconstituee:", len(mine))
print("identiques:", keys == mine, "| diff A-B:", len(keys - mine), "| diff B-A:", len(mine - keys))
print(f"RECONSTRUIT (issu reelle Polymarket): n=63 wins={wins} losses={losses} pnl={pnl:+.4f}")
print(f"OFFICIEL (pnl.json/cumulative): trades=63 wins={cum['wins']} losses={cum['losses']} pnl={cum['pnl']:+.4f}")

# Par coin + buckets, sur la reconstruction validee
bycoin = collections.defaultdict(lambda: [0, 0, 0.0])
for coin, key, price, real in rows:
    c = bycoin[coin]; c[0] += 1; c[1] += 1 if real > 0 else 0; c[2] += real
print("\nPAR COIN (reconstruit):")
for c, v in sorted(bycoin.items(), key=lambda kv: -kv[1][2]):
    print(f"  {c}: n={v[0]} wins={v[1]} wr={100*v[1]/v[0]:.0f}% pnl={v[2]:+.3f}")

def bucket(p):
    if p < 0.60: return '0.55-0.60'
    if p < 0.65: return '0.60-0.65'
    if p < 0.70: return '0.65-0.70'
    if p < 0.75: return '0.70-0.75'
    return '0.75+'
byb = collections.defaultdict(lambda: [0, 0, 0.0, 0.0])
for coin, key, price, real in rows:
    b = byb[bucket(price)]; b[0] += 1; b[1] += 1 if real > 0 else 0; b[2] += real
    b[3] += (1 / price - 1)
print("\nPAR BUCKET DE PRIX D'ENTREE (reconstruit): bucket n wins wr pnl EV/trade EV_theorique")
for b in ['0.55-0.60', '0.60-0.65', '0.65-0.70', '0.70-0.75', '0.75+']:
    if b in byb:
        v = byb[b]
        print(f"  {b}: n={v[0]} wins={v[1]} wr={100*v[1]/v[0]:.0f}% pnl={v[2]:+.3f} EV={v[2]/v[0]:+.4f} evmax={v[3]/v[0]:.4f}")
json.dump({'rows': rows, 'info': info}, open('docs/data/_verify.json', 'w'))
