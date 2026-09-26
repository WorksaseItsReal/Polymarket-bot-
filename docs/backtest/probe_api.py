#!/usr/bin/env python3
"""Probe: le endpoint gamma accepte-t-il plusieurs slugs en une requête ?

Objectif : réduire le nombre d'appels HTTP lors de la résolution des issues.
Chemin VÉRIFIÉ pour un slug unique :
    GET https://gamma-api.polymarket.com/events?slug=<coin>-updown-5m-<slot>
    -> [{'slug':..., 'closed':true, 'markets':[{'outcomePrices':'["1","0"]', ...}]}]

Chemin BUGGÉ à ne jamais utiliser (filtre ignoré, renvoie toujours la même page) :
    GET https://gamma-api.polymarket.com/markets?condition_id=<cid>

Sortie : JSON {mode: n_réponses, slugs_retournés}.
"""
import json
import sys
import urllib.request

UA = {'User-Agent': 'paperbot-edge-validation/1.0'}
BASE = 'https://gamma-api.polymarket.com/events'


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def main():
    slugs = sys.argv[1:5] or [
        'btc-updown-5m-1789243800',
        'eth-updown-5m-1789243800',
        'sol-updown-5m-1789243800',
    ]
    out = {}

    # 1) slug répété
    url = BASE + '?limit=10&' + '&'.join('slug=' + s for s in slugs)
    try:
        r = fetch(url)
        out['slug_repeté'] = {'n': len(r), 'slugs': [e.get('slug') for e in r], 'url': url}
    except Exception as e:
        out['slug_repeté'] = {'error': str(e)}

    # 2) slug__in
    url = BASE + '?limit=10&slug__in=' + ','.join(slugs)
    try:
        r = fetch(url)
        out['slug__in'] = {'n': len(r), 'slugs': [e.get('slug') for e in r], 'url': url}
    except Exception as e:
        out['slug__in'] = {'error': str(e)}

    # 3) slug unique (référence)
    url = BASE + '?slug=' + slugs[0] + '&limit=5'
    r = fetch(url)
    out['slug_unique'] = {'n': len(r), 'slugs': [e.get('slug') for e in r], 'url': url}

    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
