import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ChatProvider, useChatNodesSnapshot, useChatPanes, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';
import type { ChatNodeState, Project } from './chatTypes';
import { useCloseOtherPanes } from './closeOtherPanes';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
  fetchAllWorkspacesMeta: vi.fn().mockResolvedValue([]),
  fetchTreeMessages: vi.fn().mockResolvedValue([]),
  fetchWorkspaces: vi.fn().mockResolvedValue([]),
  fetchWorkspace: vi.fn().mockResolvedValue(null),
  warmCwd: vi.fn().mockResolvedValue(undefined),
}));

const BROWSER = 'pane:browser:web';
const chat = (nodeId: string): ChatNodeState => ({
  nodeId, chatId: null, projectId: 'p1', kind: 'chat', title: nodeId.toUpperCase(), messages: [], followUps: [], status: 'idle',
});
const project: Project = {
  id: 'p1', name: 'WS', cwd: '~/x', chatIds: ['a', 'b', 'c'],
  edges: [{ source: 'a', target: 'b', kind: 'branch' }, { source: 'a', target: 'c', kind: 'branch' }],
  trees: [{ id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: 0 }], activeTreeId: 't1', createdAt: 0,
};

function wrapper({ children }: { children: React.ReactNode }) {
  return <PrefsProvider><ChatProvider>{children}</ChatProvider></PrefsProvider>;
}

async function mount(singlePageMode: boolean, withBrowser: boolean) {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('michi:v1:prefs', JSON.stringify({ singlePageMode }));
  localStorage.setItem('michi:v1:state', JSON.stringify({ version: 2, projects: [project], nodes: { a: chat('a'), b: chat('b'), c: chat('c') }, activeProjectId: 'p1' }));
  localStorage.setItem('michi:migrated', '1');
  // Single-page mode opens one chat at a time; seed the slot as a window left it.
  sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'p1::t1': withBrowser ? ['a', 'b', 'c', BROWSER] : ['a', 'b', 'c'] }));
  sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'p1::t1': 'c' }));
  sessionStorage.setItem('michi:panes:items:v1', JSON.stringify({
    [BROWSER]: { id: BROWSER, kind: 'browser', projectId: 'p1', treeId: 't1', title: 'Browser', createdAt: 1, surfaceId: 'web', url: 'https://example.com' },
  }));
  const view = renderHook(() => ({ store: useChatStore(), panes: useChatPanes(), nodes: useChatNodesSnapshot(), ...useCloseOtherPanes() }), { wrapper });
  await waitFor(() => expect(view.result.current.store.activeProject?.id).toBe('p1'));
  act(() => view.result.current.store.setPaneWidth('b', 480));
  return view;
}

/** The slot's panes, whichever of them single-page mode shows. */
const slotPanes = ({ panes }: { panes: ReturnType<typeof useChatPanes> }) => panes.tabPanes
  ? [...panes.tabPanes, ...panes.openPanes.filter((id) => !panes.tabPanes!.includes(id))]
  : panes.openPanes;

describe('useCloseOtherPanes', () => {
  beforeEach(() => { delete window.electron; });

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])('closes every other pane but browsers, focuses and widens the kept one (single-page %s, browser %s)', async (singlePage, withBrowser) => {
    const { result } = await mount(singlePage, withBrowser);
    expect(slotPanes(result.current)).toEqual(withBrowser ? ['a', 'b', 'c', BROWSER] : ['a', 'b', 'c']);
    expect(result.current.canCloseOtherPanes('b')).toBe(true);
    act(() => result.current.closeOtherPanes('b'));
    expect(slotPanes(result.current)).toEqual(withBrowser ? ['b', BROWSER] : ['b']);
    expect(result.current.panes.focusedPane).toBe('b');
    expect(result.current.nodes.b.paneWidth).toBeUndefined();
    expect(result.current.canCloseOtherPanes('b')).toBe(false);
  });
});
