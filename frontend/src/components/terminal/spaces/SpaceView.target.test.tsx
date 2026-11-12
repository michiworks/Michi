import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompanionPanelState, openCompanionPanel, resetCompanionPanelForTests } from '../../../state/companion/companionPanel';
import { PAGE_HELPER_DRAFT_EVENT, type PageHelperDraftRequest } from '../../../state/pages/pageHelperDraft';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import SpaceView from './SpaceView';

vi.mock('../../../state/chatStore', () => ({
  useChatActions: () => ({ openPagePane: vi.fn(), revealBackendNode: vi.fn() }),
  useChatNodesSnapshot: () => ({}),
  useChatProjects: () => ({ projects: [{ id: 'workspace-1', name: 'Workspace' }], agentStatus: null }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
}));
vi.mock('../../../state/pages/useSpaceTree', () => ({ useSpaceTree: () => ({ pages: [{ id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Release' }], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/usePage', () => ({ usePage: () => ({
  page: {
    id: 'page-1', workspaceId: 'workspace-1', parentId: null, position: 0, title: 'Release', color: null, updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1,
    blocks: [
      { id: 'next', rev: 1, type: 'checklist', title: 'Next steps', items: [{ id: 'i1', text: 'Ship it', done: false }] },
      { id: 'notes', rev: 1, type: 'markdown', text: 'Plain notes' },
      { id: 'db', rev: 1, type: 'database-ref', databaseId: 'database-1' },
    ],
  },
  changes: [], status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), revertBatch: vi.fn(),
}) }));
vi.mock('../../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: [], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/revealSource', () => ({ revealPageSource: vi.fn() }));
vi.mock('../../../state/pages/pageEvents', () => ({ notifyPageChanged: vi.fn(), subscribePageChanges: vi.fn(() => () => {}) }));
vi.mock('../../../services/api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/pages')>()),
  createWorkspaceDatabase: vi.fn(), listWorkspaceDatabases: vi.fn(), createPage: vi.fn(), deletePage: vi.fn(), fetchPage: vi.fn(), patchPage: vi.fn(),
}));
vi.mock('./NativeDatabase', () => ({ default: ({ onAskDraft, onAskRow, compact }: { onAskDraft?: (text: string) => void; onAskRow?: (row: { id: string; title: string }) => void; compact?: boolean }) => <>
  <button type="button" data-compact={compact ? '' : undefined} onClick={() => onAskDraft?.('Summarize this database')}>Ask database</button>
  {onAskRow && <button type="button" onClick={() => onAskRow({ id: 'row-7', title: 'F-8 change history' })}>Ask row</button>}
</> }));
vi.mock('./MaintenanceStatus', () => ({ MaintenanceStatus: () => null }));
vi.mock('./conversation/SpaceConversationSlot', () => ({ NewChatSheetSlot: () => null, PageProgressCards: () => null }));

const route = { type: 'space' as const, pageId: 'page-1', workspaceId: 'workspace-1', backendConnectionId: 'local' };

const block = (id: string) => document.querySelector<HTMLElement>(`.michi-doc-block[data-block-id="${id}"]`)!;
const target = () => getCompanionPanelState().target;
const renderPage = () => render(<SpaceView route={route} onBack={vi.fn()} onOpenPage={vi.fn()} />);

// DESIGN-v2 §1.3: a block's Ask opens the one panel about the block; while
// the panel is open, a click on a block makes it the target.
describe('Block targeting in Pages', () => {
  beforeEach(() => {
    resetCompanionPanelForTests();
    resetCompanionStoreForTests();
  });
  afterEach(() => { cleanup(); act(() => resetCompanionPanelForTests()); });

  it('with the panel open, outlines a clicked block, makes it the target and clears on a second click', () => {
    act(() => openCompanionPanel({ tab: 'chat', focusComposer: false }));
    renderPage();
    fireEvent.click(screen.getByText('Plain notes'));
    expect(block('notes').dataset.selected).toBe('true');
    // Named as on a home page (pageBlockTarget): a text block by its heading or first words.
    expect(target()).toMatchObject({ pageId: 'page-1', blockId: 'notes', title: 'Plain notes', workspaceId: 'workspace-1', backendConnectionId: 'local' });

    fireEvent.click(screen.getByText('Plain notes'));
    expect(block('notes').dataset.selected).toBeUndefined();
    expect(target()).toBeNull();

    fireEvent.click(screen.getByText('Ship it'));
    expect(block('next').dataset.selected).toBe('true');
    expect(target()).toMatchObject({ blockId: 'next', title: 'Next steps' });
    // The panel's × on its chip clears it: the outline follows.
    act(() => resetCompanionPanelForTests({ open: true }));
    expect(block('next').dataset.selected).toBeUndefined();
  });

  it('with the panel closed, a click on a block targets nothing and opens nothing', () => {
    renderPage();
    fireEvent.click(screen.getByText('Plain notes'));
    expect(block('notes').dataset.selected).toBeUndefined();
    expect(getCompanionPanelState()).toMatchObject({ open: false, target: null });
  });

  it('a block’s own Select targets it with the panel closed, for the next ⌘J, and opens nothing', () => {
    renderPage();
    const toolbar = block('notes').querySelector<HTMLElement>('[role="toolbar"]')!;
    fireEvent.click(toolbar.querySelector<HTMLButtonElement>('[aria-label="Select"]')!);
    expect(getCompanionPanelState()).toMatchObject({ open: false, target: { pageId: 'page-1', blockId: 'notes', title: 'Plain notes' } });
    expect(block('notes').dataset.selected).toBe('true');
    fireEvent.click(toolbar.querySelector<HTMLButtonElement>('[aria-label="Deselect"]')!);
    expect(target()).toBeNull();
    expect(block('notes').dataset.selected).toBeUndefined();
  });

  it('Ask <name> opens the panel about the block, its composer focused', () => {
    renderPage();
    const ask = block('next').querySelector<HTMLButtonElement>('[aria-label="Ask Michi"]')!;
    expect(ask).toBeTruthy();
    fireEvent.click(ask);
    const state = getCompanionPanelState();
    expect(state).toMatchObject({ open: true, tab: 'chat', target: { pageId: 'page-1', blockId: 'next', title: 'Next steps' } });
    expect(state.composerFocusSeq).toBeGreaterThan(0);
    // The panel's target is outlined on the page.
    expect(block('next').dataset.selected).toBe('true');
  });

  it('Ask on one checklist item targets that item, without ticking it', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Ask Michi about “Ship it”' }));
    expect(target()).toMatchObject({ pageId: 'page-1', blockId: 'next', itemIndex: 0, itemText: 'Ship it', title: 'Ship it' });
    expect(screen.getByRole('checkbox', { name: 'Ship it' }).getAttribute('aria-checked')).toBe('false');
    // Clicking the block afterwards targets the whole block again.
    fireEvent.click(screen.getByText('Plain notes'));
    fireEvent.click(screen.getByText('Ship it'));
    expect(target()).toMatchObject({ blockId: 'next', title: 'Next steps' });
    expect(target()).not.toHaveProperty('itemIndex');
  });

  it('Ask on one database row opens the panel about that row of the database block, its composer focused', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Ask row' }));
    const state = getCompanionPanelState();
    expect(state).toMatchObject({
      open: true,
      tab: 'chat',
      target: { pageId: 'page-1', blockId: 'db', title: 'F-8 change history', row: { databaseId: 'database-1', rowId: 'row-7', text: 'F-8 change history' } },
    });
    expect(state.target).not.toHaveProperty('itemIndex');
    expect(state.composerFocusSeq).toBeGreaterThan(0);
    // Clicking a block afterwards targets the whole block.
    fireEvent.click(screen.getByText('Plain notes'));
    expect(target()).toMatchObject({ blockId: 'notes' });
    expect(target()).not.toHaveProperty('row');
  });

  it('hands a database ask to the panel as a page helper’s draft about the block, without sending', () => {
    const pending: PageHelperDraftRequest[] = [];
    const record = (event: Event) => { pending.push((event as CustomEvent<PageHelperDraftRequest>).detail); };
    window.addEventListener(PAGE_HELPER_DRAFT_EVENT, record);
    try {
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Ask database' }));
    } finally {
      window.removeEventListener(PAGE_HELPER_DRAFT_EVENT, record);
    }
    expect(pending.map(({ backendConnectionId, workspaceId, pageId, text, blockContext }) => ({ backendConnectionId, workspaceId, pageId, text, blockId: blockContext?.blockId, title: blockContext?.title }))).toEqual([
      { backendConnectionId: 'local', workspaceId: 'workspace-1', pageId: 'page-1', text: 'Summarize this database', blockId: 'db', title: 'Database' },
    ]);
  });

  it('lays a database out narrow where the page is narrow, as with the panel docked beside it, and wide where it is not (F1b-review #5)', () => {
    let width = 560;
    const original = HTMLElement.prototype.getBoundingClientRect;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('michi-doc-blocks') ? { width, height: 400, top: 0, left: 0, right: width, bottom: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect : original.call(this);
    });
    try {
      act(() => openCompanionPanel({ tab: 'chat', focusComposer: false }));
      const view = renderPage();
      expect(screen.getByRole('button', { name: 'Ask database' }).hasAttribute('data-compact')).toBe(true);
      view.unmount();
      width = 1100;
      renderPage();
      expect(screen.getByRole('button', { name: 'Ask database' }).hasAttribute('data-compact')).toBe(false);
    } finally {
      measure.mockRestore();
    }
  });

  it('leaving the page clears a target on it', () => {
    act(() => openCompanionPanel({ tab: 'chat', focusComposer: false }));
    const view = renderPage();
    fireEvent.click(screen.getByText('Plain notes'));
    expect(target()?.blockId).toBe('notes');
    view.unmount();
    expect(target()).toBeNull();
  });

  it('offers no Ask where this backend has no assistant', () => {
    resetCompanionStoreForTests({ assistant: { status: 'unsupported', info: null, error: null } });
    renderPage();
    expect(block('next').querySelector('[aria-label="Ask Michi"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask Michi about “Ship it”' })).toBeNull();
  });
});
