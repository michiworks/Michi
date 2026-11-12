import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, WINDOW_ID_HEADER, encodeChatStreamEvent } from 'michi-shared';
import { applyWorkspaceCommands, fetchWorkspaces, subscribeBackground } from './api';
import { ORIGIN_WINDOW_ID } from '../config/windowIdentity';

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('workspace structure frames on the background feed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('delivers valid frames without holding back chat events and drops malformed ones', async () => {
    const event = {
      epoch: 'e1', seq: 3,
      changes: [{ entity: 'tree', op: 'created', workspaceId: 'ws-1', treeId: 't-1', originWindowId: 'window-2' }],
    };
    const liveFrame = encodeChatStreamEvent({
      event: CHAT_STREAM_EVENTS.chunk,
      data: { chatId: 'chat-x', nodeId: 'node-x', turnId: 'turn-x', seq: 1, assistantId: 'a-x', text: 'after' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      `event: workspace_structure_changed\ndata: ${JSON.stringify(event)}\n\n`,
      'event: workspace_structure_changed\ndata: {"epoch":"e1","seq":4,"changes":[{"entity":"tree","op":"exploded","workspaceId":"ws-1"}]}\n\n',
      'event: workspace_structure_changed\ndata: {"epoch":"e1","seq":-1,"changes":[]}\n\n',
      'event: workspace_structure_changed\ndata: not json\n\n',
      liveFrame,
    ])));
    const onWorkspaceStructureChanged = vi.fn();
    const chunk = vi.fn();
    subscribeBackground(() => ({ onChunk: chunk }), { onWorkspaceStructureChanged });
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(1));
    expect(onWorkspaceStructureChanged).toHaveBeenCalledTimes(1);
    expect(onWorkspaceStructureChanged).toHaveBeenCalledWith(event);
  });
});

describe('window identity on requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names this window on writes, keeping plain-object headers, and not on reads', async () => {
    expect(ORIGIN_WINDOW_ID).toBeTruthy();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ workspaces: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await applyWorkspaceCommands('ws-1', 'op-1', [{ type: 'workspace.upsert', payload: { id: 'ws-1', name: 'x' } }]);
    const [, writeInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const writeHeaders = writeInit.headers as Record<string, string>;
    expect(writeHeaders[WINDOW_ID_HEADER]).toBe(ORIGIN_WINDOW_ID);
    expect(writeHeaders['Content-Type']).toBe('application/json');

    await fetchWorkspaces();
    const [, readInit] = fetchMock.mock.calls[1] as [string, RequestInit | undefined];
    expect(new Headers(readInit?.headers).has(WINDOW_ID_HEADER)).toBe(false);
  });
});
