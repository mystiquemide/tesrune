// Telegram alerts. Alert only, with a deep link back to the desk. This never
// executes an order and never bypasses the human-confirm mandate boundary.

const PUBLIC_URL = () => process.env.TESRUNE_PUBLIC_URL ?? 'http://127.0.0.1:4310';

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendTelegram(text, { fetchImpl = fetch } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { skipped: true };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000)
    });
    const data = await res.json();
    return { ok: Boolean(data.ok) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function formatProposalAlert(p, publicUrl = PUBLIC_URL()) {
  const v = p.verdict ? `${p.verdict.class} ${p.verdict.direction} ${p.verdict.confidence}` : 'human requested';
  const mode = p.event?.historicalReplay ? ' [replay]' : p.event?.syntheticFixture ? ' [synthetic]' : '';
  return [
    `Tesrune: dark-hours hedge ready${mode}.`,
    `${p.symbol} short ${p.qty}`,
    `${v}`,
    p.notional ? `notional ${p.notional} USDT` : null,
    'Unwind 09:29 ET. Nothing opens without your confirm.',
    `Confirm: ${publicUrl}/desk`
  ].filter(Boolean).join('\n');
}

export function formatFailureAlert(cycle, publicUrl = PUBLIC_URL()) {
  return [
    `Tesrune: UNWIND FAILED for ${cycle.symbol ?? cycle.proposal?.symbol ?? 'a hedge'}.`,
    'Close it manually in Bitget demo trading.',
    `${publicUrl}/desk`
  ].join('\n');
}

// Pure watcher: decides what to alert given current state and what was already
// sent. Sending is injected so it can be tested without the network.
export async function runNotifier({ pending = [], cycles = [], notified = { proposals: [], failures: [] }, send = sendTelegram, publicUrl = PUBLIC_URL() }) {
  const proposals = new Set(notified.proposals ?? []);
  const failures = new Set(notified.failures ?? []);
  const sent = [];
  for (const p of pending) {
    const stamp = p.mandate?.stamp;
    if (p.pendingStatus === 'pending' && stamp && !proposals.has(stamp)) {
      const result = await send(formatProposalAlert(p, publicUrl));
      if (result?.ok || result?.skipped) proposals.add(stamp);
      sent.push({ type: 'proposal', symbol: p.symbol });
    }
  }
  for (const c of cycles) {
    if (c.status === 'unwind_failed' && c.cycleId && !failures.has(c.cycleId)) {
      const result = await send(formatFailureAlert(c, publicUrl));
      if (result?.ok || result?.skipped) failures.add(c.cycleId);
      sent.push({ type: 'failure', cycleId: c.cycleId });
    }
  }
  return { sent, notified: { proposals: [...proposals], failures: [...failures] } };
}
