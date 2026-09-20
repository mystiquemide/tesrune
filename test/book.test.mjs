import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHoldings, parseHoldingsRules, resolveHoldings, validateHoldings } from '../src/book.mjs';

const dependencies = {
  getDemoContracts: async () => ['TSLAUSDT', 'NVDAUSDT', 'MSTRUSDT'].map((symbol) => ({ symbol, minTradeNum: '0.01', sizeMultiplier: '0.01', minTradeUSDT: '5', maxLever: '25' })),
  getLiveContracts: async () => ['TSLAUSDT', 'NVDAUSDT', 'MSTRUSDT', 'COSTUSDT'].map((symbol) => ({ symbol })),
  getTicker: async (symbol) => ({ symbol, markPrice: { TSLAUSDT: '364.25', NVDAUSDT: '220.90', MSTRUSDT: '152.36' }[symbol] }),
  getPositions: async () => [{ symbol: 'TSLAUSDT', holdSide: 'short', total: '10' }, { symbol: 'TSLAUSDT', holdSide: 'long', total: '5' }]
};

test('parses a natural-language book with a shared broker', () => {
  assert.deepEqual(parseHoldingsRules('100 TSLA, 40 NVDA and 25 MSTR at IBKR'), [
    { ticker: 'TSLA', qty: 100, broker: 'IBKR' },
    { ticker: 'NVDA', qty: 40, broker: 'IBKR' },
    { ticker: 'MSTR', qty: 25, broker: 'IBKR' }
  ]);
});

test('supports shares-of phrasing and fractional holdings', () => {
  assert.deepEqual(parseHoldingsRules('2.5 shares of AAPL; 10 META'), [
    { ticker: 'AAPL', qty: 2.5, broker: undefined },
    { ticker: 'META', qty: 10, broker: undefined }
  ]);
});

test('merges duplicate tickers and rejects invalid books', () => {
  assert.deepEqual(validateHoldings([{ ticker: 'tsla', qty: 2 }, { ticker: 'TSLA', qty: 3 }]), [{ ticker: 'TSLA', qty: 5, broker: undefined }]);
  assert.throws(() => validateHoldings([{ ticker: 'TSLA', qty: 0 }]));
  assert.throws(() => validateHoldings([{ ticker: '../X', qty: 1 }]));
});

test('parsing requires confirmation before persistence', async () => {
  const parsed = await parseHoldings('100 TSLA', { useQwen: false });
  assert.equal(parsed.needsConfirm, true);
  assert.equal(parsed.source, 'rules');
});

test('uses structured Qwen output when credentials are available', async () => {
  const originalFetch = globalThis.fetch;
  process.env.QWEN_API_KEY = 'test-key';
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"holdings":[{"ticker":"TSLA","qty":100,"broker":"IBKR"}]}' } }] }), { status: 200 });
  try {
    const parsed = await parseHoldings('one hundred shares in Tesla at my broker');
    assert.equal(parsed.source, 'qwen');
    assert.deepEqual(parsed.holdings, [{ ticker: 'TSLA', qty: 100, broker: 'IBKR' }]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.QWEN_API_KEY;
  }
});

test('resolves demo instruments, marks, notionals and open short quantity', async () => {
  const rows = await resolveHoldings(parseHoldingsRules('100 TSLA, 40 NVDA and 25 MSTR'), dependencies);
  assert.deepEqual(rows.map(({ ticker, status }) => [ticker, status]), [['TSLA', 'hedgeable'], ['NVDA', 'hedgeable'], ['MSTR', 'hedgeable']]);
  assert.equal(rows[0].symbol, 'TSLAUSDT');
  assert.equal(rows[0].mark, 364.25);
  assert.equal(rows[0].notional, 36425);
  assert.equal(rows[0].openShortQty, 10);
  assert.deepEqual(rows[0].contract, { minQty: 0.01, qtyIncrement: 0.01, minNotional: 5, maxLeverage: 25 });
});

test('marks a live-only instrument as unavailable on the proof venue', async () => {
  const [row] = await resolveHoldings([{ ticker: 'COST', qty: 10 }], dependencies);
  assert.equal(row.status, 'unlisted');
  assert.equal(row.demoListed, false);
  assert.equal(row.liveListed, true);
  assert.equal(row.mark, null);
});
