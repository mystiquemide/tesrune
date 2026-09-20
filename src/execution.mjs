import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMandateStamp } from './mandate-stamp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'data', 'orders.jsonl');
const BASE = 'https://api.bitget.com';
let envLoaded = false;

async function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  try {
    const text = await readFile(join(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
    }
  } catch {}
}

async function credentials() {
  await loadEnv();
  const key = process.env.BITGET_PAPER_API_KEY;
  const secret = process.env.BITGET_PAPER_SECRET_KEY;
  const passphrase = process.env.BITGET_PAPER_PASSPHRASE;
  if (!key || !secret || !passphrase) throw new Error('Bitget demo credentials are not configured');
  return { key, secret, passphrase };
}

export function signature(secret, timestamp, method, path, body = '') {
  return createHmac('sha256', secret).update(`${timestamp}${method}${path}${body}`).digest('base64');
}

async function log(entry) {
  await mkdir(dirname(LOG), { recursive: true });
  await appendFile(LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

async function request(path, { method = 'GET', body, auth = true, paper = true } = {}) {
  const bodyText = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', locale: 'en-US' };
  if (paper) headers.paptrading = '1';
  if (auth) {
    const creds = await credentials();
    const timestamp = Date.now().toString();
    Object.assign(headers, {
      'ACCESS-KEY': creds.key,
      'ACCESS-SIGN': signature(creds.secret, timestamp, method, path, bodyText),
      'ACCESS-PASSPHRASE': creds.passphrase,
      'ACCESS-TIMESTAMP': timestamp
    });
  }
  const response = await fetch(`${BASE}${path}`, { method, headers, body: bodyText || undefined, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Bitget demo returned HTTP ${response.status} with a non-JSON response`);
  }
  if (!response.ok || json.code !== '00000') throw new Error(`Bitget demo ${json.code ?? response.status}: ${json.msg ?? response.statusText}`);
  return json.data;
}

export function normalizeQty(qty) {
  const value = Number(qty);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Quantity must be a positive finite number');
  const floored = Math.floor((value + Number.EPSILON) * 100) / 100;
  if (floored <= 0) throw new Error('Quantity is below the 0.01 contract increment');
  return floored;
}

export function openPayload({ symbol, qty }) {
  return {
    symbol,
    productType: 'USDT-FUTURES',
    marginMode: 'crossed',
    marginCoin: 'USDT',
    size: normalizeQty(qty).toFixed(2),
    side: 'sell',
    posSide: 'short',
    tradeSide: 'open',
    orderType: 'market',
    clientOid: randomUUID()
  };
}

export function closePayload({ symbol }) {
  return {
    symbol,
    productType: 'USDT-FUTURES',
    holdSide: 'short',
    marginCoin: 'USDT'
  };
}

export async function account() {
  const rows = await request('/api/v2/mix/account/accounts?productType=USDT-FUTURES');
  return rows?.[0] ?? null;
}

export async function positions() {
  return request('/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
}

export async function contracts() {
  return request('/api/v2/mix/market/contracts?productType=USDT-FUTURES', { auth: false });
}

export async function ticker(symbol) {
  const rows = await request(`/api/v2/mix/market/ticker?productType=USDT-FUTURES&symbol=${encodeURIComponent(symbol)}`, { auth: false });
  return rows?.[0] ?? null;
}

export async function previewOpen(input) {
  const payload = openPayload(input);
  const mark = await ticker(payload.symbol);
  const contractRows = await contracts();
  const contract = contractRows.find(({ symbol }) => symbol === payload.symbol);
  if (!contract) throw new Error(`${payload.symbol} is not listed on the Bitget demo engine`);
  const qty = Number(payload.size);
  if (qty < Number(contract.minTradeNum)) throw new Error(`Quantity is below ${contract.minTradeNum}`);
  const notional = qty * Number(mark.markPrice ?? mark.lastPr);
  if (notional < Number(contract.minTradeUSDT)) throw new Error(`Notional is below ${contract.minTradeUSDT} USDT`);
  const result = { dryRun: true, endpoint: 'POST /api/v2/mix/order/place-order', payload, mark: Number(mark.markPrice ?? mark.lastPr), notional };
  await log({ phase: 'dry_run', ...result });
  return result;
}

export function openOrderId(response) {
  if (!response?.orderId) throw new Error('Bitget demo accepted the request without returning an order id');
  return response.orderId;
}

export function closeOrderId(symbol, response) {
  const failures = response?.failureList ?? [];
  const success = (response?.successList ?? []).find((item) => item.symbol === symbol);
  if (failures.length || !success?.orderId) throw new Error(`Bitget demo did not close ${symbol}: ${JSON.stringify(failures)}`);
  return success.orderId;
}

export async function place(order, stamp) {
  const authorized = {
    symbol: order.symbol,
    qty: normalizeQty(order.qty),
    side: 'sell',
    posSide: 'short',
    unwindAt: order.unwindAt,
    eventId: order.eventId
  };
  if (!verifyMandateStamp(authorized, stamp)) throw new Error('Order rejected: invalid mandate stamp');
  const dryRun = await previewOpen(authorized);
  const response = await request('/api/v2/mix/order/place-order', { method: 'POST', body: dryRun.payload });
  const orderId = openOrderId(response);
  const result = { phase: 'open', symbol: authorized.symbol, qty: authorized.qty, unwindAt: authorized.unwindAt, eventId: authorized.eventId, orderId, request: dryRun.payload, response };
  await log(result);
  return result;
}

export async function close(input) {
  const payload = closePayload(input);
  const response = await request('/api/v2/mix/order/close-positions', { method: 'POST', body: payload });
  const orderId = closeOrderId(input.symbol, response);
  const result = { phase: 'close', symbol: input.symbol, orderId, request: payload, response };
  await log(result);
  return result;
}

async function cli() {
  const [command, symbol = 'TSLAUSDT', qty = '0.01'] = process.argv.slice(2);
  if (command === '--check') {
    const [accountState, openPositions, market] = await Promise.all([account(), positions(), ticker(symbol)]);
    console.log(JSON.stringify({ accountEquity: Number(accountState?.accountEquity ?? 0), available: Number(accountState?.available ?? 0), positions: openPositions.filter((item) => Number(item.total ?? 0) !== 0), ticker: market }, null, 2));
    return;
  }
  if (command === '--dry-run') {
    console.log(JSON.stringify(await previewOpen({ symbol, qty }), null, 2));
    return;
  }
  if (command === '--close') {
    console.log(JSON.stringify(await close({ symbol }), null, 2));
    return;
  }
  throw new Error('Use --check [symbol], --dry-run SYMBOL QTY, or --close SYMBOL. Opening requires a mandate stamp through the cycle runner.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
