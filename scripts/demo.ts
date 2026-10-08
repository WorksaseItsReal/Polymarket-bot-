/**
 * Démo hors ligne : le VRAI bot sur un marché SIMULÉ (horloge ×10, carnet en retard), pour
 * voir le dashboard et le fonctionnement avant de déployer.
 *
 *   npm run demo            puis ouvrir http://127.0.0.1:3002   (Ctrl+C pour arrêter)
 *
 * Isolée de tout : dossier de données temporaire (jamais ~/.polymarket), aucune clé de
 * wallet, Telegram coupé (et intercepté par le faux réseau), aucun accès Internet. Les
 * paris et résultats affichés sont FICTIFS (monde simulé où le carnet a 45 s de retard :
 * le bot y gagne, ce qui ne dit RIEN du vrai Polymarket).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'polymarket-demo-'));
const port = process.env.DEMO_PORT || '3002';
if (!existsSync(join(repo, 'dashboard', 'dist', 'index.html'))) {
  console.log('⚠️  Interface du dashboard non construite : (cd dashboard && npm install && npm run build)\n');
}
console.log(`Démo hors ligne (données dans ${home}) — dashboard : http://127.0.0.1:${port}\n`
  + 'Monde SIMULÉ, horloge ×10 : résultats fictifs, sans valeur de preuve. Ctrl+C pour arrêter.\n');
const child = spawn(process.execPath, ['--import', 'tsx', '--import', './tests/fixtures/fake-live-net.ts', 'bot-with-dashboard.ts'], {
  stdio: 'inherit',
  cwd: repo,
  env: {
    ...process.env,
    // .env ignoré : la démo ne dépend d'aucun réglage ni secret du serveur
    DOTENV_CONFIG_PATH: '/dev/null',
    HOME: home, DRY_RUN: 'true', PAPER_CAPITAL: '1000', FV_POLL_SEC: '5', FV_SPOT_STREAM: 'false',
    // vides, en plus : rien de réel même si ces variables existent dans l'environnement
    TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', TELEGRAM_ENABLED: 'false', POLYMARKET_PRIVATE_KEY: '',
    DIPARB_ENABLED: 'false', SMARTMONEY_ENABLED: 'false', ARBITRAGE_ENABLED: 'false',
    DASHBOARD_PORT: port, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_TOKEN: '',
    FAKE_TIME_SPEED: process.env.FAKE_TIME_SPEED || '10', FAKE_BOOK_LAG_SEC: '45',
  },
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
child.on('exit', code => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* dossier temporaire */ }
  process.exit(code ?? 0);
});
