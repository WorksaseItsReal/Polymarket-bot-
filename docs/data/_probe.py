#!/usr/bin/env python3
"""Reconstruction des trades resolus du paper bot depuis paperbot.log + archive 09-18 + Gamma.
Lecture seule sur les donnees ; ecrit uniquement dans docs/data/.
"""
import json, urllib.request, collections

UA = {'User-Agent': 'paperbot-review/1.0'}


def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=20))


a = json.load(open('/root/.polymarket/archive/2026-09-18/history.json'))
bymap = {e['roundId']: e for e in a if e.get('side') not in (None, 'HOLD')}
print("archive trades:", len(bymap))

d = json.load(open('docs/data/_rec.json'))
dec = d['decs']
w = [x for x in dec if x['ts'] >= '2026-09-18T13:40']
print("window trades (>=09-18T13:40):", len(w))
ov = [x for x in w if x['round'] in bymap]
miss = [x for x in w if x['round'] not in bymap]
print("present in archive snapshot:", len(ov), "| not in archive:", len(miss))

res = [bymap[x['round']] for x in ov]
have = [e for e in res if isinstance(e.get('realized'), (int, float)) and e['realized'] != 0]
print("archive overlap with realized!=0:", len(have),
      "| still unresolved at snapshot:", len(res) - len(have))

k = w[0]['round']
print("sample round:", k, "->", json.dumps(bymap.get(k), ensure_ascii=False)[:300])

cid = bymap.get(k, {}).get('conditionId')
print("sample conditionId:", cid)
try:
    r = get(f'https://gamma-api.polymarket.com/markets?condition_id={cid}')
    print("gamma by condition_id: n=", len(r),
          "| outcomePrices=", (r[0].get('outcomePrices') if r else None),
          "| slug=", (r[0].get('slug') if r else None))
except Exception as e:
    print("gamma by condition_id FAILED:", e)
