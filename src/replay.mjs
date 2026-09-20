import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { state as clockState } from './clock.mjs';
import { confirmProposal, openCycleStates, processEvents } from './cycle.mjs';
import { ticker } from './execution.mjs';
import { classifyAndLog } from './materiality.mjs';
import { activateReplay } from './unwind.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.TESRUNE_DATA_DIR ?? join(ROOT, 'data');
const LOG = join(DATA_DIR, 'replays.jsonl');

function decimal(value, places = 8) {
  return Number(Number(value).toFixed(places));
}

export function validateScenario(value) {
  if (value?.mode !== 'historical_replay') throw new Error('Scenario must be labeled historical_replay');
  if (!/^[A-Z]{1,6}$/.test(value?.ticker ?? '')) throw new Error('Scenario ticker is invalid');
  if (!value?.event?.meta?.historicalReplay) throw new Error('Scenario requires a labeled historical event');
  if (!value?.event?.url && !value?.event?.mcpSourced) throw new Error('Scenario requires a cited historical event (external url or Bitget MCP source)');
  for (const key of ['fridayClose', 'mondayOpen', 'mondayClose']) {
    if (!Number.isFinite(Number(value?.historical?.[key]))) throw new Error(`Scenario historical.${key} is required`);
  }
  for (const candle of ['entryCandle', 'unwindCandle']) {
    for (const key of ['open', 'high', 'low', 'close']) if (!Number.isFinite(Number(value?.historical?.[candle]?.[key]))) throw new Error(`Scenario historical.${candle}.${key} is required`);
  }
  if (!Number.isFinite(new Date(value.decisionAt).getTime()) || !Number.isFinite(new Date(value.unwindAt).getTime())) throw new Error('Scenario clock is invalid');
  return value;
}

export async function loadScenario(path) {
  return validateScenario(JSON.parse(await readFile(resolve(path), 'utf8')));
}

export function historicalOutcome(scenario, hedgeQty) {
  const heldQty = Number(scenario.holdingQty);
  const fridayClose = Number(scenario.historical.fridayClose);
  const mondayOpen = Number(scenario.historical.mondayOpen);
  const gapPerShare = mondayOpen - fridayClose;
  const unhedgedGapPnl = gapPerShare * heldQty;
  const entry = scenario.historical.entryCandle;
  const unwind = scenario.historical.unwindCandle;
  const hedgeGrossLow = (Number(entry.low) - Number(unwind.high)) * hedgeQty;
  const hedgeGrossHigh = (Number(entry.high) - Number(unwind.low)) * hedgeQty;
  return {
    label: 'historical counterfactual range, not the current demo fill or an exact historical fill',
    fridayClose,
    mondayOpen,
    mondayClose: Number(scenario.historical.mondayClose),
    gapPerShare: decimal(gapPerShare),
    gapPercent: decimal((gapPerShare / fridayClose) * 100),
    heldQty,
    hedgeQty,
    unhedgedGapPnl: decimal(unhedgedGapPnl),
    hypotheticalHedgeGrossRange: [decimal(hedgeGrossLow), decimal(hedgeGrossHigh)],
    combinedAtOpenBeforeCostsRange: [decimal(unhedgedGapPnl + hedgeGrossLow), decimal(unhedgedGapPnl + hedgeGrossHigh)],
    uncertainty: `Entry and unwind are bounded by the Bitget ${scenario.ticker}USDT 4H candle lows/highs because exact historical fills are unavailable.`,
    sources: { stock: scenario.historical.priceSource, perp: scenario.historical.perpSource },
    entryCandle: entry,
    unwindCandle: unwind
  };
}

async function log(entry) {
  await mkdir(dirname(LOG), { recursive: true });
  await appendFile(LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

export async function prepareReplay(scenario, options = {}) {
  validateScenario(scenario);
  const getTicker = options.tickerFn ?? ticker;
  const classifyFn = options.classifyFn ?? classifyAndLog;
  const market = await getTicker(`${scenario.ticker}USDT`);
  const mark = Number(market.markPrice ?? market.lastPr);
  const holding = {
    ticker: scenario.ticker,
    symbol: `${scenario.ticker}USDT`,
    qty: Number(scenario.holdingQty),
    status: 'hedgeable',
    demoListed: true,
    mark,
    notional: mark * Number(scenario.holdingQty),
    openShortQty: 0,
    contract: { minQty: 0.01, qtyIncrement: 0.01, minNotional: 5 }
  };
  const event = { ...scenario.event, tickers: [scenario.ticker], meta: { ...scenario.event.meta, historicalReplay: true } };
  const replayClock = clockState(scenario.decisionAt);
  if (replayClock.window !== 'dark') throw new Error(`Scenario decision time is ${replayClock.window}, not dark`);
  if (replayClock.nextUnwind !== scenario.unwindAt) throw new Error(`Scenario unwind mismatch: clock computed ${replayClock.nextUnwind}`);
  const context = {
    quote: { close: scenario.historical.fridayClose, prev_close: scenario.historical.previousClose },
    mark: { markPrice: scenario.historical.fridayClose, fundingRate: '0' },
    observedAt: scenario.decisionAt
  };
  const [entry] = await processEvents({
    events: [event],
    holdings: [holding],
    contexts: { [scenario.ticker]: context },
    clock: replayClock,
    classifyFn,
    openHedges: await openCycleStates()
  });
  if (!entry) throw new Error('Replay event was already processed or produced no decision');
  await log({ phase: 'prepared', scenarioId: scenario.id, mode: 'historical_replay', decision: entry.decision });
  return { scenario, holding, event, clock: replayClock, decision: entry.decision };
}

export async function executeReplay(prepared, options = {}) {
  if (prepared.decision?.type !== 'proposal') throw new Error(`Replay was not executable: ${prepared.decision?.rule ?? 'no proposal'}`);
  const confirm = options.confirmFn ?? confirmProposal;
  const cycle = await confirm(prepared.decision.mandate.stamp);
  if (cycle.mode !== 'replay') throw new Error(`Replay cycle was mislabeled ${cycle.mode}`);
  await log({ phase: 'opened', scenarioId: prepared.scenario.id, mode: 'historical_replay', cycleId: cycle.cycleId, openingOrderId: cycle.fill.orderId });
  return cycle;
}

export async function jumpToUnwind(prepared, cycle, options = {}) {
  const activate = options.activateFn ?? activateReplay;
  const results = await activate(cycle.cycleId, options.unwindOptions ?? {});
  const closed = results.find(({ cycleId }) => cycleId === cycle.cycleId);
  if (!closed || closed.status !== 'closed') throw new Error(`Replay unwind failed: ${JSON.stringify(results)}`);
  const historical = historicalOutcome(prepared.scenario, prepared.decision.qty);
  const artifact = {
    scenarioId: prepared.scenario.id,
    mode: 'historical_replay',
    eventSource: prepared.event.url || prepared.event.source || 'Bitget MCP news',
    historical,
    executionProof: {
      label: 'current Bitget demo-engine execution, not historical execution',
      cycleId: cycle.cycleId,
      openingOrderId: cycle.fill.orderId,
      closingOrderId: closed.closingFill?.orderId,
      pnl: closed.pnl
    }
  };
  await log({ phase: 'complete', ...artifact });
  return artifact;
}

export async function runReplay(path, options = {}) {
  const scenario = await loadScenario(path);
  const prepared = await prepareReplay(scenario, options);
  if (prepared.decision.type !== 'proposal') return { prepared, artifact: null };
  const cycle = await executeReplay(prepared, options);
  const artifact = await jumpToUnwind(prepared, cycle, options);
  return { prepared, cycle, artifact };
}

async function cli() {
  const index = process.argv.indexOf('--run');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Use --run scenarios/file.json');
  console.log(JSON.stringify(await runReplay(process.argv[index + 1]), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});

export { DATA_DIR, LOG };
