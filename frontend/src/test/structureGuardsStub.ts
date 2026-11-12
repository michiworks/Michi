import type { StructureEditGuards } from '../state/structureMerge';

/** Guards of a window with no edit the backend has not confirmed. */
export const quietStructureGuards = (overrides: Partial<StructureEditGuards> = {}): StructureEditGuards => ({
  workspaceFieldEdited: () => false,
  treeFieldEdited: () => false,
  nodeFieldEdited: () => false,
  pendingDeletes: () => ({ treeIds: new Set(), edgeIds: new Set() }),
  pendingEdgeUpserts: () => new Set(),
  heldByBackendBefore: () => false,
  ...overrides,
});

/** A structure read that began at 1 000 ms, in such a window. */
export const quietStructureRead = { readStartedAt: 1_000, guards: quietStructureGuards() };
