/** Round TERMINÉ : le code doit refuser, pas fabriquer 0/1 ni 50/50. */
import { GammaApiClient } from '/root/clawd/Polymarket-bot/src/clients/gamma-api.js';
import { MarketService } from '/root/clawd/Polymarket-bot/src/services/market-service.js';
import { RateLimiter } from '/root/clawd/Polymarket-bot/src/core/rate-limiter.js';
import { createUnifiedCache } from '/root/clawd/Polymarket-bot/src/core/unified-cache.js';

const lr = new RateLimiter();
const cache = createUnifiedCache();
const gamma = new GammaApiClient(lr, cache);
const svc = new MarketService(gamma, undefined, lr, cache);
const j = (x: unknown) => JSON.stringify(x);

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const slot = Math.floor(now / 300) * 300 - 300; // round PRÉCÉDENT (terminé)
  for (const c of ['btc', 'eth']) {
    const slug = `${c}-updown-5m-${slot}`;
    const g = await gamma.getMarketBySlug(slug);
    console.log(`\n--- ${slug} (active=${g?.active} closed=${g?.closed}) ---`);
    console.log('Gamma outcomePrices =', j(g?.outcomePrices), ' bestBid/Ask =', g?.bestBid, '/', g?.bestAsk,
      ' pricesMissing =', g?.pricesMissing, ' endDateMissing =', g?.endDateMissing);
    if (!g) continue;
    try {
      const ob = await svc.getProcessedOrderbook(g.conditionId);
      console.log('⚠️  orderbook renvoyé sur round terminé:', j({
        yes: { bid: ob.yes.bid, ask: ob.yes.ask }, no: { bid: ob.no.bid, ask: ob.no.ask },
        longArbProfit: ob.summary.longArbProfit, shortArbProfit: ob.summary.shortArbProfit,
      }));
    } catch (e) {
      console.log('✅ getProcessedOrderbook refuse:', (e as Error).message);
    }
    try {
      const m = await svc.getMarket(slug);
      console.log('   getMarket -> source =', m.source, ' slug =', m.slug, ' prix =', j(m.tokens.map(t => t.price)),
        ' endDate =', m.endDate?.toISOString());
    } catch (e) {
      console.log('   getMarket -> erreur explicite:', (e as Error).message);
    }
  }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
