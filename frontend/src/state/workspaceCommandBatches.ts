import type { WorkspaceCommand } from '../services/api';

/**
 * Splitting one workspace's command batch into chunks the backend accepts,
 * and deciding what a rejected chunk means. Pure: the flush loop in
 * workspacePersistence owns the state.
 *
 * The backend runs each POST /workspaces/:id/commands in one transaction and
 * checks (backend/src/services/domainCommands.ts):
 * - per command: a node's tree exists and its parent is in the same tree; an
 *   edge's endpoints exist (branch/link: in one tree); a context's origin node
 *   exists; trees need their workspace row (foreign key);
 * - per batch: every upserted tree's root node is in that tree, and the
 *   workspace's active tree exists.
 * So a chunk keeps together what one batch must hold at its end, and chunks
 * run in dependency order: the workspace row (with its active tree), trees
 * (each with its root node's commands), nodes parents first (each node's
 * upsert, patches and view mark together), then edges and contexts, deletes
 * last (a tree delete cascades to whatever is still in that tree).
 */

/** What the backend accepts per batch when it does not say (domainCommands.ts). */
export const DEFAULT_MAX_COMMANDS_PER_BATCH = 500;
/** The largest group that must commit together is a workspace, a tree and its root (6); keep headroom. */
export const MIN_COMMANDS_PER_BATCH = 8;

export const COMMAND_RETRY_INITIAL_MS = 2_000;
export const COMMAND_RETRY_MAX_MS = 60_000;
/** A conflict that keeps coming back is shown after this long (it is retried meanwhile). */
export const COMMAND_CONFLICT_NOTICE_AFTER_MS = 120_000;

function entityId(command: WorkspaceCommand): string {
  return typeof command.payload.id === 'string' ? command.payload.id : '';
}

function stringField(command: WorkspaceCommand, field: string): string | undefined {
  const value = command.payload[field];
  return typeof value === 'string' && value ? value : undefined;
}

/** `commands` in dependency order, as chunks of at most `maxPerChunk` (a group larger than that goes alone). */
export function chunkWorkspaceCommands(commands: readonly WorkspaceCommand[], maxPerChunk: number): WorkspaceCommand[][] {
  const workspace: WorkspaceCommand[] = [];
  const trees = new Map<string, WorkspaceCommand[]>();
  const nodes = new Map<string, WorkspaceCommand[]>();
  const edgeUpserts: WorkspaceCommand[] = [];
  const contextUpserts: WorkspaceCommand[] = [];
  const deletes: Record<'edge.delete' | 'context.delete' | 'tree.delete', WorkspaceCommand[]> = {
    'edge.delete': [], 'context.delete': [], 'tree.delete': [],
  };
  for (const command of commands) {
    switch (command.type) {
      case 'workspace.upsert': workspace.push(command); break;
      case 'tree.upsert': trees.set(entityId(command), [...(trees.get(entityId(command)) ?? []), command]); break;
      case 'node.upsert':
      case 'node.patch': nodes.set(entityId(command), [...(nodes.get(entityId(command)) ?? []), command]); break;
      case 'edge.upsert': edgeUpserts.push(command); break;
      case 'context.upsert': contextUpserts.push(command); break;
      default: deletes[command.type].push(command);
    }
  }

  const parentOf = new Map<string, string>();
  for (const [nodeId, group] of nodes) {
    for (const command of group) {
      const parent = stringField(command, 'parent_node_id');
      if (parent) parentOf.set(nodeId, parent);
    }
  }

  const placed = new Set<string>();
  const activeTreeId = workspace.map((command) => stringField(command, 'active_tree_id')).find(Boolean);
  const treeUnits: WorkspaceCommand[][] = [];
  let activeTreeUnit: WorkspaceCommand[] = [];
  for (const [treeId, group] of trees) {
    const unit = [...group];
    // The batch that upserts a tree must hold its root in it.
    const rootId = group.map((command) => stringField(command, 'root_node_id')).find(Boolean);
    if (rootId && nodes.has(rootId) && !placed.has(rootId)) {
      placed.add(rootId);
      unit.push(...nodes.get(rootId)!);
    }
    if (treeId === activeTreeId) activeTreeUnit = unit;
    else treeUnits.push(unit);
  }

  const nodeUnits: WorkspaceCommand[][] = [];
  const visiting = new Set<string>();
  const visit = (nodeId: string) => {
    if (placed.has(nodeId) || visiting.has(nodeId) || !nodes.has(nodeId)) return;
    visiting.add(nodeId);
    const parent = parentOf.get(nodeId);
    if (parent) visit(parent);
    placed.add(nodeId);
    nodeUnits.push(nodes.get(nodeId)!);
  };
  for (const nodeId of nodes.keys()) visit(nodeId);

  const units: WorkspaceCommand[][] = [
    [...workspace, ...activeTreeUnit],
    ...treeUnits,
    ...nodeUnits,
    ...edgeUpserts.map((command) => [command]),
    ...contextUpserts.map((command) => [command]),
    ...deletes['edge.delete'].map((command) => [command]),
    ...deletes['context.delete'].map((command) => [command]),
    ...deletes['tree.delete'].map((command) => [command]),
  ].filter((unit) => unit.length > 0);

  const limit = Math.max(1, Math.floor(maxPerChunk));
  const chunks: WorkspaceCommand[][] = [];
  let current: WorkspaceCommand[] = [];
  for (const unit of units) {
    if (current.length > 0 && current.length + unit.length > limit) {
      chunks.push(current);
      current = [];
    }
    current.push(...unit);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export type CommandFailure =
  /** Unreachable, timed out, overloaded or a server fault: try again later. */
  | { kind: 'retry' }
  /** 409: the backend's state moved under this window; re-read and try again. */
  | { kind: 'conflict'; message: string }
  /** The batch was larger than the backend takes. */
  | { kind: 'too_many'; maxCommands?: number }
  /** Any other 4xx: sending the same writes again will fail the same way. */
  | { kind: 'rejected'; status: number; code?: string; message: string };

/** Pre-code backends say only this for an oversized batch (domainCommands.ts). */
const OLD_SIZE_LIMIT_TEXT = /at most (\d+) items/;

export function classifyCommandFailure(error: unknown): CommandFailure {
  const failure = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown; detail?: { maxCommands?: unknown } } | null;
  // Anything but an answered request (a network error, a dropped connection) is transient.
  if (!failure || failure.name !== 'WorkspaceCommandsError' || typeof failure.status !== 'number') return { kind: 'retry' };
  const { status } = failure;
  const code = typeof failure.code === 'string' ? failure.code : undefined;
  const message = typeof failure.message === 'string' ? failure.message : `HTTP ${status}`;
  if (status >= 500 || status === 408 || status === 429) return { kind: 'retry' };
  if (status === 409) return { kind: 'conflict', message };
  const reported = failure.detail?.maxCommands;
  if (code === 'too_many_commands') {
    return { kind: 'too_many', ...(typeof reported === 'number' && reported > 0 ? { maxCommands: reported } : {}) };
  }
  const old = status === 400 && (code === undefined || code === 'invalid_commands') ? OLD_SIZE_LIMIT_TEXT.exec(message) : null;
  if (old) return { kind: 'too_many', maxCommands: Number(old[1]) };
  if (status >= 400 && status < 500) return { kind: 'rejected', status, ...(code ? { code } : {}), message };
  return { kind: 'retry' };
}

/** Wait before retry number `failures` (1-based): 2 s doubling to a minute. */
export function commandRetryDelay(failures: number): number {
  return Math.min(COMMAND_RETRY_MAX_MS, COMMAND_RETRY_INITIAL_MS * 2 ** Math.max(0, failures - 1));
}

/** The chunk size to use after a chunk of `sent` commands was refused as too large. */
export function smallerCommandLimit(sent: number, current: number, reported?: number): number {
  const target = reported !== undefined && reported < sent ? reported : Math.floor(sent / 2);
  return Math.max(MIN_COMMANDS_PER_BATCH, Math.min(current, target));
}
