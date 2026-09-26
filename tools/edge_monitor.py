#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
edge_monitor.py — Surveillance statistique HONNÊTE du paperbot Polymarket « Up or Down 5m ».

Objet : dire la vérité sur l'edge du bot à partir des données réelles. Ce script n'est PAS
un outil de motivation : il est conçu pour NE PAS flatter, et pour déclarer « NON significatif »
tant que les données ne permettent pas de rejeter l'hypothèse « edge = zéro ».

Ce qu'il calcule (à partir de /root/.polymarket/history.json) :
  (a) n, win rate, PnL moyen/trade, écart-type, erreur-type, t-statistique, IC95 du total,
      et n requis pour |t| > 2 au vu de la variance mesurée ;
  (b) verdict EXPLICITE : « significatif » UNIQUEMENT si |t| dépasse À LA FOIS 1,96 ET le seuil
      de Bonferroni corrigé du nombre de tests réellement effectués ; sinon
      « NON significatif (bruit) » + probabilité de faux positif ;
  (c) WR break-even réelle = 1/(1+b), b = gain moyen / |perte moyenne| ;
  (d) les trades `realized == 0` sont EN ATTENTE : exclus des statistiques (jamais gagnés ni perdus) ;
  (e) évaluation d'un KILL-SWITCH chiffré (t sous borne négative) + alerte de drawdown maximal ;
  (f) découpage par coin et par tranche de prix d'entrée.

Lecture seule. N'écrit JAMAIS dans /root/.polymarket/. Lançable en cron (`--json` pour un
consommateur machine).

Usage :
    python3 tools/edge_monitor.py
    python3 tools/edge_monitor.py --json
    python3 tools/edge_monitor.py --json --exit-on-kill    # code 2 si kill-switch déclenché

Dépendances : Python 3 stdlib uniquement.
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Valeurs par défaut (chemin réel du bot vivant — LECTURE SEULE)
# ---------------------------------------------------------------------------
DEF_HISTORY = "/root/.polymarket/history.json"
DEF_CUMULATIVE = "/root/.polymarket/cumulative.json"
DEF_PNL = "/root/.polymarket/pnl.json"

# Tranches de prix d'entrée (identiques à EDGE.md pour comparabilité)
BUCKETS = [
    ("<0.55", lambda p: p < 0.55),
    ("0.55-0.60", lambda p: 0.55 <= p < 0.60),
    ("0.60-0.65", lambda p: 0.60 <= p < 0.65),
    ("0.65-0.70", lambda p: 0.65 <= p < 0.70),
    ("0.70-0.75", lambda p: 0.70 <= p < 0.75),
    ("0.75+", lambda p: p >= 0.75),
]

# --- Seuils de kill-switch / alerte (chiffrés, défendables) ---
# t-statistique (sur l'ensemble résolu) sous lequel on considère l'edge comme prouvée négative.
DEF_KILL_T = -2.0      # |t|>2 du mauvais côté -> edge négative significative -> STOP
DEF_WARN_T = -1.0      # zone de vigilance (pas encore significatif)
# Drawdown maximal de la courbe de PnL, exprimé en « mises » (= 1 unité = 1 € de mise unitaire).
DEF_DD_WARN = 15.0     # 15 mises de drawdown -> alerte
DEF_DD_KILL = 25.0     # 25 mises -> STOP (cf. RISK.md : Q95 maxDD edge zéro ≈ 51 mises)
# Séries de pertes consécutives
DEF_CONSEC_LOSS_WARN = 6
DEF_CONSEC_LOSS_KILL = 8


# ---------------------------------------------------------------------------
# Statistique normale (stdlib : pas de scipy)
# ---------------------------------------------------------------------------
def norm_cdf(x):
    """Fonction de répartition de la loi normale centrée réduite."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_ppf(p):
    """Inverse de la CDF normale (Acklam, précision ~1e-9)."""
    if p <= 0.0 or p >= 1.0:
        raise ValueError("norm_ppf: p doit être dans (0,1)")
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
    if p <= phigh:
        q = p - 0.5
        r = q * q
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
               (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    q = math.sqrt(-2 * math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)


def two_sided_p(t):
    """p-value bilatérale associée à |t|."""
    return 2.0 * (1.0 - norm_cdf(abs(t)))


# ---------------------------------------------------------------------------
# Chargement des données (lecture seule, tolérant)
# ---------------------------------------------------------------------------
def load_json(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception as e:  # fichier en cours d'écriture par le bot vivant
        sys.stderr.write("[edge_monitor] WARN: lecture impossible %s (%s)\n" % (path, e))
        return None


def stake_of(entry):
    s = entry.get("stake", 1)
    try:
        s = float(s)
    except (TypeError, ValueError):
        s = 1.0
    return s if s > 0 else 1.0


def build_trades(history, raw_stake=False):
    """Transforme history.json en liste de trades résolus normalisés (mise unitaire = 1 €).

    Chaque trade : dict(roundId, coin, side, price, pnl, won, ts)
    - pnl = realized / stake  (donc « PnL pour une mise de 1 € »)  [ou realized brut si raw_stake]
    - realized == 0 (ou absent) => EN ATTENTE : jamais gagné ni perdu -> EXCLU.
    """
    resolved, pending = [], []
    for e in history:
        r = e.get("realized", None)
        if r is None:
            pending.append(e)
            continue
        try:
            r = float(r)
        except (TypeError, ValueError):
            pending.append(e)
            continue
        if r == 0.0:
            pending.append(e)   # trade EN ATTENTE : ne jamais le compter
            continue
        s = stake_of(e) if not raw_stake else 1.0
        pnl = r if raw_stake else (r / s)
        resolved.append({
            "roundId": e.get("roundId"),
            "coin": e.get("coin", "?"),
            "side": e.get("side", "?"),
            "price": float(e.get("price", 0.0)),
            "pnl": pnl,
            "won": r > 0,
            "ts": e.get("ts", ""),
        })
    resolved.sort(key=lambda t: t["ts"] or "")
    return resolved, pending


# ---------------------------------------------------------------------------
# Statistiques d'un échantillon de PnL
# ---------------------------------------------------------------------------
def stats_of(pnls, target_t=2.0, bonferroni_crit=None):
    n = len(pnls)
    out = {"n": n}
    if n == 0:
        out.update(win_rate=None, mean=None, sd=None, se=None, t=None,
                   total=None, ci95_total=None, ci95_mean=None,
                   n_required_target=None, n_required_bonferroni=None)
        return out
    wins = sum(1 for x in pnls if x > 0)
    losses = n - wins
    mean = sum(pnls) / n
    var = sum((x - mean) ** 2 for x in pnls) / (n - 1) if n > 1 else 0.0
    sd = math.sqrt(var)
    se = sd / math.sqrt(n) if n > 0 else None
    total = sum(pnls)
    t = (mean / se) if (se and se > 0) else None
    ci95_total = None
    if sd > 0 and n > 1:
        half = 1.96 * sd * math.sqrt(n)   # SE de la somme = sd*sqrt(n)
        ci95_total = [total - half, total + half]
    ci95_mean = None
    if se and se > 0:
        ci95_mean = [mean - 1.96 * se, mean + 1.96 * se]

    def n_req(target):
        if mean is None or sd is None or mean <= 0 or target <= 0:
            return None   # µ<=0 : il faudrait une infinité de trades (aucun edge à prouver)
        return (target * sd / mean) ** 2

    out.update(
        wins=wins, losses=losses,
        win_rate=wins / n,
        mean=mean, sd=sd, se=se, t=t, total=total,
        ci95_total=ci95_total, ci95_mean=ci95_mean,
        n_required_target=n_req(target_t),
        n_required_bonferroni=n_req(bonferroni_crit) if bonferroni_crit else None,
    )
    return out


def breakeven_wr(pnls):
    """WR break-even réelle = 1/(1+b), b = gain_moyen / |perte_moyenne|."""
    gains = [x for x in pnls if x > 0]
    losses = [-x for x in pnls if x < 0]
    if not gains or not losses:
        return {"b": None, "be_wr": None, "mean_gain": None, "mean_loss": None}
    mg = sum(gains) / len(gains)
    ml = sum(losses) / len(losses)
    b = mg / ml if ml > 0 else None
    be = (1.0 / (1.0 + b)) if b is not None else None
    return {"b": b, "be_wr": be, "mean_gain": mg, "mean_loss": ml}


def drawdown_stats(trades):
    """Drawdown max de la courbe de PnL cumulé (en unités de mise) + séries de pertes."""
    cum = 0.0
    peak = 0.0
    max_dd = 0.0
    cur_loss_streak = 0
    max_loss_streak = 0
    dd_series = []
    for t in trades:
        cum += t["pnl"]
        if cum > peak:
            peak = cum
        dd = peak - cum
        dd_series.append(dd)
        if dd > max_dd:
            max_dd = dd
        if t["pnl"] < 0:
            cur_loss_streak += 1
            max_loss_streak = max(max_loss_streak, cur_loss_streak)
        else:
            cur_loss_streak = 0
    return {"max_dd": max_dd, "current_dd": dd_series[-1] if dd_series else 0.0,
            "max_consec_losses": max_loss_streak, "final_cum": cum}


# ---------------------------------------------------------------------------
# Rendu texte
# ---------------------------------------------------------------------------
def pct(x):
    return "n/a" if x is None else "%.1f%%" % (100.0 * x)


def money(x):
    return "n/a" if x is None else "%+.4f" % x


def fmt_n(x):
    if x is None:
        return "∞ (µ≤0 : aucun edge à prouver)"
    return "%d" % math.ceil(x)


def group_block(title, trades, keyfn, label_header, target_t, bonf, min_n):
    lines = []
    lines.append(title)
    lines.append("%-10s %5s %7s %7s %9s %8s %7s %7s %9s %19s  %s" % (
        label_header, "n", "WR", "BE_WR", "mean€", "sd", "se", "t", "total€",
        "IC95 total", "verdict"))
    groups = {}
    for t in trades:
        groups.setdefault(keyfn(t), []).append(t)
    for label in sorted(groups.keys(), key=lambda k: str(k)):
        tr = groups[label]
        pnls = [x["pnl"] for x in tr]
        st = stats_of(pnls, target_t=target_t, bonferroni_crit=bonf)
        be = breakeven_wr(pnls)
        if st["n"] < min_n:
            verdict = "n<%d (non testé)" % min_n
        elif st["t"] is None:
            verdict = "non calculable"
        elif abs(st["t"]) > 1.96 and abs(st["t"]) > bonf:
            verdict = "SIGNIFICATIF"
        else:
            verdict = "NON significatif (bruit)"
        ci = "n/a"
        if st["ci95_total"]:
            ci = "[%+.2f, %+.2f]" % (st["ci95_total"][0], st["ci95_total"][1])
        lines.append("%-10s %5d %7s %7s %9s %8s %7s %7s %9s %19s  %s" % (
            str(label), st["n"], pct(st["win_rate"]),
            pct(be["be_wr"]) if be["be_wr"] is not None else "n/a",
            money(st["mean"]) if st["mean"] is not None else "n/a",
            "%.4f" % st["sd"] if st["sd"] is not None else "n/a",
            "%.4f" % st["se"] if st["se"] is not None else "n/a",
            "%+.2f" % st["t"] if st["t"] is not None else "n/a",
            money(st["total"]) if st["total"] is not None else "n/a",
            ci, verdict))
    return "\n".join(lines)


def render_text(res, trades):
    g = res["global"]
    be = res["breakeven"]
    dd = res["drawdown"]
    lines = []
    lines.append("=" * 78)
    lines.append("EDGE_MONITOR — surveillance statistique du paperbot Polymarket Up/Down 5m")
    lines.append("=" * 78)
    lines.append("Généré : %s" % res["generated_at"])
    lines.append("Source trades : %s" % res["history_path"])
    lines.append("Échantillon : %d trades RÉSOLUS | %d EN ATTENTE (realized==0, exclus) | %d entrées totales"
                 % (g["n"], res["pending"], res["entries"]))
    lines.append("Unité de PnL : %s" % (
        "réalisé BRUT (mises réelles)" if res["raw_stake"]
        else "pour une mise de 1 € (realized/stake)"))
    lines.append("")

    # --- (a) statistiques ---
    lines.append("(a) STATISTIQUES GLOBALES")
    lines.append("  n (résolus)          : %d  (%d gains / %d pertes)" % (g["n"], g["wins"], g["losses"]))
    lines.append("  Win rate observé     : %s" % pct(g["win_rate"]))
    lines.append("  PnL moyen / trade    : %s" % money(g["mean"]))
    lines.append("  Écart-type (sd)      : %s" % ("%.4f" % g["sd"] if g["sd"] is not None else "n/a"))
    lines.append("  Erreur-type (se)     : %s" % ("%.4f" % g["se"] if g["se"] is not None else "n/a"))
    lines.append("  t-statistique        : %s" % ("%+.3f" % g["t"] if g["t"] is not None else "n/a"))
    lines.append("  PnL total observé    : %s" % money(g["total"]))
    if g["ci95_total"]:
        lines.append("  IC95 du PnL TOTAL    : [%+.2f €, %+.2f €]" % (g["ci95_total"][0], g["ci95_total"][1]))
    if g["ci95_mean"]:
        lines.append("  IC95 du PnL/trade    : [%+.4f, %+.4f]" % (g["ci95_mean"][0], g["ci95_mean"][1]))
    lines.append("  n requis pour |t|>%.2f (variance mesurée) : %s"
                 % (res["target_t"], fmt_n(g["n_required_target"])))
    lines.append("  n requis pour |t|>%.2f (Bonferroni)        : %s"
                 % (res["bonferroni_crit"], fmt_n(g["n_required_bonferroni"])))
    lines.append("")

    # --- (b) verdict ---
    lines.append("(b) VERDICT")
    lines.append("  Tests effectués (m)      : %d  (global + %d coins + %d tranches testés)"
                 % (res["n_tests"], res["n_coin_tests"], res["n_bucket_tests"]))
    lines.append("  Seuil standard (95%%)    : |t| > 1.96")
    lines.append("  Seuil Bonferroni (m=%d) : |t| > %.3f" % (res["n_tests"], res["bonferroni_crit"]))
    lines.append("  p-value bilatérale       : %s" % (
        "%.4f" % g["p_value"] if g["p_value"] is not None else "n/a"))
    if g["p_value"] is not None:
        fw = 1.0 - (1.0 - g["p_value"]) ** res["n_tests"]
        lines.append("  P(faux positif, 1 test)  : %s" % ("%.2f%%" % (100.0 * g["p_value"])))
        lines.append("  P(≥1 faux positif sur m) : %s  (correction family-wise)" % ("%.2f%%" % (100.0 * fw)))
        lines.append("  Faux positifs attendus à |t|>2 sous H0 : %.2f sur %d tests"
                     % (res["n_tests"] * two_sided_p(2.0), res["n_tests"]))
    lines.append("")
    if g["verdict"] == "SIGNIFICATIF":
        lines.append("  >>> VERDICT : SIGNIFICATIF <<<")
    else:
        lines.append("  >>> VERDICT : NON SIGNIFICATIF (BRUIT) <<<")
    lines.append("  %s" % g["verdict_reason"])
    lines.append("")

    # --- (c) break-even ---
    lines.append("(c) WR BREAK-EVEN RÉELLE  (1/(1+b), b = gain moyen / |perte moyenne|)")
    if be["b"] is not None:
        lines.append("  gain moyen (gagnants) : %+.4f" % be["mean_gain"])
        lines.append("  perte moyenne (perdants) : %.4f" % be["mean_loss"])
        lines.append("  b = gain/perte        : %.4f" % be["b"])
        lines.append("  WR break-even         : %s" % pct(be["be_wr"]))
        lines.append("  WR observé            : %s" % pct(g["win_rate"]))
        edge_pp = (g["win_rate"] - be["be_wr"]) * 100.0
        lines.append("  Marge (WR - BE)       : %+.2f points" % edge_pp)
        lines.append("  Verdict break-even    : %s" % (
            "AU-DESSUS du seuil MAIS non significatif (cf. (b))"
            if edge_pp > 0 and g["verdict"] != "SIGNIFICATIF"
            else ("SOUS le seuil d'équilibre (perdant en espérance)"
                  if edge_pp < 0 else "exactement à l'équilibre")))
    else:
        lines.append("  non calculable (pas de gagnant OU pas de perdant dans l'échantillon)")
    lines.append("")

    # --- (e) risques ---
    lines.append("(e) KILL-SWITCH & DRAWDOWN")
    lines.append("  Drawdown max (courbe PnL) : %.2f € (= %.2f mises)" % (dd["max_dd"], dd["max_dd"]))
    lines.append("  Drawdown courant          : %.2f €" % dd["current_dd"])
    lines.append("  Plus longue série de pertes : %d" % dd["max_consec_losses"])
    lines.append("  PnL cumulé final          : %+.2f €" % dd["final_cum"])
    lines.append("  Seuils : kill t ≤ %.2f | warn t ≤ %.2f | DD kill ≥ %.1f€ | DD warn ≥ %.1f€"
                 % (res["kill_t"], res["warn_t"], res["dd_kill"], res["dd_warn"]))
    lines.append("  Séries : kill ≥ %d pertes consécutives | warn ≥ %d"
                 % (res["consec_kill"], res["consec_warn"]))
    ks = res["killswitch"]
    lines.append("  ÉTAT KILL-SWITCH : %s" % ks["state"])
    for r in ks["reasons"]:
        lines.append("      - %s" % r)
    lines.append("")

    # --- (f) découpage ---
    lines.append("(f) DÉCOUPAGE")
    lines.append("")
    lines.append(group_block("  (f1) PAR COIN", trades, lambda t: t["coin"], "coin",
                             res["target_t"], res["bonferroni_crit"], res["min_n"]))
    lines.append("")
    def bucket_of(t):
        for name, fn in BUCKETS:
            if fn(t["price"]):
                return name
        return "?"
    lines.append(group_block("  (f2) PAR TRANCHE DE PRIX D'ENTRÉE", trades, bucket_of, "tranche",
                             res["target_t"], res["bonferroni_crit"], res["min_n"]))
    lines.append("")

    # --- provenance / caveats ---
    lines.append("(g) PROVENANCE & MISES EN GARDE")
    for c in res["caveats"]:
        lines.append("  - %s" % c)
    lines.append("=" * 78)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Cœur
# ---------------------------------------------------------------------------
def analyze(args):
    history = load_json(args.history)
    if history is None:
        sys.stderr.write("[edge_monitor] ERREUR: history introuvable ou illisible: %s\n" % args.history)
        sys.exit(1)
    if not isinstance(history, list):
        sys.stderr.write("[edge_monitor] ERREUR: format history.json inattendu (liste attendue)\n")
        sys.exit(1)

    cumulative = load_json(args.cumulative)
    pnl_file = load_json(args.pnl)

    trades, pending = build_trades(history, raw_stake=args.raw_stake)
    pnls = [t["pnl"] for t in trades]

    # (f) groupes -> déterminer le nombre réel de tests pour Bonferroni
    coins = sorted({t["coin"] for t in trades})
    nbuckets = sorted({bucket for bucket in
                       [next((nm for nm, fn in BUCKETS if fn(t["price"])), "?") for t in trades]})
    n_coin_tests = sum(1 for c in coins
                       if sum(1 for t in trades if t["coin"] == c) >= args.min_n)
    n_bucket_tests = sum(1 for b in nbuckets
                         if sum(1 for t in trades
                                if next((nm for nm, fn in BUCKETS if fn(t["price"])), "?") == b) >= args.min_n)
    n_tests = 1 + n_coin_tests + n_bucket_tests  # global + sous-groupes testés
    bonf = norm_ppf(1.0 - args.alpha / (2.0 * n_tests))

    g = stats_of(pnls, target_t=args.target_t, bonferroni_crit=bonf)
    g["p_value"] = two_sided_p(g["t"]) if g["t"] is not None else None

    # verdict (b)
    if g["t"] is None:
        g["verdict"] = "NON SIGNIFICATIF"
        g["verdict_reason"] = "t non calculable (variance nulle ou n<2)."
    elif abs(g["t"]) > 1.96 and abs(g["t"]) > bonf:
        g["verdict"] = "SIGNIFICATIF"
        g["verdict_reason"] = ("|t|=%.3f dépasse 1.96 ET le seuil Bonferroni %.3f." % (abs(g["t"]), bonf))
    else:
        g["verdict"] = "NON SIGNIFICATIF"
        if abs(g["t"]) <= 1.96 and abs(g["t"]) <= bonf:
            why = "|t|=%.3f ≤ 1.96 ET ≤ Bonferroni %.3f" % (abs(g["t"]), bonf)
        elif abs(g["t"]) <= 1.96:
            why = "|t|=%.3f ≤ 1.96" % abs(g["t"])
        else:
            why = "|t|=%.3f > 1.96 MAIS ≤ Bonferroni %.3f (multiple-comparaisons)" % (abs(g["t"]), bonf)
        pv = g["p_value"]
        g["verdict_reason"] = ("%s : l'hypothèse « edge = zéro » N'EST PAS rejetée. "
                               "P(faux positif à ce |t|, 1 test) = %.1f%%." % (why, 100.0 * pv) if pv is not None else why + ".")

    be = breakeven_wr(pnls)
    dd = drawdown_stats(trades)

    # (e) kill-switch
    reasons = []
    if g["t"] is not None and g["t"] <= args.kill_t:
        reasons.append("t = %+.2f ≤ %.2f : edge NÉGATIVE significative -> arrêt." % (g["t"], args.kill_t))
    elif g["t"] is not None and g["t"] <= args.warn_t:
        reasons.append("t = %+.2f ≤ %.2f : zone de vigilance (pas encore significatif)." % (g["t"], args.warn_t))
    if dd["max_dd"] >= args.dd_kill:
        reasons.append("drawdown max %.1f € ≥ %.1f € : arrêt." % (dd["max_dd"], args.dd_kill))
    elif dd["max_dd"] >= args.dd_warn:
        reasons.append("drawdown max %.1f € ≥ %.1f € : alerte." % (dd["max_dd"], args.dd_warn))
    if dd["max_consec_losses"] >= args.consec_kill:
        reasons.append("%d pertes consécutives ≥ %d : arrêt." % (dd["max_consec_losses"], args.consec_kill))
    elif dd["max_consec_losses"] >= args.consec_warn:
        reasons.append("%d pertes consécutives ≥ %d : alerte." % (dd["max_consec_losses"], args.consec_warn))
    kill_hit = any(("arrêt" in r) for r in reasons)
    if kill_hit:
        state = "DÉCLENCHÉ (arrêt recommandé)"
    elif reasons:
        state = "VIGILANCE (alertes actives, pas d'arrêt)"
    else:
        state = "OK (aucun seuil franchi)"
    if not reasons:
        reasons = ["aucun seuil franchi."]

    caveats = []
    caveats.append("history.json est un fichier VIVANT écrit par le bot : n et chiffres bougent à chaque résolution.")
    caveats.append("Les trades `realized == 0` sont EN ATTENTE et exclus (%d ici) : ni gagnés ni perdus." % len(pending))
    if not args.raw_stake:
        caveats.append("PnL normalisé par `stake` (mise de 1 €) pour rendre les trades comparables "
                       "(%d trades avec stake≠1 dans l'échantillon)." % sum(1 for e in history if abs(stake_of(e) - 1.0) > 1e-9))
    else:
        caveats.append("PnL brut (mises réelles) : les trades à stake≠1 pèsent plus lourd.")
    caveats.append("Le champ `realized` a historiquement porté un bug de résolution (documenté dans "
                   "cumulative.json / EDGE.md), corrigé le 2026-09-25. Les trades antérieurs restent à interpréter avec prudence.")
    caveats.append("Tester %d sous-groupes gonfle le risque de faux positif : c'est pourquoi le seuil "
                   "Bonferroni (m=%d -> |t|>%.3f) est exigé en plus de 1.96." % (n_tests - 1, n_tests, bonf))
    if cumulative and isinstance(cumulative, dict):
        caveats.append("cumulative.json (agrégat officiel du bot) : pnl=%.4f, resolved=%s, total_trades=%s, "
                       "wins=%s, losses=%s — échantillon cumulé PLUS LARGE que history.json."
                       % (cumulative.get("pnl", float("nan")), cumulative.get("resolved") if not isinstance(cumulative.get("resolved"), dict) else len(cumulative["resolved"]),
                          cumulative.get("total_trades"), cumulative.get("wins"), cumulative.get("losses")))
    if pnl_file and isinstance(pnl_file, dict):
        caveats.append("pnl.json : trades=%s wins=%s losses=%s wr=%s pnl=%s pending=%s."
                       % (pnl_file.get("trades"), pnl_file.get("wins"), pnl_file.get("losses"),
                          pnl_file.get("win_rate"), pnl_file.get("pnl"), pnl_file.get("pending")))

    res = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "history_path": args.history,
        "entries": len(history),
        "pending": len(pending),
        "raw_stake": args.raw_stake,
        "alpha": args.alpha,
        "target_t": args.target_t,
        "kill_t": args.kill_t, "warn_t": args.warn_t,
        "dd_warn": args.dd_warn, "dd_kill": args.dd_kill,
        "consec_warn": args.consec_warn, "consec_kill": args.consec_kill,
        "min_n": args.min_n,
        "n_tests": n_tests, "n_coin_tests": n_coin_tests, "n_bucket_tests": n_bucket_tests,
        "bonferroni_crit": bonf,
        "global": g,
        "breakeven": be,
        "drawdown": dd,
        "killswitch": {"state": state, "triggered": kill_hit, "reasons": reasons},
        "caveats": caveats,
    }

    # sous-groupes pour --json
    def grp(keyfn):
        out = {}
        for t in trades:
            out.setdefault(keyfn(t), []).append(t)
        b = {}
        for label, tr in out.items():
            p = [x["pnl"] for x in tr]
            st = stats_of(p, target_t=args.target_t, bonferroni_crit=bonf)
            st["breakeven"] = breakeven_wr(p)
            b[label] = st
        return b
    res["by_coin"] = grp(lambda t: t["coin"])
    res["by_price_bucket"] = grp(lambda t: next((nm for nm, fn in BUCKETS if fn(t["price"])), "?"))

    return res, trades


def main():
    ap = argparse.ArgumentParser(description="Surveillance statistique honnête du paperbot Polymarket.")
    ap.add_argument("--history", default=DEF_HISTORY)
    ap.add_argument("--cumulative", default=DEF_CUMULATIVE)
    ap.add_argument("--pnl", default=DEF_PNL)
    ap.add_argument("--json", action="store_true", help="sortie machine (JSON)")
    ap.add_argument("--raw-stake", action="store_true", help="utiliser realized brut (mises réelles) au lieu de normalized (1€)")
    ap.add_argument("--alpha", type=float, default=0.05, help="risque de famille (défaut 0.05)")
    ap.add_argument("--target-t", type=float, default=2.0, help="|t| cible pour n_requis (défaut 2.0)")
    ap.add_argument("--min-n", type=int, default=5, help="n minimal pour tester un sous-groupe (défaut 5)")
    ap.add_argument("--kill-t", type=float, default=DEF_KILL_T)
    ap.add_argument("--warn-t", type=float, default=DEF_WARN_T)
    ap.add_argument("--dd-warn", type=float, default=DEF_DD_WARN)
    ap.add_argument("--dd-kill", type=float, default=DEF_DD_KILL)
    ap.add_argument("--consec-loss-warn", dest="consec_warn", type=int, default=DEF_CONSEC_LOSS_WARN)
    ap.add_argument("--consec-loss-kill", dest="consec_kill", type=int, default=DEF_CONSEC_LOSS_KILL)
    ap.add_argument("--exit-on-kill", action="store_true",
                    help="code de sortie 2 si le kill-switch est déclenché (sinon 0)")
    args = ap.parse_args()

    res, trades = analyze(args)

    if args.json:
        print(json.dumps(res, indent=2, ensure_ascii=False, default=str))
    else:
        print(render_text(res, trades))

    if args.exit_on_kill and res["killswitch"]["triggered"]:
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
