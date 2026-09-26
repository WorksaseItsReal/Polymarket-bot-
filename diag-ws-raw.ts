// TEMP raw WS probe - à supprimer
import WebSocket from 'ws';

const tests: Array<{ label: string; msg: any }> = [
  { label: 'crypto_prices btc/usd', msg: { subscriptions: [{ topic: 'crypto_prices', type: 'update', filters: '{"symbol":"btc/usd"}' }] } },
  { label: 'crypto_prices BTC/USD', msg: { subscriptions: [{ topic: 'crypto_prices', type: 'update', filters: '{"symbol":"BTC/USD"}' }] } },
  { label: 'chainlink BTC/USD', msg: { subscriptions: [{ topic: 'crypto_prices_chainlink', type: 'update', filters: '{"symbol":"BTC/USD"}' }] } },
  { label: 'clob_market agg_orderbook', msg: { subscriptions: [{ topic: 'clob_market', type: 'agg_orderbook', filters: '["8537293540817350446684115966936488095497385935153337225826"]' }] } },
  { label: 'activity trades', msg: { subscriptions: [{ topic: 'activity', type: 'trades' }] } },
];

const label = process.argv[2];
const t = tests.find(x => x.label === label) || tests[0];

const ws = new WebSocket('wss://ws-live-data.polymarket.com/');
let n = 0;
ws.on('open', () => {
  console.log('OPEN -> sending', t.label);
  ws.send(JSON.stringify(t.msg));
});
ws.on('message', (d) => {
  n++;
  if (n <= 4) console.log('RAW:', d.toString().slice(0, 400));
});
ws.on('error', (e) => console.log('ERR', e.message));
setTimeout(() => { console.log('total messages:', n); ws.close(); process.exit(0); }, 25000);
