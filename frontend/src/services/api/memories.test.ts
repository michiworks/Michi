import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from 'michi-shared';
import {
  MemoryApiError,
  createMemory,
  deleteMemory,
  fetchMemoryExtractionStatus,
  fetchMemoryProfile,
  fetchReplyMemorySources,
  hideRecalledTurn,
  isMemoryNotFound,
  isMemoryUnavailable,
  isMemoryVersionConflict,
  listMemories,
  markMemoryNoticeSeen,
  removeMemoryProfileLine,
  resetMemories,
  saveMemorySettings,
  setMemoryExtractionPaused,
  subscribeMemoryChanges,
  updateMemory,
} from './memories';

const stream = vi.hoisted(() => ({ fetchStream: vi.fn() }));
vi.mock('./streamTransport', () => ({ fetchStream: stream.fetchStream }));

const RECORD: MemoryRecord = {
  id: 'mem-1', ownerUserId: 'local', scope: { kind: 'workspace', workspaceId: 'ws-1' }, kind: 'convention', body: 'use 2 spaces',
  source: { nodeId: 'n-1' }, status: 'active', origin: 'explicit', version: 3, supersedesId: null, sourceRisk: null, createdAt: 1, updatedAt: 2,
};

const fetchMock = vi.fn();
const answer = (status: number, body?: unknown) => fetchMock.mockResolvedValueOnce(
  new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
);
const lastCall = () => {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit | undefined];
  return { url: new URL(url, 'http://localhost'), init };
};

beforeEach(() => {
  fetchMock.mockReset();
  stream.fetchStream.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('memory REST client', () => {
  it('lists with scope, workspace, statuses, search and cursor, keeping only well-formed records', async () => {
    answer(200, { items: [RECORD, { id: 'broken' }], nextCursor: 'c2' });
    const page = await listMemories({ scope: 'workspace', workspaceId: 'ws-1', status: ['active', 'pending'], q: ' spaces ', cursor: 'c1', limit: 50 });
    expect(page).toEqual({ items: [RECORD], nextCursor: 'c2' });
    const { url } = lastCall();
    expect(url.pathname).toMatch(/\/memories$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'workspace', workspaceId: 'ws-1', status: 'active,pending', q: 'spaces', cursor: 'c1', limit: '50' });
  });

  it('reads an answer of another shape, or a bare 404, as a backend without Memory', async () => {
    answer(200, { __unmocked: '/memories' });
    const shape = await listMemories().catch((error: unknown) => error);
    expect(isMemoryUnavailable(shape)).toBe(true);
    answer(404, '<html>Cannot GET</html>');
    const missing = await listMemories().catch((error: unknown) => error);
    expect(isMemoryUnavailable(missing)).toBe(true);
    // A memory that is gone is not a missing route.
    answer(404, { error: 'Memory not found', code: 'not_found' });
    const gone = await deleteMemory('mem-9').catch((error: unknown) => error);
    expect(isMemoryUnavailable(gone)).toBe(false);
    expect(isMemoryNotFound(gone)).toBe(true);
  });

  it('sends edits with the expected version and reports a conflict with the stored version', async () => {
    answer(409, { error: 'The memory changed since it was read', code: 'version_conflict', currentVersion: 4 });
    const conflict = await updateMemory('mem-1', { body: 'use tabs', expectedVersion: 3 }).catch((error: unknown) => error);
    expect(isMemoryVersionConflict(conflict)).toBe(true);
    expect((conflict as MemoryApiError).currentVersion).toBe(4);
    const { url, init } = lastCall();
    expect(url.pathname).toMatch(/\/memories\/mem-1$/);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ body: 'use tabs', expectedVersion: 3 });

    answer(200, { memory: { ...RECORD, scope: { kind: 'user' }, version: 4 } });
    expect((await updateMemory('mem-1', { scope: { kind: 'user' }, expectedVersion: 3 })).version).toBe(4);
  });

  it('creates, deletes and saves the mode', async () => {
    answer(201, { memory: RECORD });
    expect(await createMemory({ scope: { kind: 'user' }, kind: 'fact', body: 'x' })).toEqual(RECORD);
    expect(lastCall().init?.method).toBe('POST');
    answer(204);
    await expect(deleteMemory('a/b')).resolves.toBeUndefined();
    expect(lastCall().url.pathname).toMatch(/\/memories\/a%2Fb$/);
    answer(409, { error: 'Memory is turned off', code: 'memory_disabled' });
    const off = await createMemory({ scope: { kind: 'user' }, kind: 'fact', body: 'x' }).catch((error: unknown) => error);
    expect((off as MemoryApiError).code).toBe('memory_disabled');
    answer(200, { mode: 'off' });
    expect(await saveMemorySettings('off')).toEqual({ mode: 'off' });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ mode: 'off' });
  });
});

describe('what a reply was based on', () => {
  const BASE = 'http://localhost:3000/api';
  const MEMORY = { kind: 'memory', memoryId: 'mem-1', text: 'Use pnpm', savedBy: 'import', importSource: 'claude', at: 5, from: null };
  const CHAT = { kind: 'conversation', docId: 7, text: 'The launch is on March 3', at: 6, from: { nodeId: 'n-2', messageId: 'u-1', title: null } };

  it('asks the conversation’s backend for its messages at once, keeping well-formed sources only', async () => {
    answer(200, { messages: [{ messageId: 'a,1', sources: [MEMORY, CHAT, { kind: 'memory' }] }, { broken: true }] });
    expect(await fetchReplyMemorySources(BASE, 'n/1', ['a,1', 'a-2'])).toEqual({ messages: [{ messageId: 'a,1', sources: [MEMORY, CHAT] }] });
    const { url } = lastCall();
    expect(url.pathname).toBe('/api/nodes/n%2F1/memory-sources');
    expect(url.search).toBe('?messages=a%2C1,a-2');
    answer(404, '<html>Cannot GET</html>');
    expect(isMemoryUnavailable(await fetchReplyMemorySources(BASE, 'n-1', ['a-1']).catch((error: unknown) => error))).toBe(true);
  });

  it('hides a past turn, and forgets a memory, on the conversation’s backend', async () => {
    answer(200, { hidden: true });
    await hideRecalledTurn(BASE, 7);
    expect(lastCall().url.pathname).toBe('/api/memory-recall/hide');
    expect(lastCall().init?.method).toBe('POST');
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ docId: 7 });
    answer(204);
    await deleteMemory('mem 1', 'http://localhost:3000/api/backend-connections/remote-1/proxy');
    expect(lastCall().url.pathname).toBe('/api/backend-connections/remote-1/proxy/memories/mem%201');
    expect(lastCall().init?.method).toBe('DELETE');
  });
});

describe('the profile, reset and the notice', () => {
  it('keeps each profile line’s place in the backend’s list, and reads a backend without a profile as none', async () => {
    answer(200, {
      lines: [
        { topic: 'Work', text: 'no refs' },
        { topic: 'Home', text: 'Only an air fryer', refs: [{ ref: 'm:1v1', id: 'mem-1', body: 'I only have an air fryer' }, { broken: true }] },
      ],
      builtAt: 5, version: 2, rebuildRequested: true,
    });
    // Remove names a line by its place, so a skipped line must not shift the next one's.
    expect(await fetchMemoryProfile()).toEqual({
      lines: [{ index: 1, topic: 'Home', text: 'Only an air fryer', refs: [{ ref: 'm:1v1', id: 'mem-1', body: 'I only have an air fryer' }] }],
      builtAt: 5, version: 2, rebuildRequested: true,
    });
    answer(404, '<html>Cannot GET</html>');
    expect(await fetchMemoryProfile()).toBeNull();
  });

  it('removes a line at the version read, and reports a profile rebuilt since', async () => {
    answer(409, { error: 'The profile changed since it was read', code: 'version_conflict' });
    const conflict = await removeMemoryProfileLine(1, 2).catch((error: unknown) => error);
    expect(isMemoryVersionConflict(conflict)).toBe(true);
    expect(lastCall().url.pathname).toMatch(/\/memory-profile\/remove-line$/);
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ index: 1, version: 2 });
  });

  it('confirms a reset, and records the one-time notice as seen', async () => {
    answer(200, { removed: 4, hiddenTurns: 9 });
    expect(await resetMemories()).toEqual({ removed: 4 });
    expect(lastCall().url.pathname).toMatch(/\/memories\/reset$/);
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ confirm: true });
    answer(200, { mode: 'auto', migratedFromExplicit: true, noticeSeen: true });
    expect(await markMemoryNoticeSeen()).toEqual({ mode: 'auto', migratedFromExplicit: true, noticeSeen: true });
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({ noticeSeen: true });
  });
});

describe('automatic memory status', () => {
  const STATUS = { enabled: true, paused: false, lastRunAt: 5, lastError: null, todayTokens: 1200, dailyTokenLimit: 50000 };

  it('reads the status, and null from a backend without it', async () => {
    answer(200, STATUS);
    expect(await fetchMemoryExtractionStatus()).toEqual(STATUS);
    answer(404, { error: 'not found' });
    expect(await fetchMemoryExtractionStatus()).toBeNull();
    answer(200, { __unmocked: '/memory-extraction/status' });
    expect(await fetchMemoryExtractionStatus()).toBeNull();
  });

  it('pauses and resumes, reading the status again when the answer has none', async () => {
    answer(200, { ...STATUS, paused: true });
    expect((await setMemoryExtractionPaused(true))?.paused).toBe(true);
    expect(lastCall().url.pathname).toMatch(/\/memory-extraction\/pause$/);
    answer(200, { ok: true });
    answer(200, STATUS);
    expect((await setMemoryExtractionPaused(false))?.paused).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost').pathname.replace(/^.*\/memory/, '/memory')))
      .toEqual(['/memory-extraction/pause', '/memory-extraction/resume', '/memory-extraction/status']);
  });
});

describe('subscribeMemoryChanges', () => {
  const sse = (text: string) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  it('reads memory_changed frames through the stream transport and reports the end', async () => {
    const change = { ownerUserId: 'local', workspaceId: null, memoryId: 'mem-1', action: 'created', status: 'active', body: 'x', origin: 'explicit' };
    stream.fetchStream.mockResolvedValue(sse(`: connected\n\nevent: memory_changed\ndata: ${JSON.stringify(change)}\n\nevent: memory_changed\ndata: {"broken":true}\n\nevent: other\ndata: {}\n\n`));
    const onEvent = vi.fn();
    const onOpen = vi.fn();
    const ended = new Promise<Error | undefined>((resolve) => subscribeMemoryChanges({ onEvent, onOpen, onDisconnect: resolve }));
    expect(await ended).toBeUndefined();
    expect(String(stream.fetchStream.mock.calls[0][0])).toMatch(/\/memories\/changes\/stream$/);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls).toEqual([[{ ...change, supersedesId: null }]]);
  });

  it('reports the HTTP status of a refused feed', async () => {
    stream.fetchStream.mockResolvedValue(new Response('{}', { status: 404 }));
    const error = await new Promise<Error | undefined>((resolve) => subscribeMemoryChanges({ onEvent: vi.fn(), onDisconnect: resolve }));
    expect((error as { status?: number }).status).toBe(404);
  });

  it('drops a feed that hears nothing for three keepalives', async () => {
    vi.useFakeTimers();
    try {
      stream.fetchStream.mockImplementation(async (_url: string, init?: RequestInit) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
      const onDisconnect = vi.fn();
      subscribeMemoryChanges({ onEvent: vi.fn(), onDisconnect });
      await vi.advanceTimersByTimeAsync(74_999);
      expect(onDisconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
      expect(onDisconnect.mock.calls[0][0]).toMatchObject({ message: expect.stringContaining('stalled') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays silent after unsubscribe', async () => {
    let release!: (response: Response) => void;
    stream.fetchStream.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const onDisconnect = vi.fn();
    const onOpen = vi.fn();
    const stop = subscribeMemoryChanges({ onEvent: vi.fn(), onOpen, onDisconnect });
    stop();
    expect((stream.fetchStream.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    release(sse(': connected\n\n'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
