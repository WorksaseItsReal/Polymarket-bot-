/**
 * Point d'entrée du bot papier « Up or Down 5 min » (nom conservé pour PM2 : voir
 * ecosystem.config.cjs). Tout le câblage est dans src/bot/app.ts.
 *
 *   npx tsx bot-with-dashboard.ts        (ou : pm2 start ecosystem.config.cjs)
 */
import 'dotenv/config';
import { main } from './src/bot/app.js';

main().catch((err) => {
  console.error('Fatal:', err?.message ?? err);
  console.error(err);
  process.exit(1);
});
