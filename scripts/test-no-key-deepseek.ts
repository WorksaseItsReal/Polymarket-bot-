// Test du module DeepSeek en mode dégradé SANS clé (réseau jamais appelé)
import { analyzeMarket, isEnabled } from '../src/deepseek-analyzer.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

async function main() {
  // Forcer une clé vide et désactivé, pour garantir le mode dégradé
  process.env.DEEPSEEK_API_KEY = '';
  process.env.DEEPSEEK_ANALYZER_ENABLED = 'false';

  // Nettoie le budget pour un test reproductible
  const budgetFile = join(homedir(), '.polymarket', 'llm-calls.json');
  if (existsSync(budgetFile)) unlinkSync(budgetFile);

  const enabled = isEnabled();
  console.log('isEnabled() =', enabled, '(attendu false)');

  const t0 = Date.now();
  const res = await analyzeMarket({
    marketId: 'test-123',
    question: 'Will BTC be above 100k by Dec 2026?',
    orderbook: {
      yes: { ask: 0.45, bid: 0.44, bidDepth: 5000, askDepth: 6000 },
      no: { ask: 0.56, bid: 0.55, bidDepth: 4000, askDepth: 5000 },
    },
    priceHistory: [{ price: 0.40 }, { price: 0.42 }, { price: 0.44 }],
    news: 'No news.',
    liquidityUsd: 5000,
    spreadPct: 0.02,
  });
  const ms = Date.now() - t0;

  console.log('Résultat:', JSON.stringify(res, null, 2));
  console.log('Temps écoulé (ms):', ms);
  console.log('Dégradé (réseau non appelé):', res.degraded, '(attendu true)');
  console.log('Recommendation:', res.recommendation, '(attendu HOLD)');

  const ok = !enabled && res.degraded && res.recommendation === 'HOLD' && ms < 200;
  console.log('\nTEST PASSÉ:', ok ? 'OUI ✅' : 'NON ❌');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('Erreur inattendue:', e);
  process.exit(1);
});