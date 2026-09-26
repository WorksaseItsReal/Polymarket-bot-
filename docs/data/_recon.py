#!/usr/bin/env python3
"""1) Verifie le resolveur PnL (archive 09-18) contre l'issue reelle (gamma events?slug=).
2) Reconstruit les 63 trades de la fenetre 09-18T13:40 -> 09-20T14:29 et compare au cumul.
Ecrit docs/data/recon_trades.csv. Lecture seule sur le reste.
"""
import json, urllib.request, time, csv, collections

UA = {'User-Agent': 'paperbot-review/1.0'}
CACHE = {}


def outcome(round_id):
    """Retourne (yes_won, no_won, ok)."""
    if round_id in CACHE:
        return CACHE[round_id]
    try:
        r = json.load(urllib.request.urlopen(
            urllib.request.Request('https://gamma-api.polymarket.com/events?slug=' + round_id, headers=UA), timeout=25))
        if not r:
            CACHE[round_id] = (None, None, False); return CACHE[round_id]
        m = r[0]['markets'][0]
        p = json.loads(m['outcomePrices'])
        yes_p, no_p = float(p[0]), float(p[1])
        CACHE[round_id] = (yes_p > 0.9, no_p > 0.9, True)
    except Exception as e:
        CACHE[round_id] = (None, None, False)
    time.sleep(0.12)
    return CACHE[round_id]


# ---------- 1) controle du resolveur sur l'archive 09-18 ----------
a = json.load(open('/root/.polymarket/archive/2026-09-18/history.json'))
tr = [e for e in a if e.get('side') not in (None, 'HOLD') and isinstance(e.get('realized'), (int, float)) and e['realized'] != 0]
print("=== Controle resolveur (archive 09-18) :", len(tr), "trades avec realized != 0")
ok = bad = noapi = 0
mismatch = []
for e in tr:
    yw, nw, valid = outcome(e['roundId'])
    if not valid:
        noapi += 1; continue
    won_real = yw if e['side'] == 'YES' else nw
    wr = e['realized'] > 0
    if e.get('soldTp'):
        # vente TP : le realized est le gain de la vente, pas l'issue du round -> on teste juste le signe
        pass
    if wr == won_real:
        ok += 1
    else:
        bad += 1
        mismatch.append((e['roundId'], e['coin'], e['side'], e['price'], e['realized'], won_real))
print(f"  coherents={ok} incoherents={bad} api_ko={noapi}")
for m in mismatch[:15]:
    print("   MISMATCH", m)

# ---------- 2) reconstruction de la fenetre du cumul ----------
d = json.load(open('docs/data/_rec.json'))
decs = d['decs']; tps = d['tps']
w = [x for x in decs if x['ts'] >= '2026-09-18T13:40']
print("\n=== Reconstruction fenetre 09-18T13:40 -> 09-20T14:29 :", len(w), "trades")
rows = []
for x in w:
    tp = tps.get(x['round'])
    yw, nw, valid = outcome(x['round'])
    if tp:
        realized = tp['gain']; won = realized > 0; src = 'TP'
    elif valid:
        won = (yw if x['side'] == 'YES' else nw)
        realized = round(1 / x['price'] - 1, 4) if won else -1.0
        src = 'Gamma'
    else:
        won = None; realized = None; src = 'ABSENT'
    rows.append(dict(coin=x['coin'], round=x['round'], ts=x['ts'], side=x['side'], price=x['price'],
                     src=src, won=won, realized=realized))
res = [r for r in rows if r['realized'] is not None]
pnl = sum(r['realized'] for r in res)
wins = sum(1 for r in res if r['realized'] > 0)
losses = sum(1 for r in res if r['realized'] < 0)
print(f"  resolus={len(res)} (absents={len(rows)-len(res)}) wins={wins} losses={losses} "
      f"wr={100*wins/max(len(res),1):.1f}% pnl={pnl:.4f}")
print("  CUMULATIF OFFICIEL: trades=63 wins=28 losses=35 pnl=-21.0667")

with open('docs/data/recon_trades.csv', 'w', newline='') as f:
    wr = csv.DictWriter(f, fieldnames=['coin', 'round', 'ts', 'side', 'price', 'src', 'won', 'realized'])
    wr.writeheader(); wr.writerows(rows)
print("  -> docs/data/recon_trades.csv")

bycoin = collections.defaultdict(lambda: [0, 0, 0.0])
for r in res:
    c = bycoin[r['coin']]; c[0] += 1; c[1] += 1 if r['won'] else 0; c[2] += r['realized']
print("\n  par coin: coin n wins wr% pnl")
for c, v in sorted(bycoin.items()):
    print(f"   {c}: n={v[0]} wins={v[1]} wr={100*v[1]/v[0]:.1f}% pnl={v[2]:+.4f}")
json.dump({k: v for k, v in CACHE.items()}, open('docs/data/_outcomes.json', 'w'))
