import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { ChatNodeState, Project } from './chatTypes';
import type { PaneItem } from './paneItems';
import { newestUndoAt, resetUndoStackForTests, undoLatest } from './undoStack';
import { useUndoableActions, type RawUndoableActions, type UndoableActionState } from './undoableActions';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));

function node(nodeId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, projectId: 'w1', title: nodeId.toUpperCase(), kind: 'chat', status: 'idle', messages: [], ...extra } as ChatNodeState;
}
function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id === 'w1' ? 'Work' : 'Home', chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1, ...extra };
}

function rawActions(): RawUndoableActions {
  return {
    archiveTree: vi.fn(() => true), unarchiveTree: vi.fn(() => true), deleteTree: vi.fn(() => 'del-1'), restoreDeletion: vi.fn(() => 'a'),
    moveTreeToWorkspace: vi.fn(async () => true), renameNode: vi.fn(), renameTree: vi.fn(),
    pinTree: vi.fn(), unpinTree: vi.fn(), pinNode: vi.fn(), unpinNode: vi.fn(), pinProject: vi.fn(), unpinProject: vi.fn(),
    deleteNode: vi.fn(() => 'del-2'), trimNode: vi.fn(() => 'trim-1'), archiveNode: vi.fn(() => 'arch-1'),
    renameProject: vi.fn(), archiveProject: vi.fn(), unarchiveProject: vi.fn(), deleteProject: vi.fn(), restoreProject: vi.fn(),
    closePane: vi.fn(), restorePaneInSlot: vi.fn(), registerPaneItem: vi.fn(), revealNode: vi.fn(() => true),
    selectProject: vi.fn(), activateTree: vi.fn(), clearTreeSelection: vi.fn(),
  };
}

let state: UndoableActionState;
let raw: RawUndoableActions;
function setup(overrides: Partial<UndoableActionState> = {}) {
  return renderHook(() => useUndoableActions(raw, { ...state, ...overrides })).result;
}

beforeEach(() => {
  resetUndoStackForTests();
  vi.mocked(toast).mockClear();
  raw = rawActions();
  state = {
    projectsRef: { current: [
      project('w1', { chatIds: ['a', 'b'], trees: [{ id: 't1', rootNodeId: 'a' }, { id: 't2', rootNodeId: 'b' }] as Project['trees'], activeTreeId: 't1' }),
      project('w2'),
    ] },
    nodesRef: { current: { a: node('a', { title: 'Plan' }), b: node('b', { title: 'Notes' }) } },
    activeProjectIdRef: { current: 'w1' },
    paneItemsRef: { current: {} },
    slotPanes: ['a', 'page-1', 'b'],
    focusedPane: 'page-1',
    treeSelection: new Set(['t1', 't2']),
  };
});

describe('useUndoableActions', () => {
  it('archives a thread with a toast, and its undo unarchives it and shows it again when it was on screen', async () => {
    const actions = setup();
    act(() => { actions.current.archiveTree('t1'); });
    expect(raw.archiveTree).toHaveBeenCalledWith('t1');
    expect(toast).toHaveBeenCalledWith('Archived “Plan”', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }));
    await undoLatest();
    expect(raw.unarchiveTree).toHaveBeenCalledWith('t1');
    expect(raw.revealNode).toHaveBeenCalledWith('a');
  });

  it('records nothing when the action did not act', () => {
    vi.mocked(raw.archiveTree).mockReturnValue(false);
    vi.mocked(raw.deleteTree).mockReturnValue(null);
    const actions = setup();
    act(() => { actions.current.archiveTree('t1'); actions.current.deleteTree('t2'); });
    expect(newestUndoAt()).toBeNull();
  });

  it('undoes a delete by restoring its group, without moving the user when it was not on screen', async () => {
    const actions = setup();
    act(() => { actions.current.deleteTree('t2'); });
    expect(toast).toHaveBeenCalledWith('Moved “Notes” to Trash', expect.anything());
    await undoLatest();
    expect(raw.restoreDeletion).toHaveBeenCalledWith('del-1');
    expect(raw.revealNode).not.toHaveBeenCalled();
  });

  it('moves a thread back to where it came from, through the newest move action', async () => {
    const { result, rerender } = renderHook(({ actions }) => useUndoableActions(actions, state), { initialProps: { actions: raw } });
    await act(async () => { await result.current.moveTreeToWorkspace('t2', 'w2'); });
    expect(toast).toHaveBeenCalledWith('Moved “Notes” to Home', expect.anything());
    // The store renders again, with actions that read the moved state, before the undo runs.
    const fresh = { ...raw, moveTreeToWorkspace: vi.fn(async () => true) };
    rerender({ actions: fresh });
    expect(await undoLatest()).toBe('undone');
    expect(fresh.moveTreeToWorkspace).toHaveBeenCalledWith('t2', 'w1');
    expect(raw.moveTreeToWorkspace).toHaveBeenCalledTimes(1);
    // The move back goes through the raw action, so nothing new lands on the history.
    expect(newestUndoAt()).toBeNull();
  });

  it('renames back to the old title, but has no title to go back to for an untitled thread', async () => {
    const actions = setup();
    act(() => { actions.current.renameTree('t1', 'Roadmap'); });
    expect(raw.renameNode).toHaveBeenCalledWith('a', 'Roadmap');
    await undoLatest();
    expect(raw.renameNode).toHaveBeenLastCalledWith('a', 'Plan');

    state.nodesRef.current.b = node('b', { title: undefined });
    act(() => { actions.current.renameNode('b', 'Named'); });
    expect(newestUndoAt()).toBeNull();
  });

  it('reopens a closed pane where it was, focused when it was, with its pane item', async () => {
    const item = { id: 'page-1', kind: 'page', title: 'Spec' } as unknown as PaneItem;
    state.paneItemsRef.current = { 'page-1': item };
    const actions = setup();
    act(() => { actions.current.closePane('page-1'); });
    expect(raw.closePane).toHaveBeenCalledWith('page-1');
    await undoLatest();
    expect(raw.registerPaneItem).toHaveBeenCalledWith(item);
    expect(raw.restorePaneInSlot).toHaveBeenCalledWith({ projectId: 'w1', treeId: 't1' }, 'page-1', 1, true);
    expect(raw.selectProject).not.toHaveBeenCalled();
    expect(raw.activateTree).not.toHaveBeenCalled();
  });

  it('records no undo for closing a terminal, whose shell ends with it', () => {
    state.paneItemsRef.current = { 'page-1': { id: 'page-1', kind: 'terminal' } as unknown as PaneItem };
    const actions = setup();
    act(() => { actions.current.closePane('page-1'); });
    expect(newestUndoAt()).toBeNull();
  });

  it('goes back to the thread a pane was closed in when it is no longer on screen', async () => {
    const actions = setup();
    act(() => { actions.current.closePane('b'); });
    state.projectsRef.current = state.projectsRef.current.map((p) => (p.id === 'w1' ? { ...p, activeTreeId: 't2' } : p));
    await undoLatest();
    expect(raw.restorePaneInSlot).toHaveBeenCalledWith({ projectId: 'w1', treeId: 't1' }, 'b', 2, false);
    expect(raw.activateTree).toHaveBeenCalledWith('t1', 'w1');
  });

  it('undoes a bulk archive in one step and clears the selection', async () => {
    const actions = setup();
    act(() => { actions.current.bulkArchiveTrees(); });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Archived 2 threads', expect.anything());
    expect(raw.clearTreeSelection).toHaveBeenCalled();
    await undoLatest();
    expect(vi.mocked(raw.unarchiveTree).mock.calls).toEqual([['t2'], ['t1']]);
    expect(await undoLatest()).toBe('empty');
  });

  it('puts an archived workspace back and returns to it when it was the active one', async () => {
    const actions = setup();
    act(() => { actions.current.archiveProject('w1'); });
    expect(toast).toHaveBeenCalledWith('Archived “Work”', expect.anything());
    await undoLatest();
    expect(raw.unarchiveProject).toHaveBeenCalledWith('w1');
    expect(raw.selectProject).toHaveBeenCalledWith('w1');
  });
});
