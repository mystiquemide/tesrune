import test from 'node:test';
import assert from 'node:assert/strict';
import { isDark, resetNow, setNow, state } from '../src/clock.mjs';

const cases = [
  ['Tuesday 21:00 ET', '2026-09-23T01:00:00.000Z', 'dark'],
  ['Saturday noon ET', '2026-09-26T16:00:00.000Z', 'dark'],
  ['Monday 03:59 ET', '2026-09-21T07:59:00.000Z', 'dark'],
  ['Monday 04:00 ET', '2026-09-21T08:00:00.000Z', 'pre_bell'],
  ['Tuesday 14:00 ET', '2026-09-22T18:00:00.000Z', 'broker_open'],
  ['Friday 19:59 ET', '2026-09-25T23:59:00.000Z', 'broker_open'],
  ['Friday 20:00 ET', '2026-09-26T00:00:00.000Z', 'dark'],
  ['Labor Day noon ET', '2026-09-07T16:00:00.000Z', 'dark']
];

for (const [name, timestamp, expected] of cases) {
  test(name, () => assert.equal(state(timestamp).window, expected));
}

test('dark predicate matches window', () => {
  assert.equal(isDark('2026-09-23T01:00:00.000Z'), true);
  assert.equal(isDark('2026-09-22T18:00:00.000Z'), false);
});

test('next unwind is the next trading day at 09:29 ET', () => {
  assert.equal(state('2026-09-26T01:00:42.000Z').nextUnwind, '2026-09-28T13:29:00.000Z');
});

test('restart during the unwind minute marks the unwind overdue now', () => {
  const result = state('2026-09-22T13:29:01.000Z');
  assert.equal(result.nextUnwind, '2026-09-22T13:29:00.000Z');
  assert.equal(result.msToUnwind, -1000);
});

test('next dark start skips the weekend', () => {
  assert.equal(state('2026-09-26T01:00:00.000Z').nextDarkStart, '2026-09-29T00:00:00.000Z');
});

test('controllable clock source supports replay', () => {
  setNow('2026-07-24T01:15:00.000Z');
  assert.equal(state().window, 'dark');
  assert.equal(state().et, '2026-07-23 21:15:00 ET');
  resetNow();
});

test('DST fallback keeps ET wall-clock semantics', () => {
  assert.equal(state('2026-11-02T09:00:00.000Z').window, 'pre_bell');
  assert.equal(state('2026-11-02T14:30:00.000Z').window, 'broker_open');
});
