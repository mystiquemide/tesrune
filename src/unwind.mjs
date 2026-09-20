import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { close, orderDetail, positions, ticker } from './execution.mjs';
import { equityQuote } from './feeds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.TESRUNE_DATA_DIR ?? join(ROOT, 'data');
const PATHS = {
  schedule: join(DATA_DIR, 'schedule.json'),
  cycles: join(DATA_DIR, 'cycles.jsonl'),
  pending: join(DATA_DIR, 'pending.json'),
  failures: join(DATA_DIR, 'unwind-failures.jsonl')
};
const locks = new Set();

async function append(path, entry) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readJsonl(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

function latestStates(rows) {
  const states = new Map();
  for (const row of rows) states.set(row.cycleId, row);
  return [...states.values()];
}

export async function schedules() {
  return readJson(PATHS.schedule, []);
}

async function persist(rows) {
  await writeJsonAtomic(PATHS.schedule, rows);
}

function scheduleFromCycle(cycle) {
  const proposal = cycle.proposal;
  return {
    cycleId: cycle.cycleId,
    ticker: proposal.ticker,
    symbol: proposal.symbol,
    qty: proposal.qty,
    unwindAt: proposal.unwindAt,
    openingOrderId: cycle.fill?.orderId ?? cycle.fill?.response?.orderId ?? null,
    proposal,
    mode: cycle.mode ?? (proposal.event?.syntheticFixture ? 'synthetic' : 'live'),
    status: 'armed',
    attempts: 0,
    armedAt: new Date().toISOString()
  };
}

export async function scheduleUnwind(cycle) {
  if (!cycle?.cycleId || !cycle?.proposal?.unwindAt) throw new Error('An open cycle with unwindAt is required');
  const rows = await schedules();
  if (!rows.some(({ cycleId, status }) => cycleId === cycle.cycleId && ['armed', 'closing'].includes(status))) {
    rows.push(scheduleFromCycle(cycle));
    await persist(rows);
  }
  return rows.find(({ cycleId }) => cycleId === cycle.cycleId);
}

export async function reconcileSchedules() {
  const [rows, cycles, pending] = await Promise.all([schedules(), readJsonl(PATHS.cycles), readJson(PATHS.pending, [])]);
  const latest = latestStates(cycles);
  const candidates = [
    ...latest.filter(({ status, proposal }) => status === 'open' && proposal).map(scheduleFromCycle),
    ...pending.filter(({ pendingStatus }) => ['executing', 'unknown'].includes(pendingStatus)).map((proposal) => scheduleFromCycle({ cycleId: proposal.id, proposal, fill: null, mode: proposal.event?.syntheticFixture ? 'synthetic' : 'live' }))
  ];
  let changed = false;
  for (const candidate of candidates) {
    if (!rows.some(({ cycleId, status }) => cycleId === candidate.cycleId && !['complete', 'failed'].includes(status))) {
      rows.push(candidate);
      changed = true;
    }
  }
  if (changed) await persist(rows);
  return rows;
}

function shortQty(symbol, rows) {
  return rows.filter((position) => position.symbol === symbol && position.holdSide === 'short').reduce((sum, position) => sum + Number(position.total ?? 0), 0);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimal(value, places = 8) {
  return value === null ? null : Number(value.toFixed(places));
}

export function calculatePnl({ proposal, openDetail, closeDetail, quote, sessionOpenVerified = false }) {
  const qty = number(closeDetail?.baseVolume) ?? number(openDetail?.baseVolume) ?? number(proposal?.qty);
  const openPrice = number(openDetail?.priceAvg);
  const closePrice = number(closeDetail?.priceAvg);
  const realized = number(closeDetail?.totalProfits);
  const grossHedgePnl = realized ?? (qty !== null && openPrice !== null && closePrice !== null ? (openPrice - closePrice) * qty : null);
  const estimatedFees = number(proposal?.estimatedFees) ?? 0;
  const estimatedFunding = number(proposal?.estimatedFunding) ?? 0;
  const netHedgePnl = grossHedgePnl === null ? null : grossHedgePnl - estimatedFees + estimatedFunding;
  const previousClose = number(quote?.prev_close);
  const nextOpen = sessionOpenVerified ? number(quote?.open) : null;
  const underlyingGapPnl = qty !== null && previousClose !== null && nextOpen !== null ? (nextOpen - previousClose) * qty : null;
  return {
    qty,
    openPrice,
    closePrice,
    grossHedgePnl: decimal(grossHedgePnl),
    estimatedFees,
    estimatedFunding,
    netHedgePnl: decimal(netHedgePnl),
    previousClose,
    nextOpen,
    underlyingGapPnl: decimal(underlyingGapPnl),
    labels: { fees: 'estimated', funding: 'estimated', prices: 'exchange fills', underlying: sessionOpenVerified ? 'verified MCP cash-session open' : 'pending next cash-session open' }
  };
}

async function updateSchedule(cycleId, update) {
  const rows = await schedules();
  const index = rows.findIndex((row) => row.cycleId === cycleId && !['complete', 'failed'].includes(row.status));
  if (index < 0) throw new Error(`Active schedule ${cycleId} not found`);
  rows[index] = { ...rows[index], ...update };
  await persist(rows);
  return rows[index];
}

async function resolvePending(cycleId) {
  const pending = await readJson(PATHS.pending, []);
  const remaining = pending.filter((proposal) => proposal.id !== cycleId);
  if (remaining.length !== pending.length) await writeJsonAtomic(PATHS.pending, remaining);
}

async function complete(item, closingFill, dependencies) {
  const errors = [];
  const capture = async (label, task) => {
    try {
      return await task;
    } catch (error) {
      errors.push({ source: label, error: error.message });
      return null;
    }
  };
  const [openDetail, closeDetail, quote] = await Promise.all([
    item.openingOrderId ? capture('opening-order-detail', dependencies.detail(item.symbol, item.openingOrderId)) : null,
    closingFill?.orderId ? capture('closing-order-detail', dependencies.detail(item.symbol, closingFill.orderId)) : null,
    capture('underlying-quote', dependencies.quote(item.ticker))
  ]);
  const pnl = calculatePnl({ proposal: item.proposal, openDetail, closeDetail, quote });
  const closedAt = new Date().toISOString();
  await append(PATHS.cycles, { cycleId: item.cycleId, status: 'closed', closedAt, closingFill, pnl, evidenceErrors: errors, mode: item.mode });
  await updateSchedule(item.cycleId, { status: 'complete', completedAt: closedAt, closingFill, pnl, evidenceErrors: errors });
  await resolvePending(item.cycleId);
  return { cycleId: item.cycleId, status: 'closed', closingFill, pnl, evidenceErrors: errors };
}

export async function unwindItem(item, options = {}) {
  if (locks.has(item.cycleId)) return { cycleId: item.cycleId, status: 'already-running' };
  locks.add(item.cycleId);
  const dependencies = {
    close: options.closeFn ?? close,
    positions: options.positionsFn ?? positions,
    detail: options.detailFn ?? orderDetail,
    quote: options.quoteFn ?? equityQuote,
    wait: options.waitFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  };
  const maxAttempts = options.maxAttempts ?? 20;
  const retryDelayMs = options.retryDelayMs ?? 15_000;
  let closingFill = item.closingFill ?? null;
  let lastError;
  try {
    await updateSchedule(item.cycleId, { status: 'closing', startedAt: new Date().toISOString() });
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let openQty;
      try {
        openQty = shortQty(item.symbol, await dependencies.positions());
      } catch (error) {
        lastError = error;
        await updateSchedule(item.cycleId, { attempts: attempt, lastError: error.message });
        await dependencies.wait(retryDelayMs);
        continue;
      }
      if (openQty <= 0) return complete(item, closingFill, dependencies);
      try {
        closingFill = await dependencies.close({ symbol: item.symbol });
        await updateSchedule(item.cycleId, { attempts: attempt, closingFill, lastError: null });
      } catch (error) {
        lastError = error;
        await updateSchedule(item.cycleId, { attempts: attempt, lastError: error.message });
      }
      await dependencies.wait(retryDelayMs);
    }
    const failure = { cycleId: item.cycleId, status: 'unwind_failed', symbol: item.symbol, attempts: maxAttempts, error: lastError?.message ?? 'Position remained open' };
    await append(PATHS.failures, failure);
    await append(PATHS.cycles, { ...failure, mode: item.mode });
    await updateSchedule(item.cycleId, { status: 'failed', failedAt: new Date().toISOString(), lastError: failure.error });
    return failure;
  } finally {
    locks.delete(item.cycleId);
  }
}

export async function runDue(now = new Date(), options = {}) {
  const rows = await reconcileSchedules();
  const due = rows.filter(({ status, unwindAt }) => ['armed', 'closing'].includes(status) && new Date(unwindAt) <= now);
  const results = [];
  for (const item of due) results.push(await unwindItem(item, options));
  return results;
}

export async function startScheduler(options = {}) {
  await reconcileSchedules();
  const intervalMs = options.intervalMs ?? 15_000;
  await runDue(new Date(), options);
  return setInterval(() => runDue(new Date(), options).catch((error) => append(PATHS.failures, { status: 'scheduler_error', error: error.message })), intervalMs);
}

async function cli() {
  if (process.argv.includes('--run-due')) {
    console.log(JSON.stringify(await runDue(), null, 2));
    return;
  }
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify(await reconcileSchedules(), null, 2));
    return;
  }
  throw new Error('Use --run-due or --status');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});

export { DATA_DIR, PATHS, shortQty };
