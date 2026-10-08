/**
 * Diagnostic d'installation du bot (configuration, fichiers, réseau, Telegram).
 *
 *   npm run doctor
 *
 * Code de sortie 1 s'il y a au moins une erreur (❌). Ne modifie rien.
 */
import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configChecks, fileChecks, networkChecks, summarize, type Check } from '../src/services/doctor.js';
import { TelegramClient, telegramConfigFromEnv } from '../src/services/telegram.js';

async function main(): Promise<number> {
  const poly = join(process.env.HOME || homedir(), '.polymarket');
  const checks: Check[] = [...configChecks(process.env), ...fileChecks(poly, process.cwd())];
  console.log('Vérification du réseau (quelques secondes)…\n');
  checks.push(...await networkChecks((...a: Parameters<typeof fetch>) => fetch(...a), Date.now()));
  const tg = telegramConfigFromEnv(process.env);
  if (tg) {
    const r = await new TelegramClient({ ...tg, log: () => undefined }).check();
    checks.push({ level: r.ok ? 'ok' : 'error', label: 'Telegram (connexion)', detail: r.detail });
  }
  const s = summarize(checks);
  console.log(s.text);
  console.log(`\n${s.errors ? `❌ ${s.errors} erreur(s)` : '✅ aucune erreur'}${s.warnings ? `, ⚠️ ${s.warnings} avertissement(s)` : ''}.`
    + (s.errors ? ' Corriger les ❌ avant de lancer le bot.' : ''));
  return s.errors ? 1 : 0;
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
