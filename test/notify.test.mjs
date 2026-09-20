import test from 'node:test';
import assert from 'node:assert/strict';
import { formatProposalAlert, runNotifier } from '../src/notify.mjs';

const proposal = {
  pendingStatus: 'pending', symbol: 'TSLAUSDT', qty: 0.02, notional: 7.28,
  verdict: { class: 'material', direction: 'down', confidence: 0.72 },
  event: { historicalReplay: false }, mandate: { stamp: 'stamp-a' }
};

test('formats a proposal alert with the desk link and no execution', () => {
  const text = formatProposalAlert(proposal, 'https://tesrune.midelabs.xyz');
  assert.match(text, /TSLAUSDT short 0.02/);
  assert.match(text, /material down 0.72/);
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
