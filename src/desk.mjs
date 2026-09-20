import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmBook, parseHoldings, readBook, resolveHoldings } from './book.mjs';
import { state as clockState } from './clock.mjs';
import { confirmProposal, openCycleStates, pendingProposals, queueDecision, rejectProposal, runOnce } from './cycle.mjs';
import { propose } from './mandate.mjs';
import { jumpToUnwind, loadScenario, prepareReplay } from './replay.mjs';
import { reconcileGaps, schedules, startScheduler } from './unwind.mjs';
import { broadcast, fetchNewSubscribers, getBotUsername, runNotifier, telegramConfigured, welcomeMessage } from './notify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.TESRUNE_DATA_DIR ?? join(ROOT, 'data');
const PUBLIC_DIR = join(ROOT, 'public');
const SCENARIO_DIR = join(ROOT, 'scenarios');
const REPLAY_SESSION = join(DATA_DIR, 'replay-session.json');
const NOTIFIED = join(DATA_DIR, 'notified.json');
const SUBS = join(DATA_DIR, 'subscribers.json');
let telegramBot = null;
const LOGS = {
  events: join(DATA_DIR, 'events.jsonl'),
  verdicts: join(DATA_DIR, 'verdicts.jsonl'),
  declines: join(DATA_DIR, 'declines.jsonl'),
  proposals: join(DATA_DIR, 'proposals.jsonl'),
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

function round(value, places = 8) {
  return value === null || value === undefined || Number.isNaN(value) ? null : Number(Number(value).toFixed(places));
}

// Honest aggregate over what the logs actually contain. Every field traces to a
// real record; nothing is modeled or assumed.
function buildScorecard(cycles, declines, proposals) {
  const closed = cycles.filter((c) => c.status === 'closed');
  const proposalCount = proposals.length;
  const declineCount = declines.length;
  const decided = proposalCount + declineCount;
  let netPnl = 0, fees = 0, funding = 0, netCount = 0;
  const latencies = [];
  const offsets = [];
  let gapsReconciled = 0;
  for (const c of cycles) {
    if (c.pnl?.netHedgePnl !== null && c.pnl?.netHedgePnl !== undefined) { netPnl += c.pnl.netHedgePnl; netCount += 1; }
    if (c.pnl?.estimatedFees) fees += c.pnl.estimatedFees;
    if (c.pnl?.estimatedFunding) funding += c.pnl.estimatedFunding;
    if (c.pnl?.underlyingGapPnl !== null && c.pnl?.underlyingGapPnl !== undefined) gapsReconciled += 1;
    if (c.effectiveness?.offsetPct !== null && c.effectiveness?.offsetPct !== undefined) offsets.push(c.effectiveness.offsetPct);
    const evTs = c.proposal?.event?.ts ? Date.parse(c.proposal.event.ts) : NaN;
    const propTs = c.proposal?.createdAt ? Date.parse(c.proposal.createdAt) : NaN;
    if (Number.isFinite(evTs) && Number.isFinite(propTs) && propTs >= evTs) latencies.push((propTs - evTs) / 1000);
  }
  const avg = (a) => (a.length ? round(a.reduce((s, x) => s + x, 0) / a.length, 2) : null);
  return {
    proposals: proposalCount,
    declines: declineCount,
    declineRatePct: decided ? round((declineCount / decided) * 100, 1) : null,
    cyclesClosed: closed.length,
    cyclesOpen: cycles.filter((c) => c.status === 'open').length,
    cyclesFailed: cycles.filter((c) => c.status === 'unwind_failed').length,
    netHedgePnl: netCount ? round(netPnl) : null,
    estimatedFees: round(fees),
    estimatedFunding: round(funding),
    avgEventToProposalSeconds: avg(latencies),
    gapsReconciled,
    avgHedgeOffsetPct: avg(offsets),
    labels: { costs: 'estimated fees and funding', latency: 'event timestamp to signed proposal', offset: 'share of the verified gap covered by the hedge' }
  };
}

function buildFeed(events, verdicts) {
  const vmap = new Map(verdicts.map((v) => [v.eventId, v.verdict]));
  return events.slice(-14).reverse().map((e) => ({
    id: e.id, ts: e.ts, source: e.source, tickers: e.tickers ?? [], title: e.title, url: e.url ?? '',
    verdict: vmap.get(e.id) ? { class: vmap.get(e.id).class, direction: vmap.get(e.id).direction, confidence: vmap.get(e.id).confidence } : null
  }));
}

async function statePayload() {
  const [book, pending, scheduleRows, cycles, declines, proposals, events, verdicts, replays, replaySession] = await Promise.all([
    storedBook(),
    pendingProposals(),
    schedules(),
    readJsonl(LOGS.cycles, 200),
    readJsonl(LOGS.declines, 100),
    readJsonl(LOGS.proposals, 200),
    readJsonl(LOGS.events, 40),
    readJsonl(LOGS.verdicts, 80),
    readJsonl(LOGS.replays, 10),
    readJson(REPLAY_SESSION)
  ]);
  const mergedCycles = mergeCycles(cycles);
  return {
    scorecard: buildScorecard(mergedCycles, declines, proposals),
    feed: buildFeed(events, verdicts),
    telegram: { enabled: telegramConfigured(), bot: telegramBot },
    product: 'Tesrune',
    venue: 'Bitget demo trading',
    clock: clockState(),
    book,
    pending,
    schedules: scheduleRows.slice(-20),
    cycles: mergedCycles.slice(-20),
    declines,
    events: events.map(compactEvent),
    replays,
    replaySession
  };
}

async function loadSubs() {
  const subs = await readJson(SUBS, { chatIds: [], lastUpdateId: 0 });
  subs.chatIds = Array.isArray(subs.chatIds) ? subs.chatIds : [];
  // Seed the operator chat once so existing alerts keep working.
  if (process.env.TELEGRAM_CHAT_ID && !subs.chatIds.includes(process.env.TELEGRAM_CHAT_ID)) {
    subs.chatIds.push(process.env.TELEGRAM_CHAT_ID);
  }
  return subs;
}
async function saveSubs(subs) {
  await mkdir(dirname(SUBS), { recursive: true });
  await writeFile(SUBS, `${JSON.stringify(subs, null, 2)}\n`, { mode: 0o600 });
}

// Subscribe anyone who messages the bot, and welcome new /start chats.
async function subscriberPoll() {
  try {
    const subs = await loadSubs();
    const { chatIds, maxUpdateId } = await fetchNewSubscribers(subs.lastUpdateId);
    let changed = maxUpdateId !== subs.lastUpdateId;
    subs.lastUpdateId = maxUpdateId;
    for (const c of chatIds) {
      const id = String(c.id);
      if (!subs.chatIds.includes(id)) {
        subs.chatIds.push(id);
        changed = true;
        await broadcast([id], welcomeMessage());
      }
    }
    if (changed) await saveSubs(subs);
  } catch {
    // Subscription polling must never break the desk.
  }
}

async function notifyTick() {
  try {
    const [pending, cycleRows, notified, subs] = await Promise.all([
      pendingProposals(),
      readJsonl(LOGS.cycles, 200),
      readJson(NOTIFIED, { proposals: [], failures: [] }),
      loadSubs()
    ]);
    const send = (text) => broadcast(subs.chatIds, text);
    const { notified: next } = await runNotifier({ pending, cycles: mergeCycles(cycleRows), notified, send });
    await mkdir(dirname(NOTIFIED), { recursive: true });
    await writeFile(NOTIFIED, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Alerting must never break the desk.
  }
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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'";

function send(res, status, value, headers = {}) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': typeof value === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(payload);
}

// Same-origin write guard. Browsers send Origin/Referer, so the desk UI works,
// while drive-by curl or a foreign page (which cannot set Origin cross-site
// without CORS) is refused. Localhost dev with no Origin is allowed.
function writeAllowed(req) {
  const host = String(req.headers.host ?? '').toLowerCase();
  const isLocal = host.startsWith('127.0.0.1') || host.startsWith('localhost');
  let origin = req.headers.origin;
  if (!origin && req.headers.referer) { try { origin = new URL(req.headers.referer).origin; } catch { origin = ''; } }
  if (!origin) return isLocal;
  try {
    const oHost = new URL(origin).host.toLowerCase();
    const allowed = new Set([host]);
    if (process.env.TESRUNE_PUBLIC_URL) allowed.add(new URL(process.env.TESRUNE_PUBLIC_URL).host.toLowerCase());
    return allowed.has(oHost);
  } catch {
    return false;
  }
}

async function serveStatic(pathname, res, method = 'GET') {
  let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (relative === 'desk') relative = 'desk.html';
  const path = resolve(PUBLIC_DIR, relative);
  if (!path.startsWith(`${resolve(PUBLIC_DIR)}/`) && path !== resolve(PUBLIC_DIR, 'index.html')) return send(res, 403, { error: 'Forbidden' });
  try {
    const content = await readFile(path);
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }[extname(path)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP, ...SECURITY_HEADERS });
    res.end(method === 'HEAD' ? undefined : content);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Content-Type must be application/json' });
  if (req.method === 'POST' && !writeAllowed(req)) return send(res, 403, { error: 'Cross-origin write refused' });
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
    if (req.method === 'POST' && url.pathname === '/api/cycle/reconcile') return send(res, 200, { reconciled: await reconcileGaps() });
    if (req.method === 'POST' && url.pathname === '/api/notify/test') {
      const subs = await loadSubs();
      return send(res, 200, await broadcast(subs.chatIds, 'Tesrune test alert. If you can read this, dark-hours alerts are wired.'));
    }
    if (req.method === 'POST' && url.pathname === '/api/run') return send(res, 200, await runOnce());
    if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res, req.method);
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    return send(res, 400, { error: error.message });
  }
}

export async function createDeskServer({ host = process.env.TESRUNE_HOST ?? '127.0.0.1', port = Number(process.env.TESRUNE_PORT ?? 4310), scheduler = true } = {}) {
  if (scheduler) await startScheduler();
  if (scheduler && telegramConfigured()) {
    telegramBot = await getBotUsername();
    await subscriberPoll();
    await notifyTick();
    setInterval(() => subscriberPoll().then(() => notifyTick()), 15_000);
  }
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
