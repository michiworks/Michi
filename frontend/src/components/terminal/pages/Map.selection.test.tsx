import dagre from '@dagrejs/dagre';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalMap from './Map';

const createMergedChat = vi.hoisted(() => vi.fn(async () => 'merged'));
const clearSelection = vi.hoisted(() => vi.fn());
const deleteNode = vi.hoisted(() => vi.fn());
const archiveNode = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({
  project: null as any,
  nodes: {} as Record<string, any>,
  selection: new Set<string>(),
}));
const prefsState = vi.hoisted(() => ({ digestEnabled: true }));

vi.mock('../../../state/prefs', async () => {
  const actual = await vi.importActual<any>('../../../state/prefs');
  return { ...actual, useDigestEnabled: () => prefsState.digestEnabled };
});

vi.mock('../../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({
      activeProject: storeState.project,
      edges: storeState.project?.edges ?? [],
      openPane: vi.fn(),
      toggleSelection: vi.fn(),
      clearSelection,
      selection: storeState.selection,
      createBlankChild: vi.fn(),
      deleteNode,
      trimNode: vi.fn(),
      archiveNode,
      createMergedChat,
      createDigest: vi.fn(),
      archiveTree: vi.fn(),
      activateTree: vi.fn(),
    }),
    useChatNodesSnapshot: () => storeState.nodes,
    useStructuralSelector: (selector: (nodes: Record<string, any>) => unknown) => selector(storeState.nodes),
    chatLabel: (node: any) => node?.title ?? '',
    // Branches (doc view) reads these:
    useChatProjects: () => ({ activeProject: storeState.project }),
    useChatActions: () => ({ openPane: vi.fn() }),
    activeTreeRootNodeId: (project: any) => project?.trees?.[0]?.rootNodeId ?? null,
  };
});

function node(id: string, status: 'idle' | 'streaming' = 'idle') {
  return {
    nodeId: id,
    projectId: 'p1',
    kind: 'chat',
    title: `Node ${id}`,
    status,
    messages: [],
    followUps: [],
    createdAt: 0,
  };
}

function sameTreeProject() {
  return {
    id: 'p1',
    name: 'Workspace',
    chatIds: ['n1', 'n2'],
    edges: [{ source: 'n1', target: 'n2', kind: 'branch' }],
    createdAt: 0,
    trees: [{ id: 't1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 }],
    activeTreeId: 't1',
    artifacts: [],
  };
}

beforeEach(() => {
  createMergedChat.mockClear();
  clearSelection.mockClear();
  deleteNode.mockClear();
  archiveNode.mockClear();
  storeState.project = sameTreeProject();
  storeState.nodes = { n1: node('n1'), n2: node('n2') };
  storeState.selection = new Set(['n1', 'n2']);
  prefsState.digestEnabled = true;
});

describe('Map selection actions', () => {
  it('reuses the dagre layout when only labels or project metadata change', () => {
    const layout = vi.spyOn(dagre, 'layout');
    try {
      const view = render(<TerminalMap />);
      const initialCalls = layout.mock.calls.length;
      expect(initialCalls).toBeGreaterThan(0);

      storeState.project = { ...storeState.project, name: 'Renamed workspace' };
      storeState.nodes = {
        ...storeState.nodes,
        n1: { ...storeState.nodes.n1, title: 'Renamed node' },
      };
      view.rerender(<TerminalMap />);

      expect(layout).toHaveBeenCalledTimes(initialCalls);
    } finally {
      layout.mockRestore();
    }
  });

  it('recomputes dagre layout when branch topology changes', () => {
    const layout = vi.spyOn(dagre, 'layout');
    try {
      const view = render(<TerminalMap />);
      const initialCalls = layout.mock.calls.length;

      storeState.project = {
        ...storeState.project,
        chatIds: [...storeState.project.chatIds, 'n3'],
        edges: [...storeState.project.edges, { source: 'n2', target: 'n3', kind: 'branch' }],
      };
      storeState.nodes = { ...storeState.nodes, n3: node('n3') };
      view.rerender(<TerminalMap />);

      expect(layout.mock.calls.length).toBeGreaterThan(initialCalls);
    } finally {
      layout.mockRestore();
    }
  });

  it('exposes Merge, Digest, Export, and Clear and wires their existing flows', async () => {
    const onNav = vi.fn();
    const digestSpy = vi.fn();
    const exportSpy = vi.fn();
    window.addEventListener('michi:digest-prompt', digestSpy as EventListener);
    window.addEventListener('michi:toggle-export-panel', exportSpy as EventListener);
    try {
      render(<TerminalMap onNav={onNav} />);

      expect(screen.getByRole('toolbar', { name: 'Map selection actions' })).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
      expect(createMergedChat).toHaveBeenCalledWith(['n1', 'n2']);
      await waitFor(() => expect(onNav).toHaveBeenCalledWith('dashboard'));

      fireEvent.click(screen.getByRole('button', { name: 'Digest' }));
      expect(digestSpy).toHaveBeenCalledOnce();
      expect((digestSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({
        projectId: 'p1',
        sourceIds: ['n1', 'n2'],
      });

      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      expect(exportSpy).toHaveBeenCalledOnce();
      expect((exportSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({
        projectId: 'p1',
        nodeIds: ['n1', 'n2'],
      });

      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(clearSelection).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener('michi:digest-prompt', digestSpy as EventListener);
      window.removeEventListener('michi:toggle-export-panel', exportSpy as EventListener);
    }
  });

  it('ignores selected nodes from other threads', () => {
    storeState.project = {
      ...sameTreeProject(),
      edges: [],
      trees: [
        { id: 't1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 },
        { id: 't2', rootNodeId: 'n2', createdAt: 1, lastActiveAt: 1 },
      ],
    };

    const digestSpy = vi.fn();
    window.addEventListener('michi:digest-prompt', digestSpy as EventListener);
    render(<TerminalMap />);

    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Digest' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Node n2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Digest' }));
    expect((digestSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({
      projectId: 'p1',
      sourceIds: ['n1'],
    });
    window.removeEventListener('michi:digest-prompt', digestSpy as EventListener);
  });

  it('disables Merge and Digest while any selected node is streaming', () => {
    storeState.nodes.n2 = node('n2', 'streaming');

    render(<TerminalMap />);

    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Digest' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers no Digest action while Settings › Digest is off', () => {
    prefsState.digestEnabled = false;
    render(<TerminalMap />);
    expect(screen.getByRole('button', { name: 'Merge' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Export' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Digest' })).toBeNull();
  });
});

// Thread t1 (n1 -> n2) is on the Map; thread t2 (x -> x1) is not.
function twoThreadProject() {
  return {
    ...sameTreeProject(),
    chatIds: ['n1', 'n2', 'x', 'x1'],
    edges: [
      { source: 'n1', target: 'n2', kind: 'branch' },
      { source: 'x', target: 'x1', kind: 'branch' },
    ],
    trees: [
      { id: 't1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 },
      { id: 't2', rootNodeId: 'x', createdAt: 1, lastActiveAt: 1 },
    ],
  };
}

function openCardMenu(id: string) {
  fireEvent.contextMenu(document.querySelector(`div[data-map-node="${id}"][data-context-target]`)!, { clientX: 10, clientY: 10 });
}

const menuItem = (name: RegExp) => screen.getByRole('menuitem', { name });

describe('Map context menu', () => {
  beforeEach(() => {
    storeState.project = twoThreadProject();
    storeState.nodes = { n1: node('n1'), n2: node('n2'), x: node('x'), x1: node('x1') };
  });

  it('treats a node as the only target when the rest of the selection is off the Map', async () => {
    storeState.selection = new Set(['n2', 'x1']);
    render(<TerminalMap />);
    expect(screen.getByRole('toolbar', { name: 'Map selection actions' }).textContent).toContain('1SELECTED');

    openCardMenu('n2');
    expect(screen.queryByRole('menuitem', { name: /Weave/ })).toBeNull();
    fireEvent.click(menuItem(/Delete subtree/));
    await waitFor(() => expect(deleteNode).toHaveBeenCalled());
    expect(deleteNode).toHaveBeenCalledExactlyOnceWith('n2');
  });

  it('archives, deletes and exports only the selected nodes on the Map', async () => {
    storeState.selection = new Set(['n1', 'n2', 'x1']);
    const exportSpy = vi.fn();
    window.addEventListener('michi:toggle-export-panel', exportSpy as EventListener);
    try {
      render(<TerminalMap />);

      openCardMenu('n2');
      fireEvent.click(menuItem(/^Export 2 selected/));
      await waitFor(() => expect(exportSpy).toHaveBeenCalledOnce());
      expect((exportSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({ projectId: 'p1', nodeIds: ['n1', 'n2'] });

      openCardMenu('n2');
      fireEvent.click(menuItem(/^Archive 2/));
      await waitFor(() => expect(archiveNode).toHaveBeenCalled());
      expect(archiveNode).toHaveBeenCalledExactlyOnceWith('n2');

      openCardMenu('n2');
      fireEvent.click(menuItem(/^Delete 2/));
      await waitFor(() => expect(deleteNode).toHaveBeenCalled());
      expect(deleteNode).toHaveBeenCalledExactlyOnceWith('n2');
    } finally {
      window.removeEventListener('michi:toggle-export-panel', exportSpy as EventListener);
    }
  });

  it('offers no Rename on a card, which the Map cannot carry out', () => {
    storeState.selection = new Set();
    render(<TerminalMap />);
    openCardMenu('n2');
    expect(menuItem(/Open in pane/)).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Rename/ })).toBeNull();
  });

  it('refuses Weave and Digest when the bar does, and says why', () => {
    storeState.selection = new Set(['n1', 'n2']);
    storeState.nodes.n2 = node('n2', 'streaming');
    render(<TerminalMap />);

    openCardMenu('n1');
    const weave = menuItem(/^Weave 2 chats/);
    const digest = menuItem(/^Digest from 2 chats/);
    expect(weave.getAttribute('aria-disabled')).toBe('true');
    expect(digest.getAttribute('aria-disabled')).toBe('true');
    expect(weave.textContent).toContain('Wait for streaming to finish before merging.');
    expect(screen.getByRole('button', { name: 'Merge' }).getAttribute('title'))
      .toBe('Wait for streaming to finish before merging.');
  });

  it('refuses a cross-thread Weave in a merge thread, as the bar does', () => {
    storeState.project = {
      ...sameTreeProject(),
      chatIds: ['A', 'A1', 'M'],
      edges: [
        { source: 'A', target: 'A1', kind: 'branch' },
        { source: 'A1', target: 'M', kind: 'merge' },
      ],
      trees: [
        { id: 'tree-a', rootNodeId: 'A', createdAt: 0, lastActiveAt: 0 },
        { id: 'merge-tree', rootNodeId: 'M', createdAt: 1, lastActiveAt: 1, kind: 'merge' },
      ],
      activeTreeId: 'merge-tree',
    };
    storeState.nodes = { A: node('A'), A1: node('A1'), M: { ...node('M'), mergeSources: ['A1'] } };
    storeState.selection = new Set(['A1', 'M']);
    render(<TerminalMap />);

    expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
    openCardMenu('M');
    const weave = menuItem(/^Weave 2 chats/);
    expect(weave.getAttribute('aria-disabled')).toBe('true');
    expect(weave.textContent).toContain('Merge requires nodes from a single thread.');
  });
});

const drawnNodeIds = () =>
  Array.from(document.querySelectorAll('div[data-map-node][data-context-target]'))
    .map((el) => el.getAttribute('data-map-node'));

describe('Map graph contents', () => {
  it('lays out a branching thread in walk order, not chat order', () => {
    storeState.project = {
      ...sameTreeProject(),
      chatIds: ['n3', 'n1', 'n2'],
      edges: [
        { source: 'n1', target: 'n2', kind: 'branch' },
        { source: 'n1', target: 'n3', kind: 'branch' },
      ],
    };
    storeState.nodes = { n1: node('n1'), n2: node('n2'), n3: node('n3') };
    storeState.selection = new Set();
    render(<TerminalMap />);
    expect(drawnNodeIds()).toEqual(['n1', 'n2', 'n3']);
  });

  it('shows a merge thread with its sources', () => {
    storeState.project = {
      ...sameTreeProject(),
      chatIds: ['A', 'A1', 'B', 'B1', 'M'],
      edges: [
        { source: 'A', target: 'A1', kind: 'branch' },
        { source: 'B', target: 'B1', kind: 'branch' },
        { source: 'A1', target: 'M', kind: 'merge' },
        { source: 'B1', target: 'M', kind: 'merge' },
      ],
      trees: [
        { id: 'tree-a', rootNodeId: 'A', createdAt: 0, lastActiveAt: 0 },
        { id: 'tree-b', rootNodeId: 'B', createdAt: 0, lastActiveAt: 0 },
        { id: 'merge-tree', rootNodeId: 'M', createdAt: 1, lastActiveAt: 1, kind: 'merge' },
      ],
      activeTreeId: 'merge-tree',
    };
    storeState.nodes = {
      A: node('A'), A1: node('A1'), B: node('B'), B1: node('B1'),
      M: { ...node('M'), mergeSources: ['A1', 'B1'] },
    };
    storeState.selection = new Set();
    render(<TerminalMap />);
    expect(new Set(drawnNodeIds())).toEqual(new Set(['A', 'A1', 'B', 'B1', 'M']));
    expect(document.querySelectorAll('svg path[stroke-dasharray="6 4"]').length).toBe(2);
  });
});

describe('Map three-view switch', () => {
  it('switching to Timeline renders lane content and drops the graph cards', () => {
    storeState.nodes = {
      n1: { ...node('n1'), branchOverviewEntries: [{ at: 1000, text: 'first progress step' }] },
      n2: node('n2'),
    };
    render(<TerminalMap />);
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('first progress step')).toBeTruthy();
    expect(document.querySelector('[data-map-node]')).toBeNull();
  });
});

describe('Map card expand', () => {
  // Regression: the wrapper AND the card each toggled on click, so the two
  // fired back-to-back and the card never actually expanded. The wrapper is
  // now the sole click authority.
  it('expands a card on click (single toggle, not double)', () => {
    storeState.nodes = {
      n1: { ...node('n1'), branchOverviewEntries: [{ at: 1000, text: 'first progress step' }] },
      n2: node('n2'),
    };
    render(<TerminalMap />);
    // The expand section is always mounted; its data-expanded flag is the
    // CSS-independent source of truth (the grid-rows animation reveals it).
    const wrap = () => document.querySelector('[data-map-node="n1"] .map-card__expand-wrap');
    // Wrapper is the sole click authority; click it (outer node div).
    const card = document.querySelector('div[data-map-node="n1"]') as HTMLElement;
    expect(wrap()?.getAttribute('data-expanded')).toBe('false');
    fireEvent.click(card);
    // A single toggle expands it (the old double-toggle bug left it collapsed).
    expect(wrap()?.getAttribute('data-expanded')).toBe('true');
    fireEvent.click(card);
    expect(wrap()?.getAttribute('data-expanded')).toBe('false');
  });
});
