import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmBook, parseHoldings, readBook, resolveHoldings } from './book.mjs';
import { state as clockState } from './clock.mjs';
import { confirmProposal, openCycleStates, pendingProposals, queueDecision, rejectProposal, runOnce } from './cycle.mjs';
import { propose } from './mandate.mjs';
import { jumpToUnwind, loadScenario, prepareReplay } from './replay.mjs';
import { schedules, startScheduler } from './unwind.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.TESRUNE_DATA_DIR ?? join(ROOT, 'data');
const PUBLIC_DIR = join(ROOT, 'public');
const SCENARIO_DIR = join(ROOT, 'scenarios');
const REPLAY_SESSION = join(DATA_DIR, 'replay-session.json');
const LOGS = {
  events: join(DATA_DIR, 'events.jsonl'),
  verdicts: join(DATA_DIR, 'verdicts.jsonl'),
  declines: join(DATA_DIR, 'declines.jsonl'),
  cycles: join(DATA_DIR, 'cycles.jsonl'),
  replays: join(DATA_DIR, 'replays.jsonl')
};
let pendingBookParse;

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readJsonl(path, limit = 50) {
  try {
    const lines = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(JSON.parse);
  } catch {
    return [];
  }
}

async function storedBook() {
  try {
    return await readBook();
  } catch {
    return null;
  }
}

function compactEvent(event) {
  return { ...event, body: event.body ? `${event.body.slice(0, 500)}${event.body.length > 500 ? '…' : ''}` : '' };
}

export function routeIntent(text) {
  const value = String(text ?? '').trim();
  const hedge = value.match(/^hedge\s+(\d+(?:\.\d+)?)\s+([A-Za-z]{1,6})$/i);
  if (hedge) return { intent: 'hedge', qty: Number(hedge[1]), ticker: hedge[2].toUpperCase() };
  if (/what moved|while (?:the )?market was closed|dark hours/i.test(value)) return { intent: 'research' };
  if (/why.*declin|declines?/i.test(value)) return { intent: 'declines' };
  if (/status|open hedge|position/i.test(value)) return { intent: 'status' };
  return { intent: 'help' };
}

export async function researchDigest(book) {
  const activeBook = book ?? await storedBook();
  if (!activeBook?.holdings?.length) throw new Error('Confirm a holdings book first');
  const [events, verdicts] = await Promise.all([readJsonl(LOGS.events, 100), readJsonl(LOGS.verdicts, 100)]);
  const verdictMap = new Map(verdicts.map((entry) => [`${entry.eventId}:${entry.ticker}`, entry.verdict]));
  return activeBook.holdings.map(({ ticker }) => ({
    ticker,
    events: events.filter((event) => event.tickers?.includes(ticker)).slice(-5).reverse().map((event) => ({
      id: event.id,
      ts: event.ts,
      source: event.source,
      title: event.title,
      url: event.url,
      verdict: verdictMap.get(`${event.id}:${ticker}`) ?? null
    }))
  }));
}

function mergeCycles(rows) {
  const merged = new Map();
  for (const row of rows) merged.set(row.cycleId, { ...(merged.get(row.cycleId) ?? {}), ...row });
  return [...merged.values()];
}

async function statePayload() {
  const [book, pending, scheduleRows, cycles, declines, events, replays, replaySession] = await Promise.all([
    storedBook(),
    pendingProposals(),
    schedules(),
    readJsonl(LOGS.cycles, 100),
    readJsonl(LOGS.declines, 30),
    readJsonl(LOGS.events, 20),
    readJsonl(LOGS.replays, 10),
    readJson(REPLAY_SESSION)
  ]);
  return {
    product: 'Tesrune',
    venue: 'Bitget demo trading',
    clock: clockState(),
    book,
    pending,
    schedules: scheduleRows.slice(-20),
    cycles: mergeCycles(cycles).slice(-20),
    declines,
    events: events.map(compactEvent),
    replays,
    replaySession
  };
}

async function writeReplaySession(value) {
  await mkdir(dirname(REPLAY_SESSION), { recursive: true });
  await writeFile(REPLAY_SESSION, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function manualHedge({ qty, ticker: name }) {
  const book = await storedBook();
  if (!book) throw new Error('Confirm a holdings book first');
  const holdings = await resolveHoldings(book.holdings);
  const holding = holdings.find(({ ticker }) => ticker === name);
  if (!holding) throw new Error(`${name} is not in the confirmed book`);
  const event = { id: `manual:${Date.now()}:${name}`, ts: new Date().toISOString(), source: 'human-request', tickers: [name], title: `Human-requested ${name} hedge`, body: 'The human trader requested an explicit hedge quantity.', url: '', meta: {} };
  const verdict = { class: 'material', direction: 'down', confidence: 1, hedge_ratio: 1, reasoning: 'Human trader requested the hedge.', source: 'human-request' };
  const decision = propose({ holding, verdict, clockState: clockState(), openHedges: await openCycleStates(), event, fundingRate: 0, requestedQty: qty });
  return queueDecision({ event, holding, decision });
}

async function ask(text) {
  const routed = routeIntent(text);
  if (routed.intent === 'research') return { ...routed, answer: await researchDigest() };
  if (routed.intent === 'hedge') return { ...routed, answer: await manualHedge(routed) };
  if (routed.intent === 'declines') return { ...routed, answer: await readJsonl(LOGS.declines, 20) };
  if (routed.intent === 'status') return { ...routed, answer: await statePayload() };
  return { ...routed, answer: 'Ask “what moved my names”, “hedge 150 TSLA”, “why did you decline”, or “status”.' };
}

async function scenarioNames() {
  try {
    return (await readdir(SCENARIO_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body exceeds 64 KB');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res, status, value, headers = {}) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(payload);
}

async function serveStatic(pathname, res) {
  let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (relative === 'desk') relative = 'desk.html';
  const path = resolve(PUBLIC_DIR, relative);
  if (!path.startsWith(`${resolve(PUBLIC_DIR)}/`) && path !== resolve(PUBLIC_DIR, 'index.html')) return send(res, 403, { error: 'Forbidden' });
  try {
    const content = await readFile(path);
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }[extname(path)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'" });
    res.end(content);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Content-Type must be application/json' });
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, product: 'Tesrune' });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, await statePayload());
    if (req.method === 'GET' && url.pathname === '/api/scenarios') return send(res, 200, { scenarios: await scenarioNames() });
    if (req.method === 'POST' && url.pathname === '/api/book') {
      const input = await body(req);
      pendingBookParse = await parseHoldings(input.text);
      return send(res, 200, pendingBookParse);
    }
    if (req.method === 'POST' && url.pathname === '/api/book/confirm') {
      if (!pendingBookParse) throw new Error('No parsed book is waiting for confirmation');
      const book = await confirmBook(pendingBookParse);
      pendingBookParse = undefined;
      return send(res, 200, book);
    }
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const input = await body(req);
      return send(res, 200, await ask(input.text));
    }
    if (req.method === 'POST' && url.pathname === '/api/proposal/confirm') {
      const input = await body(req);
      const cycle = await confirmProposal(input.stamp);
      if (cycle.mode === 'replay') {
        const session = await readJson(REPLAY_SESSION, {});
        await writeReplaySession({ ...session, cycle });
      }
      return send(res, 200, cycle);
    }
    if (req.method === 'POST' && url.pathname === '/api/proposal/reject') {
      const input = await body(req);
      return send(res, 200, await rejectProposal(input.stamp));
    }
    if (req.method === 'POST' && url.pathname === '/api/replay/start') {
      const input = await body(req);
      const allowed = await scenarioNames();
      const name = basename(input.scenario ?? allowed[0] ?? '');
      if (!allowed.includes(name)) throw new Error('Unknown replay scenario');
      const scenario = await loadScenario(join(SCENARIO_DIR, name));
      const prepared = await prepareReplay(scenario);
      await writeReplaySession({ scenarioName: name, prepared });
      return send(res, 200, prepared);
    }
    if (req.method === 'POST' && url.pathname === '/api/replay/jump') {
      const session = await readJson(REPLAY_SESSION);
      if (!session?.prepared || !session?.cycle) throw new Error('Open a replay cycle before jumping the clock');
      const artifact = await jumpToUnwind(session.prepared, session.cycle);
      await writeReplaySession({ ...session, artifact });
      return send(res, 200, artifact);
    }
    if (req.method === 'POST' && url.pathname === '/api/run') return send(res, 200, await runOnce());
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    return send(res, 400, { error: error.message });
  }
}

export async function createDeskServer({ host = process.env.TESRUNE_HOST ?? '127.0.0.1', port = Number(process.env.TESRUNE_PORT ?? 4310), scheduler = true } = {}) {
  if (scheduler) await startScheduler();
  const server = createServer((req, res) => handle(req, res));
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolvePromise);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) createDeskServer().then((server) => {
  const address = server.address();
  console.log(`Tesrune desk listening on http://${address.address}:${address.port}`);
}).catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});

export { DATA_DIR, LOGS, REPLAY_SESSION, ask, manualHedge, statePayload };
