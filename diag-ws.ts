// TEMP WS probe - à supprimer
import { RealTimeDataClient } from '@polymarket/real-time-data-client';

const variants = [
  { topic: 'crypto_prices', type: 'update', filters: '{"symbol":"btc/usd"}' },
  { topic: 'crypto_prices', type: 'update', filters: '{"symbol":"BTC/USD"}' },
  { topic: 'crypto_prices', type: 'update' },
  { topic: 'crypto_prices_chainlink', type: 'update', filters: '{"symbol":"BTC/USD"}' },
  { topic: 'crypto_prices_chainlink', type: 'update', filters: '{"symbol":"btc/usd"}' },
];

const counts: Record<string, number> = {};

const client = new RealTimeDataClient({
  autoReconnect: false,
  onMessage: (msg: any) => {
    const key = `${msg.topic}|${msg.type}`;
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] <= 3) console.log('MSG', key, JSON.stringify(msg.payload ?? msg).slice(0, 300));
  },
  onConnect: (c: any) => {
    console.log('CONNECTED');
    variants.forEach((v, i) => {
      console.log('subscribing', i, v.topic, v.type, v.filters ?? '');
      setTimeout(() => c.subscribe({ subscriptions: [v] }), 200 * i);
    });
  },
});

client.connect();
setTimeout(() => {
  console.log('=== counts after 30s ===');
  console.log(counts);
  process.exit(0);
}, 30000);
