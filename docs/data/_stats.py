#!/usr/bin/env python3
"""Stats finales sur l'echantillon valide (63 trades) + diagnostic du resolveur."""
import json, collections, math, statistics as st

v = json.load(open('docs/data/_verify.json'))
rows = v['rows']          # [coin, key, price, realized_reel]
cum = json.load(open('/root/.polymarket/cumulative.json'))
keys = list(cum['resolved'].keys())
real = {k: r for (_, k, _, r) in rows}

n = len(rows)
wins = sum(1 for _, _, _, r in rows if r > 0)
losses = sum(1 for _, _, _, r in rows if r < 0)
winsum = sum(r for _, _, _, r in rows if r > 0)
losssum = sum(r for _, _, _, r in rows if r < 0)
pnl = winsum + losssum
print(f"n={n} wins={wins} losses={losses} wr={100*wins/n:.1f}%")
print(f"somme gains={winsum:+.4f} (avg +{winsum/wins:.4f}) | somme pertes={losssum:+.4f} (avg {losssum/losses:.4f})")
print(f"pnl={pnl:+.4f}  EV/trade={pnl/n:+.5f}  payoff b={(winsum/wins)/abs(losssum/losses):.3f}")
p = wins / n
b = (winsum / wins) / abs(losssum / losses)
print(f"p={p:.4f} b={b:.3f} edge=p*b-(1-p)={p*b-(1-p):+.4f}")
fstar = p - (1 - p) / b
print(f"Kelly f*={fstar:.4f} -> clamp[0,0.25]={max(0,min(0.25,fstar)):.4f} -> sizeFactor~{1+2*max(0,min(0.25,fstar)):.3f}")

sd = st.pstdev([r for _, _, _, r in rows])
se = sd / math.sqrt(n)
print(f"sd/trade={sd:.4f} se={se:.4f} t-stat={pnl/n/se:.2f} (significatif si |t|>2)")
if pnl != 0:
    print(f"n requis pour t=2 avec EV={pnl/n:+.5f} : ~{(2*sd/(pnl/n))**2:.0f} trades")
    print(f"n requis pour detecter EV=+0.05 : ~{(2*sd/0.05)**2:.0f} trades")

tot_real = sum(real[k] for k in keys)
print(f"\nOFFICIEL pnl={cum['pnl']:+.4f} (wins={cum['wins']} losses={cum['losses']})")
print(f"REEL      pnl={tot_real:+.4f} (wins={wins} losses={losses})")
print(f"ECART     {tot_real-cum['pnl']:+.4f} EUR sur {n} trades a 1 EUR")


def wilson(k, nn, z=1.96):
    if nn == 0: return (0, 0)
    ph = k / nn
    d = 1 + z * z / nn
    c = ph + z * z / (2 * nn)
    r = z * math.sqrt(ph * (1 - ph) / nn + z * z / (4 * nn * nn))
    return ((c - r) / d * 100, (c + r) / d * 100)


lo, hi = wilson(wins, n)
print(f"WR global {100*wins/n:.1f}% IC95%=[{lo:.1f};{hi:.1f}]%")


def bk(pr):
    if pr < 0.60: return '0.55-0.60'
    if pr < 0.65: return '0.60-0.65'
    if pr < 0.70: return '0.65-0.70'
    if pr < 0.75: return '0.70-0.75'
    return '0.75+'


print("\n--- buckets (issue reelle) ---")
bg = collections.defaultdict(list)
for _, _, pr, r in rows:
    bg[bk(pr)].append((pr, r))
for bkt in ['0.55-0.60', '0.60-0.65', '0.65-0.70', '0.70-0.75', '0.75+']:
    if bkt not in bg: continue
    g = bg[bkt]; nn = len(g); k = sum(1 for _, r in g if r > 0)
    l, h = wilson(k, nn)
    avgpre = sum(pr for pr, _ in g) / nn
    print(f"  {bkt}: n={nn} wr={100*k/nn:.0f}% IC95=[{l:.0f};{h:.0f}] prix_moy={avgpre:.3f} "
          f"breakeven_wr={100*avgpre:.0f}% pnl={sum(r for _, r in g):+.3f} EV={sum(r for _, r in g)/nn:+.4f}")

print("\n--- coins ---")
cg = collections.defaultdict(list)
for c, _, pr, r in rows:
    cg[c].append(r)
for c, g in sorted(cg.items(), key=lambda kv: -sum(kv[1])):
    nn = len(g); k = sum(1 for r in g if r > 0); l, h = wilson(k, nn)
    print(f"  {c}: n={nn} wr={100*k/nn:.0f}% IC95=[{l:.0f};{h:.0f}] pnl={sum(g):+.3f} EV={sum(g)/nn:+.4f}")

print("\n--- concentration des trades sur la fenetre ---")
byday = collections.Counter(ts[:10] for ts in json.load(open('docs/data/_rec.json'))['decs'] if ts >= '2026-09-18T13:40')
print("  trades/jour:", dict(sorted(byday.items())))
