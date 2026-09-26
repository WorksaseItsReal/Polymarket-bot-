import WebSocket from 'ws';
const subs = [
  { topic: 'crypto_prices', type: 'update', filters: '{"symbol":"btc/usd"}' },
  { topic: 'crypto_prices_chainlink', type: 'update', filters: '{"symbol":"BTC/USD"}' },
];
const ws = new WebSocket('wss://ws-live-data.polymarket.com/');
let n = 0;
ws.on('open', () => { console.log('OPEN'); ws.send(JSON.stringify({ subscriptions: subs })); });
ws.on('message', (d) => { n++; if (n <= 3) console.log('MSG', d.toString().slice(0, 200)); });
ws.on('error', (e) => console.log('ERR', (e as Error).message));
setTimeout(() => { console.log('WS MESSAGES RECEIVED (15s) =', n); ws.close(); process.exit(0); }, 15000);
