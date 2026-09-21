# Tesrune Evidence

This is a curated record of real, verified runs. Every number here traces to a logged run. Demo execution and the historical counterfactual are kept in separate sections and are never merged into one P&L number.

Product in one line: an agent that hedges your closed-broker US stock holdings on Bitget stock perpetuals during the hours your broker is dark, and is flat by 09:29 ET before the opening bell. The invariant is "flat by the bell."

Two things to read carefully before the numbers:

- Bitget demo execution means demo-engine fills with virtual funds on the Bitget demo trading environment. These are real order placements and real fills, funded by virtual balances. They are not live-account trades and they are not historical fills.
- The historical replay is a counterfactual. It runs the classifier on information that was available at decision time and prices the hedge against a range of real Bitget candles. It reports a range, not exact fills.

## 1. Test suite

- 83 of 83 tests pass with `node --test 'test/*.test.mjs'` on Node 22.
- Coverage spans the market clock, the signed demo execution client, feeds, book parsing, the mandate rules, materiality classification, the cycle, the unwind scheduler and gap reconciliation, the desk server and state hydration, the Telegram subscriber/notifier flow, the index-proxy sizing and its mandate branch, and both replay scenarios.

## 2. Bitget demo execution cycles (demo-engine fills, virtual funds)

All four cycles below placed real orders on the Bitget demo engine with virtual funds, then verified the TSLA position flat after the unwind. Fees are estimated at the taker rate. Where funding is shown as 0, no funding settlement fell inside the hold.

### T7, synthetic cycle

- Path: confirmed book to fresh marks to windowed feeds to Qwen verdict to mandate to human confirmation to signed demo order.
- Input labeled synthetic: 0.04 TSLA holding to a 0.02 TSLAUSDT short, 7 mandate checks, notional 7.2838.
- Open order `1485550303184060417`, close order `1485550310620561415`.
- Cycle `405b9fcf-77f4-45de-b6f3-ae61fc082692` recorded append-only from open to closed.
- Result: pending 0, open cycles 0, TSLA position flat.

### T8, restart-recovery proof

- Process A opened a synthetic 0.02 TSLA short, order `1485553376786808833`, due to unwind in 10 seconds, then exited.
- Process B started fresh, recovered the persisted schedule, and closed order `1485553430339682306`.
- Fills: 364.18 open to 364.19 close, gross -0.0002, estimated round-trip fees 0.00874176, net -0.00894176.
- Result: schedule complete after 1 attempt, pending 0, open cycles 0, TSLA position flat.
- What this proves: an open hedge survives a process restart and still unwinds on schedule.

### T9, replay cycle

- Current demo execution proof kept separate from the historical counterfactual in the same run.
- Qwen 3.8 Max classified the replay event material and down at confidence 0.70. The deterministic 50 percent default sized 0.02 of the 0.04 holding. Qwen did not size the order.
- Cycle `29b32de7-06c5-4d73-9cc2-966065bd8eef`.
- Open order `1485558571809800204`, close order `1485558574137638913`.
- Current fill P&L: 364.18 to 364.29, gross -0.0022, estimated fees 0.00874176, net -0.01094176.
- Result: schedule complete, pending 0, open cycles 0, TSLA position flat.

### Latest replay cycle through the live desk endpoints

- Ran the whole path through the same API endpoints the browser UI calls, on the self-contained desk build.
- Replay start: Qwen 3.8 Max material and down at confidence 0.72, a 0.02 TSLAUSDT proposal, 64-character mandate stamp.
- Cycle `3ea79a46-9d4a-4e56-86c5-905e46b948bb`, mode replay.
- Confirm: real demo open order `1485611262078517249` at 364.18.
- Jump to unwind: real demo close order `1485611445537374209` at 364.29.
- Net hedge P&L -0.01094152, fees estimated, funding 0.
- Underlying gap P&L: null, labeled "pending next cash-session open."
- Result: pending 0, TSLA position flat.

## 3. Historical replay counterfactual, 21 February 2026 tariff scenario

Honest label: historical counterfactual range, not exact fills. This section prices a hedge against real Bitget candle ranges. It is kept separate from the demo execution above and is never combined with it into a single number.

- Event source: CNN Business, "Global tariff increased from 10% to 15%, effective immediately."
- Event URL: https://www.cnn.com/2026/02/21/business/trump-global-tariffs-increase-supreme-court
- The classifier only saw information available at the Saturday decision time.

Prices, from Bitget MCP historical data and Bitget public TSLAUSDT 4H candles:

- TSLA Friday close: 411.82.
- TSLA Monday open: 407.285.
- Gap: -1.10 percent.
- Held quantity: 0.04. Hedge quantity: 0.02.
- Unhedged gap P&L on the 0.04 holding: -0.1814.
- Hedge gross P&L range: 0.0532 to 0.2194.
- Perp entry candle range used for the entry: 410.92 to 412.00.
- Perp unwind candle range used for the exit: 401.03 to 408.26.

Why a range and not one number: a stock Friday close is not a weekend perp fill, so the hedge is priced across the real perp candle band rather than claimed at an exact price. Before costs, the combined open range across the hedge and the underlying spans -0.1282 to +0.038. These are ranges, not exact fills.

### Second scenario, 15 September 2026 COIN rate-hike selloff

Honest label: historical counterfactual range, sourced from Bitget MCP. The catalyst is Bitget MCP editorial (a daily desk note on rising rate-hike expectations and an AI slowdown scare), so it is cited as the Bitget MCP source, not an external wire, and has no external URL.

- Prices, from Bitget MCP equity_price_historical: 14 Sep close 191.45, 15 Sep open 183.621 (a -4.09% overnight gap), 15 Sep close 172.11.
- Perp candles, from Bitget public COINUSDT 4H candles: entry 2026-09-15T00:00Z open 185.84 high 186.31 low 183.29 close 183.48; unwind 2026-09-15T12:00Z open 181.52 high 181.59 low 168.34 close 172.37.
- Decision time 2026-09-15T00:30Z is a verified dark window; the unwind resolves to 2026-09-15T13:29Z from the clock.
- Outcome on a verified run: Qwen 3.8 Max classified the event "priced" at 0.72 confidence, so the mandate declined it NOT_MATERIAL. This is the honest already-priced refusal path, decided live by the model, not forced. No order was placed.

Together the two scenarios cover both outcomes: TSLA produces a material-down proposal and a full demo cycle, COIN produces a priced-decline.

## 4. Feeds, holdings, and mandate proofs

### T3, feeds

- One clean poll returned 9 current events: 8 Bitget MCP news items and 1 in-window SEC EDGAR 8-K, with no source errors.
- TSLA quote: close 364.18, previous 366.20. TSLAUSDT mark 364.23, funding -0.000049.
- A more recent TSLA EDGAR filing parsed with items 2.02 and 9.01 and a canonical SEC URL, but it was not written because its timestamp fell outside the active poll window. Seed history cannot become a new hedge event.
- 30 of 30 tests passed at this stage.

### T4, book

- Input "100 TSLA, 40 NVDA, 25 MSTR at IBKR" parsed and resolved. All three hedgeable.
- Marks: 364.22, 221.79, 153.17. Notionals: 36,422, 8,871.6, 3,829.25. No open shorts.
- The confirmed book was written only after an explicit confirm step, at file mode 600.
- COST was correctly reported unlisted on the demo engine while liveListed was true.
- 37 of 37 tests passed at this stage.

### T5, mandate declines

- The mandate engine implements seven rules in order: NOT_DARK, NOT_MATERIAL, DIRECTION_UP, UNLISTED, CAP, MIN_SIZE, DUPLICATE.
- Verification fixture: 75 TSLA, notional 27,316.50, taker fees 16.3899 each and 32.7798 round-trip, one funding settlement at -1.3385085, and a 64-character valid mandate stamp.
- Through the desk, "hedge 150 TSLA" produced a proposal clipped to 100 with 7 checks and a Monday 09:29 ET unwind, which demonstrates the CAP refusal live.
- 46 of 46 tests passed at this stage.

### T6, Qwen classification of a real SEC filing

- Real filing `0001193125-26-389858`, an MSTR 8-K with items 7.01 and 8.01 and no substantive detail in the feed, was classified noise and unclear at confidence 0.85 with ratio 0.
- A synthetic fixture was explicitly labeled, and Qwen refused to treat it as real evidence.
- Qwen never sees account balances, never sizes above the cap, and has no code path to the exchange.
- 53 of 53 tests passed at this stage.

## 5. Added capabilities

- Post-open gap reconciliation. After the cash session opens, the desk fetches the real open and computes the gap on the hedged shares and the share of it the hedge offset. It only runs for live cycles while the window is broker-open, and the gap stays null and labeled pending until then. Unit-tested end to end with an injected quote. No live overnight cycle has been reconciled yet because the demo cycles to date are replay-mode, so this is proven by test and mechanism, and populates on a real dark-hours hedge held into the next open.
- Hedge scorecard. The desk aggregates proposals, declines, decline rate, closed cycles, net hedge P&L, average event-to-proposal latency, gaps reconciled, and average hedge offset, computed only from real logged records. Served in the desk state and shown in the Cycles column.
- Live feed. The desk joins recent events with their Qwen verdicts and shows them in the Book column, so the event to classification path is visible. Populates from live feed polls.
- Telegram alerts. Alert-only with a deep link back to the desk to confirm. A test alert to the configured chat returned ok from the Telegram API. The notifier dedupes to one alert per proposal and one per unwind failure, and it never places an order.
- Index-proxy hedge. For an unlisted name, the desk can size a correlation hedge on an index perp using a beta estimated from real returns, capped at the beta target and labeled a proxy with basis risk. Additive to the mandate, off by default behind `TESRUNE_PROXY_HEDGE=1`, and unit-tested including the sizing, the mandate branch, and the book enrichment.

## 6. Limitations and honest labels

- Holdings are self-reported. The user pastes them. We never claim to verify broker positions. The delta cap is enforced against the pasted quantity.
- Demo execution uses virtual funds on the Bitget demo engine. It is not a live UTA account.
- Exact historical perp fills are not available, so the historical counterfactual uses candle ranges rather than exact prices.
- Underlying gap P&L is left null and labeled "pending next cash-session open" until a post-open quote is verified.
- Calm dark windows can produce zero decisions. When nothing is material, the desk reports that honestly and places no order.
