#!/usr/bin/env python3
"""harness.py — moteur de backtest réutilisable pour le bot Polymarket Up/Down 5m.

Il ne fait AUCUNE hypothèse sur la stratégie : on lui donne des trades (avec l'issue
réelle du round) et un jeu de règles, il renvoie les métriques. Tout est en stdlib
(aucune dépendance) pour que le résultat soit reproductible tel quel.

-----------------------------------------------------------------------------
FORMAT DES TRADES
-----------------------------------------------------------------------------
Chaque trade est un dict avec au minimum :
    ts      : horodatage ISO (str, trié lexicographiquement = ordre chronologique)
    coin    : BTC|ETH|SOL|XRP|DOGE
    side    : YES (=UP) | NO (=DOWN)
    price   : prix d'entrée payé (0..1)
    won     : 1 si le côté acheté a gagné à la résolution, 0 sinon, absent si non résolu
    pnl_round : (1/price - 1) si gagné, -1 si perdu  -> achat tenu jusqu'à la résolution
    pnl_tp  : PnL de la sortie RÉELLEMENT exécutée par le bot (vente TP/stop) si elle
              existe, sinon pnl_round. (dataset 'executed' uniquement)

Deux « bases » de PnL, volontairement distinctes :
    basis='round' : le trade est tenu jusqu'à la résolution du round binaire.
    basis='tp'    : on reproduit les sorties réellement exécutées par le bot
                    (ventes à 0,99 / stop). Ce qui n'est PAS modélisable sans données
                    tick : un TP à un AUTRE prix qu'un prix réellement observé.

-----------------------------------------------------------------------------
RÈGLES SUPPORTÉES (dict)
-----------------------------------------------------------------------------
    price_min, price_max : float   fenêtre de prix d'entrée (inclusif/exclusif bornes)
    coins                : list    whitelist de coins (None = tous)
    sides                : list    whitelist YES/NO (None = les deux)
    after                : str     ne garder que ts >= after
    before               : str     ne garder que ts <  before
    stake                : float   mise fixe (defaut 1.0)
    stake_by_price       : callable(price) -> multiplicateur de mise (defaut None)
    skip_after_losses    : int     apres N pertes consecutives, sauter le trade suivant
                                   (par coin). Causal (n'utilise que le passé).
    min_wr_recent        : float   sauter si le WR des N derniers trades resolus du coin
                                   est sous ce seuil (filtre « learn » du bot)
    *args ignorés (les règles inconnues sont signalées, jamais devinées)

-----------------------------------------------------------------------------
MÉTRIQUES RENDUES
-----------------------------------------------------------------------------
    n, wins, losses, n_pending, win_rate + IC95 Wilson
    pnl, ev (par trade), sd, se
    IC95 du PnL moyen (Student, bilatéral 95 %), statistique t, p-value bilatérale
    IC95 bootstrap du PnL moyen (2000 rééchantillonnages, seed fixe)
    max_drawdown (en unités de mise, sur la courbe de PnL cumulée en ordre chronologique)
    profit_factor, break_even_wr (déduit des gains moyens observés), marge de WR
    n_requis_t2 (nombre de trades qu'il faudrait pour t=2 à l'EV et l'écart-type mesurés)
    par_coin  : mêmes métriques, par coin (avec IC)
"""
import argparse
import csv
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')

# ---------------------------------------------------------------------------
# Statistiques (stdlib pur)
# ---------------------------------------------------------------------------

def _norm_cdf(z):
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _norm_ppf(p):
    """Quantile de la loi normale centrée réduite (Acklam, précision ~1e-9)."""
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


_T975 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
         8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
         15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
         21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056,
         27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042}


def t975(df):
    """Quantile 97,5 % de Student, interpolation linéaire dans une table, 1.96 au-delà."""
    if df < 1:
        return float('nan')
    if df > 30:
        return 1.9600 + (2.042 - 1.9600) * (30.0 / df) ** 2   # tend vers 1.96
    lo, hi = int(math.floor(df)), int(math.ceil(df))
    if lo == hi:
        return _T975[lo]
    f = df - lo
    return _T975[lo] * (1 - f) + _T975[hi] * f


def wilson_ci(k, n, z=1.959964):
    """IC95 de Wilson pour une proportion (bien meilleur que l'approx normale en petit n)."""
    if n == 0:
        return (float('nan'), float('nan'))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def mean_stats(vals):
    """mean, sd (ddof=1), se, t, p bilatérale, IC95 (Student)."""
    n = len(vals)
    if n == 0:
        return {'n': 0, 'mean': float('nan'), 'sd': float('nan'), 'se': float('nan'),
                't': float('nan'), 'p': float('nan'),
                'ci95': (float('nan'), float('nan'))}
    m = sum(vals) / n
    if n == 1:
        return {'n': 1, 'mean': m, 'sd': 0.0, 'se': float('nan'), 't': float('nan'),
                'p': float('nan'), 'ci95': (float('nan'), float('nan'))}
    var = sum((v - m) ** 2 for v in vals) / (n - 1)
    sd = math.sqrt(var)
    se = sd / math.sqrt(n)
    t = m / se if se > 0 else float('nan')
    p = 2 * (1 - _norm_cdf(abs(t))) if se > 0 else float('nan')
    q = t975(n - 1)
    return {'n': n, 'mean': m, 'sd': sd, 'se': se, 't': t, 'p': p,
            'ci95': (m - q * se, m + q * se)}


def bootstrap_mean_ci(vals, iters=2000, seed=20260926):
    """IC95 bootstrap (percentile) du PnL moyen — contrôle que l'IC Student n'est pas
    un artefact de la non-normalité (les PnL sont très asymétriques : -1 ou +0,5)."""
    if len(vals) < 2:
        return (float('nan'), float('nan'))
    rnd = random.Random(seed)
    n = len(vals)
    means = []
    for _ in range(iters):
        s = 0.0
        for _ in range(n):
            s += vals[rnd.randrange(n)]
        means.append(s / n)
    means.sort()
    return (means[int(0.025 * iters)], means[int(0.975 * iters) - 1])


def _row_pnl(t, basis):
    if basis == 'tp' and t.get('pnl_tp') is not None:
        return t['pnl_tp']
    return t['pnl_round']


def max_drawdown(ordered_pnls):
    """Perte max pic->creux de la courbe de PnL cumulée (ordre chronologique), en €."""
    cum = 0.0
    peak = 0.0
    dd = 0.0
    for p in ordered_pnls:
        cum += p
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return dd


def required_n(ev, sd, t_target=2.0):
    """Trades nécessaires pour atteindre t_target à l'EV et l'écart-type mesurés.
    None si ev <= 0, ou si ev/sd ne sont pas des nombres finis exploitables.
    ATTENTION : suppose que l'EV mesurée est la vraie valeur."""
    if ev is None or sd is None:
        return None
    if not (math.isfinite(ev) and math.isfinite(sd)):
        return None
    if ev <= 0 or sd <= 0:
        return None
    return (t_target * sd / ev) ** 2


def break_even_wr(payoffs_won):
    """WR minimal pour être à l'équilibre : 1/(1+b) avec b = gain moyen des gagnants."""
    if not payoffs_won:
        return None
    b = sum(payoffs_won) / len(payoffs_won)
    return 1.0 / (1.0 + b)


# ---------------------------------------------------------------------------
# Chargement des données
# ---------------------------------------------------------------------------

def _num(v):
    if v is None or v == '':
        return None
    return float(v)


def load_dataset(name, path=None):
    """name = 'executed' | 'decisions'. -> liste de trades (dict propre)."""
    path = path or os.path.join(DATA, name + '.csv')
    rows = []
    with open(path, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            won = r.get('won')
            rows.append({
                'ts': r['ts'], 'coin': r['coin'], 'round': r['round'],
                'side': r['side'], 'price': float(r['price']),
                'won': None if won in (None, '') else int(won),
                'pnl_round': _num(r.get('pnl_round')),
                'pnl_tp': _num(r.get('pnl_tp')),
                'sold_tp': int(_num(r.get('sold_tp')) or 0),
                'src_exec': r.get('src_exec'),
                'realized_stored': _num(r.get('realized_stored')),
            })
    rows.sort(key=lambda x: x['ts'])
    return rows


# ---------------------------------------------------------------------------
# Application des règles et évaluation
# ---------------------------------------------------------------------------

def apply_rules(rows, rules):
    """Sélectionne les trades satisfaisant les règles. Les règles « adaptatives »
    (skip_after_losses, min_wr_recent) ne regardent QUE le passé -> pas de look-ahead.
    Retourne (trades_retenus, liste_de_raisons_de_rejet)."""
    pm, pM = rules.get('price_min'), rules.get('price_max')
    coins, sides = rules.get('coins'), rules.get('sides')
    lo_c, hi_c = rules.get('cost_min'), rules.get('cost_max')
    out, why = [], {'prix': 0, 'coin': 0, 'side': 0, 'periode': 0, 'non_resolu': 0,
                    'cooldown': 0, 'filtre_wr': 0}
    per_coin_hist = {}                     # coin -> [won,...] des trades retenus

    for t in rows:
        if t['won'] is None or t.get('pnl_round') is None:
            why['non_resolu'] += 1
            continue
        if pm is not None and t['price'] < pm:
            why['prix'] += 1
            continue
        if pM is not None and t['price'] >= pM:
            why['prix'] += 1
            continue
        if lo_c is not None and lo_c not in t['coin']:
            why['coin'] += 1
            continue
        if hi_c is not None and hi_c not in t['coin']:
            why['coin'] += 1
            continue
        if coins and t['coin'] not in coins:
            why['coin'] += 1
            continue
        if sides and t['side'] not in sides:
            why['side'] += 1
            continue
        if rules.get('after') and t['ts'] < rules['after']:
            why['periode'] += 1
            continue
        if rules.get('before') and t['ts'] >= rules['before']:
            why['periode'] += 1
            continue
        h = per_coin_hist.get(t['coin'], [])
        skip = 0
        if rules.get('skip_after_losses') and len(h) >= rules['skip_after_losses']:
            if all(w == 0 for w in h[-rules['skip_after_losses']:]):
                skip += 1
        if rules.get('min_wr_recent'):
            need = rules.get('min_wr_recent_n', 8)
            if len(h) >= need:
                wr = sum(h[-need:]) / need
                if wr < rules['min_wr_recent']:
                    skip += 1
        if skip:
            why['cooldown'] += 1
            continue                      # le trade sauté n'entre pas dans l'historique du coin
        out.append(t)
        per_coin_hist.setdefault(t['coin'], []).append(t['won'])
    return out, why


def evaluate(rows, rules=None, basis='round', bootstrap=True):
    """Applique les règles puis calcule toutes les métriques. -> dict."""
    rules = dict(rules or {})
    sel, why = apply_rules(rows, rules)
    stake = rules.get('stake', 1.0)
    mult = rules.get('stake_by_price')
    pnls, ordered = [], []
    wins = []
    for t in sel:
        if basis == 'tp':
            p = t['pnl_tp'] if t.get('pnl_tp') is not None else t['pnl_round']
        else:
            p = t['pnl_round']
        m = mult(t['price']) if mult else 1.0
        pnls.append(p * stake * m)
        ordered.append((t['ts'], p * stake * m))
        if t['won']:
            wins.append(t['pnl_round'])
    pnls_ord = [p for _, p in sorted(ordered, key=lambda x: x[0])]
    st = mean_stats(pnls) if pnls else mean_stats([])
    wins_n = sum(1 for t in sel if t['won'])
    losses_n = len(sel) - wins_n
    ciw = wilson_ci(wins_n, len(sel))
    tot = sum(pnls)
    gains = sum(p for p in pnls if p > 0)
    pertes = -sum(p for p in pnls if p < 0)
    out = {
        'regles': {k: (v if not callable(v) else 'callable') for k, v in rules.items()},
        'base': basis, 'n': len(sel), 'n_examines': len(rows),
        'wins': wins_n, 'losses': losses_n,
        'win_rate': (wins_n / len(sel) * 100) if sel else float('nan'),
        'win_rate_ic95': [round(ciw[0] * 100, 1), round(ciw[1] * 100, 1)],
        'pnl': round(tot, 4),
        'ev': round(st['mean'], 4) if sel else float('nan'),
        'sd': round(st['sd'], 4) if sel else float('nan'),
        'se': round(st['se'], 4) if sel else float('nan'),
        't': round(st['t'], 3) if st['t'] == st['t'] else None,
        'p_value': round(st['p'], 4) if st['p'] == st['p'] else None,
        'pnl_ic95': [round(st['ci95'][0], 4), round(st['ci95'][1], 4)] if sel else None,
        'max_drawdown': round(max_drawdown(pnls_ord), 4),
        'profit_factor': round(gains / pertes, 3) if pertes > 0 else None,
        'gain_moyen': round(sum(wins) / len(wins), 4) if wins else None,
        'perte_moyenne': round(-sum(p for p in pnls if p < 0) / losses_n, 4) if losses_n else None,
        'break_even_wr': (round(break_even_wr(wins) * 100, 1)
                          if break_even_wr(wins) is not None else None),
        'marge_wr_pts': (round((wins_n / len(sel) - break_even_wr(wins)) * 100, 2)
                         if sel and break_even_wr(wins) is not None else None),
        'n_requis_t2': (round(required_n(st['mean'], st['sd'], 2.0))
                        if required_n(st['mean'], st['sd'], 2.0) else None),
        'rejets': why,
    }
    if bootstrap and len(pnls) >= 2:
        b = bootstrap_mean_ci(pnls)
        out['ev_ic95_bootstrap'] = [round(b[0], 4), round(b[1], 4)]
    # par coin
    par_coin = {}
    for t in sel:
        p = _row_pnl(t, basis)
        par_coin.setdefault(t['coin'], []).append((p * stake, t['won']))
    out['par_coin'] = {}
    for c, lst in sorted(par_coin.items()):
        vals = [v for v, _ in lst]
        w = sum(1 for _, w_ in lst if w_)
        s = mean_stats(vals)
        ci = wilson_ci(w, len(lst))
        out['par_coin'][c] = {
            'n': len(lst), 'wins': w, 'win_rate': round(100 * w / len(lst), 1),
            'win_rate_ic95': [round(ci[0] * 100, 1), round(ci[1] * 100, 1)],
            'pnl': round(sum(vals), 4), 'ev': round(s['mean'], 4),
            'ev_ic95': [round(s['ci95'][0], 4), round(s['ci95'][1], 4)],
            't': round(s['t'], 2) if s['t'] == s['t'] else None,
        }
    # par bucket de prix (pas 0,05) — utile pour la question « fenêtre 0,58-0,65 »
    buckets = [(0.50, 0.55), (0.55, 0.60), (0.60, 0.65), (0.65, 0.70),
               (0.70, 0.75), (0.75, 0.80), (0.80, 1.01)]
    out['par_bucket'] = {}
    for lo, hi in buckets:
        sub = [t for t in sel if lo <= t['price'] < hi]
        if not sub:
            continue
        vals = [_row_pnl(t, basis) * stake for t in sub]
        w = sum(1 for t in sub if t['won'])
        s = mean_stats(vals)
        ci = wilson_ci(w, len(sub))
        out['par_bucket'][f'{lo:.2f}-{hi:.2f}'] = {
            'n': len(sub), 'wins': w, 'win_rate': round(100 * w / len(sub), 1),
            'win_rate_ic95': [round(ci[0] * 100, 1), round(ci[1] * 100, 1)],
            'prix_moyen': round(sum(t['price'] for t in sub) / len(sub), 3),
            'pnl': round(sum(vals), 4), 'ev': round(s['mean'], 4),
            'ev_ic95': [round(s['ci95'][0], 4), round(s['ci95'][1], 4)],
            't': round(s['t'], 2) if s['t'] == s['t'] else None,
        }
    return out


def print_metrics(m, title=''):
    if title:
        print('\n### ' + title)
    print('  n=%s  W=%s L=%s  WR=%.1f%% (IC95 %.1f-%.1f)  PnL=%+.4f  EV=%+.4f  '
          't=%s  p=%s' % (m['n'], m['wins'], m['losses'], m['win_rate'],
                          m['win_rate_ic95'][0], m['win_rate_ic95'][1], m['pnl'],
                          m['ev'] if m['ev'] == m['ev'] else float('nan'),
                          m['t'], m['p_value']))
    print('     IC95 PnL/trade=%s  IC95 bootstrap=%s  DDmax=%.4f  PF=%s  '
          'break-even WR=%s%%  marge=%s pt' % (
              m['pnl_ic95'], m.get('ev_ic95_bootstrap'), m['max_drawdown'],
              m['profit_factor'], m['break_even_wr'], m['marge_wr_pts']))
    print('     gain moyen=%s  perte moyenne=%s  n requis pour t=2=%s' % (
        m['gain_moyen'], m['perte_moyenne'], m['n_requis_t2']))


def main():
    ap = argparse.ArgumentParser(description='Backtest Polymarket Up/Down 5m')
    ap.add_argument('--dataset', default='executed', choices=['executed', 'decisions'])
    ap.add_argument('--basis', default='round', choices=['round', 'tp'])
    ap.add_argument('--price-min', type=float, default=None)
    ap.add_argument('--price-max', type=float, default=None)
    ap.add_argument('--coins', default=None, help='ex: BTC,ETH')
    ap.add_argument('--sides', default=None, help='ex: YES')
    ap.add_argument('--after', default=None)
    ap.add_argument('--before', default=None)
    ap.add_argument('--stake', type=float, default=1.0)
    ap.add_argument('--skip-after-losses', type=int, default=None)
    ap.add_argument('--min-wr-recent', type=float, default=None)
    ap.add_argument('--json', default=None, help='écrit les métriques complètes en JSON')
    ap.add_argument('--print-buckets', action='store_true')
    args = ap.parse_args()

    rows = load_dataset(args.dataset)
    rules = {
        'price_min': args.price_min, 'price_max': args.price_max,
        'coins': args.coins.split(',') if args.coins else None,
        'sides': args.sides.split(',') if args.sides else None,
        'after': args.after, 'before': args.before, 'stake': args.stake,
        'skip_after_losses': args.skip_after_losses,
        'min_wr_recent': args.min_wr_recent,
    }
    m = evaluate(rows, rules, basis=args.basis)
    print_metrics(m, 'dataset=%s base=%s regles=%s' % (args.dataset, args.basis,
                                                       {k: v for k, v in rules.items() if v}))
    if args.print_buckets:
        for b, v in m['par_bucket'].items():
            print('  bucket %s: n=%-4s WR=%.1f%% (IC95 %.1f-%.1f) prix=%.3f PnL=%+.4f '
                  'EV=%+.4f t=%s' % (b, v['n'], v['win_rate'], v['win_rate_ic95'][0],
                                     v['win_rate_ic95'][1], v['prix_moyen'], v['pnl'],
                                     v['ev'], v['t']))
    if args.json:
        json.dump(m, open(args.json, 'w'), indent=2, ensure_ascii=False)
        print('  -> %s' % args.json)


if __name__ == '__main__':
    main()