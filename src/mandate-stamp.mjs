import { createHmac, timingSafeEqual } from 'node:crypto';

function secret() {
  const value = process.env.TESRUNE_MANDATE_SECRET;
  if (!value || value.length < 32) throw new Error('TESRUNE_MANDATE_SECRET must contain at least 32 characters');
  return value;
}

function canonical(order) {
  return JSON.stringify({
    symbol: order.symbol,
    qty: Number(order.qty),
    side: order.side,
    posSide: order.posSide,
    unwindAt: order.unwindAt,
    eventId: order.eventId
  });
}

export function createMandateStamp(order) {
  return createHmac('sha256', secret()).update(canonical(order)).digest('hex');
}

export function verifyMandateStamp(order, stamp) {
  if (typeof stamp !== 'string' || !/^[0-9a-f]{64}$/.test(stamp)) return false;
  const expected = createMandateStamp(order);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(stamp, 'hex'));
}
