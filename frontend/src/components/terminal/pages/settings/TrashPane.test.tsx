import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState, Project } from '../../../../state/chatTypes';
import { TrashPane } from './TrashPane';
import { SettingsBackContext } from './settingsPhone';
import { buildTrashSections, deletionBucket, groupByBucket, groupsPastRetention, remainingDays } from '../trashModel';

const state = vi.hoisted(() => ({
  nodes: {} as Record<string, ChatNodeState>,
  projects: [] as Project[],
  ttl: 30,
  hydrated: true,
  restoreDeletion: vi.fn(), restoreProject: vi.fn(), purgeDeletionAsync: vi.fn(),
  emptyTrashAsync: vi.fn(), purgeProject: vi.fn(), selectProject: vi.fn(), openPane: vi.fn(), revealNode: vi.fn(() => true),
  confirm: vi.fn(), success: vi.fn(), fetchWorkspaceStructure: vi.fn(), fetchTreeMessagePage: vi.fn(), setPref: vi.fn(),
  listPageTrash: vi.fn(), restorePage: vi.fn(), purgePage: vi.fn(),
}));
vi.mock('../../../../state/chatStore', () => ({
  useChatStore: () => state,
  useChatNodesSnapshot: () => state.nodes,
  chatLabel: (node: ChatNodeState) => node.messages[0]?.text || 'Untitled thread',
}));
vi.mock('../../../../state/prefs', () => ({ usePrefs: () => ({ prefs: { trashTTLDays: state.ttl }, setPref: state.setPref }) }));
vi.mock('../../../../services/api', () => ({
  fetchWorkspaceStructure: (...args: unknown[]) => state.fetchWorkspaceStructure(...args),
  fetchTreeMessagePage: (...args: unknown[]) => state.fetchTreeMessagePage(...args),
}));
vi.mock('../../../../services/api/pages', () => ({ listPageTrash: (...args: unknown[]) => state.listPageTrash(...args), restorePage: (...args: unknown[]) => state.restorePage(...args), purgePage: (...args: unknown[]) => state.purgePage(...args) }));
vi.mock('../../../ui/ConfirmDialog', () => ({ confirmDialog: (...args: unknown[]) => state.confirm(...args) }));
vi.mock('sonner', () => ({ toast: { success: (...args: unknown[]) => state.success(...args) } }));

const now = Date.now();
const day = 86_400_000;
function node(nodeId: string, projectId: string, group: string | undefined, age: number, extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, projectId, title: nodeId, kind: 'chat', chatId: null, status: 'idle', messages: [], messagesLoaded: true, followUps: [], deletionGroupId: group, deletedAt: group ? now - age * day : undefined, ...extra } as ChatNodeState;
}
function project(id: string, name: string, deletedAt?: number): Project {
  return { id, name, chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1, deletedAt, cwd: `~/projects/${name}` };
}
function fixture() {
  state.projects = [project('m', 'michi'), project('f', 'designlab'), project('empty', 'TestCloud2', now - 8 * day), project('dead', 'Research', now - 3 * day)];
  state.nodes = {
    a: node('a', 'm', 'del-a', 0, { title: 'DeepSeek models', messages: [{ id: 'a-user', role: 'user', text: 'Compare these models.', toolCalls: [] }, { id: 'a-answer', role: 'assistant', text: '', blocks: [{ kind: 'answer', id: 'answer', rawText: 'A persisted answer.' }], toolCalls: [] }] } as Partial<ChatNodeState>),
    child: node('child', 'm', 'del-a', 28, { parentNodeId: 'a', messagesLoaded: false, messageCount: 7 }),
    b: node('b', 'm', 'del-b', 1.2, { title: 'michi notes' }),
    c: node('c', 'f', 'del-c', 0, { title: 'Design review' }),
    archived: node('archived', 'm', 'arch-never-trash', 3),
    gone: node('gone', 'dead', 'del-gone', 2, { title: 'Research thread' }),
    live: node('live', 'dead', undefined, 0, { title: 'Still in workspace' }),
  };
  // Pin each deletion to its calendar day whatever the time of day.
  const today = new Date(now).setHours(0, 0, 0, 0);
  state.nodes.a.deletedAt = now - 1;
  state.nodes.c.deletedAt = now - 2;
  state.nodes.b.deletedAt = today - 12 * 3_600_000;
  state.projects.forEach(item => { item.chatIds = Object.values(state.nodes).filter(node => node.projectId === item.id).map(node => node.nodeId); });
  state.projects[3].trees = [{ id: 'live-tree', rootNodeId: 'live', createdAt: 1, lastActiveAt: 1 }];
}
const rowKeys = () => Array.from(document.querySelectorAll('[data-history-key]')).map(row => row.getAttribute('data-history-key'));
beforeEach(() => {
  vi.clearAllMocks();
  fixture();
  state.ttl = 30;
  state.hydrated = true;
  state.confirm.mockResolvedValue(true);
  state.purgeDeletionAsync.mockResolvedValue({ purged: 1 });
  state.emptyTrashAsync.mockResolvedValue({ purged: 3 });
  state.purgeProject.mockResolvedValue(undefined);
  state.listPageTrash.mockResolvedValue([]);
  state.restorePage.mockResolvedValue(undefined);
  state.purgePage.mockResolvedValue(undefined);
  state.restoreDeletion.mockImplementation((id: string) => Object.values(state.nodes).find(node => node.deletionGroupId === id)?.nodeId ?? null);
});

describe('Trash data projection', () => {
  it('excludes archive groups, identifies subtree roots, and counts lazy messages without treating them as empty', () => {
    const sections = buildTrashSections(state.projects, state.nodes);
    const group = sections[0].groups.find(group => group.id === 'del-a')!;
    expect(group.root.nodeId).toBe('a');
    expect(group.members).toHaveLength(2);
    expect(group.messageCount).toBe(9);
    expect(sections.flatMap(section => section.groups).some(group => group.id.startsWith('arch-'))).toBe(false);
    // Three thread groups in live workspaces, two deleted workspaces.
    expect(sections.reduce((sum, section) => sum + (section.project.deletedAt ? 1 : section.groups.length), 0)).toBe(5);
    expect(remainingDays(group, 30, now)).toBe(2);
    expect(remainingDays(group, 0, now)).toBeNull();
  });

  it('groups by calendar day and finds the threads a shorter retention deletes at once', () => {
    const noon = new Date(2026, 10, 6, 12).getTime();
    expect(deletionBucket(noon - 3_600_000, noon)).toBe('Today');
    expect(deletionBucket(new Date(2026, 10, 5, 23, 59).getTime(), noon)).toBe('Yesterday');
    expect(deletionBucket(noon - 6 * day, noon)).toBe('Last 7 days');
    expect(deletionBucket(noon - 7 * day, noon)).toBe('Earlier');
    expect(groupByBucket([noon, noon - 1, noon - 2 * day, noon - 9 * day], ts => ts, noon).map(group => [group.bucket, group.items.length]))
      .toEqual([['Today', 2], ['Last 7 days', 1], ['Earlier', 1]]);
    const sections = buildTrashSections(state.projects, state.nodes);
    expect(groupsPastRetention(sections, 7, now).map(group => group.id)).toEqual(['del-a']);
    expect(groupsPastRetention(sections, 0, now)).toEqual([]);
  });
});

describe('Settings › Trash', () => {
  it('lists items newest first in time groups, with deleted workspaces as one item each', () => {
    render(<TrashPane />);
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(['Today 2', 'Yesterday 1', 'Last 7 days 1', 'Earlier 1']);
    expect(rowKeys()).toEqual(['thread:del-a', 'thread:del-c', 'thread:del-b', 'workspace:dead', 'workspace:empty']);
    expect(screen.queryByRole('button', { name: 'Research thread' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort deleted items' }), { target: { value: 'oldest' } });
    expect(rowKeys()[0]).toBe('workspace:empty');
    fireEvent.click(screen.getByRole('button', { name: 'Workspaces 2' }));
    expect(rowKeys()).toEqual(['workspace:empty', 'workspace:dead']);
  });

  it('lists and restores a native deleted page subtree through its owning backend', async () => {
    state.listPageTrash.mockResolvedValueOnce([{
      deletionGroupId: 'del-page', deletedAt: now - day,
      root: { id: 'page-1', workspaceId: 'm', title: 'Launch plan' },
      pages: [{ id: 'page-1', title: 'Launch plan' }, { id: 'page-2', title: 'Risks' }],
      databases: [],
    }]);
    render(<TrashPane />);
    expect(await screen.findByRole('button', { name: 'Launch plan' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Launch plan' }));
    await waitFor(() => expect(state.restorePage).toHaveBeenCalledWith('page-1', { backendConnectionId: 'local', workspaceId: 'm', pageId: 'page-1' }));
    expect(state.success).toHaveBeenCalledWith('Page restored');
  });

  it('searches titles and workspaces, highlights matches, and keeps the input through composition', () => {
    render(<TrashPane />);
    const input = screen.getByRole('searchbox', { name: 'Search Trash' });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'DeepSeek' } });
    fireEvent.compositionEnd(input);
    expect(screen.getByRole('searchbox')).toBe(input);
    expect(document.querySelector('mark')?.textContent).toBe('DeepSeek');
    expect(rowKeys()).toEqual(['thread:del-a']);
    fireEvent.change(input, { target: { value: 'designlab' } });
    expect(rowKeys()).toEqual(['thread:del-c']);
    fireEvent.change(input, { target: { value: '<no match>' } });
    expect(screen.getByRole('heading', { name: 'No matching items' })).toBeTruthy();
    expect(screen.getByText('Nothing in Trash matches "<no match>".')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('names a renamed thread by the name the user gave it, and finds it by that name', () => {
    state.projects[0].trees = [{ id: 'b-tree', rootNodeId: 'b', name: 'Release notes', createdAt: 1, lastActiveAt: 1 }];
    expect(buildTrashSections(state.projects, state.nodes)[0].groups.find(group => group.id === 'del-b')?.title).toBe('Release notes');
    render(<TrashPane />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Trash' }), { target: { value: 'release' } });
    expect(rowKeys()).toEqual(['thread:del-b']);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('keeps the search on the Esc that ends an IME composition (%o)', (ime) => {
    render(<TrashPane />);
    const input = screen.getByRole('searchbox', { name: 'Search Trash' });
    fireEvent.change(input, { target: { value: 'Deep' } });
    fireEvent.keyDown(input, { key: 'Escape', ...ime });
    expect(input).toHaveProperty('value', 'Deep');
  });

  it('warns about threads close to automatic deletion and shows only them on request', () => {
    render(<TrashPane />);
    expect(screen.getByText('1 thread will be deleted automatically within 3 days.')).toBeTruthy();
    expect(within(document.querySelector('[data-history-key="thread:del-a"]')!).getByText('2 days left')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    expect(rowKeys()).toEqual(['thread:del-a']);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(rowKeys()).toHaveLength(5);
  });

  it('asks before a shorter retention deletes older threads, and not otherwise', async () => {
    render(<TrashPane />);
    const retention = screen.getByRole('combobox', { name: 'Delete automatically' });
    state.confirm.mockResolvedValueOnce(false);
    fireEvent.change(retention, { target: { value: '7' } });
    await waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(1));
    expect(state.confirm.mock.calls[0][0].title).toBe('Delete 1 thread now?');
    expect(state.setPref).not.toHaveBeenCalled();
    fireEvent.change(retention, { target: { value: '7' } });
    await waitFor(() => expect(state.setPref).toHaveBeenCalledWith('trashTTLDays', 7));
    fireEvent.change(retention, { target: { value: '90' } });
    fireEvent.change(retention, { target: { value: '0' } });
    await waitFor(() => expect(state.setPref.mock.calls).toEqual([['trashTTLDays', 7], ['trashTTLDays', 90], ['trashTTLDays', 0]]));
    expect(state.confirm).toHaveBeenCalledTimes(2);
  });

  it('opens an item read-only inside the page, without opening a pane or fetching loaded messages', () => {
    render(<TrashPane />);
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek models' }));
    expect(screen.getByRole('heading', { level: 2, name: 'DeepSeek models' })).toBe(document.activeElement);
    expect(screen.getByText('A persisted answer.')).toBeTruthy();
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(screen.getByText(/^In 2 days · /)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state.fetchWorkspaceStructure).not.toHaveBeenCalled();
    expect(state.openPane).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.getByRole('searchbox', { name: 'Search Trash' })).toBeTruthy();
  });

  it('lets the phone’s header Back close an open item first', () => {
    let close: (() => void) | null = null;
    render(<SettingsBackContext.Provider value={(next) => { close = next; }}><TrashPane /></SettingsBackContext.Provider>);
    expect(close).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'michi notes' }));
    expect(close).not.toBeNull();
    act(() => close!());
    expect(screen.getByRole('searchbox', { name: 'Search Trash' })).toBeTruthy();
    expect(close).toBeNull();
  });

  it('restores a nested deletion together with its workspace but only opens it on the toast action', () => {
    const onNav = vi.fn();
    render(<TrashPane onNav={onNav} />);
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    fireEvent.click(screen.getByRole('button', { name: 'Research thread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore thread' }));
    expect(state.restoreProject).toHaveBeenCalledWith('dead');
    expect(state.restoreDeletion).toHaveBeenCalledWith('del-gone');
    expect(onNav).not.toHaveBeenCalled();
    state.success.mock.calls[0][1].action.onClick();
    // In its own thread: the shown slot belongs to another thread.
    expect(state.revealNode).toHaveBeenCalledWith('gone', { workspaceId: 'dead' });
    expect(state.openPane).not.toHaveBeenCalled();
    expect(onNav).toHaveBeenCalledWith('dashboard');
  });

  it('restores a workspace without restoring its independently trashed threads', () => {
    render(<TrashPane />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Research' }));
    expect(state.restoreProject).toHaveBeenCalledWith('dead');
    expect(state.restoreDeletion).not.toHaveBeenCalled();
  });

  it('acts on selected items together and confirms a permanent deletion once', async () => {
    render(<TrashPane />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select michi notes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Design review' }));
    expect(screen.getByRole('status').textContent).toBe('2 selected');
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    await waitFor(() => expect(state.purgeDeletionAsync.mock.calls).toEqual([['del-c'], ['del-b']]));
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.confirm.mock.calls[0][0].title).toBe('Delete 2 items permanently?');
    await waitFor(() => expect(state.success).toHaveBeenCalledWith('2 items permanently deleted'));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select DeepSeek models' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    expect(screen.getByRole('status').textContent).toBe('5 selected');
    fireEvent.keyDown(screen.getByRole('checkbox', { name: 'Clear selection' }), { key: 'Escape' });
    expect(screen.getByRole('searchbox', { name: 'Search Trash' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select DeepSeek models' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select michi notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(state.restoreDeletion.mock.calls).toEqual([['del-a'], ['del-b']]);
    expect(state.success).toHaveBeenLastCalledWith('2 items restored');
  });

  it('guards destructive operations, retains a failed thread row, and shows an inline error', async () => {
    let reject!: (error: Error) => void;
    state.purgeDeletionAsync.mockReturnValue(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    render(<TrashPane />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for michi notes' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently...' }));
    await waitFor(() => expect(state.purgeDeletionAsync).toHaveBeenCalledWith('del-b'));
    expect((screen.getByRole('button', { name: 'Restore Design review' }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.confirm.mock.calls[0][0].message).toContain('This cannot be undone');
    await act(async () => reject(new Error('Connection unavailable')));
    expect(screen.getByRole('alert').textContent).toContain('Connection unavailable');
    expect(screen.getByRole('button', { name: 'michi notes' })).toBeTruthy();
    expect(state.success).not.toHaveBeenCalled();
  });

  it('keeps an open item when its deletion is cancelled', async () => {
    state.confirm.mockResolvedValue(false);
    render(<TrashPane />);
    fireEvent.click(screen.getByRole('button', { name: 'michi notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete michi notes permanently' }));
    await waitFor(() => expect(state.confirm).toHaveBeenCalled());
    expect(state.purgeDeletionAsync).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 2, name: 'michi notes' })).toBeTruthy();
  });

  it('empties threads before whole workspaces and stops when a backend operation fails', async () => {
    const calls: string[] = [];
    state.emptyTrashAsync.mockImplementation(async () => { calls.push('threads'); });
    state.purgeProject.mockImplementation(async (id: string) => { calls.push(id); });
    render(<TrashPane />);
    fireEvent.click(screen.getByRole('button', { name: 'Empty Trash…' }));
    await waitFor(() => expect(state.success).toHaveBeenCalledWith('Trash emptied'));
    expect(calls).toEqual(['threads', 'empty', 'dead']);
    expect(state.confirm.mock.calls[0][0]).toMatchObject({ title: 'Empty Trash?', danger: true });
    state.emptyTrashAsync.mockRejectedValue(new Error('Purge unavailable'));
    state.purgeProject.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Empty Trash…' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Purge unavailable'));
    expect(state.purgeProject).not.toHaveBeenCalled();
  });

  it('shows loading until hydration finishes and never invents a retention deadline when disabled', () => {
    state.hydrated = false;
    state.ttl = 0;
    const view = render(<TrashPane />);
    expect(screen.getByRole('status', { name: 'Loading Trash' })).toBeTruthy();
    expect(screen.queryByText('Trash is empty')).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Delete automatically' }) as HTMLSelectElement).value).toBe('0');
    expect(screen.queryByText(/days left/)).toBeNull();
    state.hydrated = true;
    state.nodes = {};
    state.projects = [];
    view.rerender(<TrashPane />);
    expect(screen.getByRole('heading', { name: 'Trash is empty' })).toBeTruthy();
    expect(screen.getByText(/Nothing is deleted until you empty Trash/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Empty Trash…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('previews an unloaded thread from one page of it, not its workspace\'s bodies', async () => {
    state.nodes.b = { ...state.nodes.b, messagesLoaded: false, messageCount: 4 };
    state.fetchWorkspaceStructure.mockResolvedValue({ workspace: { id: 'm' }, nodes: [{ id: 'b', tree_id: 'tree-b', message_count: 45 }] });
    state.fetchTreeMessagePage.mockResolvedValue({
      messages: [{ id: 'm44', node_id: 'b', role: 'assistant', content: 'The newest answer.', seq: 44 }],
      pages: [{ nodeId: 'b', total: 45, before: { seq: 44, id: 'm44' } }],
    });
    render(<TrashPane />);
    fireEvent.click(screen.getByRole('button', { name: 'michi notes' }));
    await waitFor(() => expect(screen.getByText('The newest answer.')).toBeTruthy());
    expect(screen.getByText('Latest 20 of 45 messages')).toBeTruthy();
    expect(state.fetchTreeMessagePage).toHaveBeenCalledWith('m', 'tree-b', undefined, expect.any(AbortSignal), { nodeId: 'b', limit: 20 });
  });

  it('shows a retryable preview error instead of claiming unloaded messages are empty', async () => {
    state.nodes.b = { ...state.nodes.b, messagesLoaded: false, messageCount: 4 };
    state.fetchWorkspaceStructure.mockRejectedValueOnce(new Error('Preview unavailable')).mockReturnValue(new Promise(() => {}));
    render(<TrashPane />);
    fireEvent.click(screen.getByRole('button', { name: 'michi notes' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Preview unavailable'));
    expect(screen.queryByText('No messages in this thread.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(state.fetchWorkspaceStructure).toHaveBeenCalledTimes(2));
    const signal = state.fetchWorkspaceStructure.mock.calls[1][1] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'All items' }));
    await waitFor(() => expect(signal.aborted).toBe(true));
  });
});
