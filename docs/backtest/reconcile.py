#!/usr/bin/env python3
"""reconcile.py — pourquoi le PnL « officiel » ne vaut pas la somme des gains par trade.

Le store cumulatif (~/.polymarket/cumulative.json) additionne un `realized` au moment
où il le voit. Il ne conserve PAS le détail par trade (juste un ensemble de clés).
Résultat : son total peut différer de la somme des `realized` stockés.

Décomposition testée ici :
    cumulative.pnl  ==  pnl(63 premiers trades, valeur du repair du 25/09)
                        +  somme des realized des 37 trades suivants
et comparaison avec les valeurs recalculées indépendamment sur l'issue réelle.

Usage : python3 reconcile.py
"""
import csv
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')


def main():
    cum = json.load(open(os.path.join(DATA, 'polymarket__cumulative.json')))
    repair = json.load(open(os.path.join(DATA, 'polymarket__repair-20260925-213149.json')))
    ex = list(csv.DictReader(open(os.path.join(DATA, 'executed.csv'))))
    exs = sorted(ex, key=lambda r: r['ts'])
    first63 = [r for r in exs if r['src_exec'] == 'recon']
    later = [r for r in exs if r['src_exec'] == 'history' and r['won'] != '']

    def s(rows, col):
        return round(sum(float(r[col]) for r in rows if r[col] not in ('', None)), 4)

    a = repair['stats_cumulative']['after']['pnl']          # valeur du repair sur les 63
    b = s(later, 'realized_stored')                          # 37 trades suivants
    print('cumulative.pnl officiel                  : %+.4f' % cum['pnl'])
    print('  = valeur du repair 2026-09-25 (63 tr.) : %+.4f  (wins %d / losses %d)'
          % (a, repair['stats_cumulative']['after']['wins'],
             repair['stats_cumulative']['after']['losses']))
    print('  + realized stockés des 37 trades suiv. : %+.4f' % b)
    print('  = %+.4f   (écart avec l\'officiel : %+.4f)'
          % (a + b, cum['pnl'] - (a + b)))
    print()
    print('recalcul indépendant sur l\'issue réelle :')
    print('  les 63 premiers, base sorties réelles  : %+.4f' % s(first63, 'pnl_tp'))
    print('  les 63 premiers, base tenu au round    : %+.4f' % s(first63, 'pnl_round'))
    print('  les 37 suivants, sorties TP du bot     : %+.4f' % s(later, 'pnl_tp'))
    print('  total 100 trades, base sorties réelles : %+.4f'
          % (s(first63, 'pnl_tp') + s(later, 'pnl_tp')))
    print('  total 100 trades, base tenu au round   : %+.4f'
          % (s(first63, 'pnl_round') + s(later, 'pnl_round')))
    print('  total 100 trades, somme des realized   : %+.4f'
          % s([r for r in exs if r['won'] != ''], 'realized_stored'))
    print()
    print('wins/losses : officiel %d/%d | recalculé (round) %d/%d'
          % (cum['wins'], cum['losses'],
             sum(1 for r in exs if r['won'] == '1'), sum(1 for r in exs if r['won'] == '0')))
    out = {
        'cumulative_pnl': cum['pnl'],
        'decomposition': {'repair_63': a, 'realized_37': b, 'somme': round(a + b, 4),
                          'ecart': round(cum['pnl'] - (a + b), 4)},
        'recalcule_100_sorties_reelles': round(s(first63, 'pnl_tp') + s(later, 'pnl_tp'), 4),
        'recalcule_100_tenu_au_round': round(s(first63, 'pnl_round') + s(later, 'pnl_round'), 4),
        'somme_realized_stockes': s([r for r in exs if r['won'] != ''], 'realized_stored'),
        'ecart_officiel_vs_stockes': round(cum['pnl'] -
                                           s([r for r in exs if r['won'] != ''],
                                             'realized_stored'), 4),
    }
    json.dump(out, open(os.path.join(DATA, 'reconciliation.json'), 'w'), indent=2)
    print('\n-> data/reconciliation.json')


if __name__ == '__main__':
    main()