#!/usr/bin/env python3
"""Probe gamma-api: le filtre condition_id de paperbot-pnl.py est-il reellement applique ?"""
import json, urllib.request

UA = {'User-Agent': 'paperbot-review/1.0'}


def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25))


cids = [
    '0xce113b8a6447e8e9ddfbc9f1f1147720dfd0c7f059bc24e0187d8af9ec6c745a',
    '0x10734be37eb7b93840ece0cb6ccb241e5cf160a0668f34954149c4af4e361321',
    '0x85cc7dbddb0fd36f8f3a2c73dd494bc93ce83966094c86dbff9b0581e1309185',
]

for cid in cids:
    for ep in [f'?condition_id={cid}', f'?condition_ids={cid}']:
        try:
            r = get('https://gamma-api.polymarket.com/markets' + ep)
            n = len(r)
            ids = [x.get('conditionId') for x in r]
            hit = cid in ids
            print(f"{ep[:24]}... n={n} contains_target={hit} first_slug={r[0].get('slug') if r else None}")
            if hit:
                x = r[ids.index(cid)]
                print("   TARGET:", x.get('slug'), x.get('outcomes'), x.get('outcomePrices'), 'closed=', x.get('closed'))
        except Exception as e:
            print(ep, 'FAILED', e)

# endpoint direct single market
try:
    r = get('https://gamma-api.polymarket.com/markets/' + cids[0])
    print("single:", r.get('slug'), r.get('outcomePrices'), r.get('conditionId'))
except Exception as e:
    print('single FAILED', e)
