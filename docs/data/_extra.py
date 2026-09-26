#!/usr/bin/env python3
"""Complement: TP vs resolution, direction de l'erreur du resolveur, spam de log."""
import json, collections, csv

rows = list(csv.DictReader(open('docs/data/recon_trades.csv')))
n = len(rows)
tp = [r for r in rows if r['src'] == 'TP']
gm = [r for r in rows if r['src'] == 'Gamma']
print(f"n={n} TP_vendus={len(tp)} resolus_au_round={len(gm)}")
if tp:
    caps = [float(r['realized']) / (1 / float(r['price']) - 1) for r in tp if float(r['realized']) > 0]
    print(f"  capture moyenne du gain max sur les TP: {100*sum(caps)/len(caps):.1f}% (n={len(caps)})")
    neg = [r for r in tp if float(r['realized']) < 0]
    print(f"  TP/SL vendus en perte: {len(neg)}")
print("  pertes totales:", sum(1 for r in rows if float(r['realized']) < 0),
      "| toutes a -1.00 ?", all(abs(float(r['realized']) + 1) < 1e-9 for r in rows if float(r['realized']) < 0))

# direction de l'erreur du resolveur sur l'archive 09-18
a = json.load(open('/root/.polymarket/archive/2026-09-18/history.json'))
tr = [e for e in a if e.get('side') not in (None, 'HOLD') and isinstance(e.get('realized'), (int, float)) and e['realized'] != 0]
yes = [e for e in tr if e['side'] == 'YES']
no = [e for e in tr if e['side'] == 'NO']
print(f"\narchive 09-18 (n={len(tr)}): YES={len(yes)} dont declares gagnants {sum(1 for e in yes if e['realized']>0)}")
print(f"                    NO={len(no)} dont declares gagnants {sum(1 for e in no if e['realized']>0)}")

# trades par jour sur la fenetre cumulee
d = json.load(open('docs/data/_rec.json'))['decs']
w = [x for x in d if x['ts'] >= '2026-09-18T13:40']
bd = collections.Counter(x['ts'][:10] for x in w)
print("\ntrades/jour fenetre cumul:", dict(sorted(bd.items())))

# spam log
import subprocess
c = subprocess.run(['grep', '-c', 'Monitoring active', 'paperbot.log'], capture_output=True, text=True).stdout.strip()
print("lignes 'Monitoring active' dans paperbot.log:", c)
