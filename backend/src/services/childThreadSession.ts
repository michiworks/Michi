/**
 * The shared core of the threads Michi opens under a chat: spawn_branches
 * children (spawnChild.ts) and multi-model branches (multiModel/childThreads.ts).
 */
import { edgeRowId } from 'michi-shared';
import * as sessionRegistry from '../agents/sessionRegistry';
import type { AgentRuntime, AgentSession } from '../agents/types';
import { getDb } from './db';
import { getWorkspace, listTrees, updateNodeResumeBinding, type NodeRow } from './dbRepository';
import { ensureDurableGraphNode, rollbackProvisionalSpawnNode } from './graphCommands';
import { log } from './logger';
import { acquireSessionRestoreLock } from './nativeResume';
import type { NewThreadProfile } from './threadProfile';

/**
 * Adds an agent-created child chat and its branch edge to the parent's tree,
 * and returns the edge id. The workspace and tree are read here, so a
 * rename or thread switch made while the caller awaited is not reverted.
 */
export function insertChildThreadNode(input: {
  parent: NodeRow;
  childNodeId: string;
  title: string;
  /** spawn_branches only: the child's first prompt, a durable outbox until it starts. */
  composerDraft?: string;
  createdAt: number;
}): string {
  const { parent, childNodeId, createdAt } = input;
  const workspace = getWorkspace(parent.workspace_id);
  if (!workspace) throw new Error(`workspace ${parent.workspace_id} not found`);
  const tree = parent.tree_id ? listTrees(parent.workspace_id).find((candidate) => candidate.id === parent.tree_id) : undefined;
  const edgeId = edgeRowId('branch', parent.id, childNodeId);
  ensureDurableGraphNode({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      cwd: workspace.cwd ?? null,
      createdAt: workspace.created_at,
      activeTreeId: workspace.active_tree_id ?? parent.tree_id ?? null,
    },
    ...(tree ? {
      tree: {
        id: tree.id,
        rootNodeId: tree.root_node_id,
        name: tree.name ?? null,
        archivedAt: tree.archived_at ?? null,
        pinnedAt: tree.pinned_at ?? null,
        lastActiveAt: tree.last_active_at,
        createdAt: tree.created_at,
      },
    } : {}),
    node: {
      id: childNodeId, treeId: parent.tree_id ?? null, parentNodeId: parent.id, kind: 'chat', title: input.title, spawnedByAgent: true,
      composerDraft: input.composerDraft, createdAt,
    },
    edges: [{ id: edgeId, sourceNodeId: parent.id, targetNodeId: childNodeId, kind: 'branch', anchorMessageId: null, createdAt }],
    ownerUserId: workspace.owner_user_id ?? null,
  });
  return edgeId;
}

/**
 * Opens a just-inserted child's first session under its restore lock, so
 * an ensure-session for the child waits for it instead of opening another.
 * Seeds the node's profile in the insert's tick, before the structure flush
 * reaches a window. On failure it releases the session (a failed release is
 * only logged), clears a binding it wrote, rolls the provisional node back
 * and rethrows. Resolves with the lock still held.
 */
export async function openChildThreadSession(input: {
  runtime: AgentRuntime;
  childNodeId: string;
  workspaceId: string;
  /** The workspace row's owner; null on desktop. */
  owner: string | null;
  profile: NewThreadProfile;
  /** Further writes to the child; a failure rolls them back with it. */
  seed?: () => void;
  open: () => Promise<AgentSession>;
}): Promise<{ session: AgentSession; release: () => void }> {
  const { runtime, childNodeId, profile } = input;
  let session: AgentSession | undefined;
  let release: (() => void) | undefined;
  let bound = false;
  try {
    getDb().prepare(`UPDATE nodes SET runtime_id = ?, provider_id = ?, model_id = ?, reasoning = ?
       WHERE id = ? AND acp_session_id IS NULL`).run(runtime.id, profile.providerId, profile.modelId, profile.reasoning, childNodeId);
    input.seed?.();
    release = await acquireSessionRestoreLock(childNodeId);
    session = await input.open();
    updateNodeResumeBinding(childNodeId, {
      acp_session_id: session.nativeSessionId ?? session.id,
      runtime_id: session.runtimeId,
      runtime_engine: session.nativeEngine ?? null,
      provider_id: profile.providerId,
      model_id: session.currentModelId ?? profile.modelId,
      reasoning: profile.reasoning,
      current_mode_id: session.currentModeId ?? null,
    });
    bound = true;
    sessionRegistry.registerSession(session, input.owner);
    return { session, release };
  } catch (error) {
    if (session) {
      try {
        await runtime.releaseSession(session.id);
      } catch (releaseError) {
        log.warn('chat', 'child thread session release failed', { childNodeId, error: releaseError instanceof Error ? releaseError.message : String(releaseError) });
      }
      sessionRegistry.dropSession(session.id);
    }
    // The rollback refuses a bound node; a failure after binding clears it first.
    if (bound) getDb().prepare('UPDATE nodes SET acp_session_id = NULL, external_session_id = NULL WHERE id = ?').run(childNodeId);
    if (!rollbackProvisionalSpawnNode(childNodeId, input.workspaceId, input.owner)) {
      log.warn('chat', 'child thread kept after a failed open', { childNodeId });
    }
    release?.();
    throw error;
  }
}
