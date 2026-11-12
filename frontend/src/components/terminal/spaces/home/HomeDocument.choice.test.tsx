import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageBlock, PageChangeDto, PageDto } from 'michi-shared';
import { useHomeDocument } from './HomeDocument';

vi.mock('../../../MentionEditor', () => import('../../../../test/mentionEditorStub'));
vi.mock('../../TPane', () => ({ default: () => null }));
vi.mock('../../../../state/chatStore', () => ({
  useChatActions: () => ({ openPagePane: vi.fn(), revealBackendNode: vi.fn() }),
  useChatNodesSnapshot: () => ({}),
  useChatProjects: () => ({ projects: [{ id: 'ws-1', name: 'sample-project' }], agentStatus: null }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
}));

const location = { parentId: null, slot: null, previousId: null, nextId: null };
const before: PageBlock = { id: 'lead', rev: 1, type: 'markdown', text: 'Michi merged into dev.' };
const after: PageBlock = { id: 'lead', rev: 2, type: 'markdown', text: 'Michi merged into dev on Monday.' };
const state = vi.hoisted(() => ({ accept: vi.fn() }));
const HOME = vi.hoisted(() => ({
  id: 'wh', workspaceId: 'ws-1', parentId: null, position: 0, title: 'sample-project', color: null, updatedAt: 1, updatedBy: 'agent',
  pendingProposals: 1, helperNodeId: null, revision: 1, viewVersion: 1, blocks: [] as PageBlock[],
}) as PageDto);
HOME.blocks = [before];
const pending: PageChangeDto = {
  id: 'chg-1', seq: 1, batchId: 'batch-1', target: { kind: 'block', pageId: 'wh', blockId: 'lead' }, op: 'update',
  before: { kind: 'block', exists: true, block: before, location }, after: { kind: 'block', exists: true, block: after, location },
  forward: { kind: 'block', op: 'upsert', block: after, location }, inverse: { kind: 'block', op: 'upsert', block: before, location },
  baseRev: 1, appliedRev: null, previousHeadId: null, source: { kind: 'chat', nodeId: 'node-1', turnId: 'turn-1', assistantId: 'msg-1' },
  proposalState: 'pending', applicationState: null, createdAt: 1, resolvedAt: null,
};

vi.mock('../../../../state/pages/usePage', () => ({ usePage: () => ({
  page: HOME, changes: [pending], status: 'ready', error: null, stale: false, lastSeenChangeSeq: 0,
  refresh: vi.fn(), edit: vi.fn(), apply: vi.fn(), accept: state.accept, dismiss: vi.fn(), reopen: vi.fn(), revert: vi.fn(), redo: vi.fn(), acknowledgeThrough: vi.fn(async () => undefined),
}) }));
vi.mock('../../../../services/api/pages', () => ({ fetchPageActivitySeen: () => Promise.resolve({ lastSeenChangeSeq: 0 }) }));
vi.mock('../SpacesPage', () => ({ openNativePageRoute: vi.fn() }));
vi.mock('../NativeDatabase', () => ({ default: () => null }));

function HomeBlocks() {
  const doc = useHomeDocument({ backendConnectionId: 'local', initial: HOME });
  return <>{doc.renderBlocks(HOME.blocks, 'rest')}</>;
}

afterEach(cleanup);

describe('A suggestion on a home page', () => {
  it('takes its buttons back as soon as an answer that did not take settles', async () => {
    let settle!: () => void;
    state.accept.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve; }));
    render(<HomeBlocks />);
    const accept = () => screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement;
    fireEvent.click(accept());
    expect(state.accept).toHaveBeenCalledWith('chg-1', undefined);
    expect(accept().disabled).toBe(true);
    await act(async () => { settle(); });
    // Well before the 8 s fallback for a handler that gives nothing to wait on.
    await waitFor(() => expect(accept().disabled).toBe(false));
  });
});
