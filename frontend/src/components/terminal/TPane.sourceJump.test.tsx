/**
 * A jump from a page's source into its conversation: TPane scrolls the cited
 * message to the middle once, then Continue puts the cursor in the composer
 * and Open leaves it out. Real TPane with stubbed children, as in
 * TPane.scrollSave.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, fireEvent } from '@testing-library/react';

const focusState = vi.hoisted(() => ({ focused: null as string | null, focus: vi.fn(), scrolled: [] as string[], editorReady: true }));
const nodeState = vi.hoisted(() => ({ status: 'idle', followUps: [] as string[] }));
const paneFind = vi.hoisted(() => ({ props: null as null | { onVisitMatch: (range: Range) => () => void } }));
// jsdom has no layout: the transcript is 800px tall in a 500px viewport, and
// scrolling a message into view puts it at 100.
const geom = vi.hoisted(() => ({ scrollTop: 0, scroller: null as HTMLElement | null }));
const observers = vi.hoisted(() => [] as Array<{ cb: () => void; targets: Element[] }>);
// How much of the conversation is loaded: messages from `from` on, older ones
// still unread; and how many replies the reader has not seen (`unread`).
const history = vi.hoisted(() => ({
  from: 0, unread: undefined as number | undefined, node: null as unknown,
  loadOlderUntil: vi.fn(), ensureCompleteHistory: vi.fn(),
}));
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));

if (typeof (globalThis as any).CSS === 'undefined') (globalThis as any).CSS = {};
if (!(globalThis as any).CSS.highlights) (globalThis as any).CSS.highlights = new Map();
if (typeof (globalThis as any).Highlight === 'undefined') {
  (globalThis as any).Highlight = class Highlight { constructor(..._r: any[]) {} };
}
if (typeof window.matchMedia !== 'function') {
  (window as any).matchMedia = () => ({
    matches: false, media: '', onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

(globalThis as any).ResizeObserver = class FakeResizeObserver {
  private entry: { cb: () => void; targets: Element[] };
  constructor(cb: () => void) { this.entry = { cb, targets: [] }; observers.push(this.entry); }
  observe(el: Element) { this.entry.targets.push(el); }
  unobserve() {}
  disconnect() { this.entry.targets = []; }
};
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

function stubGeometry(scroller: HTMLElement | null) {
  if (!scroller || geom.scroller === scroller) return;
  geom.scroller = scroller;
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 500 });
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => geom.scrollTop, set: (v: number) => { geom.scrollTop = v; } });
}
const scrolledTo = (id: string) => () => { focusState.scrolled.push(id); geom.scrollTop = 100; };

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const messages = Array.from({ length: 6 }, (_, i) => ({
    id: `m${i + 1}`, role: i % 2 === 0 ? 'user' : 'assistant', text: `msg ${i + 1}`, content: `msg ${i + 1}`,
    createdAt: (i + 1) * 100, toolCalls: [], blocks: [],
  }));
  const node = {
    id: 'node1', nodeId: 'node1', chatId: 'chat1', projectId: 'p1', kind: 'chat',
    get messages() { return messages.slice(history.from); },
    get historyBefore() { return history.from > 0 ? { id: messages[history.from].id, seq: history.from } : undefined; },
    get status() { return nodeState.status; },
    get followUps() { return nodeState.followUps; },
    get completionSeq() { return history.unread === undefined ? undefined : 10; },
    get seenCompletionSeq() { return history.unread === undefined ? undefined : 10 - history.unread; },
    followUpsGenerating: false, title: 'Test thread', pendingComments: [], queuedMessages: [], injectedContexts: [],
  };
  history.node = node;
  return {
    ...actual,
    useChatActions: () => new Proxy({}, { get: (_target, key) => (
      key === 'loadOlderUntil' ? history.loadOlderUntil : key === 'ensureCompleteHistory' ? history.ensureCompleteHistory : vi.fn()) }),
    useChatStore: () => ({ focusedPane: null }),
    useChatProjects: () => ({
      availableModes: [], agentStatus: null, refreshAgentStatus: vi.fn(),
      activeProject: { id: 'p1', name: 'P', artifacts: [], edges: [], chatIds: ['node1'], trees: [{ id: 't1', rootNodeId: 'node1' }], activeTreeId: 't1' },
    }),
    useChatPanes: () => ({ focusedPane: focusState.focused, openPanes: [], focusNonce: 0, paneItems: {}, viewMode: 'single' as const }),
    useChatNode: () => node,
    useStructuralSelector: (sel: any) => { try { return sel({}); } catch { return undefined; } },
  };
});
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: {}, setPref: vi.fn() }) }));
vi.mock('../../services/api', () => ({
  listAgentModels: vi.fn(async () => []),
  saveAgentOptions: vi.fn(async () => {}),
  getWebUploadCwd: vi.fn(async () => null),
  importWorkspaceFileUpload: vi.fn(async () => ({ filePath: '', displayName: '' })),
}));
vi.mock('./PaneMessageList', () => ({
  PaneMessageList: () => (
    <div ref={(el) => stubGeometry(el?.parentElement ?? null)}>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} data-msg-id={`m${i + 1}`} ref={(el) => {
          if (!el) return;
          el.scrollIntoView = scrolledTo(`m${i + 1}`);
          // Message n sits n * 100px down the transcript.
          if (history.unread !== undefined) el.getBoundingClientRect = () => ({ top: (i + 1) * 100 - geom.scrollTop } as DOMRect);
        }}>
          {[0, 1].map((n) => <span key={n} ref={(el) => { if (el) el.scrollIntoView = scrolledTo(`m${i + 1}/${n}`); }}>msg</span>)}
        </div>
      ))}
    </div>
  ),
}));
vi.mock('./ComposerShell', () => ({ ComposerShell: React.forwardRef((p: any, _r: any) => p.input) }));
vi.mock('./PaneComposerPreBlocks', () => ({ PaneComposerPreBlocks: () => null }));
vi.mock('./PaneComposerActions', () => ({ PaneComposerActions: () => null }));
vi.mock('./PaneComposerToolbarLeft', () => ({ PaneComposerToolbarLeft: () => null }));
vi.mock('./PaneAgentMenus', () => ({ PaneAgentMenus: () => null }));
vi.mock('./PaneFind', () => ({ default: (props: any) => { paneFind.props = props; return null; } }));
vi.mock('./PermissionBanner', () => ({ default: () => null, PermissionBanner: () => null }));
vi.mock('./MergeBanner', () => ({ default: () => null, MergeBanner: () => null }));
vi.mock('./PaneDragOverlays', () => ({ FileDropOverlay: () => null, PaneDropIndicator: () => null }));
vi.mock('../MentionEditor', () => ({ default: React.forwardRef((_p, ref) => {
  React.useImperativeHandle(ref, () => ({ get editor() { return focusState.editorReady ? { commands: { focus: focusState.focus } } : null; } }));
  return null;
}) }));
vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('../UploadProgressBar', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: toastMock }));

async function load() {
  vi.resetModules();
  const [{ default: TPane }, nav] = await Promise.all([import('./TPane'), import('../../state/sourceNav/sourceNav')]);
  nav.registerSourceNavigator({ currentOrigin: () => ({ kind: 'home', title: 'Home' }), reveal: async () => true, returnTo: () => {} });
  return { TPane, nav };
}

describe('TPane: jump from a page source', () => {
  beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear(); focusState.editorReady = true; });
  afterEach(async () => {
    cleanup();
    focusState.focused = null;
    focusState.focus.mockClear();
    focusState.scrolled = [];
    try { await act(async () => { await vi.advanceTimersByTimeAsync(1300); }); } finally { vi.useRealTimers(); }
  });

  it('Continue scrolls to the cited message once and puts the cursor in the composer', async () => {
    const { TPane, nav } = await load();
    await nav.openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'p1', nodeId: 'node1', messageId: 'm4', focus: true });
    const { unmount } = render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled[0]).toBe('m4');
    expect(focusState.focus).toHaveBeenCalledWith('end', { scrollIntoView: false });
    unmount();
    focusState.scrolled = [];
    focusState.focus.mockClear();
    render(<TPane nodeId="node1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled).toEqual([]);
    expect(focusState.focus).not.toHaveBeenCalledWith('end', { scrollIntoView: false });
  });

  it('Continue waits for the lazy composer after its cited message is ready', async () => {
    const { TPane, nav } = await load();
    focusState.editorReady = false;
    await nav.openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'p1', nodeId: 'node1', messageId: 'm4', focus: true });
    render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled[0]).toBe('m4');
    expect(focusState.focus).not.toHaveBeenCalled();
    focusState.editorReady = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(focusState.focus).toHaveBeenCalledExactlyOnceWith('end', { scrollIntoView: false });
  });

  it('Open scrolls to the message without focusing the composer; another conversation is left alone', async () => {
    const { TPane, nav } = await load();
    await nav.openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'p1', nodeId: 'node1', messageId: 'm2' });
    render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled[0]).toBe('m2');
    expect(focusState.focus).not.toHaveBeenCalled();
    expect(nav.getSourceNavState().reference).toMatchObject({ nodeId: 'node1', messageId: 'm2' });

    await nav.openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'p1', nodeId: 'other', messageId: 'm1', focus: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled).toEqual(expect.not.arrayContaining(['m1']));
    expect(focusState.focus).not.toHaveBeenCalled();
  });

  it('a conversation opened without a message (a new conversation card) only takes the cursor for Continue', async () => {
    const { TPane, nav } = await load();
    await nav.openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'p1', nodeId: 'node1', focus: true });
    render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled).toEqual([]);
    expect(focusState.focus).toHaveBeenCalledWith('end', { scrollIntoView: false });
  });
});

/**
 * A jump from outside the pane (search, the ask bar, a page's source link) or
 * from its own find bar: the mount restore and follow mode must not pull the
 * transcript back to its tail afterwards.
 */
describe('TPane: jump to a message', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    nodeState.status = 'idle';
    nodeState.followUps = [];
    geom.scrollTop = 0;
    geom.scroller = null;
    observers.length = 0;
    paneFind.props = null;
  });
  afterEach(async () => {
    cleanup();
    focusState.scrolled = [];
    document.querySelectorAll('.t-find-flash').forEach((el) => el.remove());
    try { await act(async () => { await vi.advanceTimersByTimeAsync(1300); }); } finally { vi.useRealTimers(); }
  });

  async function mount() {
    const { TPane } = await load();
    const { revealPageSource } = await import('../../state/pages/revealSource');
    const view = render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    const resize = () => { act(() => { for (const o of observers) if (geom.scroller && o.targets.includes(geom.scroller)) o.cb(); }); };
    const openSource = (messageId: string) => revealPageSource(
      { backendConnectionId: 'local', workspaceId: 'p1' },
      { nodeId: 'node1', assistantId: messageId },
      async () => true,
    );
    return { ...view, resize, openSource };
  }

  it.each([
    ['while the reply streams', { status: 'streaming', followUps: [] as string[] }],
    ['while follow-up suggestions show', { status: 'idle', followUps: ['Next?'] }],
  ])('a page source link stays on its message %s', async (_label, state) => {
    Object.assign(nodeState, state);
    const { resize, openSource } = await mount();
    // The mount restore has settled; follow mode holds the tail.
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    resize();
    expect(geom.scrollTop).toBe(300);

    await act(async () => { void openSource('m2'); await vi.advanceTimersByTimeAsync(200); });
    expect(focusState.scrolled).toContain('m2');
    expect(geom.scrollTop).toBe(100);
    resize();
    expect(geom.scrollTop).toBe(100);
  });

  it('a jump that lands while the mount restore is still positioning wins', async () => {
    const { resize, openSource } = await mount();
    resize();
    expect(geom.scrollTop).toBe(300);
    await act(async () => { void openSource('m2'); await vi.advanceTimersByTimeAsync(100); });
    expect(geom.scrollTop).toBe(100);
    resize();
    expect(geom.scrollTop).toBe(100);
  });

  it('a jump from outside the pane flashes the whole message', async () => {
    const { container, openSource } = await mount();
    await act(async () => { void openSource('m4'); await vi.advanceTimersByTimeAsync(100); });
    expect(container.querySelector('[data-msg-id="m4"]')?.classList.contains('t-msg-flash')).toBe(true);
  });

  it('find scrolls to the matched occurrence and flashes only it, also while the reply streams', async () => {
    nodeState.status = 'streaming';
    const { container, resize } = await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    // PaneFind's match: the second "msg" of m3.
    const text = container.querySelectorAll('[data-msg-id="m3"] span')[1]!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    act(() => { paneFind.props?.onVisitMatch(range); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(focusState.scrolled).toContain('m3/1');
    expect(focusState.scrolled).not.toContain('m3');
    expect(document.querySelector('.t-find-flash')).not.toBeNull();
    expect(container.querySelector('[data-msg-id="m3"]')?.classList.contains('t-msg-flash')).toBe(false);
    resize();
    expect(geom.scrollTop).toBe(100);
  });
});

describe('TPane: jump to a message older than its loaded page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    history.from = 2;
    history.loadOlderUntil.mockReset();
    toastMock.mockClear();
  });
  afterEach(async () => {
    cleanup();
    history.from = 0;
    focusState.scrolled = [];
    try { await act(async () => { await vi.advanceTimersByTimeAsync(1300); }); } finally { vi.useRealTimers(); }
  });

  async function jumpTo(messageId: string) {
    const { TPane, nav } = await load();
    render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    await act(async () => { nav.requestMessageJump('node1', messageId); await vi.advanceTimersByTimeAsync(200); });
  }

  it('reads older pages until the message is there, then scrolls to it', async () => {
    history.loadOlderUntil.mockImplementation(async () => {
      history.from = 0;
      return { found: true, pages: 1, more: false };
    });
    await jumpTo('m1');
    expect(history.loadOlderUntil).toHaveBeenCalledWith('node1', expect.any(Function), expect.objectContaining({ maxPages: 10 }));
    expect(focusState.scrolled[0]).toBe('m1');
  });

  it('says so when no older page has the message, and leaves the scroll where it is', async () => {
    history.loadOlderUntil.mockResolvedValue({ found: false, pages: 3, more: false });
    await jumpTo('m1');
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining("Couldn't find that message"));
    expect(focusState.scrolled).toEqual([]);
  });
});

/**
 * The unread replies reach past the loaded page: the pane holds the oldest
 * loaded message while it reads back to the first of them, then lands on its
 * question at UNSEEN_TOP_FRACTION (message n sits at n * 100px; 30% of the
 * 500px viewport is 150px).
 */
describe('TPane: unread replies older than the loaded page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    nodeState.status = 'idle';
    nodeState.followUps = [];
    geom.scrollTop = 0;
    geom.scroller = null;
    history.from = 4;
    history.unread = 2;
    history.loadOlderUntil.mockReset();
  });
  afterEach(async () => {
    cleanup();
    history.from = 0;
    history.unread = undefined;
    focusState.scrolled = [];
    try { await act(async () => { await vi.advanceTimersByTimeAsync(1300); }); } finally { vi.useRealTimers(); }
  });

  async function open() {
    const { TPane, nav } = await load();
    render(<TPane nodeId="node1" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    return nav;
  }

  it('reads older pages until the first unread reply is there, then lands on its question', async () => {
    history.loadOlderUntil.mockImplementation(async (_id: string, has: (node: unknown) => boolean) => {
      history.from = 2;
      return { found: has(history.node), pages: 1, more: true };
    });
    await open();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(history.loadOlderUntil).toHaveBeenCalledExactlyOnceWith('node1', expect.any(Function), expect.objectContaining({ maxPages: 5 }));
    await expect(history.loadOlderUntil.mock.results[0].value).resolves.toMatchObject({ found: true });
    // m3 asked what m4, the first of the two unread replies, answers.
    expect(geom.scrollTop).toBe(150);
  });

  it.each([
    ['the reader scrolls the transcript meanwhile', 350, async () => { fireEvent.wheel(geom.scroller!); }],
    ['a jump arrives meanwhile', 100, async (nav: Awaited<ReturnType<typeof open>>) => {
      history.loadOlderUntil.mockImplementationOnce(async () => { history.from = 0; return { found: true, pages: 2, more: false }; });
      nav.requestMessageJump('node1', 'm2');
      await vi.advanceTimersByTimeAsync(200);
    }],
  ])('stays where it is when %s', async (_label, stays, interrupt) => {
    let finishRead!: () => void;
    history.loadOlderUntil.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = () => {
        history.from = Math.min(history.from, 2);
        resolve({ found: true, pages: 1, more: true });
      };
    }));
    const nav = await open();
    // Held on m5, the oldest message loaded, while the older page comes.
    expect(geom.scrollTop).toBe(350);
    await act(async () => { await interrupt(nav); });
    await act(async () => { finishRead(); await vi.advanceTimersByTimeAsync(50); });
    expect((history.loadOlderUntil.mock.calls[0][2] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect(geom.scrollTop).toBe(stays);
  });
});
