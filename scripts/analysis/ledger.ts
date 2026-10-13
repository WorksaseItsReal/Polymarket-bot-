/**
 * Bilan du registre papier (~/.polymarket/fv-ledger.jsonl, journal append-only).
 *
 *   npx tsx scripts/analysis/ledger.ts [--last 15]
 *   npx tsx scripts/analysis/ledger.ts --export-json [--force]
 *
 * Lecture seule (le bot peut tourner : pas de verrou d'écrivain). Affiche le bilan (même calcul
 * que le bot et Telegram), la mesure « modèle vs carnet » et les derniers trades.
 *
 * --export-json : RETOUR ARRIÈRE vers une version du bot antérieure au journal. Reconstruit
 * ~/.polymarket/fv-ledger.json (ancien format, un seul JSON) à partir du journal rejoué ; refuse
 * d'écraser un fv-ledger.json existant sans --force. Arrêter le bot avant.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeStats, type LedgerStats, type LedgerTrade } from '../../src/services/paper-ledger.js';
import { LedgerStore, exportLegacyLedger, readLegacyLedger } from '../../src/services/ledger-store.js';
import { reliability, shadowLine } from '../../src/services/telegram-messages.js';
import { shadowStats, type ShadowAggregate } from '../../src/strategy/shadow-tracker.js';

const POLY = join(process.env.HOME || homedir(), '.polymarket');
const JOURNAL = join(POLY, 'fv-ledger.jsonl');
const LEGACY = join(POLY, 'fv-ledger.json');
const i = process.argv.indexOf('--last');
const LAST = i >= 0 ? Number(process.argv[i + 1]) || 15 : 15;

if (process.argv.includes('--export-json')) {
  if (!existsSync(JOURNAL)) {
    console.error(`${JOURNAL} absent : rien à exporter.`);
    process.exit(1);
  }
  if (existsSync(LEGACY) && !process.argv.includes('--force')) {
    console.error(`${LEGACY} existe déjà : export refusé (le déplacer, ou --force pour l'écraser).`);
    process.exit(1);
  }
  try {
    const n = exportLegacyLedger(JOURNAL, LEGACY);
    console.log(`${n} trades exportés vers ${LEGACY} (ancien format). Pour revenir à une version antérieure du bot :`);
    console.log(`  arrêter le bot, archiver ${JOURNAL} (sinon un bot récent le préférera à fv-ledger.json), puis lancer l'ancienne version.`);
    process.exit(0);
  } catch (err) {
    console.error(`Export impossible : ${(err as Error).message}`);
    process.exit(1);
  }
}

let st: LedgerStats;
let last: LedgerTrade[];
if (!existsSync(JOURNAL) && existsSync(LEGACY)) {
  // Bot pas encore redémarré depuis la mise à jour : ancien format, lu tel quel.
  const trades = readLegacyLedger(LEGACY);
  if (trades === null) {
    console.error('fv-ledger.json illisible (fichier préservé).');
    process.exit(1);
  }
  console.log('(ancien registre fv-ledger.json : migré au prochain démarrage du bot)');
  st = computeStats(trades);
  last = trades.slice(-LAST);
} else {
  const ledger = new LedgerStore(JOURNAL);
  const broken = ledger.brokenReason();
  if (broken) {
    console.error(`fv-ledger.jsonl illisible (${broken}) — fichier préservé.`);
    process.exit(1);
  }
  st = ledger.stats();
  // Derniers trades : réglés récents et positions ouvertes, par date (le registre ne garde en
  // mémoire que les 512 derniers règlements).
  const key = (t: LedgerTrade) => t.resolvedAt ?? t.openedAt;
  last = [...ledger.recentSettled(), ...ledger.openTrades()].sort((a, b) => key(a).localeCompare(key(b))).slice(-LAST);
}
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)} %`);
console.log(`Trades réglés : ${st.n} (${st.wins} gagnés / ${st.losses} perdus) · en cours : ${st.open}`);
console.log(`Taux de réussite : ${pct(st.winRate)} · côté choisi gagnant à l'issue du round : ${pct(st.calibWinRate)} pour ${pct(st.avgModelProb)} annoncés par le modèle (n=${st.calibN})`);
console.log(`PnL : ${st.pnl >= 0 ? '+' : ''}${st.pnl.toFixed(2)} $ · pire baisse : ${st.maxDrawdown.toFixed(2)} $ · série de pertes : ${st.lossStreak}`);
console.log(`Fiabilité : ${reliability(st)}`);
const shPath = join(POLY, 'fv-shadow.json');
if (existsSync(shPath)) {
  try { console.log(shadowLine(shadowStats(JSON.parse(readFileSync(shPath, 'utf8')) as ShadowAggregate))); } catch { /* ignoré */ }
}
const guard = join(POLY, 'fv-guard.json');
if (existsSync(guard)) console.log(`🛑 ARRÊT DE SÉCURITÉ ACTIF : ${readFileSync(guard, 'utf8').trim()}`);
console.log(`\nDerniers trades :`);
for (const t of last) {
  const res = t.status === 'open' ? 'en cours' : `${t.status} ${t.pnl! >= 0 ? '+' : ''}${t.pnl!.toFixed(3)} $`;
  console.log(`  ${t.openedAt.slice(0, 16).replace('T', ' ')}  ${t.coin.padEnd(4)} ${t.side.padEnd(4)}  p=${t.modelProb.toFixed(2)}  coût=${t.costPerShare.toFixed(3)}  mise=${t.stake.toFixed(2)}  ${res}`);
}
