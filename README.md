# Tesrune

An agent that hedges your closed-broker US stock holdings on Bitget stock perpetuals during the hours your broker is dark, and is flat by 09:29 ET before the opening bell. The invariant is "flat by the bell."

## The problem

Your broker closes at 8pm ET and stays shut all weekend. The news does not keep those hours. An 8-K drops after the close, a tariff headline lands on a Saturday, a name gaps before Monday's open, and you cannot touch your position until the bell. Tesrune covers that gap. It hedges the same names on Bitget stock perpetuals while the broker is dark, then unwinds before the market reopens so you are back to your real book by 09:29 ET.

## Who it is for

Retail and desk traders who hold US single-name stocks at a closed broker and want a same-name hedge during dark hours without leaving a position open into the reopen.

## How it works

1. Book. You paste your holdings. Qwen parses them, you confirm, and the desk resolves each name to its Bitget perp, mark, and notional.
2. Event. Feeds poll Bitget MCP news, SEC EDGAR 8-K filings for the held names, and perp mark moves during dark hours.
3. Qwen materiality. Qwen 3.8 Max classifies each event as material, priced, or noise, with a direction and a confidence. It writes the reason. It does not size anything.
4. Mandate. Deterministic rules decide whether an order may exist at all: dark hours only, material only, downside only, listed only, capped at your held quantity, minimum size, one hedge per name per window. A passing proposal is stamped.
5. Human confirm. You see the proposal card and click Confirm. Nothing opens without your click.
6. Bitget demo fill. Execution refuses any order without a valid mandate stamp, then places a real fill on the Bitget demo engine with virtual funds.
7. 09:29 unwind. Every hedge carries a pre-authorized unwind at 09:29 ET. The scheduler closes the position and verifies it flat, and it re-arms after a restart.

## Why Bitget is load-bearing

- Bitget lists same-name US stock perpetuals that trade 24/7. That is the only same-name hedge instrument available while a US broker is dark, so a TSLA holding hedges with TSLAUSDT.
- The Bitget demo engine gives real fills with virtual funds, so the proof runs are genuine order placements rather than paper math.
- Bitget MCP supplies US stock news, quotes, and history that feed the classifier and the research digest.
- Bitget Agent Hub provides the agentic account path, kept behind a flag for judges with a funded account.

## The role of the LLM

Qwen 3.8 Max classifies event materiality and direction only, and writes the one-line reason. It never sizes orders, never sees account balances, and has no code path to the exchange. The deterministic mandate rules decide whether an order can exist, cap the size at your held quantity, and stamp the proposal. Execution refuses anything without a valid stamp. If Qwen is unavailable, a rules fallback runs and every card is labeled `source: rules`.

## Run instructions

Requires Node 22.

1. Copy `.env.example` to `.env` and fill:
   - `BITGET_PAPER_API_KEY`, `BITGET_PAPER_SECRET_KEY`, `BITGET_PAPER_PASSPHRASE` (Bitget demo trading API key, created inside Demo mode).
   - `BITGET_QWEN_API_KEY`.
   - `QWEN_BASE_URL=https://hackathon.bitgetops.com/v1`.
   - `QWEN_MODEL=qwen3.8-max`.
   - `TESRUNE_MANDATE_SECRET` (32 or more random characters).
2. Start the desk:
   ```
   node --env-file=.env src/desk.mjs
   ```
3. Open `http://127.0.0.1:4310` for the landing page and `http://127.0.0.1:4310/desk` for the workstation.

## A 3-minute judge path

1. Open `/desk`.
2. Click Start replay to load the historical scenario.
3. Click Confirm hedge to place the real Bitget demo fill.
4. Click Jump to 09:29 to unwind the hedge and see the position go flat.
5. Read the proof, where the demo execution and the historical counterfactual are shown separately and never merged into one number.

## Evidence

See [docs/EVIDENCE.md](docs/EVIDENCE.md) for the curated, verified runs: 70 of 70 tests passing, the four Bitget demo execution cycles with their order ids, the 21 February 2026 tariff counterfactual kept in its own section, and the feeds, book, and mandate proofs.

## Limitations

- Holdings are self-reported. You paste them. We never claim to verify positions at your broker. The cap is enforced against the pasted quantity.
- Demo execution uses virtual funds on the Bitget demo engine. It is not a live account.
- Exact historical perp fills are not available, so the historical counterfactual uses candle ranges rather than exact prices.
- Underlying gap P&L stays null and labeled "pending next cash-session open" until a post-open quote is verified.
- Calm dark windows can produce zero decisions. When nothing is material, the desk says so and places no order.
