#!/usr/bin/env python3
"""Piste 1b (verification): les 'sommes YES < 1' sont-elles de VRAIS arb ?

Deux pieges a eliminer:
  (a) partition non exhaustive (une issue 'None/Other' absente -> si aucune
      des issues listees ne gagne, acheter tous les YES perd tout);
  (b) profondeur nulle: le bestAsk Gamma peut valoir 0.01 pour 3 parts.
On recharge donc les carnets CLOB reels et on walk jusqu'a epuisement.
"""
import json, time, urllib.request

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"


def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "arb-research/1.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                return {"__error__": str(e)}
            time.sleep(1.2 * (i + 1))


def event_detail(slug):
    d = get(f"{GAMMA}/events?slug={slug}")
    if isinstance(d, list) and d:
        return d[0]
    return None


def book_asks(token_id):
    d = get(f"{CLOB}/book?token_id={token_id}")
    if not isinstance(d, dict) or "asks" not in d:
        return []
    return sorted((float(l["price"]), float(l["size"])) for l in d["asks"])


def walk_sum(books):
    """Achat simultane 1 part de chaque book; on cherche la plus grande q
    telle que somme des prix marginaux < 1. Renvoie (q, profit_unitaire)."""
    idx = [0] * len(books)
    q = 0.0
    prof = 0.0
    while True:
        psum = 0.0
        avail = []
        for i, b in enumerate(books):
            if idx[i] >= len(b):
                return None  # une jambe epuisee
            p, s = b[idx[i]]
            psum += p
            avail.append(s)
        if psum >= 1.0:
            break
        take = min(avail)
        if take <= 0:
            break
        q += take
        prof += take * (1.0 - psum)
        for i, b in enumerate(books):
            p, s = b[idx[i]]
            if s - take <= 1e-9:
                idx[i] += 1
            else:
                b[idx[i]] = (p, s - take)
    return q, prof


def main():
    rows = json.load(open("arb_multi.json"))
    tops = sorted([r for r in rows if r["sum_yes_ask"] < 1.0], key=lambda x: x["sum_yes_ask"])
    for r in tops:
        ev = event_detail(r["slug"])
        if not ev:
            print(f"\n### {r['slug']}: event introuvable")
            continue
        mks = [m for m in ev.get("markets", []) if not m.get("closed")]
        print(f"\n{'='*78}")
        print(f"### {r['slug']}  (Gamma sum={r['sum_yes_ask']:.4f}, n={r['n']})")
        print(f"    titre: {ev.get('title')}")
        print(f"    negRisk={ev.get('negRisk')}  vol24={ev.get('volume24hr')}")
        print(f"    issues listees ({len(mks)}):")
        books = []
        for m in mks:
            outc = json.loads(m.get("outcomes") or "[]")
            tit = m.get("groupItemTitle") or m.get("question")
            a = m.get("bestAsk")
            print(f"      - {str(tit)[:52]:52s} bestAsk={a} prices={m.get('outcomePrices')}")
            if len(outc) == 2:
                toks = json.loads(m.get("clobTokenIds") or "[]")
                yi = 0 if str(outc[0]).lower() == "yes" else 1
                books.append((tit, toks[yi]))
        # vraie profondeur CLOB
        bks = []
        for tit, tok in books:
            bks.append(book_asks(tok))
            time.sleep(0.05)
        if bks and all(bks):
            res = walk_sum([list(b) for b in bks])
            if res:
                q, prof = res
                print(f"    >>> CLOB reel: q_max={q:.2f} parts, profit_total_executable={prof:.4f} USDC "
                      f"({100*prof/max(1e-9,(q or 1)):.2f}% brut /unite)")
                # detail des niveaux retenus
                for (tit, _), b in zip(books, bks):
                    print(f"        {str(tit)[:40]:40s} ask_top={b[0] if b else None} depth_au_top={(b[0][1] if b else None)}")
            else:
                print("    >>> une jambe n'a AUCUNE offre (carnet vide) -> non capturable")
        else:
            print("    >>> carnets CLOB indisponibles/vides")


if __name__ == "__main__":
    main()
