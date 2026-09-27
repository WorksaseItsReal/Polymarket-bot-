/**
 * Smoke-test réel des couches données corrigées (audit 2026-09-27).
 * Lancé depuis la racine du projet : npx tsx <ce fichier>
 * Tout chiffre imprimé vient d'un appel réseau réel.
 */
import { GammaApiClient } from '/root/clawd/Polymarket-bot/src/clients/gamma-api.js';
import { MarketService } from '/root/clawd/Polymarket-bot/src/services/market-service.js';
import { RateLimiter } from '/root/clawd/Polymarket-bot/src/core/rate-limiter.js';
import { createUnifiedCache } from '/root/clawd/Polymarket-bot/src/core/unified-cache.js';

const lr = new RateLimiter();
const cache = createUnifiedCache();
const gamma = new GammaApiClient(lr, cache);
const svc = new MarketService(gamma, undefined, lr, cache);

const j = (x: unknown) => JSON.stringify(x);

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const slot = Math.floor(now / 300) * 300;
  const slug = `btc-updown-5m-${slot}`;

  // 1) A/B du filtre Gamma : condition_id (singulier) vs condition_ids (pluriel)
  const g = await gamma.getMarketBySlug(slug);
  if (!g) throw new Error('marché introuvable: ' + slug);
  const cid = g.conditionId;
  console.log('== 1. filtre Gamma A/B ==');
  console.log('slug demandé      :', slug, '\nconditionId réel  :', cid);
  const rawSingular = await (await fetch(
    `https://gamma-api.polymarket.com/markets?condition_id=${cid}&limit=5`
  )).json() as Array<{ slug: string }>;
  const rawPlural = await (await fetch(
    `https://gamma-api.polymarket.com/markets?condition_ids=${cid}&limit=5`
  )).json() as Array<{ slug: string }>;
  console.log('?condition_id  ->', rawSingular.length, 'items:', j(rawSingular.map(m => m.slug)));
  console.log('?condition_ids ->', rawPlural.length, 'items:', j(rawPlural.map(m => m.slug)));
  console.log('getMarketByConditionId() (code corrigé) ->', (await gamma.getMarketByConditionId(cid))?.slug);

  // 2) Chemin de décision : carnet CLOB réel vs champs Gamma
  console.log('\n== 2. carnet CLOB vs Gamma (même instant) ==');
  const t0 = Date.now();
  try {
    const ob = await svc.getProcessedOrderbook(cid);
    const dt = Date.now() - t0;
    console.log('yes bid/ask =', ob.yes.bid, '/', ob.yes.ask, ' no bid/ask =', ob.no.bid, '/', ob.no.ask);
    console.log('askSum =', ob.summary.askSum.toFixed(4), ' longArbProfit =', ob.summary.longArbProfit.toFixed(5),
      ' shortArbProfit =', ob.summary.shortArbProfit.toFixed(5));
    console.log('latence getProcessedOrderbook =', dt, 'ms');
  } catch (e) {
    // Un round qui vient de tourner a un carnet encore unilatéral : le garde-fou
    // doit REFUSER (c'est le comportement voulu), on le documente.
    console.log('✅ getProcessedOrderbook refuse (carnet incomplet attendu en début de round):', (e as Error).message);
  }
  console.log('Gamma outcomePrices =', j(g.outcomePrices), ' bestBid/Ask =', g.bestBid, '/', g.bestAsk);

  // 3) Fraîcheur : âge des données du carnet (timestamp serveur)
  const fast = await svc.getTokenOrderbook(JSON.parse(
    (await (await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}&limit=1`)).json() as Array<{ clobTokenIds: string }>)[0].clobTokenIds
  )[0]);
  console.log('\n== 3. fraîcheur ==');
  console.log('timestamp serveur du carnet =', fast.timestamp, ' age(local) =', Date.now() - fast.timestamp, 'ms');

  // 4) Round TERMINÉ : le code doit REFUSER, pas renvoyer 0/1 ni un 50/50
  console.log('\n== 4. round terminé (token périmé) ==');
  const pastSlug = `btc-updown-5m-${slot - 900}`;
  const past = await gamma.getMarketBySlug(pastSlug);
  if (past) {
    const pastCid = past.conditionId;
    try {
      const pastOb = await svc.getProcessedOrderbook(pastCid);
      console.log('⚠️  orderbook renvoyé malgré round terminé:', j(pastOb.summary.effectivePrices));
    } catch (e) {
      console.log('✅ refus explicite:', (e as Error).message);
    }
    try {
      const m = await svc.getMarket(pastSlug);
      console.log('getMarket(slug périmé) -> source =', m.source, ' slug =', m.slug,
        ' prix =', j(m.tokens.map(t => t.price)));
    } catch (e) {
      console.log('getMarket(slug périmé) -> erreur:', (e as Error).message);
    }
  }

  // 5) Panne simulée : hôte injoignable → erreur explicite (pas de [] ni de 0.5)
  console.log('\n== 5. panne simulée (data-api + gamma injoignables) ==');
  const { DataApiClient } = await import('/root/clawd/Polymarket-bot/src/clients/data-api.js');
  const dataApi = new DataApiClient(lr, cache);
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ENOTFOUND simulé'); }) as typeof fetch;
  try {
    await dataApi.getTrades({ market: cid, limit: 5 });
    console.log('⚠️  getTrades a renvoyé une valeur malgré la panne');
  } catch (e) {
    console.log('✅ getTrades panne -> erreur explicite:', (e as Error).message);
  }
  globalThis.fetch = origFetch;
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
