#!/usr/bin/env python3
"""validate.py — la validation qui compte : walk-forward, IC, significativité, verdicts.

Produit docs/backtest/validation_results.json et une sortie lisible qui sert
directement de source au rapport docs/EDGE-VALIDATION.md.

Sections :
  1. Réconciliation comptable (officiel vs recalculé)
  2. Calibration du marché : prix payé vs taux de réussite réel (le test le plus dur)
  3. Balayage de fenêtres de prix + sélection in-sample puis test hors échantillon
  4. Walk-forward par période chronologique (les règles « gagnantes » tiennent-elles ?)
  5. Hypothèse « ne miser que dans 0,58-0,65 »
  6. EV par coin avec IC et verdict
  7. Taille d'échantillon nécessaire
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import (load_dataset, evaluate, mean_stats, wilson_ci, required_n,  # noqa: E402
                     max_drawdown, apply_rules, t975)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'validation_results.json')
R = {}


def hdr(t):
    print('\n' + '=' * 78 + '\n' + t + '\n' + '=' * 78)


def fmt(m):
    return ('n=%-4s W=%-3s L=%-3s WR=%5.1f%% (IC95 %5.1f-%5.1f) PnL=%+8.4f EV=%+.4f '
            't=%s p=%s  DD=%s' % (
                m['n'], m['wins'], m['losses'], m['win_rate'], m['win_rate_ic95'][0],
                m['win_rate_ic95'][1], m['pnl'], m['ev'], m['t'], m['p_value'],
                m['max_drawdown']))


def main():
    dec = load_dataset('decisions')
    ex = load_dataset('executed')
    exr = [t for t in ex if t['won'] is not None]

    # ------------------------------------------------------------------ 1
    hdr('1. RÉCONCILIATION COMPTABLE')
    m_ex_round = evaluate(ex, {}, basis='round')
    m_ex_tp = evaluate(ex, {}, basis='tp')
    stored = sum(t['realized_stored'] or 0 for t in exr)
    cum = json.load(open(os.path.join(HERE, 'data', 'polymarket__cumulative.json')))
    R['reconciliation'] = {
        'cumulative_officiel': {'trades': cum['total_trades'], 'wins': cum['wins'],
                                'losses': cum['losses'], 'pnl': round(cum['pnl'], 4)},
        'recalcule_base_round': {k: m_ex_round[k] for k in
                                 ('n', 'wins', 'losses', 'win_rate', 'pnl', 'ev', 't',
                                  'p_value', 'pnl_ic95')},
        'recalcule_base_tp_bot': {k: m_ex_tp[k] for k in
                                  ('n', 'wins', 'losses', 'win_rate', 'pnl', 'ev', 't',
                                   'p_value', 'pnl_ic95')},
        'somme_realized_stockes': round(stored, 4),
        'ecart_officiel_moins_somme_stockee': round(cum['pnl'] - stored, 4),
        'ecart_officiel_moins_recalcule_tp': round(cum['pnl'] - m_ex_tp['pnl'], 4),
    }
    print('officiel cumulative :', R['reconciliation']['cumulative_officiel'])
    print('recalcul base round :', fmt(m_ex_round))
    print('recalcul base tp    :', fmt(m_ex_tp))
    print('somme des realized stockés (par trade) : %+.4f' % stored)
    print('écart officiel - somme stockée         : %+.4f' % (cum['pnl'] - stored))

    # ------------------------------------------------------------------ 2
    hdr('2. CALIBRATION DU MARCHÉ (prix payé vs WR réel) — le test le plus dur')
    cal = {}
    for lo in [0.50, 0.55, 0.60, 0.65, 0.70, 0.75]:
        hi = lo + 0.05
        sub = [t for t in dec if lo <= t['price'] < hi and t['won'] is not None]
        if not sub:
            continue
        w = sum(t['won'] for t in sub)
        ci = wilson_ci(w, len(sub))
        # à break-even sur un binaire : WR*(1/p - 1) - (1 - WR) = 0  =>  WR = p.
        # Le prix payé EST donc le taux de réussite d'équilibre.
        be = 100 * sum(t['price'] for t in sub) / len(sub)
        cal['%.2f-%.2f' % (lo, hi)] = {
            'n': len(sub), 'prix_moyen': round(sum(t['price'] for t in sub) / len(sub), 4),
            'wr_reel': round(100 * w / len(sub), 1),
            'wr_ic95': [round(ci[0] * 100, 1), round(ci[1] * 100, 1)],
            'wr_break_even': round(be, 1),
            'marge_pts': round(100 * w / len(sub) - be, 2),
        }
        print('  %s  n=%-5s prix=%.3f  WR réel=%5.1f%% (IC95 %5.1f-%5.1f)  '
              'break-even=%.1f%%  marge=%+.2f pt'
              % ('%.2f-%.2f' % (lo, hi), len(sub), cal['%.2f-%.2f' % (lo, hi)]['prix_moyen'],
                 cal['%.2f-%.2f' % (lo, hi)]['wr_reel'], ci[0] * 100, ci[1] * 100, be,
                 cal['%.2f-%.2f' % (lo, hi)]['marge_pts']))
    R['calibration_decisions'] = cal
    print('  -> lecture : si WR réel ≈ break-even, le marché est correctement prixé, '
          'donc pas d\'edge dans le niveau de prix.')

    # ------------------------------------------------------------------ 3
    hdr('3. BALAYAGE DE FENÊTRES + SÉLECTION IN-SAMPLE / TEST HORS ÉCHANTILLON')
    decs_sorted = sorted(dec, key=lambda x: x['ts'])
    cut = decs_sorted[int(len(decs_sorted) * 0.66)]['ts']
    print('  coupure temporelle (66 %% in-sample / 34 %% OOS) à %s' % cut)
    grid = []
    for lo in [0.50, 0.55, 0.58, 0.60, 0.65, 0.70]:
        for hi in [0.60, 0.65, 0.70, 0.75, 0.80, 1.01]:
            if hi <= lo:
                continue
            grid.append((lo, hi))
    sweep = []
    for lo, hi in grid:
        a = evaluate(dec, {'price_min': lo, 'price_max': hi, 'before': cut}, basis='round',
                     bootstrap=False)
        b = evaluate(dec, {'price_min': lo, 'price_max': hi, 'after': cut}, basis='round',
                     bootstrap=False)
        sweep.append({'window': [lo, hi], 'is_n': a['n'], 'is_ev': a['ev'],
                      'is_pnl': a['pnl'], 'oos_n': b['n'], 'oos_ev': b['ev'],
                      'oos_pnl': b['pnl'], 'oos_t': b['t'],
                      'oos_wr': b['win_rate'], 'oos_be_wr': b['break_even_wr'],
                      'oos_ic95': b['pnl_ic95']})
    R['sweep_fenetres'] = sweep
    print('  fenêtre            IS: n / EV      |  OOS: n / EV      WR / break-even / t')
    for s in sweep:
        flag = '  <-- EV IS la plus haute' if s['is_ev'] == max(x['is_ev'] for x in sweep) \
            else ''
        print('  %.2f-%.2f   IS n=%-5s EV=%+.4f | OOS n=%-5s EV=%+.4f  '
              'WR=%.1f%% BE=%.1f%% t=%s%s'
              % (s['window'][0], s['window'][1], s['is_n'], s['is_ev'], s['oos_n'],
                 s['oos_ev'], s['oos_wr'], s['oos_be_wr'], s['oos_t'], flag))
    best_is = max(sweep, key=lambda x: x['is_ev'])
    R['meilleure_fenetre_in_sample'] = best_is
    print('\n  MEILLEURE FENÊTRE EN IN-SAMPLE : %.2f-%.2f → OOS EV=%+.4f (n=%s, t=%s)'
          % (best_is['window'][0], best_is['window'][1], best_is['oos_ev'],
             best_is['oos_n'], best_is['oos_t']))
    print('  -> si l\'EV OOS ne suit pas l\'EV IS, la fenêtre était du bruit.')

    # ------------------------------------------------------------------ 4
    hdr('4. WALK-FORWARD PAR PÉRIODE CHRONOLOGIQUE (décisions)')
    periods = [('P1 2026-09-12→14', '2026-09-12', '2026-09-15'),
               ('P2 2026-09-15→18', '2026-09-15', '2026-09-18'),
               ('P3 2026-09-18→21', '2026-09-18', '2026-09-21')]
    wf = {}
    for name, a, b in periods:
        base = {'after': a, 'before': b}
        allm = evaluate(dec, base, basis='round', bootstrap=False)
        sw = evaluate(dec, dict(base, price_min=0.58, price_max=0.65), basis='round',
                      bootstrap=False)
        hi = evaluate(dec, dict(base, price_min=0.65, price_max=0.75), basis='round',
                      bootstrap=False)
        wf[name] = {'toutes': {k: allm[k] for k in ('n', 'win_rate', 'pnl', 'ev', 't',
                                                    'win_rate_ic95', 'break_even_wr')},
                    '0.58-0.65': {k: sw[k] for k in ('n', 'win_rate', 'pnl', 'ev', 't',
                                                     'win_rate_ic95', 'break_even_wr')},
                    '0.65-0.75': {k: hi[k] for k in ('n', 'win_rate', 'pnl', 'ev', 't',
                                                     'win_rate_ic95', 'break_even_wr')}}
        print('  %s' % name)
        print('     toutes     ', fmt(allm))
        print('     0.58-0.65  ', fmt(sw))
        print('     0.65-0.75  ', fmt(hi))
    # 4e période : trades complets post-fix (2026-09-25/26), base tp
    p4 = [t for t in exr if t['ts'] >= '2026-09-25']
    m4 = evaluate(p4, {}, basis='tp', bootstrap=False)
    wf['P4 2026-09-25→26 (trades exécutés, base tp)'] = {
        'toutes': {k: m4[k] for k in ('n', 'win_rate', 'pnl', 'ev', 't',
                                      'win_rate_ic95', 'break_even_wr')}}
    print('  P4 2026-09-25→26 (trades exécutés, base tp)')
    print('     toutes     ', fmt(m4))
    R['walk_forward'] = wf

    # 4bis) granularité par JOUR (le vrai « découpage » disponible)
    days = sorted({t['ts'][:10] for t in dec if t['won'] is not None})
    byday = {}
    print('\n  par jour (décisions, base round) :')
    print('   jour         n    WR%%    PnL        EV       t      0.58-0.65 (n/EV)')
    for d in days:
        sub = [t for t in dec if t['ts'][:10] == d and t['won'] is not None]
        if not sub:
            continue
        m = evaluate(sub, {}, basis='round', bootstrap=False)
        sw = evaluate(sub, {'price_min': 0.58, 'price_max': 0.65}, basis='round',
                      bootstrap=False)
        byday[d] = {'n': m['n'], 'wr': round(m['win_rate'], 1), 'pnl': m['pnl'],
                    'ev': m['ev'], 't': m['t'],
                    'w58_65_n': sw['n'], 'w58_65_ev': sw['ev'] if sw['n'] else None}
        print('   %s %5d %5.1f  %+9.4f %+8.4f %6.2f    %4d / %s'
              % (d, m['n'], m['win_rate'], m['pnl'], m['ev'], m['t'], sw['n'],
                 ('%+.4f' % sw['ev']) if sw['n'] else 'n/a'))
    R['par_jour_decisions'] = byday

    # 4ter) le seul cas où l'échantillon est grand : les 2 gros jours
    big = [d for d in days if sum(1 for t in dec if t['ts'][:10] == d) >= 200]
    print('\n  jours à >=200 décisions :', big)

    # ------------------------------------------------------------------ 5
    hdr('5. HYPOTHÈSE « NE MISER QUE DANS 0,58-0,65 »')
    h1 = evaluate(dec, {'price_min': 0.58, 'price_max': 0.65}, basis='round')
    h2 = evaluate(ex, {'price_min': 0.58, 'price_max': 0.65}, basis='round')
    h3 = evaluate(ex, {'price_min': 0.58, 'price_max': 0.65}, basis='tp')
    R['hypothese_058_065'] = {
        'decisions_round': h1, 'execute_round': h2, 'execute_tp': h3,
    }
    print('  A. toutes les décisions du log, base round  :', fmt(h1))
    print('     IC95 bootstrap EV=%s   break-even WR=%s%%  marge=%s pt  DD=%s'
          % (h1.get('ev_ic95_bootstrap'), h1['break_even_wr'], h1['marge_wr_pts'],
             h1['max_drawdown']))
    print('  B. 100 trades comptés, base round           :', fmt(h2))
    print('     IC95 bootstrap EV=%s   break-even WR=%s%%  marge=%s pt  DD=%s'
          % (h2.get('ev_ic95_bootstrap'), h2['break_even_wr'], h2['marge_wr_pts'],
             h2['max_drawdown']))
    print('  C. 100 trades comptés, base tp (sorties bot):', fmt(h3))
    print('  n requis (t=2) A=%s  B=%s' % (h1['n_requis_t2'], h2['n_requis_t2']))

    # ------------------------------------------------------------------ 6
    hdr('6. EV PAR COIN (décisions, base round) — peut-on juger un coin ?')
    allm = evaluate(dec, {}, basis='round', bootstrap=False)
    coins = {}
    for c, v in allm['par_coin'].items():
        coins[c] = v
        print('  %-5s n=%-5s WR=%5.1f%% (IC95 %5.1f-%5.1f)  PnL=%+8.4f  EV=%+.4f '
              '(IC95 %+.4f..%+.4f)  t=%s'
              % (c, v['n'], v['win_rate'], v['win_rate_ic95'][0], v['win_rate_ic95'][1],
                 v['pnl'], v['ev'], v['ev_ic95'][0], v['ev_ic95'][1], v['t']))
    R['par_coin_decisions'] = coins
    # sur les trades exécutés
    exm = evaluate(ex, {}, basis='tp', bootstrap=False)
    R['par_coin_execute'] = exm['par_coin']
    print('\n  sur les 100 trades comptés (base tp) :')
    for c, v in exm['par_coin'].items():
        print('  %-5s n=%-5s WR=%5.1f%% (IC95 %5.1f-%5.1f)  PnL=%+8.4f  EV=%+.4f '
              '(IC95 %+.4f..%+.4f)  t=%s'
              % (c, v['n'], v['win_rate'], v['win_rate_ic95'][0], v['win_rate_ic95'][1],
                 v['pnl'], v['ev'], v['ev_ic95'][0], v['ev_ic95'][1], v['t']))

    # ------------------------------------------------------------------ 7
    hdr('7. TAILLE D\'ÉCHANTILLON NÉCESSAIRE (t = 2)')
    rows = []
    for label, m in [('décisions (toutes)', allm), ('trades comptés (base tp)', exm)]:
        for target in [1.0, 2.0, 3.0]:
            if m['ev'] and m['ev'] > 0:
                n = required_n(m['ev'], m['sd'], target)
                rows.append((label, target, int(n) if n else None))
            else:
                rows.append((label, target, None))
    R['n_requis'] = rows
    for label, target, n in rows:
        print('  %-26s t=%.1f -> %s trades' % (label, target, n if n else 'jamais (EV<=0)'))
    print('\n  Rappel cadence observée : %d trades comptés sur 8,0 jours '
          '(2026-09-18 → 09-26)' % len(exr))

    # ------------------------------------------------------------------ 8
    hdr('8. CALIBRATION EN UN CHIFFRE + EFFET DU TAKE-PROFIT (test apparié)')
    prix_moy = sum(t['price'] for t in dec if t['won'] is not None) / len(
        [t for t in dec if t['won'] is not None])
    wr = 100 * sum(1 for t in dec if t['won'] == 1) / len(
        [t for t in dec if t['won'] is not None])
    R['calibration_un_chiffre'] = {
        'n': len([t for t in dec if t['won'] is not None]),
        'prix_moyen_paye': round(prix_moy, 4),
        'wr_reel_pct': round(wr, 2),
        'wr_break_even_pct': round(100 * prix_moy, 2),
        'marge_pts': round(wr - 100 * prix_moy, 2),
        'ev_mesuree': round(sum(t['pnl_round'] for t in dec
                                if t['won'] is not None) / len([t for t in dec
                                                                if t['won'] is not None]), 4),
    }
    print('  décisions : n=%d  prix moyen payé=%.4f  WR réel=%.2f%%  '
          'break-even=%.2f%%  marge=%+.2f pt  EV mesurée=%+.4f €/trade'
          % (R['calibration_un_chiffre']['n'], prix_moy, wr, 100 * prix_moy,
             wr - 100 * prix_moy, R['calibration_un_chiffre']['ev_mesuree']))
    print('  -> sur un binaire, le break-even est le PRIX : WR≈prix = marché efficient.')

    # Take-profit : comparaison appariée (mêmes trades, seule la sortie change)
    pairs = [(t['pnl_round'], t['pnl_tp']) for t in exr
             if t['pnl_round'] is not None and t['pnl_tp'] is not None]
    diffs = [a - b for a, b in pairs]
    nonnul = [d for d in diffs if abs(d) > 1e-9]
    st = mean_stats(diffs)
    R['effet_take_profit'] = {
        'n': len(pairs), 'n_trades_affectes': len(nonnul),
        'pnl_si_tenu_au_round': round(sum(a for a, _ in pairs), 4),
        'pnl_avec_sorties_du_bot': round(sum(b for _, b in pairs), 4),
        'delta_total': round(sum(diffs), 4),
        'delta_moyen_par_trade': round(st['mean'], 4),
        'delta_ic95': [round(st['ci95'][0], 4), round(st['ci95'][1], 4)],
        'delta_t': round(st['t'], 3) if st['t'] == st['t'] else None,
        'delta_p': round(st['p'], 4) if st['p'] == st['p'] else None,
        'gain_moyen_par_trade_affecte': round(sum(nonnul) / len(nonnul), 4)
        if nonnul else None,
    }
    print('  take-profit (100 trades comptés, comparaison appariée) :')
    print('    PnL si tout tenu au round : %+.4f' % sum(a for a, _ in pairs))
    print('    PnL avec les sorties réelles du bot : %+.4f' % sum(b for _, b in pairs))
    print('    delta = %+.4f € au total, %+.4f €/trade (IC95 %s, t=%s, p=%s) sur '
          '%d trades affectés'
          % (sum(diffs), st['mean'], [round(st['ci95'][0], 4), round(st['ci95'][1], 4)],
             R['effet_take_profit']['delta_t'], R['effet_take_profit']['delta_p'],
             len(nonnul)))

    json.dump(R, open(OUT, 'w'), indent=2, ensure_ascii=False)
    print('\n-> ', OUT)


if __name__ == '__main__':
    main()