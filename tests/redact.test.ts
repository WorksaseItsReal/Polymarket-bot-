/**
 * tests/redact.test.ts — aucun secret dans les logs (clé privée mal saisie, URL RPC, en-têtes CLOB).
 * Exécution : `npx tsx --test tests/redact.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { maskPolyHeaders, secretRedactor } from '../src/services/redact.ts';

const KEY = '0x' + '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

test('clé privée mal saisie : le message d\'erreur d\'ethers ne la contient plus', () => {
  // Les fautes de frappe réelles : un caractère manquant, un « O » pour un « 0 », un espace dans les guillemets.
  for (const typo of [KEY.slice(0, -1), KEY.slice(0, 12) + 'O' + KEY.slice(13), ' ' + KEY, KEY.slice(2, -1)]) {
    let msg = '';
    try { new ethers.Wallet(typo); } catch (err) { msg = (err as Error).message; }
    assert.ok(msg.includes(typo.trim().replace(/^0x/, '').slice(0, 40)), 'ethers recopie bien la valeur (sinon le test ne prouve rien)');
    const out = secretRedactor({ POLYMARKET_PRIVATE_KEY: typo })(`Balance setup error: ${msg}`);
    assert.doesNotMatch(out, /[0-9a-f]{40,}/i, out);
    assert.match(out, /\[masqué\]/);
  }
});

test('clé valide citée avec ou sans 0x, jetons Telegram et dashboard : masqués', () => {
  const r = secretRedactor({ POLYMARKET_PRIVATE_KEY: KEY, TELEGRAM_BOT_TOKEN: '123456789:AAH' + 'x'.repeat(32), DASHBOARD_TOKEN: 'mon-secret-du-dashboard' });
  const out = r(`a ${KEY} b ${KEY.slice(2)} c 123456789:AAH${'x'.repeat(32)} d ?token=mon-secret-du-dashboard`);
  assert.equal(out, 'a [masqué] b [masqué] c [masqué] d ?token=[masqué]');
});

test('URL RPC : la clé d\'API disparaît, l\'hôte reste ; une URL sans clé reste lisible', () => {
  const r = secretRedactor({ POLYGON_RPC_URL: 'https://polygon-mainnet.g.alchemy.com/v2/AbCdEf0123456789XyZ' });
  assert.equal(r('could not detect network (url="https://polygon-mainnet.g.alchemy.com/v2/AbCdEf0123456789XyZ")'),
    'could not detect network (url="https://polygon-mainnet.g.alchemy.com/[masqué]")');
  assert.equal(secretRedactor({ POLYGON_RPC_URL: 'https://1rpc.io/matic' })('url="https://1rpc.io/matic"'), 'url="https://1rpc.io/matic"');
  assert.equal(secretRedactor({ POLYMARKET_PRIVATE_KEY: 'your_private_key_here', DASHBOARD_TOKEN: 'court' })('court'), 'court', 'secret < 12 caractères ignoré');
  assert.equal(secretRedactor({})('rien'), 'rien');
});

test('en-têtes CLOB : identifiants et signatures masqués, adresse conservée', () => {
  const h: Record<string, unknown> = { POLY_API_KEY: 'k', POLY_PASSPHRASE: 'p', POLY_SIGNATURE: 's', POLY_TIMESTAMP: '1', POLY_ADDRESS: '0xabc', 'Content-Type': 'application/json' };
  maskPolyHeaders(h);
  assert.deepEqual(h, { POLY_API_KEY: '[masqué]', POLY_PASSPHRASE: '[masqué]', POLY_SIGNATURE: '[masqué]', POLY_TIMESTAMP: '[masqué]', POLY_ADDRESS: '0xabc', 'Content-Type': 'application/json' });
  maskPolyHeaders(undefined);
  maskPolyHeaders('x');
});
