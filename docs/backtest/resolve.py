#!/usr/bin/env python3
"""resolve.py — résolution de l'issue réelle des rounds Up/Down 5m via l'API Gamma.

CHEMIN VÉRIFIÉ (et unique utilisé ici) :
    GET https://gamma-api.polymarket.com/events?slug=<coin>-updown-5m-<slot>&limit=5
    -> [{'slug': ..., 'closed': bool, 'markets': [{'outcomePrices': '["1","0"]',
                                                   'conditionId': '0x...'}]}]

CHEMIN BUGGÉ, INTERDIT (filtre ignoré, renvoie toujours la même page de 20 marchés) :
    GET https://gamma-api.polymarket.com/markets?condition_id=<cid>   -> data[0]
    (data[0] était `xi-jinping-out-before-2027` : tout YES enregistré perdant.)
    Le même défaut existe pour `slug__in=` : le filtre est ignoré (vérifié par probe_api.py).

Garde-fou appliqué à CHAQUE réponse : le slug renvoyé doit être EXACTEMENT celui demandé.
Une réponse non filtrée est rejetée, jamais interprétée.

Batching : le paramètre `slug` peut être répété (?slug=a&slug=b&...) et renvoie bien
N événements (vérifié). On l'utilise pour réduire le nombre d'appels HTTP, avec
re-validation individuelle de chaque slug retourné.

Sortie : cache JSON { slug: {closed, up_price, down_price, condition_id, resolved} }.

Usage :
    python3 resolve.py <fichier_slugs.txt> <cache.json> [--batch 20] [--workers 4]
"""
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = {'User-Agent': 'paperbot-edge-validation/1.0'}
BASE = 'https://gamma-api.polymarket.com/events'
LOCK = threading.Lock()


def fetch(url, timeout=30, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as e:          # réseau instable -> backoff
            last = e
            time.sleep(0.8 * (i + 1))
    raise last if last is not None else RuntimeError('fetch failed')


def parse_event(ev, want_slug):
    """-> dict ou None si la réponse ne concerne pas le slug demandé."""
    if not isinstance(ev, dict) or (ev.get('slug') or '') != want_slug:
        return None                      # réponse non filtrée -> rejet
    ms = ev.get('markets') or []
    if not ms:
        return None
    m = ms[0]
    slot = want_slug.split('-updown-5m-')[-1]
    if slot not in (m.get('slug') or want_slug):
        return None                      # le marché ne correspond pas au round demandé
    out = {'closed': bool(m.get('closed')),
           'condition_id': m.get('conditionId'),
           'up_price': None, 'down_price': None, 'resolved': False}
    p = m.get('outcomePrices')
    if p:
        try:
            arr = [float(x) for x in (json.loads(p) if isinstance(p, str) else p)]
            if len(arr) >= 2:
                out['up_price'], out['down_price'] = arr[0], arr[1]
        except Exception:
            pass
    if out['closed'] and out['up_price'] is not None:
        if out['up_price'] > 0.9:
            out['resolved'], out['yes_won'] = True, True
        elif out['down_price'] > 0.9:
            out['resolved'], out['yes_won'] = True, False
    return out


def resolve_batch(slugs, batch=20):
    """Résout un lot de slugs. -> {slug: dict}. Les slugs absents sont marqués unresolved."""
    url = BASE + '?limit=%d&' % (len(slugs) * 2) + '&'.join(
        'slug=' + urllib.parse.quote(s) for s in slugs)
    found = {}
    try:
        data = fetch(url)
    except Exception as e:
        data = []
        print('  ! lot en échec (%d slugs): %s' % (len(slugs), e), file=sys.stderr)
    for ev in (data or []):
        s = (ev or {}).get('slug')
        if s in slugs and s not in found:
            p = parse_event(ev, s)
            if p:
                found[s] = p
    for s in slugs:
        found.setdefault(s, {'closed': False, 'condition_id': None, 'up_price': None,
                             'down_price': None, 'resolved': False})
    return found


def main():
    slugs_file, cache_file = sys.argv[1], sys.argv[2]
    batch = int(sys.argv[sys.argv.index('--batch') + 1]) if '--batch' in sys.argv else 20
    workers = int(sys.argv[sys.argv.index('--workers') + 1]) if '--workers' in sys.argv else 4

    slugs = [l.strip() for l in open(slugs_file) if l.strip()]
    slugs = sorted(set(slugs))
    cache = {}
    if os.path.exists(cache_file):
        try:
            cache = json.load(open(cache_file))
        except Exception:
            cache = {}
    todo = [s for s in slugs if s not in cache or not cache[s].get('resolved')]
    print('slugs demandés: %d | déjà en cache: %d | à résoudre: %d'
          % (len(slugs), len(slugs) - len(todo), len(todo)))

    chunks = [todo[i:i + batch] for i in range(0, len(todo), batch)]
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for res in ex.map(lambda c: resolve_batch(c, batch), chunks):
            with LOCK:
                cache.update(res)
                done += 1
                if done % 10 == 0:
                    print('  lots traités: %d/%d' % (done, len(chunks)))
                    json.dump(cache, open(cache_file, 'w'))
    json.dump(cache, open(cache_file, 'w'), indent=0)

    n_res = sum(1 for s in slugs if cache.get(s, {}).get('resolved'))
    n_closed = sum(1 for s in slugs if cache.get(s, {}).get('closed'))
    print('résolus: %d/%d (closed=%d, non résolus=%d) -> %s'
          % (n_res, len(slugs), n_closed, len(slugs) - n_res, cache_file))
    n_up = sum(1 for s in slugs if cache.get(s, {}).get('yes_won'))
    if n_res:
        print('UP gagnants: %d (%.1f%%)' % (n_up, 100.0 * n_up / n_res))


if __name__ == '__main__':
    main()
