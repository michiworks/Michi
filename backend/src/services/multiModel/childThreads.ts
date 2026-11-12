/**
 * A multi-model run's branches: a real child chat of the caller (same tree),
 * seeded with its runtime/model, the caller's own permission setting and the
 * server-owned markers, with its session opened by a native fork, a text
 * fork of the caller up to the user's request, or nothing inherited (fresh).
 * The node and its session open through childThreadSession.ts, as
 * spawn_branches children do.
 *
 * Also the availability rules every multi-model check uses: the caller must
 * still be a live chat of the run's workspace, and a branch a live chat.
 */
import type { MultiModelContext, MultiModelPermissionMode } from 'michi-shared';
import { getRuntime } from '../../agents/registry';
import type { AgentReasoning, AgentSession } from '../../agents/types';
import { resolveBranchBoundary, toBranchContext } from '../branchBoundary';
import { chatNodeUnavailable, chatTargetUnavailable } from '../chatTarget';
import { writeNodePermissionMode } from '../chatPermissions';
import { insertChildThreadNode, openChildThreadSession } from '../childThreadSession';
import { getDb } from '../db';
import { getNode, getWorkspace, setEdgeForkProvenance } from '../dbRepository';
import { tryForkChatSession } from '../nativeFork';
import { resolveNewThreadProfile } from '../threadProfile';
import { workspaceSessionCwd } from '../workspaceSandbox';
import { MultiModelError } from '../../agents/multiModelTool';
import type { MultiModelStore } from './store';
import type { MultiModelModelChoice } from './types';

/** Why a run's caller can no longer drive it; null while it can. */
export type CallerUnavailable = 'removed' | 'moved';

/**
 * The caller is a live chat (chatTargetUnavailable) in a live workspace, and
 * still in the run's workspace (moving a tree moves nodes, not run rows).
 */
export function callerUnavailable(callerNodeId: string, workspaceId: string): CallerUnavailable | null {
  const unavailable = chatTargetUnavailable(getNode(callerNodeId), workspaceId);
  if (!unavailable) return null;
  return unavailable === 'moved' ? 'moved' : 'removed';
}

/** The branch still exists and is a chat outside the archive and the Trash. */
export function childAvailable(childNodeId: string): boolean {
  return chatNodeUnavailable(getNode(childNodeId)) === null;
}

/** The branch's node row exists, purged or not (getNode hides a purged row, which stays until GC and keeps its id taken). */
export function childRowExists(childNodeId: string): boolean {
  return getDb().prepare('SELECT 1 FROM nodes WHERE id = ?').get(childNodeId) !== undefined;
}

export interface CreateChildInput {
  /** Hub/owner id; LOCAL_AGENT_OWNER_ID on desktop. */
  ownerUserId: string;
  callerNodeId: string;
  runId: string;
  /** Minted and persisted by the orchestrator before this call. */
  childNodeId: string;
  /** The caller's own setting, read right before this call (readNodePermissionSetting), not its effective mode. */
  permissionMode: MultiModelPermissionMode;
  approveForMe: boolean;
  choice: MultiModelModelChoice;
  context: MultiModelContext;
  /** The fork cut: the user's message that asked. */
  askMessageId: string | null;
  /** `${runtimeLabel} · ${modelLabel}`. */
  title: string;
}

export interface OpenedChild {
  childNodeId: string;
  session: AgentSession;
  forkKind: 'native' | 'text' | 'fresh';
  /** Release the restore lock once the first turn has been started (startRequestedSelfTurn called). */
  release(): void;
}

export interface ChildThreadDeps {
  /** server.ts's default cwd, for a workspace without a folder. */
  defaultCwd: string;
  store: Pick<MultiModelStore, 'markChild'>;
  now?: () => number;
}

/** Creates the node, seeds it and opens its session; rolls back on failure. Holds the node's restore lock until release(). */
export async function createChildThread(input: CreateChildInput, deps: ChildThreadDeps): Promise<OpenedChild> {
  const now = deps.now ?? Date.now;
  const caller = getNode(input.callerNodeId);
  const workspace = caller ? getWorkspace(caller.workspace_id) : null;
  if (!caller || !workspace || callerUnavailable(caller.id, caller.workspace_id) !== null) {
    throw new MultiModelError('caller_unavailable', 'The conversation that started this was removed', 409);
  }
  const runtime = getRuntime(input.choice.runtimeId);
  if (!runtime) throw new Error(`${input.choice.runtimeLabel} is not available`);
  const profile = await resolveNewThreadProfile(runtime, {
    providerId: input.choice.providerId, modelId: input.choice.modelId, reasoning: input.choice.reasoning as AgentReasoning | null,
  });
  const cloud = process.env.MICHI_CLOUD === '1';
  const owner = workspace.owner_user_id ?? null;
  const permUser = cloud ? input.ownerUserId : undefined;
  const childNodeId = input.childNodeId;
  // A fork without the user's request to cut at inherits nothing.
  const fresh = input.context === 'fresh' || input.askMessageId === null;

  // No composerDraft (the frontend would send a second turn) and no anchor
  // message (no "Branches N" row under the caller's message).
  const edgeId = insertChildThreadNode({ parent: caller, childNodeId, title: input.title, createdAt: now() });
  let forkKind: OpenedChild['forkKind'] = 'fresh';
  const { session, release } = await openChildThreadSession({
    runtime, childNodeId, workspaceId: workspace.id, owner, profile,
    seed: () => {
      deps.store.markChild(childNodeId, input.runId, fresh);
      writeNodePermissionMode(childNodeId, input.permissionMode, permUser, false, input.approveForMe);
      if (!fresh) setEdgeForkProvenance(edgeId, { forkBoundaryMessageId: input.askMessageId });
    },
    open: async () => {
      const opts = {
        cwd: workspaceSessionCwd(workspace, input.ownerUserId, deps.defaultCwd),
        sessionId: childNodeId,
        workspaceId: workspace.id,
        ownerUserId: owner,
        model: profile.modelId,
        provider: profile.providerId,
        reasoning: profile.reasoning,
        enableFollowUps: true,
      };
      // An empty BranchContext suppresses the ancestor chain and renders nothing.
      if (fresh) return runtime.newSession({ ...opts, branchContext: { parentNodeId: caller.id, kind: 'exact', messages: [] } });
      const boundary = resolveBranchBoundary({ childNodeId, parentNodeId: caller.id, userId: permUser });
      const branchContext = boundary ? toBranchContext(boundary) : undefined;
      const native = await tryForkChatSession(runtime, { ...opts, parentChatId: caller.id, branchContext });
      const session = native ?? await runtime.newSession({ ...opts, parentChatId: caller.id, branchContext });
      forkKind = native ? 'native' : 'text';
      setEdgeForkProvenance(edgeId, { forkKind });
      return session;
    },
  });
  return { childNodeId, session, forkKind, release };
}
