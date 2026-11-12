import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  approvalAttentionCopy,
  ATTENTION_EVENTS,
  completionAttentionCopy,
  encodeAttentionFrame,
  failureAttentionCopy,
  isAttentionEventName,
  parseAttentionClaimResult,
  parseAttentionNotification,
  parseAttentionResolved,
  parseAttentionSnapshot,
  questionAttentionCopy,
  turnEndAttentionKind,
  type AttentionNotificationV1,
} from '../src/index';

// The server attention wire contract: frames a window accepts, and the ones it drops.

const notification: AttentionNotificationV1 = {
  id: 'attn-1', key: 'node:n1', kind: 'needs_input', reason: 'approval', title: 'Tool approval needed', body: 'ls',
  target: { type: 'node', nodeId: 'n1', workspaceId: 'ws-1' }, createdAt: 1, claimedByWindowId: null, claimedAt: null,
};

describe('attention wire contract', () => {
  test('a frame round-trips through its SSE encoding', () => {
    const frame = encodeAttentionFrame(ATTENTION_EVENTS.notification, notification);
    const [eventLine, dataLine] = frame.trimEnd().split('\n');
    assert.equal(eventLine, 'event: attention_notification');
    assert.deepEqual(parseAttentionNotification(JSON.parse(dataLine.slice('data: '.length))), notification);
    assert.ok(frame.endsWith('\n\n'));
    assert.deepEqual(Object.values(ATTENTION_EVENTS).map(isAttentionEventName), [true, true, true]);
    assert.equal(isAttentionEventName('scheduled_job_run'), false);
  });

  test('malformed records are dropped, never half-read', () => {
    const run = { ...notification, target: { type: 'agent_run', runId: 'run-1', workspaceId: 'ws-1' } };
    assert.deepEqual(parseAttentionNotification(run)?.target, run.target);
    for (const broken of [
      { ...notification, kind: 'urgent' },
      { ...notification, reason: 'because' },
      { ...notification, target: { type: 'node', workspaceId: 'ws-1' } },
      { ...notification, target: { type: 'page', pageId: 'p', workspaceId: 'ws-1' } },
      { ...notification, createdAt: 'yesterday' },
      { ...notification, claimedByWindowId: '' },
      { ...notification, id: '' },
      null, [], 'attn-1',
    ]) {
      assert.equal(parseAttentionNotification(broken), null, JSON.stringify(broken));
    }
  });

  test('a snapshot keeps its well-formed records, and another protocol is rejected', () => {
    assert.deepEqual(parseAttentionSnapshot({ protocol: 'v1', notifications: [notification, { id: 'bad' }] }),
      { protocol: 'v1', notifications: [notification] });
    assert.equal(parseAttentionSnapshot({ protocol: 'v2', notifications: [] }), null);
    assert.equal(parseAttentionSnapshot({ protocol: 'v1' }), null);
  });

  test('resolutions and claim answers', () => {
    const resolved = { id: 'attn-1', key: 'node:n1', target: notification.target, reason: 'answered', resolvedAt: 2 };
    assert.deepEqual(parseAttentionResolved(resolved), resolved);
    assert.equal(parseAttentionResolved({ ...resolved, reason: 'forgotten' }), null);
    assert.deepEqual(parseAttentionClaimResult({ claimed: false, claimedByWindowId: 'w-1', status: 'active' }),
      { claimed: false, claimedByWindowId: 'w-1', status: 'active' });
    assert.deepEqual(parseAttentionClaimResult({ claimed: false, claimedByWindowId: null, status: 'expired' }),
      { claimed: false, claimedByWindowId: null, status: 'expired' });
    assert.equal(parseAttentionClaimResult({ claimed: 'yes', claimedByWindowId: null, status: 'active' }), null);
    assert.equal(parseAttentionClaimResult({ claimed: true, claimedByWindowId: null, status: 'pending' }), null);
  });
});

describe('turn attention rule and wording, shared by the server and a window without it', () => {
  test('a cancelled turn raises nothing, one stopped by an error a failure, any other end a completion', () => {
    const cases: Array<[string | null | undefined, ReturnType<typeof turnEndAttentionKind>]> = [
      ['cancel', null], ['cancelled', null], ['error', 'failed'],
      ['end_turn', 'finished'], ['max_tokens', 'finished'], [null, 'finished'], [undefined, 'finished'],
    ];
    for (const [stopReason, kind] of cases) assert.equal(turnEndAttentionKind(stopReason), kind, String(stopReason));
  });

  test('empty text falls back to the default wording', () => {
    assert.deepEqual(approvalAttentionCopy('Run ls'), { title: 'Tool approval needed', body: 'Run ls' });
    assert.deepEqual(approvalAttentionCopy(''), { title: 'Tool approval needed', body: 'A tool is waiting for your approval' });
    assert.deepEqual(questionAttentionCopy(''), { title: 'Agent needs your input', body: 'Please answer' });
    assert.deepEqual(questionAttentionCopy(undefined), { title: 'Agent needs your input', body: 'Please answer' });
    assert.deepEqual(completionAttentionCopy('Release'), { title: 'Release', body: 'Streaming finished' });
    assert.deepEqual(completionAttentionCopy(''), { title: 'Branch complete', body: 'Streaming finished' });
    assert.deepEqual(failureAttentionCopy(null, 'quota'), { title: 'Conversation', body: 'Failed: quota' });
    assert.deepEqual(failureAttentionCopy('Release', ''), { title: 'Release', body: 'The turn failed' });
  });
});
