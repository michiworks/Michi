import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryChangedEvent, ReplyMemorySource } from 'michi-shared';
import { API_BASE_URL } from '../../config/env';

const api = vi.hoisted(() => ({ fetchReplyMemorySources: vi.fn() }));
const feeds = vi.hoisted(() => ({
  changed: [] as Array<(event: MemoryChangedEvent) => void>,
  mode: [] as Array<(apiBase: string, nodeId: string, mode: string) => void>,
  on: [] as Array<(apiBase: string, on: boolean) => void>,
}));
vi.mock('../../services/api/memories', async (original) => ({
  ...(await original<typeof import('../../services/api/memories')>()),
  fetchReplyMemorySources: api.fetchReplyMemorySources,
}));
vi.mock('./memoryNotifications', () => ({
  onMemoryChanged: (listener: (event: MemoryChangedEvent) => void) => { feeds.changed.push(listener); return () => {}; },
}));
vi.mock('./conversationMemory', () => ({
  onConversationMemoryModeChange: (listener: (apiBase: string, nodeId: string, mode: string) => void) => { feeds.mode.push(listener); return () => {}; },
  onMemoryOnChange: (listener: (apiBase: string, on: boolean) => void) => { feeds.on.push(listener); return () => {}; },
}));

import { MemoryApiError } from '../../services/api/memories';
import { readReplySources, refreshReplySources, removeReplySource, requestReplySources, resetReplySources, subscribeReplySources } from './replySources';

const LOCAL = { apiBase: API_BASE_URL, nodeId: 'n-1' };
const REMOTE = { apiBase: `${API_BASE_URL}/backend-connections/r-1/proxy`, nodeId: 'n-9' };
const memory = (id: string): ReplyMemorySource => ({ kind: 'memory', memoryId: id, text: id, savedBy: 'michi', at: 1, from: null });
const chat = (docId: number): ReplyMemorySource => ({ kind: 'conversation', docId, text: 'x', at: 1, from: { nodeId: 'n-2', messageId: null, title: null } });

function answerWith(byMessage: Record<string, ReplyMemorySource[]>) {
  api.fetchReplyMemorySources.mockImplementation(async (_apiBase: string, _nodeId: string, ids: string[]) => ({
    messages: ids.filter((id) => byMessage[id]).map((id) => ({ messageId: id, sources: byMessage[id] })),
  }));
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
}

function event(memoryId: string, action: MemoryChangedEvent['action']): MemoryChangedEvent {
  return { ownerUserId: 'local', workspaceId: null, memoryId, action, status: 'active', body: '', origin: 'extracted', supersedesId: null };
}

beforeEach(() => {
  vi.useFakeTimers();
  api.fetchReplyMemorySources.mockReset();
  feeds.changed.length = 0;
  feeds.mode.length = 0;
  feeds.on.length = 0;
  resetReplySources();
});
afterEach(() => vi.useRealTimers());

describe('reply sources store', () => {
  it('asks once for the replies of a conversation that ask together, and caches every answer, an empty one too', async () => {
    answerWith({ 'a-1': [memory('mem-1')], 'a-2': [chat(7)] });
    for (const id of ['a-1', 'a-2', 'a-3', 'a-1']) requestReplySources(LOCAL, id);
    await settle();
    expect(api.fetchReplyMemorySources).toHaveBeenCalledTimes(1);
    expect(api.fetchReplyMemorySources.mock.calls[0]!.slice(0, 3)).toEqual([API_BASE_URL, 'n-1', ['a-1', 'a-2', 'a-3']]);
    expect(readReplySources(LOCAL, 'a-1')).toEqual([memory('mem-1')]);
    expect(readReplySources(LOCAL, 'a-3')).toEqual([]);
    for (const id of ['a-1', 'a-3']) requestReplySources(LOCAL, id);
    await settle();
    expect(api.fetchReplyMemorySources).toHaveBeenCalledTimes(1);
  });

  it('a hundred ids go at once; a backend without the route is not asked again; a conversation it lacks answers nothing', async () => {
    answerWith({});
    for (let i = 0; i < 100; i += 1) requestReplySources(LOCAL, `m-${i}`);
    await Promise.resolve();
    expect(api.fetchReplyMemorySources).toHaveBeenCalledTimes(1);
    api.fetchReplyMemorySources.mockRejectedValueOnce(new MemoryApiError(404, 'Not found'));
    requestReplySources(REMOTE, 'a-1');
    await settle();
    requestReplySources(REMOTE, 'a-2');
    await settle();
    expect(api.fetchReplyMemorySources).toHaveBeenCalledTimes(2);
    api.fetchReplyMemorySources.mockRejectedValueOnce(new MemoryApiError(404, 'Conversation not found', { code: 'not_found' }));
    requestReplySources({ ...LOCAL, nodeId: 'n-new' }, 'a-1');
    await settle();
    expect(readReplySources({ ...LOCAL, nodeId: 'n-new' }, 'a-1')).toEqual([]);
  });

  it('this machine\'s change feed: a deleted memory leaves every answer, its past chats stay; an updated or put-away one asks again; a created one changes nothing', async () => {
    answerWith({ 'a-1': [memory('mem-1'), chat(7)], 'a-2': [memory('mem-1')], 'a-3': [memory('mem-2')], 'a-4': [memory('mem-3')] });
    for (const id of ['a-1', 'a-2', 'a-3', 'a-4']) requestReplySources(LOCAL, id);
    requestReplySources(REMOTE, 'a-1');
    await settle();
    const told = vi.fn();
    subscribeReplySources(LOCAL, 'a-2', told);
    for (const listener of feeds.changed) listener(event('mem-1', 'deleted'));
    // Deleting a memory leaves chat history as it is: an answer's past chats stay without asking again.
    expect(readReplySources(LOCAL, 'a-1')).toEqual([chat(7)]);
    expect(readReplySources(LOCAL, 'a-2')).toEqual([]);
    expect(told).toHaveBeenCalled();
    // Another backend's memories are not this machine's: its answer stays as it was.
    expect(readReplySources(REMOTE, 'a-1')).toEqual([memory('mem-1'), chat(7)]);
    // An answer asked again never brings the deleted memory back.
    requestReplySources(LOCAL, 'a-1');
    await settle();
    expect(readReplySources(LOCAL, 'a-1')).toEqual([chat(7)]);
    for (const listener of feeds.changed) listener(event('mem-2', 'superseded'));
    expect(readReplySources(LOCAL, 'a-3')).toBeUndefined();
    for (const listener of feeds.changed) listener(event('mem-9', 'created'));
    expect(readReplySources(LOCAL, 'a-4')).toEqual([memory('mem-3')]);
  });

  it('a past chat no longer recalled leaves every answer of that backend; a source chat that stops learning asks again; opening asks again', async () => {
    const fromN2 = chat(7);
    const fromN3: ReplyMemorySource = { kind: 'conversation', docId: 8, text: 'y', at: 1, from: { nodeId: 'n-3', messageId: null, title: null } };
    answerWith({ 'a-1': [fromN2], 'a-2': [fromN2, memory('mem-1')], 'b-1': [fromN3] });
    requestReplySources(LOCAL, 'a-1');
    requestReplySources({ ...LOCAL, nodeId: 'n-5' }, 'a-2');
    requestReplySources({ ...LOCAL, nodeId: 'n-6' }, 'b-1');
    await settle();
    removeReplySource(LOCAL, 'a-1', fromN2);
    expect(readReplySources(LOCAL, 'a-1')).toEqual([]);
    // The other conversation's reply too.
    expect(readReplySources({ ...LOCAL, nodeId: 'n-5' }, 'a-2')).toEqual([memory('mem-1')]);
    // n-3 is set to Use only in its own pane: the replies elsewhere that named it ask again.
    for (const listener of feeds.mode) listener(API_BASE_URL, 'n-3', 'use_only');
    expect(readReplySources({ ...LOCAL, nodeId: 'n-6' }, 'b-1')).toBeUndefined();
    // An opened footer asks again even with an answer cached, and a same answer keeps its object.
    answerWith({ 'a-2': [memory('mem-1')] });
    const before = readReplySources({ ...LOCAL, nodeId: 'n-5' }, 'a-2');
    refreshReplySources({ ...LOCAL, nodeId: 'n-5' }, 'a-2');
    await settle();
    expect(api.fetchReplyMemorySources).toHaveBeenCalledTimes(4);
    expect(readReplySources({ ...LOCAL, nodeId: 'n-5' }, 'a-2')).toBe(before);
  });

  it('a chat\'s memory setting, and memory turned on or off, drop what was cached; the footer\'s own removal is at once', async () => {
    answerWith({ 'a-1': [memory('mem-1'), chat(7)], 'a-2': [memory('mem-1')] });
    requestReplySources(LOCAL, 'a-1');
    requestReplySources(LOCAL, 'a-2');
    await settle();
    removeReplySource(LOCAL, 'a-1', chat(7));
    expect(readReplySources(LOCAL, 'a-1')).toEqual([memory('mem-1')]);
    removeReplySource(LOCAL, 'a-1', memory('mem-1'));
    // A forgotten memory leaves the conversation's other replies too.
    expect(readReplySources(LOCAL, 'a-2')).toEqual([]);
    for (const listener of feeds.mode) listener(API_BASE_URL, 'n-1', 'off');
    expect(readReplySources(LOCAL, 'a-1')).toBeUndefined();
    requestReplySources(LOCAL, 'a-1');
    await settle();
    for (const listener of feeds.on) listener(API_BASE_URL, false);
    expect(readReplySources(LOCAL, 'a-1')).toBeUndefined();
  });

  it('an unreachable backend answers nothing for those replies: a mounted line does not ask again in a loop', async () => {
    api.fetchReplyMemorySources.mockRejectedValue(new TypeError('Failed to fetch'));
    const told = vi.fn(() => requestReplySources(LOCAL, 'a-1'));
    subscribeReplySources(LOCAL, 'a-1', told);
    requestReplySources(LOCAL, 'a-1');
    await settle();
    await settle();
    expect(api.fetchReplyMemorySources).toHaveBeenCalledTimes(1);
    expect(readReplySources(LOCAL, 'a-1')).toEqual([]);
    expect(told).toHaveBeenCalledTimes(1);
  });

  it('keeps 30 conversations', async () => {
    answerWith({ 'a-1': [memory('mem-1')] });
    for (let i = 0; i < 31; i += 1) requestReplySources({ ...LOCAL, nodeId: `n-${i}` }, 'a-1');
    await settle();
    expect(readReplySources({ ...LOCAL, nodeId: 'n-0' }, 'a-1')).toBeUndefined();
    expect(readReplySources({ ...LOCAL, nodeId: 'n-30' }, 'a-1')).toEqual([memory('mem-1')]);
  });
});
