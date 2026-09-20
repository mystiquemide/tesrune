// Telegram alerts. Alert only, with a deep link back to the desk. This never
// executes an order and never bypasses the human-confirm mandate boundary.
// Anyone who sends /start to the bot is subscribed and receives dark-hours
// alerts for the desk; subscriber state is owned by the caller (desk.mjs).

const PUBLIC_URL = () => process.env.TESRUNE_PUBLIC_URL ?? 'http://127.0.0.1:4310';
const token = () => process.env.TELEGRAM_BOT_TOKEN;

export function telegramConfigured() {
  return Boolean(token());
}

async function tg(method, body, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  return res.json();
}

let cachedUsername;
export async function getBotUsername({ fetchImpl = fetch } = {}) {
  if (cachedUsername !== undefined) return cachedUsername;
  if (!token()) { cachedUsername = null; return null; }
  try {
    const data = await tg('getMe', {}, { fetchImpl });
    cachedUsername = data?.result?.username ?? null;
  } catch {
    cachedUsername = null;
  }
  return cachedUsername;
}

async function sendMessage(chatId, text, { fetchImpl = fetch } = {}) {
  try {
    const data = await tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }, { fetchImpl });
    return { ok: Boolean(data.ok) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function broadcast(chatIds, text, { fetchImpl = fetch } = {}) {
  if (!token()) return { skipped: true, sent: 0 };
  const ids = [...new Set((chatIds ?? []).filter(Boolean))];
  if (!ids.length) return { ok: true, sent: 0 };
  let sent = 0;
  for (const id of ids) {
    const r = await sendMessage(id, text, { fetchImpl });
    if (r.ok) sent += 1;
  }
  return { ok: sent > 0, sent };
}

// Pull new bot updates from a given offset. Returns chat ids that messaged the
// bot (so /start subscribes them) and the highest update id seen.
export async function fetchNewSubscribers(offset = 0, { fetchImpl = fetch } = {}) {
  if (!token()) return { chatIds: [], maxUpdateId: offset };
  let data;
  try {
    data = await tg('getUpdates', { offset: offset + 1, timeout: 0, allowed_updates: ['message'] }, { fetchImpl });
  } catch {
    return { chatIds: [], maxUpdateId: offset };
  }
  const updates = Array.isArray(data?.result) ? data.result : [];
  let maxUpdateId = offset;
  const chatIds = [];
  for (const u of updates) {
    if (u.update_id > maxUpdateId) maxUpdateId = u.update_id;
    const chat = u.message?.chat;
    if (chat?.id) {
      const text = String(u.message?.text ?? '');
      chatIds.push({ id: chat.id, text, isStart: text.trim().toLowerCase().startsWith('/start'), name: chat.first_name || chat.title || '' });
    }
  }
  return { chatIds, maxUpdateId };
}

// One-time bot profile setup: display name, About, description, and command menu.
export async function configureBot({ fetchImpl = fetch } = {}) {
  if (!token()) return { skipped: true };
  try {
    await tg('setMyName', { name: 'Tesrune' }, { fetchImpl });
    await tg('setMyShortDescription', { short_description: 'Dark-hours hedging alerts for US stocks on Bitget stock perps. Alert-only, you confirm every hedge on the desk.' }, { fetchImpl });
    await tg('setMyDescription', { description: 'Tesrune hedges the US stocks you hold at a closed broker on Bitget stock perpetuals, and is flat by the opening bell.\n\nThis bot sends dark-hours alerts. When the desk flags a material event and a hedge is ready, you get a ping with a link to confirm. It only sends alerts and never places an order.\n\nSend /start to subscribe.' }, { fetchImpl });
    await tg('setMyCommands', { commands: [
      { command: 'start', description: 'Subscribe to dark-hours alerts' },
      { command: 'status', description: 'Current desk window' },
      { command: 'help', description: 'How Tesrune works' },
      { command: 'stop', description: 'Unsubscribe from alerts' }
    ] }, { fetchImpl });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function welcomeMessage(publicUrl = PUBLIC_URL()) {
  return [
    'You are subscribed to Tesrune dark-hours alerts.',
    '',
    'When your broker is dark and the desk flags a material event, I send the hedge proposal here with a link to confirm. Alert only. Nothing opens until you confirm on the desk, and every hedge is flat by 09:29 ET.',
    '',
    'Commands: /status, /help, /stop',
    `Desk: ${publicUrl}/desk`
  ].join('\n');
}

export function helpMessage(publicUrl = PUBLIC_URL()) {
  return [
    'How Tesrune works:',
    '1. Qwen reads the event and judges materiality and direction. It never sizes or places orders.',
    '2. Deterministic mandate code decides if a hedge is allowed and caps the size.',
    '3. You confirm the hedge on the desk. Nothing opens without you.',
    '4. Bitget demo trading places the fill with virtual funds.',
    '5. The scheduler unwinds it at 09:29 ET, before the bell.',
    '',
    'This bot sends alerts only. Commands: /status, /stop.',
    `Desk: ${publicUrl}/desk`
  ].join('\n');
}

export function statusMessage(clock, publicUrl = PUBLIC_URL()) {
  const w = String(clock?.window || 'unknown').replace('_', ' ');
  return [
    `Desk status: ${w}.`,
    'Hedges unwind at 09:29 ET. Bitget demo trading, virtual funds.',
    `Desk: ${publicUrl}/desk`
  ].join('\n');
}

export function goodbyeMessage() {
  return 'Unsubscribed. You will not get dark-hours alerts. Send /start anytime to turn them back on.';
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
export async function runNotifier({ pending = [], cycles = [], notified = { proposals: [], failures: [] }, send, publicUrl = PUBLIC_URL() }) {
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
