import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent, type AttentionNotificationV1 } from 'michi-shared';
import { subscribeBackground } from './api';
import { isServerAttentionActive } from './serverAttention';
import { activeServerAttentionRecords, resetServerAttentionStore } from './serverAttentionStore';

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const record: AttentionNotificationV1 = {
  id: 'attn-1', key: 'node:n1', kind: 'needs_input', reason: 'approval', title: 'Tool approval needed', body: 'ls',
  target: { type: 'node', nodeId: 'n1', workspaceId: 'ws-1' }, createdAt: 1, claimedByWindowId: null, claimedAt: null,
};

const frames = [
  `event: attention_snapshot\ndata: ${JSON.stringify({ protocol: 'v1', notifications: [] })}\n\n`,
  `event: attention_notification\ndata: ${JSON.stringify(record)}\n\n`,
  'event: attention_notification\ndata: {"id":\n\n',
  encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { chatId: 'n1', nodeId: 'n1', turnId: 't1', seq: 1, text: 'hi' } }),
];

describe('attention frames on the background feed', () => {
  beforeEach(() => resetServerAttentionStore());
  afterEach(() => vi.unstubAllGlobals());

  it('reach the attention store without disturbing the chat frames around them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(frames)));
    const onChunk = vi.fn();
    const onDisconnect = vi.fn();
    subscribeBackground(() => ({ onChunk }), { onDisconnect });
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(activeServerAttentionRecords('local')).toEqual([record]);
    expect(isServerAttentionActive('local')).toBe(true);
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it('keeps a remote connection\'s records in that connection, with renderer-scoped ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(frames));
    vi.stubGlobal('fetch', fetchMock);
    const onDisconnect = vi.fn();
    subscribeBackground(() => ({}), { onDisconnect }, 'conn-r');
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain('/backend-connections/conn-r/proxy/chats/background/subscribe');
    const [remote] = activeServerAttentionRecords('conn-r');
    expect(remote.id, 'the record id is the backend\'s, used to claim it there').toBe('attn-1');
    expect(remote.target).toEqual({ type: 'node', nodeId: 'remote:conn-r:n1', workspaceId: 'remote:conn-r:ws-1' });
    expect([isServerAttentionActive('conn-r'), isServerAttentionActive('local')]).toEqual([true, false]);
  });
});
