import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionRunDto } from 'michi-shared';
import {
  getCompanionPanelState,
  isCompanionPanelShowing,
  openCompanionPanel,
  resetCompanionPanelForTests,
  setCompanionTarget,
} from '../../../state/companion/companionPanel';
import { getCompanionAssistant, resetCompanionStoreForTests, updateCompanionSnapshot } from '../../../state/companion/companionStore';
import { getAssistantComposer, resetAssistantComposerForTests } from '../../../state/assistant/assistantComposer';
import { dispatchPageHelperDraft } from '../../../state/pages/pageHelperDraft';
import { backTarget, hasBackLayer } from '../../../lib/backStack';
import { assistantInfo, companionItem, companionSnapshot, jsonResponse } from '../../../test/companionFixtures';
import { COMPANION_PANEL_WIDTH_KEY, CompanionPanelHost } from './CompanionPanel';

const mocks = vi.hoisted(() => ({ preempt: vi.fn(), settings: vi.fn() }));
vi.mock('./CompanionChatTab', async () => {
  const { useMetaChatRevealPage } = await import('../spaces/metaChat/metaChatRevealPage');
  return {
    // A card's View or a page link in the conversation gets the panel out of the page's way, when it is in the way.
    CompanionChatTab: function ChatStub() {
      const revealPage = useMetaChatRevealPage();
      return <div role="tabpanel" aria-label="Chat">Chat body{revealPage && <button type="button" onClick={revealPage}>View page</button>}</div>;
    },
  };
});
vi.mock('../spaces/AssistantHistory', () => ({
  AssistantHistory: () => <p>Recent conversations</p>,
}));
vi.mock('../../../state/chatStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/chatStore')>()),
  useChatActions: () => ({ revealBackendNode: vi.fn(async () => true) }),
  useStructuralSelector: (selector: (nodes: Record<string, never>) => unknown) => selector({}),
}));
vi.mock('../../../state/companion/companionPresence', () => ({ preemptCompanionTurn: mocks.preempt, noteCompanionComposing: vi.fn() }));

const snapshot = companionSnapshot({
  settings: { ...companionSnapshot().settings, displayName: 'Sidekick' },
  items: [companionItem('a', { title: 'CR-1 needs attention' }), companionItem('b', { title: 'Seen already', status: 'seen' })],
  counts: { needsYou: 2, newItems: 1, unreadMessages: 2 },
});
const ready = { status: 'ready' as const, info: assistantInfo() as never, error: null };
const running = (kind: CompanionRunDto['kind']): CompanionRunDto => ({ id: `run-${kind}`, kind, trigger: 't', outcome: 'running', detail: null, startedAt: 1, finishedAt: null });

const panel = () => document.querySelector<HTMLElement>('aside[data-companion-panel]');
const open = (options?: Parameters<typeof openCompanionPanel>[0]) => act(async () => { openCompanionPanel(options); });

beforeEach(() => {
  resetCompanionPanelForTests();
  resetCompanionStoreForTests({ snapshot, assistant: ready });
  resetAssistantComposerForTests();
  localStorage.removeItem(COMPANION_PANEL_WIDTH_KEY);
  mocks.preempt.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ catchUp: null })));
});

afterEach(() => {
  resetCompanionStoreForTests();
  vi.unstubAllGlobals();
});

describe('the panel (DESIGN-v2 §1)', () => {
  it('shows nothing while closed, or when this backend has no assistant', async () => {
    const view = render(<CompanionPanelHost narrow={false} />);
    expect(panel()).toBeNull();
    act(() => resetCompanionStoreForTests({ snapshot, assistant: { status: 'unsupported', info: null, error: null } }));
    await open();
    view.rerender(<CompanionPanelHost narrow={false} />);
    expect(panel()).toBeNull();
  });

  it('is the one panel: both data attributes on its root, named by the agent', async () => {
    render(<CompanionPanelHost narrow={false} />);
    await open();
    expect(panel()!.hasAttribute('data-assistant-panel')).toBe(true);
    expect(panel()!.getAttribute('aria-label')).toBe('Sidekick');
  });

  it('opens Chat with only /assistant: Today says it is not available without a snapshot', async () => {
    resetCompanionStoreForTests({ assistant: ready });
    render(<CompanionPanelHost narrow={false} />);
    await open({ tab: 'chat' });
    expect(screen.getByRole('tabpanel', { name: 'Chat' }).textContent).toBe('Chat body');
    fireEvent.click(screen.getByRole('tab', { name: /Today/ }));
    expect(screen.getByRole('status').textContent).toBe('Today isn’t available right now.');
  });

  it('opens with the name, the shared status line, and counts on its tabs', async () => {
    render(<CompanionPanelHost narrow={false} />);
    await open({ tab: 'today' });
    expect(screen.getByText('Sidekick')).toBeTruthy();
    expect(screen.getByText('Watching · not checked yet')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Today/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('1 need you')).toBeTruthy();
    act(() => updateCompanionSnapshot((current) => ({ ...current, counts: { ...current.counts, unreadMessages: 1 } })));
    expect(screen.getByLabelText('1 new')).toBeTruthy();
    expect(screen.getByRole('tabpanel', { name: 'Today' }).textContent).toContain('CR-1 needs attention');
  });

  it('says "Checking in…" with Stop for a check-in, and "Saying hello…" without Stop for the welcome (F4)', async () => {
    resetCompanionStoreForTests({ assistant: ready, snapshot: companionSnapshot({ status: { ...snapshot.status, working: true }, activity: [running('heartbeat')] }) });
    const view = render(<CompanionPanelHost narrow={false} />);
    await open();
    expect(screen.getByRole('status').textContent).toContain('Checking in…');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(mocks.preempt).toHaveBeenCalled();
    view.unmount();
    resetCompanionStoreForTests({ assistant: ready, snapshot: companionSnapshot({ status: { ...snapshot.status, working: true }, activity: [running('welcome')] }) });
    render(<CompanionPanelHost narrow={false} />);
    expect(screen.getByRole('status').textContent).toBe('Saying hello…');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('starts a new conversation from its menu, following the new V', async () => {
    const next = assistantInfo('v-next');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/assistant/reset') ? jsonResponse(next) : jsonResponse({ catchUp: null }))));
    render(<CompanionPanelHost narrow={false} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Sidekick menu' }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'New conversation' })); });
    await waitFor(() => expect(getCompanionAssistant().info?.nodeId).toBe('v-next'));
    fireEvent.click(screen.getByRole('button', { name: 'Sidekick menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History…' }));
    expect(screen.getByRole('dialog', { name: 'History' }).textContent).toContain('Recent conversations');
  });

  it('counts V as in view only while the panel shows its Chat', async () => {
    render(<CompanionPanelHost narrow={false} />);
    await open({ tab: 'chat' });
    expect(isCompanionPanelShowing('companion-node')).toBe(true);
    expect(isCompanionPanelShowing('other')).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: /Today/ }));
    expect(isCompanionPanelShowing('companion-node')).toBe(false);
  });

  it('closes on Escape and gives focus back to where it was before it opened', async () => {
    render(<><button type="button">On the page</button><button type="button" data-companion-button="">Michi</button><CompanionPanelHost narrow={false} /></>);
    screen.getByRole('button', { name: 'On the page' }).focus();
    await open();
    const tab = screen.getByRole('tab', { name: /Today/ });
    tab.focus();
    fireEvent.keyDown(tab, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'On the page' }));
  });

  it('Today’s Ask attaches the item and drafts only “Tell me more about this.”', async () => {
    render(<CompanionPanelHost narrow={false} />);
    await open({ tab: 'today' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask about: CR-1 needs attention' })[0]);
    expect(getCompanionPanelState().tab).toBe('chat');
    // The Chat tab takes the request; it is queued with the item as a chip and the bare prompt.
    const { takeCompanionRequests } = await import('../../../state/companion/companionPanel');
    expect(takeCompanionRequests()).toEqual([{ draft: 'Tell me more about this.', attachments: [{ kind: 'companion_item', id: 'a', title: 'CR-1 needs attention' }] }]);
    expect(getAssistantComposer('companion-node').injected).toBeNull();
  });

  it('opens with a page helper’s draft in any area, the block as its target', async () => {
    render(<CompanionPanelHost narrow={false} />);
    act(() => dispatchPageHelperDraft({
      backendConnectionId: 'local', workspaceId: 'ws1', pageId: 'p1', text: 'Add a column',
      blockContext: { blockId: 'b1', title: 'Tasks', content: 'rows' },
    }));
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat', target: { pageId: 'p1', blockId: 'b1', title: 'Tasks' } });
  });

  it('keeps its width between 360 and 720 pixels, and remembers it', async () => {
    localStorage.setItem(COMPANION_PANEL_WIDTH_KEY, '2000');
    render(<CompanionPanelHost narrow={false} />);
    await open();
    expect(panel()!.style.getPropertyValue('--companion-panel-width')).toBe('720px');
    const handle = screen.getByRole('button', { name: 'Resize the Sidekick panel' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panel()!.style.getPropertyValue('--companion-panel-width')).toBe('696px');
    expect(localStorage.getItem(COMPANION_PANEL_WIDTH_KEY)).toBe('696');
  });

  it('goes back to its default width on a double-click on its edge', async () => {
    localStorage.setItem(COMPANION_PANEL_WIDTH_KEY, '600');
    render(<CompanionPanelHost narrow={false} />);
    await open();
    expect(panel()!.style.getPropertyValue('--companion-panel-width')).toBe('600px');
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Resize the Sidekick panel' }));
    expect(panel()!.style.getPropertyValue('--companion-panel-width')).toBe('420px');
    expect(localStorage.getItem(COMPANION_PANEL_WIDTH_KEY)).toBeNull();
  });

  it('shows over the page in a narrow window, without a resize handle', async () => {
    render(<CompanionPanelHost narrow />);
    await open();
    expect(panel()!.getAttribute('data-layout')).toBe('overlay');
    expect(screen.queryByRole('button', { name: /Resize/ })).toBeNull();
  });

  it('closes on Back over a narrow window, History first; docked beside the page it is no layer of Back', async () => {
    const view = render(<CompanionPanelHost narrow={false} />);
    await open({ history: true });
    expect(hasBackLayer()).toBe(false);
    view.rerender(<CompanionPanelHost narrow />);
    expect(hasBackLayer()).toBe(true);
    expect(screen.getByRole('dialog', { name: 'History' })).toBeTruthy();
    act(() => backTarget()?.back());
    expect(screen.queryByRole('dialog', { name: 'History' })).toBeNull();
    expect(panel()).not.toBeNull();
    act(() => backTarget()?.back());
    expect(panel()).toBeNull();
    expect(getCompanionPanelState().open).toBe(false);
    expect(hasBackLayer()).toBe(false);
  });

  it('closes over a narrow window when something in it opens a page; docked, it stays (F1a-review #6)', async () => {
    const view = render(<CompanionPanelHost narrow={false} />);
    await open({ tab: 'chat' });
    expect(screen.queryByRole('button', { name: 'View page' })).toBeNull();
    view.rerender(<CompanionPanelHost narrow />);
    fireEvent.click(screen.getByRole('button', { name: 'View page' }));
    expect(panel()).toBeNull();
  });

  it('moves focus into its menu, and closes it on Escape or a press outside (F1a-review #15)', async () => {
    render(<CompanionPanelHost narrow={false} />);
    await open();
    const more = screen.getByRole('button', { name: 'Sidekick menu' });
    fireEvent.click(more);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'New conversation' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('tab', { name: /Today/ }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('lets a block target go when the shell shows another area, panel open or not (F1a-review #9)', async () => {
    const view = render(<CompanionPanelHost narrow={false} page="space" />);
    act(() => setCompanionTarget({ pageId: 'p1', blockId: 'b1' }));
    view.rerender(<CompanionPanelHost narrow={false} page="space" />);
    expect(getCompanionPanelState().target).not.toBeNull();
    view.rerender(<CompanionPanelHost narrow={false} page="scheduled" />);
    expect(getCompanionPanelState().target).toBeNull();
  });

  it('opens History when asked to (Settings › Conversation › History)', async () => {
    render(<CompanionPanelHost narrow={false} />);
    await open({ history: true });
    expect(screen.getByRole('dialog', { name: 'History' }).textContent).toContain('Recent conversations');
    fireEvent.click(screen.getByRole('button', { name: 'Close history' }));
    expect(screen.queryByRole('dialog', { name: 'History' })).toBeNull();
  });

  it('drafts a brief card’s action as a reply to the post of the run that wrote the brief (D9)', async () => {
    resetCompanionStoreForTests({
      assistant: ready,
      snapshot: {
        ...snapshot,
        brief: {
          id: 'brief-1', date: '2026-11-06', headline: 'A quiet day', closing: 'That’s all.', origin: 'llm', createdAt: 150, cardFeedback: {},
          cards: [{ title: 'Launch', body: 'Due Friday', itemIds: [], action: { label: 'Draft the note', prompt: 'Draft the launch note' } }],
        },
        activity: [
          { id: 'r-old', kind: 'heartbeat', trigger: 't', outcome: 'quiet', detail: null, startedAt: 10, finishedAt: 20 },
          { id: 'r-brief', kind: 'brief', trigger: 't', outcome: 'spoke', detail: null, startedAt: 100, finishedAt: 200, postedMessageId: 'cmp-post-r-brief' },
        ],
      },
    });
    render(<CompanionPanelHost narrow={false} />);
    await open({ tab: 'today' });
    fireEvent.click(screen.getByRole('button', { name: 'Draft the note' }));
    const { takeCompanionRequests } = await import('../../../state/companion/companionPanel');
    expect(takeCompanionRequests()).toEqual([{ draft: 'Draft the launch note', replyToPost: 'cmp-post-r-brief' }]);
  });

  it('keeps what it last showed when the backend cannot be reached', async () => {
    resetCompanionStoreForTests({ snapshot, stale: true, assistant: ready });
    render(<CompanionPanelHost narrow={false} />);
    await open({ tab: 'today' });
    expect(screen.getByText('Can’t reach Sidekick right now — this is what it last showed.')).toBeTruthy();
    expect(screen.getByText('CR-1 needs attention')).toBeTruthy();
  });
});
