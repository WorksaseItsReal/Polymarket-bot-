import { GammaApiClient } from '/root/clawd/Polymarket-bot/src/clients/gamma-api.js';
import { MarketService } from '/root/clawd/Polymarket-bot/src/services/market-service.js';
import { RateLimiter } from '/root/clawd/Polymarket-bot/src/core/rate-limiter.js';
import { createUnifiedCache } from '/root/clawd/Polymarket-bot/src/core/unified-cache.js';
const lr = new RateLimiter(); const cache = createUnifiedCache();
const gamma = new GammaApiClient(lr, cache); const svc = new MarketService(gamma, undefined, lr, cache);
(async () => {
  const slot = Math.floor(Date.now()/1000/300)*300;
  for (const c of ['btc','eth','sol','xrp','doge']) {
    const slug = `${c}-updown-5m-${slot}`;
    const g = await gamma.getMarketBySlug(slug);
    if (!g) { console.log(slug, 'introuvable'); continue; }
    const m = await svc.getMarket(slug);
    const clob = await svc.getClobMarket(g.conditionId);
    const books = await Promise.all((clob?.tokens ?? []).map(t => svc.getTokenOrderbook(t.tokenId).catch(e => ({err:(e as Error).message}))));
    const bb = books.map((b:any) => b.err ? 'ERR' : `${b.bids[0]?.price}/${b.asks[0]?.price}`);
    console.log(`${slug}\n  UnifiedMarket.tokens[].price (source=${m.source}) = ${JSON.stringify(m.tokens.map(t=>t.price))}`);
    console.log(`  CLOB /markets tokens[].price                    = ${JSON.stringify(clob?.tokens.map(t=>t.price))}`);
    console.log(`  GAMMA outcomePrices                             = ${JSON.stringify(g.outcomePrices)}`);
    console.log(`  CARNET CLOB réel bid/ask                        = ${JSON.stringify(bb)}`);
  }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
