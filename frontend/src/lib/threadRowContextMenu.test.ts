import { vi } from 'vitest';
import { toast } from 'sonner';
import { buildThreadRowContextMenu } from './threadRowContextMenu';
import { recordUndo, resetUndoStackForTests, undoLatest } from '../state/undoStack';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn((_message: string, options?: { id?: string }) => options?.id), { error: vi.fn(), dismiss: vi.fn() }) }));
beforeEach(() => { resetUndoStackForTests(); vi.mocked(toast).mockClear(); });

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

describe('buildThreadRowContextMenu', () => {

  it('moves the thread to Trash at once from Delete thread', () => {
    const args = baseArgs();
    const sections = buildThreadRowContextMenu(args);
    sections.flatMap((s) => s.items).find((i) => i.label === 'Delete thread')!.run();
    expect(args.actions.deleteTree).toHaveBeenCalledWith('t1');
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

    it('batch Delete moves every selected thread to Trash at once, with one Undo toast for them all', async () => {
      const clearTreeSelection = vi.fn();
      const restored: string[] = [];
      // As the app's deleteTree does, each move records its own Undo toast.
      const deleteTree = vi.fn((id: string) => { recordUndo({ label: `Moved ${id} to Trash`, toast: true, undo: () => { restored.push(id); } }); });
      const args = baseArgs({ treeId: 't1', treeSelection: new Set(['t1', 't2']), clearTreeSelection });
      const sections = buildThreadRowContextMenu({ ...args, actions: { ...args.actions, deleteTree } });
      sections.flatMap((s) => s.items).find((i) => i.label === 'Delete 2 threads')!.run();
      expect(deleteTree).toHaveBeenCalledWith('t1');
      expect(deleteTree).toHaveBeenCalledWith('t2');
      expect(clearTreeSelection).toHaveBeenCalled();
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledWith('Moved 2 threads to Trash', expect.anything());
      expect(await undoLatest()).toBe('undone');
      expect(restored).toEqual(['t2', 't1']);
    });
  });
});
