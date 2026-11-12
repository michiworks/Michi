import { getDb } from '../db';
import { recordNodeRowChange } from '../structureEvents';
import { mainThreadDb } from '../turnPersistence.mainAdapter';
import { appendBranchOverviewJournal as coreAppendBranchOverviewJournal } from '../turnPersistence.core';
import { isNodeTombstoned, isWorkspaceTombstoned } from './tombstones';

export interface NodeRow {
  /** Server-owned native Page helper binding; saveNode never accepts changes to it. */
  page_id?: string | null;
  /** Server-owned scheduled maintenance identity; graph snapshots cannot set or clear it. */
  maintenance_job_id?: string | null;
  /** Server-owned: the Scheduled-only job whose run made this thread (shown only in Scheduled). */
  scheduled_only_job_id?: string | null;
  id: string;
  workspace_id: string;
  tree_id?: string | null;
  parent_node_id?: string | null;
  kind: string;
  title?: string | null;
  branch_overview?: string | null;
  status: string;
  position_x?: number | null;
  position_y?: number | null;
  minimized: number;
  deleted_at?: number | null;
  deletion_group_id?: string | null;
  spawned_by_agent: number;
  current_mode_id?: string | null;
  /** Written only by the ordinary chat permission API. Graph snapshots cannot overwrite it. */
  permission_mode?: string | null;
  /** 1: Approve for me on top of permission_mode 'ask'. Written with permission_mode only. */
  permission_approve_for_me?: number | null;
  /** 1: the chat runs Ultracode (chatUltracode.ts). Server-owned like permission_mode. */
  ultracode?: number | null;
  crew_memory_mode?: string | null;
  pane_width?: number | null;
  digest?: string | null;
  follow_ups?: string | null;
  follow_ups_source_message_id?: string | null;
  acp_session_id?: string | null;
  runtime_id?: string | null;
  runtime_engine?: string | null;
  provider_id?: string | null;
  model_id?: string | null;
  reasoning?: string | null;
  resume_fingerprint?: string | null;
  composer_draft?: string | null;
  external_session_id?: string | null;
  /** JSON-encoded TrimSnapshot. Non-null iff the node was trimmed (single-node
   *  trash entry, not a subtree deletion). Carries the undo data for restore. */
  trim_snapshot?: string | null;
  last_applied_turn_id?: string | null;
  last_applied_seq?: number | null;
  /** Node-level UI pin (sidebar ordering within the sibling group). NULL =
   *  not pinned; otherwise Unix ms when pinned. See migration 0021. */
  pinned_at?: number | null;
  /** Tombstone — Unix ms when this node was permanently purged. Non-null rows
   *  are filtered out of reads and refused on write so a stale POST /sync from
   *  another tab cannot resurrect them. GC'd by `runTombstoneGc()` after
   *  TOMBSTONE_TTL_MS. See migration v16. */
  purged_at?: number | null;
  /** Fork provenance for an extracted thread (migration 0030). Server-owned:
   *  graph snapshots must not overwrite these; see setNodeForkProvenance. */
  forked_from_node_id?: string | null;
  fork_boundary_message_id?: string | null;
  /** Exact inherited prefix length; messages with seq < this are copied history. */
  inherited_message_count?: number;
  /** When the owner last had it on screen (migration 0042). Written only by markNodeViewed. */
  viewed_at?: number | null;
  /** Server-owned completion facts (migration 0064): turns that completed with an
   *  answer, and the latest of them. Written only when a turn finalizes. */
  completion_seq?: number;
  last_completed_at?: number | null;
  last_completed_turn_id?: string | null;
  /** Highest completion a focused window had on screen; written only by markNodeCompletionSeen. */
  seen_completion_seq?: number;
  /** Server-owned (migration 0067): the multi-model run that created this branch. Written only by
   *  services/multiModel/store.ts; graph snapshots cannot set or clear it. */
  multi_model_run_id?: string | null;
  /** Server-owned (migration 0067): 1 when the branch inherits no parent history (a fresh
   *  multi-model branch). Written only by services/multiModel/store.ts. */
  fresh_context?: number;
  created_at: number;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

// --- Node CRUD ---

export function listNodes(workspaceId: string, userId?: string): NodeRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    return getDb().prepare(
      `SELECT n.* FROM nodes n JOIN workspaces w ON n.workspace_id = w.id
       WHERE n.workspace_id = ? AND w.owner_user_id = ? AND n.purged_at IS NULL`,
    ).all(workspaceId, userId) as unknown as NodeRow[];
  }
  return getDb()
    .prepare('SELECT * FROM nodes WHERE workspace_id = ? AND purged_at IS NULL')
    .all(workspaceId) as unknown as NodeRow[];
}

export function getNode(id: string): NodeRow | null {
  return (
    (getDb().prepare('SELECT * FROM nodes WHERE id = ? AND purged_at IS NULL').get(id) as unknown as NodeRow)
    ?? null
  );
}

export function saveNode(node: NodeRow, userId?: string): void {
  const { permission_mode: _permissionMode, permission_approve_for_me: _approveForMe, crew_memory_mode: _crewMemoryMode, maintenance_job_id: _maintenanceJobId,
    scheduled_only_job_id: _scheduledOnlyJobId, viewed_at: _viewedAt, ultracode: _ultracode, completion_seq: _completionSeq, last_completed_at: _lastCompletedAt,
    last_completed_turn_id: _lastCompletedTurnId, seen_completion_seq: _seenCompletionSeq, multi_model_run_id: _multiModelRunId,
    fresh_context: _freshContext, ...graphNode } = node;
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    const owned = getDb().prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(node.workspace_id, userId);
    if (!owned) return;
  }
  // Tombstone guard — refuse to upsert any id that is tombstoned, OR whose
  // owning workspace is tombstoned. Multi-tab anti-revival bedrock: a stale
  // POST /sync from another tab can no longer undo a purge.
  if (isNodeTombstoned(node.id) || isWorkspaceTombstoned(node.workspace_id)) return;
  const existing = getDb().prepare(
    'SELECT workspace_id, tree_id, parent_node_id, title, deleted_at, deletion_group_id FROM nodes WHERE id = ?',
  ).get(node.id) as Pick<NodeRow, 'workspace_id' | 'tree_id' | 'parent_node_id' | 'title' | 'deleted_at' | 'deletion_group_id'> | undefined;

  // A child cloned from a scheduled maintenance transcript remains restricted.
  // Do not accept a client-provided marker; derive it only from the durable
  // server-owned parent row on insertion. Existing rows keep their marker via
  // the conflict clause below. A branch of a Scheduled-only run's thread
  // shows where its parent does, so it inherits that marker the same way.
  const parentMarkers = node.parent_node_id
    ? getDb().prepare('SELECT maintenance_job_id, scheduled_only_job_id FROM nodes WHERE id = ?').get(node.parent_node_id) as
      Pick<NodeRow, 'maintenance_job_id' | 'scheduled_only_job_id'> | undefined
    : undefined;
  const inheritedMaintenanceJobId = parentMarkers?.maintenance_job_id ?? null;
  // A lean window holds no value for a field it deferred (shared/leanNodeFields)
  // and leaves its key out: the stored column stays. An explicit null clears it.
  const keeps = (column: 'branch_overview' | 'follow_ups' | 'follow_ups_source_message_id' | 'composer_draft') =>
    (graphNode[column] === undefined ? 1 : 0);

  getDb().prepare(`
    INSERT INTO nodes (id, workspace_id, tree_id, parent_node_id, kind, title, branch_overview, status,
      position_x, position_y, minimized, deleted_at, deletion_group_id,
      spawned_by_agent, current_mode_id, pane_width, digest, follow_ups, follow_ups_source_message_id,
      acp_session_id, runtime_id,
      provider_id, model_id, reasoning, resume_fingerprint, composer_draft, external_session_id,
      trim_snapshot, last_applied_turn_id, last_applied_seq, pinned_at, created_at, rev, maintenance_job_id,
      scheduled_only_job_id)
    VALUES (@id, @workspace_id, @tree_id, @parent_node_id, @kind, @title, @branch_overview, @status,
      @position_x, @position_y, @minimized, @deleted_at, @deletion_group_id,
      @spawned_by_agent, @current_mode_id, @pane_width, @digest, @follow_ups, @follow_ups_source_message_id,
      @acp_session_id, @runtime_id,
      @provider_id, @model_id, @reasoning, @resume_fingerprint, @composer_draft, @external_session_id,
      @trim_snapshot, @last_applied_turn_id, @last_applied_seq, @pinned_at, @created_at, @rev, @maintenance_job_id,
      @scheduled_only_job_id)
    ON CONFLICT(id) DO UPDATE SET
      tree_id=excluded.tree_id, parent_node_id=excluded.parent_node_id,
      kind=excluded.kind, title=excluded.title,
      branch_overview=CASE WHEN @keep_branch_overview = 1 THEN nodes.branch_overview ELSE excluded.branch_overview END,
      status=excluded.status,
      position_x=excluded.position_x, position_y=excluded.position_y,
      minimized=excluded.minimized, deleted_at=excluded.deleted_at,
      deletion_group_id=excluded.deletion_group_id, spawned_by_agent=excluded.spawned_by_agent,
      current_mode_id=excluded.current_mode_id, pane_width=excluded.pane_width,
      digest=excluded.digest,
      follow_ups=CASE WHEN @keep_follow_ups = 1 THEN nodes.follow_ups ELSE excluded.follow_ups END,
      follow_ups_source_message_id=CASE WHEN @keep_follow_ups_source_message_id = 1
        THEN nodes.follow_ups_source_message_id ELSE excluded.follow_ups_source_message_id END,
      -- acp_session_id is minted server-side for Kiro. Preserve an existing
      -- binding when an older/newer frontend snapshot omits it or carries the
      -- public node id instead. updateNodeResumeBinding remains authoritative
      -- when a runtime intentionally re-binds the node.
      acp_session_id=COALESCE(nodes.acp_session_id, excluded.acp_session_id),
      -- Runtime ownership is also server-side. Agent-spawn can race a frontend
      -- graph snapshot that has not received runtime metadata yet; never let
      -- that nullable snapshot erase a binding persisted by the adapter.
      runtime_id=COALESCE(nodes.runtime_id, excluded.runtime_id),
      -- Keep the native id and its signature atomic. Delayed graph snapshots
      -- must not make ensure-session mistake the live model for a new choice.
      -- Explicit runtime/model changes go through updateNodeResumeBinding.
      provider_id=CASE WHEN nodes.acp_session_id IS NOT NULL OR nodes.external_session_id IS NOT NULL
        THEN nodes.provider_id ELSE excluded.provider_id END,
      model_id=CASE WHEN nodes.acp_session_id IS NOT NULL OR nodes.external_session_id IS NOT NULL
        THEN nodes.model_id ELSE excluded.model_id END,
      reasoning=CASE WHEN nodes.acp_session_id IS NOT NULL OR nodes.external_session_id IS NOT NULL
        THEN nodes.reasoning ELSE excluded.reasoning END,
      resume_fingerprint=excluded.resume_fingerprint,
      composer_draft=CASE WHEN @keep_composer_draft = 1 THEN nodes.composer_draft ELSE excluded.composer_draft END,
      -- external_session_id is minted server-side from claude system/init and is
      -- NOT carried in the frontend node sync payload (serializeNodeRow omits it).
      -- A plain excluded.external_session_id therefore clobbered the just-persisted
      -- claude session UUID back to NULL on the very next sync, permanently breaking
      -- native claude --resume (loadSession threw, then silent fresh+replay). COALESCE
      -- preserves the stored value when the incoming row omits it, matching the rev
      -- guard on this same statement. Only the binding writer can replace it.
      external_session_id=CASE WHEN nodes.acp_session_id IS NOT NULL OR nodes.external_session_id IS NOT NULL
        THEN nodes.external_session_id ELSE excluded.external_session_id END,
      trim_snapshot=excluded.trim_snapshot,
      last_applied_turn_id=excluded.last_applied_turn_id,
      last_applied_seq=excluded.last_applied_seq,
      pinned_at=excluded.pinned_at,
      maintenance_job_id=COALESCE(nodes.maintenance_job_id, excluded.maintenance_job_id),
      -- scheduled_only_job_id is set on insertion only: moving a run to its
      -- workspace clears it, and a snapshot must not bring it back.
      rev=COALESCE(excluded.rev, nodes.rev)
  `).run({
    tree_id: null,
    parent_node_id: null,
    title: null,
    position_x: null,
    position_y: null,
    deleted_at: null,
    deletion_group_id: null,
    current_mode_id: null,
    pane_width: null,
    digest: null,
    acp_session_id: null,
    runtime_id: null,
    provider_id: null,
    model_id: null,
    reasoning: null,
    resume_fingerprint: null,
    external_session_id: null,
    trim_snapshot: null,
    last_applied_turn_id: null,
    last_applied_seq: null,
    pinned_at: null,
    rev: null,
    maintenance_job_id: inheritedMaintenanceJobId,
    scheduled_only_job_id: parentMarkers?.scheduled_only_job_id ?? null,
    ...graphNode,
    // A left-out field inserts NULL; an existing row keeps its value (above).
    branch_overview: graphNode.branch_overview ?? null,
    follow_ups: graphNode.follow_ups ?? null,
    follow_ups_source_message_id: graphNode.follow_ups_source_message_id ?? null,
    composer_draft: graphNode.composer_draft ?? null,
    keep_branch_overview: keeps('branch_overview'),
    keep_follow_ups: keeps('follow_ups'),
    keep_follow_ups_source_message_id: keeps('follow_ups_source_message_id'),
    keep_composer_draft: keeps('composer_draft'),
  });
  // The upsert keeps the stored workspace; the graph columns take the new row's values.
  recordNodeRowChange(existing ?? null, {
    id: node.id,
    workspace_id: existing?.workspace_id ?? node.workspace_id,
    tree_id: node.tree_id ?? null,
    parent_node_id: node.parent_node_id ?? null,
    title: node.title ?? null,
    deleted_at: node.deleted_at ?? null,
    deletion_group_id: node.deletion_group_id ?? null,
  });
}

/**
 * Records that the owner had the node on screen at `viewedAt`. The mark only
 * moves forward, so a late or replayed write from another window cannot
 * reopen a conversation already seen; a time past `now` is held to `now`.
 * Returns false when the node is not a live node of that workspace.
 */
export function markNodeViewed(nodeId: string, workspaceId: string, viewedAt: number, now = Date.now()): boolean {
  const result = getDb().prepare(`UPDATE nodes SET viewed_at = MAX(COALESCE(viewed_at, 0), ?)
    WHERE id = ? AND workspace_id = ? AND purged_at IS NULL`)
    .run(Math.min(Math.trunc(viewedAt), now), nodeId, workspaceId);
  return Number(result.changes) === 1;
}

/**
 * Records that a focused window had the node's completions up to `seenSeq` on
 * screen. Like the view mark it only moves forward, and it is held to the
 * node's own completion count, so a window cannot mark a completion seen that
 * the server has not recorded. Returns the new seen count when it advanced,
 * else null (not a live node of that workspace, or nothing new was seen).
 */
export function markNodeCompletionSeen(nodeId: string, workspaceId: string, seenSeq: number): number | null {
  const seen = Math.trunc(seenSeq);
  const result = getDb().prepare(`UPDATE nodes SET seen_completion_seq = MIN(completion_seq, ?)
    WHERE id = ? AND workspace_id = ? AND purged_at IS NULL AND MIN(completion_seq, ?) > seen_completion_seq`)
    .run(seen, nodeId, workspaceId, seen);
  if (Number(result.changes) !== 1) return null;
  const row = getDb().prepare('SELECT seen_completion_seq FROM nodes WHERE id = ?')
    .get(nodeId) as { seen_completion_seq: number } | undefined;
  return row?.seen_completion_seq ?? null;
}

/** Assigns the server-owned maintenance identity before the scheduler opens a runtime. */
export function markNodeMaintenanceJob(nodeId: string, jobId: string): void {
  const result = getDb().prepare(`UPDATE nodes SET maintenance_job_id = ? WHERE id = ? AND kind = 'chat'
    AND (maintenance_job_id IS NULL OR maintenance_job_id = ?)`)
    .run(jobId, nodeId, jobId);
  if (Number(result.changes) !== 1) throw new Error('Could not mark scheduled maintenance node');
}

export function updateNodeTitle(id: string, title: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    getDb().prepare(
      'UPDATE nodes SET title = ? WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM nodes WHERE id = ?) AND owner_user_id = ?)'
    ).run(title, id, id, userId);
    return;
  }
  getDb().prepare('UPDATE nodes SET title = ? WHERE id = ?').run(title, id);
}

export function updateNodeBranchOverview(id: string, overview: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    const owned = getDb().prepare(
      'SELECT 1 FROM nodes WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM nodes WHERE id = ?) AND owner_user_id = ?)'
    ).get(id, id, userId);
    if (!owned) return;
  }
  coreAppendBranchOverviewJournal(mainThreadDb, id, overview);
}

/** Write the server-owned provenance for a materialized branch thread. */
export function setNodeForkProvenance(nodeId: string, provenance: {
  forkedFromNodeId?: string | null;
  forkBoundaryMessageId?: string | null;
  inheritedMessageCount: number;
}): void {
  getDb().prepare(`
    UPDATE nodes
    SET forked_from_node_id = ?, fork_boundary_message_id = ?, inherited_message_count = ?
    WHERE id = ?
  `).run(
    provenance.forkedFromNodeId ?? null,
    provenance.forkBoundaryMessageId ?? null,
    provenance.inheritedMessageCount,
    nodeId,
  );
}
