import test from 'node:test';
import assert from 'node:assert/strict';
import { eventsInRange, normalizeMcpNews, parseEdgarAtom, priceMoveEvent, sseJson, stripHtml, tagTickers } from '../src/feeds.mjs';

test('parses JSON-RPC from an MCP SSE response', () => {
  assert.deepEqual(sseJson('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n'), {
    jsonrpc: '2.0',
    id: 1,
    result: { ok: true }
  });
});

test('parses EDGAR 8-K metadata and item codes', () => {
  const xml = `<feed><entry>
    <accession-number>0001628280-26-049213</accession-number>
    <filing-type>8-K</filing-type>
    <filing-href>https://www.sec.gov/filing</filing-href>
    <items-desc>items 2.02 and 9.01</items-desc>
    <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-07-22 Item 2.02: Results</summary>
    <updated>2026-07-22T16:35:52-04:00</updated>
  </entry></feed>`;
  assert.deepEqual(parseEdgarAtom(xml, 'TSLA'), [{
    id: 'sec:0001628280-26-049213',
    ts: '2026-07-22T20:35:52.000Z',
    source: 'sec-edgar',
    tickers: ['TSLA'],
    title: 'TSLA 8-K items 2.02, 9.01',
    body: 'Filed: 2026-07-22 Item 2.02: Results',
    url: 'https://www.sec.gov/filing',
    meta: { accession: '0001628280-26-049213', form: '8-K', itemCodes: ['2.02', '9.01'] }
  }]);
});

test('normalizes Bitget MCP news and tags only held tickers', () => {
  const events = normalizeMcpNews({ results: [{ id: 'n1', title: 'NVDA moves while TSLA stays quiet', content: '<p>COIN is unrelated.</p>', publish_time: '2026-09-20T01:00:00Z', url: 'https://example.com' }] }, ['NVDA', 'TSLA', 'MSTR']);
  assert.deepEqual(events[0].tickers, ['NVDA', 'TSLA']);
  assert.equal(events[0].body, 'COIN is unrelated.');
  assert.equal(events[0].id, 'mcp:n1');
  assert.equal(normalizeMcpNews({ results: [{ title: 'Unrelated company', content: 'No held names', publish_time: '2026-09-20T01:00:00Z' }] }, ['TSLA']).length, 0);
  assert.deepEqual(normalizeMcpNews({ results: [{ title: 'Fed decision', publish_time: '2026-09-20T01:00:00Z' }] }, ['TSLA', 'NVDA'], 'macro')[0].tickers, ['TSLA', 'NVDA']);
});

test('emits a perp move only past the threshold', () => {
  assert.equal(priceMoveEvent('TSLA', { markPrice: '101', ts: '1789900000000' }, { close: 100 }), null);
  const event = priceMoveEvent('TSLA', { markPrice: '97', ts: '1789900000000' }, { close: 100 });
  assert.equal(event.meta.move, -0.03);
  assert.match(event.title, /-3\.00%/);
});

test('strips HTML and matches ticker boundaries', () => {
  assert.equal(stripHtml('<p>TSLA &amp; NVDA</p>'), 'TSLA & NVDA');
  assert.deepEqual(tagTickers('TSLA moved; not XNVDAZ', ['TSLA', 'NVDA']), ['TSLA']);
});

test('keeps only filings inside the active poll window', () => {
  const events = [{ id: 'old', ts: '2026-07-22T20:35:52Z' }, { id: 'current', ts: '2026-09-20T10:00:00Z' }, { id: 'bad', ts: 'invalid' }];
  assert.deepEqual(eventsInRange(events, '2026-09-20T04:00:00Z', '2026-09-20T12:00:00Z'), [events[1]]);
});
