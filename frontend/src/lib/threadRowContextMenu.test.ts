import { vi } from 'vitest';
import { buildThreadRowContextMenu, confirmMoveThreadsToTrash } from './threadRowContextMenu';

const confirmDialog = vi.hoisted(() => vi.fn(async (_opts: { message: string }) => true));
vi.mock('../components/ui/ConfirmDialog', () => ({ confirmDialog }));
beforeEach(() => confirmDialog.mockClear());

function baseArgs(overrides: Partial<Parameters<typeof buildThreadRowContextMenu>[0]> = {}) {
  const actions = {
    activateTree: vi.fn(),
    archiveTree: vi.fn(),
    unarchiveTree: vi.fn(),
    renameTree: vi.fn(),
    deleteTree: vi.fn(),
    exportTree: vi.fn(),
  };
  return {
    treeId: 't1',
    tree: { id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 0 },
    actions,
    ...overrides,
  };
}

describe('confirmMoveThreadsToTrash', () => {
  it('asks once, in the same words, for one thread or several', async () => {
    await confirmMoveThreadsToTrash(1);
    await confirmMoveThreadsToTrash(3);
    expect(confirmDialog.mock.calls.map(([opts]) => opts)).toEqual([
      { title: 'Move to trash', message: 'Move this thread to trash?', confirmLabel: 'Move' },
      { title: 'Move to trash', message: 'Move 3 threads to trash?', confirmLabel: 'Move' },
    ]);
  });
});

describe('buildThreadRowContextMenu', () => {

  it('asks in the app’s confirm dialog, then wires Delete to actions.deleteTree', async () => {
    const native = vi.spyOn(window, 'confirm');
    const args = baseArgs();
    const sections = buildThreadRowContextMenu(args);
    const del = sections.flatMap((s) => s.items).find((i) => i.label === 'Delete thread…')!;
    confirmDialog.mockResolvedValueOnce(false);
    del.run();
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    expect(confirmDialog.mock.calls[0][0]).toMatchObject({ message: 'Move this thread to trash?' });
    await Promise.resolve();
    expect(args.actions.deleteTree).not.toHaveBeenCalled();

    del.run();
    await vi.waitFor(() => expect(args.actions.deleteTree).toHaveBeenCalledWith('t1'));
    expect(native).not.toHaveBeenCalled();
    native.mockRestore();
  });

  it('names each action, following the thread’s pinned and archived state', () => {
    const args = baseArgs();
    const actions = { ...args.actions, beginInlineRename: vi.fn(), pinTree: vi.fn(), unpinTree: vi.fn(), openMoveDialog: vi.fn() };
    const ids = (over: Partial<Parameters<typeof buildThreadRowContextMenu>[0]>) =>
      buildThreadRowContextMenu({ ...args, actions, moveTargets: [{ id: 'ws-b', name: 'Beta' }], ...over })
        .flatMap((s) => s.items.map((i) => i.id));
    expect(ids({})).toEqual(['rename', 'pin', 'archive', 'export', 'move', 'delete']);
    expect(ids({ tree: { ...args.tree, pinnedAt: 1, archivedAt: 2 } }))
      .toEqual(['rename', 'unpin', 'unarchive', 'export', 'move', 'delete']);
    expect(ids({ treeSelection: new Set(['t1', 't2']) })).toEqual(['archive', 'export', 'clear', 'delete']);
  });

  it('offers Rename only to a surface that can rename inline', () => {
    const labels = (args: ReturnType<typeof baseArgs>) =>
      buildThreadRowContextMenu(args).flatMap((s) => s.items.map((i) => i.label));
    expect(labels(baseArgs())).not.toContain('Rename…');
    const beginInlineRename = vi.fn();
    const args = baseArgs();
    const rename = buildThreadRowContextMenu({ ...args, actions: { ...args.actions, beginInlineRename } })
      .flatMap((s) => s.items).find((i) => i.label === 'Rename…')!;
    rename.run();
    expect(beginInlineRename).toHaveBeenCalledWith('t1');
  });

  it('exposes a single Move-to-workspace item that opens the picker dialog', () => {
    const openMoveDialog = vi.fn();
    const sections = buildThreadRowContextMenu(
      baseArgs({
        moveTargets: [
          { id: 'ws-a', name: 'Alpha' },
          { id: 'ws-b', name: 'Beta' },
        ],
        actions: {
          activateTree: vi.fn(),
          archiveTree: vi.fn(),
          unarchiveTree: vi.fn(),
          renameTree: vi.fn(),
          deleteTree: vi.fn(),
          exportTree: vi.fn(),
                openMoveDialog,
        },
      }),
    );
    const item = sections.flatMap((s) => s.items).find((i) => i.label === 'Move to workspace…')!;
    expect(item).toBeDefined();
    item.run();
    expect(openMoveDialog).toHaveBeenCalledTimes(1);
  });

  describe('multi-select', () => {
    it('batch Archive calls archiveTree for each selected tree and clears selection', () => {
      const clearTreeSelection = vi.fn();
      const args = baseArgs({
        treeId: 't1',
        treeSelection: new Set(['t1', 't2']),
        clearTreeSelection,
      });
      const sections = buildThreadRowContextMenu(args);
      const archive = sections.flatMap((s) => s.items).find((i) => i.label === 'Archive 2 threads')!;
      archive.run();
      expect(args.actions.archiveTree).toHaveBeenCalledWith('t1');
      expect(args.actions.archiveTree).toHaveBeenCalledWith('t2');
      expect(clearTreeSelection).toHaveBeenCalled();
    });

    it('batch Delete calls deleteTree for each selected tree after confirm', async () => {
      const clearTreeSelection = vi.fn();
      const args = baseArgs({
        treeId: 't1',
        treeSelection: new Set(['t1', 't2']),
        clearTreeSelection,
      });
      const sections = buildThreadRowContextMenu(args);
      const del = sections.flatMap((s) => s.items).find((i) => i.label === 'Delete 2 threads…')!;
      del.run();
      await vi.waitFor(() => expect(clearTreeSelection).toHaveBeenCalled());
      expect(confirmDialog.mock.calls[0][0]).toMatchObject({ message: 'Move 2 threads to trash?' });
      expect(args.actions.deleteTree).toHaveBeenCalledWith('t1');
      expect(args.actions.deleteTree).toHaveBeenCalledWith('t2');
    });
  });
});
