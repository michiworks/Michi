/**
 * spawn_branches' children: a chat under the spawning chat, in its tree,
 * whose first prompt waits in the node as a durable outbox until it starts.
 * The child's session is opened right away, by a native fork of the
 * spawning chat when its runtime can, otherwise as a new session that
 * names it as the parent, with the profile a new thread of that runtime
 * gets (threadProfile.ts).
 */
import { randomUUID } from 'node:crypto';
import { spawnOutboxComposerDraft } from 'michi-shared';
import type { AgentToolBridgeDeps } from '../agents/toolBridge';
import type { AgentRuntime } from '../agents/types';
import { resolveModel, resolveProvider, resolveReasoning } from './agentConfig';
import { insertChildThreadNode, openChildThreadSession } from './childThreadSession';
import { getNode, getNodeSessionBinding, getWorkspace } from './dbRepository';
import { tryForkChatSession } from './nativeFork';
import { resolveNewThreadProfile } from './threadProfile';

export type SpawnChildArgs = Parameters<AgentToolBridgeDeps['createChild']>[0];

export async function createSpawnChild(runtime: AgentRuntime, args: SpawnChildArgs): Promise<{ chatId: string; nodeId: string }> {
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
  // A tiny durable outbox. It lets hydration restart the child even when
  // the parent spawn SSE frame expired from the ring.
  insertChildThreadNode({
    parent: parentNode, childNodeId: nodeId, title: args.title,
    composerDraft: spawnOutboxComposerDraft(args.prompt), createdAt: Date.now(),
  });
  const { session, release } = await openChildThreadSession({
    runtime, childNodeId: nodeId, workspaceId: parentNode.workspace_id, owner, profile,
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
  release();
  return { chatId: session.id, nodeId };
}
