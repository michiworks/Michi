import type { MenuItem, MenuSection } from '../components/ContextMenu';
import { confirmDialog } from '../components/ui/ConfirmDialog';
import type { Project } from '../state/chatTypes';

/** The ids of the menu's items, for surfaces that pick items by action (the
 *  phone page hides some for an archived workspace). */
export type WorkspaceRowActionId =
  | 'manage'
  | 'folder'
  | 'rename'
  | 'pin'
  | 'unpin'
  | 'archive'
  | 'unarchive'
  | 'delete';

type WorkspaceRowMenuItem = MenuItem & { id: WorkspaceRowActionId };

export interface WorkspaceRowActions {
  archiveProject: (projectId: string) => void;
  unarchiveProject: (projectId: string) => void;
  pinProject: (projectId: string) => void;
  unpinProject: (projectId: string) => void;
  deleteProject: (projectId: string) => void;
  /** Flip the workspace row into inline-rename mode. Implemented by the UI. */
  beginInlineRename: (projectId: string) => void;
  /** Open the Workspace Manage page for the given workspace id. */
  openManageWorkspace: (projectId: string) => void;
  /** Ask the desktop shell to bind a different absolute folder. */
  changeFolder?: (projectId: string) => void;
  /** Ask for confirmation in the caller's own UI; without it, Delete asks
   *  in the app's confirm dialog and deletes. */
  requestDelete?: (projectId: string) => void;
}

export interface BuildWorkspaceRowArgs {
  project: Project;
  actions: WorkspaceRowActions;
}

export function buildWorkspaceRowContextMenu(
  args: BuildWorkspaceRowArgs,
): MenuSection[] {
  const { project, actions } = args;
  const archived = !!project.archivedAt;
  const pinned = !!project.pinnedAt;
  const sections: Array<{ items: WorkspaceRowMenuItem[] }> = [
    {
      items: [
        {
          id: 'manage',
          label: 'Manage workspace',
          keys: 'M',
          run: () => actions.openManageWorkspace(project.id),
        },
        ...(actions.changeFolder ? [{
          id: 'folder' as const,
          label: project.cwd ? 'Change folder…' : 'Link folder…',
          run: () => actions.changeFolder!(project.id),
        }] : []),
      ],
    },
    {
      items: [
        {
          id: 'rename',
          label: 'Rename…',
          keys: 'R',
          run: () => actions.beginInlineRename(project.id),
        },
        pinned
          ? { id: 'unpin', label: 'Unpin', keys: 'P', run: () => actions.unpinProject(project.id) }
          : { id: 'pin', label: 'Pin', keys: 'P', run: () => actions.pinProject(project.id) },
        archived
          ? {
              id: 'unarchive',
              label: 'Unarchive',
              keys: 'A',
              run: () => actions.unarchiveProject(project.id),
            }
          : {
              id: 'archive',
              label: 'Archive',
              keys: 'A',
              run: () => actions.archiveProject(project.id),
            },
      ],
    },
    {
      items: [
        {
          id: 'delete',
          label: 'Delete workspace…',
          danger: true,
          keys: 'D',
          run: () => {
            if (actions.requestDelete) {
              actions.requestDelete(project.id);
              return;
            }
            void confirmDialog({
              title: 'Delete workspace',
              message: `Delete "${project.name}" and all its threads? You can restore it from Trash.`,
              confirmLabel: 'Delete',
            }).then((ok) => { if (ok) actions.deleteProject(project.id); });
          },
        },
      ],
    },
  ];
  return sections;
}
