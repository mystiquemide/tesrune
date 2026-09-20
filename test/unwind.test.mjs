import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculatePnl } from '../src/unwind.mjs';

const proposal = {
  ticker: 'TSLA',
  symbol: 'TSLAUSDT',
  qty: 0.02,
  unwindAt: '2026-09-22T13:29:00Z',
  estimatedFees: 0.00874,
  estimatedFunding: -0.00036,
  event: { syntheticFixture: true }
};
const cycle = { cycleId: 'cycle-1', status: 'open', proposal, fill: { orderId: 'open-1' }, mode: 'synthetic' };

test('calculates short hedge and underlying gap P&L from evidence', () => {
  assert.deepEqual(calculatePnl({
    proposal,
    openDetail: { priceAvg: '364.18', baseVolume: '0.02' },
    closeDetail: { priceAvg: '364.23', baseVolume: '0.02', totalProfits: '-0.001' },
    quote: { prev_close: 366.2, open: 369 },
    sessionOpenVerified: true
  }), {
    qty: 0.02,
    openPrice: 364.18,
    closePrice: 364.23,
    grossHedgePnl: -0.001,
    estimatedFees: 0.00874,
    estimatedFunding: -0.00036,
    netHedgePnl: -0.0101,
    previousClose: 366.2,
    nextOpen: 369,
    underlyingGapPnl: 0.056,
    labels: { fees: 'estimated', funding: 'estimated', prices: 'exchange fills', underlying: 'verified MCP cash-session open' }
  });
});

test('does not claim the next cash open before it occurs', () => {
  const result = calculatePnl({ proposal, openDetail: { priceAvg: '364.18', baseVolume: '0.02' }, closeDetail: { priceAvg: '364.23', totalProfits: '-0.001' }, quote: { prev_close: 366.2, open: 369 } });
  assert.equal(result.nextOpen, null);
  assert.equal(result.underlyingGapPnl, null);
  assert.equal(result.labels.underlying, 'pending next cash-session open');
});

test('persists, executes and completes a due unwind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tesrune-unwind-success-'));
  process.env.TESRUNE_DATA_DIR = directory;
  const module = await import(`../src/unwind.mjs?success=${Date.now()}`);
  await module.scheduleUnwind(cycle);
  let open = true;
  const results = await module.runDue(new Date('2026-09-22T13:29:01Z'), {
    positionsFn: async () => open ? [{ symbol: 'TSLAUSDT', holdSide: 'short', total: '0.02' }] : [],
    closeFn: async () => { open = false; return { orderId: 'close-1' }; },
    detailFn: async (_symbol, orderId) => orderId === 'open-1' ? { priceAvg: '364.18', baseVolume: '0.02' } : { priceAvg: '364.23', baseVolume: '0.02', totalProfits: '-0.001' },
    quoteFn: async () => ({ prev_close: 366.2, open: 369 }),
    waitFn: async () => {},
    retryDelayMs: 0
  });
  assert.equal(results[0].status, 'closed');
  assert.equal(results[0].closingFill.orderId, 'close-1');
  assert.equal((await module.schedules())[0].status, 'complete');
  assert.match(await readFile(join(directory, 'cycles.jsonl'), 'utf8'), /"netHedgePnl":-0.0101/);
  delete process.env.TESRUNE_DATA_DIR;
});

test('records an explicit failure after bounded retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tesrune-unwind-failure-'));
  process.env.TESRUNE_DATA_DIR = directory;
  const module = await import(`../src/unwind.mjs?failure=${Date.now()}`);
  await module.scheduleUnwind({ ...cycle, cycleId: 'cycle-fail' });
  const [result] = await module.runDue(new Date('2026-09-22T13:29:01Z'), {
    positionsFn: async () => [{ symbol: 'TSLAUSDT', holdSide: 'short', total: '0.02' }],
    closeFn: async () => { throw new Error('exchange unavailable'); },
    waitFn: async () => {},
    retryDelayMs: 0,
    maxAttempts: 2
  });
  assert.equal(result.status, 'unwind_failed');
  assert.equal(result.attempts, 2);
  assert.equal((await module.schedules())[0].status, 'failed');
  assert.match(await readFile(join(directory, 'unwind-failures.jsonl'), 'utf8'), /exchange unavailable/);
  delete process.env.TESRUNE_DATA_DIR;
});

test('recovers an unscheduled open cycle after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tesrune-unwind-recovery-'));
  const recovered = { ...cycle, cycleId: 'cycle-recovered', proposal: { ...proposal, id: 'cycle-recovered', pendingStatus: 'executing' } };
  await writeFile(join(directory, 'cycles.jsonl'), `${JSON.stringify({ ts: '2026-09-20T00:00:00Z', ...recovered })}\n`);
  await writeFile(join(directory, 'pending.json'), `${JSON.stringify([{ ...recovered.proposal, pendingStatus: 'executing' }])}\n`);
  process.env.TESRUNE_DATA_DIR = directory;
  const module = await import(`../src/unwind.mjs?recovery=${Date.now()}`);
  const rows = await module.reconcileSchedules();
  assert.equal(rows[0].cycleId, 'cycle-recovered');
  assert.equal(rows[0].status, 'armed');
  await module.runDue(new Date('2026-09-22T13:29:01Z'), {
    positionsFn: async () => [],
    detailFn: async () => ({ priceAvg: '364.18', baseVolume: '0.02' }),
    quoteFn: async () => ({ prev_close: 366.2 }),
    waitFn: async () => {}
  });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'pending.json'), 'utf8')), []);
  delete process.env.TESRUNE_DATA_DIR;
});
