// TEMP diagnostic script - à supprimer après usage
import 'dotenv/config';
import { PolymarketSDK } from './src/index.js';

async function main() {
  const sdk = await PolymarketSDK.create({ privateKey: process.env.POLYMARKET_PRIVATE_KEY });

  console.log('--- 1) scanCryptoShortTermMarkets (coin all, 5m, 0..6min, limit 8) ---');
  const gm = await sdk.markets.scanCryptoShortTermMarkets({
    coin: 'all', duration: '5m', minMinutesUntilEnd: 0, maxMinutesUntilEnd: 6, limit: 8, sortBy: 'endDate',
  });
  console.log('count', gm.length);
  for (const m of gm) {
    console.log('  market:', m.slug, '| end', m.endDate, '| active', m.active, '| closed', m.closed, '| cond', (m.conditionId || '').slice(0, 18));
  }

  console.log('\n--- 2) dipArb.scanUpcomingMarkets (résolution des tokenIds) ---');
  const up = await sdk.dipArb.scanUpcomingMarkets({ coin: 'all', duration: '5m', minMinutesUntilEnd: 0, maxMinutesUntilEnd: 6, limit: 8 });
  console.log('count', up.length);
  for (const m of up) console.log('  ', m.slug, m.underlying, 'up=', m.upTokenId.slice(0, 16), 'down=', m.downTokenId.slice(0, 16), 'end', m.endTime);

  console.log('\n--- 3) getOrderbook par marché (chemin du bot) ---');
  for (const m of up.slice(0, 8)) {
    try {
      const ob = await sdk.getOrderbook(m.conditionId);
      console.log('  OK', m.slug, 'yes.ask', ob.yes?.ask, 'no.ask', ob.no?.ask, 'bidDepth', ob.yes?.bidDepth, 'askDepth', ob.yes?.askDepth);
    } catch (e: any) {
      console.log('  FAIL', m.slug, '->', e?.message || e);
    }
  }

  console.log('\n--- 4) WS Chainlink prices (BTC/USD ETH/USD SOL/USD XRP/USD DOGE/USD) 20s ---');
  const rs: any = (sdk as any).realtime;
  if (!rs) { console.log('  realtime service introuvable sur le sdk, skip'); }
  else {
    rs.connect?.();
    let n = 0;
    const got: Record<string, number> = {};
    rs.subscribeCryptoChainlinkPrices(['BTC/USD','ETH/USD','SOL/USD','XRP/USD','DOGE/USD'], {
      onPrice: (p: any) => { n++; got[p.symbol] = p.price; console.log('  price', p.symbol, p.price); },
    });
    await new Promise(r => setTimeout(r, 20000));
    console.log('  received', n, got);
  }
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
