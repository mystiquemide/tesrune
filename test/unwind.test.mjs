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

test('reconciles the underlying gap and hedge offset only after the cash session opens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tesrune-reconcile-'));
  process.env.TESRUNE_DATA_DIR = directory;
  const module = await import(`../src/unwind.mjs?reconcile=${Date.now()}`);
  const closed = {
    cycleId: 'live-1', status: 'closed', mode: 'live',
    proposal: { ticker: 'TSLA', symbol: 'TSLAUSDT', qty: 0.02 },
    pnl: { qty: 0.02, netHedgePnl: 0.09, previousClose: 411.82, nextOpen: null, underlyingGapPnl: null, labels: { underlying: 'pending next cash-session open' } }
  };
  await writeFile(join(directory, 'cycles.jsonl'), `${JSON.stringify({ ts: '2026-02-23T14:29:00Z', ...closed })}\n`);
  const quoteFn = async () => ({ prev_close: 411.82, open: 407.285 });

  // While dark, nothing is reconciled
  assert.deepEqual(await module.reconcileGaps({ clock: { window: 'dark' }, quoteFn }), []);

  // Once the cash session is open, the gap and offset are computed from the real open
  const updated = await module.reconcileGaps({ clock: { window: 'broker_open' }, quoteFn });
  assert.equal(updated.length, 1);
  const gap = updated[0].underlyingGapPnl;
  assert.ok(Math.abs(gap - ((407.285 - 411.82) * 0.02)) < 1e-9);
  assert.ok(updated[0].effectiveness.offsetPct > 0);
  assert.match(await readFile(join(directory, 'cycles.jsonl'), 'utf8'), /"underlying":"verified cash-session open"/);

  // A second pass does not double-reconcile
  assert.deepEqual(await module.reconcileGaps({ clock: { window: 'broker_open' }, quoteFn }), []);
  delete process.env.TESRUNE_DATA_DIR;
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

test('holds replay schedules until an explicit clock jump', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tesrune-unwind-replay-'));
  process.env.TESRUNE_DATA_DIR = directory;
  const module = await import(`../src/unwind.mjs?replay=${Date.now()}`);
  const replayCycle = { ...cycle, cycleId: 'cycle-replay', mode: 'replay', proposal: { ...proposal, event: { historicalReplay: true } } };
  await module.scheduleUnwind(replayCycle);
  let closeCalls = 0;
  const options = {
    positionsFn: async () => closeCalls ? [] : [{ symbol: 'TSLAUSDT', holdSide: 'short', total: '0.02' }],
    closeFn: async () => { closeCalls += 1; return { orderId: 'close-replay' }; },
    detailFn: async (_symbol, orderId) => orderId === 'open-1' ? { priceAvg: '364.18', baseVolume: '0.02' } : { priceAvg: '364.19', baseVolume: '0.02', totalProfits: '-0.0002' },
    quoteFn: async () => ({ prev_close: 366.2 }),
    waitFn: async () => {}
  };
  assert.deepEqual(await module.runDue(new Date('2026-09-23T00:00:00Z'), options), []);
  assert.equal(closeCalls, 0);
  const [closed] = await module.activateReplay('cycle-replay', options);
  assert.equal(closed.status, 'closed');
  assert.equal(closeCalls, 1);
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
