#!/usr/bin/env python3
"""audit_decision_vs_trade.py — écart entre les DÉCISIONS du bot et les trades COMPTÉS.

Question : le bot a pris ~1400 décisions (log) mais n'en a comptabilisé que 100
(cumulative.json). Les deux ensembles correspondent-ils ? Sinon, quoi, et est-ce que
ça biaise l'analyse ?

Méthode : on inverse le cache d'issues (slug -> conditionId) pour retrouver le slug de
chaque clé `conditionId|SIDE|price` du store cumulatif, puis on compare les trois
ensembles : décisions (log), trades comptés (cumulative), exécutions reconstruites.

Sortie : JSON + tableau lisible.
"""
import csv
import json
import os
import collections

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')


def main():
    cache = json.load(open(os.path.join(HERE, 'outcomes_cache.json')))
    cum = json.load(open(os.path.join(DATA, 'polymarket__cumulative.json')))
    decs = list(csv.DictReader(open(os.path.join(DATA, 'decisions.csv'))))
    ex = list(csv.DictReader(open(os.path.join(DATA, 'executed.csv'))))

    slug_of_cid = {}
    for slug, v in cache.items():
        if v.get('condition_id'):
            slug_of_cid[v['condition_id'].lower()] = slug

    # 1) chaque clé du store cumulatif -> slug -> horodatage du slot
    rows = []
    unknown = 0
    for key in cum['resolved']:
        cid, side, price = key.split('|')
        slug = slug_of_cid.get(cid.lower())
        if not slug:
            unknown += 1
            continue
        slot = int(slug.rsplit('-', 1)[-1])
        rows.append({'key': key, 'slug': slug, 'slot': slot, 'side': side,
                     'price': float(price)})
    print('clés cumulative résolues en slug : %d (inconnues: %d)' % (len(rows), unknown))

    dec_by_round = {d['round']: d for d in decs}
    ex_by_round = {e['round']: e for e in ex}

    # 2) cohérence décision <-> trade compté (même round, même côté, même prix ?)
    same_round = same_side = same_price = 0
    absent_dec = []
    for r in rows:
        d = dec_by_round.get(r['slug'])
        if d is None:
            absent_dec.append(r)
            continue
        same_round += 1
        if d['side'] == r['side']:
            same_side += 1
            if abs(float(d['price']) - r['price']) < 1e-9:
                same_price += 1
    print('trades comptés retrouvés comme décision du log : %d/%d' % (same_round, len(rows)))
    print('  ... même côté : %d | même prix : %d' % (same_side, same_price))

    # 3) décisions NON retrouvées dans le store cumulatif
    cum_rounds = {r['slug'] for r in rows}
    unused = [d for d in decs if d['round'] not in cum_rounds]
    print('décisions jamais comptées : %d/%d (%.1f%%)' % (len(unused), len(decs),
                                                         100.0 * len(unused) / len(decs)))
    per_day = collections.Counter(d['ts'][:10] for d in unused)
    print('  par jour (non comptées) :', dict(sorted(per_day.items())))

    # Où se situe la frontière ? -> la coupure est-elle TEMPORELLE (store remis à zéro
    # à une date) ou dépendante du RÉSULTAT (biais de sélection) ?
    counts = collections.defaultdict(lambda: [0, 0])       # jour -> [total, comptées]
    for d in decs:
        counts[d['ts'][:10]][0] += 1
        if d['round'] in cum_rounds:
            counts[d['ts'][:10]][1] += 1
    print('\n  jour         décisions  comptées  ratio')
    for day in sorted(counts):
        tot, c = counts[day]
        print('   %s  %7d  %7d  %6.1f%%' % (day, tot, c, 100.0 * c / tot))
    cut = min((r['ts'] for r in [d for d in decs if d['round'] in cum_rounds]), default=None)
    print('  -> première décision comptée : %s' % cut)
    print('     lecture : si le ratio passe de 0 %% à 100 %% à une date, la coupure est')
    print('     TEMPORELLE (store cumulatif remis à zéro), pas un filtrage sur le résultat.')
    dec_rnd = {d['round'] for d in decs}
    bof_rounds = {r['slug'] for r in rows} - dec_rnd
    print('     trades comptés dont le round est ABSENT du log : %d' % len(bof_rounds))

    # 4) PnL des décisions NON comptées (base round) vs comptées
    def pnl(sub):
        v = [float(d['pnl_round']) for d in sub if d['pnl_round'] != '']
        return round(sum(v), 4), len(v), round(sum(v) / len(v), 4) if v else None

    print('\nPnL round (base round, mise 1) :')
    print('  décisions NON comptées : %s' % (pnl(unused),))
    counted = [d for d in decs if d['round'] in cum_rounds]
    print('  décisions comptées     : %s' % (pnl(counted),))

    # 5) répartition des prix : décisions comptées vs non comptées
    def buckets(sub):
        c = collections.Counter()
        for d in sub:
            p = float(d['price'])
            lo = int(p * 20) / 20.0
            c['%.2f-%.2f' % (lo, lo + 0.05)] += 1
        return dict(sorted(c.items()))

    print('\nprix — décisions comptées   :', buckets(counted))
    print('prix — décisions non comptées:', buckets(unused))

    # test à deux échantillons : le sous-ensemble compté a-t-il un PnL moyen différent ?
    a = [float(d['pnl_round']) for d in counted if d['pnl_round'] != '']
    b = [float(d['pnl_round']) for d in unused if d['pnl_round'] != '']

    def ms(v):
        m = sum(v) / len(v)
        var = sum((x - m) ** 2 for x in v) / (len(v) - 1)
        return m, var, len(v)

    ma, va, na = ms(a)
    mb, vb, nb = ms(b)
    se = (va / na + vb / nb) ** 0.5
    tt = (ma - mb) / se if se > 0 else float('nan')
    print('\nPnL moyen comptées=%.4f (n=%d) vs non comptées=%.4f (n=%d) -> t=%.2f'
          % (ma, na, mb, nb, tt))

    out = {
        'cles_cumulative_mappees': len(rows), 'cles_non_mappees': unknown,
        'trades_comptes_retrouves_dans_log': same_round,
        'meme_cote': same_side, 'meme_prix': same_price,
        'decisions_total': len(decs), 'decisions_non_comptees': len(unused),
        'premiere_decision_comptee': cut,
        'ratio_compte_par_jour': {d: [counts[d][0], counts[d][1]] for d in sorted(counts)},
        'pnl_round_decisions_non_comptees': pnl(unused)[0],
        'pnl_round_decisions_comptees': pnl(counted)[0],
        't_test_comptees_vs_non_comptees': round(tt, 3) if tt == tt else None,
        'slugs_comptes_absents_du_log': sorted(bof_rounds),
    }
    json.dump(out, open(os.path.join(DATA, 'audit_decision_vs_trade.json'), 'w'),
              indent=2, ensure_ascii=False)


if __name__ == '__main__':
    main()