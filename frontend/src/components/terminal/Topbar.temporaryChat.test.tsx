/**
 * The topbar's temporary-chat switch and marks: the ghost shows only on Home
 * (the Home page, or a dashboard with no pane open), turns Home's switch on
 * and off, and leaving Home turns it off. A temporary chat's caption and a
 * phone's title carry the ghost; a regular chat's don't.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalTopbar from './Topbar';
import { ChatNodeStoreContext } from '../../state/chatStore';
import type { ChatNodeState } from '../../state/chatTypes';
import type { PageId } from '../../state/commands';
import { PrefsProvider } from '../../state/prefs';
import { resetTemporaryChatDraft, setTemporaryChatDraft, useTemporaryChatDraft } from '../../state/temporaryChatDraft';

const H = vi.hoisted(() => ({ phone: false, openPanes: [] as string[], focusedPane: null as string | null }));

vi.mock('../../hooks/usePhoneLayout', () => ({ usePhoneLayout: () => H.phone }));
vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../state/chatStore')>('../../state/chatStore');
  const project = {
    id: 'ws', name: 'WS', chatIds: ['temp', 'plain'], createdAt: 0, activeTreeId: 't1',
    trees: [{ id: 't1', rootNodeId: 'temp', createdAt: 0 }], edges: [],
  };
  const noop = () => {};
  return {
    ...actual,
    useChatProjects: () => ({ activeProject: project, projects: [project], focusedNodeId: H.focusedPane, canNavBack: false, canNavForward: false }),
    useChatPanes: () => ({ openPanes: H.openPanes, focusedPane: H.focusedPane, paneItems: {} }),
    useChatActions: () => ({ focusPane: noop, closePane: noop, reorderPane: noop, setPaneWidth: noop, navBack: noop, navForward: noop }),
  };
});
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, checkVersion: vi.fn().mockResolvedValue({ updateAvailable: false }), triggerUpdate: vi.fn() };
});
vi.mock('../../lib/electronBridge', () => ({ getElectron: () => null }));

function chat(nodeId: string, patch: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, kind: 'chat', chatId: nodeId, projectId: 'ws', title: nodeId, messages: [], followUps: [], status: 'idle', ...patch } as ChatNodeState;
}

const NODES: Record<string, ChatNodeState> = {
  temp: chat('temp', { title: 'Compare two job offers', temporary: true }),
  plain: chat('plain', { title: 'Repo setup' }),
};
const STORE = {
  getNode: (id: string) => NODES[id],
  getNodes: () => NODES,
  subscribeNode: () => () => {},
  subscribe: () => () => {},
  getStructureVersion: () => 0,
  subscribeStructure: () => () => {},
};

function topbar(page: PageId) {
  return (
    <PrefsProvider>
      <ChatNodeStoreContext.Provider value={STORE}>
        <TerminalTopbar page={page} onNav={() => {}} sidebarCollapsed={false} onToggleSidebar={() => {}}
          navigation={{ canBack: false, canForward: false, onBack: () => {}, onForward: () => {} }} />
      </ChatNodeStoreContext.Provider>
    </PrefsProvider>
  );
}

const ghostButton = () => screen.queryByRole('button', { name: /temporary chat/i });

beforeEach(() => {
  H.phone = false;
  H.openPanes = [];
  H.focusedPane = null;
  act(() => resetTemporaryChatDraft());
});

describe('the topbar’s temporary-chat switch', () => {
  it('shows on the Home page and on a dashboard showing Home, not beside a chat or on another page', () => {
    const view = render(topbar('home'));
    expect(ghostButton()?.getAttribute('aria-label')).toBe('Temporary chat');
    // The dashboard shows Home while no pane is open.
    view.rerender(topbar('dashboard'));
    expect(ghostButton()).not.toBeNull();
    H.openPanes = ['plain'];
    H.focusedPane = 'plain';
    view.rerender(topbar('dashboard'));
    expect(ghostButton()).toBeNull();
    H.openPanes = [];
    H.focusedPane = null;
    view.rerender(topbar('settings'));
    expect(ghostButton()).toBeNull();
  });

  it('turns Home’s switch on and off, and says which it does', () => {
    const draft = renderHook(() => useTemporaryChatDraft());
    render(topbar('home'));
    fireEvent.click(ghostButton()!);
    expect(draft.result.current).toBe(true);
    const on = screen.getByRole('button', { name: 'Turn off temporary chat' });
    expect(on.classList.contains('is-on')).toBe(true);
    fireEvent.click(on);
    expect(draft.result.current).toBe(false);
    expect(screen.getByRole('button', { name: 'Temporary chat' }).classList.contains('is-on')).toBe(false);
  });

  it('turns off once Home is left, so a later chat is not temporary by accident', () => {
    const draft = renderHook(() => useTemporaryChatDraft());
    const view = render(topbar('home'));
    fireEvent.click(ghostButton()!);
    expect(draft.result.current).toBe(true);
    // Home's chat opened in a pane.
    H.openPanes = ['plain'];
    H.focusedPane = 'plain';
    view.rerender(topbar('dashboard'));
    expect(draft.result.current).toBe(false);
    H.openPanes = [];
    H.focusedPane = null;
    view.rerender(topbar('home'));
    expect(screen.getByRole('button', { name: 'Temporary chat' })).toBeTruthy();
  });

  it('stays on when the palette turns it on beside a chat and then opens Home', () => {
    const draft = renderHook(() => useTemporaryChatDraft());
    H.openPanes = ['plain'];
    H.focusedPane = 'plain';
    const view = render(topbar('dashboard'));
    act(() => setTemporaryChatDraft(true));
    H.openPanes = [];
    H.focusedPane = null;
    view.rerender(topbar('home'));
    expect(draft.result.current).toBe(true);
    expect(screen.getByRole('button', { name: 'Turn off temporary chat' })).toBeTruthy();
  });
});

describe('a temporary chat’s marks in the topbar', () => {
  it('puts the ghost before a temporary chat’s caption title only', () => {
    H.openPanes = ['temp', 'plain'];
    H.focusedPane = 'temp';
    const { container } = render(topbar('dashboard'));
    const temp = container.querySelector('[data-pane-caption-id="temp"]')!;
    const plain = container.querySelector('[data-pane-caption-id="plain"]')!;
    expect(temp.querySelector('[data-temporary-chat-mark]')).not.toBeNull();
    expect(plain.querySelector('[data-temporary-chat-mark]')).toBeNull();
    expect(screen.getByLabelText('Compare two job offers pane, temporary chat, focused')).toBeTruthy();
    expect(screen.getByLabelText('Repo setup pane')).toBeTruthy();
  });

  it('puts the ghost before a phone’s title while a temporary chat is on screen', () => {
    H.phone = true;
    H.openPanes = ['temp', 'plain'];
    H.focusedPane = 'temp';
    const view = render(topbar('dashboard'));
    const title = () => view.container.querySelector('.mobile-pane-title')!;
    expect(title().textContent).toBe('Compare two job offers');
    expect(title().querySelector('[data-temporary-chat-mark]')).not.toBeNull();
    H.focusedPane = 'plain';
    view.rerender(topbar('dashboard'));
    expect(title().textContent).toBe('Repo setup');
    expect(title().querySelector('[data-temporary-chat-mark]')).toBeNull();
  });
});
