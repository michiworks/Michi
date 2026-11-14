import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionTarget } from 'michi-shared';
import { requestOpenCompanionTarget } from '../../../state/attentionOpenRequests';
import {
  closeCompanionPanel,
  getCompanionPanelState,
  resetCompanionPanelForTests,
  subscribeCompanionPanel,
} from '../../../state/companion/companionPanel';
import { adoptCompanionSnapshot, getCompanionState, resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { assistantInfo, companionItem, companionSnapshot } from '../../../test/companionFixtures';
import { CompanionNotifications, resetCompanionNotificationsForTests } from './CompanionNotifications';
import { CompanionTopbarButton } from './CompanionTopbarButton';

const mocks = vi.hoisted(() => ({
  electron: null as null | Record<string, unknown>,
  stopFeed: vi.fn(),
  stopPresence: vi.fn(),
  revealBackendNode: vi.fn(async () => true),
  openUrl: vi.fn(),
}));
vi.mock('../../../services/openUrl', () => ({ openPreferredUrl: mocks.openUrl }));
vi.mock('../../../lib/electronBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/electronBridge')>()),
  getElectron: () => mocks.electron,
}));
vi.mock('../../../state/companion/companionFeed', () => ({ startCompanionFeed: () => mocks.stopFeed }));
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

/**
 * Every target Michi's records open (services/companion/notices.ts), and
 * where a click must land: a Needs you item opens Today at it; a conversation
 * waiting 30 minutes, or a finished delegation, opens the conversation; a
 * post opens Chat.
 */
const SHAPES: Array<{ id: string; target: CompanionTarget; lands: 'today-at-item' | 'conversation' | 'today' | 'chat' }> = [
  { id: 'needs-you', target: { kind: 'companion', tab: 'today', itemId: 'cr' }, lands: 'today-at-item' },
  { id: 'waiting-30-min', target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-9' }, lands: 'conversation' },
  { id: 'today', target: { kind: 'companion', tab: 'today' }, lands: 'today' },
  { id: 'post', target: { kind: 'companion', tab: 'chat' }, lands: 'chat' },
  { id: 'finished-delegation', target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-9' }, lands: 'conversation' },
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

let hasFocus: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mocks.revealBackendNode.mockClear();
  mocks.openUrl.mockReset();
  mocks.electron = null;
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

describe('where a click on one of Michi\'s notifications lands', () => {
  it('a toast or OS notification this window raised opens its record\'s target, for every shape', async () => {
    render(<CompanionNotifications />);
    for (const { id, target, lands } of SHAPES) {
      act(() => resetCompanionPanelForTests());
      mocks.revealBackendNode.mockClear();
      await act(async () => { requestOpenCompanionTarget(target); });
      expect(landing(), id).toEqual(EXPECTED[lands]);
    }
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it('never makes a notice of its own from the snapshot: new urgent items and unread messages alone stay quiet', () => {
    render(<CompanionNotifications />);
    next({ items: [companionItem('a', { severity: 'now' }), ...first.items] });
  });

  it('opens no panel while the agent is off (Q29): a notice from before leads nowhere; a conversation still opens', async () => {
    const off = companionSnapshot({ settings: { ...companionSnapshot().settings, paused: true } });
    resetCompanionStoreForTests({ snapshot: off });
    render(<CompanionNotifications />);
    for (const target of [{ kind: 'companion', tab: 'chat' }, { kind: 'companion', tab: 'today', itemId: 'cr' }] as CompanionTarget[]) {
      await act(async () => { requestOpenCompanionTarget(target); });
      expect(getCompanionPanelState().open, JSON.stringify(target)).toBe(false);
    }
    await act(async () => { requestOpenCompanionTarget({ kind: 'node', workspaceId: 'ws-1', nodeId: 'n-1' }); });
    expect(mocks.revealBackendNode).toHaveBeenCalledWith('ws-1', 'n-1');
  });

  it('stops listening when it unmounts', async () => {
    const view = render(<CompanionNotifications />);
    view.unmount();
    expect(mocks.stopFeed).toHaveBeenCalled();
    await act(async () => { requestOpenCompanionTarget({ kind: 'companion', tab: 'chat' }); });
    expect(getCompanionPanelState().open).toBe(false);
  });
});

describe('clicks on Electron main\'s banners', () => {
  function electron(initialCompanionTarget: CompanionTarget | null = null) {
    const handlers: { open?: (target: CompanionTarget) => void } = {};
    mocks.electron = {
      initialCompanionTarget,
      onCompanionOpen: (handler: (target: CompanionTarget) => void) => { handlers.open = handler; return () => {}; },
    };
    return handlers;
  }

  it('opens what a banner click points at', () => {
    const handlers = electron();
    render(<CompanionNotifications />);
    act(() => handlers.open!({ kind: 'companion', tab: 'chat' }));
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat' });
  });

  it('lands a banner click where this window\'s own click lands, for every shape', async () => {
    const handlers = electron();
    render(<CompanionNotifications />);
    for (const { id, target, lands } of SHAPES) {
      act(() => resetCompanionPanelForTests());
      mocks.revealBackendNode.mockClear();
      await act(async () => { requestOpenCompanionTarget(target); });
      const byWindow = landing();
      act(() => resetCompanionPanelForTests());
      mocks.revealBackendNode.mockClear();
      await act(async () => { handlers.open!(target); });
      expect(byWindow, id).toEqual(landing());
      expect(byWindow, id).toEqual(EXPECTED[lands]);
    }
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

  it('is absent while the agent is off (Q29), and back at once when it is turned on', () => {
    const settings = companionSnapshot().settings;
    resetCompanionStoreForTests({ assistant: ready, snapshot: companionSnapshot({ settings: { ...settings, paused: true }, counts: { needsYou: 2, newItems: 2, unreadMessages: 1 } }) });
    const { container } = render(<CompanionTopbarButton />);
    expect(container.innerHTML).toBe('');
    act(() => adoptCompanionSnapshot({ ...getCompanionState().snapshot!, settings: { ...settings, paused: false }, revision: 99 }));
    expect(screen.getByRole('button', { name: /^Michi/ })).toBeTruthy();
  });

  it('is absent when this backend has no assistant', () => {
    resetCompanionStoreForTests({ assistant: { status: 'unsupported', info: null, error: null }, snapshot: companionSnapshot() });
    const { container } = render(<CompanionTopbarButton />);
    expect(container.innerHTML).toBe('');
  });
});
