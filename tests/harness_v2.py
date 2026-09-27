#!/usr/bin/env python3
"""Harnais de test — SECONDE GÉNÉRATION (ajouté, ne remplace pas harness_recap.py).

Exerce des fonctions RÉELLES supplémentaires de paperbot-recap.py et
paperbot-pnl.py, par import de chemin, sans jamais copier ni modifier les
sources. Comble trois trous de la première mouture :

  1. ROBUSTESSE DU PARSING — parse_log() sur un log vide / tronqué / corrompu /
     absent / non-UTF8 ; edge_stats() sur des JSON vides, absents ou corrompus ;
     main() de paperbot-pnl.py sur un history.json tronqué, vide, ou dont une
     entrée n'est pas un objet.
  2. FRAÎCHEUR — fmt_live() : une mesure ABSENTE doit être rendue « n/a », jamais
     remplacée par une valeur par défaut maquillée en mesure.
  3. SUPPORT DES CONTRÔLES NÉGATIFS — rien ici : le contrôle négatif est fait
     côté TypeScript (tests/fixtures/), pour prouver que le runner mord.

Comme harness_recap.py : les effets de bord (réseau, Telegram, écritures réelles
dans ~/.polymarket) sont neutralisés DANS ce fichier, jamais dans les sources.
Répertoire des sources surchargeable via PAPERBOT_SCRIPTS_DIR.
"""
import importlib.util
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout

SCRIPTS = os.environ.get("PAPERBOT_SCRIPTS_DIR", "/root/.hermes/scripts")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def recap():
    return load(os.path.join(SCRIPTS, "paperbot-recap.py"), "paperbot_recap_v2")


def pnl():
    return load(os.path.join(SCRIPTS, "paperbot-pnl.py"), "paperbot_pnl_v2")


def _read_text(path):
    return open(path, encoding="utf-8", errors="ignore").read()


# ---------------------------------------------------------------------------
# 1. ROBUSTESSE : parse_log() sur des fichiers dégradés
# ---------------------------------------------------------------------------

# Lignes au format RÉEL, sans préfixe de timestamp (donc jamais écartées par la
# fenêtre de 12 h) : on isole le comportement de parsing, pas l'horloge.
GOOD_DECISION = (
    "[SIMULATION] Décision-LLM UP @ $0.60 (round btc-updown-5m-1767309300, "
    "conf 0.62) — mise simulée 1€, gain est. $0.6667 si UP gagne\n"
)
GOOD_GAIN = "gain est. -1.5 si DOWN gagne (x1.54)\n"
GOOD_DIPARB = "DipArb: 3 trades\n"
GOOD_ROUND = "New round: eth-updown-5m-1767309300\n"
GOOD_WINDOW = "Fenêtre apprise → [0.60-0.65]\n"
GOOD_COINS = "Auto-adaptation coins → BTC WR 61% (12) ×1.10\n"

CORRUPT_LINES = [
    "\x00\x01\x02 binary garbage without newline\n",
    "}}} {{{ not json not a log line\n",
    "Décision-LLM UP @ $ (conf) — malformed truncation\n",
    "gain est. . . si gagne (x)\n",
    "DipArb: trades\n",
    "\ufffd\ufffd replacement chars\n",
]


def cmd_parse_log_cases(argv):
    """parse_log() sur : vide, valide, tronqué, corrompu, absent, non-UTF8.

    Renvoie, pour chaque cas, le recap produit (ou marque l'absence) — afin que
    les tests TS vérifient qu'AUCUN cas ne lève et que les lignes valides d'un
    fichier partiellement corrompu sont TOUJOURS extraites.
    """
    m = recap()
    tmp = tempfile.mkdtemp(prefix="parselog-")
    cases = {}

    def run(name, content_bytes, delete=False):
        path = os.path.join(tmp, name + ".log")
        if delete:
            if os.path.exists(path):
                os.remove(path)
        else:
            with open(path, "wb") as f:
                f.write(content_bytes)
        m.LOG = path
        try:
            r = m.parse_log()
            r = dict(r)
            # tuples non sérialisables en JSON → listes
            r["sim_history"] = [list(x) for x in r.get("sim_history", [])]
            r["decisions"] = [list(x) for x in r.get("decisions", [])]
            cases[name] = {"raised": False, "recap": r}
        except Exception as ex:  # pragma: no cover - c'est précisément ce qu'on teste
            cases[name] = {"raised": True, "error": f"{type(ex).__name__}: {ex}"}

    good = GOOD_DECISION + GOOD_GAIN + GOOD_DIPARB + GOOD_ROUND + GOOD_WINDOW + GOOD_COINS
    corrupt = "".join(CORRUPT_LINES)

    run("vide", b"")
    run("vide_juste_retour_ligne", b"\n")
    run("valide", good.encode("utf-8"))
    # Troncature : le fichier s'arrête AU MILIEU de la dernière ligne valide.
    run("tronque_milieu_ligne", (good + GOOD_DECISION[:30]).encode("utf-8"))
    # Corruption : lignes valides AVANT et APRÈS les ordures.
    run("corrompu_entrelace", (good + corrupt + good).encode("utf-8"))
    run("non_utf8", good.encode("utf-8") + b"\xff\xfe\x00garbage\n")
    run("absent", b"", delete=True)
    return cases


# ---------------------------------------------------------------------------
# 2. FRAÎCHEUR : live_price() / best_ask() — une mesure absente reste None
# ---------------------------------------------------------------------------
#
# NOTE (2026-09-27) : paperbot-recap.py évolue en direct ; `fmt_live()` a été
# remplacé par un affichage inline dans build_message(). On s'appuie donc sur les
# DEUX primitives stables qui portent la fraîcheur :
#   - live_price(coin)  → None si la source ne répond pas (jamais une valeur inventée)
#   - best_ask(token)   → None si le carnet est indisponible (docstring : « on
#                         n'invente jamais une valeur »), sinon le MEILLEUR ask.


def cmd_freshness(argv):
    m = recap()
    out = {}

    def http(payload):
        m.http_json = lambda url: payload

    # live_price : mesure absente → None, jamais un prix par défaut maquillé
    http(None)
    out["live_absent"] = m.live_price("BTC")
    http({})
    out["live_vide"] = m.live_price("BTC")
    http({"price": "100000.0"})
    out["live_present"] = m.live_price("BTC")
    http({"price": "0.5"})
    out["live_demi_reel"] = m.live_price("BTC")

    # best_ask : carnet indisponible → None ; carnet valide → offre la moins chère
    http({"asks": []})
    out["ask_carnet_vide"] = m.best_ask("t1")
    http({})
    out["ask_sans_cle"] = m.best_ask("t1")
    http({"asks": [{"price": "0.80"}, {"price": "0.50"}, {"price": "0.65"}]})
    out["ask_min"] = m.best_ask("t1")
    http({"asks": [{"price": "0.50"}]})
    out["ask_demi_reel"] = m.best_ask("t1")
    http({"asks": [{"price": None}, {"price": "0.60"}]})
    out["ask_prix_nul_ignore"] = m.best_ask("t1")
    http({"asks": [{"price": "oops"}]})
    out["ask_illisible"] = m.best_ask("t1")
    return out


# ---------------------------------------------------------------------------
# 3. ROBUSTESSE : edge_stats() sur des JSON dégradés
# ---------------------------------------------------------------------------

VALID_CUM = {"pnl": 3.0, "resolved": {"0xA|YES|0.6": 1.5, "0xB|NO|0.4": -1.0}}
VALID_HIST = [
    {"side": "YES", "price": 0.6, "realized": 1.5, "conditionId": "0xA"},
    {"side": "HOLD", "price": 0, "realized": 0, "conditionId": "0xC"},
]


def cmd_edge_stats_cases(argv):
    m = recap()
    tmp = tempfile.mkdtemp(prefix="edgestats-")
    out = {}

    def run(name, cum_bytes, hist_bytes, delete=False):
        home = os.path.join(tmp, name)
        os.makedirs(os.path.join(home, ".polymarket"), exist_ok=True)
        cp = os.path.join(home, ".polymarket", "cumulative.json")
        hp = os.path.join(home, ".polymarket", "history.json")
        if delete:
            for p in (cp, hp):
                if os.path.exists(p):
                    os.remove(p)
        else:
            with open(cp, "wb") as f:
                f.write(cum_bytes)
            with open(hp, "wb") as f:
                f.write(hist_bytes)
        m.HOME = home
        try:
            v = m.edge_stats()
            out[name] = {"raised": False, "value": list(v) if isinstance(v, tuple) else v}
        except Exception as ex:  # pragma: no cover
            out[name] = {"raised": True, "error": f"{type(ex).__name__}: {ex}"}

    run("absent", b"", b"", delete=True)
    run("valide",
        json.dumps(VALID_CUM).encode("utf-8"),
        json.dumps(VALID_HIST).encode("utf-8"))
    run("tronque", b'{"resolved": {"0xA|YES|0.6": 1.5', b"[{\"side\":\"YES\"")
    run("vide_octet_zero", b"", b"")
    run("racine_non_objet", b"42", b"[]")
    run("entree_non_objet", b"{\"resolved\":{}}", b"[\"oops\", 7, null]")
    run("valeur_booleenne", b'{"resolved": {"0xA|YES|0.6": true}}',
        json.dumps(VALID_HIST).encode("utf-8"))
    return out


# ---------------------------------------------------------------------------
# 4. GAP CONNU : main() de paperbot-pnl.py sur un history.json dégradé
# ---------------------------------------------------------------------------


def cmd_pnl_malformed(argv):
    """Caractérise le comportement RÉEL de main() face à des entrées dégradées.

    ATTENTION : ce n'est PAS une garantie de robustesse — c'est le constat de ce
    que le code fait aujourd'hui. `hist = json.load(open(HIST))` (ligne 223) et
    `for e in hist: e.get(...)` ne sont PAS protégés. Les tests TS épinglent ce
    comportement pour qu'une correction future casse le test et soit vue.
    """
    m = pnl()
    tmp = tempfile.mkdtemp(prefix="pnlmalformed-")
    out = {}

    def run(name, hist_bytes):
        m.HIST = os.path.join(tmp, name + ".history.json")
        m.CUM = os.path.join(tmp, name + ".cumulative.json")
        m.OSUM = os.path.join(tmp, name + ".pnl.json")
        with open(m.HIST, "wb") as f:
            f.write(hist_bytes)
        m.fetch = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("offline-test"))
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                m.main()
            out[name] = {"raised": False, "stdout": buf.getvalue().strip()}
        except Exception as ex:
            out[name] = {"raised": True, "error": f"{type(ex).__name__}: {ex}"}

    run("tronque", b'[{"side": "YES", "realized": 1.5')
    run("vide", b"")
    run("racine_non_liste", b"42")
    run("entree_non_objet", b"[\"oops\"]")
    run("valide", json.dumps(VALID_HIST).encode("utf-8"))
    return out


COMMANDS = {
    "parse-log-cases": cmd_parse_log_cases,
    "fmt-live": cmd_freshness,
    "edge-stats-cases": cmd_edge_stats_cases,
    "pnl-malformed": cmd_pnl_malformed,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"error": "usage: harness_v2.py <" + "|".join(COMMANDS) + "> [args]"}))
        sys.exit(2)
    print(json.dumps(COMMANDS[sys.argv[1]](sys.argv[2:]), ensure_ascii=False))


if __name__ == "__main__":
    main()
