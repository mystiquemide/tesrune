import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_PATH = join(process.env.TESRUNE_DATA_DIR ?? join(ROOT, 'data'), 'mandate.key');
let cachedSecret;

function secret() {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.TESRUNE_MANDATE_SECRET;
  if (configured && configured.length >= 32) cachedSecret = configured;
  if (!cachedSecret && existsSync(KEY_PATH)) cachedSecret = readFileSync(KEY_PATH, 'utf8').trim();
  if (!cachedSecret) {
    cachedSecret = randomBytes(32).toString('hex');
    mkdirSync(dirname(KEY_PATH), { recursive: true });
    writeFileSync(KEY_PATH, `${cachedSecret}\n`, { mode: 0o600 });
  }
  if (cachedSecret.length < 32) throw new Error('Mandate secret must contain at least 32 characters');
  return cachedSecret;
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
