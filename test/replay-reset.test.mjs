import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterReplayRecords, readReplayReset, resetReplayState } from '../src/replay-reset.mjs';

const resetAt = '2026-09-21T12:00:00.000Z';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(path, rows) {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('resets local replay state without deleting replay evidence or book state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tesrune-replay-reset-'));
  const replayProposal = {
    id: 'replay-proposal',
    pendingStatus: 'pending',
    event: { historicalReplay: true }
  };
  const liveProposal = { id: 'live-proposal', pendingStatus: 'pending', event: { historicalReplay: false } };
  const replaySchedule = { cycleId: 'replay-cycle', mode: 'replay', status: 'complete', armedAt: '2026-09-21T11:00:00.000Z' };
  const liveSchedule = { cycleId: 'live-cycle', mode: 'live', status: 'complete', armedAt: '2026-09-21T11:00:00.000Z' };
  const replayEvidence = { ts: '2026-09-21T11:30:00.000Z', historicalReplay: true, eventId: 'replay-event' };
  const liveEvidence = { ts: '2026-09-21T11:30:00.000Z', historicalReplay: false, eventId: 'live-event' };
  const book = { confirmedAt: '2026-09-21T10:00:00.000Z', holdings: [{ ticker: 'TSLA', qty: 100 }] };

  await writeJson(join(directory, 'book.json'), book);
  await writeJson(join(directory, 'pending.json'), [replayProposal, liveProposal]);
  await writeJson(join(directory, 'schedule.json'), [replaySchedule, liveSchedule]);
  await writeJson(join(directory, 'replay-session.json'), { scenarioName: 'tsla.json', prepared: {}, cycle: {} });
  await writeJsonl(join(directory, 'proposals.jsonl'), [replayEvidence, liveEvidence]);
  await writeJsonl(join(directory, 'declines.jsonl'), [replayEvidence, liveEvidence]);
  await writeJsonl(join(directory, 'cycles.jsonl'), [
    { ...replayEvidence, cycleId: 'replay-cycle', mode: 'replay', status: 'closed' },
    { ...liveEvidence, cycleId: 'live-cycle', mode: 'live', status: 'closed' }
  ]);

  const result = await resetReplayState({ dataDir: directory, resetAt });

  assert.equal(result.resetAt, resetAt);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'book.json'), 'utf8')), book);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'pending.json'), 'utf8')), [liveProposal]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'schedule.json'), 'utf8')), [liveSchedule]);
  assert.deepEqual(await readReplayReset(directory), { resetAt });
  await assert.rejects(readFile(join(directory, 'replay-session.json'), 'utf8'), { code: 'ENOENT' });

  // Append-only evidence remains on disk and is hidden from the next desk state by the reset marker.
  assert.match(await readFile(join(directory, 'proposals.jsonl'), 'utf8'), /replay-event/);
  assert.deepEqual(filterReplayRecords([replayEvidence, liveEvidence], resetAt), [liveEvidence]);
  assert.deepEqual(filterReplayRecords([{ ...replayEvidence, ts: '2026-09-21T12:00:01.000Z' }, liveEvidence], resetAt), [
    { ...replayEvidence, ts: '2026-09-21T12:00:01.000Z' },
    liveEvidence
  ]);
});

test('refuses to reset while a replay may still have an external hedge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tesrune-replay-reset-active-'));
  await writeJson(join(directory, 'pending.json'), [{ id: 'executing-replay', pendingStatus: 'executing', event: { historicalReplay: true } }]);
  await writeJson(join(directory, 'schedule.json'), [{ cycleId: 'open-replay', mode: 'replay', status: 'held-replay' }]);
  await writeJson(join(directory, 'replay-session.json'), { scenarioName: 'tsla.json', prepared: {}, cycle: { status: 'open' } });
  await writeJsonl(join(directory, 'cycles.jsonl'), [{ ts: resetAt, cycleId: 'open-replay', mode: 'replay', status: 'open' }]);

  await assert.rejects(resetReplayState({ dataDir: directory, resetAt: '2026-09-21T12:01:00.000Z' }), /Finish the open replay hedge before resetting the demo/);
  assert.equal(await readReplayReset(directory), null);
  assert.match(await readFile(join(directory, 'replay-session.json'), 'utf8'), /tsla\.json/);
});
