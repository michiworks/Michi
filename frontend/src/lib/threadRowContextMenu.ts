import type { MenuItem, MenuSection } from '../components/ContextMenu';
import { confirmDialog } from '../components/ui/ConfirmDialog';
import type { Tree } from '../state/chatStore';
import type { MoveTargetWorkspace } from '../state/moveTargets';

export interface ThreadRowActions {
  activateTree: (id: string) => void;
  archiveTree: (id: string) => void;
  unarchiveTree: (id: string) => void;
  pinTree?: (id: string) => void;
  unpinTree?: (id: string) => void;
  renameTree: (id: string, name: string) => void;
  deleteTree: (id: string) => void;
  exportTree: (id: string) => void;
  /** Flip the thread row into inline-rename mode. Implemented by the UI;
   *  without it the menu offers no Rename. */
  beginInlineRename?: (id: string) => void;
  /** Move this thread to another workspace. Omit when no other workspace is
   *  available (the menu item is dropped). The picker UI lives elsewhere —
   *  this callback is invoked once the user has chosen a target. */
  moveToWorkspace?: (targetProjectId: string) => void;
  /** Open the move-to-workspace picker dialog. When omitted (or no targets
   *  are available) the menu item is dropped. */
  openMoveDialog?: () => void;
}

/** The one way to ask before moving threads to trash, from a row menu or a selection bar. */
export function confirmMoveThreadsToTrash(count: number): Promise<boolean> {
  return confirmDialog({
    title: 'Move to trash',
    message: count === 1 ? 'Move this thread to trash?' : `Move ${count} threads to trash?`,
    confirmLabel: 'Move',
  });
}

export interface BuildThreadRowArgs {
  treeId: string;
  tree: Tree;
  actions: ThreadRowActions;
  /** Other workspaces this thread can be moved to. When empty or absent the
   *  "Move to workspace" section is omitted. */
  moveTargets?: readonly MoveTargetWorkspace[];
  /** Current multi-selection of tree IDs. When the right-clicked tree is in
   *  this set and the set has ≥2 members, the menu shows batch actions for
   *  the entire selection (matching Finder / treeContextMenu behavior). */
  treeSelection?: ReadonlySet<string>;
  /** Callback to clear the selection after a batch action completes. */
  clearTreeSelection?: () => void;
}

export function buildThreadRowContextMenu(args: BuildThreadRowArgs): MenuSection[] {
  const { treeId, tree, actions, moveTargets, treeSelection, clearTreeSelection } = args;

  // Multi-select path: if the right-clicked tree is in the selection and there
  // are ≥2 selected, show batch operations on the whole selection.
  const targetIsSelected = treeSelection?.has(treeId) ?? false;
  const isMulti = targetIsSelected && (treeSelection?.size ?? 0) >= 2;

  if (isMulti) {
    const scope = Array.from(treeSelection!);
    const count = scope.length;
    const sections: MenuSection[] = [
      {
        items: [
          {
            id: 'archive',
            label: `Archive ${count} threads`,
            keys: 'A',
            run: () => {
              for (const id of scope) actions.archiveTree(id);
              clearTreeSelection?.();
            },
          },
          {
            id: 'export',
            label: `Export ${count} threads…`,
            keys: 'E',
            run: () => {
              for (const id of scope) actions.exportTree(id);
              clearTreeSelection?.();
            },
          },
        ],
      },
      {
        items: [
          {
            id: 'clear',
            label: 'Clear selection',
            keys: 'esc',
            run: () => clearTreeSelection?.(),
          },
          {
            id: 'delete',
            label: `Delete ${count} threads…`,
            danger: true,
            keys: 'D',
            run: () => {
              void confirmMoveThreadsToTrash(count).then((ok) => {
                if (!ok) return;
                for (const id of scope) actions.deleteTree(id);
                clearTreeSelection?.();
              });
            },
          },
        ],
      },
    ];
    return sections;
  }

  // Single-target path (original behavior).
  const archived = !!tree.archivedAt;
  const pinned = !!tree.pinnedAt;
  const items: MenuItem[] = actions.beginInlineRename
    ? [{ id: 'rename', label: 'Rename…', keys: 'R', run: () => actions.beginInlineRename!(treeId) }]
    : [];
  if (actions.pinTree && actions.unpinTree) {
    items.push(
      pinned
        ? { id: 'unpin', label: 'Unpin', keys: 'P', run: () => actions.unpinTree!(treeId) }
        : { id: 'pin', label: 'Pin', keys: 'P', run: () => actions.pinTree!(treeId) },
    );
  }
  items.push(
    archived
      ? { id: 'unarchive', label: 'Unarchive', keys: 'A', run: () => actions.unarchiveTree(treeId) }
      : { id: 'archive', label: 'Archive', keys: 'A', run: () => actions.archiveTree(treeId) },
    { id: 'export', label: 'Export this thread…', keys: 'E', run: () => actions.exportTree(treeId) },
  );
  const sections: MenuSection[] = [{ items }];

  if (moveTargets && moveTargets.length > 0 && actions.openMoveDialog) {
    sections[0].items.push({
      id: 'move',
      label: 'Move to workspace…',
      keys: 'M',
      run: () => actions.openMoveDialog!(),
    });
  }

  sections.push({
    items: [
      {
        id: 'delete',
        label: 'Delete thread…',
        danger: true,
        keys: 'D',
        run: () => {
          void confirmMoveThreadsToTrash(1).then((ok) => { if (ok) actions.deleteTree(treeId); });
        },
      },
    ],
  });
  return sections;
}
