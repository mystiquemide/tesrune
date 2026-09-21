import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDeskServer, routeIntent } from '../src/desk.mjs';

test('routes the judge-path natural language intents', () => {
  assert.deepEqual(routeIntent('hedge 150 TSLA'), { intent: 'hedge', qty: 150, ticker: 'TSLA' });
  assert.equal(routeIntent('what moved my names while the market was closed').intent, 'research');
  assert.equal(routeIntent('why did you decline').intent, 'declines');
  assert.equal(routeIntent('status').intent, 'status');
  assert.equal(routeIntent('hello').intent, 'help');
});

test('serves health, state and scenario endpoints without secrets', async () => {
  const server = await createDeskServer({ port: 0, scheduler: false });
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/api/health`).then((response) => response.json());
    assert.deepEqual(health, { ok: true, product: 'Tesrune' });
    const state = await fetch(`${base}/api/state`).then((response) => response.json());
    assert.equal(state.product, 'Tesrune');
    assert.equal(state.venue, 'Bitget demo trading');
    assert.equal(JSON.stringify(state).includes('QWEN_API_KEY'), false);
    assert.equal(JSON.stringify(state).includes('BITGET_PAPER_SECRET_KEY'), false);
    const scenarios = await fetch(`${base}/api/scenarios`).then((response) => response.json());
    assert.ok(scenarios.scenarios.includes('tsla-tariff-weekend-2026-02-21.json'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('returns structured client errors', async () => {
  const server = await createDeskServer({ port: 0, scheduler: false });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /JSON/);
    const csrf = await fetch(`http://127.0.0.1:${port}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"text":"status"}' });
    assert.equal(csrf.status, 415);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('exposes the replay reset and desk rehydrate controls', async () => {
  const html = await readFile(new URL('../public/desk.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../public/js/desk.js', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="replay-start"') < html.indexOf('id="replay-jump"'));
  assert.ok(html.indexOf('id="replay-jump"') < html.indexOf('id="replay-reset"'));
  assert.match(html, /id="replay-reset"[^>]*>Reset demo</);
  assert.match(html, /id="desk-refresh"/);
  assert.match(script, /\/api\/replay\/reset/);
});
