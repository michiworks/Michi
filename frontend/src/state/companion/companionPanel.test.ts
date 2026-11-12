import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  getCompanionPanelState,
  openCompanionPanel,
  openCompanionSource,
  registerCompanionOpenSource,
  resetCompanionPanelForTests,
  noteCompanionScreen,
  setCompanionHistoryOpen,
  setCompanionPanelTab,
  setCompanionTarget,
  takeCompanionFocusMessage,
  takeCompanionRequests,
  toggleCompanionPanel,
  closeCompanionPanel,
  useCompanionPanelShownNodeIds,
} from './companionPanel';
import { resetCompanionStoreForTests } from './companionStore';
import { assistantInfo } from '../../test/companionFixtures';

/** A stand-in panel root, so focus can be inside it or outside it. */
function mountPanel(): { panel: HTMLElement; composer: HTMLElement; outside: HTMLElement } {
  document.body.innerHTML = '';
  const outside = document.createElement('input');
  const panel = document.createElement('aside');
  panel.setAttribute('data-companion-panel', '');
  const composer = document.createElement('div');
  composer.tabIndex = 0;
  panel.append(composer);
  document.body.append(outside, panel);
  return { panel, composer, outside };
}

beforeEach(() => {
  resetCompanionPanelForTests();
  resetCompanionStoreForTests({ assistant: { status: 'ready', info: assistantInfo('v1') as never, error: null } });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('⌘J and ⇧⌘J (DESIGN-v2 §1.2)', () => {
  it('⌘J: closed → open on Chat with the composer focused; focus elsewhere → back to the composer on Chat; focus in the panel → close', () => {
    const { composer, outside } = mountPanel();
    outside.focus();
    toggleCompanionPanel('chat');
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat', composerFocusSeq: 1 });
    toggleCompanionPanel('today');
    expect(getCompanionPanelState().tab).toBe('today');
    // Focus left the panel for the page: ⌘J brings it back to the composer, on Chat.
    outside.focus();
    toggleCompanionPanel('chat');
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat', composerFocusSeq: 2 });
    composer.focus();
    toggleCompanionPanel('chat');
    expect(getCompanionPanelState().open).toBe(false);
  });

  it('⇧⌘J: opens on Today, moving focus into the panel; on Today with focus in it, closes', () => {
    const { composer } = mountPanel();
    toggleCompanionPanel('today');
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'today', panelFocusSeq: 1 });
    composer.focus();
    toggleCompanionPanel('today');
    expect(getCompanionPanelState().open).toBe(false);
  });

  it('closing hands focus back to where it was when the panel opened, else to the Topbar button', () => {
    const { composer, outside } = mountPanel();
    outside.focus();
    openCompanionPanel();
    composer.focus();
    closeCompanionPanel();
    expect(document.activeElement).toBe(outside);
    const button = document.createElement('button');
    button.setAttribute('data-companion-button', '');
    document.body.append(button);
    openCompanionPanel();
    outside.remove();
    composer.focus();
    closeCompanionPanel();
    expect(document.activeElement).toBe(button);
  });

  it('closing leaves alone a focus the user moved out of the panel', () => {
    const { outside } = mountPanel();
    const other = document.createElement('button');
    document.body.append(other);
    outside.focus();
    openCompanionPanel();
    other.focus();
    closeCompanionPanel();
    expect(document.activeElement).toBe(other);
  });
});

describe('opening (DESIGN-v2 §1.3)', () => {
  it('a draft, a send, chips or a target open Chat; an item opens Today', () => {
    openCompanionPanel({ focusItem: 'i1' });
    expect(getCompanionPanelState()).toMatchObject({ tab: 'today', focusItem: { id: 'i1' } });
    openCompanionPanel({ target: { pageId: 'p1', blockId: 'b1' } });
    expect(getCompanionPanelState()).toMatchObject({ tab: 'chat', target: { pageId: 'p1', blockId: 'b1' } });
  });

  it('queues requests for the Chat tab, and drops the ones not taken when the panel closes', () => {
    openCompanionPanel({ draft: 'a' });
    openCompanionPanel({ send: 'b', attachments: [{ kind: 'companion_item', id: 'i1', title: 't' }] });
    expect(getCompanionPanelState().requestSeq).toBe(2);
    expect(takeCompanionRequests()).toEqual([{ draft: 'a' }, { send: 'b', attachments: [{ kind: 'companion_item', id: 'i1', title: 't' }] }]);
    expect(takeCompanionRequests()).toEqual([]);
    openCompanionPanel({ draft: 'c' });
    closeCompanionPanel();
    expect(takeCompanionRequests()).toEqual([]);
  });

  it('is never open beside another panel: nothing else closes it', () => {
    openCompanionPanel();
    window.sessionStorage.setItem('michi:assistant-panel-open', '1');
    expect(getCompanionPanelState().open).toBe(true);
  });
});

describe('links the area on screen shows its own way (§1.4)', () => {
  it('asks the latest registration still in place; unregistered, nothing claims the link', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => false);
    const offFirst = registerCompanionOpenSource('spaces', first);
    const offSecond = registerCompanionOpenSource('conversations', second);
    expect(openCompanionSource({ kind: 'node', id: 'n1' })).toBe(true);
    expect(second).toHaveBeenCalledWith({ kind: 'node', id: 'n1' });
    expect(first).toHaveBeenCalled();
    offFirst();
    offSecond();
    expect(openCompanionSource({ kind: 'node', id: 'n1' })).toBe(false);
  });
});


describe('a block target belongs to its moment (F1a-review #9)', () => {
  it('lets go when the panel closes', () => {
    openCompanionPanel({ target: { pageId: 'p1', blockId: 'b1' } });
    expect(getCompanionPanelState().target).toMatchObject({ pageId: 'p1' });
    closeCompanionPanel();
    expect(getCompanionPanelState().target).toBeNull();
  });

  it('lets go when the shell shows another screen, and keeps it on the screen it was set on', () => {
    noteCompanionScreen('space|page:local:w:p1');
    setCompanionTarget({ pageId: 'p1', blockId: 'b1' });
    noteCompanionScreen('space|page:local:w:p1');
    expect(getCompanionPanelState().target).not.toBeNull();
    noteCompanionScreen('scheduled|');
    expect(getCompanionPanelState().target).toBeNull();
    // Set before the shell named any screen: it belongs to the first one named.
    resetCompanionPanelForTests();
    setCompanionTarget({ pageId: 'p2' });
    noteCompanionScreen('dashboard|');
    expect(getCompanionPanelState().target).toMatchObject({ pageId: 'p2' });
    noteCompanionScreen('spaces|home');
    expect(getCompanionPanelState().target).toBeNull();
  });
});

describe('the requests Settings and Activity make (FX-F2 contract)', () => {
  it('focusMessageId opens Chat at the message without pulling focus to the composer, taken once', () => {
    openCompanionPanel({ tab: 'today' });
    openCompanionPanel({ focusMessageId: 'cmp-post-r1' });
    const state = getCompanionPanelState();
    expect(state).toMatchObject({ open: true, tab: 'chat', focusMessage: { id: 'cmp-post-r1' } });
    expect(state.composerFocusSeq).toBe(0);
    takeCompanionFocusMessage(state.focusMessage!.seq);
    expect(getCompanionPanelState().focusMessage).toBeNull();
  });

  it('history opens Chat’s History view; closing the panel leaves it', () => {
    openCompanionPanel({ history: true });
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat', historyOpen: true });
    setCompanionHistoryOpen(false);
    expect(getCompanionPanelState().historyOpen).toBe(false);
    openCompanionPanel({ history: true });
    closeCompanionPanel();
    expect(getCompanionPanelState().historyOpen).toBe(false);
  });

  it('a draft from a post keeps the post it replies to (D9); a bare reply mark is no request', () => {
    openCompanionPanel({ draft: 'Draft the note', replyToPost: 'cmp-post-r9' });
    openCompanionPanel({ replyToPost: 'cmp-post-r8' });
    expect(takeCompanionRequests()).toEqual([{ draft: 'Draft the note', replyToPost: 'cmp-post-r9' }]);
  });
});

describe('the conversation the panel shows, which presence does not report', () => {
  it('names V only while the panel is open on Chat, following the conversation the store has', () => {
    const shown = renderHook(() => useCompanionPanelShownNodeIds());
    expect(shown.result.current).toEqual([]);
    act(() => openCompanionPanel({ tab: 'chat', focusComposer: false }));
    expect(shown.result.current).toEqual(['v1']);
    act(() => setCompanionPanelTab('today'));
    expect(shown.result.current).toEqual([]);
    act(() => setCompanionPanelTab('chat'));
    act(() => resetCompanionStoreForTests({ assistant: { status: 'ready', info: assistantInfo('v2') as never, error: null } }));
    expect(shown.result.current).toEqual(['v2']);
    act(() => closeCompanionPanel());
    expect(shown.result.current).toEqual([]);
    shown.unmount();
  });
});
