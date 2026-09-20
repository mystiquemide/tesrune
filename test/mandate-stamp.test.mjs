import test from 'node:test';
import assert from 'node:assert/strict';
import { createMandateStamp, verifyMandateStamp } from '../src/mandate-stamp.mjs';

process.env.TESRUNE_MANDATE_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const order = {
  symbol: 'TSLAUSDT',
  qty: 0.02,
  side: 'sell',
  posSide: 'short',
  unwindAt: '2026-09-22T13:29:00.000Z',
  eventId: 'event-1'
};

test('validates an unchanged mandate', () => {
  const stamp = createMandateStamp(order);
  assert.equal(verifyMandateStamp(order, stamp), true);
});

test('rejects a changed quantity', () => {
  const stamp = createMandateStamp(order);
  assert.equal(verifyMandateStamp({ ...order, qty: 0.03 }, stamp), false);
});

test('rejects malformed stamps', () => {
  assert.equal(verifyMandateStamp(order, 'invalid'), false);
});
