/**
 * The names Topbar gives panes: captions and the phone title use the same
 * fallbacks as tabs and the switcher (paneTitle), and the phone title names
 * the focused pane even before it has a title.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import TerminalTopbar from './Topbar';
import { ChatNodeStoreContext } from '../../state/chatStore';
import type { ChatNodeState } from '../../state/chatTypes';
import { PrefsProvider } from '../../state/prefs';

const H = vi.hoisted(() => ({ phone: false, openPanes: ['a', 'b'], focusedPane: 'b' }));

vi.mock('../../hooks/usePhoneLayout', () => ({ usePhoneLayout: () => H.phone }));
vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../state/chatStore')>('../../state/chatStore');
  const project = {
    id: 'ws', name: 'WS', chatIds: ['a', 'b'], createdAt: 0, activeTreeId: 't1',
    trees: [{ id: 't1', rootNodeId: 'a', createdAt: 0 }], edges: [{ source: 'a', target: 'b', kind: 'branch' }],
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
  return { nodeId, kind: 'chat', chatId: null, projectId: 'ws', title: '', messages: [], followUps: [], status: 'idle', ...patch } as ChatNodeState;
}

function mount(nodes: Record<string, ChatNodeState>) {
  const store = {
    getNode: (id: string) => nodes[id],
    getNodes: () => nodes,
    subscribeNode: () => () => {},
    subscribe: () => () => {},
    getStructureVersion: () => 0,
    subscribeStructure: () => () => {},
  };
  return render(
    <PrefsProvider>
      <ChatNodeStoreContext.Provider value={store}>
        <TerminalTopbar page="dashboard" onNav={() => {}} sidebarCollapsed={false} onToggleSidebar={() => {}}
          navigation={{ canBack: false, canForward: false, onBack: () => {}, onForward: () => {} }} />
      </ChatNodeStoreContext.Provider>
    </PrefsProvider>,
  );
}

const nodes = {
  a: chat('a', { title: 'Fix login' }),
  // A branch just made: no title until its first reply.
  b: chat('b'),
};

describe('Topbar pane names', () => {
  beforeEach(() => { H.phone = false; });

  it("titles the phone screen with the focused branch's own name, not another pane's", () => {
    H.phone = true;
    const { container } = mount(nodes);
    expect(container.querySelector('.mobile-pane-title')?.textContent).toBe('New thread');
  });

  it('names an untitled chat by its first message in its caption, as its tab does', () => {
    const { container } = mount({
      ...nodes,
      b: chat('b', { messages: [{ id: 'u', role: 'user', text: 'Why does the build fail?', toolCalls: [] }] }),
    });
    expect(container.querySelector('[data-pane-caption-id="b"]')?.textContent).toContain('Why does the build fail?');
  });
});
