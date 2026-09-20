import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticker as perpTicker } from './execution.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.TESRUNE_DATA_DIR ?? join(ROOT, 'data');
const LOG = join(DATA_DIR, 'events.jsonl');
const MCP_URL = 'https://agent.bitget.com/mcp';
const CIKS = {
  TSLA: '0001318605',
  NVDA: '0001045810',
  MSTR: '0001050446',
  COIN: '0001679788',
  HOOD: '0001783879',
  AAPL: '0000320193',
  META: '0001326801',
  AMZN: '0001018724',
  GOOGL: '0001652044'
};

function decodeXml(value = '') {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function stripHtml(value = '') {
  return decodeXml(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tagTickers(text, tickers) {
  const upper = text.toUpperCase();
  return tickers.filter((ticker) => new RegExp(`(^|[^A-Z])${ticker}([^A-Z]|$)`).test(upper));
}

function sseJson(text) {
  const line = text.split('\n').find((value) => value.startsWith('data: '));
  if (!line) throw new Error('MCP response did not contain an SSE data event');
  return JSON.parse(line.slice(6));
}

async function mcpPost(body, sessionId) {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Bitget MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
  return { message: text ? sseJson(text) : null, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

export class BitgetMcpClient {
  #sessionId;
  #id = 0;

  async initialize() {
    const response = await mcpPost({
      jsonrpc: '2.0',
      id: ++this.#id,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tesrune', version: '0.0.1' } }
    });
    this.#sessionId = response.sessionId;
    if (!this.#sessionId) throw new Error('Bitget MCP did not return a session id');
    await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, this.#sessionId);
    return response.message?.result?.serverInfo;
  }

  async query(entryId, params, retried = false) {
    if (!this.#sessionId) await this.initialize();
    let response;
    try {
      response = await mcpPost({
        jsonrpc: '2.0',
        id: ++this.#id,
        method: 'tools/call',
        params: { name: 'do_query', arguments: { entry_id: entryId, params } }
      }, this.#sessionId);
    } catch (error) {
      if (retried) throw error;
      this.#sessionId = undefined;
      await this.initialize();
      return this.query(entryId, params, true);
    }
    const result = response.message?.result;
    const text = result?.content?.find(({ type }) => type === 'text')?.text;
    const payload = result?.structuredContent ?? (text ? JSON.parse(text) : null);
    if (!payload?.success) throw new Error(`Bitget MCP query failed: ${JSON.stringify(payload?.error ?? payload)}`);
    return payload.status_code === 204 ? null : payload.data;
  }
}

export function parseEdgarAtom(xml, ticker) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map(([, entry]) => {
    const field = (name) => decodeXml(entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`))?.[1]?.trim() ?? '');
    const url = decodeXml(entry.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"/)?.[1] ?? field('filing-href'));
    const accession = field('accession-number');
    const itemsText = field('items-desc') || stripHtml(field('summary'));
    const itemCodes = [...itemsText.matchAll(/\b([0-9]+\.[0-9]+)\b/g)].map((match) => match[1]);
    return {
      id: `sec:${accession}`,
      ts: new Date(field('updated')).toISOString(),
      source: 'sec-edgar',
      tickers: [ticker],
      title: `${ticker} 8-K ${itemCodes.length ? `items ${itemCodes.join(', ')}` : 'current report'}`,
      body: stripHtml(field('summary')),
      url,
      meta: { accession, form: field('filing-type') || '8-K', itemCodes }
    };
  }).filter(({ id }) => id !== 'sec:');
}

export async function edgarFilings(ticker, { count = 10 } = {}) {
  const cik = CIKS[ticker];
  if (!cik) return [];
  const userAgent = process.env.EDGAR_USER_AGENT ?? 'Tesrune research desk splashmediahub@gmail.com';
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=8-K&output=atom&count=${count}`;
  const response = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/atom+xml' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`SEC EDGAR HTTP ${response.status}`);
  return parseEdgarAtom(await response.text(), ticker);
}

export function normalizeMcpNews(data, tickers, label = 'stocks') {
  const rows = data?.results ?? [];
  return rows.map((row, index) => {
    const title = stripHtml(row.title ?? 'Bitget market news');
    const body = stripHtml(row.content ?? row.summary ?? row.description ?? '');
    const tsRaw = row.publish_time ?? row.published_at ?? row.created_at ?? row.time ?? data?.extra?.metadata?.timestamp;
    const numericTime = tsRaw !== null && tsRaw !== undefined && Number.isFinite(Number(tsRaw));
    const ts = numericTime ? new Date(Number(tsRaw)).toISOString() : new Date(tsRaw ?? 0).toISOString();
    const url = row.url ?? row.link ?? row.source_url ?? '';
    const id = row.id ?? row.news_id ?? `${ts}:${title}:${index}`;
    const tagged = label === 'macro' ? tickers : tagTickers(`${title} ${body}`, tickers);
    return { id: `mcp:${id}`, ts, source: 'bitget-mcp-news', tickers: tagged, title, body, url, meta: { label } };
  }).filter(({ tickers: tagged }) => tagged.length > 0);
}

export async function mcpNews(tickers, { start, end, client = new BitgetMcpClient() } = {}) {
  const startTime = (start ?? new Date(Date.now() - 6 * 3_600_000)).toISOString();
  const endTime = (end ?? new Date()).toISOString();
  const labels = ['stocks', 'macro'];
  const batches = await Promise.all(labels.map((label) => client.query('news_label_search', {
    label,
    language_id: 'en',
    page: 1,
    page_size: 20,
    start_time: startTime,
    end_time: endTime
  })));
  return batches.flatMap((data, index) => normalizeMcpNews(data, tickers, labels[index]));
}

export async function equityQuote(ticker, client = new BitgetMcpClient()) {
  const data = await client.query('equity_price_quote', { symbol: ticker });
  return data?.results?.[0] ?? null;
}

export function priceMoveEvent(ticker, mark, quote, threshold = 0.02) {
  const close = Number(quote?.close ?? quote?.prev_close);
  const live = Number(mark?.markPrice ?? mark?.lastPr);
  if (!Number.isFinite(close) || !Number.isFinite(live) || close <= 0) return null;
  const move = (live - close) / close;
  if (Math.abs(move) < threshold) return null;
  return {
    id: `move:${ticker}:${new Date(Number(mark.ts ?? Date.now())).toISOString().slice(0, 16)}`,
    ts: new Date(Number(mark.ts ?? Date.now())).toISOString(),
    source: 'bitget-perp-move',
    tickers: [ticker],
    title: `${ticker} perp moved ${(move * 100).toFixed(2)}% from the last stock close`,
    body: `Bitget ${ticker}USDT mark ${live}; underlying close ${close}.`,
    url: '',
    meta: { mark: live, close, move }
  };
}

async function knownIds() {
  try {
    return new Set((await readFile(LOG, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).id));
  } catch {
    return new Set();
  }
}

export async function appendUnique(events) {
  const ids = await knownIds();
  const unique = events.filter(({ id }) => id && !ids.has(id) && ids.add(id));
  if (!unique.length) return [];
  await mkdir(dirname(LOG), { recursive: true });
  await appendFile(LOG, `${unique.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return unique;
}

export function eventsInRange(events, start, end) {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  return events.filter(({ ts }) => {
    const time = new Date(ts).getTime();
    return Number.isFinite(time) && time >= from && time <= to;
  });
}

export async function pollFeeds(tickers, { start, end } = {}) {
  const rangeStart = start ?? new Date(Date.now() - 6 * 3_600_000);
  const rangeEnd = end ?? new Date();
  const errors = [];
  const capture = async (label, promise, fallback) => {
    try {
      return await promise;
    } catch (error) {
      errors.push({ source: label, error: error.message });
      return fallback;
    }
  };
  const client = new BitgetMcpClient();
  const mcpReady = await capture('bitget-mcp-init', client.initialize().then(() => true), false);
  const [news, filingGroups, quotes, marks] = await Promise.all([
    mcpReady ? capture('bitget-mcp-news', mcpNews(tickers, { start: rangeStart, end: rangeEnd, client }), []) : [],
    Promise.all(tickers.map((ticker) => capture(`sec-edgar:${ticker}`, edgarFilings(ticker, { count: 10 }), []))),
    mcpReady ? Promise.all(tickers.map((ticker) => capture(`bitget-mcp-quote:${ticker}`, equityQuote(ticker, client), null))) : tickers.map(() => null),
    Promise.all(tickers.map((ticker) => capture(`bitget-perp:${ticker}`, perpTicker(`${ticker}USDT`), null)))
  ]);
  const filings = eventsInRange(filingGroups.flat(), rangeStart, rangeEnd);
  const moves = tickers.map((ticker, index) => priceMoveEvent(ticker, marks[index], quotes[index])).filter(Boolean);
  const events = [...news, ...filings, ...moves];
  return { events: await appendUnique(events), quotes: Object.fromEntries(tickers.map((ticker, index) => [ticker, quotes[index]])), marks: Object.fromEntries(tickers.map((ticker, index) => [ticker, marks[index]])), errors };
}

async function cli() {
  if (!process.argv.includes('--once')) throw new Error('Use --once');
  const tickers = ['TSLA', 'NVDA', 'MSTR'];
  const result = await pollFeeds(tickers, { start: new Date(Date.now() - 7 * 24 * 3_600_000), end: new Date() });
  const latestEdgar = (await edgarFilings('TSLA', { count: 10 }))[0] ?? null;
  console.log(JSON.stringify({
    written: result.events.length,
    sources: Object.fromEntries([...new Set(result.events.map(({ source }) => source))].map((source) => [source, result.events.filter((event) => event.source === source).length])),
    latest: result.events.slice(0, 5),
    latestEdgar,
    errors: result.errors,
    tslaQuote: result.quotes.TSLA,
    tslaMark: result.marks.TSLA
  }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});

export { CIKS, LOG, sseJson, stripHtml, tagTickers };
