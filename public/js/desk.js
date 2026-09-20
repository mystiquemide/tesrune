// Tesrune desk. Reads /api/state, paints three columns, and drives the
// book, research, proposal, and replay flows. The desk goes dark only when
// it wants you to act.

const WINDOWS = {
  dark: { label: 'DARK', cls: 'pill-dark' },
  pre_bell: { label: 'PRE-BELL', cls: 'pill-prebell' },
  broker_open: { label: 'BROKER OPEN', cls: 'pill-open' }
};
const CHECK_LABEL = { NOT_DARK: 'DARK', NOT_MATERIAL: 'MATERIAL', DIRECTION_UP: 'DOWNSIDE', UNLISTED: 'LISTED', CAP: 'CAP', MIN_SIZE: 'SIZE', DUPLICATE: 'DUPLICATE' };

let bookFormOpen = false;
let pendingParse = null;
let threadSeeded = false;
let busy = false;

function pad(n) { return String(n).padStart(2, '0'); }
function fmtRemaining(ms) {
  if (ms < 0) ms = 0;
  const t = Math.floor(ms / 1000);
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function etHM(et) { const m = /\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/.exec(et || ''); return m ? m[1] : ''; }
function num(v) { return v === null || v === undefined || v === '' ? null : Number(v); }
function money(v) { const n = num(v); return n === null || Number.isNaN(n) ? null : n.toLocaleString('en-US', { maximumFractionDigits: 2 }); }

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function line(cls, k, v, vClass) {
  const row = el('div', cls);
  row.append(el('span', 'k', k));
  row.append(el('span', `v${vClass ? ' ' + vClass : ''}`, v));
  return row;
}

async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* Thread */
function thread() { return document.getElementById('desk-thread'); }
function pushMsg(node) { thread().append(node); thread().scrollTop = thread().scrollHeight; }
function userMsg(text) { pushMsg(el('div', 'msg msg-user', text)); }
function deskMsg(text) { pushMsg(el('div', 'msg msg-desk', text)); }
function deskNote(text) { pushMsg(el('div', 'msg msg-note', text)); }

/* Header + theme */
let targetBell = null, drift = 0;
function renderHeader(state) {
  const clock = state.clock || {};
  const conf = WINDOWS[clock.window] || WINDOWS.dark;
  const pill = document.getElementById('window-pill');
  pill.className = `pill ${conf.cls}`;
  const hm = etHM(clock.et);
  document.getElementById('window-label').textContent = clock.window === 'dark' && hm ? `DARK ${hm} ET` : conf.label;
  if (state.venue) document.getElementById('venue').textContent = state.venue;
  targetBell = new Date(clock.nextBell).getTime();
  drift = new Date(clock.now).getTime() - Date.now();

  const banner = document.getElementById('replay-banner');
  const session = state.replaySession;
  if (session && session.prepared) {
    const name = (session.scenarioName || 'scenario').replace(/\.json$/, '');
    banner.textContent = `REPLAY · ${name} · historical event, current demo fills are real`;
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}
function tickBell() {
  if (targetBell === null) return;
  const node = document.getElementById('next-bell');
  if (node) node.textContent = fmtRemaining(targetBell - (Date.now() + drift));
}
function applyArmedTheme(state) {
  const previewDark = new URLSearchParams(location.search).get('theme') === 'dark';
  const pendingAction = Array.isArray(state.pending) && state.pending.some((p) => p.pendingStatus === 'pending');
  const failedUnwind = Array.isArray(state.cycles) && state.cycles.some((c) => c.status === 'unwind_failed');
  document.body.classList.toggle('desk-armed', previewDark || pendingAction || failedUnwind);
}

/* Book column */
function renderBook(state) {
  if (bookFormOpen) return;
  const col = document.getElementById('book-col');
  col.replaceChildren();
  const holdings = state.book && Array.isArray(state.book.holdings) ? state.book.holdings : [];
  document.getElementById('book-toggle').textContent = holdings.length ? 'Edit book' : 'Add holdings';
  if (!holdings.length) {
    const e = el('p', 'empty');
    e.append(el('strong', null, 'No holdings yet. '));
    e.append(document.createTextNode('Add the positions you hold at a closed broker. Tesrune maps each to its Bitget stock perp.'));
    col.append(e);
    return;
  }
  for (const h of holdings) {
    const row = el('div', 'book-row');
    const top = el('div', 'book-row-top');
    top.append(el('span', 'book-ticker', h.ticker));
    top.append(el('span', 'book-qty', String(h.qty)));
    row.append(top);
    const meta = el('div', 'book-meta');
    meta.append(el('span', 'book-sym', h.symbol || `${h.ticker}USDT`));
    meta.append(el('span', h.status === 'hedgeable' ? 'chip chip-hedgeable' : 'chip chip-unlisted', h.status || 'unknown'));
    row.append(meta);
    if (h.mark !== null && h.mark !== undefined) row.append(line('book-line', 'Mark', String(h.mark)));
    const notional = money(h.notional);
    if (notional) row.append(line('book-line', 'Notional', `${notional} USDT`));
    row.append(line('book-line', 'Open hedge', String(h.openShortQty ?? 0)));
    col.append(row);
  }
}

function openBookForm(prefill) {
  bookFormOpen = true;
  pendingParse = null;
  const col = document.getElementById('book-col');
  col.replaceChildren();
  const form = el('div', 'book-form');
  const ta = el('textarea', 'composer-input');
  ta.rows = 3;
  ta.placeholder = '100 TSLA, 40 NVDA and 25 MSTR at IBKR';
  ta.style.width = '100%';
  ta.style.resize = 'vertical';
  if (prefill) ta.value = prefill;
  form.append(ta);
  const actions = el('div', 'card-actions');
  const parseBtn = el('button', 'btn btn-primary btn-sm', 'Parse');
  const cancel = el('button', 'btn btn-secondary btn-sm', 'Cancel');
  actions.append(parseBtn, cancel);
  form.append(actions);
  form.append(el('p', 'msg-note', 'Self-reported. Tesrune cannot verify your external broker.'));
  col.append(form);

  cancel.addEventListener('click', () => { bookFormOpen = false; refresh(); });
  parseBtn.addEventListener('click', async () => {
    if (!ta.value.trim()) return;
    parseBtn.disabled = true; parseBtn.textContent = 'Reading with Qwen...';
    try {
      pendingParse = await postJSON('/api/book', { text: ta.value.trim() });
      renderParsePreview();
    } catch (err) {
      parseBtn.disabled = false; parseBtn.textContent = 'Parse';
      form.append(el('p', 'msg-note', err.message));
    }
  });
}

function renderParsePreview() {
  const col = document.getElementById('book-col');
  col.replaceChildren();
  const wrap = el('div', 'book-form');
  wrap.append(el('p', 'msg-note', `Parsed by ${pendingParse.source === 'qwen' ? 'Qwen 3.8 Max' : 'deterministic rules'}. Confirm to store.`));
  for (const h of pendingParse.holdings || []) {
    const row = el('div', 'book-row');
    const top = el('div', 'book-row-top');
    top.append(el('span', 'book-ticker', h.ticker));
    top.append(el('span', 'book-qty', String(h.qty)));
    row.append(top);
    if (h.broker) row.append(el('span', 'book-sym', h.broker));
    wrap.append(row);
  }
  const actions = el('div', 'card-actions');
  const confirm = el('button', 'btn btn-primary btn-sm', 'Confirm book');
  const cancel = el('button', 'btn btn-secondary btn-sm', 'Cancel');
  actions.append(confirm, cancel);
  wrap.append(actions);
  col.append(wrap);
  cancel.addEventListener('click', () => { bookFormOpen = false; pendingParse = null; refresh(); });
  confirm.addEventListener('click', async () => {
    confirm.disabled = true; confirm.textContent = 'Resolving marks...';
    try {
      await postJSON('/api/book/confirm', {});
      bookFormOpen = false; pendingParse = null;
      deskNote('Book confirmed. Ask what moved your names, request a hedge, or start a replay.');
      refresh();
    } catch (err) {
      confirm.disabled = false; confirm.textContent = 'Confirm book';
      wrap.append(el('p', 'msg-note', err.message));
    }
  });
}

/* Pending proposals */
function proposalCard(p) {
  const card = el('div', 'card armed');
  const head = el('div', 'card-head');
  head.append(el('span', 'card-title', `${p.symbol} · SHORT`));
  const tag = p.event?.historicalReplay ? 'Replay' : p.event?.syntheticFixture ? 'Synthetic' : 'Live';
  head.append(el('span', 'chip chip-unlisted', tag));
  card.append(head);
  if (p.clippedFrom !== undefined && p.clippedFrom !== null) {
    card.append(el('div', 'card-reason', `Request clipped from ${p.clippedFrom} to ${p.qty}. The mandate cannot make you net short.`));
  }
  card.append(line('card-line', 'Quantity', String(p.qty)));
  if (p.mark != null) card.append(line('card-line', 'Mark', String(p.mark)));
  const notional = money(p.notional);
  if (notional) card.append(line('card-line', 'Notional', `${notional} USDT`));
  if (p.estimatedFees != null) card.append(line('card-line', 'Round-trip fees', String(p.estimatedFees)));
  if (p.estimatedFunding != null) card.append(line('card-line', 'Funding estimate', String(p.estimatedFunding)));
  card.append(line('card-line', 'Unwind', '09:29 ET'));
  if (p.verdict) {
    card.append(line('card-line', 'Verdict', `${p.verdict.class} · ${p.verdict.direction} · ${p.verdict.confidence}`));
    if (p.verdict.reasoning) card.append(el('div', 'card-reason', p.verdict.reasoning));
  }
  const checks = el('div', 'checks');
  for (const c of p.mandate?.checks || []) {
    const clipped = c.result === 'clipped';
    const label = clipped ? `CAP ${c.clippedFrom} to ${c.qty}` : CHECK_LABEL[c.rule] || c.rule;
    checks.append(el('span', `check${clipped ? ' clipped' : ''}`, label));
  }
  card.append(checks);
  const actions = el('div', 'card-actions');
  const confirm = el('button', 'btn btn-primary btn-sm', 'Confirm hedge');
  const dismiss = el('button', 'btn btn-secondary btn-sm', 'Dismiss');
  actions.append(confirm, dismiss);
  card.append(actions);

  confirm.addEventListener('click', async () => {
    confirm.disabled = true; dismiss.disabled = true; confirm.textContent = 'Placing on Bitget...';
    try {
      const cycle = await postJSON('/api/proposal/confirm', { stamp: p.mandate.stamp });
      deskMsg(`Filled ${p.symbol} short ${p.qty}. Open order ${cycle.fill?.orderId ?? 'recorded'}. Flat by 09:29 ET.`);
      refresh();
    } catch (err) { confirm.disabled = false; dismiss.disabled = false; confirm.textContent = 'Confirm hedge'; deskNote(err.message); }
  });
  dismiss.addEventListener('click', async () => {
    confirm.disabled = true; dismiss.disabled = true;
    try { await postJSON('/api/proposal/reject', { stamp: p.mandate.stamp }); deskNote(`Dismissed the ${p.symbol} proposal.`); refresh(); }
    catch (err) { confirm.disabled = false; dismiss.disabled = false; deskNote(err.message); }
  });
  return card;
}

function renderPending(state) {
  const slot = document.getElementById('pending-slot');
  slot.replaceChildren();
  const pending = Array.isArray(state.pending) ? state.pending : [];
  for (const p of pending) {
    if (p.pendingStatus === 'pending' && p.type === 'proposal') slot.append(proposalCard(p));
  }
}

/* Ask */
function renderDigest(rows) {
  if (!rows || !rows.length) { deskMsg('No holdings to research yet.'); return; }
  let any = false;
  for (const r of rows) {
    if (!r.events || !r.events.length) continue;
    any = true;
    pushMsg(el('div', 'digest-name', r.ticker));
    for (const ev of r.events) {
      const item = el('div', 'digest-item');
      item.append(el('div', 'h', ev.title || ev.id));
      const meta = [ev.source, etHM(ev.ts)].filter(Boolean).join(' · ');
      item.append(el('div', 'm', meta));
      if (ev.verdict) item.append(el('div', 'm', `${ev.verdict.class} · ${ev.verdict.direction} · ${ev.verdict.confidence}`));
      pushMsg(item);
    }
  }
  if (!any) deskMsg('No new events touched your holdings during this dark window.');
}

async function handleAsk(text) {
  userMsg(text);
  try {
    const res = await postJSON('/api/ask', { text });
    if (res.intent === 'research') { renderDigest(res.answer); }
    else if (res.intent === 'hedge') {
      const d = res.answer?.decision;
      if (d?.type === 'decline') deskMsg(`Declined: ${d.rule}. ${d.reason || ''}`);
      else deskNote('Proposal ready below.');
    }
    else if (res.intent === 'declines') {
      if (!res.answer?.length) deskMsg('No declines recorded.');
      else res.answer.slice(-6).forEach((d) => deskMsg(`${d.decision?.rule || 'DECLINED'} · ${d.ticker || ''} ${d.decision?.reason || ''}`));
    }
    else if (res.intent === 'status') deskMsg(`Window ${res.answer?.clock?.window || 'unknown'}. Venue ${res.answer?.venue || ''}.`);
    else deskMsg(typeof res.answer === 'string' ? res.answer : 'Ask what moved my names, hedge 150 TSLA, why did you decline, or status.');
  } catch (err) { deskNote(err.message); }
  refresh();
}

/* Replay */
async function loadScenarios() {
  try {
    const res = await fetch('/api/scenarios', { headers: { Accept: 'application/json' } });
    const data = await res.json();
    const select = document.getElementById('replay-select');
    select.replaceChildren();
    for (const name of data.scenarios || []) {
      const opt = el('option', null, name.replace(/\.json$/, '').replace(/-/g, ' '));
      opt.value = name;
      select.append(opt);
    }
    if (!data.scenarios || !data.scenarios.length) {
      const opt = el('option', null, 'No scenarios');
      opt.value = '';
      select.append(opt);
    }
  } catch { /* leave select empty */ }
}

/* Seed welcome once */
function seedWelcome(state) {
  if (threadSeeded) return;
  threadSeeded = true;
  const hasBook = state.book && Array.isArray(state.book.holdings) && state.book.holdings.length;
  deskMsg(hasBook
    ? 'Your book is loaded. Ask what moved your names, request a hedge, or start the historical replay.'
    : 'Your broker is dark. Add a holdings book, or start the historical replay to see a full cycle. The desk is flat by 09:29 ET.');
}

/* Refresh loop */
async function refresh() {
  let state;
  try {
    const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
    state = await res.json();
  } catch { return; }
  renderHeader(state);
  renderBook(state);
  renderCycles(state);
  renderPending(state);
  applyArmedTheme(state);
  seedWelcome(state);
}

/* Cycles + declines */
function record(children) { const r = el('div', 'record'); for (const c of children) r.append(c); return r; }
function recLine(k, v, vClass) { return line('record-line', k, v, vClass); }
function renderCycles(state) {
  const col = document.getElementById('cycles-col');
  col.replaceChildren();
  const cycles = Array.isArray(state.cycles) ? [...state.cycles].reverse() : [];
  if (!cycles.length) {
    col.append(el('p', 'empty', 'No hedge cycles yet. A confirmed hedge shows its fill, unwind, and final state here.'));
  } else {
    for (const c of cycles) {
      const children = [];
      const sym = c.proposal?.symbol || c.symbol || c.cycleId;
      const qty = c.proposal?.qty;
      children.push(recLine(qty ? `${sym} short ${qty}` : sym, (c.status || '').toUpperCase().replace('_', ' ')));
      if (c.mode) children.push(el('div', 'record-note', `Mode: ${c.mode}`));
      if (c.fill?.orderId) children.push(recLine('Open order', String(c.fill.orderId)));
      if (c.closingFill?.orderId) children.push(recLine('Close order', String(c.closingFill.orderId)));
      const net = c.pnl ? money(c.pnl.netHedgePnl) : null;
      if (net !== null && net !== undefined) children.push(recLine('Net hedge P&L', net, num(c.pnl.netHedgePnl) < 0 ? 'down' : 'up'));
      if (c.status === 'unwind_failed') children.push(el('div', 'record-note', c.error || 'Unwind failed, close manually in Bitget demo.'));
      col.append(record(children));
    }
  }
  const declines = Array.isArray(state.declines) ? [...state.declines].reverse() : [];
  const sep = el('div', 'section-sep');
  sep.append(el('span', 'meta', 'Declines'));
  col.append(sep);
  if (!declines.length) { col.append(el('p', 'empty', 'No declined actions.')); return; }
  for (const d of declines.slice(0, 15)) {
    const children = [recLine(d.decision?.rule || 'DECLINED', d.ticker || '')];
    if (d.decision?.reason) children.push(el('div', 'record-note', d.decision.reason));
    col.append(record(children));
  }
}

/* Wire controls */
document.getElementById('book-toggle').addEventListener('click', () => {
  if (bookFormOpen) { bookFormOpen = false; refresh(); return; }
  openBookForm();
});
document.getElementById('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('ask-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  handleAsk(text);
});
document.querySelectorAll('[data-ask]').forEach((btn) => btn.addEventListener('click', () => handleAsk(btn.getAttribute('data-ask'))));
document.getElementById('replay-start').addEventListener('click', async (e) => {
  if (busy) return;
  const scenario = document.getElementById('replay-select').value;
  if (!scenario) { deskNote('No replay scenario available.'); return; }
  busy = true; e.target.disabled = true;
  deskNote('Preparing replay. Reading the event with Qwen, this can take up to 90 seconds.');
  try { await postJSON('/api/replay/start', { scenario }); deskMsg('Replay prepared. Confirm the proposal below to place the current demo hedge.'); refresh(); }
  catch (err) { deskNote(err.message); }
  finally { busy = false; e.target.disabled = false; }
});
document.getElementById('replay-jump').addEventListener('click', async (e) => {
  if (busy) return;
  busy = true; e.target.disabled = true;
  deskNote('Jumping the replay clock to 09:29 ET and unwinding.');
  try {
    const artifact = await postJSON('/api/replay/jump', {});
    const cur = artifact.current || artifact;
    deskMsg('Replay complete. Historical counterfactual and current demo fills are recorded separately, see Cycles.');
    if (artifact.historical?.label) deskNote(artifact.historical.label);
  } catch (err) { deskNote(err.message); }
  finally { busy = false; e.target.disabled = false; }
  refresh();
});

loadScenarios();
refresh();
setInterval(refresh, 5000);
setInterval(tickBell, 1000);
