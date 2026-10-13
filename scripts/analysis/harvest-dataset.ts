/**
 * Récolte de fin de round rejouée sur des CARNETS RÉELS à la seconde (jeu de données public).
 *
 *   npx tsx scripts/analysis/harvest-dataset.ts --download           # télécharge puis analyse
 *   npx tsx scripts/analysis/harvest-dataset.ts --dir <dossier>      # fichiers .db / .db.zst déjà là
 *        [--label 5m|15m]
 *
 * Source : https://github.com/gensx-x1/polymarket-btc-eth-updown-data (table `ticks`, BTC/ETH,
 * 5 et 15 min, un instantané par seconde ; fichiers .db.zst de ~25 Mo). Données d'un tiers :
 * indicatives — l'issue est déduite du carnet final (src/analysis/harvest-dataset.ts).
 * Requiert Node ≥ 22.15 (node:sqlite, zstd natif). Écrit seulement dans ~/.polymarket/datasets/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { DEFAULT_HARVEST_CONFIG } from '../../src/strategy/late-harvest.js';
import { DEFAULT_FAIR_VALUE_CONFIG } from '../../src/services/fair-value.js';
import { loadSqlite, simulateAll, type DatasetRound, type HarvestSimOpts, type SimSummary, type Tick } from '../../src/analysis/harvest-dataset.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const REPO = 'gensx-x1/polymarket-btc-eth-updown-data';
const DIR = arg('dir') ?? join(process.env.HOME || homedir(), '.polymarket', 'datasets', 'gensx');
const LABEL = arg('label') === '15m' ? '15m' : '5m';
/** Règlement TWAP depuis le 7 août 2026 00:00 UTC (avant : prix ponctuel, autre jeu). */
const TWAP_START = 1_786_060_800;

async function download(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/databases`, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`liste des fichiers : HTTP ${res.status}`);
  const files = (await res.json()) as Array<{ name: string; download_url: string | null }>;
  for (const f of files.filter(x => x.name.endsWith('.db.zst') && x.download_url)) {
    const dst = join(DIR, f.name);
    if (existsSync(dst) || existsSync(dst.slice(0, -4))) continue;
    process.stderr.write(`téléchargement ${f.name}…\n`);
    const r = await fetch(f.download_url as string);
    if (!r.ok) throw new Error(`${f.name} : HTTP ${r.status}`);
    writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
  }
}

function decompressAll(): string[] {
  const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  for (const f of readdirSync(DIR).filter(x => x.endsWith('.db.zst'))) {
    const out = join(DIR, f.slice(0, -4));
    if (existsSync(out)) continue;
    if (!zstd) throw new Error('zstd natif absent (Node ≥ 22.15 requis) : décompresser à la main avec `zstd -d`');
    process.stderr.write(`décompression ${f}…\n`);
    writeFileSync(out, zstd(readFileSync(join(DIR, f))));
  }
  return readdirSync(DIR).filter(x => x.endsWith('.db')).sort().map(x => join(DIR, x));
}

async function load(paths: string[]): Promise<DatasetRound[]> {
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) throw new Error('node:sqlite indisponible (Node ≥ 22.5 requis)');
  const rounds = new Map<string, { asset: string; startSec: number; rows: Map<number, Tick> }>();
  for (const p of paths) {
    const db = new DatabaseSync(p, { readOnly: true });
    const q = db.prepare('SELECT slug, asset, window_start, ts_ms, secs_to_close, up_bid, up_ask, down_bid, down_ask FROM ticks WHERE window_label = ? AND ok = 1 AND window_start >= ?');
    for (const r of q.iterate(LABEL, TWAP_START)) {
      const slug = String(r.slug);
      let w = rounds.get(slug);
      if (!w) rounds.set(slug, (w = { asset: String(r.asset), startSec: Number(r.window_start), rows: new Map() }));
      const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
      w.rows.set(Number(r.ts_ms), { tau: Number(r.secs_to_close), upBid: num(r.up_bid), upAsk: num(r.up_ask), downBid: num(r.down_bid), downAsk: num(r.down_ask) });
    }
    db.close();
  }
  return [...rounds.entries()].map(([slug, w]) => ({
    slug, asset: w.asset, startSec: w.startSec,
    ticks: [...w.rows.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t),
  }));
}

const fmt = (s: SimSummary) => (s.trades
  ? `${s.trades} paris / ${s.rounds} rounds · gagnés ${((s.winRate as number) * 100).toFixed(2)} % · ${((s.ev as number) * 100 >= 0 ? '+' : '')}${((s.ev as number) * 100).toFixed(3)} %/pari · t ${s.t === null ? '—' : s.t.toFixed(1)}`
  : `aucun pari (${s.rounds} rounds)`);

async function main() {
  if (process.argv.includes('--download')) await download();
  if (!existsSync(DIR)) { console.error(`Dossier ${DIR} absent : lancer avec --download, ou --dir <dossier des .db>.`); process.exit(1); }
  const rounds = await load(decompressAll());
  if (!rounds.length) { console.error('Aucun round TWAP (≥ 7 août 2026) dans ces fichiers.'); process.exit(1); }
  const h = DEFAULT_HARVEST_CONFIG;
  const base: HarvestSimOpts = {
    minAsk: h.minAsk, maxAsk: h.maxAsk, minTau: h.minTauSec, maxTau: h.maxTauSec, stableSec: h.stableSec,
    stepSec: h.checkEveryMs / 1000, delaySec: 1, feeRate: DEFAULT_FAIR_VALUE_CONFIG.takerFeeRate,
  };
  const starts = rounds.map(r => r.startSec).sort((a, b) => a - b);
  const mid = starts[Math.floor(starts.length / 2)];
  const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
  console.log(`\n=== Récolte de fin de round sur carnets réels (${LABEL}) : ${rounds.length} rounds, ${day(starts[0])} → ${day(starts[starts.length - 1])} ===\n`);
  console.log(`Règle du bot (lecture /${base.stepSec} s, bloqué à ≥ ${base.minAsk} depuis ≥ ${base.stableSec} s, τ ${base.maxTau}→${base.minTau} s, exécution +${base.delaySec} s) :`);
  const all = simulateAll(rounds, base);
  console.log(`   ${fmt(all)}`);
  console.log(`   1re moitié : ${fmt(simulateAll(rounds.filter(r => r.startSec < mid), base))}`);
  console.log(`   2e moitié  : ${fmt(simulateAll(rounds.filter(r => r.startSec >= mid), base))}`);
  for (const a of [...new Set(rounds.map(r => r.asset))].sort()) console.log(`   ${a.padEnd(10)} : ${fmt(simulateAll(rounds.filter(r => r.asset === a), base))}`);
  console.log('\nRobustesse :');
  for (const [label, o] of [
    ['grille décalée de 1,5 s', { ...base, phaseSec: 1.5 }],
    ['lecture /8 s (2 lectures)', { ...base, stepSec: 8, stableSec: 8 }],
    ['exécution +3 s', { ...base, delaySec: 3 }],
    ['SANS stabilité, lecture /1 s (premier contact)', { ...base, stepSec: 1, stableSec: 0 }],
    ['fenêtre 60→8 s', { ...base, maxTau: 60 }],
  ] as Array<[string, HarvestSimOpts]>) console.log(`   ${label.padEnd(46)} : ${fmt(simulateAll(rounds, o))}`);
  const ok = all.trades >= 300 && (all.t ?? 0) >= 2 && (all.ev ?? 0) > 0;
  console.log(ok
    ? '\n→ La règle reste rentable sur ces carnets (t ≥ 2). Confirmer sur les paris papier du bot (/rapport, section 1e).'
    : '\n→ Pas de gain démontré sur ces données : si les paris papier vont dans le même sens, couper FV_HARVEST.');
}

main().catch(err => { console.error(err); process.exit(1); });
