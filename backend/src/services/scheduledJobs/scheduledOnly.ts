import { SCHEDULED_ONLY_RETENTION } from 'michi-shared';
import { getDb, runInTransaction } from '../db';
import { purgeWorkspaceNodes } from '../dbRepository';
import { recordStructureChange } from '../structureEvents';

/**
 * Threads of Scheduled-only jobs (visibility 'scheduled'): which ones Michi
 * keeps, rotating a job's ongoing thread, and moving a run's thread into its
 * workspace. A thread is hidden while nodes.scheduled_only_job_id is set.
 */

type RetentionPolicy = typeof SCHEDULED_ONLY_RETENTION;

/**
 * A thread made moments ago may not be attached to its run yet
 * (ChatScheduledJobExecutor creates it before the scheduler records it).
 */
const UNATTACHED_GRACE_MS = 10 * 60_000;
const DELETED_JOB_SETUP_GRACE_MS = 60_000;

/** The runs whose thread retention keeps: the latest minRuns, and the latest maxRuns within maxAgeMs. */
export function keptRunIds(
  runs: ReadonlyArray<{ id: string; startedAt: number }>,
  now: number,
  policy: Pick<RetentionPolicy, 'maxRuns' | 'maxAgeMs' | 'minRuns'> = SCHEDULED_ONLY_RETENTION,
): Set<string> {
  const kept = new Set<string>();
  [...runs].sort((a, b) => b.startedAt - a.startedAt).forEach((run, index) => {
    if (index < policy.minRuns || (index < policy.maxRuns && now - run.startedAt <= policy.maxAgeMs)) kept.add(run.id);
  });
  return kept;
}

interface HiddenNodeRow {
  id: string;
  workspace_id: string;
  tree_id: string | null;
  created_at: number;
}

interface PruneOptions {
  now: number;
  /** Threads a live execution of this process holds; never deleted. */
  activeNodeIds?: ReadonlySet<string>;
}

/** A thread and its branches go together: one group per tree. */
function groupByTree(nodes: readonly HiddenNodeRow[]): HiddenNodeRow[][] {
  const groups = new Map<string, HiddenNodeRow[]>();
  for (const node of nodes) {
    const key = node.tree_id ?? `node:${node.id}`;
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }
  return [...groups.values()];
}

function purgeGroups(groups: readonly HiddenNodeRow[][]): number {
  const byWorkspace = new Map<string, string[]>();
  for (const node of groups.flat()) {
    const ids = byWorkspace.get(node.workspace_id) ?? [];
    ids.push(node.id);
    byWorkspace.set(node.workspace_id, ids);
  }
  let purged = 0;
  for (const [workspaceId, nodeIds] of byWorkspace) {
    purged += purgeWorkspaceNodes(workspaceId, nodeIds);
    const placeholders = nodeIds.map(() => '?').join(',');
    // The run stays in the history, without a thread to open.
    getDb().prepare(`UPDATE scheduled_job_runs SET node_id = NULL, tree_id = NULL WHERE node_id IN (${placeholders})`).run(...nodeIds);
  }
  return purged;
}

/**
 * Delete the hidden threads of `jobId` that retention no longer keeps: none of
 * their runs is kept or still running, and the job does not continue them.
 * Returns how many nodes were deleted.
 */
export function pruneScheduledOnlyThreads(jobId: string, { now, activeNodeIds = new Set() }: PruneOptions): number {
  const db = getDb();
  const job = db.prepare('SELECT persistent_node_id FROM scheduled_jobs WHERE id = ?').get(jobId) as
    { persistent_node_id: string | null } | undefined;
  if (!job) return 0;
  const runs = db.prepare('SELECT id, node_id, status, started_at FROM scheduled_job_runs WHERE job_id = ?').all(jobId) as
    Array<{ id: string; node_id: string | null; status: string; started_at: number }>;
  const kept = keptRunIds(runs.map((run) => ({ id: run.id, startedAt: run.started_at })), now);
  const keepNodes = new Set<string>(activeNodeIds);
  if (job.persistent_node_id) keepNodes.add(job.persistent_node_id);
  const referenced = new Set<string>();
  for (const run of runs) {
    if (!run.node_id) continue;
    referenced.add(run.node_id);
    if (kept.has(run.id) || run.status === 'running') keepNodes.add(run.node_id);
  }
  const nodes = db.prepare(`SELECT id, workspace_id, tree_id, created_at FROM nodes
    WHERE scheduled_only_job_id = ? AND purged_at IS NULL`).all(jobId) as unknown as HiddenNodeRow[];
  const doomed = groupByTree(nodes).filter((group) => {
    if (group.some((node) => keepNodes.has(node.id))) return false;
    // Not yet attached to a run: wait out the grace period.
    if (!group.some((node) => referenced.has(node.id))) {
      return group.every((node) => now - node.created_at > UNATTACHED_GRACE_MS);
    }
    return true;
  });
  return purgeGroups(doomed);
}

/** Delete the hidden threads of jobs that no longer exist. */
export function sweepDeletedJobThreads({ now, activeNodeIds = new Set() }: PruneOptions): number {
  const nodes = getDb().prepare(`SELECT n.id, n.workspace_id, n.tree_id, n.created_at FROM nodes n
    WHERE n.scheduled_only_job_id IS NOT NULL AND n.purged_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM scheduled_jobs j WHERE j.id = n.scheduled_only_job_id)`).all() as unknown as HiddenNodeRow[];
  const doomed = groupByTree(nodes).filter((group) => !group.some((node) => activeNodeIds.has(node.id))
    // A job deleted while a run was being set up: its executor may still hold
    // a thread it has not reported yet. A later sweep removes it.
    && group.every((node) => now - node.created_at > DELETED_JOB_SETUP_GRACE_MS));
  return purgeGroups(doomed);
}

/** Retention for every Scheduled-only job with hidden threads, then the deleted jobs' threads. */
export function pruneAllScheduledOnlyThreads(options: PruneOptions): number {
  const jobIds = (getDb().prepare(`SELECT DISTINCT scheduled_only_job_id AS job_id FROM nodes
    WHERE scheduled_only_job_id IS NOT NULL AND purged_at IS NULL`).all() as Array<{ job_id: string }>).map((row) => row.job_id);
  let purged = 0;
  for (const jobId of jobIds) purged += pruneScheduledOnlyThreads(jobId, options);
  return purged + sweepDeletedJobThreads(options);
}

/** Whether a thread shows only in Scheduled; false when unknown (database closing). */
export function isScheduledOnlyThread(nodeId: string | null): boolean {
  if (!nodeId) return false;
  try {
    return !!getDb().prepare('SELECT 1 FROM nodes WHERE id = ? AND scheduled_only_job_id IS NOT NULL AND purged_at IS NULL').get(nodeId);
  } catch {
    return false;
  }
}

/** How many runs used this thread (rotation of a Scheduled-only job's ongoing thread). */
function countRunsOnThread(nodeId: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS count FROM scheduled_job_runs WHERE node_id = ?').get(nodeId) as { count: number }).count;
}

/** Whether a Scheduled-only job's ongoing thread is full and the next run starts a new one. */
export function threadNeedsRotation(nodeId: string, policy: Pick<RetentionPolicy, 'rotateAfterRuns'> = SCHEDULED_ONLY_RETENTION): boolean {
  return countRunsOnThread(nodeId) >= policy.rotateAfterRuns;
}

const CARRY_OVER_RUNS = 5;
const CARRY_OVER_SUMMARY_CHARS = 600;

/**
 * Prompt text that hands a rotated thread's latest results to the new one,
 * so the agent keeps track of what earlier runs found. Empty when there is nothing to carry.
 */
export function carryOverPrompt(jobId: string, previousNodeId: string): string {
  const rows = getDb().prepare(`SELECT started_at, status, summary, error FROM scheduled_job_runs
    WHERE job_id = ? AND node_id = ? AND status != 'running' ORDER BY started_at DESC LIMIT ?`)
    .all(jobId, previousNodeId, CARRY_OVER_RUNS) as Array<{ started_at: number; status: string; summary: string | null; error: string | null }>;
  const lines = rows.reverse().flatMap((row) => {
    const text = (row.status === 'succeeded' ? row.summary : row.error ?? row.summary)?.trim();
    if (!text) return [];
    const clipped = text.length > CARRY_OVER_SUMMARY_CHARS ? `${text.slice(0, CARRY_OVER_SUMMARY_CHARS - 1).trimEnd()}…` : text;
    return [`- ${new Date(row.started_at).toISOString()} (${row.status}): ${clipped}`];
  });
  if (lines.length === 0) return '';
  return `\n\n---\nThis scheduled job's earlier runs continued another thread, which has grown long. `
    + `Their latest results, oldest first:\n${lines.join('\n')}`;
}

type MoveToWorkspaceResult =
  | { kind: 'missing'; reason: string }
  | { kind: 'moved'; jobId: string; workspaceId: string; nodeId: string; treeId: string | null; alreadyVisible: boolean };

/**
 * Show a run's thread in its workspace from now on: clear the hidden mark on
 * the thread and its branches, and stop the job continuing it (its next run
 * starts a new hidden thread). Idempotent.
 */
export function moveRunThreadToWorkspace(runId: string, now: number): MoveToWorkspaceResult {
  const db = getDb();
  const run = db.prepare('SELECT job_id, node_id FROM scheduled_job_runs WHERE id = ?').get(runId) as
    { job_id: string; node_id: string | null } | undefined;
  if (!run) return { kind: 'missing', reason: 'Run not found' };
  if (!run.node_id) return { kind: 'missing', reason: 'This run has no thread to move' };
  const node = db.prepare(`SELECT id, workspace_id, tree_id, scheduled_only_job_id FROM nodes
    WHERE id = ? AND purged_at IS NULL AND deleted_at IS NULL`).get(run.node_id) as
    { id: string; workspace_id: string; tree_id: string | null; scheduled_only_job_id: string | null } | undefined;
  if (!node) return { kind: 'missing', reason: 'This run’s thread was deleted' };
  const result = { kind: 'moved' as const, jobId: run.job_id, workspaceId: node.workspace_id, nodeId: node.id, treeId: node.tree_id };
  if (!node.scheduled_only_job_id) return { ...result, alreadyVisible: true };
  runInTransaction(() => {
    db.prepare(`UPDATE nodes SET scheduled_only_job_id = NULL
      WHERE workspace_id = ? AND scheduled_only_job_id = ? AND (id = ? OR (tree_id IS NOT NULL AND tree_id = ?))`)
      .run(node.workspace_id, node.scheduled_only_job_id, node.id, node.tree_id);
    db.prepare('UPDATE scheduled_jobs SET persistent_node_id = NULL WHERE id = ? AND persistent_node_id = ?')
      .run(node.scheduled_only_job_id, node.id);
    // It was just picked out: list it with the workspace's recent threads.
    if (node.tree_id) db.prepare('UPDATE trees SET last_active_at = ? WHERE id = ? AND workspace_id = ?').run(now, node.tree_id, node.workspace_id);
  });
  // Other windows re-read the workspace and show the thread.
  recordStructureChange({ entity: 'node', op: 'restored', workspaceId: node.workspace_id, nodeId: node.id,
    ...(node.tree_id ? { treeId: node.tree_id } : {}) });
  return { ...result, alreadyVisible: false };
}
