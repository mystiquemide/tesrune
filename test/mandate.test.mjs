import test from 'node:test';
import assert from 'node:assert/strict';
import { propose, fundingSettlements } from '../src/mandate.mjs';
import { verifyMandateStamp } from '../src/mandate-stamp.mjs';

process.env.TESRUNE_MANDATE_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const holding = {
  ticker: 'TSLA',
  symbol: 'TSLAUSDT',
  qty: 100,
  status: 'hedgeable',
  demoListed: true,
  mark: 364.22,
  openShortQty: 0,
  contract: { minQty: 0.01, qtyIncrement: 0.01, minNotional: 5 }
};
const verdict = { class: 'material', direction: 'down', confidence: 0.82, hedge_ratio: 0.75, reasoning: 'Material downside event.' };
const clockState = { now: '2026-09-22T01:00:00.000Z', window: 'dark', nextUnwind: '2026-09-22T13:29:00.000Z' };
const event = { id: 'event-1', ts: '2026-09-22T00:30:00.000Z', source: 'sec-edgar', title: 'TSLA 8-K item 2.02', url: 'https://www.sec.gov/filing' };
const base = { holding, verdict, clockState, event, fundingRate: -0.000049 };

test('declines while the broker is open', () => {
  assert.equal(propose({ ...base, clockState: { ...clockState, window: 'broker_open' } }).rule, 'NOT_DARK');
});

test('declines noise and low-confidence events', () => {
  assert.equal(propose({ ...base, verdict: { ...verdict, class: 'noise' } }).rule, 'NOT_MATERIAL');
  assert.equal(propose({ ...base, verdict: { ...verdict, confidence: 0.59 } }).rule, 'NOT_MATERIAL');
});

test('declines events without a downside direction', () => {
  assert.equal(propose({ ...base, verdict: { ...verdict, direction: 'up' } }).rule, 'DIRECTION_UP');
  assert.equal(propose({ ...base, verdict: { ...verdict, direction: 'unclear' } }).rule, 'DIRECTION_UP');
});

test('declines instruments unavailable on the proof venue', () => {
  assert.equal(propose({ ...base, holding: { ...holding, status: 'unlisted', demoListed: false } }).rule, 'UNLISTED');
});

test('clips an oversized request to held quantity and records the clip', () => {
  const result = propose({ ...base, requestedQty: 150 });
  assert.equal(result.type, 'proposal');
  assert.equal(result.qty, 100);
  assert.equal(result.clippedFrom, 150);
  assert.equal(result.mandate.checks.find(({ rule }) => rule === 'CAP').result, 'clipped');
});

test('floors quantities and declines sub-minimum notionals', () => {
  const result = propose({ ...base, requestedQty: 1.239 });
  assert.equal(result.qty, 1.23);
  assert.equal(propose({ ...base, holding: { ...holding, qty: 0.01 }, requestedQty: 0.01 }).rule, 'MIN_SIZE');
});

test('declines duplicate or externally open short hedges', () => {
  assert.equal(propose({ ...base, openHedges: [{ symbol: 'TSLAUSDT', status: 'open' }] }).rule, 'DUPLICATE');
  assert.equal(propose({ ...base, holding: { ...holding, openShortQty: 1 } }).rule, 'DUPLICATE');
});

test('produces a stamped, executable proposal with costs', () => {
  const result = propose(base);
  assert.equal(result.type, 'proposal');
  assert.equal(result.qty, 75);
  assert.equal(result.notional, 27316.5);
  assert.equal(result.openFee, 16.3899);
  assert.equal(result.unwindFee, 16.3899);
  assert.equal(result.estimatedFees, 32.7798);
  assert.equal(result.fundingSettlements, 1);
  assert.equal(result.estimatedFunding, -1.3385085);
  assert.equal(result.unwindAt, clockState.nextUnwind);
  assert.equal(result.mandate.checks.length, 7);
  assert.equal(verifyMandateStamp(result, result.mandate.stamp), true);
  assert.equal(verifyMandateStamp({ ...result, qty: 75.01 }, result.mandate.stamp), false);
});

test('counts only future funding boundaries through unwind', () => {
  assert.equal(fundingSettlements('2026-09-22T01:00:00Z', '2026-09-22T13:29:00Z'), 1);
  assert.equal(fundingSettlements('2026-09-22T01:00:00Z', '2026-09-23T01:00:00Z'), 3);
});
