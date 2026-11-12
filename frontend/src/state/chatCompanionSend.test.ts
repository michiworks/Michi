import { describe, expect, it } from 'vitest';
import { formatCompanionThreadMessage } from 'michi-shared';
import { mapMessageRow } from './chatHydration';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState } from './chatTypes';

// DESIGN-v2 §4, §8.1(b): a follow-up the agent sent into a conversation it started carries
// `companionSend` beside `threadMessage`; the worker's view reads it (W3-F3).

const stored = formatCompanionThreadMessage({ displayName: 'Michi', via: 'user', text: 'Please also update the changelog.' });
const metadata = {
  threadMessage: { fromNodeId: 'companion-node', fromTitle: 'Michi' },
  companionSend: { runId: 'cmr-send-1', via: 'user' },
};

function worker(): ChatNodeState {
  return { nodeId: 'n-worker', kind: 'chat', chatId: 'n-worker', projectId: 'ws-work', messages: [], followUps: [], status: 'idle' };
}

describe('a follow-up the agent sent', () => {
  it('keeps companionSend after a reload, and shows only the body under the agent’s header', () => {
    const message = mapMessageRow({ id: 'u-1', node_id: 'n-worker', role: 'user', content: stored, metadata: JSON.stringify(metadata) });
    expect(message.companionSend).toEqual({ runId: 'cmr-send-1', via: 'user' });
    expect(message.threadMessage).toEqual(metadata.threadMessage);
    expect(message.text).toBe('Please also update the changelog.');
  });

  it('carries it live: the worker conversation open in a window shows the follow-up as it starts', () => {
    const next = reduceNodes({ 'n-worker': worker() }, {
      type: 'observer-turn-start', nodeId: 'n-worker', turnId: 'cms-cmr-send-1', assistantId: 'self-n-worker-cms-cmr-send-1',
      userText: stored, selfInitiated: true, userMetadata: metadata as never, cursor: 'background',
    });
    expect(next['n-worker'].messages[0]).toMatchObject({
      role: 'user', text: 'Please also update the changelog.', companionSend: { runId: 'cmr-send-1', via: 'user' },
    });
  });

  it('drops a malformed companionSend, and ignores one on an assistant row', () => {
    const bad = mapMessageRow({ id: 'u-2', node_id: 'n-worker', role: 'user', content: stored, metadata: JSON.stringify({
      ...metadata, companionSend: { runId: 'cmr-send-1', via: 'someone' },
    }) });
    expect(bad.companionSend).toBeUndefined();
    expect(bad.threadMessage).toEqual(metadata.threadMessage);
    const assistant = mapMessageRow({ id: 'a-1', node_id: 'n-worker', role: 'assistant', content: 'Done.', metadata: JSON.stringify(metadata) });
    expect(assistant.companionSend).toBeUndefined();
  });

  it('shows the body even if the row carries companionSend without threadMessage', () => {
    const message = mapMessageRow({ id: 'u-3', node_id: 'n-worker', role: 'user', content: stored, metadata: JSON.stringify({ companionSend: metadata.companionSend }) });
    expect(message.companionSend).toEqual(metadata.companionSend);
    expect(message.text).toBe('Please also update the changelog.');
  });
});
