/**
 * `start_conversation`: the agent's conversation (V, in the assistant's
 * workspace) opens an ordinary conversation in one of the user's workspaces
 * and sends its first message. The conversation runs on the user's global
 * runtime settings, exactly as one the user started; the agent's own
 * settings never reach it, and the agent does not do the work itself. A
 * start in a turn the user sent themselves runs without a card, whatever the
 * turn read (D19: a local, undoable change in the user's own turn); one in a
 * turn Michi started (a note, a worker report, a thread reply) asks the user
 * to approve it, and so does one whose turn cannot be read (turnGuard.ts
 * userSentRunningTurn). An applied conversation.start card is that approval
 * (services/companion/service.ts). The new conversation is Michi's work
 * either way: what leaves the machine there asks.
 *
 * In a workspace whose folder is a git repository the conversation works on
 * its own worktree and branch (services/workConversationWorktree.ts, D18,
 * Q26), so its changes stay off the user's checkout.
 *
 * The agent then follows the conversation (DESIGN-v2 §4): every start from
 * V records a delegation (origin `start_conversation`; an applied card
 * names itself the origin afterwards), so its replies come back as worker
 * reports and it may take follow-ups (companion_session_send).
 */

import { randomUUID } from 'node:crypto';
import {
  THREAD_MESSAGE_MAX_CHARS,
  type MichiConversationStart,
  type ProgressCardDto,
} from 'michi-shared';
import type { AgentSession } from '../../agents/types';
import type { StartedRequestedSelfTurn } from '../../agents/chatHub';
import { getRuntime } from '../../agents/registry';
import { startUnderRestoreLock } from '../../agents/requestedTurnStart';
import { threadMessagingDeps, type ThreadMessageApprover, type ThreadMessagingDeps } from '../../agents/threadMessageTool';
import { declinedApprovalNext } from '../../agents/singleUseApproval';
import { assistantPurposeOf, assistantTargetWorkspace, isAssistantWorkspace } from '../../assistant/identity';
import { getAgentConfig, resolveRuntimeProfile } from '../agentConfig';
import { LOCAL_AGENT_OWNER_ID, workspaceOwnerMatches } from '../agentOwner';
import { getDb, runInTransaction } from '../db';
import type { WorkspaceRow } from '../dbRepository';
import { workspaceIdKindHint } from '../idKindHint';
import { ensureDurableGraphNode } from '../graphCommands';
import { log } from '../logger';
import { recordDelegation } from '../companion/repository';
import { activeTurnTrust } from '../turnTrust';
import { noteMichiStartedTurn, recordPassedOutsideContent, turnHoldsOutsideContent, userSentRunningTurn } from '../turnGuard';
import { workConversationWorktrees, type WorkConversationWorktreePort } from '../workConversationWorktree';
import { getPage } from '../pages/repository';
import { recordStructureChange } from '../structureEvents';
import { resolveNewThreadProfile } from '../threadProfile';
import { createProgressCard } from '../pages/progressCards';
import { startTemporaryConversation } from '../memory/memoryService';
import { isTemporaryChat } from '../memory/temporaryChat';
import { CodedToolError, codedErrorResult, jsonResult, type McpTextResult } from '../../agents/tools/types';

export const START_CONVERSATION_TITLE_MAX_CHARS = 80;

/** The Meta agent chat's session-bound identity. Never from tool arguments. */
export interface StartConversationCaller {
  ownerUserId: string | null;
  workspaceId: string | null;
  nodeId: string | null;
}

export interface StartConversationArgs {
  workspaceId?: unknown;
  text?: unknown;
  title?: unknown;
  pageId?: unknown;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clipTitle(value: string): string {
  const glyphs = Array.from(oneLine(value));
  return glyphs.length <= START_CONVERSATION_TITLE_MAX_CHARS ? glyphs.join('')
    : `${glyphs.slice(0, START_CONVERSATION_TITLE_MAX_CHARS - 1).join('').trimEnd()}…`;
}

function parseArgs(args: StartConversationArgs): { workspaceId: string; text: string; title: string; pageId: string | null } {
  const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : '';
  if (!workspaceId || workspaceId.length > 160) throw new CodedToolError('INVALID_ARGUMENT', 'workspaceId is required; get one from list_workspaces');
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) throw new CodedToolError('INVALID_ARGUMENT', 'text is required');
  if (text.length > THREAD_MESSAGE_MAX_CHARS) throw new CodedToolError('INVALID_ARGUMENT', `text exceeds ${THREAD_MESSAGE_MAX_CHARS} characters`);
  if (args.title !== undefined && typeof args.title !== 'string') throw new CodedToolError('INVALID_ARGUMENT', 'title must be a string');
  const title = clipTitle(typeof args.title === 'string' && args.title.trim() ? args.title : text.split('\n').find((line) => line.trim()) ?? text);
  if (args.pageId !== undefined && (typeof args.pageId !== 'string' || !args.pageId || args.pageId.length > 200)) {
    throw new CodedToolError('INVALID_ARGUMENT', 'pageId must be a page id');
  }
  return { workspaceId, text, title, pageId: typeof args.pageId === 'string' ? args.pageId : null };
}

function callerOwner(caller: StartConversationCaller): string {
  if (!caller.nodeId || !isAssistantWorkspace(caller.workspaceId)) {
    throw new CodedToolError('UNSUPPORTED', 'start_conversation is only available in Michi’s own conversation, the one ⌘J opens');
  }
  const ownerUserId = caller.ownerUserId ?? (process.env.MICHI_CLOUD === '1' ? null : LOCAL_AGENT_OWNER_ID);
  if (!ownerUserId) throw new CodedToolError('UNSUPPORTED', 'start_conversation needs a signed-in owner');
  return ownerUserId;
}

/** One of the owner's own workspaces that takes new conversations: not deleted, archived or a system one. */
function targetWorkspace(ownerUserId: string, workspaceId: string): WorkspaceRow {
  const workspace = assistantTargetWorkspace(ownerUserId, workspaceId);
  if (!workspace || !workspaceOwnerMatches(workspace.owner_user_id ?? null, ownerUserId)) {
    throw new CodedToolError('NOT_FOUND', `workspace not found: ${workspaceId}.${workspaceIdKindHint(workspaceId)} Get ids from list_workspaces.`);
  }
  if (workspace.archived_at != null) {
    throw new CodedToolError('READ_ONLY', `${workspace.name} is archived; ask the user to restore it first`);
  }
  return workspace;
}

function checkPage(ownerUserId: string, pageId: string | null): void {
  if (!pageId) return;
  try {
    getPage(pageId, ownerUserId);
  } catch {
    throw new CodedToolError('INVALID_ARGUMENT', `page not found: ${pageId}`);
  }
}

/** The user's global runtime profile, as a conversation they started now would get it. */
async function globalProfile(ownerUserId: string) {
  const userId = process.env.MICHI_CLOUD === '1' ? ownerUserId : undefined;
  const runtimeId = getAgentConfig(userId).runtime;
  const runtime = getRuntime(runtimeId);
  if (!runtime) throw new CodedToolError('UNAVAILABLE', `the ${runtimeId} runtime is not available`);
  const profile = await resolveNewThreadProfile(runtime,
    resolveRuntimeProfile(runtimeId, runtime.capabilities.providerModels, {}, userId));
  return { runtimeId, ...profile };
}

/** Removes a conversation whose session never opened. */
function rollback(nodeId: string, workspaceId: string, treeId: string): void {
  try {
    runInTransaction(() => {
      const row = getDb().prepare(`
        SELECT n.acp_session_id, (SELECT COUNT(*) FROM messages m WHERE m.node_id = n.id) AS message_count
          FROM nodes n WHERE n.id = ? AND n.workspace_id = ? AND n.tree_id = ?
      `).get(nodeId, workspaceId, treeId) as { acp_session_id: string | null; message_count: number } | undefined;
      if (!row || row.acp_session_id || row.message_count > 0) return;
      const removed = getDb().prepare('DELETE FROM trees WHERE id = ? AND workspace_id = ? AND root_node_id = ?').run(treeId, workspaceId, nodeId);
      if (Number(removed.changes) > 0) recordStructureChange({ entity: 'tree', op: 'deleted', workspaceId, treeId });
    });
  } catch {
    // An empty thread left behind is harmless; the tool still reports the failure.
  }
}

type StartOutcome = { kind: 'started' } | { kind: 'queued' } | { kind: 'failed'; error: unknown };

function waitForStart(start: Promise<StartedRequestedSelfTurn>, waitMs: number): Promise<StartOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'queued' }), waitMs);
    timer.unref?.();
    start.then(
      () => { clearTimeout(timer); resolve({ kind: 'started' }); },
      (error) => { clearTimeout(timer); resolve({ kind: 'failed', error }); },
    );
  });
}

function errorOf(error: unknown): McpTextResult {
  if (error instanceof CodedToolError) return codedErrorResult(error.code, error.message);
  throw error;
}

export async function startConversationTool(
  caller: StartConversationCaller,
  args: StartConversationArgs,
  approve: ThreadMessageApprover,
  deps: ThreadMessagingDeps | null = threadMessagingDeps(),
  worktrees: WorkConversationWorktreePort = workConversationWorktrees,
): Promise<McpTextResult> {
  let request: ReturnType<typeof parseArgs>;
  let ownerUserId: string;
  let workspace: WorkspaceRow;
  try {
    request = parseArgs(args);
    ownerUserId = callerOwner(caller);
    workspace = targetWorkspace(ownerUserId, request.workspaceId);
    checkPage(ownerUserId, request.pageId);
  } catch (error) {
    return errorOf(error);
  }
  if (!deps) return codedErrorResult('UNAVAILABLE', 'starting conversations is not configured on this backend');

  const nodeId = `n-${randomUUID()}`;
  // The user asked for it in their own turn: no card (2026-11-12). Any other turn asks.
  const approval = userSentRunningTurn(caller.nodeId) ? { approved: true as const } : await approve({
    targetNodeId: nodeId,
    targetTitle: `New conversation · ${request.title}`,
    text: request.text,
    targetWorkspaceName: oneLine(workspace.name) || 'Untitled',
    exact: true,
  });
  if (!approval.approved) {
    if (approval.reason === 'unavailable') {
      return codedErrorResult('APPROVAL_UNAVAILABLE', 'this runtime cannot ask the user for approval; no conversation was started');
    }
    return jsonResult({
      status: 'declined',
      ...(approval.note ? { userNote: approval.note } : {}),
      next: declinedApprovalNext(approval.reason, 'nothing was started'),
    });
  }

  // The approval may have waited minutes: check the workspace and page again.
  let profile: Awaited<ReturnType<typeof globalProfile>>;
  try {
    workspace = targetWorkspace(ownerUserId, request.workspaceId);
    checkPage(ownerUserId, request.pageId);
    profile = await globalProfile(ownerUserId);
  } catch (error) {
    return errorOf(error);
  }

  const now = Date.now();
  const treeId = `t-${now}-${randomUUID().slice(0, 8)}`;
  ensureDurableGraphNode({
    workspace: {
      id: workspace.id, name: workspace.name, cwd: workspace.cwd ?? null,
      createdAt: workspace.created_at, activeTreeId: workspace.active_tree_id ?? null,
    },
    tree: { id: treeId, rootNodeId: nodeId, name: null, lastActiveAt: now, createdAt: now },
    node: { id: nodeId, treeId, parentNodeId: null, kind: 'chat', title: request.title, createdAt: now },
    edges: [],
    ownerUserId: workspace.owner_user_id ?? null,
  });
  // What a temporary chat starts carries what it was told there: a temporary chat too.
  if (isTemporaryChat(caller.nodeId)) startTemporaryConversation({ ownerUserId }, nodeId);
  // ensure-session opens a new conversation with the profile stored on its node.
  getDb().prepare('UPDATE nodes SET runtime_id = ?, provider_id = ?, model_id = ?, reasoning = ? WHERE id = ? AND acp_session_id IS NULL')
    .run(profile.runtimeId, profile.providerId, profile.modelId, profile.reasoning, nodeId);
  // D18, Q26: in a git workspace the conversation works on its own worktree and branch; its sessions open there.
  const worktree = await worktrees.prepare({ nodeId, workspaceCwd: workspace.cwd, title: request.title });
  const undo = async () => {
    if (worktree) await worktrees.discard(nodeId);
    rollback(nodeId, workspace.id, treeId);
  };

  let session: AgentSession | null;
  try {
    session = await deps.ensureSession({ ownerUserId, workspaceId: workspace.id, nodeId });
  } catch (error) {
    await undo();
    return codedErrorResult('UNAVAILABLE', error instanceof Error ? error.message : String(error));
  }
  if (!session) {
    await undo();
    return codedErrorResult('UNAVAILABLE', 'could not open a session for the new conversation');
  }

  const turnId = deps.newTurnId();
  const opened = session;
  // D19: the conversation's first turn is Michi's, and starts from whatever outside content the starting turn held.
  try {
    markMichiStart(caller, { nodeId, turnId }, opened.runtimeId);
  } catch (error) {
    await undo();
    return codedErrorResult('UNAVAILABLE', `could not mark the new conversation as Michi's work: ${error instanceof Error ? error.message : String(error)}`);
  }
  const start = startUnderRestoreLock(await deps.acquireRestoreLock(nodeId), opened, deps.isLiveSession, () => deps.startTurn({
    chatId: opened.id, nodeId, ownerUserId, turnId, text: request.text, displayText: request.text, session: opened,
  }));
  start.then((started) => { void started.done.catch(() => {}); }, (error) => {
    log.warn('chat', 'Meta agent conversation failed to begin', { nodeId, turnId, error: error instanceof Error ? error.message : String(error) });
  });
  const outcome = await waitForStart(start, deps.startWaitMs);
  if (outcome.kind === 'failed') {
    return codedErrorResult('UNAVAILABLE', outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
  }
  const followed = followStartedConversation(caller, { workspaceId: workspace.id, nodeId, title: request.title, now });

  let progressCard: ProgressCardDto | null = null;
  if (request.pageId) {
    try {
      progressCard = createProgressCard({ ownerUserId, threadNodeId: nodeId, startedFromPageId: request.pageId });
    } catch (error) {
      log.warn('chat', 'Meta agent conversation has no progress card', { nodeId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const conversation: MichiConversationStart = {
    kind: 'michiConversationStart',
    nodeId, treeId, workspaceId: workspace.id, workspaceName: workspace.name, title: request.title,
    runtimeId: session.runtimeId, modelId: profile.modelId, startedFromPageId: progressCard ? request.pageId : null,
  };
  return jsonResult({
    status: outcome.kind,
    conversation,
    ...(progressCard ? { progressCard } : {}),
    ...(worktree ? { worktree: { branch: worktree.branch } } : {}),
    next: `The conversation runs on its own. Tell the user it started and link it as [${request.title.replace(/[[\]]/g, '')}](michi://node/${nodeId}); `
      + (worktree ? `it works on its own branch \`${worktree.branch}\` in a separate worktree, so the user's checkout is untouched. ` : '')
      + 'they follow it from its progress card or the conversation page. Do not do its work yourself. '
      + (followed
        ? 'Its replies come back to you as worker reports; when it needs a next step the user asks for, send it with companion_session_send.'
        : 'Do not message it.'),
  });
}

/**
 * The new conversation's first turn is Michi's (services/turnGuard.ts
 * michiDriven, before the delegation that says so durably is recorded), and
 * when the starting turn held outside content the new turn starts from it
 * (outsideSourced: its network and credential reads ask too). Throws when
 * that cannot be recorded; nothing starts then.
 */
function markMichiStart(caller: StartConversationCaller, to: { nodeId: string; turnId: string }, runtimeId: string): void {
  noteMichiStartedTurn(to.nodeId, to.turnId);
  if (!caller.nodeId) return;
  const from = activeTurnTrust(caller.nodeId);
  if (!from || turnHoldsOutsideContent({ nodeId: caller.nodeId, turnId: from.turnId })) recordPassedOutsideContent(to, caller.nodeId, runtimeId);
}

/**
 * The agent follows a conversation its own conversation started (DESIGN-v2
 * §4): a delegation, origin `start_conversation`, recorded only for a caller
 * on V's open profile (purpose `main`), never for a closed one, nor for a
 * temporary chat: worker reports would bring the started conversation's
 * replies back into V's conversations. A failed record leaves the
 * conversation started, unfollowed. Returns whether it is followed.
 */
function followStartedConversation(caller: StartConversationCaller, started: { workspaceId: string; nodeId: string; title: string; now: number }): boolean {
  if (!caller.nodeId || assistantPurposeOf(caller.nodeId) !== 'main' || isTemporaryChat(caller.nodeId)) return false;
  try {
    recordDelegation({ ...started, origin: 'start_conversation' });
    return true;
  } catch (error) {
    log.warn('chat', 'started conversation is not followed', { nodeId: started.nodeId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
