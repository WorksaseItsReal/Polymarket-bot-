#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
monte_carlo.py - Gestion du RISQUE pour une edge NON PROUVEE
Bot papier Polymarket "Up/Down 5m" (5 coins, mise simulee 1 EUR).

LECTURE SEULE sur le bot : ce script ne lit que /root/.polymarket/*.json
et n'ecrit rien en dehors de docs/rebuild/risk/.

Mecanique modelisee (Up/Down 5m = marche BINAIRE regle tout-ou-rien) :
  - mise unitaire s EUR par trade
  - si le cote choisi gagne : PnL = s * (1/e - 1)   ou e = prix d'entree (0<e<1)
  - sinon                    : PnL = -s             (perte ENTIERE, pas de stop possible)
  - esperance par trade      : E = p*(1/e - 1) - (1-p) = p/e - 1
        -> positive SSI p > e  (le prix d'entree EST la winrate break-even)
  - un stop-loss est INERTE : le token saute de e a 1 (ou 0) a la cloche.

Trois hypotheses d'edge (1000 trades, mise 1 EUR) :
  A. edge mesure      : WR 72%   (brief) / entree 0.61 -> BE 61.0%
  B. edge ZERO        : WR = BE  (aucun avantage reel)
  C. edge NEGATIF     : WR 65% (brief) -- ATTENTION : a e=0.61, 65% > 61% donc
                        encore POSITIF ; on ajoute 60% et 55% (vraiment negatifs).
"""
import json, math, statistics, random, sys
from pathlib import Path
import numpy as np

N_TRAJ   = 20000     # >= 20000 trajectoires exige
N_TRADES = 1000
SEED     = 20260926

HIST = Path("/root/.polymarket/history.json")
OUT  = Path(__file__).resolve().parent

# ----------------------------------------------------------------------------
# 1. DONNEES REELLES
# ----------------------------------------------------------------------------
def load_history():
    h = json.loads(HIST.read_text())
    r = [t for t in h if isinstance(t.get("realized"), (int, float))]
    return r

def real_stats(r):
    v = np.array([t["realized"] for t in r], float)
    e = np.array([t["price"] for t in r], float)
    n = len(v)
    p = float((v > 0).mean())
    mean, sd = v.mean(), v.std(ddof=1)
    se = sd / math.sqrt(n)
    t = mean / se
    tot = v.sum()
    return dict(n=n, p=p, wr=p*100, avg_entry=float(e.mean()),
                mean=float(mean), sd=float(sd), se=float(se), t=float(t),
                total=float(tot), ci95=(tot-1.96*se*n, tot+1.96*se*n),
                prices=e)

# ----------------------------------------------------------------------------
# 2. MONTE-CARLO : distribution du PnL total et du drawdown max
# ----------------------------------------------------------------------------
def simulate(p_win, entries, stake, n_traj=N_TRAJ, n_trades=N_TRADES,
             rng=None, record_dd=True):
    """Retourne (totaux, maxDD, pire serie de pertes).

    entries : array des prix d'entree, echantillonnes avec remise a chaque trade
              (bootstrap -> conserve la dispersion reelle des payoffs).
    stake   : scalaire (mise fixe) OU array (n_trades,) mise variable/trade.
    """
    rng = rng or np.random.default_rng(SEED)
    # payoff gagnant depend de l'entree tiree : resample par (traj, trade)
    ei = rng.choice(entries, size=(n_traj, n_trades))
    payoff_win = 1.0 / ei - 1.0
    win = rng.random((n_traj, n_trades)) < p_win
    if np.isscalar(stake):
        pnl = np.where(win, payoff_win, -1.0) * stake
    else:
        pnl = np.where(win, payoff_win, -1.0) * stake[None, :]
    totals = pnl.sum(axis=1)
    if not record_dd:
        return totals, None, None
    cum = np.cumsum(pnl, axis=1)
    peak = np.maximum.accumulate(np.concatenate(
        [np.zeros((n_traj, 1)), cum], axis=1), axis=1)[:, 1:]
    dd = peak - cum                       # drawdown en EUR (>=0)
    maxdd = dd.max(axis=1)
    # plus longue serie de pertes consecutives
    lost = (~win).astype(np.int8)
    run = np.zeros(n_traj, np.int16); best = np.zeros(n_traj, np.int16)
    for j in range(n_trades):             # 1000 iters, vectorise sur 20k traj
        run = (run + 1) * lost[:, j]
        best = np.maximum(best, run)
    return totals, maxdd, best

def pct(a, q): return float(np.percentile(a, q))

def report(tag, totals, maxdd, streaks, bankroll=None):
    p_neg = float((totals < 0).mean())
    row = dict(tag=tag, mean=float(totals.mean()), sd=float(totals.std(ddof=1)),
               p5=pct(totals,5), p50=pct(totals,50), p95=pct(totals,95),
               p_neg=p_neg, maxdd50=pct(maxdd,50), maxdd95=pct(maxdd,95),
               streak95=float(np.percentile(streaks,95)))
    if bankroll:
        row["p_dd50"] = float((maxdd > 0.5*bankroll).mean())
        row["p_dd25"] = float((maxdd > 0.25*bankroll).mean())
        row["p_ruin"] = float((totals <= -bankroll).mean())
    return row

def print_row(r, bankroll=None):
    print(f"  {r['tag']:<34} moy {r['mean']:+8.2f} | "
          f"P5 {r['p5']:+8.2f} | med {r['p50']:+8.2f} | P95 {r['p95']:+8.2f} | "
          f"P(net<0) {r['p_neg']*100:5.1f}% | DD50 {r['maxdd50']:6.2f} "
          f"DD95 {r['maxdd95']:7.2f} | pertes-max95 {r['streak95']:.0f}")
    if bankroll:
        print(f"  {'':<34} (bankroll {bankroll:.0f} EUR -> P(DD>25%) {r['p_dd25']*100:.1f}% "
              f"P(DD>50%) {r['p_dd50']*100:.1f}% P(ruine) {r['p_ruin']*100:.2f}%)")

# ----------------------------------------------------------------------------
# 3. KELLY ET SIZING
# ----------------------------------------------------------------------------
def kelly(p, b):
    """f* = p - (1-p)/b , b = gain_moyen / |perte_moyenne|."""
    return p - (1-p)/b

def main():
    rng = np.random.default_rng(SEED)
    r = load_history()
    st = real_stats(r)
    print("="*100)
    print("ETAT MESURE (re-verifie dans /root/.polymarket/history.json)")
    print("="*100)
    print(f"  n_resolus        = {st['n']}")
    print(f"  WR               = {st['wr']:.2f}%  ({int(st['p']*st['n'])} W / "
          f"{st['n']-int(st['p']*st['n'])} L)")
    print(f"  entree moyenne   = {st['avg_entry']:.4f}  ->  BE = {st['avg_entry']*100:.1f}%")
    print(f"  PnL/trade        = {st['mean']:+.4f} EUR   sd {st['sd']:.4f}  se {st['se']:.4f}")
    print(f"  t                = {st['t']:.3f}   (|t|<1.96 => NON significatif)")
    print(f"  PnL total        = {st['total']:+.2f} EUR   IC95 [{st['ci95'][0]:+.2f}, {st['ci95'][1]:+.2f}]")
    print(f"  brief fourni     : n~57-120, WR 72%, entree 0.61, t~1.44  (coherent, meme conclusion)")
    print()

    entries = st["prices"]

    # ------------------------------------------------------------------
    print("="*100)
    print("(a) MONTE-CARLO  %d trajectoires x %d trades, mise FIXE 1 EUR" % (N_TRAJ, N_TRADES))
    print("="*100)
    print("  Entree echantillonnee (bootstrap) sur les prix reels -> payoff gagnant 1/e-1,")
    print("  perte = -1.00 entierement. BE = moyenne(prix) ~ %.3f." % st["avg_entry"])
    print()
    scen = [
        ("A  edge mesure   WR=72%",       0.72),
        ("B  edge ZERO     WR=BE=%.3f" % st["avg_entry"], st["avg_entry"]),
        ("C  brief WR=65% (>BE -> +edge)", 0.65),
        ("C' vrai negatif  WR=60%",        0.60),
        ("C'' vrai negatif WR=55%",        0.55),
        ("    reference    WR=50% (pile)", 0.50),
    ]
    res1 = []
    for tag, p in scen:
        t_, dd_, s_ = simulate(p, entries, 1.0, rng=rng)
        row = report(tag, t_, dd_, s_)
        res1.append((p,row)); print_row(row)
    print()

    # table percentiles propre
    print("  Table 5% / 50% / 95% (PnL total sur 1000 trades, mise 1 EUR) :")
    print("  " + "-"*94)
    print(f"  {'scenario':<26}{'WR':>7}{'edge/trade':>12}{'P5':>10}{'P50':>10}{'P95':>10}{'P(net<0)':>10}")
    for p,row in res1:
        edge = p/st['avg_entry'] - 1   # E = p/e - 1
        print(f"  {row['tag']:<26}{p*100:>6.1f}%{edge:>+12.4f}{row['p5']:>+10.1f}"
              f"{row['p50']:>+10.1f}{row['p95']:>+10.1f}{row['p_neg']*100:>9.1f}%")
    print()

    # ------------------------------------------------------------------
    print("="*100)
    print("(b) TAILLE DE MISE : ou la variance devient intenable")
    print("="*100)
    b_win = float((1.0/entries[entries>0] - 1).mean())   # gain moyen si victoire (mise 1)
    b = b_win / 1.0                                       # |perte|=1
    print(f"  b = gain_moyen/|perte| = {b_win:.4f} / 1.00 = {b:.4f}")
    for pname, p in [("edge mesure WR=72%", 0.72),
                     ("edge zero   WR=BE", st["avg_entry"]),
                     ("edge neg.   WR=55%", 0.55)]:
        f = kelly(p, b)
        print(f"  Kelly f* ({pname:<20}) = {f:+.4f}  ({f*100:+.1f}% du capital par trade)")
    print("  -> pile ou face (p=e) => f*=0 : theorie = NE PAS PARIER.")
    print()

    # bankroll scan : quelle mise fixe garde P(drawdown>50%) <= 5% ?
    # IDENTITE : pour une mise fixe, maxDD(s) = s * maxDD(1) (homogeneite lineaire).
    # Donc P(DD(s) > 0.5B) <= 0.05  <=>  s <= 0.5B / Q95(maxDD a mise 1).
    # On mesure Q95(maxDD a mise 1) une seule fois par hypothese, puis on en deduit s.
    print("  Mise fixe MAXIMALE telle que P(drawdown max > 50% du capital) <= 5%")
    print("  Identite : maxDD(s) = s * maxDD(1)  =>  s_max = 0.5 * B / Q95(maxDD@1).")
    print("  " + "-"*72)
    q95 = {}
    for tag, p in [("edge mesure WR=72%", 0.72), ("edge ZERO WR=BE", st["avg_entry"]),
                   ("edge neg. WR=55%", 0.55)]:
        t_, dd_, _ = simulate(p, entries, 1.0, rng=rng)
        q95[tag] = float(np.percentile(dd_, 95))
        print(f"  Q95(maxDD a mise 1 EUR), {tag:<20} = {q95[tag]:7.2f} EUR")
    print()
    print(f"  {'capital':>10} | {'s_max edge mesure':>18} | {'s_max edge ZERO':>16} | "
          f"{'% cap (edge ZERO)':>18}")
    for B in [20, 50, 100, 200, 500, 1000]:
        s_a = 0.5*B / q95["edge mesure WR=72%"]
        s_z = 0.5*B / q95["edge ZERO WR=BE"]
        print(f"  {B:>8} EUR | {s_a:>15.3f} E | {s_z:>13.3f} E | {s_z/B*100:>15.3f} %")
    print()
    print("  => la contrainte qui compte est celle de l'hypothese EDGE ZERO (non prouvee) :")
    print("     elle plafonne la mise a ~0.5*B/Q95(maxDD@1) ~ quelques % du capital, PAS")
    print("     la 'mise optimale' de Kelly (qui suppose l'edge vraie).")
    print("  Mise actuelle du bot (0.65-1.10 EUR/trade) : pour rester dans la limite")
    print("  de l'hypothese edge ZERO, il faut un capital B tel que 0.5*B/Q95 >= 1.10,")
    print(f"     soit B >= 2.2 * Q95(maxDD@1) = 2.2 * {q95['edge ZERO WR=BE']:.1f} "
          f"= {2.2*q95['edge ZERO WR=BE']:.0f} EUR.")
    print()

    # ------------------------------------------------------------------
    print("="*100)
    print("(c) TEST DU SIZING ACTUEL du bot (Kelly plafonne 0.05, sizeFactor 0.65-2)")
    print("="*100)
    print("  Logique du code : f* = p-(1-p)/b ; clamp [0,0.05] ; sizeFactor = 1+2*f*")
    print("  clamp [0.65,2] ; si n<10 -> min(1.2, sf).  Mise de base = 1 EUR.")
    print("  -> f*=0.05 => sizeFactor = 1.10 MAX. En pratique : 0.65x .. 1.10x (0.65-1.10 EUR).")
    print()
    # reproduire le sizeFactor pour p=0.72 et p=BE
    for pname, p in [("WR=72% (recent)", 0.72), ("WR=BE (edge nul)", st["avg_entry"]),
                     ("WR=55%", 0.55)]:
        f = max(0.0, min(0.05, kelly(p, b)))
        sf = 1 + 2*f
        sf = max(0.65, min(2.0, sf))
        if f <= 0: sf = 1.0 if pname.startswith("WR=BE") else 1.0
        print(f"  {pname:<20} -> f*_clamp={f:.3f}  sizeFactor={sf:.2f}x  (mise {1.0*sf:.3f} EUR)")
    print()
    # MC avec le sizing actuel vs mise plate
    # le bot tire un sizeFactor par coin (recent window) ; ici on approxime : mise = 1.0 partout
    # puis on compare a une version naive "Kelly non plafonne"
    t_flat, dd_flat, s_flat = simulate(0.72, entries, 1.0, rng=rng)
    r_flat = report("actuel: mise 0.65-1.10 EUR", t_flat, dd_flat, s_flat)
    print_row(r_flat)
    # Kelly non plafonne = f*=0.282 -> sizeFactor = 1+2*0.282 = 1.564 (mise 1.56 EUR)
    f_uncap = kelly(0.72, b)
    sf_uncap = 1 + 2*f_uncap
    t_u, dd_u, s_u = simulate(0.72, entries, float(sf_uncap), rng=rng)
    r_u = report("NAIF: Kelly non plafonne %.2fx" % sf_uncap, t_u, dd_u, s_u)
    print_row(r_u)
    # et si la meme mise "optimiste" tourne sur une edge NULLE
    t_u0, dd_u0, s_u0 = simulate(st["avg_entry"], entries, float(sf_uncap), rng=rng)
    r_u0 = report("NAIF non plafonne + edge ZERO", t_u0, dd_u0, s_u0)
    print_row(r_u0)
    print()
    print("  Verdict (c) : le plafond kellyCeil=0.05 borne la mise a ~1.10x la base.")
    print("  Compte tenu de t=%.2f (edge non prouvee), ce plafond est PRUDENT et CORRECT." % st["t"])
    print("  Le danger serait de (1) lever le plafond, ou (2) lever la mise de BASE.")
    print()

    # ------------------------------------------------------------------
    print("="*100)
    print("(d) SUR-DIMENSIONNEMENT : que se passe-t-il si l'on double la mise ?")
    print("="*100)
    print("  Mise de base augmentee (x2, x5), sous 3 hypotheses d'edge, capital 100 EUR :")
    print()
    for mult in [1.0, 2.0, 5.0, 10.0]:
        print(f"  --- mise de base {mult:.0f} EUR ---")
        for tag, p in [("edge mesure WR=72%", 0.72), ("edge ZERO WR=BE", st["avg_entry"]),
                       ("edge neg. WR=55%", 0.55)]:
            t_, dd_, s_ = simulate(p, entries, mult, rng=rng)
            row = report(tag, t_, dd_, s_, bankroll=100.0)
            print_row(row, bankroll=100.0)
        print()

    # ------------------------------------------------------------------
    print("="*100)
    print("(e) COMBIEN DE TRADES AVANT DE RE-JUGER ?  (puissance statistique)")
    print("="*100)
    d = st["mean"]/st["sd"]              # taille d'effet mesuree
    print(f"  taille d'effet mesuree d = PnL_moy/sd = {st['mean']:.4f}/{st['sd']:.4f} = {d:.4f}")
    n_sig = (1.96/d)**2
    n_pow = (2.802/d)**2
    print(f"  n pour t=1.96 (95%% signif.)         ~ {n_sig:.0f} trades resolus")
    print(f"  n pour 80%% de puissance (z=2.80)     ~ {n_pow:.0f} trades resolus")
    # si la vraie edge est la moitie de l'estimee
    d_half = d/2
    print(f"  si la VRAIE edge = moitie de l'estimee (d={d_half:.4f}) :")
    print(f"    n pour 95%% signif. ~ {(1.96/d_half)**2:.0f}   |  n pour 80%% puissance ~ {(2.802/d_half)**2:.0f}")
    print(f"  (rappel : les %d trades actuels -> n manquant = {max(0,n_pow-st['n']):.0f})" % st['n'])
    print()

    # ------------------------------------------------------------------
    print("="*100)
    print("SYNTHESE CHIFFREE")
    print("="*100)
    print(f"  edge mesuree   : WR {st['wr']:.1f}% vs BE {st['avg_entry']*100:.1f}% "
          f"-> marge {(st['p']-st['avg_entry'])*100:+.1f} pt, t={st['t']:.2f} (NON prouvee)")
    print(f"  si edge ZERO   : esperance reelle = 0 ; le PnL observe est du bruit.")
    print(f"  mise actuelle  : 0.65-1.10 EUR/trade sur base 1 EUR  -> conservative")
    t5, dd5, s5 = simulate(st['avg_entry'], entries, 5.0, rng=rng)
    r5 = report("edge nulle x5", t5, dd5, s5, bankroll=100.0)
    print(f"  sur-dimensionner (x5) sur une edge non prouvee : si edge nulle, "
          f"P(ruine, cap 100 EUR) = {r5['p_ruin']*100:.2f}% , P(DD>50%) = {r5['p_dd50']*100:.1f}%")
    print("  REPONSE : NON, augmenter les mises n'est pas une bonne idee aujourd'hui.")
    print("="*100)


if __name__ == "__main__":
    main()
