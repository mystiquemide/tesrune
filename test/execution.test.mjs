import test from 'node:test';
import assert from 'node:assert/strict';
import { closePayload, openPayload, signature } from '../src/execution.mjs';

test('signs Bitget requests with the documented prehash', () => {
  assert.equal(
    signature('secret', '1700000000000', 'POST', '/path', '{"a":1}'),
    'R6vX2n/9dKv4wlFF8BLJfHB1IlhEEsjXnt6Jn1pXpu0='
  );
});

test('builds a hedge-mode short open payload', () => {
  const payload = openPayload({ symbol: 'TSLAUSDT', qty: 0.01 });
  assert.deepEqual(
    { ...payload, clientOid: '<uuid>' },
    {
      symbol: 'TSLAUSDT',
      productType: 'USDT-FUTURES',
      marginMode: 'crossed',
      marginCoin: 'USDT',
      size: '0.01',
      side: 'sell',
      posSide: 'short',
      tradeSide: 'open',
      orderType: 'market',
      clientOid: '<uuid>'
    }
  );
  assert.match(payload.clientOid, /^[0-9a-f-]{36}$/);
});

test('rounds quantities to the contract precision', () => {
  assert.equal(openPayload({ symbol: 'NVDAUSDT', qty: 1.239 }).size, '1.24');
});

test('uses the verified flash-close path for a short', () => {
  assert.deepEqual(closePayload({ symbol: 'TSLAUSDT' }), {
    symbol: 'TSLAUSDT',
    productType: 'USDT-FUTURES',
    holdSide: 'short',
    marginCoin: 'USDT'
  });
});
