/**
 * Répétition de la migration fv-ledger.json → fv-ledger.jsonl sur une COPIE du registre.
 *
 *   npm run ledger:check-migration -- <copie de fv-ledger.json> [--keep]
 *   npx tsx scripts/analysis/ledger-migration-check.ts <copie de fv-ledger.json> [--keep]
 *
 * À lancer AVANT de redémarrer le bot sur la nouvelle version (qui migre au démarrage) : le
 * fichier donné est seulement LU ; il est recopié dans un dossier temporaire où la migration
 * tourne exactement comme au démarrage du bot (écriture, fsync, rejeu, comparaison de TOUTES
 * les statistiques à computeStats, renommages). Rien n'est jamais écrit à côté du fichier
 * donné. Le dossier temporaire est supprimé à la fin (--keep pour le garder).
 *
 * Affiche tailles, nombre de trades, durées (migration, rejeu au démarrage, une ouverture +
 * un règlement après migration) et OK/KO. Code de sortie : 0 si OK, 1 sinon.
 */
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { LedgerStore, compareToReference, migrateLegacyLedger, readLegacyLedger } from '../../src/services/ledger-store.js';
import type { LedgerTrade } from '../../src/services/paper-ledger.js';

const args = process.argv.slice(2);
const source = args.find(a => !a.startsWith('--'));
if (!source) {
  console.error('Usage : npm run ledger:check-migration -- <copie de fv-ledger.json> [--keep]');
  process.exit(1);
}
const src = resolve(source);
const mo = (b: number) => `${(b / 1e6).toFixed(2)} Mo`;
const ms = (x: number) => `${x.toFixed(x < 10 ? 2 : 0)} ms`;

/** Échec attendu (message clair, sans pile) ; process.exit dans le try sauterait le ménage. */
class Ko extends Error {}

let ok = false;
const dir = mkdtempSync(join(tmpdir(), 'ledger-migration-check-'));
try {
  const legacy = join(dir, 'fv-ledger.json');
  const journal = join(dir, 'fv-ledger.jsonl');
  copyFileSync(src, legacy); // seule opération sur le fichier donné : une lecture
  console.log(`Registre lu : ${src} (${mo(statSync(src).size)}) — copie de travail : ${dir}`);

  const trades = readLegacyLedger(legacy);
  if (trades === null) throw new Ko('fichier illisible (le bot ne le migrerait pas et n\'ouvrirait aucune position)');
  const strategies = trades.reduce((m, t) => m.set(t.strategy ?? 'fv', (m.get(t.strategy ?? 'fv') ?? 0) + 1), new Map<string, number>());
  console.log(`Trades : ${trades.length} (${[...strategies].map(([k, n]) => `${k} ${n}`).join(', ') || 'aucun'}), en cours : ${trades.filter(t => t.status === 'open').length}`);

  // 1. Migration, exactement celle du démarrage du bot (vérification comprise).
  const t0 = performance.now();
  const mig = migrateLegacyLedger(legacy, journal);
  const tMig = performance.now() - t0;
  if (mig.status !== 'migre') throw new Ko(`migration ${mig.status}${'detail' in mig ? ` — ${mig.detail}` : ''}`);
  console.log(`Migration : ${ms(tMig)} (écriture ${ms(mig.ms.write)}, rejeu + comparaison ${ms(mig.ms.verify)}) → ${basename(journal)} ${mo(statSync(journal).size)}, ancien conservé sous ${basename(mig.archivedAs)}`);

  // 2. Rejeu comme au démarrage du bot (registre neuf sur le fichier migré), comparé à nouveau.
  const t1 = performance.now();
  const store = new LedgerStore(journal);
  const writer = store.openWriter();
  const tReplay = performance.now() - t1;
  if (!writer.ok) throw new Ko(`registre migré non ouvrable en écriture (${writer.reason})`);
  const diffs = compareToReference(trades, store, Date.now());
  if (store.loadIssues.length) diffs.push(...store.loadIssues);
  console.log(`Rejeu au démarrage : ${ms(tReplay)}`);

  // 3. Une ouverture + un règlement après migration (ce que fait le bot à chaque trade).
  const now = Date.now();
  const probe: LedgerTrade = {
    id: `controle-migration-${now}`, slug: `btc-updown-5m-${Math.floor(now / 300_000) * 300}`, coin: 'BTC', side: 'UP', stake: 1,
    costPerShare: 0.6, shares: 1 / 0.6, modelProb: 0.7, edge: 0.1, openedAt: new Date(now).toISOString(), endMs: now + 60_000,
    status: 'open', pnl: null,
  };
  const before = store.stats();
  const t2 = performance.now();
  store.open(probe);
  const tOpen = performance.now() - t2;
  const t3 = performance.now();
  store.patch(probe.id, { status: 'won', pnl: probe.shares - probe.stake, resolvedAt: new Date(now + 1).toISOString(), outcomeUpWon: true }, { ifStatus: 'open' });
  const tSettle = performance.now() - t3;
  const after = store.stats();
  if (after.n !== before.n + 1 || Math.abs(after.pnl - before.pnl - (probe.shares - probe.stake)) > 1e-9) diffs.push('trade de contrôle mal compté après migration');
  store.close();
  console.log(`Après migration : ouverture ${ms(tOpen)}, règlement ${ms(tSettle)} (une ligne ajoutée + fsync chacun)`);

  if (diffs.length) {
    console.log(`KO : ${diffs.length} écart(s)\n  ${diffs.slice(0, 20).join('\n  ')}`);
  } else {
    ok = true;
    console.log(`OK : statistiques identiques (total, juste valeur, récolte : ${Object.keys(before).length} champs), positions ouvertes et PnL du jour/mois.`);
  }
} catch (err) {
  console.log(`KO : ${err instanceof Ko ? err.message : (err as Error).stack ?? err}`);
} finally {
  if (args.includes('--keep')) console.log(`Dossier de travail gardé : ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
