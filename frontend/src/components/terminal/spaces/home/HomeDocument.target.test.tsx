import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageDto } from 'michi-shared';
import { getCompanionPanelState, openCompanionPanel, resetCompanionPanelForTests } from '../../../../state/companion/companionPanel';
import { resetCompanionStoreForTests } from '../../../../state/companion/companionStore';
import { useHomeDocument } from './HomeDocument';

vi.mock('../../../../state/chatStore', () => ({
  useChatActions: () => ({ openPagePane: vi.fn(), revealBackendNode: vi.fn() }),
  useChatNodesSnapshot: () => ({}),
  useChatProjects: () => ({ projects: [{ id: 'ws-1', name: 'rabbitholes' }], agentStatus: null }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
}));
vi.mock('../../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/spacesFirstRun')>()),
  useSpacesFirstRun: () => ({ load: 'ready', data: null, error: null, unreachable: false, schedulerOff: false, justFinished: false }),
}));

const HOME = vi.hoisted(() => ({
  id: 'wh', workspaceId: 'ws-1', parentId: null, position: 0, title: 'rabbitholes', color: null, updatedAt: 1, updatedBy: 'agent',
  pendingProposals: 0, helperNodeId: null, revision: 1, viewVersion: 1,
  blocks: [
    { id: 'lead', rev: 1, type: 'markdown', text: 'Michi merged into dev.' },
    { id: 'next', rev: 1, type: 'next-steps', title: 'Next steps', items: [{ who: 'user', text: 'Confirm the risk rewrite', unblocks: 'Release notes' }] },
  ],
}) as PageDto);

vi.mock('../../../../state/pages/usePage', () => ({ usePage: () => ({
  page: HOME, changes: [], status: 'ready', error: null, stale: false, lastSeenChangeSeq: 0,
  refresh: vi.fn(), edit: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), acknowledgeThrough: vi.fn(),
}) }));
vi.mock('../../../../services/api/pages', () => ({ fetchPageActivitySeen: () => Promise.resolve({ lastSeenChangeSeq: 0 }) }));
vi.mock('../SpacesPage', () => ({ openNativePageRoute: vi.fn() }));
vi.mock('../NativeDatabase', () => ({ default: () => null }));

function HomeBlocks() {
  const doc = useHomeDocument({ backendConnectionId: 'local', initial: HOME });
  return <>{doc.renderBlocks(HOME.blocks.slice(0, 1), 'lead')}{doc.renderBlocks(HOME.blocks.slice(1), 'rest')}</>;
}

const block = (id: string) => document.querySelector<HTMLElement>(`.michi-doc-block[data-block-id="${id}"]`)!;
const target = () => getCompanionPanelState().target;

// DESIGN-v2 §1.3: a home's blocks are the panel's targets, as a Space page's are.
describe('Block targeting on a home page', () => {
  beforeEach(() => {
    resetCompanionPanelForTests();
    resetCompanionStoreForTests();
  });
  afterEach(() => { cleanup(); act(() => resetCompanionPanelForTests()); });

  it('with the panel open, outlines a clicked block in any segment, names it and clears on a second click', () => {
    act(() => openCompanionPanel({ tab: 'chat', focusComposer: false }));
    render(<HomeBlocks />);
    fireEvent.click(screen.getByText('Confirm the risk rewrite'));
    expect(block('next').dataset.selected).toBe('true');
    expect(target()).toMatchObject({ pageId: 'wh', blockId: 'next', title: 'Next steps' });

    fireEvent.click(screen.getByText('Michi merged into dev.'));
    expect(block('lead').dataset.selected).toBe('true');
    expect(block('next').dataset.selected).toBeUndefined();

    fireEvent.click(screen.getByText('Michi merged into dev.'));
    expect(block('lead').dataset.selected).toBeUndefined();
    expect(target()).toBeNull();
  });

  it('Ask <name> opens the panel about the home block, from any area', () => {
    render(<HomeBlocks />);
    const ask = block('next').querySelector<HTMLButtonElement>('[aria-label="Ask Michi"]')!;
    expect(ask).toBeTruthy();
    fireEvent.click(ask);
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat', target: { pageId: 'wh', blockId: 'next', workspaceId: 'ws-1' } });
  });

  it('selects nothing while the panel is closed', () => {
    render(<HomeBlocks />);
    fireEvent.click(screen.getByText('Confirm the risk rewrite'));
    expect(block('next').dataset.selected).toBeUndefined();
    expect(target()).toBeNull();
  });
});
