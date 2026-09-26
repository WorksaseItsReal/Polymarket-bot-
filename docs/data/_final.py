#!/usr/bin/env python3
"""Derniers chiffres : cout du TP, backtest du filtre d'edge, cadence, echantillon requis."""
import csv, json, collections, math, statistics as st, datetime

rows = list(csv.DictReader(open('docs/data/recon_trades.csv')))
for r in rows:
    r['price'] = float(r['price']); r['realized'] = float(r['realized'])
n = len(rows)
tp = [r for r in rows if r['src'] == 'TP']
cost = sum((1 / r['price'] - 1) - r['realized'] for r in tp)
print(f"TP: n={len(tp)} cout total du TP (gain max non capture) = {cost:.4f} EUR")
print(f"    cout par trade (sur {n}) = {cost/n:.5f} | EV totale = {sum(r['realized'] for r in rows)/n:.5f}"
      f" -> le TP consomme {100*cost/abs(sum(r['realized'] for r in rows)):.1f}% de l'EV")
print(f"    capture moyenne={100*(1-cost/sum(1/r['price']-1 for r in tp)):.1f}%")

# cadence
d = json.load(open('docs/data/_rec.json'))['decs']
w = [x for x in d if x['ts'] >= '2026-09-18T13:40']
t0 = datetime.datetime.fromisoformat(w[0]['ts']); t1 = datetime.datetime.fromisoformat(w[-1]['ts'])
hrs = (t1 - t0).total_seconds() / 3600
print(f"\nfenetre: {w[0]['ts']} -> {w[-1]['ts']} = {hrs:.1f} h pour {n} trades = {n/hrs:.2f} trades/h")
print(f"bot a l'arret: 2026-09-20T14:29Z -> 2026-09-25T21:08Z = {(datetime.datetime(2026,9,25,21,8)-datetime.datetime(2026,9,20,14,29)).total_seconds()/86400:.2f} jours")

sd = st.pstdev([r['realized'] for r in rows])
ev = sum(r['realized'] for r in rows) / n
for target in [ev, 0.05, 0.10]:
    nr = (2 * sd / target) ** 2
    print(f"n requis (t=2) pour EV={target:+.5f} : {nr:.0f} trades = {nr/(n/hrs)/24:.0f} jours a {n/hrs:.2f} trades/h")


# backtest sequentiel : filtre d'edge par coin (WR >= prix+10pts apres >=8 trades resolus)
def backtest(mode):
    hist = collections.defaultdict(list)
    kept = []
    for r in rows:
        c = r['coin']; h = hist[c]
        ok = True
        if mode == 'edge' and len(h) >= 8:
            wr = 100 * sum(1 for x in h if x > 0) / len(h)
            if wr < (r['price'] + 0.10) * 100:
                ok = False
        if mode == 'coinneg' and h and sum(h) < 0:
            ok = False
        if mode == 'cool2' and len(h) >= 2 and h[-1] < 0 and h[-2] < 0:
            ok = False
        if ok:
            kept.append(r)
        hist[c].append(r['realized'])
    p = sum(x['realized'] for x in kept)
    return len(kept), sum(1 for x in kept if x['realized'] > 0), p


print("\nbacktest sequentiel sur les 63 trades (issu reelle) :")
for m in ['none', 'edge', 'coinneg', 'cool2']:
    k, wins_, p = backtest(m)
    print(f"  {m:8s}: trades={k:2d} wins={wins_:2d} wr={100*wins_/max(k,1):.0f}% pnl={p:+.3f}")

# repartition TP par coin
print("\nTP par coin:", dict(collections.Counter(r['coin'] for r in tp)))
print("bucket 0.58-0.65 vs 0.65-0.75 :",
      f"{sum(1 for r in rows if r['price']<0.65)} trades ({sum(r['realized'] for r in rows if r['price']<0.65):+.3f} EUR) vs "
      f"{sum(1 for r in rows if r['price']>=0.65)} trades ({sum(r['realized'] for r in rows if r['price']>=0.65):+.3f} EUR)")
