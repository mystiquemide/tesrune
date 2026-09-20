import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, classifierInput, normalizeVerdict, rulesVerdict } from '../src/materiality.mjs';

const holding = { ticker: 'TSLA', qty: 100, mark: 364.22, notional: 36422 };
const event = { id: 'event-1', ts: '2026-09-22T00:30:00Z', source: 'sec-edgar', tickers: ['TSLA'], title: 'TSLA files 8-K', body: 'Results below consensus.', meta: { itemCodes: ['2.02', '9.01'] } };
const context = { quote: { close: 364.18, prev_close: 366.2 }, mark: { markPrice: '364.23', fundingRate: '-0.000049' }, observedAt: '2026-09-22T01:00:00Z' };

test('normalizes and clamps a valid verdict', () => {
  assert.deepEqual(normalizeVerdict({ class: 'material', direction: 'down', confidence: 1.2, reasoning: '  Material   downside. ' }), {
    class: 'material',
    direction: 'down',
    confidence: 1,
    hedge_ratio: 0.5,
    reasoning: 'Material downside.'
  });
});

test('rejects invalid classes, directions and missing reasoning', () => {
  assert.throws(() => normalizeVerdict({ class: 'trade', direction: 'down', confidence: 1, hedge_ratio: 1, reasoning: 'x' }));
  assert.throws(() => normalizeVerdict({ class: 'noise', direction: 'sell', confidence: 1, hedge_ratio: 0, reasoning: 'x' }));
  assert.throws(() => normalizeVerdict({ class: 'noise', direction: 'unclear', confidence: 1, hedge_ratio: 0, reasoning: '' }));
});

test('rules flag material 8-K items without inventing direction', () => {
  assert.deepEqual(rulesVerdict(event), {
    class: 'material',
    direction: 'unclear',
    confidence: 0.65,
    hedge_ratio: 0,
    reasoning: 'SEC 8-K item 2.02 can be material, but the direction requires interpretation.'
  });
});

test('rules treat an observed perp move as already priced', () => {
  const result = rulesVerdict({ source: 'bitget-perp-move', meta: { move: -0.03 } });
  assert.equal(result.class, 'priced');
  assert.equal(result.direction, 'down');
  assert.equal(result.hedge_ratio, 0);
});

test('Qwen structured output is validated and model-labeled', async () => {
  process.env.BITGET_QWEN_API_KEY = 'test-key';
  process.env.QWEN_MODEL = 'qwen3.8-max';
  let requestBody;
  const fetcher = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"class":"material","direction":"down","confidence":0.82,"reasoning":"Guidance cut creates downside risk."}' } }] }), { status: 200 });
  };
  const result = await classify(event, holding, context, { fetcher });
  assert.equal(result.source, 'qwen');
  assert.equal(result.model, 'qwen3.8-max');
  assert.equal(result.hedge_ratio, 0.5);
  assert.equal(result.attempts, 1);
  assert.equal(requestBody.messages[1].content.includes('accountBalance'), false);
});

test('Qwen failure falls back to deterministic rules and stays labeled', async () => {
  process.env.BITGET_QWEN_API_KEY = 'test-key';
  let attempts = 0;
  const result = await classify(event, holding, context, { fetcher: async () => { attempts += 1; throw new Error('offline'); } });
  assert.equal(result.source, 'rules-qwen-fallback');
  assert.equal(attempts, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.class, 'material');
  assert.equal(result.direction, 'unclear');
  assert.equal(result.qwenError, 'offline');
});

test('classifier input excludes account balances and truncates event bodies', () => {
  const input = classifierInput({ ...event, body: 'x'.repeat(8_000) }, { ...holding, accountBalance: 999999 }, { ...context, accountBalance: 999999 });
  assert.equal(input.event.body.length, 6_000);
  assert.equal(JSON.stringify(input).includes('accountBalance'), false);
});
