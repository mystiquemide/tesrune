# Tesrune — Architecture

Version 1.0, 20 September 2026. Every external constraint below was verified against live endpoints on 18 to 20 September 2026.

## 1. System shape

One Node.js 20+ process, ESM, no framework, no build step. Seven modules around one loop, one static page.

```
                 ┌──────────────┐
  user (LUI) ───▶│   desk.mjs   │◀──── public/index.html (poll /api/state, POST /api/*)
                 └──────┬───────┘
                        │
   clock.mjs ◀──────────┼──────────▶ book.mjs (Qwen parse, resolver)
       │                │
       ▼                ▼
  feeds.mjs ──▶ materiality.mjs (Qwen) ──▶ mandate.mjs ──▶ proposal card
   (MCP news,                                  │                 │ user confirms
    EDGAR 8-K,                                 │                 ▼
    perp marks)                                └────────▶ execution.mjs ──▶ Bitget demo engine
                                                              │
                                                    unwind.mjs (09:29 ET scheduler)
                                                              │
                                                    log.mjs ── data/*.jsonl ── evidence pack
```

Rule of separation: `materiality.mjs` (the LLM) produces opinions. `mandate.mjs` (pure functions) decides whether an order may exist. `execution.mjs` only accepts orders that carry a mandate stamp. The LLM has no code path to the exchange.

## 2. Modules

### clock.mjs

- Timezone: America/New_York via `Intl.DateTimeFormat`. No external tz lib.
- US market calendar: NYSE holidays 2026 hardcoded list (Labor Day passed; none fall in 21 to 27 Sep). Half days irrelevant in window.
- Windows per ET day:
  - `broker_open`: 04:00 to 20:00 ET on trading days (covers extended hours at brokers that offer them; conservative).
  - `dark`: 20:00 ET to 04:00 ET next trading day, and Fri 20:00 ET to Mon 04:00 ET, and holidays.
  - `pre_bell`: 04:00 to 09:30 ET. Hedges are not proposed here; open hedges are unwound at 09:29 ET.
- `state(now)` returns `{ window, nextBell, nextDarkStart, msToUnwind }`. `isDark(now)` is the only predicate mandate.mjs uses. Unit-tested against fixed timestamps including DST edge (US DST ends Nov 1 2026, outside window).
- Replay mode: `clock.now()` reads from a controllable source so the judge path can jump to 09:29 ET.

### book.mjs

- Input: free text ("100 TSLA, 40 NVDA and 25 MSTR at IBKR").
- Qwen parses to `[{ticker, qty, broker?}]` with structured JSON output. User confirms the parse before it becomes the book. Deterministic regex fallback when Qwen is unavailable, labeled `source: rules`.
- Resolver per ticker:
  - perp symbol = `${TICKER}USDT` on USDT-FUTURES.
  - `demoListed`: checked against `GET /api/v2/mix/market/contracts?productType=USDT-FUTURES` with `paptrading: 1`. Verified 20 Sep: TSLA NVDA MSTR COIN HOOD AAPL META AMZN GOOGL CRCL SNDK SPCX listed; SP500USDT and NDX100USDT available as index proxies.
  - `liveListed`: checked against the live contracts endpoint (797 contracts).
  - status: `hedgeable` | `proxy_only` (P2) | `unlisted`.
  - mark from `GET /api/v2/mix/market/ticker` (demo header for demo, none for live). Underlying quote from MCP `equity_price_quote` for the "vs Friday close" line.
  - notional = qty × mark. Contract specs verified: minTradeNum 0.01, sizeMultiplier 0.01, pricePlace 2, volumePlace 2, minTradeUSDT 5.
- Book persisted to `data/book.json`.

### feeds.mjs

Three sources, each normalized to `{ id, ts, source, tickers[], title, body, url }` and deduped by id.

1. bitget-mcp-server news. HTTP MCP at `https://agent.bitget.com/mcp`. Protocol verified 20 Sep: POST `initialize` (protocolVersion 2025-03-26) returns `mcp-session-id` header; send `notifications/initialized`; then `tools/call` with `name: "do_query"`, `arguments: { entry_id, params }`. Responses are SSE (`event: message` / `data: {...}`), parse the `data:` line. Entry `news_label_search` requires `label` in `crypto | stocks | commodities & forex | macro` and returns 204 empty without `start_time`/`end_time`; with a window it returns Bitget editorial articles with title, HTML content, publish time. Poll `stocks` and `macro` with a rolling 6-hour window every 5 minutes during dark hours. Ticker tagging by regex over title and content against the book's tickers.
2. SEC EDGAR 8-K Atom feed per issuer: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom` filtered by CIK, or per-company `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<cik>&type=8-K&output=atom`. Requires a descriptive `User-Agent` header per SEC policy. CIK map for the supported tickers hardcoded. Item codes (2.02 results, 5.02 officer departure, 8.01 other events, 1.01 material agreement) passed to the classifier as structured hints. This is the ticker-exact, dark-hours source; companies file 8-Ks after the close routinely.
3. Perp mark move: if the demo or live perp mark for a held name moves more than 2% from the last broker close while dark, emit a synthetic `price_move` event so the classifier can see the market already reacting.

`bitget-signal` (crypto macro/sentiment) is called only for crypto-linked names (MSTR, COIN, HOOD) as context, via its CLI if installed; absent, the classifier proceeds without it and the card says so.

### materiality.mjs

- Qwen via OpenAI-compatible `chat/completions`, `response_format: json_object`, temperature 0.2. Env: `QWEN_API_KEY`, `QWEN_BASE_URL` (default `https://hackathon.bitgetops.com/v1`), `QWEN_MODEL` (default `qwen3.8-max`). Same client shape as frozenmark/src/classifier.mjs, verified working 18 Sep.
- Input per event: event, the held names it touches, each name's qty, mark, last broker close, mark move since close, 8-K item codes, bitget-signal context if any.
- Output per (event, ticker): `{ class: material | priced | noise, direction: down | up | unclear, confidence 0-1, hedge_ratio 0-1, reasoning }`.
- Rule fallback when Qwen is unavailable: 8-K item 2.02/5.02/1.01 → material, direction unclear, ratio 0.5; everything else noise. Labeled `source: rules`.
- The classifier never sees account balances and never emits an order. `hedge_ratio` is a suggestion that mandate.mjs caps.

### mandate.mjs (pure, tested)

```
propose(book, verdict, clockState, openHedges) -> Proposal | Decline
```

Rules, in order, each producing a typed Decline with reason:

1. `NOT_DARK`: clockState.window !== 'dark'.
2. `NOT_MATERIAL`: verdict.class !== 'material' or confidence < 0.6.
3. `DIRECTION_UP`: hedging is a short against a long; an "up" material event yields a decline (we do not add exposure). Logged as `no_hedge_needed`.
4. `UNLISTED`: no demo perp for the name.
5. `CAP`: qty = min(round(qty_held × hedge_ratio, 0.01), qty_held − openShortQty). If the request (user or LLM) exceeds this, clip and record `clipped_from`.
6. `MIN_SIZE`: notional ≥ 5 USDT and qty ≥ 0.01.
7. `DUPLICATE`: one open hedge per name per dark window.

Proposal carries: symbol, side sell, posSide short, qty, mark, notional, takerFee (0.06%), fundingEstimate (next settlement rate × notional × settlements before bell), unwindAt (next 09:29 ET), event reference, verdict, `mandate: { checks: [...], stamp }`. The stamp is a hash over the fields; execution refuses anything without a valid stamp.

User-initiated requests ("short 150 TSLA") go through the same function with the user's number as hedge input, so the CAP and NOT_DARK refusals are demonstrable at any time.

### execution.mjs

Two venues behind one interface: `place(proposal)`, `close(symbol, holdSide)`, `positions()`, `account()`.

- `demo` (default): signed v2 REST with `paptrading: 1`, HMAC-SHA256 over `ts + method + path + body`, headers ACCESS-KEY / ACCESS-SIGN / ACCESS-PASSPHRASE / ACCESS-TIMESTAMP. Verified behaviors (18 Sep): `POST /api/v2/mix/order/place-order` needs `marginMode: crossed`, `marginCoin: USDT`, `productType: USDT-FUTURES`, `side: sell`, `posSide: short`, `tradeSide: open`, `orderType: market`, `size` as string with 2 decimals. Close path is only `POST /api/v2/mix/order/close-positions {symbol, productType, holdSide: short, marginCoin}` which flash-closes the whole side; since Tesrune holds at most one hedge per name this is exact. Demo account equity ~1,992 USDT as of 20 Sep; virtual top-up available on the demo page.
- `live` (flag `TESRUNE_LIVE=1`): `bgc order --action place ...` via the agentic account, dry-run first. Not exercised in the proof run because the account is unfunded; kept honest in README.
- Every call is `dryRun` first, then real. Both payloads logged.

### unwind.mjs

- On fill, schedule `close` at `unwindAt` (09:29:00 ET). In-process timer plus a persisted `data/schedule.json` so a restart re-arms.
- Retry every 15 seconds until `positions()` shows the side flat, max 20 attempts, then write an `UNWIND_FAILED` line and surface a red banner in the UI. No silent failure.
- After the unwind fill, compute cycle P&L: hedge P&L from fills, versus the underlying's close-to-open move (MCP `equity_price_quote` prev_close and open) applied to the hedged quantity. Both numbers on the card; no netting claims beyond that.

### log.mjs

Append-only JSONL under `data/`:

- `events.jsonl`: every normalized feed item.
- `verdicts.jsonl`: every classifier output with source.
- `declines.jsonl`: every Decline with rule and inputs.
- `cycles.jsonl`: proposal, confirmation, dryRun, fill, unwind fill, P&L, all timestamps.
- `orders.jsonl`: raw request and response for every exchange write.

The evidence pack is a curated copy of these plus screenshots, committed under `evidence/` before submission. `data/` itself stays ignored.

### desk.mjs (HTTP + LUI backend)

- `node src/desk.mjs` serves `public/` and JSON endpoints on 127.0.0.1:4310.
- `GET /api/state`: clock state, book, open hedges, last 50 events, pending proposal, last cycles, declines.
- `POST /api/book` `{ text }` → parse → `{ parsed, needsConfirm }`; `POST /api/book/confirm`.
- `POST /api/ask` `{ text }`: the LUI. Intents: set book, "what moved my names", "hedge X", "why did you decline", "status". Qwen routes intent with a small JSON schema; regex fallback.
- `POST /api/proposal/confirm` `{ stamp }` → execution.
- `POST /api/replay` `{ scenario }` → loads a labeled historical event and marks, sets the clock source to replay time, runs the same pipeline against the demo engine (real fill, real unwind when the replay clock is advanced). Every replay artifact carries `mode: replay`.
- Research task endpoint for the Desk requirement: `POST /api/ask` with "what moved my names while the market was closed" returns a cited digest built from `events.jsonl` and verdicts, per name, with MCP quote deltas.

## 3. Data flow, one dark-hours cycle

1. clock says `dark`. feeds polls MCP news (windowed), EDGAR 8-K, perp marks.
2. New event touching TSLA. materiality returns `material, down, 0.82, ratio 0.75, reasoning`.
3. mandate: dark ✓, material ✓, direction down ✓, listed ✓, cap: 100 × 0.75 = 75 TSLAUSDT, min size ✓, no open hedge ✓. Proposal card stamped.
4. UI shows the card. User confirms.
5. execution: dryRun payload logged, then place. Fill id, price, size logged. Position visible via `positions()`.
6. unwind schedules 09:29 ET. At 09:29, close-positions; retry until flat. Cycle P&L written.
7. Research digest and cycle timeline update.

Negative paths: any Decline writes `declines.jsonl` and renders a card with the rule name and reason. The three judge refusals map to `NOT_DARK`, `CAP` (clipped), and `NOT_MATERIAL` with class `priced`.

## 4. Failure and edge handling

- MCP session expiry: re-initialize on any non-200 or missing session; sessions are cheap.
- MCP news returns 204 without a window: always send a window. Editorial latency is real; EDGAR is the fast source for company events, perp mark moves are the fast source for market reaction.
- Qwen down: rules fallback, cards say `source: rules`, hedges still require the user click.
- Demo engine rejects (40774, 22002): payload shapes are pinned to the verified ones; errors are logged raw and shown.
- Restart during an open hedge: `schedule.json` re-arms the unwind; `positions()` reconciles on boot and adopts any open short on a held name as a managed hedge.
- Clock drift: unwind fires on ET wall clock from `Date.now()`; VPS NTP assumed; a 60-second early margin (09:29) covers it.
- Weekend: `dark` from Fri 20:00 ET to Mon 04:00 ET; unwind Monday 09:29 ET; funding estimate uses the observed near-zero weekend rate but reads the live `fundingRate` field each cycle.

## 5. Infra

- Node.js 20+ ESM, zero runtime dependencies (fetch, crypto, http built in). Dev dependency: `node --test` only.
- Storage: JSONL plus `book.json`, `schedule.json`. No database.
- UI: one static HTML page, vanilla JS, polling every 3 seconds. Spec in DESIGN.md.
- Secrets: `.env` (ignored) with `BITGET_PAPER_*`, `QWEN_*`. `.env.example` committed.
- Repo hygiene: memory.md, PRD, TASKS, data/ ignored. README is the judge surface.
- Process: `node src/desk.mjs` runs the loop and the server. A second entry `node src/cycle.mjs --replay <scenario>` runs a headless replay for the evidence pack.
