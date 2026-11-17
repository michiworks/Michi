import { defineWindowEvent } from '../lib/windowEvents';
import type { PageId } from './commands';

/**
 * The app's window events, defined once each (lib/windowEvents). Every event
 * here has a dispatcher and a subscriber outside tests (appEvents.test.ts).
 */

/** Show a page of the terminal shell; 'settings' opens the Settings drawer. */
export const navPageEvent = defineWindowEvent<{ page: PageId }>('michi:nav-page', (detail) => {
  const page = (detail as { page?: unknown } | null)?.page;
  return typeof page === 'string' && page ? { page: page as PageId } : null;
});

/** Open the export panel: a thread, chosen nodes, or a digest's own text; the active thread without one. */
export interface ExportPanelRequest {
  projectId?: string;
  treeId?: string;
  nodeIds?: string[];
  digestNodeId?: string;
}

const id = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export const exportPanelEvent = defineWindowEvent<ExportPanelRequest>('michi:toggle-export-panel', (detail) => {
  if (!detail || typeof detail !== 'object') return {};
  const { projectId, treeId, nodeIds, digestNodeId } = detail as Record<string, unknown>;
  return {
    projectId: id(projectId),
    treeId: id(treeId),
    nodeIds: Array.isArray(nodeIds) ? nodeIds.filter((nodeId): nodeId is string => typeof nodeId === 'string' && !!nodeId) : undefined,
    digestNodeId: id(digestNodeId),
  };
});

/**
 * A notification's click (a toast, an OS notification, Electron main's
 * banner) is about to open its target. Overlays that would cover it leave:
 * the ones that only show something close, drawers in one frame (TR-39).
 * Dialogs holding the user's input do not listen.
 */
export const leaveOverlaysEvent = defineWindowEvent<Record<string, never>>('michi:leave-overlays', () => ({}));
