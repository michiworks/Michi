import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageBlock, PageChangeDto, PageDto } from 'michi-shared';
import { pagePaneId, type PagePaneItem } from '../../../state/paneItems';
import { PAGE_HELPER_DRAFT_EVENT, type PageHelperDraftRequest } from '../../../state/pages/pageHelperDraft';
import { getCompanionPanelState, openCompanionPanel, resetCompanionPanelForTests } from '../../../state/companion/companionPanel';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';

const mocks = vi.hoisted(() => ({
  page: null as PageDto | null,
  refresh: vi.fn(),
  edit: vi.fn(async () => undefined),
  accept: vi.fn(),
  changes: [] as PageChangeDto[],
  revealBackendNode: vi.fn(async () => true),
  usePageIdentity: null as unknown,
  ownerOverrides: {} as Record<string, unknown>,
  pages: [] as Array<{ id: string; helperNodeId: string | null }>,
  sourceNodeId: 'helper-node',
  nodes: {} as Record<string, { projectId: string; pageId?: string | null }>,
}));

const item: PagePaneItem = {
  id: pagePaneId('backend-a', 'owner-ws', 'page-1'),
  kind: 'page', projectId: 'host-ws', treeId: 'host-tree', title: 'Page', createdAt: 1,
  backendConnectionId: 'backend-a', workspaceId: 'owner-ws', pageId: 'page-1',
};

vi.mock('../../../state/chatStore', () => ({
  useChatActions: () => ({ revealBackendNode: mocks.revealBackendNode }),
  useChatNodesSnapshot: () => mocks.nodes,
  useChatProjects: () => ({ projects: [
    { id: 'host-ws', name: 'Chat workspace' },
    { id: 'owner-ws', name: 'Page workspace', ...mocks.ownerOverrides },
  ] }),
}));
vi.mock('../../../state/pages/useSpaceTree', () => ({ useSpaceTree: () => ({ pages: mocks.pages, status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/usePage', () => ({
  usePage: (identity: unknown) => {
    mocks.usePageIdentity = identity;
    return { page: mocks.page, status: mocks.page ? 'ready' : 'loading', error: null, stale: false, refresh: mocks.refresh, edit: mocks.edit, changes: mocks.changes, accept: mocks.accept };
  },
}));
vi.mock('./NativePageDocument', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('./NativePageDocument')),
  default: ({ page, compact, readOnly, renderComponent, renderDatabaseRef, onOpenSource, onAskAssistant, onSelectionChange, selectedBlockIds, selectOnClick }: {
    page: PageDto; compact?: boolean; readOnly?: boolean;
    renderComponent?: (block: PageBlock) => React.ReactNode;
    renderDatabaseRef?: (block: Extract<PageBlock, { type: 'database-ref' }>) => React.ReactNode;
    onOpenSource?: (source: { nodeId: string; turnId: string; assistantId: string }) => void;
    onAskAssistant?: (block: PageBlock, item?: { index: number; text: string }) => void;
    onSelectionChange?: (selection: { blockId: string } | null) => void;
    selectedBlockIds?: readonly string[];
    selectOnClick?: boolean;
  }) => <div data-testid="native-document" data-compact={String(Boolean(compact))} data-read-only={String(Boolean(readOnly))}
    data-select-on-click={String(Boolean(selectOnClick))} data-selected={(selectedBlockIds ?? []).join(',')}>
    {page.title}{renderComponent?.({ type: 'component', id: 'component-block', componentId: 'component-1', pinnedVersion: 1, props: {}, height: 200 } as PageBlock)}
    {page.blocks.map((block) => onAskAssistant && <React.Fragment key={block.id}>
      <button type="button" onClick={() => onAskAssistant(block)}>Ask about {block.id}</button>
      {block.type === 'checklist' && <button type="button" onClick={() => onAskAssistant(block, { index: 0, text: block.items[0].text })}>Ask about item 0</button>}
      <button type="button" onClick={() => onSelectionChange?.({ blockId: block.id })}>Select {block.id}</button>
    </React.Fragment>)}
    {renderDatabaseRef?.({ type: 'database-ref', id: 'database-block', databaseId: 'database-1', viewId: 'view-1' } as Extract<PageBlock, { type: 'database-ref' }>)}
    <button type="button" onClick={() => onOpenSource?.({ nodeId: mocks.sourceNodeId, turnId: 'turn-old', assistantId: 'answer-old' })}>Open helper source</button>
  </div>,
}));
vi.mock('./NativeDatabase', () => ({ default: ({ onAskDraft }: { onAskDraft?: (text: string) => void }) => <button type="button" onClick={() => onAskDraft?.('Help with this database view')}>Ask database helper</button> }));
vi.mock('./components/CustomBlock', () => ({ CustomBlock: ({ onAskDraft }: { onAskDraft?: (text: string) => void }) => <button type="button" onClick={() => onAskDraft?.('Help with this component')}>Ask component helper</button> }));

import PagePane from './PagePane';

describe('PagePane', () => {
  beforeEach(() => {
    mocks.revealBackendNode.mockReset().mockResolvedValue(true);
    mocks.page = {
      id: 'page-1', workspaceId: 'owner-ws', parentId: null, position: 0,
      title: 'Roadmap', color: null, updatedAt: 1, updatedBy: 'user', pendingProposals: 0,
      helperNodeId: null, revision: 1, viewVersion: 1, blocks: [],
    };
    mocks.ownerOverrides = {};
    mocks.pages = [{ id: 'page-1', helperNodeId: null }];
    mocks.sourceNodeId = 'helper-node';
    mocks.nodes = {};
    resetCompanionPanelForTests();
    resetCompanionStoreForTests();
    mocks.changes = [];
  });

  // F1b-review #4: a page pane's blocks are the panel's targets as a page's in Pages are (DESIGN-v2 §1.3).
  describe('blocks as the panel’s targets', () => {
    const checklist = { id: 'next', rev: 1, type: 'checklist', title: 'Next steps', items: [{ text: 'Ship it', done: false }] } as unknown as PageBlock;

    it('Ask <name> on a block or a checklist item opens the panel about it, on the pane’s own backend', () => {
      mocks.page = { ...mocks.page!, blocks: [checklist] };
      render(<PagePane item={item} />);
      fireEvent.click(screen.getByRole('button', { name: 'Ask about next' }));
      expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat', target: {
        pageId: 'page-1', blockId: 'next', workspaceId: 'owner-ws', backendConnectionId: 'backend-a', title: 'Next steps',
      } });
      expect(screen.getByTestId('native-document').dataset.selected).toBe('next');
      fireEvent.click(screen.getByRole('button', { name: 'Ask about item 0' }));
      expect(getCompanionPanelState().target).toMatchObject({ blockId: 'next', itemIndex: 0, itemText: 'Ship it', title: 'Ship it', backendConnectionId: 'backend-a' });
    });

    it('a click targets a block only while the panel is open, and nothing is offered on a read-only page', () => {
      mocks.page = { ...mocks.page!, blocks: [checklist] };
      const view = render(<PagePane item={item} />);
      expect(screen.getByTestId('native-document').dataset.selectOnClick).toBe('false');
      act(() => openCompanionPanel({ tab: 'chat', focusComposer: false }));
      expect(screen.getByTestId('native-document').dataset.selectOnClick).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'Select next' }));
      expect(getCompanionPanelState().target).toMatchObject({ pageId: 'page-1', blockId: 'next', backendConnectionId: 'backend-a' });
      view.unmount();
      // Leaving the pane clears a target on its page.
      expect(getCompanionPanelState().target).toBeNull();

      mocks.ownerOverrides = { archivedAt: 2 };
      render(<PagePane item={item} />);
      expect(screen.queryByRole('button', { name: 'Ask about next' })).toBeNull();
    });
  });

  it('loads using the owner identity, identifies a cross-workspace page, and opens standalone', () => {
    const onRoute = vi.fn();
    window.addEventListener('michi:open-native-page', onRoute);
    render(<PagePane item={item} />);
    expect(screen.getByText(/Belongs to Page workspace/)).toBeTruthy();
    expect(document.querySelector('[data-native-page-pane]')).toMatchObject({ dataset: {
      pageId: 'page-1', workspaceId: 'owner-ws', backendConnectionId: 'backend-a',
    } });
    expect(screen.getByTestId('native-document').getAttribute('data-compact')).toBe('true');
    expect(mocks.usePageIdentity).toEqual({ backendConnectionId: 'backend-a', workspaceId: 'owner-ws', pageId: 'page-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Open standalone' }));
    expect(onRoute).toHaveBeenCalledWith(expect.objectContaining({
      detail: { pageId: 'page-1', workspaceId: 'owner-ws', backendConnectionId: 'backend-a' },
    }));
    window.removeEventListener('michi:open-native-page', onRoute);
  });

  it('passes read-only state through for an archived or deleted owner workspace', () => {
    mocks.ownerOverrides = { archivedAt: 2 };
    render(<PagePane item={item} />);
    expect(screen.getByText('This workspace is archived or deleted. The page is read-only.')).toBeTruthy();
    expect(screen.getByTestId('native-document').getAttribute('data-read-only')).toBe('true');
  });

  it('hands custom block and database Ask drafts to the panel for the owning page, in place and without sending', () => {
    const onRoute = vi.fn();
    const pending: PageHelperDraftRequest[] = [];
    const record = (event: Event) => { pending.push((event as CustomEvent<PageHelperDraftRequest>).detail); };
    window.addEventListener('michi:open-native-page', onRoute);
    window.addEventListener(PAGE_HELPER_DRAFT_EVENT, record);
    try {
      render(<PagePane item={item} />);
      fireEvent.click(screen.getByRole('button', { name: 'Ask component helper' }));
      fireEvent.click(screen.getByRole('button', { name: 'Ask database helper' }));
      expect(pending.every((draft) => draft.backendConnectionId === 'backend-a' && draft.workspaceId === 'owner-ws' && draft.pageId === 'page-1')).toBe(true);
      expect(pending.map(({ text, blockContext }) => ({ text, blockContext }))).toEqual([
        { text: 'Help with this component', blockContext: { blockId: 'component-block', title: 'Component', content: 'Custom page component' } },
        { text: 'Help with this database view', blockContext: { blockId: 'database-block', title: 'Database', content: 'Native database view' } },
      ]);
      // The panel opens right here (its host takes the draft): no detour to the page in Pages (DESIGN-v2 §1.3).
      expect(onRoute).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('michi:open-native-page', onRoute);
      window.removeEventListener(PAGE_HELPER_DRAFT_EVENT, record);
    }
  });

  it('opens a page helper’s cited answer like any chat’s, not its page', async () => {
    const onRoute = vi.fn();
    window.addEventListener('michi:open-native-page', onRoute);
    try {
      for (const bound of [
        () => { mocks.pages = [{ id: 'page-1', helperNodeId: 'helper-node' }]; mocks.nodes = {}; },
        () => { mocks.pages = [{ id: 'page-1', helperNodeId: null }]; mocks.nodes = { 'helper-node': { projectId: 'owner-ws', pageId: 'page-2' } }; },
      ]) {
        bound();
        mocks.revealBackendNode.mockClear();
        const view = render(<PagePane item={item} />);
        fireEvent.click(screen.getByRole('button', { name: 'Open helper source' }));
        await vi.waitFor(() => expect(mocks.revealBackendNode).toHaveBeenCalledWith('remote:backend-a:owner-ws', 'remote:backend-a:helper-node'));
        view.unmount();
      }
      expect(onRoute).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('michi:open-native-page', onRoute);
    }
  });

  it('opens a promoted former helper as an ordinary chat', async () => {
    mocks.sourceNodeId = 'promoted-node';
    mocks.pages = [{ id: 'page-1', helperNodeId: null }, { id: 'page-2', helperNodeId: 'promoted-node' }];
    mocks.nodes = { 'promoted-node': { projectId: 'owner-ws', pageId: null } };
    mocks.revealBackendNode.mockResolvedValue(true);
    render(<PagePane item={item} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open helper source' }));
    await vi.waitFor(() => expect(mocks.revealBackendNode).toHaveBeenCalledWith('remote:backend-a:owner-ws', 'remote:backend-a:promoted-node'));
  });

  it('takes a suggestion’s buttons back as soon as an answer that did not take settles', async () => {
    const row = { id: 'row-1', rev: 1, values: { status: 'Todo' }, body: '', position: 0, updatedAt: 1, edited: {}, bodyEditedAt: null };
    mocks.changes = [{
      id: 'suggested', seq: 1, batchId: 'batch-1', target: { kind: 'row', databaseId: 'database-1', rowId: 'row-1', columnIds: ['status'] }, op: 'row',
      before: { kind: 'row', exists: true, row, location: { position: 0, after: null } },
      after: { kind: 'row', exists: true, row: { ...row, rev: 2, values: { status: 'Done' } }, location: { position: 0, after: null } },
      forward: { kind: 'row', op: 'patch', id: 'row-1', values: { status: 'Done' } },
      inverse: { kind: 'row', op: 'patch', id: 'row-1', values: { status: 'Todo' } },
      baseRev: 1, appliedRev: null, previousHeadId: null, source: { kind: 'chat', nodeId: 'node-1', turnId: 'turn-1', assistantId: 'msg-1' },
      proposalState: 'pending', applicationState: null, createdAt: 1, resolvedAt: null,
    }];
    let settle!: () => void;
    mocks.accept.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve; }));
    render(<PagePane item={item} />);
    const accept = () => screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement;
    fireEvent.click(accept());
    expect(mocks.accept).toHaveBeenCalledWith('suggested', undefined);
    expect(accept().disabled).toBe(true);
    await act(async () => { settle(); });
    // Well before the 8 s fallback for a handler that gives nothing to wait on.
    await waitFor(() => expect(accept().disabled).toBe(false));
  });
});
