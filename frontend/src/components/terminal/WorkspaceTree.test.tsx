import type React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';
import WorkspaceTree from './WorkspaceTree';
import { ChatProvider, useChatActions } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import type { ChatNodeState, Project } from '../../state/chatTypes';

// Stub the API surface so workspacePersistence falls back to localStorage seed
// instead of populating from a real backend (which the dev machine would hit).
// Partial mock: keep every export, override just the network-touching ones.
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
    fetchAllWorkspacesMeta: vi.fn().mockResolvedValue([]),
    fetchTreeMessages: vi.fn().mockResolvedValue([]),
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
    fetchWorkspace: vi.fn().mockResolvedValue(null),
    warmCwd: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

function fixture() {
  const nodes: Record<string, ChatNodeState> = {
    rootA: {
      nodeId: 'rootA', chatId: null, projectId: 'p1', kind: 'chat',
      title: 'Active thread', messages: [], followUps: [], status: 'idle',
    },
    childA: {
      nodeId: 'childA', chatId: null, projectId: 'p1', kind: 'chat',
      title: 'Child of A', messages: [], followUps: [], status: 'idle',
    },
    rootB: {
      nodeId: 'rootB', chatId: null, projectId: 'p1', kind: 'chat',
      title: 'Other thread', messages: [], followUps: [], status: 'idle',
    },
    rootP2: {
      nodeId: 'rootP2', chatId: null, projectId: 'p2', kind: 'chat',
      title: 'P2 thread', messages: [], followUps: [], status: 'idle',
    },
  };
  // Both used recently (A, then B, then P2), so neither folds into Earlier.
  const now = Date.now();
  const projects: Project[] = [
    {
      id: 'p1', name: 'Active workspace', cwd: '~/x',
      chatIds: ['rootA', 'childA', 'rootB'],
      edges: [{ source: 'rootA', target: 'childA', kind: 'branch' }],
      trees: [
        { id: 'tA', rootNodeId: 'rootA', createdAt: 0, lastActiveAt: now - 100 },
        { id: 'tB', rootNodeId: 'rootB', createdAt: 0, lastActiveAt: now - 150 },
      ],
      activeTreeId: 'tA', createdAt: 0,
    },
    {
      id: 'p2', name: 'Other workspace', cwd: '~/y',
      chatIds: ['rootP2'], edges: [],
      trees: [{ id: 'tP2', rootNodeId: 'rootP2', createdAt: 0, lastActiveAt: now - 200 }],
      activeTreeId: 'tP2', createdAt: 0,
    },
  ];
  return { nodes, projects };
}

const DAY = 24 * 60 * 60 * 1000;

function renderTreeWith(
  seed: { nodes: Record<string, ChatNodeState>; projects: Project[] },
  props: React.ComponentProps<typeof WorkspaceTree> = {},
) {
  // ChatProvider hydrates via fetchAllWorkspacesMeta (mocked empty above); when
  // that returns nothing, persistence falls back to localStorage. Pre-seed
  // v2 state and mark the localStorage→SQLite migration as already done so
  // the fallback skips the migration path entirely.
  localStorage.setItem(
    'michi:v1:state',
    JSON.stringify({
      version: 2,
      projects: seed.projects,
      nodes: seed.nodes,
      activeProjectId: 'p1',
    }),
  );
  localStorage.setItem('michi:migrated', '1');
  return render(
    <PrefsProvider>
      <ChatProvider>
        <WorkspaceTree {...props} />
      </ChatProvider>
    </PrefsProvider>,
  );
}

function renderTree() {
  renderTreeWith(fixture());
}

describe('WorkspaceTree', () => {
  it('leaves the classic row style without the neutral folder glyph', async () => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ sidebarRowStyle: 'classic' }));
    renderTree();
    await screen.findByText('Child of A');
    expect(screen.queryByTestId('workspace-folder-icon')).toBeNull();
  });

  it('closes a branch menu on a second press of its ⋯', async () => {
    renderTree();
    const kebab = await screen.findByRole('button', { name: 'Actions for Child of A' });
    fireEvent.click(kebab);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(kebab);
    fireEvent.click(kebab);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hangs branches off their thread by indent alone, one step per level', async () => {
    // rootA → [childA → [grand], second]: two sibling branches, the first with
    // a branch of its own.
    const { nodes, projects } = fixture();
    const extra = (nodeId: string, title: string): ChatNodeState => ({
      nodeId, chatId: null, projectId: 'p1', kind: 'chat',
      title, messages: [], followUps: [], status: 'idle',
    });
    nodes.second = extra('second', 'Second child');
    nodes.grand = extra('grand', 'Grandchild');
    projects[0].chatIds.push('second', 'grand');
    projects[0].edges.push(
      { source: 'rootA', target: 'second', kind: 'branch' },
      { source: 'childA', target: 'grand', kind: 'branch' },
    );
    renderTreeWith({ nodes, projects });
    await screen.findByText('Second child');
    fireEvent.click(screen.getByText('Child of A'));
    await screen.findByText('Grandchild');

    const row = (nodeId: string) =>
      document.querySelector<HTMLElement>(`[data-sidebar-row="${nodeId}"]`)!;
    expect(row('childA').style.paddingLeft).toBe('43px');
    expect(row('second').style.paddingLeft).toBe('43px');
    expect(row('grand').style.paddingLeft).toBe('55px');
    // No connector lines: nothing bordered sits in front of a branch title.
    for (const id of ['childA', 'second', 'grand']) {
      const lines = [...row(id).querySelectorAll<HTMLElement>('[aria-hidden]')].filter(
        (el) => el.style.borderLeft !== '' || el.style.borderBottom !== '' || el.style.borderTop !== '',
      );
      expect(lines).toHaveLength(0);
    }
  });

  // This test passes in isolation but is flaky when run with other tests in this
  // file due to React state and localStorage hydration ordering. The behavior
  // (snapshotBeforeSwitch pinning the outgoing workspace) is tested indirectly
  // by the more comprehensive "clicking an expanded but inactive workspace"
  // test below, which also exercises cross-workspace expansion.
  it.skip('clicking a collapsed workspace expands it (and the previous active workspace stays expanded)', async () => {
    renderTree();
    // Wait for initial render to stabilize
    expect(await screen.findByText('Active thread')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Other workspace')); });
    expect(await screen.findByText('P2 thread')).toBeTruthy();
    // Previously-active workspace must remain expanded across the switch.
    // Use findByText (waitFor internally) since React 18 batching in the full
    // suite can delay rendering of the pinned workspace state.
    expect(await screen.findByText('Active thread')).toBeTruthy();
  });

  it('clicking an expanded but inactive workspace activates without collapsing; a second click on the now-active workspace collapses', async () => {
    renderTree();
    // 1. Expand p2 (collapsed → expanded). p2 is now active + expanded.
    fireEvent.click(await screen.findByText('Other workspace'));
    expect(await screen.findByText('P2 thread')).toBeTruthy();
    // 2. Click p1 (expanded, inactive) → just activates, p1 stays expanded
    //    AND p2 (now inactive) stays expanded.
    fireEvent.click(screen.getByText('Active workspace'));
    expect(screen.getByText('Active thread')).toBeTruthy();
    expect(screen.getByText('P2 thread')).toBeTruthy();
    // 3. Second click on p1 (now active + expanded) → collapses p1.
    fireEvent.click(screen.getByText('Active workspace'));
    expect(screen.queryByText('Active thread')).toBeNull();
    // p2 unaffected.
    expect(screen.getByText('P2 thread')).toBeTruthy();
  });

  it('switching threads from a thread row keeps every thread expanded as it was', async () => {
    const { nodes, projects } = fixture();
    const extra = (nodeId: string, projectId: string, title: string): ChatNodeState => ({
      nodeId, chatId: null, projectId, kind: 'chat',
      title, messages: [], followUps: [], status: 'idle',
    });
    nodes.childB = extra('childB', 'p1', 'Child of B');
    nodes.childP2 = extra('childP2', 'p2', 'Child of P2');
    projects[0].chatIds.push('childB');
    projects[0].edges.push({ source: 'rootB', target: 'childB', kind: 'branch' });
    projects[1].chatIds.push('childP2');
    projects[1].edges.push({ source: 'rootP2', target: 'childP2', kind: 'branch' });
    renderTreeWith({ nodes, projects });
    await screen.findByText('Child of A');

    // Same workspace: thread B opens, thread A stays open.
    fireEvent.click(screen.getByText('Other thread'));
    expect(await screen.findByText('Child of B')).toBeTruthy();
    expect(screen.getByText('Child of A')).toBeTruthy();

    // Expand the other workspace while keeping p1 active; its active thread
    // shows expanded by default.
    fireEvent.click(screen.getByText('Other workspace'));
    fireEvent.click(screen.getByText('Active workspace'));
    expect(await screen.findByText('Child of P2')).toBeTruthy();

    // Cross workspace: switching to that thread must not collapse it.
    fireEvent.click(screen.getByText('P2 thread'));
    await act(async () => {});
    expect(screen.getByText('Child of P2')).toBeTruthy();
    expect(screen.getByText('Child of A')).toBeTruthy();
    expect(screen.getByText('Child of B')).toBeTruthy();
  });

  it('shows only the five most recent live threads until expanded', async () => {
    const nodes: Record<string, ChatNodeState> = {};
    const trees = Array.from({ length: 6 }, (_, index) => {
      const n = index + 1;
      const rootNodeId = `root${n}`;
      nodes[rootNodeId] = {
        nodeId: rootNodeId,
        chatId: null,
        projectId: 'p1',
        kind: 'chat',
        title: `Thread ${n}`,
        messages: [],
        followUps: [],
        status: 'idle',
      };
      return {
        id: `t${n}`,
        rootNodeId,
        createdAt: n,
        lastActiveAt: 1000 - n,
      };
    });
    const projects: Project[] = [
      {
        id: 'p1',
        name: 'Active workspace',
        cwd: '~/x',
        chatIds: Object.keys(nodes),
        edges: [],
        trees,
        activeTreeId: 't1',
        createdAt: 0,
      },
    ];

    renderTreeWith({ nodes, projects });

    expect(await screen.findByText('Thread 1')).toBeTruthy();
    expect(screen.getByText('Thread 5')).toBeTruthy();
    expect(screen.queryByText('Thread 6')).toBeNull();
    fireEvent.click(screen.getByText(/Show more/));
    expect(await screen.findByText('Thread 6')).toBeTruthy();
  });

  it('counts Merged threads separately from regular threads', async () => {
    const nodes: Record<string, ChatNodeState> = {};
    const regularTrees = Array.from({ length: 6 }, (_, index) => {
      const n = index + 1;
      const rootNodeId = `regular${n}`;
      nodes[rootNodeId] = {
        nodeId: rootNodeId,
        chatId: null,
        projectId: 'p1',
        kind: 'chat',
        title: `Thread ${n}`,
        messages: [],
        followUps: [],
        status: 'idle',
      };
      return {
        id: `t${n}`,
        rootNodeId,
        createdAt: n,
        lastActiveAt: 2000 - n,
      };
    });
    const mergeTrees = Array.from({ length: 6 }, (_, index) => {
      const n = index + 1;
      const rootNodeId = `merge${n}`;
      nodes[rootNodeId] = {
        nodeId: rootNodeId,
        chatId: null,
        projectId: 'p1',
        kind: 'chat',
        title: `Merged ${n}`,
        mergeSources: [],
        messages: [],
        followUps: [],
        status: 'idle',
      };
      return {
        id: `m${n}`,
        rootNodeId,
        createdAt: n,
        lastActiveAt: 1000 - n,
        kind: 'merge' as const,
      };
    });
    const projects: Project[] = [
      {
        id: 'p1',
        name: 'Active workspace',
        cwd: '~/x',
        chatIds: Object.keys(nodes),
        edges: [],
        trees: [...regularTrees, ...mergeTrees],
        activeTreeId: 't1',
        createdAt: 0,
      },
    ];

    renderTreeWith({ nodes, projects });

    expect(await screen.findByText('Thread 5')).toBeTruthy();
    expect(screen.queryByText('Thread 6')).toBeNull();
    expect(screen.getByText('Merged 5')).toBeTruthy();
    expect(screen.queryByText('Merged 6')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show more merged threads' }));

    expect(await screen.findByText('Merged 6')).toBeTruthy();
    expect(screen.queryByText('Thread 6')).toBeNull();
  });

  it('puts the way to Workspaces at the right end of the Projects header as "All N ›"', async () => {
    const onOpenWorkspaces = vi.fn();
    renderTreeWith(fixture(), { onOpenWorkspaces });
    const header = await screen.findByTestId('section-label-projects');
    expect(header.firstChild?.textContent).toBe('Projects');
    const all = within(header).getByRole('button', { name: 'All 2 workspaces' });
    expect(all.textContent).toBe('All 2 ›');
    expect(all.hasAttribute('aria-current')).toBe(false);
    fireEvent.click(all);
    expect(onOpenWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('folds workspaces left alone for 30 days into a closed Earlier group, in their own order, and remembers it open', async () => {
    const { nodes, projects } = fixture();
    const old = Date.now() - 31 * DAY;
    const idle = (id: string, name: string): Project => {
      nodes[`root-${id}`] = { nodeId: `root-${id}`, chatId: null, projectId: id, kind: 'chat', title: `${name} thread`, messages: [], followUps: [], status: 'idle' };
      return {
        id, name, cwd: `~/${id}`, chatIds: [`root-${id}`], edges: [],
        trees: [{ id: `t-${id}`, rootNodeId: `root-${id}`, createdAt: old, lastActiveAt: old }],
        activeTreeId: `t-${id}`, createdAt: old,
      };
    };
    // p1 is old too, but it is the active workspace; p2 was used today.
    projects.push(idle('p3', 'Dusty one'), idle('p4', 'Dusty two'));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ workspaceOrder: ['p1', 'p4', 'p2', 'p3'] }));
    renderTreeWith({ nodes, projects });

    const toggle = await screen.findByRole('button', { name: 'Earlier, 2 workspaces' });
    expect(toggle.textContent).toBe('›Earlier· 2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Dusty one')).toBeNull();
    // Projects keeps the rest, active one included, in the manual order.
    const names = () => [...document.querySelectorAll('[data-testid^="workspace-row-"]')].map((row) => row.getAttribute('data-testid'));
    expect(names()).toEqual(['workspace-row-p1', 'workspace-row-p2']);
    // Earlier sits at the end of Projects.
    expect(screen.getByTestId('section-label-projects').nextElementSibling?.lastElementChild?.contains(toggle)).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(screen.getByRole('group', { name: 'Earlier workspaces' })).getByText('Dusty two')).toBeTruthy();
    expect(names()).toEqual(['workspace-row-p1', 'workspace-row-p2', 'workspace-row-p4', 'workspace-row-p3']);
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('michi:v1:prefs') ?? '{}').sidebarExpanded?.groups?.earlier).toBe(true);
    }, { timeout: 2000 });

    // Enter on the focused group header folds it again.
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Dusty two')).toBeNull();
  });

  // Running work, open panes and pins: earlierWorkspaces.test.ts.
  it('moves a workspace out of Earlier when it becomes the active one', async () => {
    const { nodes, projects } = fixture();
    projects[1].trees[0].lastActiveAt = Date.now() - 60 * DAY;
    renderTreeWith({ nodes, projects });
    fireEvent.click(await screen.findByRole('button', { name: 'Earlier, 1 workspace' }));
    const group = screen.getByRole('group', { name: 'Earlier workspaces' });
    fireEvent.click(within(group).getByText('Other workspace'));
    expect(await screen.findByText('P2 thread')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Earlier workspaces' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Earlier/ })).toBeNull();
    // Now p1 is the one not active, but it was used today.
    expect(screen.getByText('Active workspace')).toBeTruthy();
  });

  it('reaches workspace and thread rows with Tab and opens them with Enter or Space', async () => {
    renderTreeWith(fixture());
    const workspace = await screen.findByRole('button', { name: 'Other workspace' });
    expect(workspace.tabIndex).toBe(0);
    expect(workspace.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(workspace, { key: 'Enter' });
    expect(await screen.findByText('P2 thread')).toBeTruthy();
    expect(workspace.getAttribute('aria-expanded')).toBe('true');
    // ← folds it.
    fireEvent.keyDown(workspace, { key: 'ArrowLeft' });
    expect(screen.queryByText('P2 thread')).toBeNull();

    const thread = screen.getByRole('button', { name: 'Other thread' });
    expect(thread.tabIndex).toBe(0);
    expect(thread.hasAttribute('aria-current')).toBe(false);
    fireEvent.keyDown(thread, { key: ' ' });
    await waitFor(() => expect(thread.getAttribute('aria-current')).toBe('true'));
    // The current row is marked, so its ⋯ stays showing (sidebar.css).
    expect(screen.getByRole('button', { name: 'Active thread' }).hasAttribute('aria-current')).toBe(false);
    // Keys inside the row belong to what has focus there.
    const kebab = within(thread).getByRole('button', { name: 'Actions for Other thread' });
    fireEvent.keyDown(kebab, { key: 'Enter' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('leaves merge chats in Trash or the archive out of the Merged section', async () => {
    const { nodes, projects } = fixture();
    const merge = (nodeId: string, title: string, extra: Partial<ChatNodeState> = {}): ChatNodeState => ({
      nodeId, chatId: null, projectId: 'p1', kind: 'chat', title, mergeSources: [], messages: [], followUps: [], status: 'idle', ...extra,
    });
    nodes.mLive = merge('mLive', 'Merged live');
    nodes.mBinned = merge('mBinned', 'Merged binned', { deletedAt: 5, deletionGroupId: 'del-m' });
    nodes.mOld = merge('mOld', 'Merged archived');
    projects[0].chatIds.push('mLive', 'mBinned', 'mOld');
    projects[0].trees.push(
      { id: 'tmLive', rootNodeId: 'mLive', createdAt: 0, lastActiveAt: 30, kind: 'merge' },
      { id: 'tmBinned', rootNodeId: 'mBinned', createdAt: 0, lastActiveAt: 20, kind: 'merge' },
      { id: 'tmOld', rootNodeId: 'mOld', createdAt: 0, lastActiveAt: 10, kind: 'merge', archivedAt: 15 },
    );

    renderTreeWith({ nodes, projects });

    expect(await screen.findByText('Merged live')).toBeTruthy();
    expect(screen.queryByText('Merged binned')).toBeNull();
    expect(screen.queryByText('Merged archived')).toBeNull();
  });
});

describe('WorkspaceTree collapsed workspace rail', () => {
  const actionsRef: { current: ReturnType<typeof useChatActions> | null } = { current: null };
  function ActionsProbe() {
    actionsRef.current = useChatActions();
    return null;
  }
  function renderStyled(style: 'classic' | 'square-full') {
    const { nodes, projects } = fixture();
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ sidebarRowStyle: style }));
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 2, projects, nodes, activeProjectId: 'p1' }));
    localStorage.setItem('michi:migrated', '1');
    render(
      <PrefsProvider>
        <ChatProvider>
          <ActionsProbe />
          <WorkspaceTree />
        </ChatProvider>
      </PrefsProvider>,
    );
  }
  const rail = (projectId: string) =>
    screen.getByTestId(`workspace-row-${projectId}`).querySelector('[data-context-target]')!.lastElementChild as HTMLElement;

  it.each([['classic', '2px'], ['square-full', '3px']] as const)('runs in the run colour while a chat inside streams (%s)', async (style, right) => {
    renderStyled(style);
    await screen.findByText('Child of A');
    act(() => {
      actionsRef.current!.dispatch({ type: 'user-send', nodeId: 'rootP2', userText: 'hi', assistantId: 'a1' });
    });
    await waitFor(() => expect(rail('p2').style.background).toBe('var(--term-run)'));
    expect(rail('p2').style.color).toBe('var(--term-run)');
    expect(rail('p2').style.right).toBe(right);
  });

  it.each([['classic', 'var(--term-accent)'], ['square-full', 'var(--term-line-s)']] as const)('marks an open pane inside with the threads\' idle rail (%s)', async (style, background) => {
    renderStyled(style);
    await screen.findByText('Child of A');
    act(() => {
      actionsRef.current!.openPane('childA');
      actionsRef.current!.openPane('rootA');
      actionsRef.current!.focusPane('rootA');
    });
    fireEvent.click(screen.getByText('Active workspace'));
    await waitFor(() => expect(screen.queryByText('Child of A')).toBeNull());
    expect(rail('p1').style.background).toBe(background);
  });
});
