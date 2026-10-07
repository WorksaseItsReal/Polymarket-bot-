/**
 * Bilan du registre de la stratégie juste valeur (~/.polymarket/fv-ledger.json).
 *
 *   npx tsx scripts/analysis/ledger.ts [--last 15]
 *
 * Lecture seule. Affiche le bilan (même calcul que le bot et Telegram), la mesure
 * « modèle vs carnet » et les derniers trades.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeStats, loadLedger } from '../../src/services/paper-ledger.js';
import { reliability, shadowLine } from '../../src/services/telegram-messages.js';
import { shadowStats, type ShadowAggregate } from '../../src/strategy/shadow-tracker.js';

const POLY = join(process.env.HOME || homedir(), '.polymarket');
const i = process.argv.indexOf('--last');
const LAST = i >= 0 ? Number(process.argv[i + 1]) || 15 : 15;

const trades = loadLedger(join(POLY, 'fv-ledger.json'));
if (trades === null) {
  console.error('fv-ledger.json illisible (fichier préservé).');
  process.exit(1);
}
const st = computeStats(trades);
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)} %`);
console.log(`Trades réglés : ${st.n} (${st.wins} gagnés / ${st.losses} perdus) · en cours : ${st.open}`);
console.log(`Taux de réussite : ${pct(st.winRate)} (attendu par le modèle : ${pct(st.avgModelProb)})`);
console.log(`PnL : ${st.pnl >= 0 ? '+' : ''}${st.pnl.toFixed(2)} $ · pire baisse : ${st.maxDrawdown.toFixed(2)} $ · série de pertes : ${st.lossStreak}`);
console.log(`Fiabilité : ${reliability(st)}`);
const shPath = join(POLY, 'fv-shadow.json');
if (existsSync(shPath)) {
  try { console.log(shadowLine(shadowStats(JSON.parse(readFileSync(shPath, 'utf8')) as ShadowAggregate))); } catch { /* ignoré */ }
}
const guard = join(POLY, 'fv-guard.json');
if (existsSync(guard)) console.log(`🛑 ARRÊT DE SÉCURITÉ ACTIF : ${readFileSync(guard, 'utf8').trim()}`);
console.log(`\nDerniers trades :`);
for (const t of trades.slice(-LAST)) {
  const res = t.status === 'open' ? 'en cours' : `${t.status} ${t.pnl! >= 0 ? '+' : ''}${t.pnl!.toFixed(3)} $`;
  console.log(`  ${t.openedAt.slice(0, 16).replace('T', ' ')}  ${t.coin.padEnd(4)} ${t.side.padEnd(4)}  p=${t.modelProb.toFixed(2)}  coût=${t.costPerShare.toFixed(3)}  mise=${t.stake.toFixed(2)}  ${res}`);
}
