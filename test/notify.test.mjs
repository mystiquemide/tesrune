import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcast, fetchNewSubscribers, formatProposalAlert, goodbyeMessage, helpMessage, runNotifier, statusMessage, welcomeMessage } from '../src/notify.mjs';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';

const proposal = {
  pendingStatus: 'pending', symbol: 'TSLAUSDT', qty: 0.02, notional: 7.28,
  verdict: { class: 'material', direction: 'down', confidence: 0.72 },
  event: { historicalReplay: false }, mandate: { stamp: 'stamp-a' }
};

test('formats a proposal alert with the desk link and no execution', () => {
  const text = formatProposalAlert(proposal, 'https://tesrune.midelabs.xyz');
  assert.match(text, /TSLAUSDT short 0.02/);
  assert.match(text, /material down, 0.72 confidence/);
  assert.match(text, /https:\/\/tesrune\.midelabs\.xyz\/desk/);
  assert.match(text, /without your confirm/);
});

test('alerts once per proposal and once per failure, never twice', async () => {
  const sends = [];
  const send = async (text) => { sends.push(text); return { ok: true }; };
  const cycles = [{ cycleId: 'c1', status: 'unwind_failed', symbol: 'NVDAUSDT' }];

  const first = await runNotifier({ pending: [proposal], cycles, notified: { proposals: [], failures: [] }, send, publicUrl: 'https://x' });
  assert.equal(first.sent.length, 2);
  assert.deepEqual(first.notified.proposals, ['stamp-a']);
  assert.deepEqual(first.notified.failures, ['c1']);

  const second = await runNotifier({ pending: [proposal], cycles, notified: first.notified, send, publicUrl: 'https://x' });
  assert.equal(second.sent.length, 0);
  assert.equal(sends.length, 2);
});

test('does not alert a proposal that is not pending', async () => {
  const send = async () => ({ ok: true });
  const res = await runNotifier({ pending: [{ ...proposal, pendingStatus: 'executing' }], cycles: [], notified: { proposals: [], failures: [] }, send });
  assert.equal(res.sent.length, 0);
});

test('broadcast sends to every subscriber and dedupes ids', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(JSON.parse(opts.body).chat_id); return { json: async () => ({ ok: true }) }; };
  const r = await broadcast(['1', '2', '2', '1', ''], 'hi', { fetchImpl });
  assert.equal(r.sent, 2);
  assert.deepEqual(calls.sort(), ['1', '2']);
});

test('fetchNewSubscribers extracts chat ids and advances the offset', async () => {
  const fetchImpl = async () => ({ json: async () => ({ ok: true, result: [
    { update_id: 10, message: { text: '/start', chat: { id: 555, first_name: 'Judge' } } },
    { update_id: 11, message: { text: 'hello', chat: { id: 666 } } }
  ] }) });
  const { chatIds, maxUpdateId } = await fetchNewSubscribers(0, { fetchImpl });
  assert.equal(maxUpdateId, 11);
  assert.equal(chatIds.length, 2);
  assert.equal(chatIds[0].id, 555);
  assert.equal(chatIds[0].isStart, true);
  assert.equal(chatIds[0].text, '/start');
  assert.equal(chatIds[1].isStart, false);
});

test('bot messages are honest and carry the desk link', () => {
  const url = 'https://tesrune.midelabs.xyz';
  assert.match(welcomeMessage(url), /Welcome to Tesrune\. Alerts are on/);
  assert.match(welcomeMessage(url), /Nothing opens without your confirmation/);
  assert.match(helpMessage(url), /never sizes or places orders/);
  assert.match(helpMessage(url), new RegExp(`${url}/desk`));
  assert.match(statusMessage({ window: 'dark' }, url), /Desk window: dark/);
  assert.match(goodbyeMessage(), /Alerts off/);
});
