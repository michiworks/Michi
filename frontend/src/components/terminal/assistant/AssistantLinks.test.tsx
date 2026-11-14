import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownContent from '../../MarkdownContent';
import { AssistantLinkScope, MichiLinkScope } from './AssistantLinks';
import { MichiLinkConnectionContext } from './linkConnection';

const revealNode = vi.hoisted(() => vi.fn((_nodeId: string, _opts?: { workspaceId?: string; messageId?: string }) => true));
const store = vi.hoisted(() => ({
  nodes: {
    n7: { nodeId: 'n7', projectId: 'w1', title: 'S7 thread' },
    'remote:build-box:n4': { nodeId: 'remote:build-box:n4', projectId: 'remote:build-box:w4', title: 'Phone layout' },
  } as Record<string, unknown>,
  projects: [
    { id: 'w1', name: 'A', chatIds: ['n7'] },
    { id: 'sys', name: 'Assistant', system: 'assistant', chatIds: ['n-sys'] },
    { id: 'remote:build-box:w4', name: 'Build box', chatIds: ['remote:build-box:n4'] },
  ] as Array<{ id: string; name: string; system?: string; chatIds: string[] }>,
  installWorkspaceSnapshot: vi.fn((_raw: unknown, _readStartedAt?: number) => true),
  listeners: new Set<() => void>(),
  /** Readers re-render on a change, as with the real store. */
  emit() { for (const listener of this.listeners) listener(); },
  subscribe(listener: () => void) {
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
  },
}));
const persistence = vi.hoisted(() => ({ fetchNodeWorkspace: vi.fn(), fetchWorkspaceStructure: vi.fn() }));
const pages = vi.hoisted(() => ({ openSpacesPage: vi.fn(async (_target: unknown) => 'opened' as const) }));

vi.mock('../../../services/api/persistence', () => persistence);
vi.mock('../../../state/metaChat/spacesPages', () => pages);
vi.mock('../../../state/chatStore', () => ({
  useChatNode: (id: string) => React.useSyncExternalStore(store.subscribe, () => store.nodes[id]),
  // The real reader sees an install at once, before any re-render.
  useChatNodeReader: () => (id: string) => store.nodes[id],
  useChatProjects: () => ({ projects: React.useSyncExternalStore(store.subscribe, () => store.projects), activeProjectId: 'w1' }),
  useChatActions: () => ({ revealNode, installWorkspaceSnapshot: store.installWorkspaceSnapshot }),
}));

const ANSWER = 'See [S7](michi://node/n7).';

beforeEach(() => {
  revealNode.mockClear();
  persistence.fetchNodeWorkspace.mockReset();
  persistence.fetchWorkspaceStructure.mockReset();
  store.installWorkspaceSnapshot.mockReset().mockReturnValue(true);
  pages.openSpacesPage.mockClear();
});

describe('assistant answer chips', () => {
  it('renders native conversation links as chips', () => {
    render(<AssistantLinkScope><MarkdownContent text={ANSWER} /></AssistantLinkScope>);
    expect(screen.getByRole('button', { name: 'S7' }).getAttribute('data-assistant-link')).toBe('node');
    expect(document.querySelector('a')).toBeNull();
  });

  it('opens what each chip points at', () => {
    render(<AssistantLinkScope><MarkdownContent text={ANSWER} /></AssistantLinkScope>);
    fireEvent.click(screen.getByRole('button', { name: 'S7' }));
    expect(revealNode).toHaveBeenCalledWith('n7', { workspaceId: 'w1' });
  });

  it('opens a message link at the message it cites', () => {
    render(<AssistantLinkScope><MarkdownContent text={'See [the decision](michi://node/n7?message=m42).'} /></AssistantLinkScope>);
    fireEvent.click(screen.getByRole('button', { name: 'the decision' }));
    expect(revealNode).toHaveBeenCalledWith('n7', { workspaceId: 'w1', messageId: 'm42' });
  });

  it('loads a thread this window does not have yet, then opens it', async () => {
    const raw = { workspace: { id: 'w2' }, trees: [{ id: 't9', root_node_id: 'n9' }], nodes: [{ id: 'n9', title: 'New elsewhere' }], edges: [] };
    persistence.fetchNodeWorkspace.mockResolvedValue({ workspaceId: 'w2', treeId: 't9' });
    persistence.fetchWorkspaceStructure.mockResolvedValue(raw);
    // As the real install: the node is in the store at once, for the next render.
    store.installWorkspaceSnapshot.mockImplementation(() => {
      store.nodes = { ...store.nodes, n9: { nodeId: 'n9', projectId: 'w2', title: 'New elsewhere' } };
      store.projects = [...store.projects, { id: 'w2', name: 'B', chatIds: ['n9'] }];
      return true;
    });
    const text = 'See [清理项目背景](michi://node/n9).';
    const before = Date.now();
    render(<AssistantLinkScope><MarkdownContent text={text} /></AssistantLinkScope>);
    try {
      fireEvent.click(screen.getByRole('button', { name: '清理项目背景' }));
      await waitFor(() => expect(store.installWorkspaceSnapshot).toHaveBeenCalledWith(raw, expect.any(Number)));
      // When the workspace read began goes with it.
      expect(store.installWorkspaceSnapshot.mock.calls[0][1]).toBeGreaterThanOrEqual(before);
      // Only that one workspace is read.
      expect(persistence.fetchNodeWorkspace).toHaveBeenCalledWith('n9', expect.any(AbortSignal));
      expect(persistence.fetchWorkspaceStructure).toHaveBeenCalledWith('w2', expect.any(AbortSignal));
      await waitFor(() => expect(revealNode).toHaveBeenCalledWith('n9', { workspaceId: 'w2' }));
    } finally {
      const { n9: _n9, ...rest } = store.nodes;
      store.nodes = rest;
      store.projects = store.projects.filter((p) => p.id !== 'w2');
    }
  });

  it('says not found when the workspace came in without that thread', async () => {
    persistence.fetchNodeWorkspace.mockResolvedValue({ workspaceId: 'w2', treeId: 't9' });
    // Deleted between the lookup and the read: the workspace has no live n9.
    persistence.fetchWorkspaceStructure.mockResolvedValue({ workspace: { id: 'w2' }, trees: [], nodes: [], edges: [] });
    render(<AssistantLinkScope><MarkdownContent text={'See [Just deleted](michi://node/n9).'} /></AssistantLinkScope>);
    const chip = screen.getByRole('button', { name: /Just deleted/ });
    fireEvent.click(chip);
    await waitFor(() => expect(chip.getAttribute('aria-disabled')).toBe('true'));
    expect(chip.textContent).toContain('not found');
    expect(store.installWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    fireEvent.click(chip);
    expect(persistence.fetchNodeWorkspace).toHaveBeenCalledTimes(1);
    expect(revealNode).not.toHaveBeenCalled();
  });

  it('says it could not load a workspace it could not read, and tries again on the next click', async () => {
    persistence.fetchNodeWorkspace.mockResolvedValue({ workspaceId: 'w2', treeId: 't9' });
    persistence.fetchWorkspaceStructure.mockResolvedValue({ nope: true });
    store.installWorkspaceSnapshot.mockReturnValue(false);
    render(<AssistantLinkScope><MarkdownContent text={'See [Odd one](michi://node/n9).'} /></AssistantLinkScope>);
    const chip = screen.getByRole('button', { name: /Odd one/ });
    fireEvent.click(chip);
    await waitFor(() => expect(chip.textContent).toContain("couldn't load"));
    expect(chip.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(chip);
    await waitFor(() => expect(persistence.fetchNodeWorkspace).toHaveBeenCalledTimes(2));
    expect(revealNode).not.toHaveBeenCalled();
  });

  it('says so when Michi has no such thread, and does nothing else', async () => {
    persistence.fetchNodeWorkspace.mockResolvedValue(null);
    render(<AssistantLinkScope><MarkdownContent text={'Was in [Old thread](michi://node/n8).'} /></AssistantLinkScope>);
    const chip = screen.getByRole('button', { name: /Old thread/ });
    fireEvent.click(chip);
    await waitFor(() => expect(chip.getAttribute('aria-disabled')).toBe('true'));
    expect(chip.textContent).toContain('not found');
    expect(store.installWorkspaceSnapshot).not.toHaveBeenCalled();
    act(() => { fireEvent.click(chip); });
    expect(persistence.fetchNodeWorkspace).toHaveBeenCalledTimes(1);
    expect(revealNode).not.toHaveBeenCalled();
  });

  it('tries again on the next click when the backend could not be asked', async () => {
    persistence.fetchNodeWorkspace.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(null);
    render(<AssistantLinkScope><MarkdownContent text={'Was in [Old thread](michi://node/n8).'} /></AssistantLinkScope>);
    const chip = screen.getByRole('button', { name: /Old thread/ });
    fireEvent.click(chip);
    await waitFor(() => expect(chip.getAttribute('aria-busy')).toBeNull());
    expect(chip.getAttribute('aria-disabled')).toBeNull();
    expect(chip.textContent).toContain("couldn't load");
    fireEvent.click(chip);
    await waitFor(() => expect(chip.getAttribute('aria-disabled')).toBe('true'));
    expect(persistence.fetchNodeWorkspace).toHaveBeenCalledTimes(2);
  });

  it('says it could not load a remote thread the store lacks, without asking this machine', async () => {
    render(<AssistantLinkScope><MarkdownContent text={'On [Build box chat](michi://node/remote:build-box:n5).'} /></AssistantLinkScope>);
    const chip = screen.getByRole('button', { name: /Build box chat/ });
    fireEvent.click(chip);
    await waitFor(() => expect(chip.textContent).toContain("couldn't load"));
    expect(chip.textContent).not.toContain('not found');
    expect(chip.getAttribute('aria-disabled')).toBeNull();
    expect(persistence.fetchNodeWorkspace).not.toHaveBeenCalled();
    expect(store.installWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('installs nothing for a chip that went away mid-lookup', async () => {
    let answer!: (value: unknown) => void;
    persistence.fetchNodeWorkspace.mockResolvedValue({ workspaceId: 'w2', treeId: null });
    persistence.fetchWorkspaceStructure.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const view = render(<AssistantLinkScope><MarkdownContent text={'See [Gone soon](michi://node/n9).'} /></AssistantLinkScope>);
    fireEvent.click(screen.getByRole('button', { name: 'Gone soon' }));
    await waitFor(() => expect(persistence.fetchWorkspaceStructure).toHaveBeenCalled());
    const signal = persistence.fetchWorkspaceStructure.mock.calls[0][1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { answer({ workspace: { id: 'w2' }, nodes: [{ id: 'n9' }] }); });
    expect(store.installWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it('changes nothing for every other caller', () => {
    render(<MarkdownContent text={ANSWER} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    for (const a of Array.from(document.querySelectorAll('a'))) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^(michi|desk):/i);
    }
  });

  it('gives Markdown anywhere in the app the chips', () => {
    render(<MichiLinkScope><MarkdownContent text={ANSWER} /></MichiLinkScope>);
    fireEvent.click(screen.getByRole('button', { name: 'S7' }));
    expect(revealNode).toHaveBeenCalledWith('n7', { workspaceId: 'w1' });
  });
});

describe("links in a remote machine's content", () => {
  // An agent on the remote machine writes its own ids.
  const onBuildBox = (text: string) => (
    <MichiLinkScope>
      <MichiLinkConnectionContext.Provider value="build-box"><MarkdownContent text={text} /></MichiLinkConnectionContext.Provider>
    </MichiLinkScope>
  );

  it('opens the thread on that connection', () => {
    render(onBuildBox('See [Phone layout](michi://node/n4).'));
    fireEvent.click(screen.getByRole('button', { name: 'Phone layout' }));
    expect(revealNode).toHaveBeenCalledWith('remote:build-box:n4', { workspaceId: 'remote:build-box:w4' });
    expect(persistence.fetchNodeWorkspace).not.toHaveBeenCalled();
  });

  it('never asks this machine about one of its threads the store lacks', async () => {
    render(onBuildBox('See [Made since](michi://node/n3).'));
    const chip = screen.getByRole('button', { name: /Made since/ });
    fireEvent.click(chip);
    await waitFor(() => expect(chip.textContent).toContain("couldn't load"));
    expect(chip.textContent).not.toContain('not found');
    expect(persistence.fetchNodeWorkspace).not.toHaveBeenCalled();
  });

  it("leaves a link to another connection's thread as its words", () => {
    render(onBuildBox('Was on [their laptop](michi://node/remote:laptop:n1).'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(screen.getByText(/their laptop/)).toBeTruthy();
  });

  it('opens a page on the backend its id names', () => {
    render(<>
      {onBuildBox('See [Leftovers](michi://page/pg-6).')}
      <MichiLinkScope><MarkdownContent text={'And [Plan](michi://page/remote:build-box:pg-7?block=b2).'} /></MichiLinkScope>
    </>);
    fireEvent.click(screen.getByRole('button', { name: 'Leftovers' }));
    expect(pages.openSpacesPage).toHaveBeenLastCalledWith({ pageId: 'remote:build-box:pg-6', backendConnectionId: 'build-box' });
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(pages.openSpacesPage).toHaveBeenLastCalledWith({ pageId: 'remote:build-box:pg-7', backendConnectionId: 'build-box', blockId: 'b2' });
  });
});
