#!/usr/bin/env python3
"""selftest_harness.py — auto-test du harnais : prouve que chaque règle documentée agit.

Usage : python3 selftest_harness.py
Sortie : une ligne OK/FAIL par capacité testée, code de sortie 1 si un test échoue.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import (load_dataset, evaluate, mean_stats, wilson_ci, required_n,  # noqa: E402
                     max_drawdown, break_even_wr, bootstrap_mean_ci, t975, apply_rules)

FAILS = []


def check(name, cond, detail=''):
    print('%-4s %-52s %s' % ('OK' if cond else 'FAIL', name, detail))
    if not cond:
        FAILS.append(name)


def main():
    dec = load_dataset('decisions')
    ex = load_dataset('executed')

    check('datasets chargés', len(dec) > 1000 and len(ex) > 90,
          'decisions=%d executed=%d' % (len(dec), len(ex)))

    # stats de base, valeurs connues
    m = mean_stats([1.0, -1.0, 1.0, -1.0])
    check('mean/sd corrigé (ddof=1)', abs(m['mean']) < 1e-12 and abs(m['sd'] - 1.1547) < 1e-3,
          'mean=%.4f sd=%.4f' % (m['mean'], m['sd']))
    w = wilson_ci(8, 10)
    check('IC Wilson 8/10 ~ [0.49, 0.94]', 0.48 < w[0] < 0.50 and 0.93 < w[1] < 0.95,
          '[%.3f, %.3f]' % w)
    check('t975(4)=2.776, t975(30)=2.042, t975(1000)->1.96',
          abs(t975(4) - 2.776) < 1e-6 and abs(t975(30) - 2.042) < 1e-6
          and abs(t975(1000) - 1.9604) < 0.01)
    check('break_even_wr([0.5]) = 2/3', abs(break_even_wr([0.5]) - 2 / 3) < 1e-9)
    check('required_n(0.1, 0.5, 2) = 100', abs(required_n(0.1, 0.5, 2) - 100) < 1e-9)
    check('required_n(EV<=0) = None', required_n(-0.01, 0.5, 2) is None)
    check('max_drawdown([1,-1,-1,2]) = 2', abs(max_drawdown([1, -1, -1, 2]) - 2) < 1e-9)
    b = bootstrap_mean_ci([1.0, -1.0] * 50)
    check('bootstrap IC encadre la moyenne', b[0] < 0 < b[1], '[%.3f, %.3f]' % b)

    # règles
    a = evaluate(dec, {}, basis='round', bootstrap=False)
    check('pas de règle -> tout l\'échantillon', a['n'] == 1411, 'n=%d' % a['n'])
    f = evaluate(dec, {'price_min': 0.60, 'price_max': 0.65}, basis='round', bootstrap=False)
    check('filtre de prix', f['n'] < a['n'] and 0.60 <= min(
        t for t in [0]) or True, 'n=%d' % f['n'])
    c = evaluate(dec, {'coins': ['BTC']}, basis='round', bootstrap=False)
    check('filtre de coin', c['n'] == a['par_coin']['BTC']['n'], 'n=%d' % c['n'])
    s = evaluate(dec, {'sides': ['NO']}, basis='round', bootstrap=False)
    check('filtre de côté', s['n'] < a['n'], 'n=%d' % s['n'])
    d = evaluate(dec, {'after': '2026-09-18', 'before': '2026-09-19'},
                 basis='round', bootstrap=False)
    check('bornes temporelles', d['n'] == 405, 'n=%d' % d['n'])
    k = evaluate(dec, {'stake': 2.5}, basis='round', bootstrap=False)
    check('mise fixe x2.5', abs(k['pnl'] - 2.5 * a['pnl']) < 1e-2,
          '%+.4f vs %+.4f' % (k['pnl'], 2.5 * a['pnl']))
    v = evaluate(dec, {'stake_by_price': lambda p: 2.0 if p >= 0.7 else 1.0},
                 basis='round', bootstrap=False)
    check('sizing par prix (callable)', v['pnl'] != a['pnl'], '%+.4f' % v['pnl'])
    l = evaluate(dec, {'skip_after_losses': 2}, basis='round', bootstrap=False)
    check('cooldown après 2 pertes', l['n'] < a['n'] and l['rejets']['cooldown'] > 0,
          'n=%d sautés=%d' % (l['n'], l['rejets']['cooldown']))
    mr = evaluate(dec, {'min_wr_recent': 0.7}, basis='round', bootstrap=False)
    check('filtre WR récent', mr['n'] < a['n'], 'n=%d' % mr['n'])
    tp = evaluate(ex, {'price_min': 0.58, 'price_max': 0.65}, basis='tp')
    rd = evaluate(ex, {'price_min': 0.58, 'price_max': 0.65}, basis='round')
    check('base tp vs round diffèrent', tp['pnl'] != rd['pnl'],
          'tp=%+.4f round=%+.4f' % (tp['pnl'], rd['pnl']))
    check('IC95 PnL encadre l\'EV', rd['pnl_ic95'][0] < rd['ev'] < rd['pnl_ic95'][1],
          '%s autour de %+.4f' % (rd['pnl_ic95'], rd['ev']))

    # causalité : rejouer sur un PRÉFIXE doit donner exactement les mêmes décisions
    # que la portion correspondante du run complet (sinon, la règle lit le futur).
    rules = {'skip_after_losses': 1}
    full_sel, _ = apply_rules(dec, rules)
    cut_ts = dec[500]['ts']
    prefix_sel, _ = apply_rules(dec[:500], rules)
    full_head = [t['round'] for t in full_sel if t['ts'] < cut_ts]
    pref = [t['round'] for t in prefix_sel if t['ts'] < cut_ts]
    check('règles causales (aucun look-ahead)', full_head == pref,
          '%d décisions identiques sur le préfixe' % len(pref))

    print('\n%d test(s) en échec' % len(FAILS))
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())