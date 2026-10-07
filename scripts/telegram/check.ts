/**
 * Vérifie la connexion Telegram du bot et envoie un message de test.
 *
 *   npx tsx scripts/telegram/check.ts
 *
 * Lit TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID dans .env. Code de sortie 0 si le message
 * de test est parti, 1 sinon (avec la marche à suivre).
 */
import 'dotenv/config';
import { TelegramClient, telegramConfigFromEnv } from '../../src/services/telegram.js';

async function main(): Promise<number> {
  const cfg = telegramConfigFromEnv(process.env);
  if (!cfg) {
    console.error('❌ Telegram non configuré : renseigne TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID dans .env (et TELEGRAM_ENABLED≠false).');
    return 1;
  }
  const client = new TelegramClient({ ...cfg, log: (_l, m) => console.error(`   ${m}`) });
  const check = await client.check();
  if (!check.ok) {
    console.error(`❌ ${check.detail}`);
    return 1;
  }
  console.log(`✅ ${check.detail}`);
  client.send('✅ <b>Test de connexion</b> — le bot Polymarket peut t\'envoyer ses notifications.');
  await client.flush();
  if (client.stats.sent !== 1) {
    console.error('❌ Le message de test n\'a pas pu être envoyé (voir ci-dessus).');
    return 1;
  }
  console.log('✅ Message de test envoyé : vérifie ton Telegram.');
  return 0;
}

main().then(code => process.exit(code));
