/**
 * Thread and branch deletes must advance the structure version: memoized
 * structural selectors (TerminalShell's deleted-id key, which keeps Back off
 * deleted threads) recompute only when it moves.
 */
import React, { useCallback } from 'react';
import { vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({
  __esModule: true,
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  deleteWorkspace: () => Promise.resolve({ ok: true }),
  setChatMode: () => Promise.resolve('fake-chat'),
  respondToPermission: () => Promise.resolve({ ok: true }),
  cancelPermission: () => Promise.resolve({ ok: true }),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChat: () => Promise.resolve(),
  ensureSession: vi.fn(() =>
    Promise.resolve({ chatId: 'fake-chat', currentModeId: null, resumeStrategy: 'fresh' }),
  ),
  streamMessage: vi.fn(() => () => {}),
  syncWorkspace: () => Promise.resolve({ ok: true }),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));

import { ChatProvider, useChatStore, useStructuralSelector } from './chatStore';
import type { ChatNodeState } from './chatTypes';
import { PrefsProvider } from './prefs';

function useStoreAndStructure() {
  const store = useChatStore();
  const deletedIds = useStructuralSelector(useCallback((nodes: Record<string, ChatNodeState>) => (
    Object.keys(nodes).filter((id) => nodes[id]?.deletedAt).sort().join(',')
  ), []));
  return { store, deletedIds };
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

async function mountWithTwoThreads() {
  const hook = renderHook(() => useStoreAndStructure(), { wrapper });
  await act(async () => { await hook.result.current.store.createProject('test', undefined); });
  await waitFor(() => expect(hook.result.current.store.activeProject).toBeTruthy());
  let rootA = '';
  await act(async () => { rootA = (await hook.result.current.store.createThread()) ?? ''; });
  let childA = '';
  await act(async () => { childA = await hook.result.current.store.createBlankChild(rootA); });
  await act(async () => { await hook.result.current.store.createThread(); });
  const treeA = hook.result.current.store.activeProject!.trees.find((t) => t.rootNodeId === rootA)!;
  return { ...hook, rootA, childA, treeA };
}

describe('structural selectors after deletes', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sees a deleted thread', async () => {
    const { result, rootA, childA, treeA } = await mountWithTwoThreads();
    expect(result.current.deletedIds).toBe('');

    act(() => { result.current.store.deleteTree(treeA.id); });

    expect(result.current.deletedIds).toBe([rootA, childA].sort().join(','));
  });

  it('sees a deleted branch', async () => {
    const { result, childA } = await mountWithTwoThreads();

    act(() => { result.current.store.deleteNode(childA); });

    expect(result.current.deletedIds).toBe(childA);
  });

});
