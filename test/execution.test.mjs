import test from 'node:test';
import assert from 'node:assert/strict';
import { closeOrderId, closePayload, normalizeQty, openOrderId, openPayload, place, signature } from '../src/execution.mjs';

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

test('floors quantities to the contract precision', () => {
  assert.equal(openPayload({ symbol: 'NVDAUSDT', qty: 1.239 }).size, '1.23');
  assert.equal(normalizeQty(0.019), 0.01);
});

test('rejects non-positive and invalid quantities', () => {
  for (const value of [0, -1, NaN, Infinity, 'nope', 0.009]) assert.throws(() => normalizeQty(value));
});

test('uses the verified flash-close path for a short', () => {
  assert.deepEqual(closePayload({ symbol: 'TSLAUSDT' }), {
    symbol: 'TSLAUSDT',
    productType: 'USDT-FUTURES',
    holdSide: 'short',
    marginCoin: 'USDT'
  });
});

test('accepts only explicit successful exchange responses', () => {
  assert.equal(openOrderId({ orderId: 'open-1' }), 'open-1');
  assert.throws(() => openOrderId({}));
  assert.equal(closeOrderId('TSLAUSDT', { successList: [{ symbol: 'TSLAUSDT', orderId: 'close-1' }], failureList: [], result: false }), 'close-1');
  assert.throws(() => closeOrderId('TSLAUSDT', { successList: [], failureList: [{ symbol: 'TSLAUSDT', errorMsg: 'failed' }] }));
});

test('rejects placement before network access without a valid mandate', async () => {
  process.env.TESRUNE_MANDATE_SECRET = 'test-secret-that-is-at-least-32-characters-long';
  await assert.rejects(
    place({ symbol: 'TSLAUSDT', qty: 0.02, unwindAt: '2026-09-22T13:29:00.000Z', eventId: 'event-1' }, 'invalid'),
    /invalid mandate stamp/
  );
});
