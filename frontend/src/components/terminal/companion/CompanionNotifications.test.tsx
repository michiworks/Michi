import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionNotice, CompanionTarget } from 'michi-shared';
import {
  closeCompanionPanel,
  getCompanionPanelState,
  openCompanionPanel,
  resetCompanionPanelForTests,
  subscribeCompanionPanel,
} from '../../../state/companion/companionPanel';
import { adoptCompanionSnapshot, getCompanionState, resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { assistantInfo, companionItem, companionSnapshot } from '../../../test/companionFixtures';
import { CompanionNotifications, resetCompanionNotificationsForTests } from './CompanionNotifications';
import { CompanionTopbarButton } from './CompanionTopbarButton';

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  electron: null as null | Record<string, unknown>,
  stopFeed: vi.fn(),
  stopPresence: vi.fn(),
  noticeListeners: new Set<(notice: CompanionNotice) => void>(),
  revealBackendNode: vi.fn(async () => true),
  openUrl: vi.fn(),
}));
vi.mock('../../../services/notifications', () => ({ notify: mocks.notify }));
vi.mock('../../../services/openUrl', () => ({ openPreferredUrl: mocks.openUrl }));
vi.mock('../../../lib/electronBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/electronBridge')>()),
  getElectron: () => mocks.electron,
}));
vi.mock('../../../state/companion/companionFeed', () => ({
  startCompanionFeed: () => mocks.stopFeed,
  subscribeCompanionNotices: (listener: (notice: CompanionNotice) => void) => {
    mocks.noticeListeners.add(listener);
    return () => { mocks.noticeListeners.delete(listener); };
  },
}));
vi.mock('../../../state/companion/companionPresence', () => ({ startCompanionPresence: () => mocks.stopPresence }));
vi.mock('../../../state/chatStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/chatStore')>()),
  useChatActions: () => ({ revealBackendNode: mocks.revealBackendNode }),
}));

const first = companionSnapshot({ items: [companionItem('old', { title: 'Already there' })], revision: 1 });

function next(overrides: Parameters<typeof companionSnapshot>[0]) {
  const current = getCompanionState().snapshot!;
  act(() => adoptCompanionSnapshot({ ...current, ...overrides, revision: current.revision + 1 }));
}

/** A notice about one item, as the backend sends it (delivery.ts itemNoticeDraft): Today, at that item. */
const notice = (id: string, overrides: Partial<CompanionNotice> = {}): CompanionNotice => ({
  id, title: 'Companion', body: 'CR-9 needs attention — 1 unresolved comment', target: { kind: 'companion', tab: 'today', itemId: 'cr' },
  itemIds: ['cr'], createdAt: 1, expiresAt: Date.now() + 60_000, ...overrides,
});

/**
 * Every notice shape the backend sends, and where its click must land: a
 * single item opens Today at it; a conversation waiting 30 minutes, or a
 * finished worker, opens the conversation; a batch or "while you were away"
 * fold opens Today; a reply opens Chat.
 */
const SHAPES: Array<{ notice: CompanionNotice; lands: 'today-at-item' | 'conversation' | 'today' | 'chat' }> = [
  { notice: notice('one-item'), lands: 'today-at-item' },
  { notice: notice('waiting-30-min', { target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-9' }, itemIds: ['cmi-michi'] }), lands: 'conversation' },
  { notice: notice('batch', { target: { kind: 'companion', tab: 'today' }, itemIds: ['a', 'b'] }), lands: 'today' },
  { notice: notice('reply', { target: { kind: 'companion', tab: 'chat' }, itemIds: [] }), lands: 'chat' },
  { notice: notice('worker-finished', { target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-9' }, itemIds: [] }), lands: 'conversation' },
];

/** Where the user is after a click: the panel (tab, the item asked for) and the conversation revealed. */
function landing() {
  const panel = getCompanionPanelState();
  return {
    panel: panel.open ? { tab: panel.tab, item: panel.focusItem?.id ?? null } : null,
    revealed: mocks.revealBackendNode.mock.calls.map((call) => (call as unknown[]).join('/')),
  };
}

const EXPECTED = {
  'today-at-item': { panel: { tab: 'today', item: 'cr' }, revealed: [] },
  conversation: { panel: null, revealed: ['ws-1/n-9'] },
  today: { panel: { tab: 'today', item: null }, revealed: [] },
  chat: { panel: { tab: 'chat', item: null }, revealed: [] },
} as const;

/** A notice the backend's gate sent over the change feed. */
function fromFeed(value: CompanionNotice) {
  act(() => { for (const listener of [...mocks.noticeListeners]) listener(value); });
}

let hasFocus: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mocks.notify.mockReset();
  mocks.revealBackendNode.mockClear();
  mocks.openUrl.mockReset();
  mocks.electron = null;
  mocks.noticeListeners.clear();
  resetCompanionNotificationsForTests();
  resetCompanionPanelForTests();
  resetCompanionStoreForTests({ snapshot: first });
  hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => {
  hasFocus.mockRestore();
  resetCompanionStoreForTests();
  window.history.replaceState(null, '', '/');
});

describe('Companion notices in a browser', () => {
  it('shows the notices the backend’s gate sends over the feed, once each, and none that expired', () => {
    render(<CompanionNotifications />);
    fromFeed(notice('n-1'));
    fromFeed(notice('n-1'));
    fromFeed(notice('n-2', { expiresAt: Date.now() - 1 }));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Companion', body: 'CR-9 needs attention — 1 unresolved comment' }));
    // A click opens where the notice points: Today, at its item.
    act(() => mocks.notify.mock.calls[0][0].onClick());
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'today', focusItem: { id: 'cr' } });
  });

  it('opens exactly the notice’s target on a click, for every shape the backend sends', async () => {
    render(<CompanionNotifications />);
    for (const { notice: value, lands } of SHAPES) {
      act(() => resetCompanionPanelForTests());
      mocks.revealBackendNode.mockClear();
      mocks.notify.mockReset();
      fromFeed(value);
      await act(async () => { mocks.notify.mock.calls[0][0].onClick(); });
      expect(landing(), value.id).toEqual(EXPECTED[lands]);
    }
  });

  it('never makes a notice of its own from the snapshot: new urgent items and unread messages alone stay quiet', () => {
    render(<CompanionNotifications />);
    // Before the welcome, on an off day or past the caps the gate sends nothing, so neither does this window.
    next({ items: [companionItem('cr', { title: 'CR-9 needs changes', summary: '1 comment' }), ...first.items] });
    next({
      counts: { ...first.counts, unreadMessages: 1 },
      activity: [{ id: 'run-1', kind: 'brief', trigger: 'schedule', outcome: 'spoke', detail: 'Your brief is ready', startedAt: 1, finishedAt: 2 }],
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('does not announce what the open panel already shows, but does the rest', () => {
    render(<CompanionNotifications />);
    act(() => openCompanionPanel({ tab: 'today' }));
    fromFeed(notice('n-1'));
    expect(mocks.notify).not.toHaveBeenCalled();
    fromFeed(notice('n-2', { target: { kind: 'companion', tab: 'chat' }, itemIds: [], body: 'Your pipeline recovered' }));
    fromFeed(notice('n-3', { target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-9' }, itemIds: [], body: 'Worker finished: Fix the build' }));
    expect(mocks.notify.mock.calls.map(([options]) => options.body)).toEqual(['Your pipeline recovered', 'Worker finished: Fix the build']);
  });

  it('stops listening when it unmounts', () => {
    const view = render(<CompanionNotifications />);
    expect(mocks.noticeListeners.size).toBe(1);
    view.unmount();
    expect(mocks.noticeListeners.size).toBe(0);
  });
});

describe('Companion notices in the desktop app', () => {
  function electron(initialCompanionTarget: CompanionTarget | null = null) {
    const handlers: { notice?: (notice: CompanionNotice) => void; open?: (target: CompanionTarget) => void } = {};
    mocks.electron = {
      initialCompanionTarget,
      onCompanionNotice: (handler: (notice: CompanionNotice) => void) => { handlers.notice = handler; return () => {}; },
      onCompanionOpen: (handler: (target: CompanionTarget) => void) => { handlers.open = handler; return () => {}; },
    };
    return handlers;
  }

  it('shows the toasts Electron sends while the window has focus, once each, and none that expired', () => {
    const handlers = electron();
    render(<CompanionNotifications />);
    const pipeline = notice('n-1', { title: 'Pipeline blocked', body: 'MyService', target: { kind: 'companion', tab: 'today', itemId: 'pipe' }, itemIds: ['pipe'] });
    handlers.notice!(pipeline);
    handlers.notice!(pipeline);
    handlers.notice!(notice('n-2', { expiresAt: Date.now() - 1 }));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    act(() => mocks.notify.mock.calls[0][0].onClick());
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'today', focusItem: { id: 'pipe' } });
    // Electron toasts for this window: it neither toasts new items itself nor takes the feed's notices.
    next({ items: [companionItem('a'), ...first.items] });
    expect(mocks.noticeListeners.size).toBe(0);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it('shows a notice once in the desktop app, though the change feed carries it too', () => {
    const handlers = electron();
    render(<CompanionNotifications />);
    // Main shows it as this window's toast (or a banner); the renderer feed's copy is not shown again.
    handlers.notice!(notice('n-1'));
    fromFeed(notice('n-1'));
    fromFeed(notice('n-2', { body: 'Only on the feed' }));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0].body).toBe('CR-9 needs attention — 1 unresolved comment');
  });

  it('opens what a banner click points at', () => {
    const handlers = electron();
    render(<CompanionNotifications />);
    act(() => handlers.open!({ kind: 'companion', tab: 'chat' }));
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat' });
  });

  it('lands a toast click where the banner click lands, for every shape the backend sends', async () => {
    const handlers = electron();
    render(<CompanionNotifications />);
    for (const { notice: value, lands } of SHAPES) {
      // The window has focus: a toast.
      act(() => resetCompanionPanelForTests());
      mocks.revealBackendNode.mockClear();
      mocks.notify.mockReset();
      handlers.notice!(value);
      await act(async () => { mocks.notify.mock.calls[0][0].onClick(); });
      const byToast = landing();
      // Michi in the background: a banner, whose click main hands to this window.
      act(() => resetCompanionPanelForTests());
      mocks.revealBackendNode.mockClear();
      await act(async () => { handlers.open!(value.target); });
      expect(byToast, value.id).toEqual(landing());
      expect(byToast, value.id).toEqual(EXPECTED[lands]);
    }
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it('opens the target a banner click opened the window with once, and drops it from the URL so a reload does not', () => {
    const target: CompanionTarget = { kind: 'companion', tab: 'today' };
    window.history.replaceState(null, '', `/?michiWindowId=w1&${new URLSearchParams({ michiCompanionTarget: JSON.stringify(target) })}`);
    electron(target);
    const opens: boolean[] = [];
    const unsubscribe = subscribeCompanionPanel(() => opens.push(getCompanionPanelState().open));
    const view = render(<React.StrictMode><CompanionNotifications /></React.StrictMode>);
    unsubscribe();
    // StrictMode runs the effect twice: the target opens once.
    expect(opens).toEqual([true]);
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'today' });
    expect(window.location.search).toBe('?michiWindowId=w1');
    // The user closes it; a remount (an error boundary's retry) does not open it again.
    act(() => closeCompanionPanel());
    view.unmount();
    render(<React.StrictMode><CompanionNotifications /></React.StrictMode>);
    expect(getCompanionPanelState().open).toBe(false);
    expect(window.location.search).toBe('?michiWindowId=w1');
  });

  it('opens Today at the item a banner’s notice named, in the window that click opened', () => {
    electron({ kind: 'companion', tab: 'today', itemId: 'cmi-7' });
    render(<CompanionNotifications />);
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'today', focusItem: { id: 'cmi-7' } });
  });
});

describe('the Topbar button (DESIGN-v2 §1.2)', () => {
  const ready = { status: 'ready' as const, info: assistantInfo() as never, error: null };

  it('counts what needs the user and the agent’s unread messages, and toggles the panel', () => {
    resetCompanionStoreForTests({ assistant: ready, snapshot: companionSnapshot({
      items: [companionItem('a'), companionItem('b', { status: 'seen' }), companionItem('c', { bucket: 'update' })],
      counts: { needsYou: 2, newItems: 2, unreadMessages: 1 },
    }) });
    render(<CompanionTopbarButton />);
    const button = screen.getByRole('button', { name: 'Michi, 2 new' });
    expect(button.textContent).toBe('2');
    expect(button.querySelector('[data-companion-glyph]')).toBeTruthy();
    fireEvent.click(button);
    expect(getCompanionPanelState().open).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(getCompanionPanelState().open).toBe(false);
  });

  it('caps the badge at 9+, and shows a New dot before the first open', () => {
    resetCompanionStoreForTests({ assistant: ready, snapshot: companionSnapshot({ items: Array.from({ length: 12 }, (_, index) => companionItem(`i-${index}`)) }) });
    const view = render(<CompanionTopbarButton />);
    expect(screen.getByRole('button', { name: 'Michi, 12 new' }).textContent).toBe('9+');
    view.unmount();
    resetCompanionStoreForTests({ assistant: ready, snapshot: companionSnapshot() });
    resetCompanionPanelForTests({ openedBefore: false });
    render(<CompanionTopbarButton />);
    expect(screen.getByRole('button', { name: 'Michi, new' }).querySelector('.companion-topbar-btn__new')).toBeTruthy();
  });

  it('shows with the conversation alone, before (or without) any Companion snapshot', () => {
    resetCompanionStoreForTests({ assistant: ready, availability: 'unavailable' });
    render(<CompanionTopbarButton />);
    expect(screen.getByRole('button', { name: 'Michi' }).textContent).toBe('');
  });

  it('is absent when this backend has no assistant', () => {
    resetCompanionStoreForTests({ assistant: { status: 'unsupported', info: null, error: null }, snapshot: companionSnapshot() });
    const { container } = render(<CompanionTopbarButton />);
    expect(container.innerHTML).toBe('');
  });
});
