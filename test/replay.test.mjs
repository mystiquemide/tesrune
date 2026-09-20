import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historicalOutcome, validateScenario } from '../src/replay.mjs';

const scenario = JSON.parse(await readFile(new URL('../scenarios/tsla-tariff-weekend-2026-02-21.json', import.meta.url), 'utf8'));

test('validates a cited and labeled historical replay', () => {
  assert.equal(validateScenario(scenario), scenario);
  assert.throws(() => validateScenario({ ...scenario, mode: 'live' }));
  assert.throws(() => validateScenario({ ...scenario, event: { ...scenario.event, url: '' } }));
});

test('accepts a Bitget MCP-sourced scenario without an external url', async () => {
  const coin = JSON.parse(await readFile(new URL('../scenarios/coin-rate-hike-selloff-2026-09-15.json', import.meta.url), 'utf8'));
  assert.equal(validateScenario(coin), coin);
  assert.equal(coin.event.url, '');
  assert.equal(coin.event.mcpSourced, true);
  const outcome = historicalOutcome(coin, 0.02);
  assert.ok(outcome.gapPercent < 0, `expected a downside gap, got ${outcome.gapPercent}`);
  assert.match(outcome.uncertainty, /COINUSDT/);
  // mcpSourced is required when there is no url
  assert.throws(() => validateScenario({ ...coin, event: { ...coin.event, mcpSourced: false } }));
});

test('keeps the historical counterfactual separate and exactly recomputable', () => {
  assert.deepEqual(historicalOutcome(scenario, 0.02), {
    label: 'historical counterfactual range, not the current demo fill or an exact historical fill',
    fridayClose: 411.82,
    mondayOpen: 407.285,
    mondayClose: 399.83,
    gapPerShare: -4.535,
    gapPercent: -1.10120927,
    heldQty: 0.04,
    hedgeQty: 0.02,
    unhedgedGapPnl: -0.1814,
    hypotheticalHedgeGrossRange: [0.0532, 0.2194],
    combinedAtOpenBeforeCostsRange: [-0.1282, 0.038],
    uncertainty: 'Entry and unwind are bounded by the Bitget TSLAUSDT 4H candle lows/highs because exact historical fills are unavailable.',
    sources: { stock: 'Bitget MCP equity_price_historical (provider: Massive)', perp: 'Bitget public TSLAUSDT 4H candles' },
    entryCandle: scenario.historical.entryCandle,
    unwindCandle: scenario.historical.unwindCandle
  });
});
