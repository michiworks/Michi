import { approvalAttentionCopy, artifactNameKey, artifactTypeForPath, completionAttentionCopy, deriveConversationTitle, parseSlashInvocation, questionAttentionCopy } from 'michi-shared';
import { formatQuotedSelectionContext } from '../lib/quoteFormat';
import { isFileFeedbackTargetValid, type FileFeedbackTarget } from './fileFeedback';
import type { QuoteSource } from '../lib/quoteFormat';
import { backendFetch } from '../services/api/backendRequest';
import { nextQueuedBatch, executeComposerCommand } from './chatCommands';
import { buildSlashEntries, liveSlashCommands, pickedSlashEntry, recordedSlashSkill, resolveSlashRun, type SlashEntry } from './slashEntries';
import { invalidateSkillCatalog, readSkillCatalog, rememberRuntimeLabels, settleSkillCatalog } from './skillCatalog';
import { chatPermissionChoiceParts, NO_APPLIED_TURN_CURSOR, parseSessionState, randomUuid, type ScheduledJobRunEvent, type SteerMessageOptions } from 'michi-shared';
import { createBackgroundCatchUp, type BackgroundCatchUpActions } from './backgroundCatchUp';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { allocateNodeIdsLocal, ensureSession, fetchAgentStatus, fetchAgentStatusAfterFirstPaint, fetchBackgroundCursors, fetchNodeWorkspace, fetchReady, fetchTreeMessagePage, fetchWorkspaceStructure, listAgentModels, setChatMode, respondToPermission, cancelPermission, respondToUserInput, skipUserInput, cancelChatAndObserve, reattachTurnReplay, steerChat } from '../services/api';
import { bindPendingPrimaryAgent, type AgentStatus, type TreeMessagePage } from '../services/api';
import { activeTreeRootNodeId, findTreeIdForNode, descendants, resolveBranchParent, isBranchEdge } from './tree';
import { useMessageHistory, type MessageHistoryActions } from './useMessageHistory';
export { activeTreeRootNodeId } from './tree';
import { usePrefs } from './prefs';
import { DARK_PALETTES } from '../components/terminal/tokens';
import { resolveAtMentions, resolveAtNodeMentions, buildNodeTranscriptBlock, stripNodeMentionTokens, rewriteNodeMentionsForDisplay } from './contextBudget';
import { artifactManifestForBackend, deletedArtifactId, knownArtifactManifest } from './agentArtifacts';
import { runChatStream, type TurnEndReason } from './chatStreamRunner';
import { inspectOriginalTurn, turnErrorAction } from './turnErrorRecovery';
import { buildResumePrompt, interruptionCauseOfKind } from './turnInterruption';
import { createBackgroundTurnBinding } from './observeChatStream';
import { createBackgroundTurnTransport } from './backgroundTurnTransport';
import type { ReplayGapInstall } from '../services/api/stream';
import { visibleMessageText } from './assistantBlocks';
import * as perf from '../services/perf';
import { startupMarkOnce } from '../services/startupTrace';
import { TreePrefetchContext } from './treePrefetch';
import { buildFlushPayload } from './queueFlush';
import { expandMentions } from '../components/mentions';
import { appendAttachmentsSentinel } from '../lib/composerAttachments';
import { formatCommentsBlock, joinMessageParts, joinMessageQuotes } from '../lib/commentFormat';
import { useDigestOrchestration } from './digestOrchestration';
import { visibleDigestMarkdown } from './digest';
import { buildSubtreeContextBlocks } from './mergePreamble';
import { paneAfterClose, usePaneState } from './paneState';
import { WINDOW_ID } from '../config/windowIdentity';
export { WINDOW_ID } from '../config/windowIdentity';
import { useFocusedNodeSeen, useShownNodesSeen } from './useCompletionSeen';
import { usePanePresenceIntegration } from './usePanePresenceIntegration';
import { agentRunPaneId, DEFAULT_BROWSER_URL, pagePaneId, normalizeBrowserUrl, parseSourceLocation, singletonPaneId, uniquePaneId, type PaneItem, type PaneLauncherChoice } from './paneItems';
import type { AgentResourceIdentity } from './agentIdentity';
import { knownAgentRunName } from './agentRunNotifications';
import { getElectron } from '../lib/electronBridge';
import { closeTerminal } from '../services/api/terminals';
import { TERMINAL_CLIENT_ID, terminalPaneFields, terminalTargetForPane, terminalTargetForWorkspace } from './terminalTarget';
import { isAbsoluteFilePath } from '../lib/workspaceFilePath';
import { navigateToNode } from './navigateToNode';
import { useAgentModeCatalog } from '../hooks/useAgentModeCatalog';
import { useWorkspacePrewarm } from '../hooks/useWorkspacePrewarm';
import { useArtifactWatch } from '../hooks/useArtifactWatch';
import { NODE_ACTIVITY_ACTIONS, reduceNodes, reduceProject } from './chatReducers';
import { prependToDraft } from './composerDraft';
import {
  LEGACY_STATE_KEY,
  buildStateKey,
  durableNodePrerequisite,
  readActiveProjectId,
  readInitialHydrated,
  useWorkspacePersistence,
  writeActiveProjectId,
  type BackendInstalledEntities,
} from './workspacePersistence';
import type { StructureAdoption } from './structureAdoption';
import { useLazyTreeMessages } from './useLazyTreeMessages';
import { TreeMessageRequests } from './treeMessageRequests';
import { backendConnectionProvisional, whenBackendConnectionConfirmed } from '../config/backendConnectionState';
import { NodeMessagesContext } from './nodeMessagesSelfHeal';
import { useStructureSync } from './useStructureSync';
import { backendInstalledEntities, mergeWorkspaceSnapshot } from './assistant/workspaceSnapshot';
import { isSystemWorkspace } from './assistant/systemWorkspace';
import { isListedThread, isVisibleConversationNode } from './conversationVisibility';
import { rememberUserWorkspace, userWorkspaceToReturnTo } from './assistant/userWorkspace';
import { isNodeShownInWindow, isPaneShownInWindow } from './attention/targetVisibility';
import { isServerAttentionActive, subscribeServerAttention, type AttentionIntent as ServerAttentionIntent } from '../services/serverAttention';
import { activeServerAttentionRecord } from '../services/serverAttentionStore';
import { getCompanionAssistant, isCompanionNodeId, noteCompanionTurnEnded } from './companion/companionStore';
import { getCompanionPanelState, openCompanionPanel, useCompanionPanelShownNodeIds } from './companion/companionPanel';
import { requestOpenCompanionTarget, requestOpenScheduledRun } from './attentionOpenRequests';
import { isAwaitingUserInput } from './askUserSelectors';
import { companionNameNow } from './companion/companionName';
import { companionPostRunId, isCheckinNodeId } from 'michi-shared';
import { captureMetaAgentTurnContext, mergeMetaAgentTurnContexts, withCarriedRefs } from '../services/api/assistant';
import { takeSourceJumpInto } from './sourceNav/sourceNav';
import { refreshMetaAgent } from './metaAgent/useMetaAgent';
import { quoteSourceOf } from './assistant/assistantContext';
import { useContextActions } from './contextActions';
import { useProjectActions, useTreeActions } from './projectTreeActions';
import { useExtractNodeTree } from './extractNodeTree';
import { useTrashActions } from './trashActions';
import { useUndoableActions } from './undoableActions';
import { attentionTargetKey, dismissAttention, presentAttention, type AttentionIntent } from '../services/attention/policy';
import {
  indexBackendProjects,
  backendConnectionIdForWorkspace,
  LOCAL_BACKEND_CONNECTION_ID,
  nodeBackendApiBase,
  projectConnectionId,
  setActiveBackendConnectionId,
} from '../config/backendConnections';
import { toast } from 'sonner';
import type { ChatAction, ChatActionsValue, ChatContextValue, ChatMessage, ChatNodeState, ChatPaneValue, ChatProjectsValue, ComposerDraft, MessageAttachment, PendingQueuedMessage, Project, ProjectEdge, SendBindingMeta, Theme, UserSendMeta } from './chatTypes';
import { computeSurvivingMessageIds, cleanupOrphanedAnchors } from './branchAnchors';
import { abortableDelay, sleep } from '../utils/sleep';
import {
  BackgroundGapRetries,
  backgroundReplayCursor,
  installBackendWorkspaceNode,
  readAndInstallNode,
  reconcileBackgroundWorkspaceSnapshot,
  type BackgroundReplayGap,
} from './backgroundGapReconcile';
import { SCHEDULED_JOB_RUN_WINDOW_EVENT, SCHEDULED_JOBS_CHANGED_WINDOW_EVENT, latestTurnIsScheduled } from './scheduledRunNotice';
import type { StreamHandlers } from '../services/chatStreamEvents';
import type { CreateChildChatOptions } from './chatTypes';
import { backendEntityId, remoteEntityIdentity } from '../config/backendIdentity';
import { navPageEvent } from './appEvents';
import { requestMessageJump } from './sourceNav/sourceNav';

/**
 * Construct a branch edge with provenance fields stamped at fork time.
 * All 4 edge-creation sites in this file funnel through here so the shape
 * is a single source of truth.
 */
export function makeBranchEdge(params: {
  source: string;
  target: string;
  anchorMessageId?: string;
  createdAt: number;
  kind?: 'branch';
}): ProjectEdge {
  return {
    source: params.source,
    target: params.target,
    ...(params.kind ? { kind: params.kind } : {}),
    anchorMessageId: params.anchorMessageId,
    createdAt: params.createdAt,
  };
}

/** The / entries a send on `node` resolves against; its pane's menu lists the same (TPane). */
function sendSlashEntries(node: ChatNodeState, project: Project | undefined, runtimeId: string | undefined): SlashEntry[] {
  return buildSlashEntries({
    agentCommands: liveSlashCommands(node, runtimeId),
    catalog: readSkillCatalog(node.projectId, runtimeId),
    // The assistant's conversations run no skills; the backend refuses them there.
    skills: !isSystemWorkspace(project),
    runtimeId,
  });
}

/** How long a typed `/name` waits for what its runtime's catalog still lacks (settleSkillCatalog). */
const SLASH_CATALOG_WAIT_MS = 2500;

/**
 * A skill send's wire text: what the user wrote after the command, framed
 * the way the composer framed the whole message (comments, quote, attached
 * files), so the runtime gets its usual context along with the skill. The
 * arguments come last (SkillInvocationRequest.args), so the attached-files
 * line goes first.
 */
function skillWireText(args: string, meta: UserSendMeta | undefined): string {
  if (meta?.displayText === undefined) return args;
  const attached = appendAttachmentsSentinel('', meta.attachments ?? []).trim();
  const framed = joinMessageParts(meta.comments?.length ? formatCommentsBlock(meta.comments) : null, meta.quotedText ?? null, args, meta.quoteSource);
  return [attached, framed].filter(Boolean).join('\n\n');
}

export { hydrateBackendWorkspaces, hydrateSavedState, STATE_SCHEMA_VERSION } from './chatHydration';
export { reduceProject } from './chatReducers';
export type {
  ChatAction,
  ChatContextValue,
  ChatMessage,
  ChatNodeState,
  ChatPaneValue,
  ChatProjectsValue,
  ComposerDraft,
  ComposerMention,
  ArtifactEntry,
  EdgeKind,
  NodeKind,
  Project,
  ProjectAction,
  ProjectEdge,
  Theme,
  ToolCallState,
  Tree,
  ViewMode,
} from './chatTypes';

/**
 * Singleton workspace id for the "Chats" workspace — the default
 * folder-less home for ad-hoc conversations. Created lazily on first Skip.
 */
export const CHATS_WORKSPACE_ID = 'chats-default';

/** How long a chat the backend could not place is left alone before asking again. */
const BACKEND_CHAT_DISCOVERY_RETRY_MS = 10_000;
// A background replay gap holds every chat's frames on its feed while it reads
// one node: bounded reads, a bounded wait for a foreground turn on that node,
// and a few rereads when local edits race them.
const BACKGROUND_GAP_ATTEMPTS = 4;
const GAP_FOREGROUND_WAIT_MS = 10_000;
const GAP_READ_TIMEOUT_MS = 30_000;
// A backend-created thread installs off the feed, so it may reread more often.
const BACKEND_NODE_INSTALL_ATTEMPTS = 6;

/**
 * The agent's own conversation, V (DESIGN-v2 §0.2), or another node of the
 * assistant's hidden workspace (History, a check-in's scratch node): it shows
 * in the <name> panel, never as a pane of that workspace. V counts by its id
 * before its workspace has loaded here.
 */
export function isAssistantConversation(projects: ReadonlyArray<Pick<Project, 'system' | 'chatIds'>>, nodeId: string): boolean {
  if (!nodeId) return false;
  return isCheckinNodeId(nodeId) || isCompanionNodeId(nodeId)
    || projects.some((project) => isSystemWorkspace(project) && project.chatIds.includes(nodeId));
}

/**
 * Notifications, the "agent is asking" bar and source links that point into
 * the assistant's workspace open the panel on Chat, the one reveal for all of
 * them (DESIGN-v2 §1.2). False for any other node: the caller opens its pane.
 */
export function revealInCompanionPanel(projects: ReadonlyArray<Pick<Project, 'system' | 'chatIds'>>, nodeId: string): boolean {
  if (!isAssistantConversation(projects, nodeId)) return false;
  // A jump from Pages' source popover lands in the panel, not the conversation area: it leaves
  // no "Back to <page>" bar behind (F1b-review #6); the panel shows the cited message instead.
  const jump = takeSourceJumpInto(nodeId);
  const messageId = jump?.messageId && getCompanionAssistant().info?.nodeId === nodeId ? jump.messageId : null;
  openCompanionPanel({
    tab: 'chat',
    ...(messageId ? { focusMessageId: messageId } : {}),
    ...(jump ? { focusComposer: jump.focus === 'composer' } : {}),
  });
  return true;
}

/** First-run narration's message ids (backend services/metaAgent/firstRunNarration.ts). */
const NARRATION_ID_PREFIX = 'mna-';

/**
 * The agent speaking on its own in V: a check-in's post (`cmp-post-<runId>`,
 * §3.3, the shared post-id contract) or first-run narration (`mna-…`). Their
 * notices come from the agent's own gate by its level, never as chat
 * notifications. Narration's live frames carry no metadata, so its id is
 * what tells.
 */
export function isCompanionSelfMessage(message: Pick<ChatMessage, 'id' | 'role' | 'companionPost'> | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  return !!message.companionPost || companionPostRunId(message.id) !== null || message.id.startsWith(NARRATION_ID_PREFIX);
}

/**
 * A retry or an edit of a message to the agent (F1a-review #1): it carries
 * what the original carried (its context while this window remembers it,
 * else the area now) plus every reference it was sent with, which a reload
 * keeps (companionRefs). Nothing is taken that the next send of the user's
 * own is about to carry. Undefined for any other chat.
 */
function resendTurnContext(nodeId: string, source: ChatMessage | undefined) {
  const base = source?.role === 'user' && source.metaAgentContext !== undefined
    ? source.metaAgentContext
    : captureMetaAgentTurnContext(nodeId, { consume: false });
  return withCarriedRefs(base, source?.role === 'user' ? source.companionRefs : undefined);
}

/** The titles of V's chat notifications carry the agent's name (§1.5). */
function companionNoticeTitle(kind: 'approval' | 'question' | 'reply'): string {
  const name = companionNameNow();
  return kind === 'approval' ? `${name}: needs your approval` : kind === 'question' ? `${name}: has a question` : `${name} replied`;
}

/**
 * High-frequency action types that throttle React renders to one per animation
 * frame and DO NOT advance the structure version. Streamed token / heartbeat /
 * tool-progress actions all fall here. Locked by chatReducers.structural.test.ts —
 * if you add a new type here, that test verifies it does not mutate any
 * structural field.
 */
export const HIGH_FREQ_ACTIONS: ReadonlySet<ChatAction['type']> = new Set([
  'chunk', 'thought', 'heartbeat', 'tool-call', 'tool-call-update', 'plan',
  'subagent-list-update', 'subagent-tool-activity', 'apply-seq',
  'set-composer-draft',
]);

interface AgentRunPaneActions {
  openAgentRunPane: (identity: AgentResourceIdentity, workspaceId: string, title?: string) => string;
  openPagePane: (page: { pageId: string; workspaceId: string; backendConnectionId: string; title?: string }) => string;
  /**
   * Show a node where it lives: its workspace and thread, on the Dashboard,
   * scrolled to `messageId` when given. The assistant's conversation shows in
   * its ⌘J panel. False when no workspace holds the node.
   */
  revealNode: (nodeId: string, opts?: { workspaceId?: string; messageId?: string }) => boolean;
  /** Open a thread the backend created (scheduled run); false if it cannot be found. */
  revealBackendNode: (workspaceId: string, nodeId: string) => Promise<boolean>;
}

interface WorkspaceSnapshotActions {
  /**
   * Install a backend workspace snapshot the store doesn't hold yet (or its
   * missing nodes) — the ⌘J assistant's system workspace is provisioned after
   * hydration. Nodes already in the store are left untouched. False when the
   * snapshot isn't a workspace. `readStartedAt` (Date.now() when its read
   * began) lets removals confirmed before then count as seen by it.
   */
  installWorkspaceSnapshot: (rawWorkspace: unknown, readStartedAt?: number) => boolean;
}

type ExtendedChatContextValue = ChatContextValue & AgentRunPaneActions;
type ExtendedChatActionsValue = ChatActionsValue & AgentRunPaneActions & WorkspaceSnapshotActions & MessageHistoryActions
  & BackgroundCatchUpActions;

const ChatContext = createContext<ExtendedChatContextValue | null>(null);

interface ChatNodeStoreValue {
  getNode: (nodeId: string) => ChatNodeState | undefined;
  getNodes: () => Record<string, ChatNodeState>;
  subscribeNode: (nodeId: string, listener: () => void) => () => void;
  /** Subscribe to ANY node change. Listener fires once per `nodes` reference flip. */
  subscribe: (listener: () => void) => () => void;
  /** Returns a monotonic counter that bumps on non-HIGH_FREQ_ACTIONS dispatches. */
  getStructureVersion: () => number;
  /** Subscribe to structural changes — fires only when the version advances. (Wired in Task 3.) */
  subscribeStructure: (listener: () => void) => () => void;
}

/**
 * @internal Exposed only for structural-channel tests.
 * Production code should use useChatNode, useNodesSelector, useStructureVersion,
 * useStructuralSelector, or useChatNodesSnapshot — not this raw context.
 */
export const ChatNodeStoreContext = createContext<ChatNodeStoreValue | null>(null);
const ChatActionsContext = createContext<ExtendedChatActionsValue | null>(null);
const ChatProjectsContext = createContext<ChatProjectsValue | null>(null);
const ChatPaneContext = createContext<ChatPaneValue | null>(null);

/**
 * Build a pre-rendered context block from a source node. The backend
 * embeds these verbatim into the merge node's first-message preamble.
 */
function buildMergeContextBlock(source: ChatNodeState | undefined): string | null {
  if (!source) return null;
  const title = source.title || source.messages.find((m) => m.role === 'user')?.text.slice(0, 80) || 'thread';
  const lastAssistant = [...source.messages].reverse().find((m) => m.role === 'assistant' && visibleMessageText(m));
  if (!lastAssistant) return null;
  const visibleText = visibleMessageText(lastAssistant);
  if (!visibleText) return null;
  return `=== Source: ${title} ===\n${visibleText}`;
}

/**
 * Build a preamble block from a digest node. Used when a chat is branched off
 * a digest (e.g. "explore" on an open thread, or follow-up question from the
 * digest pane) — without this the new session would inherit no context since
 * digests have no chatId of their own.
 */
function buildDigestContextBlock(source: ChatNodeState | undefined): string | null {
  if (!source || source.kind !== 'digest' || !source.digest) return null;
  const title = source.title || 'Workspace digest';
  const content = visibleDigestMarkdown(source.digest.content ?? '');
  if (!content) return null;
  return `=== Digest: ${title} ===\n${content}`;
}

/** Return the nodeIds of every peer connected to `nodeId` via a 'link' edge. */
function linkedPeersOf(
  nodeId: string,
  edges: ReadonlyArray<ProjectEdge>,
): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (e.kind !== 'link') continue;
    if (e.source === nodeId) out.push(e.target);
    else if (e.target === nodeId) out.push(e.source);
  }
  return out;
}

export function ChatProvider({ children, userId }: { children: React.ReactNode; userId?: string }) {
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({});
  const [projects, setProjectsState] = useState<Project[]>([]);
  // Structural actions often create a tree/node and submit its first message
  // in the same event handler. Keep the project forest synchronously readable,
  // matching nodesRef below, so startStream never builds a graph prerequisite
  // from the previous render's tree list.
  const projectsRef = useRef(projects);
  const setProjects = useCallback<React.Dispatch<React.SetStateAction<Project[]>>>((update) => {
    const updated = typeof update === 'function'
      ? (update as (prev: Project[]) => Project[])(projectsRef.current)
      : update;
    const next = updated.map(project => {
      const identity = remoteEntityIdentity(project.id);
      return identity && !project.backendConnectionId ? { ...project, backendConnectionId: identity.connectionId } : project;
    });
    projectsRef.current = next;
    indexBackendProjects(next);
    setProjectsState(next);
  }, []);
  const activeProjectBaseKey = userId ? buildStateKey(userId) : LEGACY_STATE_KEY;
  // Seed from localStorage so the most-recently-active workspace is restored on
  // boot. Backend hydration runs async; without this seed, `initialActiveProjectIdRef`
  // captures `null` and boot opens the first live workspace instead.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    () => readActiveProjectId(
      userId ? buildStateKey(userId) : LEGACY_STATE_KEY,
      WINDOW_ID,
      readInitialHydrated(userId).activeProjectId,
    ),
  );
  const activeBackendConnectionId = projects.find((project) => project.id === activeProjectId)?.backendConnectionId
    ?? LOCAL_BACKEND_CONNECTION_ID;
  setActiveBackendConnectionId(activeBackendConnectionId);
  const { prefs, setPref } = usePrefs();
  const {
    openPanes,
    slotPanes,
    tabPanes,
    pagePane,
    focusedPane,
    zoomedPane,
    focusNonce,
    paneItems,
    viewMode,
    openPanesMap,
    setOpenPanes,
    setFocusedPane,
    openPane: openPaneState,
    registerPaneItem,
    updatePaneItem,
    replacePaneItem,
    removePaneItem,
    setPaneItemWidth,
    closePane: closePaneState,
    focusPane: focusPaneState,
    zoomPane: zoomPaneState,
    reorderPane,
    setViewMode,
    retainProjectPaneKeys,
    setPaneSlot,
    restorePaneInSlot,
    ensurePaneSlot,
    openPaneInTree,
    appendPaneInTree,
    prunePaneIds,
  } = usePaneState({ projects, activeProjectId, singlePage: prefs.singlePageMode });
  // Latest active workspace id, read synchronously by callbacks that must
  // stay referentially stable for the actions context.
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  // Agent runtime descriptors, fetched on mount and refreshed on the
  // `michi:reload-agent-status` window event (dispatched by chatStreamRunner on
  // auth errors and by Settings when keys change). Not persisted.
  //   - agentStatus: capabilities-shaped descriptor consumed by ApiKeyGate,
  //     Settings (provider/model/reasoning controls), and the TPane toolbar chips.
  //   - availableModes: runtime Agent catalog reused by every picker.
  //   - defaultModeId: fresh-session default resolved for the active workspace.
  // Status and modes retry independently during cold start. The mode hook
  // retains workspace catalogs and exposes a bounded loading state with retry.
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const agentStatusRef = useRef(agentStatus);
  agentStatusRef.current = agentStatus;
  const activeWarmProject = projects.find((project) => project.id === activeProjectId);
  const { availableModes, defaultModeId, agentModesLoading, agentModesError, retryAgentModes } =
    useAgentModeCatalog(activeProjectId, activeBackendConnectionId, agentStatus, activeWarmProject?.cwd);
  const [warmFailedError, setWarmFailedError] = useState<string | null>(null);
  const [agentStatusUnreachable, setAgentStatusUnreachable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAgentStatus(null);
    setWarmFailedError(null);
    setAgentStatusUnreachable(false);
    let statusLoaded = false;
    let statusRequestSeq = 0;
    let statusLoads = 0;
    let retryRun = 0;

    // Track backend warmup for the cold-start error banner, but don't gate
    // /agent/status on it. Status is intentionally fast and lets the composer
    // render its agent/model chips while the runtime warm pool finishes.
    const POLL_INTERVAL_MS = 250;
    const POLL_TIMEOUT_MS = 30_000;

    const waitForReady = async (): Promise<'ready' | 'failed' | 'timeout'> => {
      const t0 = Date.now();
      while (!cancelled && Date.now() - t0 < POLL_TIMEOUT_MS) {
        try {
          const r = await fetchReady();
          if (r.status === 'ready') return 'ready';
          if (r.status === 'failed') {
            setWarmFailedError(r.error ?? 'Runtime failed to start');
            return 'failed';
          }
        } catch {
          // backend not yet listening — keep polling
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      return 'timeout';
    };

    const refreshSanitizedModel = (status: AgentStatus, seq: number) => {
      if (status.capabilities.models !== true) return;
      void listAgentModels({ provider: status.provider })
        .then((modelsResp) => {
          if (cancelled || seq !== statusRequestSeq) return;
          if (!modelsResp.sanitizedModel || modelsResp.sanitizedModel === status.model) return;
          setAgentStatus((prev) =>
            prev && prev.runtime === status.runtime
              ? { ...prev, model: modelsResp.sanitizedModel ?? undefined }
              : prev,
          );
        })
        .catch(() => {});
    };

    const load = async (): Promise<boolean> => {
      const seq = ++statusRequestSeq;
      try {
        // The first read of a remote waits (bounded) for its conversation to paint; refreshes do not.
        const status = statusLoaded ? await fetchAgentStatus() : await fetchAgentStatusAfterFirstPaint(undefined);
        if (cancelled || seq !== statusRequestSeq) return false;
        statusLoaded = true;
        statusLoads += 1;
        rememberRuntimeLabels(activeBackendConnectionId, status.availableRuntimes);
        setAgentStatus(status);
        setAgentStatusUnreachable(false);
        refreshSanitizedModel(status, seq);
        return true;
      } catch {
        // Backend may not be listening yet — loadUntilLoaded retries below.
        return false;
      }
    };

    // Status retries independently of the workspace mode catalog and warmup.
    // Boot and every reload get the same bounded retry; a newer run replaces
    // an older one, and only a run that ends without any status reports the
    // backend unreachable.
    const loadUntilLoaded = async () => {
      const run = ++retryRun;
      const loadsBefore = statusLoads;
      setAgentStatusUnreachable(false);
      const t0 = Date.now();
      while (!cancelled && run === retryRun && statusLoads === loadsBefore && Date.now() - t0 < POLL_TIMEOUT_MS) {
        if (await load()) return;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (!cancelled && run === retryRun && statusLoads === loadsBefore) setAgentStatusUnreachable(true);
    };

    const watchReady = async () => {
      const result = await waitForReady();
      if (cancelled) return;
      if (result === 'ready') setWarmFailedError(null);
      // Backstop: surface status even if the poll above never landed.
      if (result !== 'timeout') {
        if (!statusLoaded) void load();
      }
    };

    void loadUntilLoaded();
    void watchReady();
    const handler = () => { void loadUntilLoaded(); };
    window.addEventListener('michi:reload-agent-status', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('michi:reload-agent-status', handler);
    };
  }, [activeBackendConnectionId]);
  const refreshAgentStatus = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    }
  }, []);

  const [focusedNodeId, setFocusedNodeIdState] = useState<string | null>(null);
  const setFocusedNodeId = useCallback((id: string | null) => {
    setFocusedNodeIdState(id);
    // Keep activeTreeId in sync with focus so the sidebar's ThreadRow active
    // visual never lingers on a tree whose node is no longer focused. If the
    // focused node belongs to a tree, activate that tree. Nodes outside any
    // tree (digest, merge) resolve to null — don't deactivate the current tree.
    if (!id) return;
    setProjects((prev) => {
      const owning = prev.find((p) => p.chatIds.includes(id));
      if (!owning) return prev;
      const treeId = findTreeIdForNode(id, owning);
      if (!treeId || treeId === owning.activeTreeId) return prev;
      return prev.map((p) => (p.id === owning.id ? reduceProject(p, { type: 'activate-tree', treeId }) : p));
    });
  }, []);
  const [unreadFilterOn, setUnreadFilterOnState] = useState<boolean>(false);
  const setUnreadFilterOn = useCallback((on: boolean) => {
    setUnreadFilterOnState(on);
  }, []);

  // Search highlight: holds the current keyword to highlight in chat messages.
  const [searchHighlightTerm, setSearchHighlightTerm] = useState<{ term: string; nodeId: string } | null>(null);

  // Auto-clear search highlight after 8 seconds so it doesn't persist indefinitely.
  // Centralised here to avoid multiple pane instances racing.
  useEffect(() => {
    if (!searchHighlightTerm) return;
    const timer = setTimeout(() => setSearchHighlightTerm(null), 8000);
    return () => clearTimeout(timer);
  }, [searchHighlightTerm]);

  const [selection, setSelectionState] = useState<ReadonlySet<string>>(() => new Set());

  const [hydrated, setHydrated] = useState(false);
  const [treeSelection, setTreeSelection] = useState<ReadonlySet<string>>(() => new Set());

  const toggleSelection = useCallback((nodeId: string) => {
    setSelectionState((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectionState(new Set());
  }, []);

  const toggleTreeSelection = useCallback((treeId: string) => {
    setTreeSelection((prev) => {
      const next = new Set(prev);
      if (next.has(treeId)) next.delete(treeId);
      else next.add(treeId);
      return next;
    });
  }, []);

  const clearTreeSelection = useCallback(() => {
    setTreeSelection(new Set());
  }, []);

  const selectTrees = useCallback((treeIds: Iterable<string>) => {
    setTreeSelection(new Set(treeIds));
  }, []);

  // The sidebar's thread rows of the active workspace; merge chats have a
  // section of their own. A surface that lists other rows passes its own ids.
  const selectAllTrees = useCallback(() => {
    const proj = projects.find((p) => p.id === activeProjectId);
    if (!proj) return;
    selectTrees(proj.trees
      .filter((t) => t.kind !== 'merge' && isListedThread(t, nodesRef.current[t.rootNodeId]))
      .map((t) => t.id));
  }, [projects, activeProjectId, selectTrees]);

  useEffect(() => {
    setSelectionState(new Set());
    setTreeSelection(new Set());
    retainProjectPaneKeys(activeProjectId);
  }, [activeProjectId, retainProjectPaneKeys]);

  // Close any open pane whose node became `deletedAt`, across EVERY pane key
  // (not just the active one). `deleteNode`/`trimNode` only clear the pane key
  // they run in, so a node deleted while another tree/tab holds an open pane —
  // or flipped to `deletedAt` by an L2 sync-conflict adoption — would otherwise
  // linger as a chattable pane even though the tree/sidebar hide it.
  //
  // The derived key is stable across renders (sorted trashed-id join), so the
  // EFFECT only re-fires when the trashed set actually changes; `prunePaneIds`
  // is additionally a no-op (no setState) when none of those ids are open.
  // The scan itself can't gate on the structural-version channel: not every
  // setNodes writer (hydration among them) bumps structureVersion,
  // so gating there could miss deletions. It runs in
  // ChatProvider's render (which already commits per RAF frame while
  // streaming), adding only an allocation-free O(nodeCount) read loop — not the
  // channel-mutating per-chunk work the structural fast-path guards against.
  const deletedIdsKey = useMemo(() => {
    const ids: string[] = [];
    for (const id in nodes) if (nodes[id]?.deletedAt) ids.push(id);
    return ids.sort().join(',');
  }, [nodes]);
  useEffect(() => {
    if (!deletedIdsKey) return;
    prunePaneIds(new Set(deletedIdsKey.split(',')));
  }, [deletedIdsKey, prunePaneIds]);

  const theme: Theme = DARK_PALETTES.has(prefs.terminalPalette) ? 'dark' : 'light';

  const cancelFns = useRef<Record<string, () => void>>({});
  // Tracks nodes whose Stop button was pressed before their cancelFn got
  // registered (i.e. during ensureSession await / pre-SSE window). When
  // startStream finally registers a cancelFn for a node in this set, it
  // invokes it immediately.
  const assistantTextBufs = useRef<Record<string, string>>({});
  /** Nodes ensured in this renderer. Follow-ups still validate with the backend,
   *  but can use its durable history instead of uploading the transcript again. */
  const boundSessionsRef = useRef<Set<string>>(new Set());
  /** Blank branches of a digest: the digest their first session takes as context. */
  const branchContextFromRef = useRef(new Map<string, string>());
  const backgroundTransportRef = useRef<Map<string, ReturnType<typeof createBackgroundTurnTransport>>>(new Map());
  // Direct replay streams installed after a renderer reload. Kept separate
  // from normal prompt cancel fns so re-rendering cannot open duplicate SSE
  // consumers for the same hydrated foreground turn.
  const recoveredForegroundReplayRef = useRef<Map<string, { cancel: () => void; inspect?: () => void }>>(new Map());
  // Stable handle to the current recover() closure so the lazy-loader can ask a
  // just-loaded streaming placeholder to reattach without re-running (and thus
  // tearing down) the whole foreground-replay effect.
  const reconnectStreamingNodeRef = useRef<(nodeId: string) => void>(() => {});
  const backgroundGapReconciliationsRef = useRef(new Map<string, { promise: Promise<ReplayGapInstall | undefined>; signal: AbortSignal }>());
  const backgroundGapRetriesRef = useRef(new BackgroundGapRetries());
  const sharedStreamHandlersRef = useRef<(nodeId: string) => Omit<Partial<StreamHandlers>, 'onEnvelope' | 'onTurnStart' | 'onDone' | 'onError' | 'onErrorPayload'>>(() => ({}));
  const turnEndHandlerRef = useRef<(reason: TurnEndReason, nodeId: string) => void>(() => {});
  const streamCompleteHandlerRef = useRef<(nodeId: string) => void>(() => {});
  // Navigates to a node's pane (switching workspace / thread when needed) and
  // lands on the Dashboard. Assigned below, once the nav actions exist; held in
  // a ref because the stream handlers are built earlier in this component.
  const revealNodeRef = useRef<(nodeId: string) => boolean>(() => false);
  const openAgentRunPaneRef = useRef<(identity: AgentResourceIdentity, workspaceId: string, title?: string) => string>(() => '');
  // Threads created by scheduled runs. In the desktop app their notifications
  // come from Electron main (with click-to-open), so per-turn renderer
  // notifications for them are suppressed to avoid duplicates.
  const scheduledNodeIdsRef = useRef(new Set<string>());
  const scheduledJobRunHandlerRef = useRef<(event: ScheduledJobRunEvent) => void>(() => {});
  const backendNodeInstallsRef = useRef(new Map<string, Promise<boolean>>());
  const backendNodeInstallRequestsRef = useRef(new Map<string, AbortController>());
  useEffect(() => () => {
    for (const request of backendNodeInstallRequestsRef.current.values()) request.abort();
    backendNodeInstallRequestsRef.current.clear();
  }, []);
  // Background frames for a chat this window has never seen (a conversation
  // started on a phone or another machine): handlers for it, while it installs.
  const unknownBackendChatRef = useRef<(connectionId: string, chatId: string, nodeId?: string) => StreamHandlers>(() => ({}));
  const discoveredTurnEndRef = useRef<(nodeId: string) => void>(() => {});
  /** installBackendNode, for stream handlers made before it is defined. */
  const installBackendNodeRef = useRef<(workspaceId: string, nodeId: string, refresh: boolean) => Promise<boolean>>(
    async () => false,
  );
  const commandsInFlightRef = useRef(new Set<string>());
  const sendMessageRef = useRef<(nodeId: string, text: string, meta?: UserSendMeta) => void>(() => {});

  const nodesRef = useRef(nodes);
  // Draft edits keep structural subscribers quiet, but still need durable saves.
  const dirtyDraftNodeIdsRef = useRef(new Set<string>());
  const lastNotifiedNodesRef = useRef(nodes);
  const nodeSubscribersRef = useRef<Map<string, Set<() => void>>>(new Map());
  const storeSubscribersRef = useRef<Set<() => void>>(new Set());
  // Bumps on every non-HIGH_FREQ dispatch. Streamed-token commits keep it
  // still so structural consumers (useStructuralSelector, Task 4) skip work
  // each frame. Locked by chatStore.structural.test.tsx.
  const structureVersionRef = useRef(0);
  const lastNotifiedStructureVersionRef = useRef(0);
  const structureSubscribersRef = useRef<Set<() => void>>(new Set());
  /**
   * Held true by destructive async actions (Empty Trash, single-group purge)
   * while they await the backend's explicit DELETE/purge endpoint. The 2s
   * persistence interval checks this and skips the full-state POST /sync that
   * would otherwise race the purge — a pre-purge snapshot in flight when the
   * DELETE lands would re-insert the just-purged rows. Cleared after the
   * follower setState resolves so the next interval syncs the clean state.
   */
  const syncPausedRef = useRef(false);

  const notifyNodeSubscribers = useCallback((nodeIds: Iterable<string>) => {
    const listeners = new Set<() => void>();
    for (const id of nodeIds) {
      nodeSubscribersRef.current.get(id)?.forEach((listener) => listeners.add(listener));
    }
    listeners.forEach((listener) => listener());
  }, []);

  const notifyChangedNodeSubscribers = useCallback(
    (
      prev: Record<string, ChatNodeState>,
      next: Record<string, ChatNodeState>,
    ) => {
      if (prev === next) return;
      const changed = new Set<string>();
      for (const id of Object.keys(prev)) {
        if (prev[id] !== next[id]) changed.add(id);
      }
      for (const id of Object.keys(next)) {
        if (!(id in prev)) changed.add(id);
      }
      if (changed.size > 0) notifyNodeSubscribers(changed);
    },
    [notifyNodeSubscribers],
  );

  const nodeStore = useMemo<ChatNodeStoreValue>(
    () => ({
      getNode: (nodeId) => nodesRef.current[nodeId],
      getNodes: () => nodesRef.current,
      subscribeNode: (nodeId, listener) => {
        let listeners = nodeSubscribersRef.current.get(nodeId);
        if (!listeners) {
          listeners = new Set();
          nodeSubscribersRef.current.set(nodeId, listeners);
        }
        listeners.add(listener);
        return () => {
          listeners?.delete(listener);
          if (listeners?.size === 0) nodeSubscribersRef.current.delete(nodeId);
        };
      },
      subscribe: (listener) => {
        storeSubscribersRef.current.add(listener);
        return () => {
          storeSubscribersRef.current.delete(listener);
        };
      },
      getStructureVersion: () => structureVersionRef.current,
      subscribeStructure: (listener) => {
        structureSubscribersRef.current.add(listener);
        return () => {
          structureSubscribersRef.current.delete(listener);
        };
      },
    }),
    [],
  );

  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);
  const focusedPaneRef = useRef(focusedPane);
  useEffect(() => { focusedPaneRef.current = focusedPane; }, [focusedPane]);
  const openPanesRef = useRef(openPanes);
  useEffect(() => { openPanesRef.current = openPanes; }, [openPanes]);
  const paneItemsRef = useRef(paneItems);
  paneItemsRef.current = paneItems;

  // Workspace switches intentionally discard the departing workspace's pane
  // slots. Release matching native runtimes at the same boundary so hidden
  // PTYs/WebContentsViews cannot become unreachable background processes.
  // Terminal panes are exempt: they are window-scoped and survive workspace
  // switches. Only an explicit pane close destroys their PTY.
  useEffect(() => {
    if (!hydrated || !activeProjectId) return;
    for (const item of Object.values(paneItemsRef.current)) {
      if (item.projectId === activeProjectId) continue;
      if (item.kind === 'terminal') continue;
      if (item.kind === 'browser') getElectron()?.browserDestroy?.(item.surfaceId);
      removePaneItem(item.id);
    }
  }, [activeProjectId, hydrated, removePaneItem]);

  useEffect(() => {
    if (!hydrated) return;
    for (const item of Object.values(paneItemsRef.current)) {
      // Terminal panes are window-scoped; never garbage-collected by tree/project orphan checks.
      if (item.kind === 'terminal') continue;
      const project = projects.find((candidate) => candidate.id === item.projectId);
      if (project && (item.treeId === null || project.trees.some((tree) => tree.id === item.treeId))) continue;
      if (item.kind === 'browser') getElectron()?.browserDestroy?.(item.surfaceId);
      removePaneItem(item.id);
    }
  }, [hydrated, projects, removePaneItem]);

  // Every switch of the focused pane (Ctrl+Tab, captions, tabs, the phone
  // switcher, zoom, a click, a close, a new branch) moves the viewed chat with
  // it: a chat pane is viewed, so its replies count as read; any other pane
  // leaves none.
  const viewPane = useCallback((paneId: string | null) => {
    setFocusedNodeIdState(paneId && nodesRef.current[paneId] ? paneId : null);
  }, []);

  const closePaneRaw = useCallback((paneId: string) => {
    const item = paneItemsRef.current[paneId];
    if (item?.kind === 'terminal') {
      const target = terminalTargetForPane(item);
      if (target.transport === 'native') getElectron()?.terminalDestroy?.(item.surfaceId);
      // Ends the shell unless another window still shows it.
      else void closeTerminal(target.connectionId, item.surfaceId, TERMINAL_CLIENT_ID).catch(() => {});
    }
    if (item?.kind === 'browser') getElectron()?.browserDestroy?.(item.surfaceId);
    if (item) removePaneItem(paneId);

    const remaining = openPanes.filter((id) => id !== paneId);
    closePaneState(paneId);
    if (focusedPane === paneId) viewPane(paneAfterClose(slotPanes ?? [], paneId));
    else if (focusedNodeId === paneId) viewPane(focusedPane);
    // The assistant's hidden workspace is active only while its conversation
    // is open as a pane: closing that pane (×, ⌘W, ⌘J back to the panel)
    // returns to the user's workspace rather than leaving an empty one no
    // list shows.
    if (remaining.length === 0) {
      const projectsNow = projectsRef.current;
      if (isSystemWorkspace(projectsNow.find((p) => p.id === activeProjectIdRef.current))) {
        const back = userWorkspaceToReturnTo(projectsNow);
        if (back) setActiveProjectId(back);
      }
    }
  }, [closePaneState, focusedNodeId, focusedPane, openPanes, removePaneItem, slotPanes, viewPane]);

  const openPane = useCallback((paneId: string) => {
    openPaneState(paneId);
    viewPane(paneId);
  }, [openPaneState, viewPane]);
  const focusPane = useCallback((paneId: string) => {
    focusPaneState(paneId);
    viewPane(paneId);
  }, [focusPaneState, viewPane]);
  const zoomPane = useCallback((paneId: string | null) => {
    zoomPaneState(paneId);
    if (paneId !== null) viewPane(paneId);
  }, [zoomPaneState, viewPane]);

  // `dispatch` keeps nodesRef.current up-to-date synchronously for the
  // reducer path, and structural setNodes callers must do the same before
  // asking React to render. This effect is only the notification bridge for
  // React commits.
  //
  // IMPORTANT: do not copy the committed `nodes` value back into nodesRef.
  // RAF-coalesced streaming renders can commit an older snapshot after
  // nodesRef has already advanced. Treating that commit as authoritative
  // rolls the stream backward and drops text mid-reply (for example broken
  // `[FOLLOW-` prefixes in follow-up sentinels).
  // Structural refs (structureVersionRef / lastNotifiedStructureVersionRef /
  // structureSubscribersRef) are also intentionally omitted — refs are stable
  // by definition and adding them would make the gate self-defeating.
  useEffect(() => {
    const prev = lastNotifiedNodesRef.current;
    const next = nodesRef.current;
    if (prev === next) return;
    lastNotifiedNodesRef.current = next;
    notifyChangedNodeSubscribers(prev, next);
    storeSubscribersRef.current.forEach((l) => l());

    // Structural channel: only fire when the version actually advanced since
    // the last commit. Streamed-token commits keep the version unchanged, so
    // useStructuralSelector consumers do not re-snapshot during streaming.
    const v = structureVersionRef.current;
    if (v !== lastNotifiedStructureVersionRef.current) {
      lastNotifiedStructureVersionRef.current = v;
      structureSubscribersRef.current.forEach((l) => l());
    }
  }, [nodes, notifyChangedNodeSubscribers]);

  // One tree read pool for the provider: hydration hands it the visible remote
  // thread's boot read, the lazy loader and self-heal read through it, and every
  // remote first page it reads is kept for the next boot.
  const remoteTreePageSinkRef = useRef<(project: Project, treeId: string, page: TreeMessagePage) => void>(() => {});
  const treeMessageRequestsRef = useRef<TreeMessageRequests | null>(null);
  treeMessageRequestsRef.current ??= new TreeMessageRequests({
    onRemotePage: (project, treeId, page) => remoteTreePageSinkRef.current(project, treeId, page),
  });
  const {
    runWorkspaceMutation, noteRemoteTreePage, noteBackendInstalled, pendingBackendDeletes, noteArtifactNamed, probeArtifacts,
    noteConnectionRecovered, adoptBackendStructure, structureGuards, workspacesBusy, whenWorkspacesSettled,
  } = useWorkspacePersistence({
    projects,
    activeProjectId,
    nodes,
    structureVersion: nodeStore.getStructureVersion(),
    hydrated,
    nodesRef,
    setProjects,
    setActiveProjectId,
    setNodes,
    setHydrated,
    userId,
    windowId: WINDOW_ID,
    syncPausedRef,
    dirtyDraftNodeIdsRef,
    treeMessageRequests: treeMessageRequestsRef.current,
  });
  remoteTreePageSinkRef.current = noteRemoteTreePage;

  // Structure changes made elsewhere (workspace_structure_changed on the
  // background feed): re-read the workspaces they name and merge them in.
  const structureFeedHandler = useStructureSync({
    hydrated,
    projectsRef,
    nodesRef,
    activeProjectIdRef,
    setProjects,
    setNodes,
    setActiveProjectId,
    structureVersionRef,
    prunePaneIds,
    persistence: { adoptBackendStructure, structureGuards, workspacesBusy, whenWorkspacesSettled },
  });
  const structureFeedHandlerRef = useRef(structureFeedHandler);
  structureFeedHandlerRef.current = structureFeedHandler;

  // Pane Presence — reports every open pane slot for the ACTIVE project (across all its trees,
  // not just the visible one) to the backend presence registry (design §9; W13 brief). Mounted
  // exactly once here so the reporter's own per-connection lease never gets duplicated by a
  // second mount elsewhere. Disabled entirely (empty `backends`) until the active connection's
  // capability probe confirms `paneInspection: 'v1'` support and workspace hydration completes —
  // see usePanePresenceIntegration's own doc comment for the full gate/allocation contract.
  usePanePresenceIntegration({
    windowId: WINDOW_ID,
    hydrated,
    projects,
    activeProjectId,
    activeBackendConnectionId,
    openPanesMap,
    paneItems,
    // What the active tree's layout displays (one page in single-page mode): of these, the
    // panes on screen are reported visible.
    displayedPanes: openPanes,
  });

  useEffect(() => {
    if (!hydrated) return;
    writeActiveProjectId(activeProjectBaseKey, WINDOW_ID, activeProjectId);
  }, [hydrated, activeProjectId, activeProjectBaseKey]);

  useWorkspacePrewarm(hydrated, activeWarmProject, agentStatus);

  const rafPending = React.useRef(false);

  const dispatch = useCallback((a: ChatAction) => {
    // Compute next from the ref (single source of truth for "latest"),
    // update the ref synchronously, then push to React. The previous pattern
    // (inside the setNodes functional updater) relied on React running
    // updaters synchronously — which it does not reliably do across renders
    // and batched event handlers. This caused startStream(newId, …) to read
    // the old ref and bail out when called right after a 'create' dispatch.
    const previous = nodesRef.current;
    const next = reduceNodes(previous, a);
    nodesRef.current = next;
    if ('nodeId' in a && previous[a.nodeId]?.composerDraft !== next[a.nodeId]?.composerDraft) {
      dirtyDraftNodeIdsRef.current.add(a.nodeId);
    }

    if (!HIGH_FREQ_ACTIONS.has(a.type)) {
      structureVersionRef.current += 1;
    }

    // For high-frequency streaming actions, coalesce React renders into one
    // per animation frame. The ref is already up-to-date for synchronous
    // reads (e.g. startStream right after create).
    if (HIGH_FREQ_ACTIONS.has(a.type)) {
      if (!rafPending.current) {
        rafPending.current = true;
        requestAnimationFrame(() => {
          rafPending.current = false;
          setNodes(nodesRef.current);
        });
      }
    } else {
      setNodes(next);
    }

    if (NODE_ACTIVITY_ACTIONS.has(a.type)) {
      const nodeId =
        'nodeId' in a ? a.nodeId : 'parentNodeId' in a ? a.parentNodeId : undefined;
      if (!nodeId) return;
      const now = Date.now();
      setProjects((prev) =>
        prev.map((p) => {
          if (!p.chatIds.includes(nodeId)) return p;
          const treeId = findTreeIdForNode(nodeId, p);
          if (!treeId) return p;
          return reduceProject(p, { type: 'touch-tree', treeId, now });
        }),
      );
    }
  }, []);

  // Lazy-load: fetch the active tree's message bodies on demand when it's a
  // placeholder (hydration only eager-loads the initially-active tree).
  // Mounted after `dispatch` is defined so it can dispatch `messages-loaded`.
  const { prefetchNode: prefetchTreeForNode, ensureNodeMessages } = useLazyTreeMessages({ hydrated, activeProjectId, projects, nodesRef, dispatch, reconnectStreamingRef: reconnectStreamingNodeRef, requests: treeMessageRequestsRef.current });
  const { loadOlderMessages, ensureCompleteHistory } = useMessageHistory(nodesRef, projectsRef, dispatch, reconnectStreamingNodeRef);
  // Sends waiting on their thread's history, their runtime's / catalog, or a
  // remote shown from the local cache.
  const preparingSends = useRef(new Set<string>());

  /** A foreground turn or host command owns the node's live state. */
  const nodeBusy = useCallback((nodeId: string) => !!cancelFns.current[nodeId] || commandsInFlightRef.current.has(nodeId), []);

  /** Put what a backend read brings in into the store: it is already durable, so never written back. */
  const commitBackendInstall = useCallback((result: {
    projects: Project[];
    nodes: Record<string, ChatNodeState>;
    adoptions?: readonly StructureAdoption[];
    installed?: BackendInstalledEntities | null;
    artifactProbes?: { projectId: string; contextIds: string[] };
  }) => {
    // Before the store changes: the scan that renders it takes it as durable.
    for (const adoption of result.adoptions ?? []) adoptBackendStructure(adoption);
    if (result.installed) noteBackendInstalled(result.installed);
    if (result.projects !== projectsRef.current) setProjects(result.projects);
    if (result.artifactProbes) probeArtifacts(result.artifactProbes.projectId, result.artifactProbes.contextIds);
    if (result.nodes !== nodesRef.current) {
      nodesRef.current = result.nodes;
      structureVersionRef.current += 1;
      setNodes(result.nodes);
    }
  }, [adoptBackendStructure, noteBackendInstalled, probeArtifacts, setProjects]);

  const reconcileBackgroundGap = useCallback(async (
    gap: BackgroundReplayGap,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ReplayGapInstall | undefined> => {
    const existing = backgroundGapReconciliationsRef.current.get(gap.chatId);
    // A reconnect re-sends the gap; a read tied to a feed that has closed since
    // is about to abort and is no answer for the new feed.
    if (existing && !existing.signal.aborted) return existing.promise;

    /**
     * Read the workspace's structure and the gap node's latest page, never the
     * workspace's bodies, and install them. Resolves the background cursor the
     * node now holds, or undefined when there is nothing to install: the node
     * is gone, moved to another thread, or this window's foreground stream
     * still owns its turn.
     */
    const install = async (nodeId: string, workspaceId: string): Promise<ReplayGapInstall | undefined> => {
      const foregroundDeadline = Date.now() + GAP_FOREGROUND_WAIT_MS;
      const read = await readAndInstallNode({
        workspaceId,
        nodeId,
        attempts: BACKGROUND_GAP_ATTEMPTS,
        signal,
        readTimeoutMs: GAP_READ_TIMEOUT_MS,
        project: () => projectsRef.current.find((candidate) => candidate.id === workspaceId),
        node: () => nodesRef.current[nodeId],
        nodeHeld: true,
        busy: () => nodeBusy(nodeId),
        // A foreground stream owns the node's live turn, and this window's
        // own turn frames never come through this feed. Hold the feed only so
        // long; the turn's own stream keeps the node current.
        idle: async () => {
          while (nodeBusy(nodeId)) {
            if (Date.now() >= foregroundDeadline) return false;
            await abortableDelay(50, signal);
          }
          return true;
        },
        fetchStructure: fetchWorkspaceStructure,
        fetchPage: fetchTreeMessagePage,
        install: ({ structure, page, readStartedAt }) => {
          const result = reconcileBackgroundWorkspaceSnapshot({
            currentProjects: projectsRef.current,
            currentNodes: nodesRef.current,
            rawWorkspace: structure,
            page,
            readStartedAt,
            guards: structureGuards,
            gap: { ...gap, nodeId },
          });
          if (!result) throw new Error(`Durable workspace snapshot omitted ${gap.chatId}`);
          commitBackendInstall(result);
          return result.cursor;
        },
      });
      if (read === 'exhausted') throw new Error(`The conversation kept changing while its replay gap was read: ${gap.chatId}`);
      return read === 'gone' ? undefined : read.installed;
    };

    const retries = backgroundGapRetriesRef.current;
    const reconciliation = (async (): Promise<ReplayGapInstall | undefined> => {
      const nodeId = gap.nodeId
        ?? Object.values(nodesRef.current).find((candidate) => candidate.chatId === gap.chatId)?.nodeId;
      const node = nodeId ? nodesRef.current[nodeId] : undefined;
      const project = node
        ? projectsRef.current.find((candidate) => candidate.id === node.projectId)
        : undefined;
      if (!nodeId || !node || !project) {
        throw new Error(`Cannot reconcile background gap for unknown chat ${gap.chatId}`);
      }
      // The same gap comes back on every reconnect until it reconciles.
      await abortableDelay(retries.delay(gap), signal);
      try {
        const installed = await install(nodeId, project.id);
        retries.settled(gap);
        return installed;
      } catch (error) {
        if (!signal.aborted) retries.failed(gap);
        throw error;
      }
    })().finally(() => {
      if (backgroundGapReconciliationsRef.current.get(gap.chatId)?.promise === reconciliation) {
        backgroundGapReconciliationsRef.current.delete(gap.chatId);
      }
    });
    backgroundGapReconciliationsRef.current.set(gap.chatId, { promise: reconciliation, signal });
    return reconciliation;
  }, [commitBackendInstall, nodeBusy, structureGuards]);

  const installWorkspaceSnapshot = useCallback((rawWorkspace: unknown, readStartedAt?: number): boolean => {
    // A snapshot read before one of this window's removals reached the
    // backend must not bring the removed trees and edges back.
    const merged = mergeWorkspaceSnapshot(projectsRef.current, nodesRef.current, rawWorkspace, {
      pendingDeletes: pendingBackendDeletes,
      readStartedAt,
    });
    if (!merged) return false;
    commitBackendInstall({ ...merged, installed: backendInstalledEntities(projectsRef.current, nodesRef.current, merged) });
    return true;
  }, [commitBackendInstall, pendingBackendDeletes]);

  // A remote shown from the local cache opens its feed once its own metadata
  // replaced the copy (that install changes `projects`): the feed's opening
  // cursor is then checked against a real hydration read, as at any boot.
  const backgroundConnectionIdsKey = useMemo(
    () => Array.from(new Set([
      LOCAL_BACKEND_CONNECTION_ID,
      ...projects.map(projectConnectionId)
        .filter((connectionId) => !backendConnectionProvisional(connectionId)),
    ])).sort().join('|'),
    [projects],
  );

  useEffect(() => {
    if (!hydrated) return;
    const connectionIds = backgroundConnectionIdsKey ? backgroundConnectionIdsKey.split('|') : [];
    for (const connectionId of connectionIds) {
      const bindings = new Map<string, { nodeId: string; handlers: StreamHandlers }>();
      const belongsToConnection = (node: ChatNodeState): boolean => {
        const project = projectsRef.current.find((candidate) => candidate.id === node.projectId);
        return (project ? projectConnectionId(project) : LOCAL_BACKEND_CONNECTION_ID) === connectionId;
      };
      const transport = createBackgroundTurnTransport({
        connectionId,
        cursorSnapshot: () => {
          const cursors: Record<string, { turnId: string; seq: number }> = {};
          for (const node of Object.values(nodesRef.current)) {
            if (!belongsToConnection(node)) continue;
            // A bound chat's id is its node id. A chat with no applied turn
            // still names itself, so its first turn can come back as a gap.
            cursors[node.chatId ?? node.nodeId] = backgroundReplayCursor(node, !!cancelFns.current[node.nodeId])
              ?? NO_APPLIED_TURN_CURSOR;
          }
          return cursors;
        },
        onReplayGap: reconcileBackgroundGap,
        // Scheduling is local-only; remote feeds never carry these frames.
        onScheduledJobRun: connectionId === LOCAL_BACKEND_CONNECTION_ID
          ? (event) => scheduledJobRunHandlerRef.current(event)
          : undefined,
        // The Scheduled page refreshes on this.
        onScheduledJobsChanged: connectionId === LOCAL_BACKEND_CONNECTION_ID
          ? (event) => window.dispatchEvent(new CustomEvent(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT, { detail: event }))
          : undefined,
        onWorkspaceStructureChanged: (event) => structureFeedHandlerRef.current(connectionId, event),
        // Back after a disconnect, the backend may be another build: what it
        // advertised is read again before it is relied on (workspacePersistence).
        onReconnect: () => noteConnectionRecovered(connectionId),
        handlersForChat: (chatId, envelopeNodeId) => {
          const byEnvelope = envelopeNodeId ? nodesRef.current[envelopeNodeId] : undefined;
          const node = byEnvelope && (byEnvelope.chatId === chatId || byEnvelope.nodeId === chatId) && belongsToConnection(byEnvelope)
            ? byEnvelope
            : Object.values(nodesRef.current).find(
                (candidate) => candidate.chatId === chatId && belongsToConnection(candidate),
              );
          // A conversation another device started after this window loaded:
          // install it from the backend so it shows up without a reload.
          if (!node) return unknownBackendChatRef.current(connectionId, chatId, envelopeNodeId);
          const nodeId = node.nodeId;
          // Another device can start the first turn before this renderer has
          // ever opened a native session for this existing node.
          if (!node.chatId) dispatch({ type: 'bind-chat', nodeId });
          const cached = bindings.get(chatId);
          if (cached?.nodeId === nodeId) return cached.handlers;
          const handlers = createBackgroundTurnBinding({
            chatId,
            nodeId,
            dispatch,
            lastTurnRef: {
              get current() { return nodesRef.current[nodeId]?.lastAppliedBackgroundTurnId ?? ''; },
              set current(_value: string) {},
            },
            lastSeqRef: {
              get current() { return nodesRef.current[nodeId]?.lastAppliedBackgroundSeq ?? -1; },
              set current(_value: number) {},
            },
            extraHandlers: sharedStreamHandlersRef.current(nodeId),
            workspaceId: () => nodesRef.current[nodeId]?.projectId,
            onTurnEnd: (reason, endedNodeId) => {
              turnEndHandlerRef.current(reason, endedNodeId);
              discoveredTurnEndRef.current(endedNodeId);
            },
            onStreamComplete: () => streamCompleteHandlerRef.current(nodeId),
          }).createHandlers();
          bindings.set(chatId, { nodeId, handlers });
          return handlers;
        },
      });
      backgroundTransportRef.current.set(connectionId, transport);
      transport.start();
    }
    return () => {
      for (const connectionId of connectionIds) {
        backgroundTransportRef.current.get(connectionId)?.stop();
        backgroundTransportRef.current.delete(connectionId);
      }
    };
  }, [backgroundConnectionIdsKey, dispatch, hydrated, noteConnectionRecovered, reconcileBackgroundGap]);

  // Back in the foreground, or with a pane opened, the window checks itself
  // against SQLite: a feed that is down or missed a turn delays it, no more.
  const backgroundCatchUpRef = useRef<ReturnType<typeof createBackgroundCatchUp> | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    const connectionOf = (node: ChatNodeState): string => (
      projectsRef.current.find((candidate) => candidate.id === node.projectId)?.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID
    );
    const catchUp = createBackgroundCatchUp({
      connectionIds: () => (backgroundConnectionIdsKey ? backgroundConnectionIdsKey.split('|') : []),
      // The workspace on screen; another one's panes check themselves as they open.
      nodesFor: (connectionId) => Object.values(nodesRef.current).filter((node) => (
        node.projectId === activeProjectIdRef.current && connectionOf(node) === connectionId
      )),
      node: (nodeId) => nodesRef.current[nodeId],
      nodeConnection: (nodeId) => {
        const node = nodesRef.current[nodeId];
        return node ? connectionOf(node) : undefined;
      },
      foregroundActive: (nodeId) => !!cancelFns.current[nodeId],
      fetchCursors: (chatIds, connectionId, signal) => fetchBackgroundCursors(chatIds, connectionId, signal),
      reconcile: (gap) => reconcileBackgroundGap(gap),
    });
    backgroundCatchUpRef.current = catchUp;
    const onForeground = () => {
      if (document.visibilityState === 'visible') catchUp.requestAll();
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    return () => {
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
      catchUp.dispose();
      if (backgroundCatchUpRef.current === catchUp) backgroundCatchUpRef.current = null;
    };
  }, [backgroundConnectionIdsKey, hydrated, reconcileBackgroundGap]);
  const catchUpNodes = useCallback((nodeIds: readonly string[]) => {
    backgroundCatchUpRef.current?.request(nodeIds);
  }, []);

  // A reload can happen while a turn is still active. Reattach to its per-chat
  // replay stream exactly once, as the sending window does (reattachTurnReplay).
  // A runtime self-turn is refused there (turn_background_owned) and is left
  // live: the shared background feed delivers it, and marking this node
  // done/error would hide it. When the live replay is gone, the saved turn decides.
  useEffect(() => {
    if (!hydrated) return;
    const recover = (nodeId: string) => {
      const node = nodesRef.current[nodeId];
      if (
        !node
        || node.status !== 'streaming'
        || !node.chatId
        || !node.lastAppliedTurnId
        || typeof node.lastAppliedSeq !== 'number'
        || recoveredForegroundReplayRef.current.has(nodeId)
      ) return;
      const assistantId = [...node.messages].reverse().find((message) => message.role === 'assistant')?.id;
      if (!assistantId) return;
      const chatId = node.chatId;
      const turnId = node.lastAppliedTurnId;
      let stopped = false;
      const finish = () => {
        const entry = recoveredForegroundReplayRef.current.get(nodeId);
        if (entry?.cancel === cancel) recoveredForegroundReplayRef.current.delete(nodeId);
        if (cancelFns.current[nodeId] === stop) delete cancelFns.current[nodeId];
      };
      // The turn may still be running or already saved: Retry inspects it, never re-sends its prompt.
      const fail = (message: string, errorKind: string) => {
        dispatch({ type: 'error', nodeId, assistantId, message, errorKind, turnId });
        finish();
      };
      const binding = createBackgroundTurnBinding({
        chatId,
        nodeId,
        dispatch,
        cursor: 'foreground',
        lastTurnRef: {
          get current() { return nodesRef.current[nodeId]?.lastAppliedTurnId ?? ''; },
          set current(_value: string) {},
        },
        lastSeqRef: {
          get current() { return nodesRef.current[nodeId]?.lastAppliedSeq ?? -1; },
          set current(_value: number) {},
        },
        extraHandlers: sharedStreamHandlersRef.current(nodeId),
        workspaceId: () => nodesRef.current[nodeId]?.projectId,
        onTurnEnd: (reason, endedNodeId) => turnEndHandlerRef.current(reason, endedNodeId),
        onStreamComplete: () => streamCompleteHandlerRef.current(nodeId),
        onTerminal: finish,
      }).createHandlers();
      // The entry stays while the replay waits to reconnect, so Stop and
      // cleanup can end it. It replays only this turn into this assistant
      // message: once another turn owns the node, it ends instead.
      const cancel = reattachTurnReplay(chatId, {
        turnId,
        nextSeq: () => (nodesRef.current[nodeId]?.lastAppliedSeq ?? -1) + 1,
        handlers: binding,
        isCurrent: () => {
          const current = nodesRef.current[nodeId];
          return !stopped && recoveredForegroundReplayRef.current.get(nodeId)?.cancel === cancel
            && current?.status === 'streaming' && current.lastAppliedTurnId === turnId
            && current.messages.findLast((message) => message.role === 'assistant')?.id === assistantId;
        },
        onStale: finish,
        onBackgroundOwned: finish,
        onUnavailable: fail,
        onReplayGone: (message, errorKind) => {
          const entry = recoveredForegroundReplayRef.current.get(nodeId);
          if (!entry) return;
          entry.inspect = inspectOriginalTurn({
            chatId,
            turnId,
            onResult: ({ persisted, assistant, lastSeq, completedAt, stopReason }) => {
              const current = nodesRef.current[nodeId];
              if (stopped || current?.status !== 'streaming' || current.lastAppliedTurnId !== turnId) {
                finish();
                return;
              }
              if (!persisted || !assistant || typeof lastSeq !== 'number') {
                fail(message, errorKind);
                return;
              }
              dispatch({ type: 'recover-original-result', nodeId, turnId, assistantId, assistant, lastSeq, cursor: 'foreground' });
              binding.onDone?.(stopReason, assistant.id, turnId, true, completedAt);
            },
          });
        },
      });
      const stop = () => {
        stopped = true;
        recoveredForegroundReplayRef.current.get(nodeId)?.inspect?.();
        cancel();
        dispatch({ type: 'done', nodeId, assistantId, aborted: true });
        cancelChatAndObserve(chatId, turnId, (status) => {
          dispatch({ type: 'cancel-recovery', nodeId, assistantId, ...status });
        });
        finish();
        turnEndHandlerRef.current('cancel', nodeId);
      };
      recoveredForegroundReplayRef.current.set(nodeId, { cancel });
      cancelFns.current[nodeId] = stop;
    };
    // Expose the live closure so the lazy-loader can reattach a streaming
    // placeholder the moment its checkpoint body lands (recover() dedupes and
    // no-ops until the node has an assistant message, so re-calls are safe).
    reconnectStreamingNodeRef.current = recover;
    for (const node of Object.values(nodesRef.current)) recover(node.nodeId);
    return () => {
      for (const entry of recoveredForegroundReplayRef.current.values()) {
        entry.inspect?.();
        entry.cancel();
      }
      recoveredForegroundReplayRef.current.clear();
    };
  }, [dispatch, hydrated]);

  // When the user moves focus to a node, mark it as viewed so the unread
  // indicator clears. On cleanup (focus departing), re-stamp viewedAt so any
  // lastAssistantAt that landed while focused is covered — without this, a
  // node that completed streaming while you were looking at it would show
  // unread the moment you navigated away.
  useEffect(() => {
    if (focusedNodeId !== null) {
      dispatch({ type: 'node-viewed', nodeId: focusedNodeId, viewedAt: Date.now() });
    }
    return () => {
      if (focusedNodeId !== null) {
        dispatch({ type: 'node-viewed', nodeId: focusedNodeId, viewedAt: Date.now() });
      }
    };
  }, [focusedNodeId, dispatch]);
  // Server completion facts: the focused node's completions are seen only while this window is in front.
  const focusedNodeFacts = focusedNodeId !== null ? nodes[focusedNodeId] : undefined;
  useFocusedNodeSeen(focusedNodeId, focusedNodeFacts?.completionSeq, focusedNodeFacts?.seenCompletionSeq, dispatch);
  // So are those of the conversation the panel shows (V, open on Chat).
  const assistantShownNodeIds = useCompanionPanelShownNodeIds();
  useShownNodesSeen(assistantShownNodeIds, nodes, dispatch);

  // Bulk close of the read loop — used by the unread filter's "Read all"
  // action to clear every unread chat thread at once.
  const markAllRead = useCallback(() => {
    dispatch({ type: 'mark-all-read', viewedAt: Date.now() });
  }, [dispatch]);

  const renameNodeRaw = useCallback(
    (nodeId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      dispatch({ type: 'rename-node', nodeId, title: trimmed });
      // A thread's name is its root's title: a legacy name stored apart would still show.
      if (projectsRef.current.some((p) => p.trees.some((t) => t.rootNodeId === nodeId && t.name !== undefined))) {
        setProjects((prev) => prev.map((p) => reduceProject(p, { type: 'clear-thread-name', rootNodeId: nodeId })));
      }
    },
    [dispatch, setProjects],
  );

  const pinNodeRaw = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'pin-node', nodeId, now: Date.now() });
    },
    [dispatch],
  );

  const unpinNodeRaw = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'unpin-node', nodeId });
    },
    [dispatch],
  );

  const newNodeId = useCallback(
    (projectId = activeProjectIdRef.current) => backendEntityId(
      projectId ? backendConnectionIdForWorkspace(projectId) : LOCAL_BACKEND_CONNECTION_ID,
      allocateNodeIdsLocal(1)[0],
    ),
    [],
  );

  // Notices about a node go through the attention policy
  // (services/attention/policy.ts), which stays quiet only while this window
  // shows the node and has the user's attention.
  const presentNodeAttention = useCallback((
    nodeId: string,
    notice: Pick<AttentionIntent, 'kind' | 'title' | 'body' | 'isStillCurrent' | 'showToast'>,
  ) => {
    const node = nodesRef.current[nodeId];
    const project = node ? projectsRef.current.find((candidate) => candidate.id === node.projectId) : undefined;
    const target = {
      type: 'node' as const,
      nodeId,
      workspaceId: node?.projectId,
      backendConnectionId: project?.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID,
    };
    // That backend decides and announces this itself (attention_* frames,
    // presented below): a local notice would say it twice.
    if (isServerAttentionActive(target.backendConnectionId)) return;
    presentAttention({
      ...notice,
      key: attentionTargetKey(target),
      target,
      isTargetVisible: () => isNodeShownInWindow(nodeId, openPanesRef.current),
      onOpen: () => revealNodeRef.current(nodeId),
    });
  }, []);
  // Notices the backend decided (services/serverAttention.ts) go through the
  // same policy. Ids in the records are the backend's; this window's node and
  // workspace ids are scoped per connection. The policy's own delay re-reads
  // the record, so one resolved meanwhile (answered, seen) never shows.
  useEffect(() => {
    const localTarget = (target: ServerAttentionIntent['target']) => {
      const conn = target.backendConnectionId;
      const workspaceId = backendEntityId(conn, target.workspaceId);
      switch (target.type) {
        case 'node':
          return { type: 'node' as const, nodeId: backendEntityId(conn, target.nodeId), workspaceId, backendConnectionId: conn };
        case 'agent_run':
          return { type: 'agent_run' as const, runId: target.runId, workspaceId, backendConnectionId: conn };
        case 'agent':
          return { type: 'agent' as const, ref: target.ref, open: target.open, workspaceId, backendConnectionId: conn };
        case 'scheduled_run':
          return { type: 'scheduled_run' as const, runId: target.runId, jobId: target.jobId,
            nodeId: target.nodeId ? backendEntityId(conn, target.nodeId) : null, workspaceId, backendConnectionId: conn };
      }
    };
    const inView = (target: ReturnType<typeof localTarget>): boolean => {
      switch (target.type) {
        case 'node':
          return isNodeShownInWindow(target.nodeId, openPanesRef.current);
        case 'agent_run':
          return isPaneShownInWindow(agentRunPaneId(target.backendConnectionId, target.runId), openPanesRef.current);
        case 'scheduled_run':
          return target.nodeId !== null && isNodeShownInWindow(target.nodeId, openPanesRef.current);
        case 'agent': {
          // Michi's own: its panel on the tab the record opens (this window's backend only), or the conversation it names.
          const { open } = target;
          if (open.kind === 'node') return isNodeShownInWindow(backendEntityId(target.backendConnectionId, open.nodeId), openPanesRef.current);
          if (open.kind !== 'companion' || target.backendConnectionId !== LOCAL_BACKEND_CONNECTION_ID) return false;
          const panel = getCompanionPanelState();
          return panel.open && panel.tab === open.tab;
        }
      }
    };
    /** Michi's and a scheduled run's records open through the shell's own openers; another backend's, where this window can. */
    const openTarget = (target: ReturnType<typeof localTarget>, serverTarget: ServerAttentionIntent['target']) => {
      if (target.type === 'node') {
        revealNodeRef.current(target.nodeId);
        return;
      }
      const local = target.backendConnectionId === LOCAL_BACKEND_CONNECTION_ID;
      if (target.type === 'agent') {
        if (local) requestOpenCompanionTarget(target.open);
        else if (target.open.kind === 'node') revealNodeRef.current(backendEntityId(target.backendConnectionId, target.open.nodeId));
        return;
      }
      if (target.type === 'scheduled_run' && serverTarget.type === 'scheduled_run') {
        if (local) requestOpenScheduledRun({ runId: serverTarget.runId, jobId: serverTarget.jobId, workspaceId: serverTarget.workspaceId, nodeId: serverTarget.nodeId });
        else if (target.nodeId) revealNodeRef.current(target.nodeId);
        return;
      }
      if (target.type !== 'agent_run') return;
      // The pane is named for its agent (the notice's title says what happened), else the default.
      const run = { backendConnectionId: target.backendConnectionId, id: target.runId };
      openAgentRunPaneRef.current(run, target.workspaceId, knownAgentRunName(run));
    };
    return subscribeServerAttention((intent, presentation) => {
      const target = localTarget(intent.target);
      const key = attentionTargetKey(target);
      presentAttention({
        key,
        kind: intent.kind,
        reason: intent.reason,
        title: intent.title,
        body: intent.body,
        target,
        source: 'server',
        // Another window holds the claim: it alone raises the OS notification.
        osNotification: presentation.claimed ? 'auto' : 'never',
        isTargetVisible: () => inView(target),
        isStillCurrent: () => activeServerAttentionRecord(target.backendConnectionId, intent.serverId) !== undefined,
        // A question this window holds is in AskUserNotice already: no toast saying it again.
        showToast: () => !(intent.reason === 'question' && target.type === 'node'
          && isAwaitingUserInput(nodesRef.current[target.nodeId])),
        onOpen: () => {
          try {
            openTarget(target, intent.target);
          } catch (error) {
            // Its workspace is not loaded in this window (openAgentRunPane selects a loaded one itself).
            console.warn('[attention] could not open the notice target', error);
          }
        },
      });
      return () => dismissAttention(key, intent.kind);
    }, { isTargetInView: (intent) => inView(localTarget(intent.target)) });
  }, []);
  // An approval or question answered (here, elsewhere or automatically): its
  // "needs input" notice is moot once nothing on the node waits for the user.
  const dismissAnsweredAttention = useCallback((nodeId: string) => {
    const node = nodesRef.current[nodeId];
    if (node?.pendingPermission || (node?.pendingUserInput && !node.pendingUserInput.resolved)) return;
    dismissAttention(attentionTargetKey({ type: 'node', nodeId }), 'needs_input');
  }, []);

  /** Feature side effects shared by foreground and runtime self-turn streams. */
  const createSharedStreamHandlers = useCallback((nodeId: string): Omit<Partial<StreamHandlers>, 'onEnvelope' | 'onTurnStart' | 'onDone' | 'onError' | 'onErrorPayload'> => ({
    onArtifactSaved: (name, filePath, size, contextId) => {
      const projectId = nodesRef.current[nodeId]?.projectId;
      if (!projectId) return;
      setProjects((prev) => prev.map((project) => {
        if (project.id !== projectId) return project;
        const existing = (project.artifacts ?? []).find((context) => artifactNameKey(context.name) === artifactNameKey(name));
        return reduceProject(project, {
          type: 'upsert-context',
          projectId,
          context: { id: contextId ?? existing?.id, name, filePath, size, type: artifactTypeForPath(filePath), kind: 'embedded', source: 'agent' },
        });
      }));
    },
    onArtifactUpdated: (name, filePath, size, contextId) => {
      const projectId = nodesRef.current[nodeId]?.projectId;
      if (!projectId) return;
      setProjects((prev) => prev.map((project) => project.id === projectId
        ? reduceProject(project, {
            type: 'update-context-by-name',
            projectId,
            context: { id: contextId, name, filePath, size, type: artifactTypeForPath(filePath), kind: 'embedded', source: 'agent' },
          })
        : project));
    },
    // The backend already removed the row; dropping it here keeps this
    // window's persistence from writing it back. A replay of an artifact
    // already gone changes nothing.
    onArtifactDeleted: (name, contextId) => {
      const projectId = nodesRef.current[nodeId]?.projectId;
      if (!projectId) return;
      setProjects((prev) => prev.map((project) => {
        if (project.id !== projectId) return project;
        const id = deletedArtifactId(project.artifacts, { name, contextId });
        return id ? reduceProject(project, { type: 'delete-context', projectId, contextId: id }) : project;
      }));
    },
    onSpawnBranches: (topics) => {
      if (topics.length === 0) return;
      const parent = nodesRef.current[nodeId];
      if (!parent) return;
      const projectId = parent.projectId;
      const owningProject = projectsRef.current.find((project) => project.id === projectId);
      const treeId = owningProject ? findTreeIdForNode(nodeId, owningProject) : null;
      const spawned = topics.map((topic) => ({
        nodeId: topic.nodeId ?? topic.chatId,
        chatId: topic.chatId,
        title: topic.title,
        runtimeId: parent.runtimeId,
      }));
      const lastAssistantId = [...parent.messages]
        .reverse()
        .find((message) => message.role === 'assistant')?.id;
      const spawnCreatedAt = Date.now();
      dispatch({ type: 'agent-spawn', parentNodeId: nodeId, projectId, nodes: spawned });
      setProjects((prev) => prev.map((project) => project.id === projectId
        ? {
            ...project,
            chatIds: [...project.chatIds, ...spawned.map((child) => child.nodeId)
              .filter((nodeId) => !project.chatIds.includes(nodeId))],
            edges: [
              ...project.edges,
              ...spawned
                .filter((child) => !project.edges.some((edge) =>
                  edge.source === nodeId && edge.target === child.nodeId && isBranchEdge(edge)))
                .map((child) => makeBranchEdge({
                source: nodeId,
                target: child.nodeId,
                kind: 'branch',
                anchorMessageId: lastAssistantId,
                createdAt: spawnCreatedAt,
              })),
            ],
          }
        : project));
      if (treeId) {
        for (const child of spawned) appendPaneInTree(projectId, treeId, child.nodeId);
      }
      // The backend started each child's first turn before this frame, so its
      // turn_start may have come while this window did not have the child yet.
      // An empty child is read as the backend has it; a running turn is read when it ends.
      for (const child of spawned) {
        if ((nodesRef.current[child.nodeId]?.messages.length ?? 0) > 0) continue;
        void installBackendNodeRef.current(projectId, child.nodeId, true).catch(() => {});
      }
    },
    onPermissionResolved: (data) => {
      dispatch({ type: 'permission-resolved', nodeId, requestId: data.requestId });
      dismissAnsweredAttention(nodeId);
    },
    onPermissionRequest: (data) => {
      dispatch({ type: 'permission-request', nodeId, permission: data });
      // The agent's conversation V notifies like any other, under its name (DESIGN-v2 §1.5).
      presentNodeAttention(nodeId, {
        kind: 'needs_input',
        ...approvalAttentionCopy(data.title),
        ...(isAssistantConversation(projectsRef.current, nodeId) ? { title: companionNoticeTitle('approval') } : {}),
        isStillCurrent: () => nodesRef.current[nodeId]?.pendingPermission?.requestId === data.requestId,
      });
    },
    onUserInputRequest: (data) => {
      dispatch({
        type: 'user-input-request',
        nodeId,
        assistantId: data.assistantId,
        userInput: { requestId: data.requestId, interactionId: data.interactionId, questions: data.questions, answers: [] },
      });
      // The ask card renders inline in one pane's transcript, invisible when
      // that pane is closed or in another thread; the policy speaks unless
      // the node is in front of the user (the panel showing V counts, see
      // targetVisibility.ts) — as a tone and OS notification: in the window,
      // the AskUserNotice already shows the question, so no toast repeats it.
      // V's ask carries the agent's name (DESIGN-v2 §1.5).
      presentNodeAttention(nodeId, {
        kind: 'needs_input',
        ...questionAttentionCopy(data.questions[0]?.question),
        ...(isAssistantConversation(projectsRef.current, nodeId) ? { title: companionNoticeTitle('question') } : {}),
        isStillCurrent: () => {
          const pending = nodesRef.current[nodeId]?.pendingUserInput;
          return !!nodesRef.current[nodeId]
            && !(pending?.requestId === data.requestId && (pending.resolved || pending.interrupted));
        },
        showToast: () => !isAwaitingUserInput(nodesRef.current[nodeId]),
      });
    },
    onUserInputResolved: (data) => {
      dispatch({ type: 'user-input-resolved', nodeId, requestId: data.requestId, interactionId: data.interactionId, answers: data.answers, outcome: data.outcome });
      dismissAnsweredAttention(nodeId);
    },
  }), [dismissAnsweredAttention, dispatch, openPaneInTree, presentNodeAttention, setProjects]);
  sharedStreamHandlersRef.current = createSharedStreamHandlers;

  const handleTurnEnd = useCallback((reason: TurnEndReason, endedNodeId: string) => {
    const ended = nodesRef.current[endedNodeId];
    // The visible answer can finish before its hidden runtime tail. If a new
    // foreground turn has already started, that older terminal callback must
    // not consume the new turn's queue or invalidate its session binding.
    if (!ended || ended.status === 'streaming') return;
    if (reason === 'error') {
      boundSessionsRef.current.delete(endedNodeId);
    }
    // A turn in the agent's conversation ended: what it changed (a runtime switch, layout rules,
    // the Pages upkeep's state) is read again, whether or not the panel shows it (F1a-review #7).
    if (isCompanionNodeId(endedNodeId)) {
      noteCompanionTurnEnded(endedNodeId);
      void refreshMetaAgent();
    }
    const queueRuntimeId = ended.runtimeId ?? agentStatusRef.current?.runtime;
    const queue = nextQueuedBatch((ended.pendingQueued ?? []).filter((entry) => !entry.steering),
      sendSlashEntries(ended, projectsRef.current.find((project) => project.id === ended.projectId), queueRuntimeId));
    if (queue.length === 0) return;
    if (reason === 'error') {
      dispatch({ type: 'mark-queue-errored', nodeId: endedNodeId });
      return;
    }
    // A queue an error paused waits for the user ("paused, review and send
    // manually"), whatever turn ends next.
    if (ended.queueErrored) return;

    const payload = buildFlushPayload(queue);
    if (!payload) return;
    const commentBlocks = queue
      .map((entry) => entry.commentBlock)
      .filter((block): block is string => !!block);
    const combinedComments = commentBlocks.length > 0 ? commentBlocks.join('\n\n') : null;
    const legacyComments = queue.filter(entry => !entry.comments?.length).map(entry => entry.commentBlock).filter(Boolean).join('\n\n') || null;
    // Every queued quote goes along, each framed by where it came from.
    const quotes = queue.flatMap((entry) => (entry.quotedText?.trim()
      ? [{ text: entry.quotedText, source: entry.quoteSource }]
      : []));
    const combinedQuote = quotes.length > 0 ? quotes.map((quote) => quote.text).join('\n\n') : null;
    const expandedValue = expandMentions(payload.value, payload.mentions);
    const expandedText = appendAttachmentsSentinel(
      joinMessageQuotes(combinedComments, quotes, expandedValue),
      payload.attachments,
    );
    const restoredBlocks = [combinedComments, ...(quotes.length > 1 ? quotes.map(quote => formatQuotedSelectionContext(quote.text, quote.source)) : [])].filter(Boolean);
    const restoredQuotePrefix = restoredBlocks.length ? restoredBlocks.join('\n\n') + '\n\n' : '';
    const meta: UserSendMeta = {
      rejectedDraft: {
        ...prependToDraft(restoredQuotePrefix, { value: payload.value, mentions: payload.mentions }),
        ...(quotes.length === 1 ? { quotedText: quotes[0].text, quoteSource: quotes[0].source } : {}),
      },
      // A single quote has one structured source. Multiple independently
      // sourced quotes are saved with their framing in the message body so
      // reload/retry cannot mislabel the aggregate as an assistant selection.
      quotedText: quotes.length === 1 ? combinedQuote ?? undefined : undefined,
      comments: queue.flatMap(entry => entry.comments ?? []),
      ...(quotes.length === 1 && quotes[0].source ? { quoteSource: quotes[0].source } : {}),
      attachments: payload.attachments.length > 0
        ? payload.attachments.map((attachment) => ({ ...attachment }))
        : undefined,
      displayText: quotes.length > 1
        ? joinMessageQuotes(legacyComments, quotes, expandedValue)
        : joinMessageParts(legacyComments, null, expandedValue),
      // A queued send left the composer when it was queued; what the user
      // has typed since stays.
      keepDraft: true,
      // A picked command or skill drains alone (nextQueuedBatch).
      ...(queue.length === 1 && queue[0].slash ? { slash: queue[0].slash } : {}),
      // Each queued send's context was read when the user sent it; combined sends carry all their refs.
      metaAgentContext: mergeMetaAgentTurnContexts(queue.map((entry) => entry.metaAgentContext)),
    };
    // The batch leaves the queue only when it is sent. A turn that started
    // in between (a background turn) keeps it queued for its own end, and a
    // second turn-end callback finds it gone.
    setTimeout(() => {
      const node = nodesRef.current[endedNodeId];
      const queued = new Set((node?.pendingQueued ?? []).map((entry) => entry.id));
      if (!node || node.status === 'streaming' || !queue.every((entry) => queued.has(entry.id))) return;
      for (const entry of queue) dispatch({ type: 'dequeue-message', nodeId: endedNodeId, messageId: entry.id });
      sendMessageRef.current(endedNodeId, expandedText, meta);
    }, 0);
  }, [dispatch]);
  turnEndHandlerRef.current = handleTurnEnd;

  /** Stream a message. Lazily creates the backend chat session on first use. */
  const startStream = useCallback(
    async (
      nodeId: string,
      text: string,
      opts?: { contextFromNodeId?: string },
      meta?: UserSendMeta,
    ) => {
      const tSubmit = perf.now();
      perf.mark('client:user_submit', { nodeId, textLen: text.length });
      startupMarkOnce('first_message_send', { nodeId, textLen: text.length });
      let n = nodesRef.current[nodeId];
      if (!n) return;
      // The agent's conversation: what this message carries is read now, as the user sends it, and
      // goes with it however long the waits below and ensureSession take (F1a-review #1). Undefined
      // for other chats.
      const metaAgentContext = meta?.metaAgentContext !== undefined ? meta.metaAgentContext : captureMetaAgentTurnContext(nodeId);
      const rejectSend = () => {
        dispatch({ type: 'set-composer-draft', nodeId,
          draft: meta?.rejectedDraft ?? { value: text, mentions: [] }, preserveExisting: true });
        meta?.onRejected?.();
      };
      if (commandsInFlightRef.current.has(nodeId) || preparingSends.current.has(nodeId)) {
        rejectSend();
        return;
      }
      // Shown from the local cache: the send waits (bounded) for the remote's
      // own data, so it lands on the conversation as the remote has it.
      const sendConnection = backendConnectionIdForWorkspace(n.projectId);
      if (backendConnectionProvisional(sendConnection)) {
        preparingSends.current.add(nodeId);
        try { await whenBackendConnectionConfirmed(sendConnection); }
        finally { preparingSends.current.delete(nodeId); }
        n = nodesRef.current[nodeId];
        if (!n) return;
        if (n.status === 'streaming') {
          rejectSend();
          return;
        }
      }
      const contextProject = projectsRef.current.find(project => project.id === n.projectId);
      const contextNodes = new Set([nodeId, ...linkedPeersOf(nodeId, contextProject?.edges ?? []),
        ...resolveAtNodeMentions(text, nodesRef.current, { workspaceId: n.projectId,
          backendConnectionId: backendConnectionIdForWorkspace(n.projectId) }).map(node => node.nodeId)]);
      for (const source of n.mergeSources ?? []) {
        contextNodes.add(source);
        for (const id of descendants(source, contextProject?.edges ?? [])) contextNodes.add(id);
      }
      if ([...contextNodes].some(id => nodesRef.current[id]?.messagesLoaded === false)) {
        preparingSends.current.add(nodeId);
        try { await ensureCompleteHistory([...contextNodes]); }
        catch (error) {
          rejectSend();
          toast.error((error as Error).message);
          return;
        } finally { preparingSends.current.delete(nodeId); }
        n = nodesRef.current[nodeId];
        if (!n) return;
        if (n.status === 'streaming') {
          rejectSend();
          return;
        }
      }
      const sendRuntimeId = meta?.runtimeId ?? n.runtimeId ?? agentStatusRef.current?.runtime;
      const slashRuntimeId = meta?.slashRuntimeId ?? sendRuntimeId;
      // `/name args` runs the / entry picked for it, or the name's first: a
      // skill as a turn whose text is the arguments (the bubble keeps what was
      // typed), a command on the command path. Any other `/word` is a message.
      // A repeated message runs the skill it ran, which a cold or changed
      // catalog would not find by name.
      const slashText = meta?.displayText ?? text;
      const picked = pickedSlashEntry(meta?.slash, slashRuntimeId);
      const resolveSlash = (node: ChatNodeState) => recordedSlashSkill(meta?.skill, slashText) ?? resolveSlashRun(slashText,
        sendSlashEntries(node, projectsRef.current.find((project) => project.id === node.projectId), slashRuntimeId), picked);
      let slashRun = resolveSlash(n);
      // A typed `/name` first waits briefly for what its runtime's catalog
      // still lacks. Before any answer a chat knows only its live session's
      // commands and skills: a name they run as a runtime skill may be a
      // library skill's, which wins. A name nothing runs yet may be a command
      // of a chat without a session, or a skill the runtime is still listing
      // where the chat runs skills at all.
      const typedName = parseSlashInvocation(slashText.trim())?.name;
      const typed = !!typedName && !meta?.skill && picked?.name !== typedName;
      const catalogNeed = !typed ? null
        : !slashRun ? (isSystemWorkspace(contextProject) ? 'answer' as const : 'skills' as const)
          : slashRun.kind === 'skill' && slashRun.skill.origin === 'runtime' ? 'answer' as const : null;
      const catalogWait = catalogNeed && slashRuntimeId
        ? settleSkillCatalog(n.projectId, slashRuntimeId, SLASH_CATALOG_WAIT_MS, catalogNeed) : null;
      if (catalogWait) {
        preparingSends.current.add(nodeId);
        try { await catalogWait; } finally { preparingSends.current.delete(nodeId); }
        n = nodesRef.current[nodeId];
        if (!n) return;
        if (n.status === 'streaming') {
          rejectSend();
          return;
        }
        slashRun = resolveSlash(n);
      }
      const skillSend = slashRun?.kind === 'skill' ? slashRun : null;
      // A command is the whole message: with a quote, comments or files it is prose.
      const command = slashRun?.kind === 'command' && text.trim() === slashText.trim() ? slashRun : null;
      const wireText = skillSend ? skillWireText(skillSend.args, meta) : text;
      const priorMessagesForResume = n.chatId && boundSessionsRef.current.has(nodeId)
        ? undefined
        : n.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            role: m.role,
            text: visibleMessageText(m),
          }));

      // Gather linked peers whose context hasn't been injected yet, so we
      // can bridge them into this node's session.
      const owningProject = projectsRef.current.find((p) => p.id === n.projectId);
      const consumed = new Set(n.consumedLinks ?? []);
      const peerIds = linkedPeersOf(nodeId, owningProject?.edges ?? []).filter(
        (pid) => !consumed.has(pid),
      );
      const peerBlocks = peerIds
        .map((pid) => buildMergeContextBlock(nodesRef.current[pid]))
        .filter((b): b is string => !!b);

      const parentNode = n.parentNodeId ? nodesRef.current[n.parentNodeId] : undefined;
      // Digest parents have no chatId — create a fresh/compatible session and
      // inject the digest content as a preamble block instead. When the caller
      // re-anchored the branch edge (a branch of a digest hangs under the
      // originating tree's root), it passes the digest's nodeId via
      // opts.contextFromNodeId, or a blank branch keeps it until its first
      // session, so we can still build the preamble.
      const parentChatId = parentNode && parentNode.kind !== 'digest'
        ? parentNode.chatId ?? undefined
        : undefined;
      const cwd = owningProject?.cwd;
      const mergeContextsFromMerge = buildSubtreeContextBlocks(
        n.mergeSources ?? [],
        nodesRef.current,
        owningProject?.edges ?? [],
        (id) => !nodesRef.current[id]?.deletedAt,
      );
      if (n.chatId) branchContextFromRef.current.delete(nodeId);
      const contextFromNodeId = opts?.contextFromNodeId ?? branchContextFromRef.current.get(nodeId);
      const digestSourceNode = contextFromNodeId
        ? nodesRef.current[contextFromNodeId]
        : parentNode;
      const digestParentBlock = buildDigestContextBlock(digestSourceNode);
      // Both merge sources and fresh link peers feed the same preamble slot;
      // a digest parent contributes its summary content the same way.
      const mergeContexts = [
        ...(digestParentBlock ? [digestParentBlock] : []),
        ...mergeContextsFromMerge,
        ...peerBlocks,
      ];

      // Resolve reusable artifacts to inject. `extraContexts` is what actually
      // gets injected this turn — ONLY explicit @mentions (auto-inject was
      // removed). `contextManifest` names only the PINNED artifacts, with
      // `artifactCount` for the rest, which the agent finds with
      // list_artifacts / search_artifacts; a backend without those tools gets
      // the list itself, at most 50 (artifactManifestForBackend) — links
      // carry a url and no filePath, so pass both and let the backend pick
      // per type.
      const mentionCtxs = resolveAtMentions(text, owningProject?.artifacts ?? []);

      const extraContexts = mentionCtxs.length > 0
        ? mentionCtxs.map(c => ({ name: c.name, filePath: c.filePath, url: c.url, size: c.size, kind: c.kind }))
        : undefined;

      // Asked now so the capability probe, when one is needed, runs alongside
      // the rest of the send. When none is (no artifacts, a fresh answer),
      // ensure-session starts in this tick, without waiting a microtask.
      const knownManifest = knownArtifactManifest(sendConnection, owningProject?.artifacts);
      const artifactManifest = knownManifest ?? artifactManifestForBackend(sendConnection, owningProject?.artifacts);

      const ensureRuntimeSession = async (signal?: AbortSignal) => {
        if (!owningProject) throw new Error('workspace not found for node');
        const { contextManifest, artifactCount } = knownManifest ?? await artifactManifest;
        return ensureSession({
          nodeId,
          chatId: n.chatId,
          cwd,
          workspaceId: owningProject?.id,
          parentChatId,
          mergeContexts: mergeContexts.length > 0 ? mergeContexts : undefined,
          extraContexts,
          enableFollowUps: prefsRef.current.enableFollowUps,
          contextManifest,
          artifactCount,
          priorMessages: priorMessagesForResume,
          runtimeId: meta?.runtimeId ?? n.runtimeId,
          providerId: meta?.providerId ?? n.providerId,
          modelId: meta?.modelId ?? n.modelId,
          reasoning: meta?.reasoning !== undefined ? meta.reasoning : n.reasoning,
          // Desired agent for a brand-new thread (Home composer pre-selection).
          // Applied server-side after the fresh session is created, before this
          // first prompt streams. Ignored on resume (node already has a chatId).
          permissionMode: meta?.permissionMode ?? n.permissionMode,
          approveForMe: meta?.permissionMode ? meta.approveForMe === true : n.permissionApproveForMe === true,
          crewMemoryMode: meta?.crewMemoryMode,
          // A temporary chat's first session is created as one; a retry
          // after a failed first send asks again (the node keeps its mark).
          temporary: !n.chatId && (meta?.temporary === true || n.temporary === true) ? true : undefined,
          modeId: n.chatId ? undefined : n.currentModeId ?? undefined,
          graphPrerequisite: durableNodePrerequisite(owningProject, nodesRef.current, nodesRef.current[nodeId] ?? n),
          signal,
        });
      };

      if (command) {
        commandsInFlightRef.current.add(nodeId);
        dispatch({ type: 'command-result', nodeId, result: { command: command.name, status: 'running', message: 'Running…' } });
        void (async () => {
          // A command may be the first action after startup, or the first
          // action in an anchored blank branch. Resolve the same durable
          // session as a prompt before the runtime runs it.
          const ensured = await ensureRuntimeSession();
          dispatch({ type: 'bind-chat', nodeId, currentModeId: ensured.currentModeId,
            runtimeId: ensured.runtimeId, providerId: ensured.providerId,
            modelId: ensured.modelId, reasoning: ensured.reasoning });
          if (ensured.sessionState) dispatch({ type: 'session-state', nodeId, state: ensured.sessionState });
          boundSessionsRef.current.add(nodeId);
          if (ensured.lastUsedUpdated) refreshAgentStatus();
          return executeComposerCommand(nodeId, command);
        })().then((result) => {
          if (result.sessionState) dispatch({ type: 'session-state', nodeId, state: result.sessionState });
          dispatch({ type: 'command-result', nodeId, result: { command: command.name,
            status: result.success ? 'completed' : 'error', message: result.message } });
          commandsInFlightRef.current.delete(nodeId);
          turnEndHandlerRef.current(result.success ? 'done' : 'error', nodeId);
        }).catch((error) => {
          dispatch({ type: 'command-result', nodeId, result: { command: command.name, status: 'error',
            message: String(error instanceof Error ? error.message : error) } });
          commandsInFlightRef.current.delete(nodeId);
          turnEndHandlerRef.current('error', nodeId);
        });
        return;
      }
      // A prompt moves the conversation on; a finished command's result goes.
      if (n.commandResult && n.commandResult.status !== 'running') {
        dispatch({ type: 'command-result', nodeId, result: null });
      }
      // Create assistant message synchronously first so status flips to 'streaming'
      // immediately, blocking concurrent submits on the same node.
      const assistantId = `a-${nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // Rewrite @node:xxx tokens to @<title> for display so the chip the user
      // typed survives in the transcript. Raw tokens are resolved later and
      // injected as context into the outgoing prompt.
      const baseDisplay = meta?.displayText ?? text;
      const displayText = rewriteNodeMentionsForDisplay(baseDisplay, nodesRef.current);
      // The arguments as the wire text carries them, where the runtime finds
      // them (SkillInvocationRequest.args): chat mentions leave the text and
      // come along as context instead.
      const skillArgs = skillSend ? stripNodeMentionTokens(skillSend.args).trim() : '';
      dispatch({
        type: 'user-send',
        nodeId,
        userText: displayText,
        assistantId,
        quotedText: meta?.quotedText,
        attachments: meta?.attachments,
        comments: meta?.comments,
        mentions: meta?.mentions,
        ...(meta?.keepDraft ? { keepDraft: true } : {}),
        ...(meta?.quoteSource ? { quoteSource: meta.quoteSource } : {}),
        ...(skillSend ? { skill: {
          id: skillSend.skill.id, name: skillSend.skill.name, origin: skillSend.skill.origin,
          ...(skillSend.skill.runtimeId ? { runtimeId: skillSend.skill.runtimeId } : {}), args: skillArgs,
        } } : {}),
        ...(metaAgentContext !== undefined ? { metaAgentContext } : {}),
      });
      assistantTextBufs.current[assistantId] = '';

      let chatId = n.chatId;
      let outgoingText = wireText;
      const tEnsureStart = perf.now();
      // The empty assistant's loading dots cover session setup as well.
      const setupController = new AbortController();
      let setupCancelled = false;
      const cancelSetup = () => {
        if (setupCancelled) return;
        setupCancelled = true;
        setupController.abort();
        delete assistantTextBufs.current[assistantId];
        if (cancelFns.current[nodeId] === cancelSetup) delete cancelFns.current[nodeId];
        dispatch({ type: 'done', nodeId, assistantId, aborted: true });
        handleTurnEnd('cancel', nodeId);
      };
      cancelFns.current[nodeId] = cancelSetup;
      try {
        if (!owningProject) throw new Error('workspace not found for node');
        if (meta?.permissionMode && !n.permissionMode) dispatch({ type: 'set-permission-mode', nodeId, mode: meta.permissionMode, approveForMe: meta.approveForMe });
        const ensured = await ensureRuntimeSession(setupController.signal);
        // Aborting the HTTP wait does not undo the server's native binding.
        // A late response must never send the cancelled prompt or bind over a newer turn.
        if (setupCancelled) return;
        perf.measure('client:ensure_session', tEnsureStart, { nodeId, strategy: ensured.resumeStrategy });
        perf.measure('client:submit_to_ensured', tSubmit, { nodeId });
        // New backends return chatId === nodeId. Ignore a legacy runtime id in
        // the compatibility field; all subsequent frontend operations address
        // the canonical nodeId.
        chatId = nodeId;
        dispatch({
          type: 'bind-chat',
          nodeId,
          currentModeId: ensured.currentModeId,
          runtimeId: ensured.runtimeId,
          providerId: ensured.providerId,
          modelId: ensured.modelId,
          reasoning: ensured.reasoning,
        });
        if (ensured.sessionState) dispatch({ type: 'session-state', nodeId, state: ensured.sessionState });
        boundSessionsRef.current.add(nodeId);
        // This send changed the runtime's remembered model. Reload status so
        // other panes switching to that runtime land on it instead of a
        // stale value from the last status load.
        if (ensured.lastUsedUpdated) refreshAgentStatus();

        if ((ensured.resumeStrategy === 'live' || ensured.resumeStrategy === 'exact') && peerBlocks.length > 0) {
          // Existing hidden context stays intact, so newly linked peer context
          // needs to ride on this user turn instead of first-message preamble.
          outgoingText =
            `The user linked a peer thread. Use the following as additional context:\n\n` +
            peerBlocks.join('\n\n') +
            `\n\n---\n\n${wireText}`;
        }
      } catch (err) {
        if (setupCancelled) {
          delete assistantTextBufs.current[assistantId];
          return;
        }
        const branchCode = (err as { code?: string }).code;
        const branchMessage = branchCode === 'BRANCH_ANCHOR_UNAVAILABLE'
          ? 'The message this branch was cut from no longer exists. Choose a different message to branch from.'
          : branchCode === 'BRANCH_PARENT_UNAVAILABLE'
            ? 'The parent conversation is no longer available, so this branch cannot be created.'
            : undefined;
        dispatch({
          type: 'error',
          nodeId,
          assistantId,
          message: branchMessage ?? ((err as Error).name === 'TimeoutError'
            ? 'Session connection timed out. The original session binding is retained; please retry.'
            : (err as Error).message || 'failed to ensure chat session'),
        });
        delete assistantTextBufs.current[assistantId];
        return;
      } finally {
        if (cancelFns.current[nodeId] === cancelSetup) delete cancelFns.current[nodeId];
      }

      // Mark these peers consumed so we don't re-inject on the next turn.
      if (peerIds.length > 0) {
        dispatch({ type: 'consume-links', nodeId, peerIds });
      }

      if (!chatId) {
        dispatch({ type: 'error', nodeId, assistantId, message: 'failed to bind chat session' });
        delete assistantTextBufs.current[assistantId];
        return;
      }

      // Resolve @node:xxx mentions — inject referenced node transcripts.
      const nodeMentionScope = { workspaceId: n.projectId, backendConnectionId: backendConnectionIdForWorkspace(n.projectId) };
      const mentionedNodes = resolveAtNodeMentions(outgoingText, nodesRef.current, nodeMentionScope);
      const cleanNodeMentionText = stripNodeMentionTokens(outgoingText);
      if (mentionedNodes.length > 0) {
        const nodeBlocks = mentionedNodes.map(mn => buildNodeTranscriptBlock(mn, nodeMentionScope));
        const cleanText = cleanNodeMentionText;
        outgoingText =
          `The user referenced the following chat nodes. Short conversations are ` +
          `included in full; for longer ones, use read_node or read_node_overview ` +
          `to retrieve full content when needed:\n\n` +
          nodeBlocks.join('\n\n') +
          `\n\n---\n\n${cleanText}`;
      } else {
        outgoingText = cleanNodeMentionText;
      }

      const cancel = runChatStream({
        prompt: outgoingText,
        nodeId,
        assistantId,
        workspaceId: n.projectId,
        dispatch,
        assistantTextBufs,
        cancelFns,
        displayText,
        rejectedDraft: meta?.rejectedDraft ?? { value: meta?.displayText ?? text, mentions: [] },
        onRejected: meta?.onRejected,
        enableKiroSidecarTitle: prefsRef.current.enableKiroSidecarTitles,
        userMetadata: {
          quotedText: meta?.quotedText,
          quoteSource: meta?.quoteSource,
          attachments: meta?.attachments,
          comments: meta?.comments as Array<Record<string, unknown>> | undefined,
          ...(metaAgentContext?.refs?.length ? { companionRefs: metaAgentContext.refs } : {}),
        },
        ...(skillSend ? { skill: { id: skillSend.skill.id, name: skillSend.skill.name, args: skillArgs } } : {}),
        ...(skillSend && slashRuntimeId ? {
          onSkillRejected: () => invalidateSkillCatalog(n.projectId, slashRuntimeId, skillSend.skill.id),
        } : {}),
        metaAgentContext,
        onTurnEnd: handleTurnEnd,
        extraHandlers: createSharedStreamHandlers(nodeId),
        onStreamComplete: () => streamCompleteHandlerRef.current(nodeId),
      });
      cancelFns.current[nodeId] = cancel;
    },
    [createSharedStreamHandlers, dispatch, handleTurnEnd, refreshAgentStatus, ensureCompleteHistory],
  );

  const {
    createProject,
    enterChatsWorkspace,
    renameProject: renameProjectRaw,
    setProjectCwd,
    addFolder,
    removeFolder,
    updateFolderLabel,
    setProjectInstructions,
    deleteProject: deleteProjectRaw,
    restoreProject: restoreProjectRaw,
    purgeProject,
    archiveProject: archiveProjectRaw,
    unarchiveProject: unarchiveProjectRaw,
    selectProject,
  } = useProjectActions({
    projects,
    activeProjectId,
    chatsWorkspaceId: CHATS_WORKSPACE_ID,
    nodesRef,
    setProjects,
    setActiveProjectId,
    setNodes,
  });

  const createChildChat = useCallback(
    async (
      parentNodeId: string,
      firstMessage: string,
      meta?: UserSendMeta,
      opts?: CreateChildChatOptions,
    ) => {
      const parent = nodesRef.current[parentNodeId];
      if (!parent) throw new Error('unknown parent node');
      const projectId = parent.projectId;
      const branch = resolveBranchParent(parentNodeId, projectsRef.current.find((p) => p.id === projectId), nodesRef.current);
      if (!branch) throw new Error('No chat to branch from');
      const { branchParentNodeId, contextFromNodeId } = branch;
      const nodeId = newNodeId(projectId);
      if (opts?.primaryAgent) {
        bindPendingPrimaryAgent(nodeId, { workspaceId: projectId, ...opts.primaryAgent });
      }
      dispatch({
        type: 'create', nodeId, projectId, parentNodeId: branchParentNodeId,
        modeId: opts?.primaryAgent ? undefined : opts?.modeId,
      });
      const createdAt = Date.now();
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? {
                ...p,
                chatIds: [...p.chatIds, nodeId],
                edges: [
                  ...p.edges,
                  makeBranchEdge({
                    source: branchParentNodeId,
                    target: nodeId,
                    anchorMessageId: opts?.anchorMessageId,
                    createdAt,
                  }),
                ],
              }
            : p,
        ),
      );
      // Always open the pane so it's visible in the dashboard strip. Only move
      // focus there when the caller didn't opt out (opts.focus === false).
      // Chat-pane branch gestures pass focus:false so branching a tangent
      // doesn't yank the user off the pane they're reading.
      setOpenPanes((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
      if (opts?.focus !== false) {
        setFocusedPane(nodeId);
        viewPane(nodeId);
      }
      // A branch runs on its parent's runtime and model unless the caller
      // names a runtime or an agent definition brings its own; the backend
      // would otherwise start it on the global default.
      const childMeta = meta?.runtimeId || opts?.primaryAgent || !parent.runtimeId ? meta : {
        ...meta, runtimeId: parent.runtimeId, providerId: parent.providerId ?? undefined, modelId: parent.modelId ?? undefined, reasoning: parent.reasoning,
      };
      void startStream(nodeId, firstMessage, { contextFromNodeId }, childMeta);
      return nodeId;
    },
    [dispatch, newNodeId, setFocusedPane, setOpenPanes, startStream, viewPane],
  );

  const createBlankChild = useCallback(
    async (parentNodeId: string, opts?: { anchorMessageId?: string }) => {
      const parent = nodesRef.current[parentNodeId];
      if (!parent) throw new Error('unknown parent node');
      const projectId = parent.projectId;
      const branch = resolveBranchParent(parentNodeId, projectsRef.current.find((p) => p.id === projectId), nodesRef.current);
      if (!branch) throw new Error('No chat to branch from');
      const { branchParentNodeId, contextFromNodeId } = branch;
      const nodeId = newNodeId(projectId);
      if (contextFromNodeId) branchContextFromRef.current.set(nodeId, contextFromNodeId);
      dispatch({ type: 'create', nodeId, projectId, parentNodeId: branchParentNodeId });
      const createdAt = Date.now();
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? {
                ...p,
                chatIds: [...p.chatIds, nodeId],
                edges: [
                  ...p.edges,
                  makeBranchEdge({
                    source: branchParentNodeId,
                    target: nodeId,
                    anchorMessageId: opts?.anchorMessageId,
                    createdAt,
                  }),
                ],
              }
            : p,
        ),
      );
      setOpenPanes((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
      setFocusedPane(nodeId);
      viewPane(nodeId);
      return nodeId;
    },
    [dispatch, newNodeId, setFocusedPane, setOpenPanes, viewPane],
  );

  const sameTree = useCallback(
    (a: string, b: string) => {
      const project = projects.find((p) => p.chatIds.includes(a) && p.chatIds.includes(b));
      if (!project) return false;
      return findTreeIdForNode(a, project) === findTreeIdForNode(b, project);
    },
    [projects],
  );

  const createMergedChat = useCallback(
    async (sourceNodeIds: string[]) => {
      if (sourceNodeIds.length < 2) {
        toast.error('Select at least two threads to merge.');
        throw new Error('createMergedChat requires at least 2 source nodes');
      }
      const dedup = new Set(sourceNodeIds);
      if (dedup.size !== sourceNodeIds.length) {
        toast.error('Cannot merge a thread with itself.');
        throw new Error('createMergedChat: duplicate source ids (self-merge?)');
      }
      // All sources must belong to the same workspace.
      const projectId = projects.find((p) => p.chatIds.includes(sourceNodeIds[0]))?.id;
      if (!projectId) {
        toast.error('Could not find the workspace for the selected threads.');
        throw new Error('unknown source workspace');
      }
      for (const sid of sourceNodeIds) {
        const p = projects.find((proj) => proj.chatIds.includes(sid));
        if (!p || p.id !== projectId) {
          toast.error('Cannot merge threads across workspaces.');
          throw new Error('cross-workspace merge');
        }
      }
      const nodeId = newNodeId(projectId);
      const treeId = backendEntityId(backendConnectionIdForWorkspace(projectId), `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
      const now = Date.now();
      dispatch({
        type: 'create',
        nodeId,
        projectId,
        // No branch parent — merge nodes anchor a new tree of their own.
        mergeSources: sourceNodeIds,
      });
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          // Add merge edges first, then create the merge tree (sets activeTreeId
          // to this tree, which paneKey will pick up on the next render).
          const withEdges = {
            ...p,
            edges: [
              ...p.edges,
              ...sourceNodeIds.map((src) => ({ source: src, target: nodeId, kind: 'merge' as const })),
            ],
          };
          return reduceProject(withEdges, {
            type: 'create-tree',
            treeId,
            rootNodeId: nodeId,
            now,
            kind: 'merge',
          });
        }),
      );
      // Seed the new tree's pane slot so the merge view is visible immediately,
      // mirroring createThread (paneKey still reflects the old activeTreeId).
      setPaneSlot(projectId, treeId, [nodeId], nodeId);
      setFocusedNodeIdState(nodeId);
      return nodeId;
    },
    [dispatch, newNodeId, projects, setPaneSlot, setProjects],
  );

  const sendMessage = useCallback(
    (
      nodeId: string,
      text: string,
      meta?: UserSendMeta,
    ) => {
      // Defensive guard: when a node is already streaming, submit() in the UI
      // layer should have routed this to createChildChat (auto-branch). If we
      // ever land here on a streaming node, do nothing — auto-branching inside
      // startStream would risk recursion with createChildChat.
      const node = nodesRef.current[nodeId];
      if (node?.status === 'streaming') {
        console.warn(
          'sendMessage called on streaming node — expected createChildChat (auto-branch)',
        );
        return;
      }
      void startStream(nodeId, text, undefined, meta);
    },
    [startStream],
  );
  sendMessageRef.current = sendMessage;

  const turnInspections = useRef(new Map<string, () => void>());
  useEffect(() => () => {
    for (const detach of turnInspections.current.values()) detach();
    turnInspections.current.clear();
  }, []);

  // Reruns need the whole transcript of a partly loaded thread. The message a
  // rerun starts from is found again by id once older pages are in front of
  // it. Null when there is nothing left to rerun.
  const completeNodeHistory = useCallback(
    async (nodeId: string, fromIndex?: number): Promise<{ node: ChatNodeState; fromIndex?: number } | null> => {
      const anchor = fromIndex === undefined ? undefined : nodesRef.current[nodeId]?.messages[fromIndex]?.id;
      try { await ensureCompleteHistory([nodeId]); }
      catch (error) { toast.error((error as Error).message); return null; }
      const node = nodesRef.current[nodeId];
      if (!node || node.status === 'streaming') return null;
      if (fromIndex === undefined) return { node };
      const found = node.messages.findIndex(message => message.id === anchor);
      return found < 0 ? null : { node, fromIndex: found };
    },
    [ensureCompleteHistory],
  );

  // Drops what a rerun replaces, and the branch anchors on those messages.
  const trimForRerun = useCallback((nodeId: string, node: ChatNodeState, fromIndex: number | undefined) => {
    const survivingIds = computeSurvivingMessageIds(node.messages, fromIndex);
    dispatch({ type: 'retry-trim', nodeId, fromIndex });
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== node.projectId) return p;
        const edges = cleanupOrphanedAnchors(p.edges, nodeId, survivingIds);
        return edges === p.edges ? p : { ...p, edges };
      }),
    );
  }, [dispatch, setProjects]);

  // A restart cut the last turn short. Its request and partial output are
  // already in the transcript, so the agent is asked to carry on from there;
  // the original request is never sent again (a second run would repeat the
  // tool calls the first one completed).
  const resumeLastTurn = useCallback(
    async (nodeId: string, binding?: SendBindingMeta) => {
      let n = nodesRef.current[nodeId];
      if (!n || n.status === 'streaming') return;
      if (n.messagesLoaded === false) {
        const completed = await completeNodeHistory(nodeId);
        if (!completed) return;
        n = completed.node;
      }
      const prompt = buildResumePrompt(n.messages, interruptionCauseOfKind(n.errorKind) ?? 'restart');
      if (!prompt) return;
      turnInspections.current.get(nodeId)?.();
      turnInspections.current.delete(nodeId);
      cancelFns.current[nodeId]?.();
      void startStream(nodeId, prompt.text, undefined, { displayText: prompt.displayText, ...binding });
    },
    [startStream, completeNodeHistory],
  );

  const retryLastTurn = useCallback(
    async (nodeId: string, fromIndex?: number, binding?: SendBindingMeta, explicitRerun = false) => {
      let n = nodesRef.current[nodeId];
      if (!n || n.status === 'streaming') return;
      if (n.messagesLoaded === false) {
        const completed = await completeNodeHistory(nodeId, fromIndex);
        if (!completed) return;
        ({ node: n, fromIndex } = completed);
      }
      const action = turnErrorAction(n.errorKind);
      if (action === 'resume-turn' && !explicitRerun) {
        resumeLastTurn(nodeId, binding);
        return;
      }
      const uncertain = action === 'inspect-existing-turn';

      if (uncertain && !explicitRerun) {
        if (n.errorRecovery === 'checking') return;
        const turnId = n.errorTurnId;
        const assistantId = [...n.messages].reverse().find((m) => m.role === 'assistant')?.id;
        if (!n.chatId || !turnId || !assistantId) {
          dispatch({ type: 'error-recovery', nodeId, state: 'unavailable' });
          return;
        }
        turnInspections.current.get(nodeId)?.();
        dispatch({ type: 'error-recovery', nodeId, state: 'checking' });
        const detach = inspectOriginalTurn({
          chatId: n.chatId,
          turnId,
          onResult: ({ persisted, completedAt, assistant, lastSeq, stopReason }) => {
            turnInspections.current.delete(nodeId);
            const current = nodesRef.current[nodeId];
            // An old read must never finish or overwrite a newer execution.
            if (!current || current.status !== 'error' || current.errorTurnId !== turnId) return;
            dispatch({ type: 'error-recovery', nodeId, state: persisted ? undefined : 'unavailable' });
            if (persisted && assistant && typeof lastSeq === 'number') {
              dispatch({ type: 'recover-original-result', nodeId, turnId, assistantId, assistant, lastSeq, cursor: n.lastAppliedBackgroundTurnId === turnId && n.lastAppliedTurnId !== turnId ? 'background' : 'foreground' });
              // Named, so the completion counts once; a cancelled turn is not one.
              dispatch({ type: 'done', nodeId, assistantId: assistant.id, completedAt, turnId, ...(stopReason === 'cancelled' ? { aborted: true } : {}) });
            }
          },
        });
        turnInspections.current.set(nodeId, detach);
        return;
      }
      turnInspections.current.get(nodeId)?.();
      turnInspections.current.delete(nodeId);
      let sourceMsg: typeof n.messages[number] | undefined;
      if (fromIndex != null) {
        // Find the user message at or just before fromIndex.
        for (let j = fromIndex; j >= 0; j--) {
          if (n.messages[j]?.role === 'user') { sourceMsg = n.messages[j]; break; }
        }
      } else {
        sourceMsg = [...n.messages].reverse().find((m) => m.role === 'user');
      }
      if (!sourceMsg) return;
      cancelFns.current[nodeId]?.();
      if (!(uncertain && explicitRerun)) trimForRerun(nodeId, n, fromIndex);
      // For retries, the stored text is already the wire-flattened payload
      // (quote prefix + attachment sentinel are baked in for old messages).
      // For new messages with structured fields, m.text is bare prose, so we
      // re-flatten via joinMessageParts + appendAttachmentsSentinel so the
      // backend gets the same shape it always has.
      const reText = sourceMsg.text;
      const reQuote = sourceMsg.quotedText;
      const reAttach = sourceMsg.attachments ?? [];
      const reComments = sourceMsg.comments;
      // The quote keeps the framing it was sent with. A message read back
      // after a reload has lost it; in the assistant's conversation its
      // attached context is recognised by how that block opens.
      const reSource = sourceMsg.quoteSource
        ?? (isSystemWorkspace(projectsRef.current.find((p) => p.id === n.projectId)) ? quoteSourceOf(reQuote) : undefined);
      const flattened = appendAttachmentsSentinel(
        joinMessageParts(formatCommentsBlock(reComments ?? []), reQuote ?? null, reText, reSource), reAttach,
      );
      const resent = resendTurnContext(nodeId, sourceMsg);
      // The skill it ran runs again; where it is gone, the backend says so.
      void startStream(nodeId, flattened, undefined, {
        quotedText: reQuote,
        ...(reQuote && reSource ? { quoteSource: reSource } : {}),
        attachments: reAttach.length > 0 ? reAttach.map(a => ({ ...a })) : undefined,
        comments: reComments,
        displayText: reText,
        ...(sourceMsg.skill ? { skill: sourceMsg.skill } : {}),
        // A model/effort picked after the failure applies to the retry,
        // the same way it would to a fresh send.
        ...binding,
        ...(resent !== undefined ? { metaAgentContext: resent } : {}),
      });
    },
    [dispatch, resumeLastTurn, startStream, completeNodeHistory, trimForRerun],
  );

  // An explicit rerun of an uncertain execution appends a new attempt, keeping
  // its existing output and anchors available for reference.
  const rerunLastTurn = useCallback(
    (nodeId: string, fromIndex?: number, binding?: SendBindingMeta) => retryLastTurn(nodeId, fromIndex, binding, true),
    [retryLastTurn],
  );

  const editAndResend = useCallback(
    async (nodeId: string, fromIndex: number, newText: string, binding?: SendBindingMeta) => {
      let n = nodesRef.current[nodeId];
      if (!n) return;
      if (n.messagesLoaded === false) {
        const completed = await completeNodeHistory(nodeId, fromIndex);
        if (!completed) return;
        n = completed.node;
        fromIndex = completed.fromIndex!;
      }
      cancelFns.current[nodeId]?.();
      // An edit that keeps the /name the message ran a skill with runs that
      // skill again; any other edit is read like a new message.
      const edited = n.messages[fromIndex];
      const slashName = (value: string) => parseSlashInvocation(value.trim())?.name.toLowerCase();
      const skill = edited?.skill && slashName(newText) !== undefined && slashName(newText) === slashName(edited.text)
        ? edited.skill : undefined;
      // The edited message keeps what it referred to (a post it replied to, handed-over rows).
      const resent = resendTurnContext(nodeId, n.messages[fromIndex]);
      trimForRerun(nodeId, n, fromIndex);
      // A model/effort picked since applies, as it does to a retry.
      void startStream(nodeId, newText, undefined, {
        ...(skill ? { skill } : {}),
        ...binding,
        ...(resent !== undefined ? { metaAgentContext: resent } : {}),
      });
    },
    [startStream, completeNodeHistory, trimForRerun],
  );

  const cancelStream = useCallback((nodeId: string) => {
    const fn = cancelFns.current[nodeId];
    const node = nodesRef.current[nodeId];
    const activeTurnId = node?.activeTurnId ?? node?.lastAppliedTurnId ?? node?.lastAppliedBackgroundTurnId;
    const observeCancellation = () => {
      const assistantId = node?.messages.at(-1)?.id;
      if (assistantId) dispatch({ type: 'done', nodeId, assistantId, aborted: true });
      cancelChatAndObserve(node!.chatId!, activeTurnId, (status) => {
        if (assistantId) dispatch({ type: 'cancel-recovery', nodeId, assistantId, ...status });
      });
    };
    if (node?.status === 'streaming') {
      // Optimistic cancel: immediately transition the node to idle so the
      // composer unlocks. The backend cancel and turn cleanup happen
      // asynchronously. A follow-up waits for this exact cancelled turn's
      // cleanup; it never interrupts a different window's newer turn.
      dispatch({ type: 'optimistic-cancel', nodeId });
    }
    // A send of this window registers its cancel in the tick it marks the
    // node streaming, so a Stop always finds it. Without one, only a turn id
    // lets the backend stop the turn; with neither, nothing here runs it and
    // the optimistic cancel above is all a Stop can do. Remembering the Stop
    // instead would cancel the user's next message.
    if (fn) {
      fn();
    } else if (node?.chatId && activeTurnId) {
      observeCancellation();
    }
  }, []);

  const switchAgent = useCallback(
    async (nodeId: string, modeId: string) => {
      const n = nodesRef.current[nodeId];
      if (!n?.chatId) return;
      // Optimistic: kiro-cli 2.1.0 doesn't broadcast current_mode_update, so we
      // flip currentModeId locally. If the RPC fails we roll back.
      const prev = n.currentModeId ?? null;
      dispatch({ type: 'set-current-mode', nodeId, currentModeId: modeId });
      try {
        const updated = await setChatMode(n.chatId, modeId);
        if (updated && updated !== modeId) {
          dispatch({ type: 'set-current-mode', nodeId, currentModeId: updated });
        }
      } catch (err) {
        if (prev !== null) dispatch({ type: 'set-current-mode', nodeId, currentModeId: prev });
        throw err;
      }
    },
    [dispatch],
  );

  const setChatPermissionMode = useCallback(async (nodeId: string, choice: import('michi-shared').ChatPermissionChoice) => {
    const node = nodesRef.current[nodeId];
    const project = projectsRef.current.find((candidate) => candidate.id === node?.projectId);
    if (!node || !project) throw new Error('Chat not found');
    const { mode, approveForMe } = chatPermissionChoiceParts(choice);
    const res = await backendFetch(`${nodeBackendApiBase(nodeId)}/nodes/${encodeURIComponent(nodeId)}/permissions`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, approveForMe, graphPrerequisite: durableNodePrerequisite(project, nodesRef.current, node) }),
    });
    if (!res.ok) throw new Error('Failed to save chat permissions');
    // An older Backend ignores approveForMe: show what it saved.
    const saved = await res.json().catch(() => null) as { approveForMe?: unknown } | null;
    dispatch({ type: 'set-permission-mode', nodeId, mode, approveForMe: approveForMe && saved?.approveForMe === true });
  }, [dispatch]);

  const setChatUltracode = useCallback(async (nodeId: string, enabled: boolean) => {
    const node = nodesRef.current[nodeId];
    const project = projectsRef.current.find((candidate) => candidate.id === node?.projectId);
    if (!node || !project) throw new Error('Chat not found');
    const res = await backendFetch(`${nodeBackendApiBase(nodeId)}/nodes/${encodeURIComponent(nodeId)}/ultracode`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, graphPrerequisite: durableNodePrerequisite(project, nodesRef.current, node) }),
    });
    if (!res.ok) {
      const failure = await res.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(typeof failure?.error === 'string' && res.status < 500 ? failure.error : 'Failed to save Ultracode');
    }
    const saved = await res.json().catch(() => null) as { enabled?: unknown; sessionState?: unknown } | null;
    dispatch({ type: 'set-ultracode', nodeId, enabled: saved?.enabled === true });
    // The live session's report of what took effect (model, workflows).
    if (saved?.sessionState && typeof saved.sessionState === 'object') {
      dispatch({ type: 'session-state', nodeId, state: parseSessionState({ ...(saved.sessionState as Record<string, unknown>) }) });
    }
  }, [dispatch]);

  const resolvePermission = useCallback((nodeId: string, optionId: string) => {
    const node = nodesRef.current[nodeId];
    if (!node?.chatId || !node.pendingPermission) return;
    const requestId = node.pendingPermission.requestId;
    if (!node.pendingPermission.options.some((option) => option.optionId === optionId && !option.disabled)) return;
    void respondToPermission(node.chatId, requestId, optionId)
      .then(() => {
        if (nodesRef.current[nodeId]?.pendingPermission?.requestId === requestId) dispatch({ type: 'permission-resolved', nodeId });
      })
      .catch(() => toast.error('Failed to send permission response'));
  }, [dispatch]);

  const denyPermission = useCallback((nodeId: string) => {
    const node = nodesRef.current[nodeId];
    if (!node?.chatId || !node.pendingPermission) return;
    const requestId = node.pendingPermission.requestId;
    void cancelPermission(node.chatId, requestId)
      .then(() => {
        if (nodesRef.current[nodeId]?.pendingPermission?.requestId === requestId) dispatch({ type: 'permission-resolved', nodeId });
      })
      .catch(() => toast.error('Failed to send permission denial'));
  }, [dispatch]);

  // Both resolve whether the response landed (false after the failure toast),
  // so the ask card can take input again at once instead of waiting it out.
  const resolveUserInputRequest = useCallback((nodeId: string, answers: Array<{ question: string; answer: string }>): Promise<boolean> => {
    const node = nodesRef.current[nodeId];
    if (!node?.chatId || !node.pendingUserInput) return Promise.resolve(false);
    const { requestId, interactionId } = node.pendingUserInput;
    return respondToUserInput(node.chatId, requestId, answers, interactionId)
      .then(() => { dispatch({ type: 'user-input-resolved', nodeId, requestId, interactionId, answers, outcome: 'answered' }); return true; })
      .catch(() => { toast.error('Failed to send user input response'); return false; });
  }, [dispatch]);

  const skipUserInputRequest = useCallback((nodeId: string): Promise<boolean> => {
    const node = nodesRef.current[nodeId];
    if (!node?.chatId || !node.pendingUserInput) return Promise.resolve(false);
    const { requestId, interactionId } = node.pendingUserInput;
    return skipUserInput(node.chatId, requestId, interactionId)
      .then(() => { dispatch({ type: 'user-input-resolved', nodeId, requestId, interactionId, answers: [], outcome: 'skipped' }); return true; })
      .catch(() => { toast.error('Failed to skip user input'); return false; });
  }, [dispatch]);

  const setMinimized = useCallback(
    (nodeId: string, minimized: boolean) => {
      dispatch({ type: 'set-minimized', nodeId, minimized });
    },
    [dispatch],
  );

  const setPaneWidth = useCallback(
    (paneId: string, width: number | undefined) => {
      setPaneItemWidth(paneId, width);
      dispatch({ type: 'set-pane-width', nodeId: paneId, width });
    },
    [dispatch, setPaneItemWidth],
  );

  const addPendingComment = useCallback(
    (nodeId: string, quotedText: string, body: string, source?: QuoteSource, context?: FileFeedbackTarget): boolean => {
      if (context && (context.nodeId !== nodeId || !isFileFeedbackTargetValid(context, projectsRef.current, nodesRef.current))) return false;
      const snapshot = source?.snapshot;
      if (context && snapshot && (snapshot.backendConnectionId !== context.backendConnectionId
        || snapshot.projectId !== context.projectId
        || (snapshot.treeId != null && snapshot.treeId !== context.treeId))) return false;
      const trimmedQuote = quotedText.trim();
      const trimmedBody = body.trim();
      // Guard against empty entries: a comment needs at least the body text,
      // since a quote-only entry is what Quote reply already covers.
      if (!trimmedBody) return false;
      dispatch({
        type: 'add-comment',
        nodeId,
        comment: {
          id: randomUuid(),
          quotedText: trimmedQuote,
          body: trimmedBody,
          createdAt: Date.now(),
          ...(source ? { source } : {}),
        },
      });
      return true;
    },
    [dispatch],
  );

  const editPendingComment = useCallback(
    (nodeId: string, commentId: string, body: string) => {
      dispatch({ type: 'edit-comment', nodeId, commentId, body });
    },
    [dispatch],
  );

  const removePendingComment = useCallback(
    (nodeId: string, commentId: string) => {
      dispatch({ type: 'remove-comment', nodeId, commentId });
    },
    [dispatch],
  );

  const clearPendingComments = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'clear-comments', nodeId });
    },
    [dispatch],
  );

  const steerMessage = useCallback(async (nodeId: string, text: string, options?: SteerMessageOptions): Promise<boolean> => {
    const node = nodesRef.current[nodeId];
    if (!node?.chatId) return false;
    if (options?.queueId) dispatch({ type: 'queue-steering', nodeId, queueId: options.queueId, steering: true });
    // A queued message to the agent carries what it was sent with into the running turn (§2.8 T4).
    const queued = options?.queueId ? node.pendingQueued?.find((entry) => entry.id === options.queueId) : undefined;
    try {
      const result = await steerChat(node.chatId, text, options, queued?.metaAgentContext);
      if (result.accepted && result.message) dispatch({ type: 'steer-accepted', nodeId, data: result.message });
      return result.accepted;
    } finally {
      if (options?.queueId) dispatch({ type: 'queue-steering', nodeId, queueId: options.queueId, steering: false });
    }
  }, [dispatch]);

  const queueMessage = useCallback(
    (nodeId: string, message: PendingQueuedMessage) => {
      // A message to the agent queued while it answers keeps what it carried when the user sent it
      // (its chips, the post it replies to, the area), for when it goes out (F1a-review #1).
      const metaAgentContext = message.metaAgentContext !== undefined ? message.metaAgentContext : captureMetaAgentTurnContext(nodeId);
      dispatch({ type: 'queue-message', nodeId, message: metaAgentContext !== undefined ? { ...message, metaAgentContext } : message });
    },
    [dispatch],
  );

  const dequeueMessage = useCallback(
    (nodeId: string, messageId: string) => {
      dispatch({ type: 'dequeue-message', nodeId, messageId });
    },
    [dispatch],
  );

  const flushQueue = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'flush-queue', nodeId });
    },
    [dispatch],
  );

  const markQueueErrored = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'mark-queue-errored', nodeId });
    },
    [dispatch],
  );

  const setComposerDraft = useCallback(
    (nodeId: string, draft: ComposerDraft | null) => {
      dispatch({ type: 'set-composer-draft', nodeId, draft });
    },
    [dispatch],
  );

  const setNodePosition = useCallback(
    (nodeId: string, position: { x: number; y: number }) => {
      dispatch({ type: 'set-position', nodeId, position });
    },
    [dispatch],
  );

  const resetLayout = useCallback(
    (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;
      dispatch({ type: 'clear-positions', nodeIds: project.chatIds });
    },
    [dispatch, projects],
  );

  const linkNodes = useCallback(
    (a: string, b: string) => {
      if (a === b) return false;
      const an = nodesRef.current[a];
      const bn = nodesRef.current[b];
      if (!an || !bn) return false;
      if (an.projectId !== bn.projectId) return false;
      if (!sameTree(a, b)) return false;
      const project = projects.find((p) => p.id === an.projectId);
      if (!project) return false;
      // Reject if ANY edge already connects these two nodes (in either
      // direction). Duplicating a branch edge as a link adds no info and
      // would just clutter the graph model.
      const alreadyConnected = project.edges.some(
        (e) =>
          (e.source === a && e.target === b) || (e.source === b && e.target === a),
      );
      if (alreadyConnected) return false;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id
            ? { ...p, edges: [...p.edges, { source: a, target: b, kind: 'link' as const }] }
            : p,
        ),
      );
      // Linking fresh — forget any prior consumption on either side so the
      // newly-linked peer's current context flows in on the next message.
      dispatch({ type: 'forget-consumed-link', nodeId: a, peerId: b });
      dispatch({ type: 'forget-consumed-link', nodeId: b, peerId: a });
      return true;
    },
    [dispatch, projects, sameTree],
  );

  const unlinkNodes = useCallback(
    (a: string, b: string) => {
      setProjects((prev) =>
        prev.map((p) => ({
          ...p,
          edges: p.edges.filter(
            (e) =>
              !(
                e.kind === 'link' &&
                ((e.source === a && e.target === b) || (e.source === b && e.target === a))
              ),
          ),
        })),
      );
    },
    [],
  );

  const fanoutBranches = useCallback(
    async (parentNodeId: string, topics: string[], opts?: { anchorMessageId?: string }) => {
      const cleaned = topics.map((t) => t.trim()).filter(Boolean);
      if (cleaned.length === 0) return [];
      const parent = nodesRef.current[parentNodeId];
      if (!parent) throw new Error('unknown parent node');
      const projectId = parent.projectId;
      const branch = resolveBranchParent(parentNodeId, projectsRef.current.find((p) => p.id === projectId), nodesRef.current);
      if (!branch) throw new Error('No chat to branch from');
      const { branchParentNodeId, contextFromNodeId } = branch;

      // Pre-generate ids locally, add all structural updates in one pass so
      // views see the new nodes appear together. No network round-trip needed.
      const newIds = cleaned.map(() => newNodeId(projectId));
      newIds.forEach((nid) => {
        dispatch({ type: 'create', nodeId: nid, projectId, parentNodeId: branchParentNodeId });
      });
      const createdAt = Date.now();
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? {
                ...p,
                chatIds: [...p.chatIds, ...newIds],
                edges: [
                  ...p.edges,
                  ...newIds.map((nid) =>
                    makeBranchEdge({
                      source: branchParentNodeId,
                      target: nid,
                      kind: 'branch',
                      anchorMessageId: opts?.anchorMessageId,
                      createdAt,
                    }),
                  ),
                ],
              }
            : p,
        ),
      );
      // Auto-open in panes so the new siblings are visible in the dashboard.
      setOpenPanes((prev) => [...prev, ...newIds.filter((id) => !prev.includes(id))]);
      setFocusedPane(newIds[0]);
      viewPane(newIds[0]);
      // Fire streams in parallel — each opens its own ACP session lazily.
      cleaned.forEach((topic, i) => {
        void startStream(newIds[i], topic, { contextFromNodeId });
      });
      return newIds;
    },
    [dispatch, newNodeId, setFocusedPane, setOpenPanes, startStream, viewPane],
  );

  const { createDigest, refreshDigest, setDigestPrompt, markDigestViewed, deleteDigest } = useDigestOrchestration({
    projects,
    dispatch,
    nodesRef,
    setProjects,
    setNodes,
    sameTree,
    newNodeId,
    ensureCompleteHistory,
  });

  /** Open and focus a non-chat pane (a new item, or a registered one by id) in
   *  `slot`, else the item's own, then show the Dashboard. The slot is explicit
   *  because a workspace switch earlier in this tick has not rendered yet. */
  const revealPane = useCallback((
    itemOrId: PaneItem | string,
    slot?: { projectId: string; treeId: string | null },
  ): string => {
    const item = typeof itemOrId === 'string' ? paneItemsRef.current[itemOrId] : itemOrId;
    if (!item) throw new Error('Pane is no longer available');
    if (item === itemOrId) registerPaneItem(item);
    openPaneInTree(slot?.projectId ?? item.projectId, slot ? slot.treeId : item.treeId, item.id);
    setFocusedNodeIdState(null);
    navPageEvent.dispatch({ page: 'dashboard' });
    return item.id;
  }, [openPaneInTree, registerPaneItem]);

  const openAgentRunPane = useCallback((
    identity: AgentResourceIdentity,
    workspaceId: string,
    title = 'Agent Run',
  ): string => {
    const project = projectsRef.current.find((candidate) => candidate.id === workspaceId && !candidate.deletedAt);
    if (!project) throw new Error('Agent Run workspace is not available');
    if (activeProjectIdRef.current !== workspaceId) selectProject(workspaceId);
    const id = agentRunPaneId(identity.backendConnectionId, identity.id);
    const item: PaneItem = {
      id,
      kind: 'agent-run',
      projectId: workspaceId,
      treeId: null,
      title,
      createdAt: Date.now(),
      backendConnectionId: identity.backendConnectionId,
      runId: identity.id,
    };
    return revealPane(item, { projectId: workspaceId, treeId: project.activeTreeId });
  }, [revealPane, selectProject]);
  openAgentRunPaneRef.current = openAgentRunPane;

  const openPagePane = useCallback((page: { pageId: string; workspaceId: string; backendConnectionId: string; title?: string }): string => {
    const host = projectsRef.current.find((candidate) => candidate.id === activeProjectIdRef.current && !candidate.deletedAt);
    if (!host) throw new Error('No active workspace for the Page pane');
    const id = pagePaneId(page.backendConnectionId, page.workspaceId, page.pageId);
    const item: PaneItem = {
      id,
      kind: 'page',
      projectId: host.id,
      treeId: host.activeTreeId,
      title: page.title?.trim() || 'Page',
      createdAt: Date.now(),
      backendConnectionId: page.backendConnectionId,
      workspaceId: page.workspaceId,
      pageId: page.pageId,
    };
    return revealPane(item);
  }, [revealPane]);

  const openFilePane = useCallback((filePath: string, options?: { parseSourceLocation?: boolean }): string => {
    if (!activeProjectId) throw new Error('No active project');
    const raw = filePath.trim();
    if (!raw) throw new Error('No file path provided');
    const { filePath: cleanPath, line, column } = options?.parseSourceLocation
      ? parseSourceLocation(raw)
      : { filePath: raw, line: undefined, column: undefined };
    const sourceLocation = line != null ? (column != null ? { line, column } : { line }) : undefined;
    const sourceReferencePath = sourceLocation ? raw : undefined;
    const isMarkdown = /\.(?:md|mdx|markdown)$/i.test(cleanPath);
    const activeTreeId = projectsRef.current.find((project) => project.id === activeProjectId)?.activeTreeId ?? 'none';
    const paneTreeId = activeTreeId === 'none' ? null : activeTreeId;
    const originTarget = paneTreeId && focusedNodeId ? {
      backendConnectionId: projectsRef.current.find(project => project.id === activeProjectId)?.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID,
      projectId: activeProjectId, treeId: paneTreeId, nodeId: focusedNodeId,
    } : null;
    const originChatNodeId = originTarget && isFileFeedbackTargetValid(originTarget, projectsRef.current, nodesRef.current)
      ? originTarget.nodeId : undefined;
    const identityPath = sourceReferencePath ? `source\0${cleanPath}` : cleanPath;
    const id = singletonPaneId('file', `${activeProjectId}:${activeTreeId}`, identityPath);
    const exactPane = paneItemsRef.current[id];
    const existing = exactPane?.kind === 'file' ? exactPane : undefined;
    if (existing) {
      const previousBasename = existing.filePath.split(/[\\/]/).filter(Boolean).pop() ?? existing.filePath;
      const cleanTitle = cleanPath.split(/[\\/]/).filter(Boolean).pop() ?? cleanPath;
      updatePaneItem(existing.id, {
        originChatNodeId,
        filePath: cleanPath,
        title: existing.title === previousBasename ? cleanTitle : existing.title,
        sourceLocation,
        sourceReferencePath,
        ...(sourceLocation && isMarkdown ? { viewMode: 'source' as const } : {}),
      });
      return revealPane(existing.id);
    }
    const title = cleanPath.split(/[\\/]/).filter(Boolean).pop() ?? cleanPath;
    return revealPane({
      id,
      kind: 'file',
      originChatNodeId,
      projectId: activeProjectId,
      treeId: paneTreeId,
      title,
      createdAt: Date.now(),
      filePath: cleanPath,
      viewMode: sourceLocation ? 'source' : isMarkdown ? 'rendered' : 'source',
      sourceLocation,
      sourceReferencePath,
    });
  }, [activeProjectId, focusedNodeId, revealPane, updatePaneItem]);

  const openBrowserPane = useCallback((url = DEFAULT_BROWSER_URL): string => {
    if (!activeProjectId) throw new Error('No active project');
    const normalized = normalizeBrowserUrl(url) ?? DEFAULT_BROWSER_URL;
    const id = uniquePaneId('browser');
    const surfaceId = id.slice('pane:browser:'.length);
    const treeId = projectsRef.current.find((project) => project.id === activeProjectId)?.activeTreeId ?? null;
    return revealPane({
      id,
      kind: 'browser',
      projectId: activeProjectId,
      treeId,
      title: 'Browser',
      createdAt: Date.now(),
      surfaceId,
      url: normalized,
    });
  }, [activeProjectId, revealPane]);

  const openLauncherPane = useCallback((): string => {
    if (!activeProjectId) throw new Error('No active project');
    const project = projectsRef.current.find((candidate) => candidate.id === activeProjectId);
    const id = uniquePaneId('launcher');
    const focusedId = focusedPaneRef.current;
    const anchorNodeId = focusedId && nodesRef.current[focusedId]?.projectId === activeProjectId
      ? focusedId
      : undefined;
    return revealPane({
      id,
      kind: 'launcher',
      projectId: activeProjectId,
      treeId: project?.activeTreeId ?? null,
      title: 'New pane',
      createdAt: Date.now(),
      anchorNodeId,
    });
  }, [activeProjectId, revealPane]);

  /** A conversation takes a launcher's slot and width, with focus; the launcher goes. */
  const takeLauncherSlot = useCallback((paneId: string, nodeId: string, width: number | undefined) => {
    setOpenPanes((previous) => {
      const withoutNode = previous.filter((id) => id !== nodeId);
      return withoutNode.map((id) => id === paneId ? nodeId : id);
    });
    setFocusedPane(nodeId);
    setFocusedNodeIdState(nodeId);
    if (width !== undefined) setPaneWidth(nodeId, width);
    removePaneItem(paneId);
  }, [removePaneItem, setFocusedPane, setOpenPanes, setPaneWidth]);

  const openNodeInLauncherPane = useCallback((paneId: string, nodeId: string) => {
    const launcher = paneItemsRef.current[paneId];
    if (!launcher || launcher.kind !== 'launcher') return;
    const node = nodesRef.current[nodeId];
    if (!node || node.deletedAt || node.projectId !== launcher.projectId) return;
    takeLauncherSlot(paneId, nodeId, launcher.width);
  }, [takeLauncherSlot]);

  const activateLauncherPane = useCallback(async (paneId: string, choice: PaneLauncherChoice): Promise<string> => {
    const launcher = paneItemsRef.current[paneId];
    if (!launcher || launcher.kind !== 'launcher') throw new Error('Pane launcher is no longer available');
    const project = projectsRef.current.find((candidate) => candidate.id === launcher.projectId);
    if (!project) throw new Error('Workspace is no longer available');
    const base = {
      id: paneId,
      projectId: launcher.projectId,
      treeId: launcher.treeId,
      createdAt: launcher.createdAt,
      width: launcher.width,
    };

    if (choice === 'files') {
      if (project.backendConnectionId) {
        throw new Error('Native folder browsing is unavailable for remote workspaces. Open files produced by the agent from chat artifacts instead.');
      }
      replacePaneItem(paneId, { ...base, kind: 'files', title: 'Files' });
      return paneId;
    }
    if (choice === 'review') {
      replacePaneItem(paneId, { ...base, kind: 'review', title: 'Review' });
      return paneId;
    }
    if (choice === 'terminal') {
      const runtimeId = uniquePaneId('terminal');
      replacePaneItem(paneId, {
        ...base,
        treeId: null, // Terminal is window-scoped, not tree-scoped
        kind: 'terminal',
        title: 'Terminal',
        surfaceId: runtimeId.slice('pane:terminal:'.length),
        cwd: project.cwd ?? project.folders?.[0]?.path ?? '',
        ...terminalPaneFields(terminalTargetForWorkspace(project)),
      });
      return paneId;
    }
    if (choice === 'browser') {
      const runtimeId = uniquePaneId('browser');
      replacePaneItem(paneId, {
        ...base,
        kind: 'browser',
        title: 'Browser',
        surfaceId: runtimeId.slice('pane:browser:'.length),
        url: DEFAULT_BROWSER_URL,
      });
      return paneId;
    }

    const anchorNodeId = launcher.anchorNodeId && resolveBranchParent(launcher.anchorNodeId, project, nodesRef.current)
      ? launcher.anchorNodeId
      : activeTreeRootNodeId(project);
    if (!anchorNodeId) throw new Error('No chat is available to branch from');
    const nodeId = await createBlankChild(anchorNodeId);
    takeLauncherSlot(paneId, nodeId, launcher.width);
    return nodeId;
  }, [createBlankChild, replacePaneItem, takeLauncherSlot]);

  /** Move an existing detached terminal into the slot currently held by a launcher pane. */
  const adoptTerminalPane = useCallback((launcherPaneId: string, terminalPaneId: string) => {
    const launcher = paneItemsRef.current[launcherPaneId];
    const terminal = paneItemsRef.current[terminalPaneId];
    if (!launcher || launcher.kind !== 'launcher') return;
    if (!terminal || terminal.kind !== 'terminal') return;

    // Replace the launcher slot with the terminal pane id.
    setOpenPanes((prev) => prev.map((id) => (id === launcherPaneId ? terminalPaneId : id)));
    setFocusedPane(terminalPaneId);

    // Inherit the launcher's width so the pane doesn't jump.
    if (launcher.width !== undefined) {
      updatePaneItem(terminalPaneId, { width: launcher.width });
    }

    // Discard the launcher item — the terminal item already exists.
    removePaneItem(launcherPaneId);
  }, [removePaneItem, setFocusedPane, setOpenPanes, updatePaneItem]);

  /** Show a terminal a backend already runs (another window's, or one this window closed earlier) in a launcher slot. */
  const adoptBackendTerminal = useCallback((launcherPaneId: string, terminal: { terminalId: string; cwd: string }, connectionId: string) => {
    const launcher = paneItemsRef.current[launcherPaneId];
    if (!launcher || launcher.kind !== 'launcher') return;
    replacePaneItem(launcherPaneId, {
      id: launcherPaneId,
      projectId: launcher.projectId,
      treeId: null, // Terminal is window-scoped, not tree-scoped
      createdAt: launcher.createdAt,
      width: launcher.width,
      kind: 'terminal',
      title: 'Terminal',
      surfaceId: terminal.terminalId,
      cwd: terminal.cwd,
      ...terminalPaneFields({ transport: 'backend', connectionId }),
    });
  }, [replacePaneItem]);

  // Compatibility name retained for artifact shelf/link callers: artifacts
  // open as layout-only file PaneItems, not conversation-graph nodes.
  const openArtifactPane = useCallback(
    async (filePath: string, options?: { parseSourceLocation?: boolean }): Promise<string> => openFilePane(filePath, options),
    [openFilePane],
  );

  const bumpStructureVersion = useCallback(() => { structureVersionRef.current += 1; }, []);
  const {
    deleteSubtree,
    deleteNode: deleteNodeRaw,
    trimNode: trimNodeRaw,
    archiveNode: archiveNodeRaw,
    restoreDeletion,
    moveDeletionGroupLane,
    purgeDeletion,
    purgeDeletionAsync,
    restoreLastDeletion,
    emptyTrash,
    emptyTrashAsync,
  } = useTrashActions({
    projects,
    nodesRef,
    cancelFns,
    setProjects,
    setNodes,
    setOpenPanes,
    setFocusedPane,
    setFocusedNodeId: setFocusedNodeIdState,
    setSelection: setSelectionState,
    trashTTLDays: prefs.trashTTLDays,
    activeTreeRootNodeId,
    syncPausedRef,
    bumpStructureVersion,
  });

  const setSidebarExpandedPref = useCallback(
    (sidebarExpanded: typeof prefs.sidebarExpanded) => {
      setPref('sidebarExpanded', sidebarExpanded);
    },
    [setPref],
  );

  const extractNodeTree = useExtractNodeTree({
    projectsRef, activeProjectIdRef, nodesRef, commandsInFlightRef, boundSessionsRef,
    setProjects, setNodes, runWorkspaceMutation, prunePaneIds, setPaneSlot, selectProject,
    setFocusedNodeId: setFocusedNodeIdState, setSelection: setSelectionState,
    bumpStructureVersion,
  });

  const {
    createThread,
    archiveTree: archiveTreeRaw,
    unarchiveTree: unarchiveTreeRaw,
    pinTree: pinTreeRaw,
    unpinTree: unpinTreeRaw,
    pinProject: pinProjectRaw,
    unpinProject: unpinProjectRaw,
    renameTree: renameTreeRaw,
    activateTree,
    deleteTree: deleteTreeRaw,
    moveTreeToWorkspace: moveTreeToWorkspaceRaw,
  } = useTreeActions({
    projects,
    activeProjectId,
    nodesRef,
    dispatch,
    renameNode: renameNodeRaw,
    newNodeId,
    setProjects,
    setNodes,
    setPaneSlot,
    ensurePaneSlot,
    setFocusedNodeId: setFocusedNodeIdState,
    selectProject,
    deleteSubtree,
    sidebarExpanded: prefs.sidebarExpanded,
    setSidebarExpanded: setSidebarExpandedPref,
    runWorkspaceMutation,
    adoptBackendStructure,
    bumpStructureVersion,
  });

  // The user's workspace to come back to while the assistant's hidden one is
  // active (New thread, Home and the thread views return there).
  useEffect(() => {
    rememberUserWorkspace(projects.find((p) => p.id === activeProjectId));
  }, [activeProjectId, projects]);

  /** Focus the window, open `nodeId`'s pane wherever it lives, land on the
   *  Dashboard. Shared by notifications and every in-app link or button whose
   *  click should take the user to a node. */
  const revealNode = useCallback((nodeId: string, opts?: { workspaceId?: string; messageId?: string }): boolean => {
    window.focus();
    // The assistant's conversations live in its hidden workspace: they show
    // in the panel, never by switching to that workspace.
    if (revealInCompanionPanel(projectsRef.current, nodeId)) return true;
    const owner = (opts?.workspaceId
      ? projectsRef.current.find((p) => p.id === opts.workspaceId && p.chatIds.includes(nodeId))
      : undefined) ?? projectsRef.current.find((p) => p.chatIds.includes(nodeId));
    if (!owner) return false;
    navigateToNode(
      {
        projects: projectsRef.current,
        activeProjectId: activeProjectIdRef.current,
        selectProject,
        openPane,
        openPaneInTree,
        activateTree,
        setFocusedNodeId,
      },
      nodeId,
      owner.id,
    );
    navPageEvent.dispatch({ page: 'dashboard' });
    // The pane carries the jump out once it shows the message, even when it mounts later.
    if (opts?.messageId) requestMessageJump(nodeId, opts.messageId);
    return true;
  }, [activateTree, openPane, openPaneInTree, selectProject, setFocusedNodeId]);
  revealNodeRef.current = revealNode;

  // The user's actions as the app exposes them, each recording its undo on
  // the window's undo history; the raw ones above stay for the store's own use.
  const {
    archiveTree,
    unarchiveTree,
    deleteTree,
    moveTreeToWorkspace,
    renameNode,
    renameTree,
    pinTree,
    unpinTree,
    pinNode,
    unpinNode,
    pinProject,
    unpinProject,
    deleteNode,
    trimNode,
    archiveNode,
    renameProject,
    archiveProject,
    unarchiveProject,
    deleteProject,
    restoreProject,
    bulkArchiveTrees,
    bulkDeleteTrees,
    bulkUnarchiveTrees,
    closePane,
  } = useUndoableActions({
    archiveTree: archiveTreeRaw,
    unarchiveTree: unarchiveTreeRaw,
    deleteTree: deleteTreeRaw,
    restoreDeletion,
    moveTreeToWorkspace: moveTreeToWorkspaceRaw,
    renameNode: renameNodeRaw,
    renameTree: renameTreeRaw,
    pinTree: pinTreeRaw,
    unpinTree: unpinTreeRaw,
    pinNode: pinNodeRaw,
    unpinNode: unpinNodeRaw,
    pinProject: pinProjectRaw,
    unpinProject: unpinProjectRaw,
    deleteNode: deleteNodeRaw,
    trimNode: trimNodeRaw,
    archiveNode: archiveNodeRaw,
    renameProject: renameProjectRaw,
    archiveProject: archiveProjectRaw,
    unarchiveProject: unarchiveProjectRaw,
    deleteProject: deleteProjectRaw,
    restoreProject: restoreProjectRaw,
    closePane: closePaneRaw,
    restorePaneInSlot,
    registerPaneItem,
    revealNode,
    selectProject,
    activateTree,
    clearTreeSelection,
  }, { projectsRef, nodesRef, activeProjectIdRef, paneItemsRef, slotPanes, focusedPane, treeSelection });

  // A multi-model run's branches next to the chat that started it. Defined
  // after the tree actions (activateTree), unlike fanoutBranches.
  const openPanesSideBySide = useCallback((callerNodeId: string, childNodeIds: readonly string[], opts?: { focusNodeId?: string }) => {
    const caller = nodesRef.current[callerNodeId];
    const project = caller ? projectsRef.current.find((p) => p.id === caller.projectId && !p.deletedAt) : undefined;
    const treeId = project ? findTreeIdForNode(callerNodeId, project) : null;
    if (!project || !treeId) return;
    const children = [...new Set(childNodeIds)].filter((id) => {
      const node = nodesRef.current[id];
      return id !== callerNodeId && !!node && !node.deletedAt && node.projectId === project.id && findTreeIdForNode(id, project) === treeId;
    });
    const group = [callerNodeId, ...children];
    const focusId = opts?.focusNodeId && group.includes(opts.focusNodeId) ? opts.focusNodeId : children[0] ?? callerNodeId;
    if (project.id === activeProjectIdRef.current && treeId === project.activeTreeId) {
      // The branches sit right after the chat, even with unrelated panes open around it.
      setOpenPanes((prev) => {
        const rest = prev.filter((id) => !group.includes(id));
        const callerIndex = prev.indexOf(callerNodeId);
        if (callerIndex < 0) return [...rest, ...group];
        const at = prev.slice(0, callerIndex).filter((id) => !group.includes(id)).length;
        return [...rest.slice(0, at), ...group, ...rest.slice(at)];
      });
      setFocusedPane(focusId);
    } else {
      // Seed the destination slot before switching to it (navigateToNode explains why).
      if (project.id !== activeProjectIdRef.current) selectProject(project.id);
      for (const id of [...group.filter((id) => id !== focusId), focusId]) openPaneInTree(project.id, treeId, id);
      activateTree(treeId, project.id);
    }
    viewPane(focusId);
    navPageEvent.dispatch({ page: 'dashboard' });
  }, [activateTree, openPaneInTree, selectProject, setFocusedPane, setOpenPanes, viewPane]);

  const handleStreamComplete = useCallback((nodeId: string) => {
    // A scheduled run reports its own completion (with the job's name).
    if (scheduledNodeIdsRef.current.has(nodeId)) return;
    const node = nodesRef.current[nodeId];
    if (latestTurnIsScheduled(node?.messages)) return;
    // A check-in's post and first-run narration: the Companion's own notices
    // carry them, by its level (DESIGN-v2 §3.3). A reply in V does notify,
    // under the agent's name (the panel showing V counts as in view).
    const last = node?.messages[node.messages.length - 1];
    if (isCompanionSelfMessage(last)) return;
    const companion = isAssistantConversation(projectsRef.current, nodeId);
    // A renamed thread's root goes by the thread's name, as in the sidebar.
    const threadName = projectsRef.current.find((project) => project.id === node?.projectId)
      ?.trees.find((tree) => tree.rootNodeId === nodeId)?.name?.trim();
    // Even the focused pane: with the window in the background, nobody sees it finish.
    presentNodeAttention(nodeId, {
      kind: 'finished',
      ...completionAttentionCopy(threadName || node?.title),
      ...(companion ? { title: companionNoticeTitle('reply') } : {}),
      // A queued follow-up that already started makes "finished" untrue.
      isStillCurrent: () => {
        const current = nodesRef.current[nodeId];
        return !!current && current.status !== 'streaming' && !current.deletedAt;
      },
    });
  }, [presentNodeAttention]);
  streamCompleteHandlerRef.current = handleStreamComplete;

  /**
   * Install (or refresh) a thread the backend created without this renderer,
   * e.g. a scheduled run or a conversation started on another device.
   * Resolves false when its workspace is not loaded.
   */
  const installBackendNode = useCallback((workspaceId: string, nodeId: string, refresh: boolean): Promise<boolean> => {
    const key = `${workspaceId}\u0000${nodeId}\u0000${refresh ? 'refresh' : 'install'}`;
    if (!refresh) {
      const finalRefresh = backendNodeInstallsRef.current.get(`${workspaceId}\u0000${nodeId}\u0000refresh`);
      if (finalRefresh) return finalRefresh;
    }
    const pending = backendNodeInstallsRef.current.get(key);
    if (pending) return pending;
    const requestKey = `${workspaceId}\u0000${nodeId}`;
    // A newer request for the node supersedes this one: its reads stop.
    backendNodeInstallRequestsRef.current.get(requestKey)?.abort();
    const request = new AbortController();
    backendNodeInstallRequestsRef.current.set(requestKey, request);
    const { signal } = request;
    const work = (async () => {
      if (nodesRef.current[nodeId] && !refresh) return true;
      const read = await readAndInstallNode({
        workspaceId,
        nodeId,
        attempts: BACKEND_NODE_INSTALL_ATTEMPTS,
        signal,
        readTimeoutMs: GAP_READ_TIMEOUT_MS,
        project: () => projectsRef.current.find((candidate) => candidate.id === workspaceId && !candidate.deletedAt),
        node: () => nodesRef.current[nodeId],
        nodeHeld: false,
        busy: () => nodeBusy(nodeId),
        // Off the feed: wait as long as the turn or command runs, rather
        // than dropping the final refresh.
        idle: async () => {
          while (nodeBusy(nodeId) && !signal.aborted) await sleep(50);
          return !signal.aborted;
        },
        fetchStructure: fetchWorkspaceStructure,
        fetchPage: fetchTreeMessagePage,
        install: ({ structure, page, readStartedAt, connectionId }) => {
          const result = installBackendWorkspaceNode({
            currentProjects: projectsRef.current,
            currentNodes: nodesRef.current,
            rawWorkspace: structure,
            page,
            readStartedAt,
            guards: structureGuards,
            nodeId,
            connectionId,
          });
          if (result) commitBackendInstall(result);
          return !!result;
        },
      });
      return typeof read === 'object' && read.installed;
    })().catch((error: unknown) => {
      if (signal.aborted) return false;
      throw error;
    }).finally(() => {
      if (backendNodeInstallsRef.current.get(key) === work) backendNodeInstallsRef.current.delete(key);
      if (backendNodeInstallRequestsRef.current.get(requestKey) === request) backendNodeInstallRequestsRef.current.delete(requestKey);
    });
    backendNodeInstallsRef.current.set(key, work);
    return work;
  }, [commitBackendInstall, nodeBusy, structureGuards]);
  installBackendNodeRef.current = installBackendNode;

  /** Open a backend-created thread (from a notification), installing it first if needed. */
  const revealBackendNode = useCallback(async (workspaceId: string, nodeId: string): Promise<boolean> => {
    if (!nodesRef.current[nodeId]) {
      const installed = await installBackendNode(workspaceId, nodeId, false).catch(() => false);
      if (!installed || !nodesRef.current[nodeId]) return false;
    }
    return revealNode(nodeId, { workspaceId });
  }, [installBackendNode, revealNode]);

  // Per node: a discovery in flight (did its turn end meanwhile?), or when a
  // failed one may be tried again. Discovered nodes wait for their turn's end.
  const backendChatDiscoveriesRef = useRef(new Map<string, { ended: boolean } | { retryAt: number }>());
  const discoveredBackendNodesRef = useRef(new Map<string, string>());

  /**
   * A background frame named a chat this window has never seen: a conversation
   * started on a phone or another machine after this window loaded. Ask the
   * backend where it lives and install it, as a reload would. Frames that
   * arrive meanwhile are dropped, so its turn's end re-reads the exact
   * transcript, as a scheduled run's finish does. The returned handlers only
   * note that end, in case it comes before the install.
   */
  const discoverBackendChat = useCallback((connectionId: string, chatId: string, envelopeNodeId?: string): StreamHandlers => {
    let nodeId: string;
    try { nodeId = backendEntityId(connectionId, envelopeNodeId ?? chatId); } catch { return {}; }
    if (nodesRef.current[nodeId]) return {};
    const discoveries = backendChatDiscoveriesRef.current;
    const markEnded = () => {
      const current = discoveries.get(nodeId);
      if (current && 'ended' in current) current.ended = true;
    };
    const handlers: StreamHandlers = { onDone: markEnded, onError: markEnded, onErrorPayload: markEnded };
    const known = discoveries.get(nodeId);
    if (known && ('ended' in known || Date.now() < known.retryAt)) return handlers;
    const discovery = { ended: false };
    discoveries.set(nodeId, discovery);
    const settle = (installed: boolean) => {
      if (discoveries.get(nodeId) !== discovery) return;
      if (!installed) {
        discoveredBackendNodesRef.current.delete(nodeId);
        discoveries.set(nodeId, { retryAt: Date.now() + BACKEND_CHAT_DISCOVERY_RETRY_MS });
        return;
      }
      discoveries.delete(nodeId);
      // It ended while installing: no later frame will say so, re-read now.
      if (discovery.ended) discoveredTurnEndRef.current(nodeId);
    };
    void (async () => {
      const where = await fetchNodeWorkspace(nodeId);
      if (!where) return false; // Not a live thread (deleted, or a chat without one).
      if (nodesRef.current[nodeId]) return true;
      discoveredBackendNodesRef.current.set(nodeId, where.workspaceId);
      if (projectsRef.current.some((project) => project.id === where.workspaceId)) {
        return installBackendNode(where.workspaceId, nodeId, false);
      }
      // Its workspace is new here too. A remote connection's new workspaces
      // arrive with that connection's own load.
      if (connectionId !== LOCAL_BACKEND_CONNECTION_ID) return false;
      const readStartedAt = Date.now();
      // Structure only: its threads arrive as placeholders that load when
      // opened, and this one's turn end installs its transcript.
      const raw = await fetchWorkspaceStructure(where.workspaceId);
      return installWorkspaceSnapshot(raw, readStartedAt) && !!nodesRef.current[nodeId];
    })().then(settle, () => settle(false));
    return handlers;
  }, [installBackendNode, installWorkspaceSnapshot]);
  unknownBackendChatRef.current = discoverBackendChat;
  discoveredTurnEndRef.current = (nodeId: string) => {
    const workspaceId = discoveredBackendNodesRef.current.get(nodeId);
    if (!workspaceId) return;
    discoveredBackendNodesRef.current.delete(nodeId);
    void installBackendNode(workspaceId, nodeId, true).catch(() => {});
  };

  const handleScheduledJobRun = useCallback((event: ScheduledJobRunEvent) => {
    if (event.nodeId) scheduledNodeIdsRef.current.add(event.nodeId);
    // The Scheduled page refreshes its list on this, and in a browser
    // useScheduledRunOpening raises the run's notice from it.
    window.dispatchEvent(new CustomEvent(SCHEDULED_JOB_RUN_WINDOW_EVENT, { detail: event }));
    if (!event.nodeId) return;
    // Install on start so the run streams live; refresh on finish so the
    // final transcript is exact even if early frames arrived before install.
    void installBackendNode(event.workspaceId, event.nodeId, event.phase === 'finished').catch(() => {});
  }, [installBackendNode]);
  scheduledJobRunHandlerRef.current = handleScheduledJobRun;

  const {
    createContext,
    updateContext,
    deleteContext,
    pinContext,
  } = useContextActions({
    projects,
    activeProjectId,
    setProjects,
    onArtifactNamed: noteArtifactNamed,
  });

  // Auto-open the root pane when (and only when) the active workspace
  // CHANGES *and* the destination tree's pane slot is empty. Previously this
  // also depended on `projects`, which mutates on every chat/edge mutation —
  // so creating a new thread would trip this effect and blow away any split
  // panes the user had open. Now we also skip when callers (e.g. sidebar
  // cross-workspace branch click via `openPaneInTree`) have already seeded
  // the destination slot, so we don't clobber their explicit pane choice.
  const lastActiveProjectIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastActiveProjectIdRef.current === activeProjectId) return;
    lastActiveProjectIdRef.current = activeProjectId;
    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) {
      setFocusedNodeIdState(null);
      setOpenPanes([]);
      setFocusedPane(null);
      return;
    }
    // If a caller has already populated the destination tree's pane slot
    // (paneKey = projectId::activeTreeId), let it stand — they own the
    // focused node + open panes for this switch. Reading openPanes here is
    // sound because openPanes already reflects the new paneKey by the time
    // this effect runs.
    if (openPanes.length > 0) return;
    setFocusedNodeIdState(null);
    const root = activeTreeRootNodeId(project);
    if (!root) {
      // No active tree: leave the workspace-only slot free of chat nodes,
      // including when every existing thread is archived or deleted.
      setOpenPanes([]);
      setFocusedPane(null);
      return;
    }
    setOpenPanes([root]);
    setFocusedPane(root);
  }, [activeProjectId, projects, openPanes, setFocusedPane, setOpenPanes]);

  const toggleTheme = useCallback(() => {
    setPref('terminalPalette', DARK_PALETTES.has(prefs.terminalPalette) ? 'bone' : 'monokai');
  }, [prefs.terminalPalette, setPref]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId && !p.deletedAt) ?? null,
    [projects, activeProjectId],
  );

  // ── Artifact live-refresh watch ────────────────────────────────────────────
  // Subscribe to disk changes for the active workspace's artifacts so an open
  // FilePane can show a "Changed on disk · refresh" badge. The watch set is the union
  // of (a) registry artifacts with a real filePath — pre-arms a watcher before
  // the pane is even opened — and (b) any currently-open file pane's path,
  // which covers panes opened from a markdown link (not necessarily in the
  // registry). Link artifacts (empty filePath) and abs paths outside the cwd
  // are dropped server-side; that's a graceful no-badge downgrade, not an error.
  const artifactWatchPaths = useMemo(() => {
    const set = new Set<string>();
    for (const a of activeProject?.artifacts ?? []) {
      if (a.filePath && a.filePath.trim()) set.add(a.filePath);
    }
    for (const item of Object.values(paneItems)) {
      if (item.kind === 'file' && item.projectId === activeProjectId && !isAbsoluteFilePath(item.filePath)) {
        set.add(item.filePath);
      }
    }
    return Array.from(set);
  }, [activeProject, activeProjectId, paneItems]);

  // Stable dispatcher: on a disk change/removal, flag every matching open
  // file pane in the active workspace. Reads refs so identity never churns
  // the EventSource lifecycle.
  const markArtifactPanes = useCallback(
    (filePath: string, removed: boolean) => {
      const pid = activeProjectIdRef.current;
      for (const item of Object.values(paneItemsRef.current)) {
        if (item.kind === 'file' && item.projectId === pid && item.filePath === filePath) {
          updatePaneItem(item.id, { diskState: removed ? 'removed' : 'changed' });
        }
      }
    },
    [updatePaneItem],
  );

  useArtifactWatch({
    workspaceId: activeProjectId ?? undefined,
    enabled: !!activeProjectId && artifactWatchPaths.length > 0,
    paths: artifactWatchPaths,
    onChanged: (fp) => markArtifactPanes(fp, false),
    onRemoved: (fp) => markArtifactPanes(fp, true),
  });

  const projectsValue = useMemo<ChatProjectsValue>(
    () => ({
      projects,
      activeProjectId,
      activeProject,
      // Read nodesRef.current (not the `nodes` state) so this memo doesn't
      // re-fire on every streaming chunk. deleteNode/restoreDeletion bump
      // project identity to keep `order`/`edges` fresh on deletedAt flips.
      order: (activeProject?.chatIds ?? []).filter((id) => !nodesRef.current[id]?.deletedAt),
      edges: (activeProject?.edges ?? []).filter(
        (e) => !nodesRef.current[e.source]?.deletedAt && !nodesRef.current[e.target]?.deletedAt,
      ),
      theme,
      availableModes,
      defaultModeId,
      agentModesLoading,
      agentModesError,
      retryAgentModes,
      agentStatus,
      agentStatusUnreachable,
      warmFailedError,
      refreshAgentStatus,
      focusedNodeId,
      selection,
      hydrated,
      treeSelection,
      searchHighlightTerm,
      unreadFilterOn,
    }),
    [
      projects,
      activeProjectId,
      activeProject,
      theme,
      availableModes,
      defaultModeId,
      agentModesLoading,
      agentModesError,
      retryAgentModes,
      agentStatus,
      agentStatusUnreachable,
      warmFailedError,
      refreshAgentStatus,
      focusedNodeId,
      selection,
      hydrated,
      treeSelection,
      searchHighlightTerm,
      unreadFilterOn,
    ],
  );

  const paneValue = useMemo<ChatPaneValue>(
    () => ({
      openPanes,
      tabPanes,
      pagePane,
      paneItems,
      focusedPane,
      zoomedPane,
      focusNonce,
      viewMode,
    }),
    [openPanes, tabPanes, pagePane, paneItems, focusedPane, zoomedPane, focusNonce, viewMode],
  );

  const value = useMemo<ExtendedChatContextValue>(
    () => ({
      projects,
      activeProjectId,
      activeProject,
      // order / edges are the LIVE projection — soft-deleted nodes and the
      // edges touching them are filtered out. Consumers that need the raw
      // list (including trash rows) read `activeProject.chatIds` / `.edges`.
      order: (activeProject?.chatIds ?? []).filter((id) => !nodesRef.current[id]?.deletedAt),
      edges: (activeProject?.edges ?? []).filter(
        (e) => !nodesRef.current[e.source]?.deletedAt && !nodesRef.current[e.target]?.deletedAt,
      ),
      theme,
      toggleTheme,
      createProject,
      enterChatsWorkspace,
      renameProject,
      setProjectCwd,
      addFolder,
      removeFolder,
      updateFolderLabel,
      setProjectInstructions,
      deleteProject,
      restoreProject,
      purgeProject,
      archiveProject,
      unarchiveProject,
      selectProject,
      sendMessage,
      setChatPermissionMode,
      setChatUltracode,
      retryLastTurn,
      rerunLastTurn,
      resumeLastTurn,
      editAndResend,
      createChildChat,
      createBlankChild,
      createMergedChat,
      cancelStream,
      availableModes,
      defaultModeId,
      agentModesLoading,
      agentModesError,
      retryAgentModes,
      agentStatus,
      agentStatusUnreachable,
      warmFailedError,
      refreshAgentStatus,
      switchAgent,
      deleteNode,
      trimNode,
      extractNodeTree,
      archiveNode,
      restoreLastDeletion,
      restoreDeletion,
      moveDeletionGroupLane,
      purgeDeletion,
      purgeDeletionAsync,
      emptyTrash,
      emptyTrashAsync,
      setMinimized,
      setPaneWidth,
      setNodePosition,
      resetLayout,
      fanoutBranches,
      openPanesSideBySide,
      linkNodes,
      unlinkNodes,
      createDigest,
      refreshDigest,
      setDigestPrompt,
      markDigestViewed,
      setComposerDraft,
      deleteDigest,
      openArtifactPane,
      openLauncherPane,
      activateLauncherPane,
      adoptTerminalPane,
      adoptBackendTerminal,
      openNodeInLauncherPane,
      openFilePane,
      openBrowserPane,
      openAgentRunPane,
      openPagePane,
      revealNode,
      revealBackendNode,
      updatePaneItem,
      paneItems,
      openPanes,
      focusedPane,
      focusNonce,
      focusedNodeId,
      setFocusedNodeId,
      viewMode,
      openPane,
      openPaneInTree,
      closePane,
      focusPane,
      zoomPane,
      reorderPane,
      setViewMode,
      selection,
      toggleSelection,
      clearSelection,
      createThread,
      archiveTree,
      unarchiveTree,
      pinTree,
      unpinTree,
      pinProject,
      unpinProject,
      renameTree,
      deleteTree,
      activateTree,
      moveTreeToWorkspace,
      createContext,
      updateContext,
      deleteContext,
      pinContext,
      resolvePermission,
      denyPermission,
      resolveUserInputRequest,
      skipUserInputRequest,
      hydrated,
      treeSelection,
      toggleTreeSelection,
      clearTreeSelection,
      selectAllTrees,
      selectTrees,
      bulkArchiveTrees,
      bulkDeleteTrees,
      bulkUnarchiveTrees,
      searchHighlightTerm,
      setSearchHighlightTerm,
      addPendingComment,
      editPendingComment,
      removePendingComment,
      clearPendingComments,
      steerMessage,
      queueMessage,
      dequeueMessage,
      flushQueue,
      markQueueErrored,
      unreadFilterOn,
      setUnreadFilterOn,
      markAllRead,
      renameNode,
      pinNode,
      unpinNode,
    }),
    [
      projects,
      activeProjectId,
      activeProject,
      theme,
      toggleTheme,
      createProject,
      enterChatsWorkspace,
      renameProject,
      setProjectCwd,
      addFolder,
      removeFolder,
      updateFolderLabel,
      setProjectInstructions,
      deleteProject,
      restoreProject,
      purgeProject,
      archiveProject,
      unarchiveProject,
      selectProject,
      sendMessage,
      setChatPermissionMode,
      setChatUltracode,
      retryLastTurn,
      rerunLastTurn,
      resumeLastTurn,
      editAndResend,
      createChildChat,
      createBlankChild,
      createMergedChat,
      cancelStream,
      availableModes,
      defaultModeId,
      agentModesLoading,
      agentModesError,
      retryAgentModes,
      agentStatus,
      agentStatusUnreachable,
      warmFailedError,
      refreshAgentStatus,
      switchAgent,
      deleteNode,
      trimNode,
      extractNodeTree,
      archiveNode,
      restoreLastDeletion,
      restoreDeletion,
      moveDeletionGroupLane,
      purgeDeletion,
      purgeDeletionAsync,
      emptyTrash,
      emptyTrashAsync,
      setMinimized,
      setPaneWidth,
      setNodePosition,
      resetLayout,
      fanoutBranches,
      openPanesSideBySide,
      linkNodes,
      unlinkNodes,
      createDigest,
      refreshDigest,
      setDigestPrompt,
      markDigestViewed,
      setComposerDraft,
      deleteDigest,
      openArtifactPane,
      openLauncherPane,
      activateLauncherPane,
      adoptTerminalPane,
      adoptBackendTerminal,
      openNodeInLauncherPane,
      openFilePane,
      openBrowserPane,
      openAgentRunPane,
      openPagePane,
      revealNode,
      revealBackendNode,
      updatePaneItem,
      paneItems,
      openPanes,
      focusedPane,
      focusNonce,
      focusedNodeId,
      setFocusedNodeId,
      viewMode,
      openPane,
      openPaneInTree,
      closePane,
      focusPane,
      zoomPane,
      reorderPane,
      setViewMode,
      selection,
      toggleSelection,
      clearSelection,
      createThread,
      archiveTree,
      unarchiveTree,
      pinTree,
      unpinTree,
      pinProject,
      unpinProject,
      renameTree,
      deleteTree,
      activateTree,
      moveTreeToWorkspace,
      createContext,
      updateContext,
      deleteContext,
      pinContext,
      resolvePermission,
      denyPermission,
      resolveUserInputRequest,
      skipUserInputRequest,
      hydrated,
      treeSelection,
      toggleTreeSelection,
      clearTreeSelection,
      selectAllTrees,
      selectTrees,
      bulkArchiveTrees,
      bulkDeleteTrees,
      bulkUnarchiveTrees,
      searchHighlightTerm,
      setSearchHighlightTerm,
      addPendingComment,
      editPendingComment,
      removePendingComment,
      clearPendingComments,
      steerMessage,
      queueMessage,
      dequeueMessage,
      flushQueue,
      markQueueErrored,
      unreadFilterOn,
      setUnreadFilterOn,
      markAllRead,
      renameNode,
      pinNode,
      unpinNode,
    ],
  );

  const hotActions = useMemo<ExtendedChatActionsValue>(
    () => ({
      loadOlderMessages,
      ensureCompleteHistory,
      catchUpNodes,
      createProject,
      enterChatsWorkspace,
      selectProject,
      renameProject,
      archiveProject,
      unarchiveProject,
      deleteProject,
      sendMessage,
      setChatPermissionMode,
      setChatUltracode,
      retryLastTurn,
      rerunLastTurn,
      resumeLastTurn,
      editAndResend,
      createChildChat,
      createBlankChild,
      createMergedChat,
      fanoutBranches,
      openPanesSideBySide,
      switchAgent,
      cancelStream,
      deleteNode,
      trimNode,
      extractNodeTree,
      archiveNode,
      setMinimized,
      setPaneWidth,
      openPane,
      openPaneInTree,
      closePane,
      focusPane,
      zoomPane,
      toggleSelection,
      clearSelection,
      restoreLastDeletion,
      createThread,
      archiveTree,
      unarchiveTree,
      pinTree,
      unpinTree,
      pinProject,
      unpinProject,
      renameTree,
      deleteTree,
      activateTree,
      moveTreeToWorkspace,
      toggleTreeSelection,
      clearTreeSelection,
      selectAllTrees,
      selectTrees,
      bulkArchiveTrees,
      bulkDeleteTrees,
      setFocusedNodeId,
      createDigest,
      resolvePermission,
      denyPermission,
      resolveUserInputRequest,
      skipUserInputRequest,
      addPendingComment,
      editPendingComment,
      removePendingComment,
      clearPendingComments,
      steerMessage,
      queueMessage,
      dequeueMessage,
      setComposerDraft,
      createContext,
      reorderPane,
      openArtifactPane,
      openLauncherPane,
      activateLauncherPane,
      adoptTerminalPane,
      adoptBackendTerminal,
      openNodeInLauncherPane,
      openFilePane,
      openBrowserPane,
      openAgentRunPane,
      openPagePane,
      revealNode,
      revealBackendNode,
      updatePaneItem,
      setUnreadFilterOn,
      markAllRead,
      renameNode,
      pinNode,
      unpinNode,
      dispatch,
      installWorkspaceSnapshot,
    }),
    [
      loadOlderMessages,
      ensureCompleteHistory,
      catchUpNodes,
      installWorkspaceSnapshot,
      createProject,
      enterChatsWorkspace,
      selectProject,
      renameProject,
      archiveProject,
      unarchiveProject,
      deleteProject,
      sendMessage,
      setChatPermissionMode,
      setChatUltracode,
      retryLastTurn,
      rerunLastTurn,
      resumeLastTurn,
      editAndResend,
      createChildChat,
      createBlankChild,
      createMergedChat,
      fanoutBranches,
      openPanesSideBySide,
      switchAgent,
      cancelStream,
      deleteNode,
      trimNode,
      extractNodeTree,
      archiveNode,
      setMinimized,
      setPaneWidth,
      openPane,
      openPaneInTree,
      closePane,
      focusPane,
      zoomPane,
      toggleSelection,
      clearSelection,
      restoreLastDeletion,
      createThread,
      archiveTree,
      unarchiveTree,
      pinTree,
      unpinTree,
      pinProject,
      unpinProject,
      renameTree,
      deleteTree,
      activateTree,
      moveTreeToWorkspace,
      toggleTreeSelection,
      clearTreeSelection,
      selectAllTrees,
      selectTrees,
      bulkArchiveTrees,
      bulkDeleteTrees,
      setFocusedNodeId,
      createDigest,
      resolvePermission,
      denyPermission,
      resolveUserInputRequest,
      skipUserInputRequest,
      addPendingComment,
      editPendingComment,
      removePendingComment,
      clearPendingComments,
      steerMessage,
      queueMessage,
      dequeueMessage,
      setComposerDraft,
      createContext,
      reorderPane,
      openArtifactPane,
      openLauncherPane,
      activateLauncherPane,
      adoptTerminalPane,
      adoptBackendTerminal,
      openNodeInLauncherPane,
      openFilePane,
      openBrowserPane,
      openAgentRunPane,
      openPagePane,
      revealNode,
      revealBackendNode,
      updatePaneItem,
      setUnreadFilterOn,
      markAllRead,
      renameNode,
      pinNode,
      unpinNode,
      dispatch,
    ],
  );

  return (
    <ChatNodeStoreContext.Provider value={nodeStore}>
      <ChatProjectsContext.Provider value={projectsValue}>
        <ChatPaneContext.Provider value={paneValue}>
          <ChatActionsContext.Provider value={hotActions}>
            <TreePrefetchContext.Provider value={prefetchTreeForNode}>
              <NodeMessagesContext.Provider value={ensureNodeMessages}>
                <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
              </NodeMessagesContext.Provider>
            </TreePrefetchContext.Provider>
          </ChatActionsContext.Provider>
        </ChatPaneContext.Provider>
      </ChatProjectsContext.Provider>
    </ChatNodeStoreContext.Provider>
  );
}

export function useChatStore(): ExtendedChatContextValue {
  const v = useContext(ChatContext);
  if (!v) throw new Error('useChatStore must be used within ChatProvider');
  return v;
}

export function useOptionalChatActions(): ExtendedChatActionsValue | null {
  return useContext(ChatActionsContext);
}

export function useChatActions(): ExtendedChatActionsValue {
  const v = useOptionalChatActions();
  if (!v) throw new Error('useChatActions must be used within ChatProvider');
  return v;
}


export function useChatProjects(): ChatProjectsValue {
  const v = useContext(ChatProjectsContext);
  if (!v) throw new Error('useChatProjects must be used within ChatProvider');
  return v;
}

/** Optional workspace slice for components that also render in isolated/provider-free contexts. */
export function useOptionalChatProjects(): ChatProjectsValue | null {
  return useContext(ChatProjectsContext);
}

/**
 * Pane-layout slice: `openPanes`, `paneItems`, `focusedPane`, `focusNonce`,
 * `viewMode`. Separated from {@link useChatProjects} so sidebar rows and
 * other structural consumers don't re-render on every pane-focus click.
 * Only components that truly need the pane layout should call this hook.
 */
export function useChatPanes(): ChatPaneValue {
  const v = useContext(ChatPaneContext);
  if (!v) throw new Error('useChatPanes must be used within ChatProvider');
  return v;
}

/**
 * Returns the current structural-version counter from the node store.
 * The value bumps on every non-HIGH_FREQ_ACTIONS dispatch and stays still
 * during streaming, so consumers can render at structural rhythm without
 * being woken up by per-token chunk/heartbeat traffic.
 *
 * Subscribes via `useSyncExternalStore` against the dedicated structural
 * channel; the consuming component re-renders whenever the version
 * advances — independently of the parent `setNodes` re-render. For data
 * selection, prefer {@link useStructuralSelector}; this raw hook is mainly
 * useful for debug overlays or "no-op during streaming" gates.
 */
export function useStructureVersion(): number {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useStructureVersion must be used within ChatProvider');
  return useSyncExternalStore(
    store.subscribeStructure,
    store.getStructureVersion,
    store.getStructureVersion,
  );
}

export function useChatNode(nodeId: string): ChatNodeState | undefined {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useChatNode must be used within ChatProvider');
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeNode(nodeId, listener),
    [store, nodeId],
  );
  const getSnapshot = useCallback(
    () => store.getNode(nodeId),
    [store, nodeId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Reads a node as the store holds it at call time (each dispatch updates it
 * synchronously), without subscribing: for decisions made in event handlers
 * and store listeners that must see an edit the last render hasn't shown.
 */
export function useChatNodeReader(): (nodeId: string) => ChatNodeState | undefined {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useChatNodeReader must be used within ChatProvider');
  return store.getNode;
}

export function useChatNodesSnapshot(): Record<string, ChatNodeState> {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useChatNodesSnapshot must be used within ChatProvider');
  return store.getNodes();
}

/**
 * Subscribe to a derived value computed from the full nodes map. Re-renders
 * only when the selector's output changes per `equalityFn` (default: `Object.is`).
 *
 * Use for whole-map derived values (counts, filtered arrays, tree walks).
 * For a single node prefer `useChatNode(id)`. For non-reactive lookups
 * inside callbacks prefer `useChatNodesSnapshot()`.
 *
 * @remarks Selector and equality functions are read via refs each call, so
 * passing inline lambdas that close over per-render variables is fine — the
 * hook re-runs the selector when its identity changes. Memoizing the selector
 * (with `useCallback`) is still beneficial: it lets the hook keep the cached
 * value when nothing relevant changed, avoiding redundant selector invocations.
 */
export function useNodesSelector<T>(
  selector: (nodes: Record<string, ChatNodeState>) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useNodesSelector must be used within ChatProvider');

  // Hold the latest selector / equalityFn in refs so a stable getSnapshot
  // reads the most recent versions. Pattern mirrors react-redux `useSelector`.
  const selectorRef = useRef(selector);
  const equalityRef = useRef(equalityFn);

  // If the selector identity changed since the last render, blow away the
  // cached result so the new selector runs on the next snapshot read.
  // Without this, when callers pass per-render closures whose captures
  // changed but the nodes ref hasn't flipped, the cache short-circuit at
  // `last.nodes === nodes` would return the old selector's stale result.
  const lastRef = useRef<{ value: T; nodes: Record<string, ChatNodeState> } | null>(null);
  if (selectorRef.current !== selector) {
    lastRef.current = null;
  }
  selectorRef.current = selector;
  equalityRef.current = equalityFn;

  const getSnapshot = useCallback(() => {
    const nodes = store.getNodes();
    const last = lastRef.current;
    if (last && last.nodes === nodes) return last.value;
    const value = selectorRef.current(nodes);
    if (last && equalityRef.current(last.value, value)) {
      lastRef.current = { value: last.value, nodes };
      return last.value;
    }
    lastRef.current = { value, nodes };
    return value;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/**
 * Like {@link useNodesSelector}, but its `getSnapshot` cache is keyed on the
 * store's structure version rather than the nodes-map reference. Streamed-
 * token commits keep the version still, so the selector body is NOT executed
 * each frame for the duration of a stream.
 *
 * Use this for selectors that read only structural fields (status, kind,
 * title, deletedAt/pinnedAt, markedReadAt/seenMessageIds, paneWidth, digest,
 * project edges) — never message text or block content. The
 * HIGH_FREQ_ACTIONS structural invariant (chatReducers.structural.test.ts)
 * guarantees those fields cannot change without advancing the version.
 *
 * @remarks For the version cache to short-circuit correctly, the selector
 * identity must be stable across renders. Wrap inline lambdas with
 * `useCallback` (or define them outside the component). If the selector
 * identity changes, the cache is cleared and the selector re-runs once.
 */
export function useStructuralSelector<T>(
  selector: (nodes: Record<string, ChatNodeState>) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useStructuralSelector must be used within ChatProvider');

  const selectorRef = useRef(selector);
  const equalityRef = useRef(equalityFn);

  const lastRef = useRef<{ value: T; version: number } | null>(null);
  if (selectorRef.current !== selector) {
    // Per-render closures break the version cache; blow away cached result so
    // the new selector runs on the next snapshot read.
    lastRef.current = null;
  }
  selectorRef.current = selector;
  equalityRef.current = equalityFn;

  const getSnapshot = useCallback(() => {
    const version = store.getStructureVersion();
    const last = lastRef.current;
    // Safe: HIGH_FREQ_ACTIONS cannot mutate structural fields, so same version
    // implies the selector output is unchanged. See chatReducers.structural.test.ts.
    if (last && last.version === version) return last.value;
    const value = selectorRef.current(store.getNodes());
    if (last && equalityRef.current(last.value, value)) {
      lastRef.current = { value: last.value, version };
      return last.value;
    }
    lastRef.current = { value, version };
    return value;
  }, [store]);

  return useSyncExternalStore(store.subscribeStructure, getSnapshot, getSnapshot);
}

/** Shallow array equality — convenience for `useNodesSelector` outputs that are arrays. */
export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Derive a short label for a chat node from its first user message. */
export function chatLabel(chat: ChatNodeState | undefined): string {
  if (!chat) return 'new thread';
  const first = chat.messages.find((m) => m.role === 'user');
  if (!first) return 'New thread';
  return deriveConversationTitle(first.text) ?? '';
}

/** Cross-project chat enumeration entry — used by the ⌘K palette and global search. */
export interface AllChatEntry {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
}

/**
 * Enumerate every non-deleted chat across every project. Foundation for cross-project
 * surfaces (⌘K palette, global search). Returned unsorted — surfaces apply their own
 * ordering (Task 3 will add recency sort once a `lastInteractedAt` field lands on
 * ChatNodeState; today the field doesn't exist).
 */
export function selectAllChats(state: {
  projects: Project[];
  nodes: Record<string, ChatNodeState>;
}): AllChatEntry[] {
  const out: AllChatEntry[] = [];
  for (const project of state.projects) {
    for (const chatId of project.chatIds) {
      const node = state.nodes[chatId];
      if (!node) continue;
      if (node.deletedAt || !isVisibleConversationNode(node)) continue;
      out.push({
        id: chatId,
        title: node.title?.trim() || chatLabel(node),
        projectId: project.id,
        projectName: project.name,
      });
    }
  }
  return out;
}
