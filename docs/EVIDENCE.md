# Tesrune Evidence

Tesrune is an AI Trading Desk for dark-hours US equity risk. It watches confirmed holdings, interprets material overnight events, proposes bounded same-name hedges on Bitget stock perpetuals, requires human confirmation, and schedules every confirmed replay hedge to unwind by 09:29 ET.

**Core invariant:** hold the stock, hedge the dark hours, flat by the bell.

- Live app: https://tesrune.midelabs.xyz
- Demo desk: https://tesrune.midelabs.xyz/desk
- Demo video: https://youtu.be/komtewJZ2Qc
- Telegram alerts: https://t.me/tesrune_desk_bot

This document separates three different kinds of evidence:

1. **Current Bitget demo execution**: real orders and fills on Bitget's demo engine using virtual funds.
2. **Historical replay counterfactuals**: real historical market data used to test the research thesis. These are ranges, not claimed historical fills.
3. **Automated and browser verification**: tests of the mandate, recovery, reset, state hydration, and UI paths.

They are intentionally not merged into one performance number.

## 1. Current build verification

### Automated suite

- **88 of 88 tests pass** with `node --test 'test/*.test.mjs'` on Node 22.
- Syntax checks pass for the JavaScript modules covered by CI.
- The suite covers the market clock, book parsing, event feeds, Qwen materiality handling, deterministic mandate rules, signed proposal validation, Bitget demo execution, replay flows, replay reset semantics, cycle state, unwind and restart recovery, gap reconciliation, desk state and hydration, Telegram alerts, and proxy sizing.
- GitHub Actions CI is configured for pushes and pull requests to `master`.

### Production verification

The deployed desk has been manually verified in a real browser.

Observed after the replay-reset deployment:

- public health endpoint returned HTTP 200;
- public desk returned HTTP 200;
- **Reset demo** is visible;
- the DESK refresh control is visible;
- **Start replay** is enabled on a clean desk;
- **Jump to 09:29** is disabled until a replay hedge is actually open;
- stale replay schedule/session state can be cleared without removing the holdings book;
- replay reset does not call Bitget, Qwen, or an execution path;
- the DESK refresh control only refetches `/api/state` and does not mutate server or exchange state.

## 2. Final judge-path browser run

This is the clean end-to-end path used to verify the current product story.

### TSLA proposal and hedge

- Scenario: TSLA weekend tariff replay.
- Qwen 3.8 Max decision: **material · down · 0.75**.
- The proposal passed the deterministic mandate and required explicit human confirmation.
- After confirmation, Bitget demo trading filled open order **`1485882314327228417`**.
- The desk then advanced to the configured 09:29 ET unwind.
- Bitget demo trading filled close order **`1485882378382639105`**.
- Final cycle state: **CLOSED**.
- The Tesrune-created TSLA replay hedge was verified flat on Bitget.

The flat check is scoped to the Tesrune-created hedge for that replay. It is not a claim that every position in the demo account is flat.

### COIN refusal

- Scenario: COIN replay.
- Qwen 3.8 Max decision on this verified run: **priced · down · 0.68**.
- Deterministic mandate result: **`NOT_MATERIAL`**.
- No hedge was opened.

This is an important product outcome: the desk can end a research task with a refusal rather than manufacturing a trade.

### State hydration

The same run also verified that:

- refreshing during an active proposal restored the pending proposal and confirmation banner;
- refreshing after the TSLA cycle completed restored the closed cycle;
- the COIN refusal was restored after refresh;
- users did not need to repeat onboarding to recover the desk state.

## 3. Replay reset and repeatability proof

The replay reset exists to return the demo to a clean research state without deleting permanent evidence or touching live records.

Reset semantics:

- removes replay-only pending proposals from local pending state;
- removes replay-only schedules;
- deletes the transient replay session;
- writes a local replay-reset marker;
- filters pre-reset replay proposals, declines, and cycles from the derived visible desk state;
- clears the visible replay card/thread, banner, pending slot, and armed theme;
- preserves the holdings book;
- preserves live cycles and live schedules;
- preserves environment and configuration;
- preserves append-only replay/evidence logs.

For safety, reset refuses to run while a replay may still have external exposure, including open, closing, failed, executing, or unknown states. The unwind must be completed or resolved first.

### Browser verification of reset

A separate isolated browser verification used real Qwen classification and Bitget demo execution:

- TSLA produced a Qwen material/down proposal.
- Human confirmation opened Bitget demo order **`1485950445284392961`**.
- Jump to 09:29 closed Bitget demo order **`1485950448769859585`**.
- The cycle closed with no evidence errors and the Tesrune TSLA hedge was verified flat.
- Browser refresh during the active replay restored the pending proposal and banner.
- Browser refresh after completion restored the closed cycle.
- A clean COIN retry produced a **`NOT_MATERIAL`** refusal.
- **Reset demo** then returned the visible replay state to:
  - no replay pending proposals;
  - no replay cycles;
  - no replay declines;
  - zero replay scorecard proposals and declines;
  - no replay session;
  - Start replay enabled;
  - Jump to 09:29 disabled.
- TSLA replay could be started successfully again after reset.
- Clicking the DESK refresh icon left server state unchanged.

Qwen classification is model-driven, so exact confidence, class, or refusal rule can vary between calls. The product records the model's actual output and then applies deterministic mandate rules. It does not hardcode the desired demo outcome.

## 4. Earlier Bitget demo execution proofs

These runs are retained because they verify specific mechanisms independently of the final judge path.

### T7, synthetic execution cycle

- Path: confirmed book → fresh marks → windowed feeds → Qwen verdict → mandate → human confirmation → signed Bitget demo order.
- Explicitly synthetic input: 0.04 TSLA holding, 0.02 TSLAUSDT short, seven mandate checks, notional 7.2838.
- Open order **`1485550303184060417`**.
- Close order **`1485550310620561415`**.
- Cycle **`405b9fcf-77f4-45de-b6f3-ae61fc082692`** was recorded append-only from open to closed.
- Result: pending 0, open cycles 0, Tesrune TSLA hedge flat.

### T8, restart-recovery proof

- Process A opened a synthetic 0.02 TSLA short with order **`1485553376786808833`**, due to unwind in 10 seconds, then exited.
- A fresh Process B recovered the persisted schedule and closed with order **`1485553430339682306`**.
- Fills: 364.18 open to 364.19 close.
- Gross hedge P&L: -0.0002.
- Estimated round-trip fees: 0.00874176.
- Net hedge P&L after estimated fees: -0.00894176.
- Result: schedule complete after one attempt, pending 0, open cycles 0, Tesrune TSLA hedge flat.

What this proves: an open Tesrune hedge can survive a process restart and still unwind from persisted schedule state.

### T9, replay cycle

- Current Bitget demo execution was kept separate from the historical counterfactual.
- Qwen 3.8 Max classified the replay event **material · down · 0.70**.
- The deterministic 50% default sized 0.02 against the 0.04 holding. Qwen did not size the order.
- Cycle **`29b32de7-06c5-4d73-9cc2-966065bd8eef`**.
- Open order **`1485558571809800204`**.
- Close order **`1485558574137638913`**.
- Current-fill P&L: 364.18 to 364.29, gross -0.0022.
- Estimated fees: 0.00874176.
- Net hedge P&L after estimated fees: -0.01094176.
- Result: schedule complete, pending 0, open cycles 0, Tesrune TSLA hedge flat.

### Prior live-desk endpoint cycle

- Ran through the same API endpoints used by the browser UI.
- Qwen 3.8 Max: **material · down · 0.72**.
- Proposal: 0.02 TSLAUSDT with a 64-character mandate stamp.
- Cycle **`3ea79a46-9d4a-4e56-86c5-905e46b948bb`**, mode replay.
- Open order **`1485611262078517249`** at 364.18.
- Close order **`1485611445537374209`** at 364.29.
- Net hedge P&L: -0.01094152 with estimated fees and funding 0.
- Underlying gap P&L remained null and explicitly labeled **pending next cash-session open**.
- Result: pending 0, Tesrune TSLA hedge flat.

## 5. Historical replay counterfactuals

Historical scenarios test whether the research thesis would have had something meaningful to evaluate. They are not presented as exact historical executions.

### TSLA, 21 February 2026 tariff scenario

**Label:** historical counterfactual range, not exact fills.

- Event source: CNN Business, “Global tariff increased from 10% to 15%, effective immediately.”
- Event URL: https://www.cnn.com/2026/02/21/business/trump-global-tariffs-increase-supreme-court
- The classifier only received information available at the Saturday decision time.

Prices from Bitget MCP historical data and Bitget public TSLAUSDT 4H candles:

- TSLA Friday close: 411.82.
- TSLA Monday open: 407.285.
- Underlying opening gap: -1.10%.
- Held quantity: 0.04.
- Hedge quantity: 0.02.
- Unhedged gap P&L on the 0.04 holding: -0.1814.
- Hedge gross P&L range: 0.0532 to 0.2194.
- Entry candle range: 410.92 to 412.00.
- Unwind candle range: 401.03 to 408.26.

A stock Friday close is not the same thing as a weekend perpetual fill, so Tesrune does not invent an exact fill price. The counterfactual is priced across the real perp candle bands.

Before costs, the combined hedge-plus-underlying range spans -0.1282 to +0.038. This is a range, not a claimed realized return.

### COIN, 15 September 2026 rate-hike selloff

**Label:** historical counterfactual range sourced from Bitget MCP.

The catalyst is a Bitget MCP editorial daily-desk note covering rising rate-hike expectations and an AI slowdown scare. It is cited as Bitget MCP data rather than presented as an external wire story.

- Bitget MCP equity history: 14 Sep close 191.45, 15 Sep open 183.621, a -4.09% opening gap, 15 Sep close 172.11.
- Bitget public COINUSDT 4H entry candle at 2026-09-15T00:00Z: open 185.84, high 186.31, low 183.29, close 183.48.
- Bitget public COINUSDT 4H unwind candle at 2026-09-15T12:00Z: open 181.52, high 181.59, low 168.34, close 172.37.
- Decision time 2026-09-15T00:30Z is a verified dark window.
- The configured unwind resolves to 2026-09-15T13:29Z.

On one verified run, Qwen 3.8 Max classified the event **priced** at 0.72 confidence and the mandate declined it **`NOT_MATERIAL`**. No order was placed.

The exact model confidence can vary between calls. What is fixed is the boundary: Qwen interprets; deterministic mandate rules decide whether the model output is eligible to become a proposal; the user must still confirm before execution.

## 6. Feeds, holdings, and mandate proofs

### Feeds

One clean feed poll returned nine current events:

- eight Bitget MCP news items;
- one in-window SEC EDGAR 8-K;
- no source errors.

Observed market data in that run:

- TSLA close 364.18;
- previous TSLA close 366.20;
- TSLAUSDT mark 364.23;
- funding -0.000049.

A more recent TSLA EDGAR filing parsed with items 2.02 and 9.01 and a canonical SEC URL, but it was not written because its timestamp fell outside the active poll window. Seed history therefore cannot silently become a new hedge event.

Historical milestone at this stage: **30/30 tests passed**.

### Holdings book

Input:

`100 TSLA, 40 NVDA, 25 MSTR at IBKR`

Observed result:

- all three parsed and resolved as hedgeable in that run;
- marks: 364.22, 221.79, 153.17;
- notionals: 36,422; 8,871.6; 3,829.25;
- no open shorts.

The confirmed book was written only after an explicit confirmation step and stored at file mode 600.

COST was correctly reported unlisted on the demo engine while `liveListed` was true.

Historical milestone at this stage: **37/37 tests passed**.

### Deterministic mandate

The mandate engine implements seven checks in order:

1. `NOT_DARK`
2. `NOT_MATERIAL`
3. `DIRECTION_UP`
4. `UNLISTED`
5. `CAP`
6. `MIN_SIZE`
7. `DUPLICATE`

Verification fixture:

- 75 TSLA;
- notional 27,316.50;
- taker fees 16.3899 each side;
- estimated round trip 32.7798;
- one funding settlement at -1.3385085;
- 64-character valid mandate stamp.

Through the desk, a request to `hedge 150 TSLA` produced a proposal clipped to 100 with all seven checks and a Monday 09:29 ET unwind, demonstrating that the user cannot be made net short beyond the confirmed holding.

Historical milestone at this stage: **46/46 tests passed**.

### Qwen classification of a real SEC filing

Real filing **`0001193125-26-389858`**, an MSTR 8-K with items 7.01 and 8.01 and no substantive detail in the feed, was classified:

- noise;
- direction unclear;
- confidence 0.85;
- ratio 0.

A synthetic fixture was explicitly labeled, and Qwen refused to treat it as real evidence.

Qwen does not receive exchange execution authority and cannot bypass the mandate boundary.

Historical milestone at this stage: **53/53 tests passed**.

## 7. Additional capability evidence

### Post-open gap reconciliation

After the cash session opens, the desk can fetch the verified stock open and calculate the gap on the hedged shares plus the portion offset by the hedge.

The field remains null and labeled pending until a post-open quote is available. This path is unit-tested with an injected quote. No live overnight Tesrune cycle has yet been presented as a completed real-market gap reconciliation.

### Hedge scorecard

The desk aggregates logged records into:

- proposals;
- declines;
- decline rate;
- closed cycles;
- net hedge P&L;
- average event-to-proposal latency;
- reconciled gaps;
- average hedge offset.

The scorecard is derived from actual stored records rather than hardcoded display values.

### Live feed

Recent Bitget MCP news, SEC filings, and relevant perp moves are joined with their model verdicts and shown inside the desk.

### Telegram alerts

`@tesrune_desk_bot` is alert-only.

- Users can subscribe with `/start`.
- Proposal alerts link back to the desk for review.
- Unwind failures can trigger alerts.
- The notifier deduplicates proposal and unwind-failure messages.
- Telegram has no order-placement path.

### Index-proxy hedge

For an unlisted name, an optional path can size a correlation hedge using an index perpetual and beta estimated from returns.

- clearly labeled as a proxy;
- carries basis risk;
- additive to the mandate;
- disabled by default behind `TESRUNE_PROXY_HEDGE=1`;
- covered by sizing and mandate tests.

## 8. What the evidence does not claim

- Holdings are self-reported. Tesrune does not verify positions at the external broker.
- Bitget demo execution uses virtual funds. It is not a live-money account.
- Historical counterfactuals use real candle ranges where exact historical perpetual fills are unavailable. They are not presented as exact fills.
- Underlying gap P&L remains pending until a post-open quote is verified.
- Qwen classification can vary between calls. Exact labels and confidence values are observed run outputs, not hardcoded promises.
- Calm dark windows may produce no proposal. Tesrune records that outcome and places no order.
- Replay reset clears replay-derived presentation and transient replay state but preserves append-only evidence.
- Proxy hedges carry basis risk and are disabled by default.
- Tesrune is a decision-support desk with explicit human confirmation, not an unrestricted autonomous trading agent.
