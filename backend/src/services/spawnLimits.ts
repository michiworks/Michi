/**
 * How far spawn_branches may fan out. Its children get the tool too, and in
 * Trust and YOLO, and on Codex and Pi, no card asks first, so one request
 * could otherwise become five chats, then twenty-five, each with a session.
 *
 * A chat's spawn depth counts the agent-spawned chats (nodes.spawned_by_agent)
 * from it up its parent chain, itself included: a chat the user made is 0, a
 * branch an agent spawned from it 1. A branch the user makes by hand starts
 * again at 0, which is the way on when a limit is reached. A multi-model
 * plan's branches are agent-spawned and count toward depth, as they already
 * cannot propose a plan of their own; they do not count toward the total,
 * since the user started each plan from its card.
 */
import { getDb } from './db';

/** The user's chat and its spawned branches may spawn; a branch of a spawned branch may not. */
export const MAX_SPAWN_DEPTH = 2;
/** Spawned branches, at any depth, below the chat the user made. */
export const MAX_SPAWNED_BRANCHES = 20;

/** Parent hops walked; a chain this long is past MAX_SPAWN_DEPTH anyway. */
const ANCESTOR_HOPS = 32;

const SPAWN_DEPTH_REFUSAL = 'spawn_branches refused: this thread has reached the branch depth limit '
  + `(${MAX_SPAWN_DEPTH} levels of agent-spawned branches). Do the work in this thread, or ask the user to branch manually.`;

interface SpawnLineage {
  depth: number;
  /** The nearest node up the chain that no agent spawned (the chat the user made). */
  rootNodeId: string;
  workspaceId: string;
}

function spawnLineage(nodeId: string): SpawnLineage | null {
  const rows = getDb().prepare(`WITH RECURSIVE chain(id, parent_node_id, workspace_id, spawned_by_agent, hops) AS (
      SELECT id, parent_node_id, workspace_id, spawned_by_agent, 0 FROM nodes WHERE id = ?
      UNION ALL
      SELECT n.id, n.parent_node_id, n.workspace_id, n.spawned_by_agent, chain.hops + 1
      FROM nodes n JOIN chain ON n.id = chain.parent_node_id
      WHERE chain.spawned_by_agent = 1 AND chain.hops < ? AND n.workspace_id = chain.workspace_id
    )
    SELECT id, workspace_id, spawned_by_agent FROM chain ORDER BY hops`)
    .all(nodeId, ANCESTOR_HOPS) as Array<{ id: string; workspace_id: string; spawned_by_agent: number }>;
  const root = rows.at(-1);
  if (!root) return null;
  return { depth: rows.filter((row) => row.spawned_by_agent === 1).length, rootNodeId: root.id, workspaceId: root.workspace_id };
}

/** spawn_branches children below `rootNodeId` through agent-spawned chats, deleted ones and plan branches left out. */
function spawnedBelow(rootNodeId: string, workspaceId: string): number {
  const row = getDb().prepare(`WITH RECURSIVE below(id) AS (
      SELECT ?
      UNION
      SELECT n.id FROM nodes n JOIN below ON n.parent_node_id = below.id
      WHERE n.workspace_id = ? AND n.spawned_by_agent = 1
    )
    SELECT COUNT(*) AS count FROM nodes n JOIN below ON n.id = below.id
    WHERE n.spawned_by_agent = 1 AND n.multi_model_run_id IS NULL AND n.deleted_at IS NULL AND n.purged_at IS NULL`)
    .get(rootNodeId, workspaceId) as { count: number };
  return row.count;
}

/** Whether the chat is offered spawn_branches at all: false once it is too deep. */
export function spawnBranchesOffered(nodeId: string | null | undefined): boolean {
  if (!nodeId) return true;
  const lineage = spawnLineage(nodeId);
  return !lineage || lineage.depth < MAX_SPAWN_DEPTH;
}

/**
 * Why the chat may not spawn `requested` more branches now, or null when it
 * may. An unknown node is left to the spawn itself, which refuses it.
 */
export function spawnBranchesRefusal(nodeId: string, requested: number): string | null {
  const lineage = spawnLineage(nodeId);
  if (!lineage) return null;
  if (lineage.depth >= MAX_SPAWN_DEPTH) return SPAWN_DEPTH_REFUSAL;
  const spawned = spawnedBelow(lineage.rootNodeId, lineage.workspaceId);
  const left = MAX_SPAWNED_BRANCHES - spawned;
  if (left <= 0) {
    return `spawn_branches refused: agents have already spawned ${spawned} branches from the conversation this thread belongs to, `
      + `the limit is ${MAX_SPAWNED_BRANCHES}. Do the work in this thread, or ask the user to branch manually.`;
  }
  if (requested > left) {
    return `spawn_branches refused: only ${left} more branch${left === 1 ? '' : 'es'} may be spawned from the conversation this thread `
      + `belongs to (the limit is ${MAX_SPAWNED_BRANCHES}). Call it again with at most ${left} topic${left === 1 ? '' : 's'}, `
      + 'or ask the user to branch manually.';
  }
  return null;
}
