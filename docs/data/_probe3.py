#!/usr/bin/env python3
"""Trouver l'endpoint correct pour verifier l'issue reelle d'un round Up/Down 5m."""
import json, urllib.request, datetime

UA = {'User-Agent': 'paperbot-review/1.0'}


def get(u):
    try:
        return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25))
    except Exception as e:
        return f'ERR {e}'


slot = 1789738800
print("slot utc:", datetime.datetime.utcfromtimestamp(slot).isoformat())
for pat in [
    f'events?slug=btc-updown-5m-{slot}',
    f'events?slug=bitcoin-up-or-down-september-18-940am',
    f'markets?slug=bitcoin-up-or-down-september-18-940am',
    f'markets?slug=btc-up-or-down-5m-{slot}',
    f'markets?slug={slot}',
]:
    r = get('https://gamma-api.polymarket.com/' + pat)
    if isinstance(r, str):
        print(pat, '->', r[:120]); continue
    print(pat, '-> n=', len(r))
    if r:
        x = r[0]
        print('   slug=', x.get('slug'), '| outcomes=', x.get('outcomes'), '| prices=', x.get('outcomePrices'),
              '| closed=', x.get('closed'), '| cid=', (x.get('conditionId') or '')[:20])
        if 'markets' in x:
            for m in x['markets'][:3]:
                print('   sub:', m.get('slug'), m.get('outcomes'), m.get('outcomePrices'), (m.get('conditionId') or '')[:20])
