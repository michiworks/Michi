/**
 * A temporary chat in the real chat store: Home's thread is marked at once,
 * its first message's ensure-session asks for a temporary chat, and once the
 * chat has a session no later send asks again. A retry after a first send
 * that never got a session still asks (the node keeps its mark). A regular
 * chat never asks.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-tmp-${++i}`); })(),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChatAndObserve: vi.fn(() => () => {}),
  fetchAllWorkspacesMeta: vi.fn(async () => []),
  fetchTreeMessages: vi.fn(async () => []),
  listBackendConnections: async () => [],
  ensureSession: vi.fn((opts: { nodeId: string }) => Promise.resolve({ chatId: opts.nodeId, currentModeId: null, resumeStrategy: 'fresh' })),
  streamMessage: vi.fn(() => () => {}),
  getSavedTurn: vi.fn(async () => null),
}));
vi.mock('../services/notifications', () => ({ notify: vi.fn() }));
vi.mock('../services/api/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api/assistant')>()),
  fetchAssistant: vi.fn(() => new Promise(() => {})),
}));

import * as api from '../services/api';
import { ChatProvider, useChatActions, useChatNodesSnapshot, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const ensure = api.ensureSession as unknown as ReturnType<typeof vi.fn>;
const stream = api.streamMessage as unknown as ReturnType<typeof vi.fn>;
type Handlers = { onDone: (...args: unknown[]) => void; onError: (...args: unknown[]) => void };
const handlersOf = (call: number) => stream.mock.calls[call][2] as Handlers;
const askedTemporary = (call: number) => (ensure.mock.calls[call][0] as { temporary?: boolean }).temporary;

function useHarness() {
  return { store: useChatStore(), actions: useChatActions(), nodes: useChatNodesSnapshot() };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <PrefsProvider><ChatProvider>{children}</ChatProvider></PrefsProvider>;
}

async function mount() {
  const view = renderHook(() => useHarness(), { wrapper });
  await waitFor(() => expect(view.result.current.store.hydrated).toBe(true));
  await act(async () => { await view.result.current.store.createProject('Work', '/work'); });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  ensure.mockClear();
  stream.mockReset();
  stream.mockImplementation(() => () => {});
});

describe('a temporary chat’s sends', () => {
  it('marks Home’s thread at once and asks for a temporary chat with its first message only', async () => {
    const { result } = await mount();
    let nodeId = '';
    act(() => { nodeId = result.current.actions.createThread(undefined, { temporary: true })!; });
    expect(result.current.nodes[nodeId]?.temporary).toBe(true);

    act(() => { result.current.actions.sendMessage(nodeId, 'Compare two job offers', { temporary: true }); });
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    expect(ensure.mock.calls[0][0]).toMatchObject({ nodeId, chatId: null, temporary: true });
    act(() => { handlersOf(0).onDone('end_turn', undefined, 'turn-1', true, Date.now()); });
    await waitFor(() => expect(result.current.nodes[nodeId]?.status).not.toBe('streaming'));

    // It has a session now: a later send asks for nothing, whatever it carries.
    act(() => { result.current.actions.sendMessage(nodeId, 'And over ten years?', { temporary: true }); });
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
    expect(askedTemporary(1)).toBeUndefined();
    expect(result.current.nodes[nodeId]?.temporary).toBe(true);
  });

  it('asks again on a retry when the first send got no session', async () => {
    const { result } = await mount();
    let nodeId = '';
    act(() => { nodeId = result.current.actions.createThread(undefined, { temporary: true })!; });
    ensure.mockRejectedValueOnce(new Error('backend unreachable'));
    act(() => { result.current.actions.sendMessage(nodeId, 'Compare two job offers', { temporary: true }); });
    await waitFor(() => expect(result.current.nodes[nodeId]?.status).toBe('error'));
    expect(askedTemporary(0)).toBe(true);

    act(() => { void result.current.store.retryLastTurn(nodeId); });
    await waitFor(() => expect(ensure).toHaveBeenCalledTimes(2));
    expect(askedTemporary(1)).toBe(true);
  });

  it('never asks for a regular chat', async () => {
    const { result } = await mount();
    let nodeId = '';
    act(() => { nodeId = result.current.actions.createThread()!; });
    expect(result.current.nodes[nodeId]?.temporary).toBeUndefined();
    act(() => { result.current.actions.sendMessage(nodeId, 'Plan the trip'); });
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    expect(askedTemporary(0)).toBeUndefined();
  });
});
