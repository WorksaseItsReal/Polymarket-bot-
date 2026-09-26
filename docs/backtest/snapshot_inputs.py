#!/usr/bin/env python3
"""snapshot_inputs.py — fige les entrées (lecture seule sur les sources).

Le bot et un autre agent écrivent dans /root/.polymarket/ pendant l'analyse :
on copie donc l'état au moment T dans docs/backtest/data/ et on travaille
exclusivement sur ces copies. Un manifeste (hashes + mtime + taille) est écrit
pour prouver plus tard sur QUEL état l'analyse a porté.

Usage : python3 snapshot_inputs.py [--dir /root/.polymarket]
"""
import hashlib
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')

SOURCES = [
    '/root/.polymarket/cumulative.json',
    '/root/.polymarket/pnl.json',
    '/root/.polymarket/history.json',
    '/root/.polymarket/cumulative.json.bak-20260925-213149',
    '/root/.polymarket/repair-20260925-213149.json',
    '/root/.polymarket/archive/2026-09-18/history.json',
    '/root/.polymarket/archive/2026-09-18/pnl.json',
    '/root/.polymarket/archive/2026-09-25/history.json',
    '/root/.polymarket/archive/2026-09-25/pnl.json',
    '/root/clawd/Polymarket-bot/docs/data/recon_trades.csv',
    '/root/clawd/Polymarket-bot/docs/data/_rec.json',
    '/root/clawd/Polymarket-bot/paperbot.log',
]


def sha(path, cap=None):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def main():
    os.makedirs(DATA, exist_ok=True)
    manifest = {'snapshot_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'files': {}}
    for src in SOURCES:
        if not os.path.exists(src):
            manifest['files'][src] = {'missing': True}
            continue
        rel = src.replace('/root/.polymarket/', 'polymarket/').replace(
            '/root/clawd/Polymarket-bot/', 'bot/').replace('/', '__')
        dst = os.path.join(DATA, rel)
        if os.path.isfile(src):
            shutil.copy2(src, dst)
        else:
            os.makedirs(dst, exist_ok=True)
        st = os.stat(src)
        manifest['files'][src] = {
            'copied_to': os.path.relpath(dst, HERE),
            'size': st.st_size,
            'mtime': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(st.st_mtime)),
            'sha256': sha(src),
        }
    json.dump(manifest, open(os.path.join(DATA, 'manifest.json'), 'w'), indent=2)
    print(json.dumps(manifest, indent=2)[:2000])


if __name__ == '__main__':
    main()
