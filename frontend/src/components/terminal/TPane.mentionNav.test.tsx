/**
 * A chat mention clicked in a dashboard pane opens that chat beside the pane
 * when it is in the shown thread, and in its own thread otherwise.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-mention-${++i}`); })(),
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
  ensureSession: vi.fn(() => Promise.reject(new Error('offline in tests'))),
  streamMessage: vi.fn(() => () => {}),
}));
vi.mock('../../services/notifications', () => ({ notify: vi.fn() }));
const list = vi.hoisted(() => ({ onMentionClick: null as null | ((name: string, kind: string, nodeId?: string) => void) }));
vi.mock('./PaneMessageList', () => ({
  PaneMessageList: (props: { onMentionClick: (name: string, kind: string, nodeId?: string) => void }) => {
    list.onMentionClick = props.onMentionClick;
    return null;
  },
}));
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef((_props: unknown, _ref: unknown) => <textarea data-testid="composer" />),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));

import TPane from './TPane';
import { ChatProvider, useChatPanes, useChatStore } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';

if (typeof CSS === 'undefined') (globalThis as { CSS?: unknown }).CSS = {};
if (!(CSS as unknown as { highlights?: unknown }).highlights) (CSS as unknown as { highlights: Map<string, unknown> }).highlights = new Map();
if (typeof Element.prototype.scrollTo !== 'function') Element.prototype.scrollTo = () => {};
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

let store: ReturnType<typeof useChatStore>;
let panes: ReturnType<typeof useChatPanes>;
let paneNodeId: string | null = null;

function Harness() {
  store = useChatStore();
  panes = useChatPanes();
  return paneNodeId ? <TPane nodeId={paneNodeId} /> : null;
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline in tests'))));
  // jsdom has no window.focus; revealNode calls it.
  vi.spyOn(window, 'focus').mockImplementation(() => {});
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('TPane — a chat mention', () => {
  it('opens a chat of another thread in that thread, not among this thread\'s panes', async () => {
    localStorage.clear();
    render(<PrefsProvider><ChatProvider><Harness /></ChatProvider></PrefsProvider>);
    await waitFor(() => expect(store.hydrated).toBe(true));
    await act(async () => { await store.createProject('Work', '/work'); });
    let otherRoot = '';
    act(() => { otherRoot = store.createThread()!; });
    const otherTree = store.activeProject!.activeTreeId!;
    let shownRoot = '';
    act(() => { shownRoot = store.createThread()!; });
    const shownTree = store.activeProject!.activeTreeId!;
    let sibling = '';
    await act(async () => { sibling = await store.createBlankChild(shownRoot); });
    paneNodeId = shownRoot;
    act(() => { store.focusPane(shownRoot); });
    await waitFor(() => expect(list.onMentionClick).not.toBeNull());

    // Same thread: beside this pane, as before.
    act(() => { list.onMentionClick!('Sibling', 'node', sibling); });
    expect(store.activeProject!.activeTreeId).toBe(shownTree);
    expect(panes.focusedPane).toBe(sibling);

    act(() => { list.onMentionClick!('Other', 'node', otherRoot); });
    expect(store.activeProject!.activeTreeId).toBe(otherTree);
    expect(panes.focusedPane).toBe(otherRoot);
    act(() => { store.activateTree(shownTree); });
    expect(panes.openPanes).not.toContain(otherRoot);
    paneNodeId = null;
  });
});
