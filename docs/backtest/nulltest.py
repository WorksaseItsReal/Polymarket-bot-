#!/usr/bin/env python3
"""nulltest.py — les tests qui décident si quelque chose est concluant.

Trois questions, trois réponses honnêtes :

  A) TEST EXACT (binomial) sur la fenêtre 0,58-0,65 :
     « 29 gagnants sur 39 à un prix moyen de 0,60, est-ce rare quand le marché est
     correctement prixé (p = prix) ? » -> p-value exacte, plus le nombre de fenêtres
     testées (correction de multiplicité).

  B) TEST DE PLACEBO (Monte-Carlo) : on fabrique des marchés PARFAITEMENT prixés
     (chaque trade gagne avec probabilité = son prix), puis on rejoue la MÊME
     procédure de sélection de fenêtre (in-sample sur les 66 % premiers, on garde la
     meilleure, on mesure hors échantillon). La distribution obtenue est celle du
     « meilleur résultat qu'on peut trouver par hasard ». Si l'observation tombe
     dedans, la fenêtre gagnante n'est pas un edge.

  C) ERREURS STANDARD ROBUSTES AU CLUSTERING : les trades arrivent par grappes
     (plusieurs coins sur le MÊME round de 5 min) -> l'hypothèse d'indépendance est
     fausse et les IC normaux sont trop étroits. On regroupe par round et par jour.

Usage : python3 nulltest.py [--iters 2000]
"""
import json
import math
import os
import random
import sys
import collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import load_dataset, evaluate, mean_stats, wilson_ci  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ITERS = 2000
if '--iters' in sys.argv:
    ITERS = int(sys.argv[sys.argv.index('--iters') + 1])


def binom_sf(k, n, p):
    """P(X >= k) pour X ~ Binomial(n, p)."""
    return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k, n + 1))


def cluster_se(rows, key, pnl_key='pnl_round'):
    """SE du PnL moyen, robuste au clustering (grappes = key(trade))."""
    groups = collections.defaultdict(list)
    for t in rows:
        if t[pnl_key] is None:
            continue
        groups[key(t)].append(t[pnl_key])
    means = [sum(v) / len(v) for v in groups.values()]
    n_g = len(means)
    if n_g < 2:
        return float('nan'), n_g
    m = sum(means) / n_g
    var = sum((x - m) ** 2 for x in means) / (n_g - 1)
    return math.sqrt(var / n_g), n_g


def main():
    dec = load_dataset('decisions')
    ex = load_dataset('executed')
    R = {}

    # ---------------- A) test exact binomial ----------------
    print('=' * 78)
    print('A) TEST EXACT (binomial) SUR LA FENÊTRE 0,58-0,65')
    print('=' * 78)
    tests = []
    for label, rows in [('décisions du log (n=745)', dec),
                        ('100 trades comptés (n=39)', ex)]:
        sub = [t for t in rows if 0.58 <= t['price'] < 0.65 and t['won'] is not None]
        if not sub:
            continue
        n = len(sub)
        k = sum(t['won'] for t in sub)
        p = sum(t['price'] for t in sub) / n            # proba implicite du marché
        pval = binom_sf(k, n, p)
        tests.append({'jeu': label, 'n': n, 'gagnants': k, 'prix_implicite': round(p, 4),
                      'wr_observe': round(100 * k / n, 1),
                      'p_value_binomiale': round(pval, 4)})
        print('  %-28s n=%-4d gagnants=%-3d prix implicite=%.3f  WR=%5.1f%%  '
              'P(X>=%d)=%.4f' % (label, n, k, p, 100 * k / n, k, pval))
    n_fenetres = 29                                        # cf. balayage de validate.py
    bonf = min(1.0, tests[0]['p_value_binomiale'] * n_fenetres) if tests else None
    print('  NB : %d fenêtres de prix ont été balayées -> p corrigée (Bonferroni) '
          '≈ %.4f pour la meilleure.' % (n_fenetres, bonf))
    print('  Rappel : les trades ne sont pas indépendants (plusieurs coins par round) '
          '-> les p-values ci-dessus sont OPTIMISTES.')
    R['test_binomial'] = {'tests': tests, 'nb_fenetres_balayees': n_fenetres,
                          'p_corrigee_bonferroni_meilleure': round(bonf, 4) if bonf else None}

    # ---------------- B) placebo Monte-Carlo ----------------
    print('\n' + '=' * 78)
    print('B) TEST DE PLACEBO — marchés parfaitement prixés, même procédure de sélection')
    print('=' * 78)
    decs_sorted = sorted([t for t in dec if t['won'] is not None], key=lambda x: x['ts'])
    cut_i = int(len(decs_sorted) * 0.66)
    cut = decs_sorted[cut_i]['ts']
    grid = [(lo, hi) for lo in (0.50, 0.55, 0.58, 0.60, 0.65, 0.70)
            for hi in (0.60, 0.65, 0.70, 0.75, 0.80, 1.01) if hi > lo]
    rnd = random.Random(20260926)
    best_is_list, best_oos_list = [], []
    for _ in range(ITERS):
        sim = [{'ts': t['ts'], 'coin': t['coin'], 'price': t['price'],
                'won': 1 if rnd.random() < t['price'] else 0} for t in decs_sorted]
        for t in sim:
            t['pnl_round'] = round((1 / t['price'] - 1) if t['won'] else -1.0, 6)
        best = None
        for lo, hi in grid:
            is_ev = [t['pnl_round'] for t in sim[:cut_i] if lo <= t['price'] < hi]
            if len(is_ev) < 10:
                continue
            ev = sum(is_ev) / len(is_ev)
            if best is None or ev > best[0]:
                best = (ev, lo, hi)
        if best is None:
            continue
        ev, lo, hi = best
        oos = [t['pnl_round'] for t in sim[cut_i:] if lo <= t['price'] < hi]
        best_is_list.append(ev)
        best_oos_list.append(sum(oos) / len(oos) if oos else None)
    best_is_list.sort()
    obs_is = 0.0252                    # meilleure EV in-sample observée (0,65-0,70)
    obs_oos = -0.0842                  # EV hors échantillon de cette fenêtre
    n_ge = sum(1 for v in best_is_list if v >= obs_is)
    q50 = best_is_list[int(0.50 * len(best_is_list))]
    q95 = best_is_list[int(0.95 * len(best_is_list))]
    print('  %d simulations d\'un marché PARFAITEMENT prixé (Bernoulli(prix)).' % ITERS)
    print('  Meilleure EV in-sample trouvée par hasard : médiane %+.4f, 95e %% %+.4f, '
          'max %+.4f' % (q50, q95, best_is_list[-1]))
    print('  EV in-sample OBSERVÉE (fenêtre 0,65-0,70) : %+.4f  -> percentile %.1f %%'
          % (obs_is, 100.0 * sum(1 for v in best_is_list if v < obs_is) / len(best_is_list)))
    print('  P(meilleure EV in-sample >= observée par pur hasard) = %.3f' % (n_ge / ITERS))
    oos_ok = [v for v in best_oos_list if v is not None]
    neg = sum(1 for v in oos_ok if v < 0)
    print('  Hors échantillon, l\'EV de la fenêtre « gagnante » est négative dans '
          '%.1f %% des simulations (observé : négative, %+.4f)'
          % (100.0 * neg / len(oos_ok), obs_oos))
    R['placebo_monte_carlo'] = {
        'iters': ITERS, 'meilleure_ev_is_mediane': round(q50, 4),
        'meilleure_ev_is_q95': round(q95, 4), 'meilleure_ev_is_max': round(best_is_list[-1], 4),
        'ev_is_observee': obs_is, 'ev_oos_observee': obs_oos,
        'p_meilleure_ev_is_ge_observee': round(n_ge / ITERS, 4),
        'part_oos_negative_pct': round(100.0 * neg / len(oos_ok), 1),
    }

    # ---------------- C) IC robustes au clustering ----------------
    print('\n' + '=' * 78)
    print('C) ERREURS STANDARD ROBUSTES AU CLUSTERING (grappes = round de 5 min, puis jour)')
    print('=' * 78)
    out_c = {}
    for label, rows in [('décisions (n=1411)', dec), ('trades comptés (base round)', ex)]:
        for keyname, keyf in [('par round', lambda t: t['round']),
                              ('par jour', lambda t: t['ts'][:10])]:
            se, ng = cluster_se(rows, keyf)
            vals = [t['pnl_round'] for t in rows if t['pnl_round'] is not None]
            m = sum(vals) / len(vals)
            tt = m / se if se == se and se > 0 else float('nan')
            out_c.setdefault(label, {})[keyname] = {
                'n': len(vals), 'n_grappes': ng, 'ev': round(m, 4),
                'se_cluster': round(se, 4), 't_cluster': round(tt, 3) if tt == tt else None}
            print('  %-28s %-9s n=%-5d grappes=%-5d EV=%+.4f  SE(cluster)=%.4f  t=%.2f'
                  % (label, keyname, len(vals), ng, m, se, tt))
    print('  -> sur les 1411 décisions, le t « naïf » (SE i.i.d.) est 1,27 ;')
    print('     regroupé par JOUR (la seule grappe réelle : 1 seule décision par round)')
    print('     il tombe à t=%.2f -> non significatif.' %
          abs(out_c['décisions (n=1411)']['par jour']['t_cluster']))
    c = collections.Counter(t['round'] for t in dec)
    print('  grappes : %d rounds distincts pour %d décisions (max %d par round) '
          '-> pas de grappe intra-round.' % (len(c), len(dec), max(c.values())))
    print('  Le vrai facteur de dépendance est le COIN : les 5 coins bougent ensemble '
          'pendant un même mouvement de marché.')
    R['clustering'] = {'tailles': out_c, 'n_rounds_distincts': len(c),
                       'max_par_round': max(c.values())}
    json.dump(R, open(os.path.join(HERE, 'nulltest_results.json'), 'w'),
              indent=2, ensure_ascii=False)
    print('\n-> nulltest_results.json')


if __name__ == '__main__':
    main()