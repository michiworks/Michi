import { withCommandReceipt } from './commandReceipts';
import { mergeLegacyComposerDraft, mergeWindowComposerDraft } from 'michi-shared';
import { getDb, runAfterCommit, runInTransaction } from './db';
import { DomainError, type DomainErrorDetails } from './domainErrors';
import { log } from './logger';
import { assertActiveTree, assertEdgePlacement, assertTreeRoot, resolveNodeTree } from './nodePlacement';
import { nodePlacementRepository } from './nodePlacementRepository';
import { currentStructureOrigin, recordNodeRowChange } from './structureEvents';
import { createTakeoverBridges, noteTakeoverBridges, takeoverBridged, type TakeoverBridges } from './takeoverBridges';
import {
  contextTombstoneWorkspace,
  deleteContext,
  deleteEdge,
  deleteTree,
  getNode,
  getWorkspace,
  listTrees,
  markNodeCompletionSeen,
  markNodeViewed,
  saveContext,
  saveEdge,
  saveNode,
  saveTree,
  saveWorkspace,
  type ContextRow,
} from './dbRepository';
import { publishNodeCompletionSeen, type NodeCompletionSeen } from './attentionSignals';

export type WorkspaceCommandType =
  | 'workspace.upsert'
  | 'tree.upsert'
  | 'tree.delete'
  | 'node.upsert'
  | 'node.patch'
  | 'edge.upsert'
  | 'edge.delete'
  | 'context.upsert'
  | 'context.delete';

export interface WorkspaceCommand {
  type: WorkspaceCommandType;
  payload: Record<string, unknown>;
}

export interface ApplyWorkspaceCommandsInput {
  operationId: string;
  commands: readonly WorkspaceCommand[];
  ownerUserId?: string | null;
  /**
   * 'id': the sending window matches the artifacts it is told about by id
   * only, never one to another by name (frontend chatReducers.ts since
   * 743b240fe), so none of its deletes is an id takeover (see takenOver).
   * Absent from older windows, whose deletes are checked.
   */
  artifactIdentity?: 'id';
}

export interface ApplyWorkspaceCommandsResult {
  operationId: string;
  applied: Array<{ type: WorkspaceCommandType; id: string }>;
  /**
   * Artifacts the batch upserted that were deleted (context_tombstones): those
   * commands were skipped, not applied, and the sender should drop its copies.
   * Present only when non-empty; an older backend never sends it.
   */
  goneContextIds?: string[];
  /**
   * Artifacts the batch upserted under a name another artifact of the
   * workspace holds: a stale window's write, skipped, not applied. They are
   * alive, so the sender keeps them and only drops those writes. Present only
   * when non-empty; an older backend failed the batch instead (a 500).
   */
  nameTakenContextIds?: string[];
}

function readId(payload: Record<string, unknown>, label: string): string {
  const id = payload.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 160) {
    throw new DomainError('invalid_argument', 'invalid_entity_id', `${label}.id must be a non-empty string <=160 chars`);
  }
  return id;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function updatedComposerDraft(raw: string | null | undefined, payload: Record<string, unknown>): string | null {
  const draft = optionalString(payload.composer_draft);
  if (!('composer_draft_window_id' in payload)) return mergeLegacyComposerDraft(raw, draft);
  const windowId = payload.composer_draft_window_id;
  if (typeof windowId !== 'string' || !windowId || windowId.length > 160) {
    throw new DomainError('invalid_argument', 'invalid_composer_window', 'composer_draft_window_id must be a non-empty string <=160 chars');
  }
  return mergeWindowComposerDraft(raw, windowId, draft);
}

/** The keys a view-mark-only patch may carry (see node.patch below). */
const VIEW_MARK_KEYS: ReadonlySet<string> = new Set(['id', 'viewed_at', 'seen_completion_seq']);

/**
 * The completion count a focused window had on screen, sent with the view
 * mark it belongs to (migration 0064). Undefined when the patch carries none.
 */
function readSeenCompletionSeq(payload: Record<string, unknown>): number | undefined {
  if (!('seen_completion_seq' in payload)) return undefined;
  const seen = payload.seen_completion_seq;
  if (typeof seen !== 'number' || !Number.isSafeInteger(seen) || seen < 0) {
    throw new DomainError('invalid_argument', 'invalid_seen_completion_seq', 'seen_completion_seq must be a non-negative integer');
  }
  if (!('viewed_at' in payload)) {
    throw new DomainError('invalid_argument', 'invalid_seen_completion_seq', 'seen_completion_seq is only accepted with viewed_at');
  }
  return seen;
}


function assertOwnedWorkspace(workspaceId: string, ownerUserId?: string | null): void {
  if (process.env.MICHI_CLOUD !== '1') return;
  const workspace = getWorkspace(workspaceId);
  if (workspace && workspace.owner_user_id !== ownerUserId) throw new DomainError('not_found', 'workspace_not_found', 'workspace not found');
}

function commandEntityId(command: WorkspaceCommand): string {
  return readId(command.payload, command.type);
}

function entityWorkspaceMismatch(table: 'trees' | 'edges' | 'contexts', id: string): DomainError {
  return new DomainError('conflict', 'entity_workspace_mismatch', `${table.slice(0, -1)} ${id} belongs to a different workspace`);
}

function assertEntityWorkspace(
  table: 'trees' | 'edges' | 'contexts',
  id: string,
  workspaceId: string,
): void {
  const row = getDb().prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`)
    .get(id) as { workspace_id: string } | undefined;
  if (row && row.workspace_id !== workspaceId) throw entityWorkspaceMismatch(table, id);
}

/**
 * assertEntityWorkspace for an artifact, its tombstone included: one deleted
 * from another workspace answers exactly as a live one there does, so a batch
 * never learns what was deleted elsewhere (in cloud mode, another user's).
 * True when it was deleted from this workspace (context_tombstones).
 */
function assertContextWorkspace(id: string, workspaceId: string): boolean {
  assertEntityWorkspace('contexts', id, workspaceId);
  const deletedFrom = contextTombstoneWorkspace(id);
  if (deletedFrom !== null && deletedFrom !== workspaceId) throw entityWorkspaceMismatch('contexts', id);
  return deletedFrom !== null;
}

function originConflict(of: 'node' | 'message'): DomainError {
  return new DomainError('conflict', 'context_origin_workspace_mismatch', `context origin ${of} must belong to the same workspace`);
}

/**
 * The origin a context.upsert of artifact `id` stores. A thread of this
 * workspace purged since (deleted for good, its messages with it) leaves the
 * artifact without one instead of failing the batch, a 409 its sender would
 * meet on every retry with every later write of the workspace behind it.
 *
 * So does, for an artifact this workspace already holds, a thread not there
 * at all (its tombstone collected, its tree deleted) that this batch does not
 * upsert: no window changes an artifact's origin once made, so that is the
 * origin it was made with (or one dropped here before), gone since.
 *
 * Anything else that does not resolve in this workspace stays a conflict:
 * another workspace's thread, live or purged (as assertEntityWorkspace
 * treats it); the origin of a new artifact that is not there; and a thread
 * this batch upserts only after the artifact.
 */
function contextOrigin(
  id: string,
  workspaceId: string,
  payload: Record<string, unknown>,
  batchNodeIds: ReadonlySet<string>,
): { nodeId: string | null; messageId: string | null } {
  const nodeId = optionalString(payload.origin_node_id);
  const messageId = optionalString(payload.origin_message_id);
  const none = { nodeId: null, messageId: null };
  if (nodeId) {
    const node = getDb().prepare('SELECT workspace_id, purged_at FROM nodes WHERE id = ?')
      .get(nodeId) as { workspace_id: string; purged_at: number | null } | undefined;
    if (node && node.workspace_id === workspaceId && node.purged_at != null) return none;
    if (!node && !batchNodeIds.has(nodeId) && getDb().prepare('SELECT 1 FROM contexts WHERE id = ?').get(id)) return none;
    if (!node || node.workspace_id !== workspaceId || node.purged_at != null) throw originConflict('node');
  }
  if (messageId) {
    const message = getDb().prepare(`
      SELECT n.workspace_id FROM messages m JOIN nodes n ON n.id = m.node_id WHERE m.id = ?
    `).get(messageId) as { workspace_id: string } | undefined;
    if (!message || message.workspace_id !== workspaceId) throw originConflict('message');
  }
  return { nodeId, messageId };
}

/** The most commands one batch may carry; GET /persistence/capabilities advertises it. */
export const MAX_COMMANDS_PER_BATCH = 500;

/**
 * A bridge for an older window's takeover (see takenOver) that one flush
 * split over two chunks: the chunk with its upsert skipped it (gone or
 * name-taken), and the next ones carry its delete (a flush sends upserts
 * first). The batch that skipped such an upsert notes the live artifacts
 * holding its name, ignoring case, as those windows matched names; the same
 * sender's next delete of one of them is that takeover's, skipped once, and
 * spends the entry. Not noted: a holder the batch itself deletes or writes
 * (its delete was decided there, and a window that writes it holds it under
 * its own id), and a name no live artifact holds.
 *
 * A sender is one window (X-Michi-Window-Id: every frontend that splits a
 * flush sets it on its writes; 739d9639f added it before 2b3119891 added
 * the chunks) or one unload's beacons, which carry no header: an older
 * frontend names its beacon chunks `unload-<workspace>-<ms>-<chunk>`, one
 * stamp per unload of a workspace. Any other batch notes nothing, so no two
 * windows share a bridge.
 *
 * The bridges hold for thirty seconds: chunks go one after another, each as
 * soon as the previous one is answered (sendCommandBatch), and an unload's
 * beacons all at once, so the next one lands within a second (a few through
 * a remote). That covers it with room, and the first retries of a failed
 * chunk too (backoff 2, 4, 8 s), while a user's own delete of the artifact
 * afterwards (a new action, then the next flush) seldom lands within it.
 *
 * Kept per database, in this process only (a restart between two chunks
 * loses it), per owner and bounded (takeoverBridges.ts).
 */
/** An older frontend's unload beacon operation id: its unload (workspace and stamp), then the chunk. */
const UNLOAD_BEACON_OPERATION = /^(unload-.+-\d{13})-\d{1,4}$/;
const takeoverBridgesByDb = new WeakMap<object, TakeoverBridges>();

/** Who sent an older window's batch, for its bridges; undefined: one that notes none. */
function takeoverBridgeSender(workspaceId: string, windowId: string | undefined, operationId: string): string | undefined {
  if (windowId) return JSON.stringify([workspaceId, 'window', windowId]);
  const unload = UNLOAD_BEACON_OPERATION.exec(operationId);
  return unload ? JSON.stringify([workspaceId, 'unload', unload[1]]) : undefined;
}

function takeoverBridgesOfDb(): TakeoverBridges {
  const db = getDb();
  let bridges = takeoverBridgesByDb.get(db);
  if (!bridges) {
    bridges = createTakeoverBridges();
    takeoverBridgesByDb.set(db, bridges);
  }
  return bridges;
}

/** Which command of a batch failed, for its sender to find it: index, type and id, never payload content. */
function commandContext(index: number, command: unknown): DomainErrorDetails {
  const { type, payload } = (command && typeof command === 'object' ? command : {}) as { type?: unknown; payload?: unknown };
  const id = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).id : undefined;
  return {
    commandIndex: index,
    ...(typeof type === 'string' ? { commandType: type.slice(0, 64) } : {}),
    ...(typeof id === 'string' && id.trim() && id.length <= 160 ? { entityId: id } : {}),
  };
}

function namingFailedCommand<T>(commands: readonly WorkspaceCommand[], failing: { index: number }, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof DomainError) || failing.index < 0) throw error;
    throw new DomainError(error.kind, error.code, error.message,
      { ...error.details, ...commandContext(failing.index, commands[failing.index]) });
  }
}

export function applyWorkspaceCommands(
  workspaceId: string,
  input: ApplyWorkspaceCommandsInput,
): ApplyWorkspaceCommandsResult {
  if (typeof input.operationId !== 'string' || !input.operationId.trim() || input.operationId.length > 200) {
    throw new DomainError('invalid_argument', 'invalid_operation_id', 'operationId must be a non-empty string <=200 chars');
  }
  if (!Array.isArray(input.commands)) {
    throw new DomainError('invalid_argument', 'invalid_commands', `commands must be an array of at most ${MAX_COMMANDS_PER_BATCH} items`);
  }
  if (input.commands.length > MAX_COMMANDS_PER_BATCH) {
    // Its own code: the client must split the batch, not drop it as malformed.
    throw new DomainError('invalid_argument', 'too_many_commands', `commands must be an array of at most ${MAX_COMMANDS_PER_BATCH} items`,
      { maxCommands: MAX_COMMANDS_PER_BATCH });
  }
  for (const [index, command] of input.commands.entries()) {
    if (!command || typeof command !== 'object' || typeof command.type !== 'string'
      || !command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) {
      throw new DomainError('invalid_argument', 'invalid_command', 'each command must have a type and object payload', commandContext(index, command));
    }
  }
  // Nodes this batch upserts (see contextOrigin).
  const batchNodeIds = new Set(input.commands.flatMap((command) =>
    command.type === 'node.upsert' && typeof command.payload.id === 'string' ? [command.payload.id] : []));
  // Each artifact's last command in this batch (see upsertContext).
  const lastContextCommand = new Map<string, number>();
  for (const [index, command] of input.commands.entries()) {
    if ((command.type === 'context.upsert' || command.type === 'context.delete') && typeof command.payload.id === 'string') {
      lastContextCommand.set(command.payload.id, index);
    }
  }
  // Seen marks are announced only once the batch has committed.
  const seenMarks: NodeCompletionSeen[] = [];
  const markViewed = (nodeId: string, viewedAt: number, seenCompletionSeq: number | undefined): void => {
    markNodeViewed(nodeId, workspaceId, viewedAt);
    if (seenCompletionSeq === undefined) return;
    const seen = markNodeCompletionSeen(nodeId, workspaceId, seenCompletionSeq);
    if (seen !== null) seenMarks.push({ workspaceId, nodeId, seenCompletionSeq: seen });
  };
  // The command being applied, so a failure can name it.
  const failing = { index: -1 };
  const result = namingFailedCommand(input.commands, failing, () => runInTransaction(() => {
    // A busy retry runs the batch again from the start.
    seenMarks.length = 0;
    failing.index = -1;
    assertOwnedWorkspace(workspaceId, input.ownerUserId);
    return withCommandReceipt({
      ledgerId: workspaceId, operationId: input.operationId,
      request: { workspaceId, commands: input.commands }, now: Date.now(),
    }, () => {
      const applied: ApplyWorkspaceCommandsResult['applied'] = [];
      const goneContextIds = new Set<string>();
      const nameTakenContextIds = new Set<string>();
      // Upserts waiting for a name a later command of the batch may free.
      const waitingForName: number[] = [];
      const matchesById = input.artifactIdentity === 'id';
      // An older window's batch: the ids it upserts artifacts under each name,
      // ignoring case, and the name of each (see takenOver).
      const upsertIdsByName = new Map<string, Set<string>>();
      const upsertNameById = new Map<string, string>();
      if (!matchesById) {
        for (const { type, payload } of input.commands) {
          if (type !== 'context.upsert' || typeof payload.id !== 'string') continue;
          const name = String(payload.name ?? '');
          upsertNameById.set(payload.id, name);
          const ids = upsertIdsByName.get(name.toLowerCase()) ?? new Set<string>();
          ids.add(payload.id);
          upsertIdsByName.set(name.toLowerCase(), ids);
        }
      }
      // The sender of an older window's batch (the route names its window,
      // X-Michi-Window-Id), whose earlier chunks may have left bridges, kept
      // under the workspace's owner (only the owner writes to a workspace).
      const sender = matchesById ? undefined : takeoverBridgeSender(workspaceId, currentStructureOrigin(), input.operationId);
      const bridgeOwner = input.ownerUserId ?? '';
      const bridges = sender === undefined ? undefined : takeoverBridgesByDb.get(getDb());
      // Bridges this batch used, spent once it commits.
      const spentBridges = new Set<string>();
      let takenOverDeletes = 0;
      /**
       * Whether context.delete of `id` is an older window's id takeover, not a
       * delete. An older frontend's reducer matched a reported artifact to the
       * one holding its name, ignoring case, and gave that one the reported
       * id, keeping its other fields: a reconnect replaying the save of A,
       * deleted since, rewrote the id of C, which took A's name after, to A.
       * Diffing by id, its flush upserts A under C's name and deletes C. Before
       * tombstones the upsert failed the batch on the name and C survived; now
       * that upsert is skipped (gone, or held by C) and the delete would lose C
       * for good, its tombstone included. Whether A was deleted before 0081 or
       * its tombstone was collected, or A is live elsewhere, makes no
       * difference to that window, so none is required here.
       *
       * So in a batch of such a window (no artifactIdentity) a live artifact is
       * not deleted when the batch upserts another artifact under its name,
       * ignoring case as those windows matched names, or when an earlier chunk
       * of the same flush skipped such an upsert while this artifact held its
       * name (a bridge, see takeoverBridgeSender). The upsert then stays
       * held and is answered name-taken, or gone. A user's own "delete notes,
       * make a new notes" in one flush of such a window keeps the old one
       * too: for an exact name that batch failed whole before (a 500 retried
       * forever), and a delete that did not land can be made again; a lost
       * artifact cannot be had back.
       *
       * A window that matches artifacts by id only says so (artifactIdentity
       * 'id'): it never re-keys one, so its deletes are never checked.
       */
      const takenOver = (id: string): boolean => {
        if (matchesById) return false;
        const live = getDb().prepare('SELECT name FROM contexts WHERE id = ? AND workspace_id = ?')
          .get(id, workspaceId) as { name: string } | undefined;
        if (!live) return false;
        const key = live.name.toLowerCase();
        for (const other of upsertIdsByName.get(key) ?? []) if (other !== id) return true;
        if (!bridges || sender === undefined || !takeoverBridged(bridges, bridgeOwner, sender, id, Date.now())) return false;
        spentBridges.add(id);
        return true;
      };
      /**
       * The live artifacts holding, ignoring case, the names of these skipped
       * upserts, per lowercased name and the exact name first, other than
       * those this batch deletes or writes (see takeoverBridgeSender).
       */
      const takeoverHolders = (skipped: Iterable<string>): Map<string, string[]> => {
        const exactNames = new Map<string, Set<string>>();
        for (const id of skipped) {
          const name = upsertNameById.get(id);
          if (name === undefined) continue;
          exactNames.set(name.toLowerCase(), (exactNames.get(name.toLowerCase()) ?? new Set<string>()).add(name));
        }
        const holders = new Map<string, string[]>();
        if (exactNames.size === 0) return holders;
        const live = getDb().prepare('SELECT id, name FROM contexts WHERE workspace_id = ?').all(workspaceId) as Array<{ id: string; name: string }>;
        for (const { id, name } of live) {
          const key = name.toLowerCase();
          const exact = exactNames.get(key);
          if (!exact || lastContextCommand.has(id)) continue;
          const ids = holders.get(key) ?? [];
          if (exact.has(name)) ids.unshift(id);
          else ids.push(id);
          holders.set(key, ids);
        }
        return holders;
      };
      /**
       * context.upsert of `id`: 'written', 'gone' or the artifact holding its
       * name. A deleted artifact is skipped (goneContextIds). So is one under a
       * name another artifact of the workspace holds: a stale window's write
       * (UNIQUE(workspace_id, name)), which would fail the whole batch, a 500
       * retried forever. The caller names it in nameTakenContextIds, never
       * gone: it is alive.
       *
       * The name is compared as that constraint compares it, exactly (`name =
       * ?`, BINARY, as the column declares no collation): "Foo" does not hold
       * "foo". Windows compare names ignoring case, so whatever they see as
       * free is free here too; skipping a case variant as well would drop a
       * write the backend accepts, of an artifact the workspace may already
       * hold beside one differing only in case (agents save names exactly).
       */
      const upsertContext = (id: string, payload: Record<string, unknown>): 'written' | 'gone' | { heldBy: string } => {
        if (payload.workspace_id !== workspaceId) throw new DomainError('conflict', 'context_workspace_mismatch', 'context must belong to route workspace');
        // Deleted (by the drawer or delete_artifact): a stale write of it is
        // skipped, not applied, and reported so its sender drops it. Checked
        // before its origin, which may have been purged since.
        if (assertContextWorkspace(id, workspaceId)) {
          goneContextIds.add(id);
          return 'gone';
        }
        const name = String(payload.name ?? '');
        const holder = getDb().prepare('SELECT id FROM contexts WHERE workspace_id = ? AND name = ? AND id <> ?')
          .get(workspaceId, name, id) as { id: string } | undefined;
        if (holder) return { heldBy: holder.id };
        const { nodeId: originNodeId, messageId: originMessageId } = contextOrigin(id, workspaceId, payload, batchNodeIds);
        saveContext({
          id,
          workspace_id: workspaceId,
          name,
          file_path: String(payload.file_path ?? ''),
          size: optionalNumber(payload.size),
          auto_inject: 0,
          source: optionalString(payload.source) ?? 'user',
          type: optionalString(payload.type),
          url: optionalString(payload.url),
          origin_node_id: originNodeId,
          origin_message_id: originMessageId,
          kind: optionalString(payload.kind),
          pinned_at: optionalNumber(payload.pinned_at),
          created_at: optionalNumber(payload.created_at) ?? Date.now(),
          updated_at: optionalNumber(payload.updated_at) ?? Date.now(),
        } as ContextRow, input.ownerUserId ?? undefined);
        return 'written';
      };
      const touchedTreeIds = new Set<string>();
      // Nodes stored in their parent's tree rather than the one the client sent.
      let treesSetFromParent = 0;
      for (const [index, command] of input.commands.entries()) {
        failing.index = index;
        const payload = command.payload;
        const id = commandEntityId(command);
        switch (command.type) {
          case 'workspace.upsert': {
            if (id !== workspaceId) throw new DomainError('conflict', 'workspace_id_mismatch', 'workspace command id must match route workspace');
            const existing = getWorkspace(workspaceId);
            saveWorkspace({
              id,
              name: typeof payload.name === 'string' && payload.name.trim() ? payload.name : existing?.name ?? 'Untitled',
              cwd: payload.cwd === undefined ? existing?.cwd ?? null : optionalString(payload.cwd),
              folders: payload.folders === undefined ? existing?.folders ?? null : optionalString(payload.folders),
              active_tree_id: payload.active_tree_id === undefined
                ? existing?.active_tree_id ?? null
                : optionalString(payload.active_tree_id),
              created_at: optionalNumber(payload.created_at) ?? existing?.created_at ?? Date.now(),
              updated_at: optionalNumber(payload.updated_at) ?? Date.now(),
              settings: payload.settings === undefined ? existing?.settings ?? null : optionalString(payload.settings),
              deleted_at: payload.deleted_at === undefined ? existing?.deleted_at ?? null : optionalNumber(payload.deleted_at),
              archived_at: payload.archived_at === undefined ? existing?.archived_at ?? null : optionalNumber(payload.archived_at),
              pinned_at: payload.pinned_at === undefined ? existing?.pinned_at ?? null : optionalNumber(payload.pinned_at),
              backend: existing?.backend ?? 'kiro',
              owner_user_id: input.ownerUserId ?? existing?.owner_user_id ?? null,
            });
            break;
          }
          case 'tree.upsert': {
            if (payload.workspace_id !== workspaceId) throw new DomainError('conflict', 'tree_workspace_mismatch', 'tree must belong to route workspace');
            assertEntityWorkspace('trees', id, workspaceId);
            touchedTreeIds.add(id);
            saveTree({
              id,
              workspace_id: workspaceId,
              root_node_id: String(payload.root_node_id ?? ''),
              name: optionalString(payload.name),
              archived_at: optionalNumber(payload.archived_at),
              pinned_at: optionalNumber(payload.pinned_at),
              last_active_at: optionalNumber(payload.last_active_at) ?? Date.now(),
              created_at: optionalNumber(payload.created_at) ?? Date.now(),
            }, input.ownerUserId ?? undefined);
            break;
          }
          case 'tree.delete':
            assertEntityWorkspace('trees', id, workspaceId);
            deleteTree(id, input.ownerUserId ?? undefined);
            break;
          case 'node.upsert': {
            if (payload.workspace_id !== workspaceId) throw new DomainError('conflict', 'node_workspace_mismatch', 'node must belong to route workspace');
            const existing = getNode(id);
            if (existing) {
              // An upsert writes nothing to a node that exists, so its placement is not checked here.
              if (existing.workspace_id !== workspaceId) {
                throw new DomainError('conflict', 'node_workspace_mismatch', `node ${id} belongs to a different workspace`);
              }
            } else {
              const parentId = optionalString(payload.parent_node_id);
              const sentTreeId = optionalString(payload.tree_id);
              const treeId = resolveNodeTree(workspaceId, sentTreeId, parentId, nodePlacementRepository);
              if (treeId !== sentTreeId) treesSetFromParent += 1;
              saveNode({
                id,
                workspace_id: workspaceId,
                tree_id: treeId,
                parent_node_id: parentId,
                kind: optionalString(payload.kind) ?? 'chat',
                title: optionalString(payload.title),
                status: 'idle',
                position_x: optionalNumber(payload.position_x),
                position_y: optionalNumber(payload.position_y),
                minimized: payload.minimized ? 1 : 0,
                deleted_at: optionalNumber(payload.deleted_at),
                deletion_group_id: optionalString(payload.deletion_group_id),
                spawned_by_agent: payload.spawned_by_agent ? 1 : 0,
                current_mode_id: optionalString(payload.current_mode_id),
                pane_width: optionalNumber(payload.pane_width),
                digest: optionalString(payload.digest),
                composer_draft: updatedComposerDraft(null, payload),
                trim_snapshot: optionalString(payload.trim_snapshot),
                pinned_at: optionalNumber(payload.pinned_at),
                created_at: optionalNumber(payload.created_at) ?? Date.now(),
              }, input.ownerUserId ?? undefined);
            }
            break;
          }
          case 'node.patch': {
            const node = getNode(id);
            const seenCompletionSeq = readSeenCompletionSeq(payload);
            if ('viewed_at' in payload) {
              const viewedAt = payload.viewed_at;
              if (typeof viewedAt !== 'number' || !Number.isFinite(viewedAt) || viewedAt <= 0) {
                throw new DomainError('invalid_argument', 'invalid_viewed_at', 'viewed_at must be a positive number');
              }
              // A view mark alone never fails the batch: the node may be gone or not yet written.
              if (Object.keys(payload).every((key) => VIEW_MARK_KEYS.has(key))) {
                if (node && node.workspace_id === workspaceId) markViewed(id, viewedAt, seenCompletionSeq);
                break;
              }
            }
            if (!node || node.workspace_id !== workspaceId) throw new DomainError('not_found', 'node_not_found', 'node not found');
            const sentTreeId = 'tree_id' in payload
              ? optionalString(payload.tree_id)
              : node.tree_id ?? null;
            const effectiveParentId = 'parent_node_id' in payload
              ? optionalString(payload.parent_node_id)
              : node.parent_node_id ?? null;
            // A child goes in its parent's tree, whatever tree the client derived for it.
            const effectiveTreeId = resolveNodeTree(workspaceId, sentTreeId, effectiveParentId, nodePlacementRepository);
            if ('tree_id' in payload && effectiveTreeId !== sentTreeId) treesSetFromParent += 1;
            const written: Record<string, unknown> = 'tree_id' in payload || effectiveTreeId !== (node.tree_id ?? null)
              ? { ...payload, tree_id: effectiveTreeId }
              : payload;
            const columns: Record<string, string> = {
              tree_id: 'tree_id', parent_node_id: 'parent_node_id', kind: 'kind',
              title: 'title', current_mode_id: 'current_mode_id', pane_width: 'pane_width',
              position_x: 'position_x', position_y: 'position_y', minimized: 'minimized',
              digest: 'digest', composer_draft: 'composer_draft', deleted_at: 'deleted_at',
              deletion_group_id: 'deletion_group_id', trim_snapshot: 'trim_snapshot',
              spawned_by_agent: 'spawned_by_agent', pinned_at: 'pinned_at',
            };
            const sets: string[] = [];
            const params: any[] = [];
            for (const [key, column] of Object.entries(columns)) {
              if (!(key in written)) continue;
              sets.push(`${column} = ?`);
              const value = key === 'composer_draft' ? updatedComposerDraft(node.composer_draft, payload) : written[key];
              params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value ?? null);
            }
            if (sets.length > 0) {
              params.push(id);
              getDb().prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
              const patched = (key: 'title' | 'deleted_at' | 'deletion_group_id', current: string | number | null | undefined) =>
                key in payload ? (payload[key] as string | number | null | undefined) ?? null : current ?? null;
              recordNodeRowChange(node, {
                id,
                workspace_id: node.workspace_id,
                tree_id: effectiveTreeId,
                parent_node_id: effectiveParentId,
                title: patched('title', node.title) as string | null,
                deleted_at: patched('deleted_at', node.deleted_at) as number | null,
                deletion_group_id: patched('deletion_group_id', node.deletion_group_id) as string | null,
              });
            }
            if (typeof payload.viewed_at === 'number') markViewed(id, payload.viewed_at, seenCompletionSeq);
            break;
          }
          case 'edge.upsert': {
            if (payload.workspace_id !== workspaceId) throw new DomainError('conflict', 'edge_workspace_mismatch', 'edge must belong to route workspace');
            assertEntityWorkspace('edges', id, workspaceId);
            const sourceNodeId = String(payload.source_node_id ?? '');
            const targetNodeId = String(payload.target_node_id ?? '');
            const kind = optionalString(payload.kind) ?? 'branch';
            assertEdgePlacement(workspaceId, { kind, sourceNodeId, targetNodeId }, nodePlacementRepository);
            saveEdge({
              id,
              workspace_id: workspaceId,
              source_node_id: sourceNodeId,
              target_node_id: targetNodeId,
              kind,
              anchor_message_id: optionalString(payload.anchor_message_id),
              created_at: optionalNumber(payload.created_at),
            }, input.ownerUserId ?? undefined);
            break;
          }
          case 'edge.delete':
            assertEntityWorkspace('edges', id, workspaceId);
            deleteEdge(id, input.ownerUserId ?? undefined);
            break;
          case 'context.upsert': {
            const outcome = upsertContext(id, payload);
            if (outcome === 'written') break;
            // A later command of its own artifact decides what becomes of it.
            if (outcome === 'gone' || lastContextCommand.get(id) !== index) continue;
            // A later command may free the name: a delete of its holder, or a
            // rename away (a flush sends upserts before deletes). Then this one
            // waits for the end of the batch.
            if ((lastContextCommand.get(outcome.heldBy) ?? -1) > index) waitingForName.push(index);
            else nameTakenContextIds.add(id);
            continue;
          }
          case 'context.delete':
            assertContextWorkspace(id, workspaceId);
            if (takenOver(id)) {
              takenOverDeletes += 1;
              continue;
            }
            deleteContext(id, input.ownerUserId ?? undefined);
            break;
          default:
            throw new DomainError('invalid_argument', 'unsupported_workspace_command', `unsupported workspace command ${(command as WorkspaceCommand).type}`);
        }
        applied.push({ type: command.type, id });
      }
      // Each pass writes the waiting upserts whose name is free by now (a chain
      // of renames frees one name after another); what no pass frees is taken.
      for (let waiting = waitingForName; waiting.length > 0;) {
        const held = waiting.filter((index) => {
          failing.index = index;
          const command = input.commands[index];
          const id = commandEntityId(command);
          if (upsertContext(id, command.payload) !== 'written') return true;
          applied.push({ type: command.type, id });
          return false;
        });
        if (held.length === waiting.length) {
          for (const index of held) nameTakenContextIds.add(commandEntityId(input.commands[index]));
          break;
        }
        waiting = held;
      }
      failing.index = -1;
      if (nameTakenContextIds.size > 0) log.warn('workspace', 'artifact writes skipped under a name another artifact holds', { count: nameTakenContextIds.size });
      if (takenOverDeletes > 0) log.warn('workspace', 'artifact deletes skipped: an older window gave their names to other artifacts', { count: takenOverDeletes });
      if (sender !== undefined) {
        const holders = takeoverHolders([...goneContextIds, ...nameTakenContextIds]);
        if (holders.size > 0 || spentBridges.size > 0) {
          runAfterCommit(() => noteTakeoverBridges(takeoverBridgesOfDb(), bridgeOwner, sender, holders, spentBridges, Date.now()));
        }
      }

        for (const treeId of touchedTreeIds) {
          const tree = getDb().prepare('SELECT id, workspace_id, root_node_id FROM trees WHERE id = ?')
            .get(treeId) as { id: string; workspace_id: string; root_node_id: string } | undefined;
          if (tree) assertTreeRoot(workspaceId, tree, nodePlacementRepository);
        }
        assertActiveTree(getWorkspace(workspaceId)?.active_tree_id, () => listTrees(workspaceId));

      // A client that derives trees differently from the backend is worth knowing about.
      if (treesSetFromParent > 0) log.warn('workspace', 'node trees set from their parents', { count: treesSetFromParent });
      getDb().prepare('UPDATE workspaces SET persistence_version = 2 WHERE id = ?').run(workspaceId);
      const result: ApplyWorkspaceCommandsResult = {
        operationId: input.operationId,
        applied,
        ...(goneContextIds.size > 0 ? { goneContextIds: [...goneContextIds] } : {}),
        ...(nameTakenContextIds.size > 0 ? { nameTakenContextIds: [...nameTakenContextIds] } : {}),
      };
      // A retry of this operation answers the same, gone and name-taken ids included.
      return result;
    });
  }));
  for (const mark of seenMarks) publishNodeCompletionSeen(mark);
  return result;
}
