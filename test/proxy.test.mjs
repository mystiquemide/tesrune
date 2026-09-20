import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBeta, proxySizing } from '../src/proxy.mjs';
import { propose } from '../src/mandate.mjs';
import { verifyMandateStamp } from '../src/mandate-stamp.mjs';

process.env.TESRUNE_MANDATE_SECRET = 'test-secret-that-is-at-least-32-characters-long';

function series(startReturns) {
  const closes = [100];
  for (const r of startReturns) closes.push(closes[closes.length - 1] * (1 + r));
  return closes;
}

test('estimateBeta is ~1 for identical series and null when too few samples', () => {
  const idxReturns = Array.from({ length: 30 }, (_, i) => (i % 5 - 2) / 100);
  const idx = series(idxReturns);
  const same = estimateBeta(idx, idx);
  assert.ok(Math.abs(same.beta - 1) < 1e-6);
  assert.equal(same.sampleSize, 30);
  assert.equal(estimateBeta([100, 101, 102], [100, 101, 102]), null);
});

test('estimateBeta recovers a 2x beta', () => {
  const idxReturns = Array.from({ length: 40 }, (_, i) => ((i % 7) - 3) / 100);
  const idx = series(idxReturns);
  const name = series(idxReturns.map((r) => 2 * r));
  const b = estimateBeta(name, idx);
  assert.ok(b.beta > 1.8 && b.beta < 2.2, `beta was ${b.beta}`);
});

test('proxySizing floors to the increment and rejects sub-minimum hedges', () => {
  const ok = proxySizing({ heldNotional: 9000, beta: 1.1, indexMark: 20000, increment: 0.01, minQty: 0.01, minNotional: 5 });
  assert.equal(ok.ok, true);
  assert.equal(ok.qty, 0.49);
  assert.ok(ok.notional <= ok.targetNotional);
  const tooSmall = proxySizing({ heldNotional: 10, beta: 1, indexMark: 20000, increment: 0.01, minNotional: 5 });
  assert.equal(tooSmall.ok, false);
});

const dark = { now: '2026-09-19T01:05:00Z', window: 'dark', nextUnwind: '2026-09-21T13:29:00Z' };
const verdict = { class: 'material', direction: 'down', confidence: 0.8, hedge_ratio: 0.5, reasoning: 'Downside.' };

test('mandate builds a labeled proxy hedge for an unlisted name with a proxy', () => {
  const holding = { ticker: 'COST', status: 'proxy', proxySymbol: 'NDX100USDT', beta: 1.1, betaSampleSize: 60, equityPrice: 900, qty: 10, proxyMark: 20000, proxyContract: { qtyIncrement: 0.01, minQty: 0.01, minNotional: 5 } };
  const result = propose({ holding, verdict, clockState: dark, event: { id: 'e1', ts: dark.now } });
  assert.equal(result.type, 'proposal');
  assert.equal(result.hedgeType, 'proxy');
  assert.equal(result.symbol, 'NDX100USDT');
  assert.equal(result.proxyFor, 'COST');
  assert.equal(result.qty, 0.49);
  assert.equal(result.mandate.checks.find((c) => c.rule === 'UNLISTED').result, 'proxy');
  assert.match(result.basisRisk, /not a same-name hedge/);
  assert.equal(verifyMandateStamp(result, result.mandate.stamp), true);
});

test('an unlisted name with no proxy still declines UNLISTED', () => {
  const holding = { ticker: 'COST', status: 'unlisted', symbol: 'COSTUSDT', qty: 10, demoListed: false };
  const result = propose({ holding, verdict, clockState: dark, event: { id: 'e2', ts: dark.now } });
  assert.equal(result.type, 'decline');
  assert.equal(result.rule, 'UNLISTED');
});
