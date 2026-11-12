import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  companionPostRunId,
  encodeChatStreamEvent,
  parseChatStreamEvent,
  parseCompanionTurnMetadata,
  parseTurnStartAssistantMetadata,
  type ChatStreamEvent,
} from '../src/index';

const turnStart = (data: Record<string, unknown>) => {
  const event = parseChatStreamEvent('turn_start', JSON.stringify(data));
  assert.ok(event && event.event === 'turn_start');
  return event.data;
};

describe('turn_start for a posted check-in (DESIGN-v2 §3.3, W0 review #1)', () => {
  test('carries the post metadata, so an open window renders it as a post at once', () => {
    const data = turnStart({
      turnId: 'cmp-post-cmr-1', assistantId: 'cmp-post-cmr-1', nodeId: 'n-v', userText: '', selfInitiated: true,
      assistantMetadata: { companionPost: { runId: 'cmr-1', kind: 'heartbeat', changes: [{ kind: 'page', id: 'p1', applied: 2, proposed: 0, junk: 1 }] }, usageSummary: {} },
    });
    assert.deepEqual(data.assistantMetadata, { companionPost: { runId: 'cmr-1', kind: 'heartbeat', changes: [{ kind: 'page', id: 'p1', applied: 2, proposed: 0 }] } });
    assert.equal(companionPostRunId(data.assistantId), 'cmr-1', 'the id alone also names the run');
  });

  test('drops assistant metadata that says nothing well-formed', () => {
    for (const assistantMetadata of [undefined, null, 'x', [], {}, { companionPost: { runId: 'cmr-1', kind: 'poll' } }, { usageSummary: {} }]) {
      const data = turnStart({ turnId: 't', assistantId: 'a', nodeId: 'n', userText: 'hi', assistantMetadata });
      assert.equal('assistantMetadata' in data, false, JSON.stringify(assistantMetadata));
      assert.equal(parseTurnStartAssistantMetadata(assistantMetadata), undefined);
    }
  });

  test('still passes the user message metadata, its companionTurn lines included (W0 review #4)', () => {
    const data = turnStart({ turnId: 't', assistantId: 'a', nodeId: 'n', userText: 'hi', userMetadata: { companionTurn: { startTaint: 'checkin' } } });
    assert.deepEqual(parseCompanionTurnMetadata(data.userMetadata?.companionTurn), { startTaint: 'checkin' });
  });

  test('encodes and parses back to the same frame', () => {
    const frame: ChatStreamEvent = {
      event: 'turn_start',
      data: {
        turnId: 'cmp-post-cmr-1', assistantId: 'cmp-post-cmr-1', nodeId: 'n-v', userText: '', selfInitiated: true, startedAt: 5,
        assistantMetadata: { companionPost: { runId: 'cmr-1', kind: 'brief', changes: [] } },
      },
    };
    const [eventLine, dataLine] = encodeChatStreamEvent(frame).split('\n');
    assert.deepEqual(parseChatStreamEvent(eventLine!.slice('event: '.length), dataLine!.slice('data: '.length)), frame);
  });
});
