/**
 * spawn_branches' children: a chat under the spawning chat, in its tree,
 * whose first turn the backend starts itself. The child's session is opened
 * right away, by a native fork of the spawning chat when its runtime can,
 * otherwise as a new session that names it as the parent, with the profile a
 * new thread of that runtime gets (threadProfile.ts) and the parent's own
 * permission setting.
 *
 * Windows only show the child: the node reaches every window through the
 * structure feed and the turn through the child's own stream. No window
 * sends the prompt, so two windows open on the parent cannot both send it.
 */
import { randomUUID } from 'node:crypto';
import type { StartedRequestedSelfTurn, StartRequestedSelfTurnArgs } from '../agents/chatHub';
import { startUnderRestoreLock } from '../agents/requestedTurnStart';
import type { AgentToolBridgeDeps } from '../agents/toolBridge';
import type { AgentRuntime, AgentSession } from '../agents/types';
import { resolveModel, resolveProvider, resolveReasoning } from './agentConfig';
import { readNodePermissionSetting, writeNodePermissionMode } from './chatPermissions';
import { insertChildThreadNode, openChildThreadSession } from './childThreadSession';
import { getNode, getNodeSessionBinding, getWorkspace } from './dbRepository';
import { log } from './logger';
import { tryForkChatSession } from './nativeFork';
import { resolveNewThreadProfile } from './threadProfile';

export type SpawnChildArgs = Parameters<AgentToolBridgeDeps['createChild']>[0];

export interface SpawnChildDeps {
  /** ChatHub.startRequestedSelfTurn. */
  startTurn(args: StartRequestedSelfTurnArgs): Promise<StartedRequestedSelfTurn>;
  /** Whether the opened session is still the live one (requestedTurnStart.isRegisteredLiveSession). */
  isLiveSession?: (session: AgentSession) => boolean;
  newTurnId?: () => string;
}

export async function createSpawnChild(
  runtime: AgentRuntime,
  args: SpawnChildArgs,
  deps: SpawnChildDeps,
): Promise<{ chatId: string; nodeId: string }> {
  const parentBinding = getNodeSessionBinding(args.parentChatId, args.ownerUserId ?? undefined);
  const parentNode = parentBinding
    ? getNode(parentBinding.nodeId)
    : process.env.MICHI_CLOUD === '1'
      ? null
      : getNode(args.parentChatId);
  if (!parentNode) throw new Error(`spawn parent node not found for ${args.parentChatId}`);
  const workspace = getWorkspace(parentNode.workspace_id);
  if (!workspace) throw new Error(`spawn workspace ${parentNode.workspace_id} not found`);
  const owner = workspace.owner_user_id ?? null;
  const userId = process.env.MICHI_CLOUD === '1' ? owner ?? undefined : undefined;
  const profile = await resolveNewThreadProfile(runtime, {
    providerId: resolveProvider(runtime.id, userId) || null,
    modelId: resolveModel(runtime.id, userId) || null,
    reasoning: resolveReasoning(runtime.id, userId) ?? null,
  });
  const nodeId = `n-${randomUUID()}`;
  // The child copies the parent's own setting, not its effective mode, as a
  // multi-model branch does: it follows the global setting while the parent does.
  const permission = readNodePermissionSetting(parentNode.id, userId);
  insertChildThreadNode({ parent: parentNode, childNodeId: nodeId, title: args.title, createdAt: Date.now() });
  const { session, release } = await openChildThreadSession({
    runtime, childNodeId: nodeId, workspaceId: parentNode.workspace_id, owner, profile,
    seed: () => writeNodePermissionMode(nodeId, permission.mode, userId, false, permission.approveForMe),
    open: async () => {
      const sessionOptions = {
        cwd: args.cwd,
        parentChatId: args.parentChatId,
        enableFollowUps: args.enableFollowUps,
        sessionId: nodeId,
        workspaceId: parentNode.workspace_id,
        ownerUserId: owner,
        model: profile.modelId, provider: profile.providerId, reasoning: profile.reasoning,
      };
      return await tryForkChatSession(runtime, sessionOptions) ?? await runtime.newSession(sessionOptions);
    },
  });
  const turnId = (deps.newTurnId ?? randomUUID)();
  // The turn registers while the restore lock is still held, so a POST
  // /message for the child in between gets 409 instead of starting first.
  const start = startUnderRestoreLock(release, session, deps.isLiveSession, () => deps.startTurn({
    chatId: session.id,
    nodeId,
    ownerUserId: args.ownerUserId ?? owner,
    turnId,
    text: args.prompt,
    displayText: args.prompt,
    session,
  }));
  try {
    const started = await start;
    void started.done.catch(() => {});
  } catch (error) {
    // The child stays, empty, for the user to write in.
    log.warn('chat', 'spawned child turn failed to begin', {
      nodeId, turnId, error: error instanceof Error ? error.message : String(error),
    });
  }
  return { chatId: session.id, nodeId };
}
