import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBook, resolveHoldings } from './book.mjs';
import { state as clockState } from './clock.mjs';
import { close, place, ticker } from './execution.mjs';
import { pollFeeds } from './feeds.mjs';
import { classifyAndLog } from './materiality.mjs';
import { propose } from './mandate.mjs';
import { scheduleUnwind } from './unwind.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.TESRUNE_DATA_DIR ?? join(ROOT, 'data');
const PATHS = {
  pending: join(DATA_DIR, 'pending.json'),
  proposals: join(DATA_DIR, 'proposals.jsonl'),
  declines: join(DATA_DIR, 'declines.jsonl'),
  cycles: join(DATA_DIR, 'cycles.jsonl')
};
const confirmationLocks = new Set();

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

export function latestCycleStates(rows) {
  const states = new Map();
  for (const row of rows) states.set(row.cycleId, row);
  return [...states.values()];
}

export async function pendingProposals() {
  return readJson(PATHS.pending, []);
}

async function persistPending(rows) {
  await writeJsonAtomic(PATHS.pending, rows);
}

export async function evaluateEvent({ event, holding, context, clock, openHedges = [], requestedQty, classifyFn = classifyAndLog }) {
  const classified = await classifyFn(event, holding, context);
  const verdict = classified.verdict ?? classified;
  return propose({
    holding,
    verdict,
    clockState: clock,
    openHedges,
    event,
    fundingRate: Number(context?.mark?.fundingRate ?? 0),
    requestedQty
  });
}

export async function processEvents({ events, holdings, contexts = {}, clock = clockState(), classifyFn = classifyAndLog, openHedges = [] }) {
  const pending = await pendingProposals();
  const results = [];
  for (const event of events) {
    for (const holding of holdings.filter(({ ticker }) => event.tickers?.includes(ticker))) {
      if (pending.some((proposal) => proposal.eventId === event.id && proposal.ticker === holding.ticker)) continue;
      const decision = await evaluateEvent({ event, holding, context: contexts[holding.ticker] ?? {}, clock, openHedges, classifyFn });
      const entry = { eventId: event.id, ticker: holding.ticker, syntheticFixture: Boolean(event.meta?.synthetic), decision };
      if (decision.type === 'decline') await append(PATHS.declines, entry);
      if (decision.type === 'proposal') {
        pending.push({ ...decision, pendingStatus: 'pending' });
        await append(PATHS.proposals, entry);
      }
      results.push(entry);
    }
  }
  await persistPending(pending);
  return results;
}

export async function confirmProposal(stamp, { execute = place, schedule = scheduleUnwind } = {}) {
  if (confirmationLocks.has(stamp)) throw new Error('Proposal confirmation is already in progress');
  confirmationLocks.add(stamp);
  try {
    const pending = await pendingProposals();
    const index = pending.findIndex((proposal) => proposal.mandate?.stamp === stamp);
    if (index < 0) throw new Error('Pending proposal not found');
    const proposal = pending[index];
    if (proposal.pendingStatus !== 'pending') throw new Error(`Proposal is ${proposal.pendingStatus}; reconcile it before retrying`);
    pending[index] = { ...proposal, pendingStatus: 'executing', confirmationStartedAt: new Date().toISOString() };
    await persistPending(pending);
    let fill;
    try {
      fill = await execute(proposal, stamp);
    } catch (error) {
      pending[index] = { ...pending[index], pendingStatus: 'unknown', executionError: error.message };
      await persistPending(pending);
      throw error;
    }
    const cycle = { cycleId: proposal.id, status: 'open', proposal, fill, openedAt: new Date().toISOString(), mode: proposal.event?.syntheticFixture ? 'synthetic' : 'live' };
    await append(PATHS.cycles, cycle);
    await schedule(cycle);
    pending.splice(index, 1);
    await persistPending(pending);
    return cycle;
  } finally {
    confirmationLocks.delete(stamp);
  }
}

export async function recordCycleUpdate(cycleId, update) {
  const entry = { cycleId, ...update };
  await append(PATHS.cycles, entry);
  return entry;
}

export async function openCycleStates() {
  return latestCycleStates(await readJsonl(PATHS.cycles)).filter(({ status }) => status === 'open');
}

export async function runOnce() {
  const stored = await readBook();
  const holdings = await resolveHoldings(stored.holdings);
  const tickers = holdings.map(({ ticker }) => ticker);
  const feeds = await pollFeeds(tickers);
  const contexts = Object.fromEntries(tickers.map((name) => [name, { quote: feeds.quotes[name], mark: feeds.marks[name] }]));
  const results = await processEvents({ events: feeds.events, holdings, contexts, clock: clockState(), openHedges: await openCycleStates() });
  return { clock: clockState(), holdings, feedErrors: feeds.errors, events: feeds.events.length, decisions: results };
}

async function proofRoundTrip() {
  const market = await ticker('TSLAUSDT');
  const mark = Number(market.markPrice ?? market.lastPr);
  const holding = { ticker: 'TSLA', symbol: 'TSLAUSDT', qty: 0.04, status: 'hedgeable', demoListed: true, mark, notional: mark * 0.04, openShortQty: 0, contract: { minQty: 0.01, qtyIncrement: 0.01, minNotional: 5 } };
  const event = { id: `synthetic-cycle-proof-${Date.now()}`, ts: '2026-09-19T01:00:00.000Z', source: 'test-fixture', tickers: ['TSLA'], title: 'Synthetic T7 execution fixture', body: 'Synthetic fixture used only to verify the event-to-fill plumbing.', url: '', meta: { synthetic: true } };
  const clock = { now: '2026-09-19T01:05:00.000Z', window: 'dark', nextUnwind: '2026-09-21T13:29:00.000Z' };
  const classifyFn = async () => ({ verdict: { class: 'material', direction: 'down', confidence: 0.9, hedge_ratio: 0.5, reasoning: 'Synthetic execution fixture.', source: 'synthetic-policy-fixture' } });
  const [entry] = await processEvents({ events: [event], holdings: [holding], contexts: { TSLA: { mark: market } }, clock, classifyFn, openHedges: await openCycleStates() });
  if (entry?.decision?.type !== 'proposal') throw new Error(`Proof did not produce a proposal: ${JSON.stringify(entry?.decision)}`);
  const cycle = await confirmProposal(entry.decision.mandate.stamp);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const closingFill = await close({ symbol: 'TSLAUSDT' });
  await recordCycleUpdate(cycle.cycleId, { status: 'closed', closedAt: new Date().toISOString(), closingFill, mode: 'synthetic' });
  return { proposal: entry.decision, openingFill: cycle.fill, closingFill };
}

async function cli() {
  if (process.argv.includes('--once')) {
    console.log(JSON.stringify(await runOnce(), null, 2));
    return;
  }
  if (process.argv.includes('--proof-roundtrip')) {
    console.log(JSON.stringify(await proofRoundTrip(), null, 2));
    return;
  }
  throw new Error('Use --once or --proof-roundtrip');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});

export { DATA_DIR, PATHS, proofRoundTrip };
