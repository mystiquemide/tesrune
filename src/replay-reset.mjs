import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function paths(dataDir) {
  return {
    pending: join(dataDir, 'pending.json'),
    schedule: join(dataDir, 'schedule.json'),
    cycles: join(dataDir, 'cycles.jsonl'),
    session: join(dataDir, 'replay-session.json'),
    reset: join(dataDir, 'replay-reset.json')
  };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readJsonl(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function latestCycleStates(rows) {
  const states = new Map();
  for (const row of rows) {
    if (row.cycleId) states.set(row.cycleId, row);
  }
  return [...states.values()];
}

export function isReplayRecord(record) {
  return Boolean(
    record?.historicalReplay === true ||
    record?.mode === 'replay' ||
    record?.mode === 'historical_replay' ||
    record?.event?.historicalReplay === true ||
    record?.event?.meta?.historicalReplay === true ||
    record?.proposal?.event?.historicalReplay === true ||
    record?.decision?.historicalReplay === true ||
    record?.decision?.event?.historicalReplay === true ||
    record?.decision?.event?.meta?.historicalReplay === true
  );
}

function recordTimestamp(record, fields) {
  for (const field of fields) {
    const value = Date.parse(record?.[field] ?? '');
    if (Number.isFinite(value)) return value;
  }
  return null;
}

// Append-only replay records remain available as evidence, but a reset marker
// keeps them out of the next demo session's derived desk state.
export function filterReplayRecords(rows, resetAt, fields = ['ts']) {
  const boundary = Date.parse(resetAt ?? '');
  if (!Number.isFinite(boundary)) return rows;
  return rows.filter((row) => {
    if (!isReplayRecord(row)) return true;
    const timestamp = recordTimestamp(row, fields);
    return timestamp === null || timestamp > boundary;
  });
}

export async function readReplayReset(dataDir) {
  return readJson(paths(dataDir).reset, null);
}

export async function resetReplayState({ dataDir, resetAt = new Date().toISOString() } = {}) {
  if (!dataDir) throw new Error('A data directory is required to reset the demo');
  const target = paths(dataDir);
  const [pending, schedules, cycleRows, session] = await Promise.all([
    readJson(target.pending, []),
    readJson(target.schedule, []),
    readJsonl(target.cycles),
    readJson(target.session, null)
  ]);
  const replayCycles = latestCycleStates(cycleRows).filter((row) => isReplayRecord(row));
  const replayPending = pending.filter((row) => isReplayRecord(row));
  const replaySchedules = schedules.filter((row) => isReplayRecord(row));
  const externalRisk = replayCycles.some((row) => ['open', 'unwind_failed'].includes(row.status)) ||
    replayPending.some((row) => ['executing', 'unknown'].includes(row.pendingStatus)) ||
    replaySchedules.some((row) => ['held-replay', 'armed', 'closing', 'failed'].includes(row.status)) ||
    ['open', 'unwind_failed'].includes(session?.cycle?.status);
  if (externalRisk) throw new Error('Finish the open replay hedge before resetting the demo');

  await writeJsonAtomic(target.pending, pending.filter((row) => !isReplayRecord(row)));
  await writeJsonAtomic(target.schedule, schedules.filter((row) => !isReplayRecord(row)));
  await unlink(target.session).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await writeJsonAtomic(target.reset, { resetAt });
  return { resetAt, clearedPending: replayPending.length, clearedSchedules: replaySchedules.length };
}
