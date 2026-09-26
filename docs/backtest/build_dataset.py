#!/usr/bin/env python3
"""build_dataset.py — construit les jeux de données du backtest depuis les snapshots.

DEUX JEUX DE DONNÉES, volontairement séparés (ils ne répondent pas à la même question) :

  A) data/executed.csv — les trades que le bot a RÉELLEMENT comptabilisés.
     Union de :
       * docs/data/recon_trades.csv (63 trades 2026-09-18T13:41 → 2026-09-20T10:14,
         reconstruits depuis l'ancien log de 622 Mo par l'analyse précédente) ;
       * snapshot de ~/.polymarket/history.json (trades 2026-09-25/26).
     Contrôle : l'union doit couvrir EXACTEMENT les clés
     `conditionId|SIDE|price` de cumulative.json (sinon on le dit).

  B) data/decisions.csv — toutes les DÉCISIONS du log (`Décision YES|NO @`).
     Beaucoup plus large (1388 décisions, 2026-09-12 → 2026-09-20), mais mesure une
     autre chose : « si on avait pris ce côté à ce prix, qu'est-ce que ça donnait ? »,
     sans filtre, sans sizing, sans budget. C'est le seul jeu assez gros pour un
     walk-forward ; il est donc utilisé pour ça, avec ses limites écrites noir sur blanc.

L'issue réelle de chaque round vient du cache produit par resolve.py (endpoint
`events?slug=`, jamais `markets?condition_id=`).

Usage : python3 build_dataset.py [--resolved docs/backtest/outcomes_cache.json]
"""
import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
CACHE = os.path.join(HERE, 'outcomes_cache.json')

DEC_RE = re.compile(
    r'D[eé]cision\s+(YES|NO)\s+@\s+\$([0-9.]+)\s+\(round\s+([a-z]+-updown-5m-[0-9]+)')
SALE_RE = re.compile(
    r'VENTE\s+([A-Z]+)\s+(YES|NO)\s+@\s+\$([0-9.]+)\s+\(round\s+([a-z]+-updown-5m-[0-9]+)\)'
    r'\s*[—-]\s*gain r[eé]alis[eé]\s+\+?\$(-?[0-9.]+)')
TS_RE = re.compile(r'^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)')


def load(path):
    with open(os.path.join(DATA, path), encoding='utf-8', errors='replace') as f:
        return json.load(f)


def parse_log(path):
    """-> (decisions, sales) extraits d'un fichier de log."""
    decs, sales = [], {}
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            m = DEC_RE.search(line)
            if m:
                t = TS_RE.match(line)
                decs.append({'ts': t.group(1) if t else '', 'side': m.group(1),
                             'price': float(m.group(2)), 'round': m.group(3),
                             'coin': m.group(3).split('-updown')[0].upper(),
                             'src': 'log'})
                continue
            s = SALE_RE.search(line)
            if s:
                sales[s.group(4)] = {'coin': s.group(1), 'side': s.group(2),
                                     'exit': float(s.group(3)), 'gain': float(s.group(5))}
    return decs, sales


def main():
    cache_path = CACHE
    if '--resolved' in sys.argv:
        cache_path = sys.argv[sys.argv.index('--resolved') + 1]
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}

    def outcome(slug):
        c = cache.get(slug) or {}
        if c.get('resolved'):
            return c['yes_won'], c.get('condition_id')
        return None, c.get('condition_id')

    # ---------- B) décisions ----------
    decs, sales = [], {}
    old = load('bot__docs__data___rec.json')
    decs += [dict(d, src='rec') for d in old['decs']]
    for slug, tp in old['tps'].items():
        sales[slug] = {'coin': tp.get('coin'), 'side': tp.get('side'),
                       'exit': tp.get('exit'), 'gain': tp.get('gain')}
    for logname in ['bot__paperbot.log']:
        p = os.path.join(DATA, logname)
        if os.path.exists(p):
            d2, s2 = parse_log(p)
            decs += d2
            sales.update(s2)
    seen, uniq = set(), []
    for d in sorted(decs, key=lambda x: (x['ts'], x['round'])):
        if d['round'] in seen:
            continue
        seen.add(d['round'])
        uniq.append(d)

    rows_dec = []
    for d in uniq:
        yw, cid = outcome(d['round'])
        won = None if yw is None else (yw if d['side'] == 'YES' else not yw)
        rows_dec.append({
            'ts': d['ts'], 'coin': d['coin'], 'round': d['round'], 'side': d['side'],
            'price': d['price'], 'condition_id': cid or '', 'src': d['src'],
            'yes_won': '' if yw is None else int(yw),
            'won': '' if won is None else int(won),
            'pnl_round': '' if won is None else round((1 / d['price'] - 1) if won else -1.0, 6),
        })
    with open(os.path.join(DATA, 'decisions.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows_dec[0].keys()))
        w.writeheader()
        w.writerows(rows_dec)

    # ---------- A) trades exécutés ----------
    ex = []
    with open(os.path.join(DATA, 'bot__docs__data__recon_trades.csv'),
              encoding='utf-8') as f:
        for r in csv.DictReader(f):
            ex.append({'ts': r['ts'], 'coin': r['coin'], 'round': r['round'],
                       'side': r['side'], 'price': float(r['price']),
                       'src_exec': 'recon', 'sold_tp': int(r['src'] == 'TP'),
                       'realized_stored': float(r['realized']), 'cid_hint': ''})
    for e in load('polymarket__history.json'):
        if e.get('side') not in ('YES', 'NO'):
            continue
        ex.append({'ts': (e.get('ts') or '').replace('Z', '')[:19], 'coin': e.get('coin'),
                   'round': e.get('roundId'), 'side': e.get('side'),
                   'price': float(e.get('price')), 'src_exec': 'history',
                   'sold_tp': int(bool(e.get('soldTp'))),
                   'realized_stored': e.get('realized'),
                   'cid_hint': e.get('conditionId') or ''})

    rows_ex = []
    for t in ex:
        yw, cid = outcome(t['round'])
        cid = cid or t.get('cid_hint') or ''
        won = None if yw is None else (yw if t['side'] == 'YES' else not yw)
        s = sales.get(t['round'])
        pnl_round = '' if won is None else round((1 / t['price'] - 1) if won else -1.0, 6)
        # sortie réellement exécutée par le bot (TP ou stop) : on garde SON prix de
        # sortie, pas l'issue du round. Sinon : achat tenu jusqu'à la résolution.
        stored = t['realized_stored']
        if t['sold_tp'] and isinstance(stored, (int, float)) and stored != 0:
            pnl_tp = round(float(stored), 6)
        elif s:
            pnl_tp = round(s['gain'], 6)
        else:
            pnl_tp = pnl_round
        rows_ex.append({
            'ts': t['ts'], 'coin': t['coin'], 'round': t['round'], 'side': t['side'],
            'price': t['price'], 'condition_id': cid, 'src_exec': t['src_exec'],
            'sold_tp': t['sold_tp'], 'tp_exit': s['exit'] if s else '',
            'realized_stored': '' if stored is None else stored,
            'yes_won': '' if yw is None else int(yw),
            'won': '' if won is None else int(won),
            'pnl_round': pnl_round, 'pnl_tp': pnl_tp,
        })
    rows_ex.sort(key=lambda r: r['ts'])
    with open(os.path.join(DATA, 'executed.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows_ex[0].keys()))
        w.writeheader()
        w.writerows(rows_ex)

    # ---------- liste de slugs à résoudre ----------
    slugs = sorted({d['round'] for d in uniq} | {t['round'] for t in ex if t['round']})
    with open(os.path.join(DATA, 'slugs.txt'), 'w') as f:
        f.write('\n'.join(slugs) + '\n')

    # ---------- rapport de couverture ----------
    cum = load('polymarket__cumulative.json')
    cum_keys = set(cum.get('resolved', {}).keys())
    got_keys = {f"{r['condition_id']}|{r['side']}|{r['price']}" for r in rows_ex
                if r['condition_id']}
    missing = cum_keys - got_keys
    extra = got_keys - cum_keys
    n_res_dec = sum(1 for r in rows_dec if r['won'] != '')
    n_res_ex = sum(1 for r in rows_ex if r['won'] != '')
    rep = {
        'decisions': {'total': len(rows_dec), 'resolues': n_res_dec,
                      'periode': [rows_dec[0]['ts'], rows_dec[-1]['ts']],
                      'pnl_round_total': round(sum(float(r['pnl_round']) for r in rows_dec
                                                   if r['pnl_round'] != ''), 4),
                      'wins': sum(1 for r in rows_dec if r['won'] == 1),
                      'losses': sum(1 for r in rows_dec if r['won'] == 0)},
        'executed': {'total': len(rows_ex), 'resolues': n_res_ex,
                     'periode': [rows_ex[0]['ts'], rows_ex[-1]['ts']],
                     'pnl_round_total': round(sum(float(r['pnl_round']) for r in rows_ex
                                                  if r['pnl_round'] != ''), 4),
                     'pnl_tp_total': round(sum(float(r['pnl_tp']) for r in rows_ex
                                               if r['pnl_tp'] != ''), 4),
                     'wins': sum(1 for r in rows_ex if r['won'] == 1),
                     'losses': sum(1 for r in rows_ex if r['won'] == 0)},
        'cumulative_officiel': {'total_trades': cum.get('total_trades'),
                                'wins': cum.get('wins'), 'losses': cum.get('losses'),
                                'pnl': round(cum.get('pnl', 0), 4), 'cles': len(cum_keys)},
        'couverture_cles_cumulative': {'manquantes': len(missing),
                                       'en_plus': len(extra),
                                       'exemples_manquantes': sorted(missing)[:3],
                                       'exemples_en_plus': sorted(extra)[:3]},
    }
    json.dump(rep, open(os.path.join(DATA, 'dataset_report.json'), 'w'),
              indent=2, ensure_ascii=False)
    print(json.dumps(rep, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
