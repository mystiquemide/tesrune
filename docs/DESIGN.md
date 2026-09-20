# Tesrune — Design

Version 1.0, 20 September 2026. One screen. A judge must understand what the desk is doing, why, and what it refused, without scrolling.

## Voice

Dark-hours desk. Calm, exact, no exclamation marks. Every number is recomputable from the card. Words used: hedge, mandate, dark hours, bell, decline, clipped, unwind. Words never used: protect, guard, monitor, alert, dashboard, safety, circuit breaker, receipt, audit.

## Layout (1280 wide, three columns, fixed header)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TESRUNE   ● DARK 02:14 ET   next bell 09:30 ET · unwind 09:29   venue: demo  │
├──────────────┬─────────────────────────────────┬─────────────────────────────┤
│ BOOK         │ DESK                             │ CYCLES                      │
│ 100 TSLA     │ > what moved my names            │ TSLA  short 75  -0.9%       │
│  TSLAUSDT    │ ─ digest, cited, per name ─      │  filled 21:07 ET            │
│  364.18      │                                  │  unwind 09:29 ET  +1.2%     │
│  36,418 USDT │ ┌ PROPOSAL ─────────────────┐    │  gap  -1.4%  carry 0.06%    │
│  hedge 0     │ │ TSLA  8-K item 2.02       │    │                             │
│ 40 NVDA ...  │ │ material · down · 0.82    │    │ DECLINES                    │
│ 25 MSTR ...  │ │ short 75 TSLAUSDT @364.2  │    │ 14:02 NOT_DARK  broker open │
│              │ │ notional 27,314 · fee 16  │    │ 21:40 CAP  150→100 clipped  │
│ + paste book │ │ funding est 0.00 · flat   │    │ 22:15 PRICED  NVDA upgrade  │
│              │ │ by 09:29 ET               │    │                             │
│              │ │ [ Confirm hedge ] [ No ]  │    │                             │
│              │ └───────────────────────────┘    │                             │
│              │ > ask the desk _                 │                             │
└──────────────┴─────────────────────────────────┴─────────────────────────────┘
```

### Header

- Wordmark left. Window pill center: `DARK hh:mm ET` (amber), `BROKER OPEN` (grey), `PRE-BELL` (blue). Next bell and unwind time. Venue tag `demo` or `live`, never hidden.
- Replay mode adds a persistent red band under the header: `REPLAY · 2026-07-23 event · demo fills are real, clock is not`.

### Book column

- One row per holding: qty, ticker, perp symbol, mark, notional, open hedge qty. Status chip: `hedgeable`, `proxy only`, `unlisted`.
- "paste book" opens a single textarea; the parse comes back as a table with a Confirm button. Nothing enters the book without the click.

### Desk column

- Conversation stream, newest at bottom. User lines prefixed `>`.
- Digest answer: per name, headline, source tag (`MCP news`, `8-K`, `perp move`), ET time, class chip, one-line reasoning, quote delta vs last close.
- Proposal card: fixed field order, always the same. Event, class · direction · confidence, order line, notional and fee, funding estimate, `flat by 09:29 ET`, two buttons. Confirm is the only primary button on the screen.
- Decline card: rule name in mono caps, one sentence, the inputs that triggered it.
- Fill card: order id, price, size, ET time, link text "position visible in account". Unwind card: same shape plus the P&L line.

### Cycles column

- Cycle rows: name, side and qty, fill time, unwind time, hedge P&L, underlying gap, carry. Green or red only on the P&L numbers.
- Declines list beneath, most recent first, rule in mono.

## Type and color

- Type: system mono (`ui-monospace, SFMono-Regular, Menlo`) for numbers, rules, symbols, timestamps. System sans (`-apple-system, Inter, Segoe UI`) for prose. Base 14px, cards 13px, header 12px caps.
- Background `#0E1116`. Panel `#151A22`. Border `#242B36`. Text `#E6E9EF`. Muted `#8B94A3`.
- Amber (dark window, pending) `#F5B942`. Blue (pre-bell) `#5AA9FF`. Green (P&L positive, filled) `#3DD68C`. Red (P&L negative, failure) `#FF5C5C`. Replay band `#7A1F1F`.
- No gradients, no icons beyond the window dot, no charts. A sparkline is not needed; the numbers are the picture.

## States

- Empty: no book. Desk shows one line: "Paste your holdings. I only act while your broker is dark."
- Dark, no events: pill amber, desk shows last poll time and "nothing material yet".
- Proposal pending: card with Confirm; header pill pulses once.
- Hedge open: book row shows hedge qty in amber; header shows `unwind in hh:mm`.
- Unwind failed: red header band `UNWIND FAILED · retrying · close manually if still open at 09:35`. Never hidden behind a toast.
- Qwen unavailable: every card carries `source: rules` in muted mono.

## Judge path (under 3 minutes)

1. Open `http://127.0.0.1:4310`. Paste `100 TSLA, 40 NVDA, 25 MSTR`. Confirm parse.
2. Type `hedge 150 TSLA`. Decline card `CAP` shows 150 clipped to 100, or `NOT_DARK` if the broker is open. Two refusals in ten seconds.
3. Click `Replay: 8-K after close`. Red band appears. Proposal card appears. Click Confirm. Fill card shows the demo order id.
4. Click `Jump to 09:29 ET`. Unwind card and cycle row appear with P&L and gap.
5. Type `what moved my names`. Cited digest.

## Accessibility

Contrast ratios above 4.5:1 on all text. Buttons reachable by tab. Cards are plain DOM, no canvas.
