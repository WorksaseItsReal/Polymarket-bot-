#!/usr/bin/env python3
"""Harnais de test — exerce les fonctions RÉELLES de paperbot-recap.py et
paperbot-pnl.py par import de chemin (les sources ne sont JAMAIS copiées ni
modifiées). Renvoie du JSON sur stdout, consommé par les tests TypeScript
(node:test) via child_process.

Pourquoi un harnais : ces deux fichiers sont des scripts exécutables (le recap
lit son token au niveau module, le résolveur écrit sur disque dans main()). On
les importe donc précautionneusement puis on monkeypatche UNIQUEMENT les effets
de bord (réseau, envoi Telegram, écriture pnl.json réel) afin de tester la
logique exacte sans toucher aux données de production.

Le répertoire des sources est surchargeable via PAPERBOT_SCRIPTS_DIR (défaut
/root/.hermes/scripts). S'il est absent (ex. CI hors de cette machine), les
tests correspondants sont SKIPPÉS côté TypeScript — jamais simulés.
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
    return load(os.path.join(SCRIPTS, "paperbot-recap.py"), "paperbot_recap")


def pnl():
    return load(os.path.join(SCRIPTS, "paperbot-pnl.py"), "paperbot_pnl")


def _fake_log(round_id):
    """parse_log() factice : structure IDENTIQUE à celle du vrai parse_log,
    entièrement déterministe (le vrai lit paperbot.log et change selon l'heure)."""
    return {
        "market": None, "underlying": None, "decisions": [],
        "sim_pnl": 0.0, "sim_trades": 0, "diparb_trades": None,
        "sim_history": [], "sim_pnl_local": 0.0, "degraded_holds": 0,
        "round": round_id,
    }


def _patch_side_effects(m):
    """Neutralise réseau / Telegram / écriture du pnl.json ÉMIS."""
    m.subprocess.run = lambda *a, **k: None


def cmd_fmt_round(argv):
    m = recap()
    rid = argv[0] if argv else ""
    return {"input": rid, "output": m.fmt_round(rid)}


def cmd_round_line(argv):
    """Exerce le VRAI build_message() pour la ligne « 🔁 Round: … » avec un id de
    round dégradé (slug + suffixe interne + virgule finale)."""
    m = recap()
    _patch_side_effects(m)
    m.round_info = lambda coin: None
    m.round_open_price = lambda coin, slot: None
    m.live_price = lambda coin: None
    m.llm_enabled = lambda: False
    cases = {
        "slug_avec_virgule": "btc-updown-5m-1767309300-abc,",
        "slug_propre": "eth-updown-5m-1767309300",
        "epoch_brut": "1767309300",
        "vide": "",
    }
    out = {}
    for name, rid in cases.items():
        m.parse_log = (lambda r: (lambda: _fake_log(r)))(rid)
        raw = m.build_message()
        line = next((l for l in raw.splitlines() if "Round:" in l), "")
        out[name] = line
    return out


def cmd_dedup(argv):
    """Exerce le VRAI main() de paperbot-recap.py et observe la clé de dédup
    réellement écrite dans le fichier `last_msg`."""
    m = recap()
    _patch_side_effects(m)
    tmp = tempfile.mkdtemp(prefix="recapstamp-")
    os.makedirs(os.path.join(tmp, ".config", "paperbot-recap"), exist_ok=True)
    m.HOME = tmp  # redirige le FICHIER tampon vers un dossier jetable
    stamp = os.path.join(tmp, ".config", "paperbot-recap", "last_msg")

    sent = []
    m.send = lambda text: sent.append(text)
    m.round_info = lambda coin: None
    m.round_open_price = lambda coin, slot: None
    m.parse_log = lambda: _fake_log("btc-updown-5m-1767309300-abc,")
    m.llm_enabled = lambda: False

    prices1 = {"BTC": 100000.0, "ETH": 3000.0, "SOL": 200.0, "XRP": 2.5, "DOGE": 0.1}
    prices2 = {"BTC": 100123.0, "ETH": 3011.0, "SOL": 201.0, "XRP": 2.6, "DOGE": 0.11}

    m.live_price = lambda coin: prices1.get(coin)
    with redirect_stdout(io.StringIO()):
        m.main()
    n1 = len(sent)
    key1 = open(stamp).read() if os.path.exists(stamp) else ""

    # Les PRIX LIVE bougent → la clé ne doit PAS changer → pas de renvoi.
    m.live_price = lambda coin: prices2.get(coin)
    with redirect_stdout(io.StringIO()):
        m.main()
    n2 = len(sent)
    key2 = open(stamp).read() if os.path.exists(stamp) else ""

    # Un ÉVÉNEMENT change (la ligne « mode déterministe » vs « aucune analyse IA »)
    # → la clé change → renvoi légitime.
    m.llm_enabled = lambda: True
    with redirect_stdout(io.StringIO()):
        m.main()
    n3 = len(sent)

    return {
        "sent_apres_appel_1": n1,
        "sent_apres_appel_2_prix_bouges": n2,
        "sent_apres_appel_3_evenement": n3,
        "cle_identique": key1 == key2,
        "cle_contient_marqueur": "\x00" in key1,
        "cle_contient_ligne_round": "🔁 Round:" in key1,
        "cle_contient_prix_live": ("100000" in key1) or ("100123" in key1) or ("3000" in key1),
        "message_envoye_contient_marqueur": any("\x00" in t for t in sent),
        "cle_extrait": key1[:60],
    }


def cmd_pnl_pending(argv):
    """Exerce le VRAI paperbot-pnl.py main() sur un history.json synthétique :
    - un trade gagné (realized pré-rempli > 0)
    - un trade perdu (realized pré-rempli < 0)
    - un trade realized:0 NON résolvable → doit rester EN ATTENTE (pending),
      ni compté gagnant ni perdant
    - un HOLD (ignoré)
    """
    m = pnl()
    tmp = tempfile.mkdtemp(prefix="pnltest-")
    m.HIST = os.path.join(tmp, "history.json")
    m.CUM = os.path.join(tmp, "cumulative.json")
    m.OSUM = os.path.join(tmp, "pnl.json")
    # Réseau coupé de façon déterministe : outcome() renvoie None → non résolu.
    m.fetch = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("offline-test"))

    hist = [
        {"side": "YES", "price": 0.5, "realized": 0, "roundId": "btc-updown-5m-1767309300",
         "conditionId": "0xAAA", "coin": "BTC", "stake": 1.0},
        {"side": "NO", "price": 0.4, "realized": 1.5, "conditionId": "0xWIN", "coin": "ETH", "stake": 1.0},
        {"side": "YES", "price": 0.6, "realized": -1.0, "conditionId": "0xLOSS", "coin": "SOL", "stake": 1.0},
        {"side": "HOLD", "price": 0, "realized": 0, "conditionId": "0xHOLD"},
    ]
    json.dump(hist, open(m.HIST, "w"))
    buf = io.StringIO()
    with redirect_stdout(buf):  # le vrai main() imprime son résumé : on l'isole
        m.main()
    out = json.load(open(m.OSUM))
    out["stdout_du_resolveur"] = buf.getvalue().strip()
    after = json.load(open(m.HIST))
    out["realized_du_pending_apres_main"] = after[0].get("realized")
    out["history_len"] = len(after)
    return out


def cmd_pnl_realized(argv):
    """Exerce la VRAIE fonction realized_for() (montant réalisé par trade)."""
    m = pnl()
    return {
        "gagne_1": m.realized_for("YES", 0.5, True, 1.0),
        "perdu_1": m.realized_for("YES", 0.5, False, 1.0),
        "gagne_5": m.realized_for("YES", 0.5, True, 5.0),
        "perdu_5": m.realized_for("YES", 0.5, False, 5.0),
        "gagne_5_no": m.realized_for("NO", 0.4, False, 5.0),
        "realized_0_impossible": m.realized_for("YES", 0.5, False, 0.0),
    }


COMMANDS = {
    "fmt-round": cmd_fmt_round,
    "round-line": cmd_round_line,
    "dedup": cmd_dedup,
    "pnl-pending": cmd_pnl_pending,
    "pnl-realized": cmd_pnl_realized,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"error": "usage: harness_recap.py <"
                          + "|".join(COMMANDS) + "> [args]"}))
        sys.exit(2)
    result = COMMANDS[sys.argv[1]](sys.argv[2:])
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
