import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateEvent, latestCycleStates } from '../src/cycle.mjs';
import { verifyMandateStamp } from '../src/mandate-stamp.mjs';

process.env.TESRUNE_MANDATE_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const holding = { ticker: 'TSLA', symbol: 'TSLAUSDT', qty: 0.04, status: 'hedgeable', demoListed: true, mark: 364.22, openShortQty: 0, contract: { minQty: 0.01, qtyIncrement: 0.01, minNotional: 5 } };
const event = { id: 'synthetic-event', ts: '2026-09-19T01:00:00Z', source: 'test-fixture', tickers: ['TSLA'], title: 'Synthetic event', meta: { synthetic: true } };
const dark = { now: '2026-09-19T01:05:00Z', window: 'dark', nextUnwind: '2026-09-21T13:29:00Z' };
const classifier = async () => ({ verdict: { class: 'material', direction: 'down', confidence: 0.9, hedge_ratio: 0.5, reasoning: 'Fixture downside.', source: 'fixture' } });

test('connects a classifier verdict to a signed mandate proposal', async () => {
  const result = await evaluateEvent({ event, holding, context: { mark: { fundingRate: '-0.000049' } }, clock: dark, classifyFn: classifier });
  assert.equal(result.type, 'proposal');
  assert.equal(result.qty, 0.02);
  assert.equal(result.event.syntheticFixture, true);
  assert.equal(verifyMandateStamp(result, result.mandate.stamp), true);
});

test('carries mandate declines through the cycle boundary', async () => {
  const result = await evaluateEvent({ event, holding, context: {}, clock: { ...dark, window: 'broker_open' }, classifyFn: classifier });
  assert.equal(result.type, 'decline');
  assert.equal(result.rule, 'NOT_DARK');
});

test('collapses append-only cycle rows to latest state', () => {
  assert.deepEqual(latestCycleStates([
    { cycleId: 'a', status: 'open' },
    { cycleId: 'b', status: 'open' },
    { cycleId: 'a', status: 'closed', orderId: 'close-a' }
  ]), [
    { cycleId: 'a', status: 'closed', orderId: 'close-a' },
    { cycleId: 'b', status: 'open' }
  ]);
});

test('claims a pending proposal before execution and removes it only after success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tesrune-cycle-success-'));
  process.env.TESRUNE_DATA_DIR = directory;
  const module = await import(`../src/cycle.mjs?success=${Date.now()}`);
  const [entry] = await module.processEvents({ events: [event], holdings: [holding], contexts: {}, clock: dark, classifyFn: classifier });
  let observedStatus;
  const cycle = await module.confirmProposal(entry.decision.mandate.stamp, { execute: async () => {
    observedStatus = (await module.pendingProposals())[0].pendingStatus;
    return { orderId: 'open-1' };
  }, schedule: async () => {} });
  assert.equal(observedStatus, 'executing');
  assert.equal(cycle.fill.orderId, 'open-1');
  assert.equal((await module.pendingProposals()).length, 0);
  assert.match(await readFile(join(directory, 'cycles.jsonl'), 'utf8'), /"status":"open"/);
  delete process.env.TESRUNE_DATA_DIR;
});

test('marks an ambiguous execution failure unknown and blocks a retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tesrune-cycle-failure-'));
  process.env.TESRUNE_DATA_DIR = directory;
  const module = await import(`../src/cycle.mjs?failure=${Date.now()}`);
  const [entry] = await module.processEvents({ events: [{ ...event, id: 'failure-event' }], holdings: [holding], contexts: {}, clock: dark, classifyFn: classifier });
  await assert.rejects(module.confirmProposal(entry.decision.mandate.stamp, { execute: async () => { throw new Error('timeout'); } }), /timeout/);
  assert.equal((await module.pendingProposals())[0].pendingStatus, 'unknown');
  await assert.rejects(module.confirmProposal(entry.decision.mandate.stamp, { execute: async () => ({ orderId: 'must-not-run' }) }), /reconcile it before retrying/);
  delete process.env.TESRUNE_DATA_DIR;
});
