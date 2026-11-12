import { sessionModeCatalog } from '../../state/sessionModeCatalog';
import { turnErrorAction } from '../../state/turnErrorRecovery';
import { ChatCommandResult } from './ChatCommandResult';
import { effectiveChatPermissionChoice, usePermissionPreferences } from '../../hooks/usePermissionPreferences';
import { backendConnectionIdForWorkspace, LOCAL_BACKEND_CONNECTION_ID, workspaceBackendApiBase } from '../../config/backendConnections';
import { ComposerPermissionControl } from './ComposerPermissionControl';
import { ConversationMemoryControl } from './ConversationMemoryControl';
import { approveForMeRuntimeIds } from '../../lib/chatPermissionModes';
import { mergeContextQuote } from '../../state/assistant/assistantContext';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { DUR, EASE, KEYBOARD_MOVE } from '../../motion/tokens';
import { useChatActions, useChatNode, useChatPanes, useChatProjects, useStructuralSelector, shallowArrayEqual, chatLabel } from '../../state/chatStore';
import type { ChatNodeState, ArtifactEntry, ProjectEdge } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { stripBranchPrefix, parseFanoutCommand, shouldBranchOnSubmit } from '../nodes/chatNodeUtils';
import SelectionActions, { findMessageIdForRange } from '../SelectionActions';
import { DOCK_ROOM_VAR } from '../selectionDockRoom';
import type { MentionEditorHandle } from '../MentionEditor';
import LazyMentionEditor from '../LazyMentionEditor';
import { spaceBeforeMention } from '../mentionSpacing';
import type { MentionRecord } from '../mentions';
import { expandMentions } from '../mentions';
import { findTreeIdForNode } from '../../state/tree';
import { collectCrossTreeGroups, EMPTY_CROSS_TREE_GROUPS as EMPTY_CROSS_TREE_NODES } from '../crossTreeMentions';
import { ATTACHED_QUOTE_SOURCE, formatQuotedMessage, type AnyQuoteSource } from '../../lib/quoteFormat';
import { buildAnchorMap, type ChildAnchor } from '../../state/branchAnchors';
import { formatCommentsBlock, joinMessageParts } from '../../lib/commentFormat';
import { getElectron } from '../../lib/electronBridge';
import { useComposerAttachments } from './useComposerAttachments';
import { registerPaneFileDropTarget } from './paneFileDropTargets';
import { isFileDrag, useFileDropZone } from './useFileDropZone';
import { openArtifact, showArtifactInDrawer } from './artifacts/artifactOpen';
import { toast } from 'sonner';
import { fetchAssistant, updateAssistantSettings, type AssistantSettingsPatch } from '../../services/api/assistant';
import { adoptCompanionAssistant, getCompanionAssistant } from '../../state/companion/companionStore';
import { appendAttachmentsSentinel } from '../../lib/composerAttachments';
import { checkRuntimeHealth } from '../../services/api';
import { companionPostRunId, shouldSteerInsteadOfQueue } from 'michi-shared';
import { useRuntimeCatalog } from '../../hooks/useRuntimeCatalog';
import { resolveNodeBinding, type PendingNodeBindingOverride } from '../../state/nodeBindingResolution';
import { useRuntimeLabel, useSkillCatalog } from '../../state/skillCatalog';
import { buildSlashEntries, keepsSlashPick, liveSlashCommands, pickedSlashEntry, resolveSlashRun, type SlashPick } from '../../state/slashEntries';
import type { CreateChildChatOptions, PendingComment, SendBindingMeta, UserSendMeta } from '../../state/chatTypes';
import { appendComposerLine, mergeComposerDraft, prependToDraft } from '../../state/composerDraft';
import UploadProgressBar from '../UploadProgressBar';
import PermissionBanner from './PermissionBanner';
import MergeBanner from './MergeBanner';
import PaneFind from './PaneFind';
import { flashMatchOverlay } from './paneFindMatches';
import { ComposerShell, type ComposerShellHandle } from './ComposerShell';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { useHoldScrollOnKeyboard } from '../../hooks/useHoldScrollOnKeyboard';
import { blurWithin, useDismissKeyboardOnDrag } from '../../hooks/useDismissKeyboardOnDrag';
import { PaneMessageList } from './PaneMessageList';
import { failedPlanStep, useMultiModelBranch } from './multiModelBranch';
import { TranscriptScrubber } from './TranscriptScrubber';
import { PaneComposerPreBlocks, type PanePendingAttachment } from './PaneComposerPreBlocks';
import { PaneComposerActions, type PaneComposerSendMode } from './PaneComposerActions';
import { PaneComposerToolbarLeft, type PaneMenuAnchor } from './PaneComposerToolbarLeft';
import { ComposerModelTrigger } from './ComposerModelTrigger';
import { resolveComposerReasoning } from './composerReasoning';
import { PaneAgentMenus } from './PaneAgentMenus';
import { FileDropOverlay, PaneDropIndicator } from './PaneDragOverlays';
import { nextFollowScrollTop } from './scrollPinning';
import { glideToTail } from './sendScroll';
import { prefersReducedMotion } from '../../hooks/useReducedMotion';
import { claimSourceJump, useSourceJump } from '../../state/sourceNav/sourceNav';
import { useRunningClaudeWorkflow } from '../../state/workflowDomain';
import { DARK_PALETTES } from './tokens';
import { focusIsTaken } from './escapeLayers';
import {
  noteAssistantContextSent,
  pendingAssistantContext,
  takeAssistantSends,
  useAssistantPendingSends,
} from '../../state/assistant/assistantComposer';
import { isSystemWorkspace } from '../../state/assistant/systemWorkspace';
import { assistantComposerBinding } from '../../state/assistant/assistantBinding';
import { useCompanionAssistantInfo } from '../../state/companion/companionStore';
import { noteCompanionPostReply } from '../../state/companion/companionReply';
import type { AssistantConversationSource } from '../../state/assistant/assistantSource';
import * as perf from '../../services/perf';

// Shared module-level flag flipped by the Sidebar's `michi:sidebar-animating`
// event. While true, every pane skips ResizeObserver-driven reflow work so
// the sidebar's width transition stays smooth even with many tabs open.
// Each pane registers a flush callback that runs once when the flag clears.
const sidebarAnimatingRef = { current: false };
const animationEndCallbacks = new Set<() => void>();
const PROGRAMMATIC_SCROLL_WINDOW_MS = 800;
const USER_SCROLL_INTENT_WINDOW_MS = 1200;
/** How close to the top of the loaded page, in viewport heights, the next older page loads. */
const OLDER_PREFETCH_VIEWPORTS = 1.5;
/** A send's message lands within this of the send; a glide later than that is not the keyboard send's. */
const KEYBOARD_SEND_WINDOW_MS = 1000;
/** How long a click in the transcript may still turn out to open or close something. */
const USER_CLICK_LAYOUT_WINDOW_MS = 300;
/** How long tail-following outlasts a stream, while the finished answer settles. */
const TAIL_SETTLE_MS = 400;

/** The transcript and the clicked message as they were when a click landed. */
interface UserClickLayout {
  scrollHeight: number;
  block: HTMLElement | null;
  blockHeight: number;
}

/**
 * A click changed the layout when the message it landed in changed height
 * (or it landed outside one). Output streaming into another message within
 * the click's window is still output to follow: a Copy during a reply keeps
 * the pane tailing it.
 */
function clickChangedLayout(click: UserClickLayout): boolean {
  if (!click.block || !click.block.isConnected) return true;
  return click.block.offsetHeight !== click.blockHeight;
}

/** A sent message keeps its key when realign-assistant-id renames it. */
function sentMessageKey(message: { id: string; clientKey?: string }): string {
  return message.clientKey ?? message.id;
}
// Mount-time scroll restore: the target is re-derived from the anchor's live
// rect and re-applied every time the content's size changes — the container
// sets overflow-anchor:none, so nothing else compensates when
// content-visibility inflation (72px estimates → real heights), composer
// measurement or image loads shift the content under the viewport. The
// restore holds the anchor until the layout has been quiet for QUIET_MS
// (hard cap MAX_MS), or the user scrolls.
const RESTORE_QUIET_MS = 350;
const RESTORE_MAX_MS = 3000;

// Persists per-pane scroll anchors across pane unmount/remount AND page
// refresh. Backed by localStorage with an LRU cap so it doesn't grow
// unbounded.
//
// Entries are message anchors, NOT pixel scrollTops: message frames render
// with content-visibility:auto (72px intrinsic-size estimates until they come
// near the viewport), so scrollHeight right after mount bears no relation to
// the layout a pixel offset was measured under — restoring one lands on an
// arbitrary message, usually clamped toward the top. An anchor id survives
// the estimate → real-height inflation.
const SCROLL_CACHE_LS_KEY = 'michi:paneScrollAnchors';
const SCROLL_CACHE_MAX_ENTRIES = 200;

export interface PaneScrollEntry {
  /** data-msg-id of the topmost visible message when the pane was left. */
  anchorId: string | null;
  /** anchor top − viewport top at save time, px (≤ 0 when the viewport sat partway into the anchor message). */
  offset: number;
  /** Pane was left pinned within 24px of the bottom (and not mid-stream). */
  atBottom: boolean;
  /**
   * Max message createdAt present when the pane was left. Messages newer
   * than this landed after the user last had the pane open — the unread
   * horizon. Deliberately independent of node.viewedAt, which activateTree
   * resets to Date.now() in the same click that opens the pane, before the
   * pane can read it.
   */
  lastSeen: number;
}

/**
 * Where the first unseen message sits after an unread restore, as a fraction
 * of the viewport height from the top — upper-middle, so what the reader
 * missed starts high enough to read on from.
 */
const UNSEEN_TOP_FRACTION = 0.3;

export interface PaneRestoreTarget {
  /**
   * unseen — anchorId is the first message newer than the saved lastSeen
   *          horizon; park it at UNSEEN_TOP_FRACTION of the viewport height
   *          (offset is unused and 0).
   * bottom — pin to the bottom (first visit on this device, left-at-bottom,
   *          or no unseen messages).
   */
  kind: 'unseen' | 'bottom';
  anchorId?: string;
  offset: number;
}

/**
 * Decide where a freshly-mounted idle pane should land, from the anchor
 * entry saved when it was last left and the node's current messages.
 * Returns null when there is nothing to position over (no messages).
 *
 * Two outcomes: unseen (messages arrived after the user last saw this
 * pane → park at first unseen) or bottom (everything else).
 */
export function resolvePaneRestore(
  saved: PaneScrollEntry | undefined,
  messages: readonly { id: string; createdAt?: number }[],
): PaneRestoreTarget | null {
  if (messages.length === 0) return null;
  if (saved && saved.lastSeen > 0) {
    const firstUnseen = messages.find((m) => (m.createdAt ?? 0) > saved.lastSeen);
    if (firstUnseen) return { kind: 'unseen', anchorId: firstUnseen.id, offset: 0 };
  }
  return { kind: 'bottom', offset: 0 };
}

const paneScrollCache = (() => {
  const map = new Map<string, PaneScrollEntry>();

  // Hydrate from localStorage on startup
  try {
    // Drop the pre-anchor pixel cache from earlier builds.
    window.localStorage.removeItem('michi:paneScrollPositions');
    const raw = window.localStorage.getItem(SCROLL_CACHE_LS_KEY);
    if (raw) {
      const entries: [string, PaneScrollEntry][] = JSON.parse(raw);
      for (const [k, v] of entries) {
        if (v && typeof v === 'object' && typeof v.lastSeen === 'number') map.set(k, v);
      }
    }
  } catch { /* corrupt or missing — start fresh */ }

  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    flushTimer = null;
    // Keep only the most recent entries (Map iteration = insertion order)
    const entries = [...map.entries()];
    const trimmed = entries.slice(-SCROLL_CACHE_MAX_ENTRIES);
    try {
      window.localStorage.setItem(SCROLL_CACHE_LS_KEY, JSON.stringify(trimmed));
    } catch { /* quota — non-critical */ }
  }

  function scheduleFlush() {
    if (flushTimer == null) flushTimer = setTimeout(flush, 1000);
  }

  // pagehide rather than beforeunload: panes write their final anchor on
  // beforeunload, which fires first — flushing here catches those writes.
  window.addEventListener('pagehide', () => {
    if (flushTimer != null) { clearTimeout(flushTimer); flush(); }
  });

  return {
    get(key: string) { return map.get(key); },
    set(key: string, value: PaneScrollEntry) {
      map.delete(key); // reinsert at end for LRU ordering
      map.set(key, value);
      scheduleFlush();
    },
  };
})();
const PANE_PERF_SLOW_COMMIT_MS = 16;
// The floating composer card is pinned this far above the pane's bottom edge
// (ComposerShell's `bottom: 12` on the absolute position style).
const COMPOSER_BOTTOM_INSET = 12;
// Breathing room between the last line of transcript content and the top edge
// of the composer card. The transcript reserves the card height plus the inset
// plus this gap, and tail-following uses the same sum, so
// the last line always comes to rest clear of the card instead of hugging it.
const COMPOSER_TAIL_GAP = 28;
const COMPOSER_CLEARANCE = COMPOSER_BOTTOM_INSET + COMPOSER_TAIL_GAP;
// Phone: the opaque strip under the card fades out this far above its top.
// Kept below COMPOSER_TAIL_GAP so content at rest at the end is never dimmed.
const COMPOSER_TOP_FADE = 24;
const EMPTY_CONTEXTS: ArtifactEntry[] = [];
const EMPTY_EDGES: readonly ProjectEdge[] = [];
const EMPTY_SAME_TREE_NODES: ChatNodeState[] = [];
const EMPTY_MERGE_SOURCE_LABELS: string[] = [];
const EMPTY_CONTEXT_NAMES: ReadonlySet<string> = new Set();

function anchorEqual(a: ChildAnchor, b: ChildAnchor): boolean {
  return (
    a.childNodeId === b.childNodeId &&
    a.title === b.title &&
    (a.messageCount ?? 0) === (b.messageCount ?? 0) &&
    a.createdAt === b.createdAt &&
    a.status === b.status &&
    (a.quotedText ?? '') === (b.quotedText ?? '') &&
    (a.question ?? '') === (b.question ?? '') &&
    (a.reply ?? '') === (b.reply ?? '')
  );
}

function anchorMapEqual(a: Map<string, ChildAnchor[]>, b: Map<string, ChildAnchor[]>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [messageId, prevAnchors] of a) {
    const nextAnchors = b.get(messageId);
    if (!nextAnchors || prevAnchors.length !== nextAnchors.length) return false;
    for (let i = 0; i < prevAnchors.length; i += 1) {
      if (!anchorEqual(prevAnchors[i], nextAnchors[i])) return false;
    }
  }
  return true;
}
if (typeof window !== 'undefined') {
  window.addEventListener('michi:sidebar-animating', (e) => {
    const animating = (e as CustomEvent<{ animating: boolean }>).detail.animating;
    sidebarAnimatingRef.current = animating;
    if (!animating) {
      // Flush queued resize-driven work after the next paint so the layout has
      // settled to its final width before observers re-measure.
      requestAnimationFrame(() => {
        for (const cb of animationEndCallbacks) cb();
      });
    }
  });
}

type ComposerDraftState = { value: string; mentions: MentionRecord[] };

const EMPTY_COMPOSER_DRAFT: ComposerDraftState = { value: '', mentions: [] };

function messageRenderStats(node: ChatNodeState | undefined) {
  if (!node) return { messages: 0, chars: 0, codeFences: 0 };
  let chars = 0;
  let codeFences = 0;
  for (const m of node.messages) {
    chars += m.text?.length ?? 0;
    codeFences += (m.text?.match(/```/g)?.length ?? 0) / 2;
    for (const b of m.blocks ?? []) {
      if (b.kind !== 'answer' && b.kind !== 'thinking') continue;
      chars += b.rawText.length;
      codeFences += (b.rawText.match(/```/g)?.length ?? 0) / 2;
    }
  }
  return {
    messages: node.messages.length,
    chars,
    codeFences: Math.floor(codeFences),
  };
}

function TPane({ nodeId, contentMaxWidth, embedded = false, draftRequest = null, composerPreBlocks, composerFocusToken = 0, composerDisabled = false, spacesAssistant = false, assistantSource, readOnly = false, permissionControl = true }: {
  nodeId: string;
  contentMaxWidth?: number | null;
  /** Rendered outside the pane grid (the ⌘J assistant panel): clicks and
   *  drops must not open or focus the node as a pane in the current slot. */
  embedded?: boolean;
  /** Explicit user-authorized draft request; populates the composer without submitting. */
  draftRequest?: { id: number; text: string } | null;
  composerPreBlocks?: React.ReactNode | ((draftHasText: boolean) => React.ReactNode);
  composerFocusToken?: number;
  composerDisabled?: boolean;
  /** Spaces reuses the complete chat composer; its model picker updates the Meta agent settings. */
  spacesAssistant?: boolean;
  /**
   * Where this window's assistant conversation lives (the Scheduled window);
   * the global assistant store when absent (Spaces, the ⌘J panel).
   */
  assistantSource?: AssistantConversationSource;
  /**
   * A transcript to read, not continue (a Scheduled-only run on the Scheduled
   * page): no composer, selection actions or message actions. A pending
   * approval and an ask_user question can still be answered.
   */
  readOnly?: boolean;
  /**
   * false: the composer has no permission chip, for a conversation whose
   * every tool runs without an approval (the Companion's closed toolset).
   */
  permissionControl?: boolean;
}) {
  const renderStartedAt = perf.enabled() ? perf.now() : 0;
  const {
    focusPane,
    closePane,
    sendMessage,
    retryLastTurn,
    rerunLastTurn,
    editAndResend,
    cancelStream,
    setChatPermissionMode,
    setChatUltracode,
    createChildChat,
    createBlankChild,
    fanoutBranches,
    setFocusedNodeId,
    switchAgent,
    resolvePermission,
    addPendingComment,
    editPendingComment,
    removePendingComment,
    clearPendingComments,
    queueMessage,
    steerMessage,
    dequeueMessage,
    setComposerDraft,
    reorderPane,
    openArtifactPane,
    revealNode,
    loadOlderMessages,
    catchUpNodes,
    dispatch,
  } = useChatActions();
  // An opened pane checks its thread against SQLite once (chatStore's catch-up).
  useEffect(() => {
    catchUpNodes?.([nodeId]);
  }, [catchUpNodes, nodeId]);
  const {
    availableModes: defaultAvailableModes,
    defaultModeId,
    agentModesLoading,
    agentModesError,
    retryAgentModes,
    agentStatus,
    refreshAgentStatus,
    activeProject: shellActiveProject,
    projects,
  } = useChatProjects();
  const { focusedPane } = useChatPanes();
  const { prefs } = usePrefs();
  // Never dimmed as an unfocused pane when embedded: it isn't one of the grid's panes.
  const paneShellStyle = usePaneShellStyle(nodeId, { dim: !embedded });
  const n = useChatNode(nodeId);
  const activeProject = embedded && n
    ? projects?.find((project) => project.id === n.projectId) ?? shellActiveProject
    : shellActiveProject;
  const claudeWorkflowRunning = useRunningClaudeWorkflow(nodeId);
  // The ⌘J assistant's conversation (in the panel, or as a pane of its hidden
  // workspace) never branches: a branch would land where no list shows it.
  // Branch and fan-out sends go to the conversation itself.
  const nodeProjectId = n?.projectId;
  const isAssistantConversation = useMemo(
    () => embedded || isSystemWorkspace(projects?.find((p) => p.id === nodeProjectId)),
    [embedded, nodeProjectId, projects],
  );
  const branchesOff = isAssistantConversation;
  // The assistant's conversation has no attachments in a pane; the <name> panel's composer (spacesAssistant) has them.
  const attachmentRestricted = isAssistantConversation && !spacesAssistant;
  const globalAssistantInfo = useCompanionAssistantInfo();
  const assistantInfo = assistantSource ? assistantSource.info : globalAssistantInfo;
  const assistantSourceRef = useRef(assistantSource);
  assistantSourceRef.current = assistantSource;
  const availableModes = sessionModeCatalog(n?.sessionState, defaultAvailableModes, agentStatus?.runtime);
  const permissionPreferences = usePermissionPreferences(n ? workspaceBackendApiBase(n.projectId) : undefined);
  // Latest node state for callbacks that outlive their render closure — the
  // unmount-time scroll save reads messages through this.
  const nLatestRef = useRef(n);
  nLatestRef.current = n;
  const hasCommittedRef = useRef(false);
  useEffect(() => {
    if (!perf.enabled()) return;
    const phase = hasCommittedRef.current ? 'pane:commit' : 'pane:mount_commit';
    const durationMs = perf.now() - renderStartedAt;
    if (!hasCommittedRef.current || durationMs >= PANE_PERF_SLOW_COMMIT_MS) {
      const stats = messageRenderStats(n);
      perf.measure(phase, renderStartedAt, {
        nodeId,
        kind: n?.kind,
        status: n?.status,
        messages: stats.messages,
        chars: stats.chars,
        codeFences: stats.codeFences,
      });
    }
    hasCommittedRef.current = true;
  });
  const draft = useMemo<ComposerDraftState>(
    () => n?.composerDraft
      ? { value: n.composerDraft.value, mentions: n.composerDraft.mentions as MentionRecord[] }
      : EMPTY_COMPOSER_DRAFT,
    [n?.composerDraft],
  );
  const quotedText = n?.composerDraft?.quotedText ?? null;
  const quoteSource = n?.composerDraft?.quoteSource;
  // Store writes are RAF-coalesced, so the render snapshot can trail the
  // TipTap transaction that immediately precedes Enter / a toolbar click.
  // Keep a synchronous source of truth for submit and quote composition.
  const latestDraftRef = useRef<ComposerDraftState>(draft);
  const latestQuotedTextRef = useRef<string | null>(quotedText);
  const latestQuoteSourceRef = useRef<AnyQuoteSource | undefined>(quoteSource);
  // The full draft stays RAF-coalesced, but the primary action must flip
  // immediately between disabled / Send / Send next / Stop. Updating this
  // boolean only on empty↔non-empty transitions avoids per-keystroke renders.
  const [draftHasText, setDraftHasText] = useState(() => draft.value.trim().length > 0);
  const [steeringQueueId, setSteeringQueueId] = useState<string | null>(null);
  useLayoutEffect(() => {
    // Sync only when the committed store draft changes. An unrelated render
    // can happen before the RAF-coalesced draft commit; copying render-time
    // props on every render would roll the synchronous editor value back.
    latestDraftRef.current = draft;
    latestQuotedTextRef.current = quotedText;
    latestQuoteSourceRef.current = quoteSource;
    setDraftHasText(draft.value.trim().length > 0);
  }, [draft, quotedText, quoteSource]);
  const persistComposerDraft = useCallback(
    (nextDraft: ComposerDraftState, nextQuotedText: string | null, nextSource: AnyQuoteSource | null = latestQuoteSourceRef.current ?? null) => {
      latestDraftRef.current = nextDraft;
      latestQuotedTextRef.current = nextQuotedText;
      latestQuoteSourceRef.current = nextQuotedText ? nextSource ?? undefined : undefined;
      setDraftHasText(nextDraft.value.trim().length > 0);
      setComposerDraft(nodeId, {
        value: nextDraft.value,
        mentions: nextDraft.mentions,
        quotedText: nextQuotedText ?? undefined,
        ...(nextQuotedText && nextSource ? { quoteSource: nextSource } : {}),
      });
    },
    [nodeId, setComposerDraft],
  );
  // The / menu row the draft's `/name` was picked from (MentionEditor's
  // onSlashPick), or the pick a restored or rejected message brought back.
  // An edit that leaves the text without that `/name` drops it, so a name
  // typed again by hand runs by the typed-name rules.
  const slashPickRef = useRef<SlashPick | null>(null);
  const setDraft = useCallback(
    (nextOrUpdater: ComposerDraftState | ((prev: ComposerDraftState) => ComposerDraftState)) => {
      const next = typeof nextOrUpdater === 'function'
        ? nextOrUpdater(latestDraftRef.current)
        : nextOrUpdater;
      const pick = slashPickRef.current;
      if (pick && !keepsSlashPick(next.value, pick.entry.name)) slashPickRef.current = null;
      persistComposerDraft(next, latestQuotedTextRef.current);
    },
    [persistComposerDraft],
  );
  const appliedDraftRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!draftRequest || appliedDraftRequest.current === draftRequest.id) return;
    appliedDraftRequest.current = draftRequest.id;
    const requested = draftRequest.text.trim();
    if (!requested) return;
    setDraft((previous) => appendComposerLine(previous, requested));
  }, [draftRequest, setDraft]);
  const setQuotedText = useCallback(
    (next: string | null) => persistComposerDraft(latestDraftRef.current, next, null),
    [persistComposerDraft],
  );
  const clearComposerDraft = useCallback(() => {
    latestDraftRef.current = EMPTY_COMPOSER_DRAFT;
    latestQuotedTextRef.current = null;
    latestQuoteSourceRef.current = undefined;
    setDraftHasText(false);
    setComposerDraft(nodeId, null);
  }, [nodeId, setComposerDraft]);
  const [agentMenu, setAgentMenu] = useState<PaneMenuAnchor | null>(null);
  const [modelMenu, setModelMenu] = useState<PaneMenuAnchor | null>(null);

  // Per-node binding: resolve runtime/model/effort from node → global fallback.
  const [pendingBindingOverride, setPendingBindingOverride] = useState<PendingNodeBindingOverride | null>(null);
  // A node continued from Michi asks for the attached session's runtime on its first send.
  // While a Michi continue is attaching this node's session, sending would race it.
  // The backend pins the assistant's runtime: what the user picked in the
  // conversation, else the global settings. The current conversation's chips
  // show that and save a pick for it alone; an older one shows what it ran on.
  const currentAssistant = isAssistantConversation && !!assistantInfo && assistantInfo.nodeId === nodeId;
  const assistantRuns = currentAssistant ? assistantInfo.conversation ?? assistantInfo.settings : null;
  const assistantBinding = isAssistantConversation ? assistantRuns
    ? { runtime: assistantRuns.runtimeId, provider: assistantRuns.providerId ?? undefined, model: assistantRuns.modelId ?? undefined,
      reasoning: assistantRuns.reasoning ?? undefined, source: 'node' as const }
    : assistantComposerBinding(n, assistantInfo, agentStatus) : null;
  const [savingAssistantModel, setSavingAssistantModel] = useState(false);
  const assistantModelSave = useRef(false);
  const saveAssistantModel = async (patch: AssistantSettingsPatch) => {
    if (assistantModelSave.current) return;
    assistantModelSave.current = true; setSavingAssistantModel(true);
    try {
      const info = await updateAssistantSettings({ ...patch, nodeId });
      const source = assistantSourceRef.current;
      if (source) { if (source.current()?.nodeId === info.nodeId) source.adopt(info); }
      else if (getCompanionAssistant().info?.nodeId === info.nodeId) adoptCompanionAssistant(info);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Could not update the assistant model'); }
    finally { assistantModelSave.current = false; setSavingAssistantModel(false); }
  };
  // Without a pick of its own the conversation follows the global settings,
  // which change under it (Settings, the model another chat last used): read
  // them again when they may have, so the chips show what the next message runs on.
  const assistantFollowsGlobal = currentAssistant && assistantInfo.conversationFollowsGlobal !== false;
  const assistantNodeStatus = n?.status;
  const modelMenuOpen = !!modelMenu;
  useEffect(() => {
    if (!assistantFollowsGlobal) return undefined;
    let live = true;
    const source = assistantSourceRef.current;
    (source ? source.refetch() : fetchAssistant()).then((info) => {
      if (!live) return;
      if (source) { if (source.current()?.nodeId === info.nodeId) source.adopt(info); }
      else if (getCompanionAssistant().info?.nodeId === info.nodeId) adoptCompanionAssistant(info);
    }, () => {});
    return () => { live = false; };
  }, [assistantFollowsGlobal, agentStatus, assistantNodeStatus, modelMenuOpen]);
  const requestedBinding = assistantBinding ?? resolveNodeBinding(n, agentStatus, pendingBindingOverride);

  // Load catalog for the *resolved* runtime (which may differ from the global active runtime).
  // Claude's provider-qualified IDs need CLI labels even before the picker opens.
  const shouldLoadModels = !!requestedBinding.runtime
    && (!!modelMenu || requestedBinding.runtime === 'claude');
  const {
    models: catalogModels,
    providers: catalogProviders,
    capabilities: catalogCapabilities,
    loading: modelsLoading,
    waiting: modelsWaiting,
    error: modelsError,
    retry: retryModels,
  } = useRuntimeCatalog({
    enabled: shouldLoadModels,
    connectionId: n ? backendConnectionIdForWorkspace(n.projectId) : undefined,
    runtime: requestedBinding.runtime,
    provider: requestedBinding.provider,
  });
  const resolvedBinding = assistantBinding ?? resolveNodeBinding(n, agentStatus, pendingBindingOverride,
    catalogProviders.length > 0 ? catalogProviders : undefined);
  const providerModels = requestedBinding.runtime === n?.runtimeId && n?.sessionState?.availableModels?.length
    ? n.sessionState.availableModels : catalogModels;
  // Ultracode is an ordinary chat's: never the assistant's or a maintenance
  // transcript's, nor a custom agent's (its live session reports none). The
  // picker offers it only on a runtime that has it (capabilities.ultracode).
  const liveSessionState = n?.sessionState?.runtimeId === resolvedBinding.runtime ? n.sessionState : undefined;
  const ultracode = n && !isAssistantConversation && !n.maintenanceJobId && !(liveSessionState && !liveSessionState.ultracode)
    ? { enabled: n.ultracode === true, available: liveSessionState?.ultracode?.available } : undefined;
  // Memory learns only from the user's own chats, never the assistant's, a
  // page's, a Meta agent run's or a Scheduled-only run's, so those (and an
  // embedded helper) offer no memory setting.
  // TODO(companion-memory): V (the 'main' assistant conversation) and check-ins fall under "the assistant's" here; decide what V offers and learns.
  const memorySetting = !!n && !embedded && !isAssistantConversation && n.kind === 'chat'
    && !n.pageId && !n.maintenanceJobId && !n.scheduledOnlyJobId;
  const composerEffort = resolveComposerReasoning(resolvedBinding, agentStatus, catalogCapabilities, providerModels, catalogProviders);
  // Snapshot the composer's runtime/model/effort for a send or retry, and
  // clear the pending chip override that this call consumes.
  const consumeBindingMeta = (): SendBindingMeta => {
    if (pendingBindingOverride) setPendingBindingOverride(null);
    // The backend pins the assistant's runtime, model and reasoning; a send
    // asks for none (the node's own binding, as the backend wrote it, goes).
    if (isAssistantConversation) return {};
    return {
      runtimeId: resolvedBinding.runtime || undefined,
      providerId: resolvedBinding.provider || undefined,
      modelId: resolvedBinding.model || undefined,
      reasoning: composerEffort.known ? composerEffort.value ?? null : resolvedBinding.reasoning,
    };
  };
  // Memoized message-list callbacks read the latest binding through this ref.
  const consumeBindingMetaRef = useRef(consumeBindingMeta);
  consumeBindingMetaRef.current = consumeBindingMeta;
  // The / menu: the runtime's commands and the skills of this workspace for
  // the runtime the next message runs on, asked for while the pane has focus
  // so the first send can resolve one. A send resolves against the same
  // entries (chatStore), and runs the row picked for its `/name`.
  // The assistant's conversations run no skills, only commands.
  const slashRuntimeId = resolvedBinding.runtime || undefined;
  const { catalog: skillCatalog, load: loadSlashCatalog } = useSkillCatalog(
    n && !readOnly ? n.projectId : undefined, slashRuntimeId, focusedPane === nodeId);
  const slashRuntimeLabel = useRuntimeLabel(n?.projectId, slashRuntimeId);
  const liveCommands = liveSlashCommands(n, slashRuntimeId);
  const slashEntries = useMemo(
    () => buildSlashEntries({ agentCommands: liveCommands, catalog: skillCatalog, skills: !isAssistantConversation,
      runtimeId: slashRuntimeId, runtimeLabel: slashRuntimeLabel }),
    [liveCommands, skillCatalog, isAssistantConversation, slashRuntimeId, slashRuntimeLabel],
  );
  // NB: do NOT call this `pending` — `onSubmit` already has a local
  // `const pending = n.pendingComments ?? []`.
  const {
    pending: pendingAttachments,
    setPending: setPendingAttachments,
    removePending: removePendingAttachment,
    uploadProgress,
    attachFiles,
    handlePaste,
    pickFiles: onPickFile,
  } = useComposerAttachments(activeProject, { restricted: attachmentRestricted });
  const [dragHover, setDragHover] = useState(false);

  // The assistant takes no files, in the ⌘J panel or as a pane (they would
  // land in a workspace folder, and it has no tool to read them).
  const {
    visible: dropzoneVisible,
    fileCount: droppedFileCount,
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    endDrag,
  } = useFileDropZone({ enabled: !attachmentRestricted });

  // inputRef is hoisted here so insertContextMention (used by handleDrop) can
  // close over it — both are declared before handleDrop to avoid TDZ.
  const inputRef = useRef<MentionEditorHandle>(null);
  useEffect(() => {
    if (composerFocusToken) inputRef.current?.focus();
  }, [composerFocusToken, nodeId]);

  const insertContextMention = useCallback((label: string) => {
    // Insert an atomic context-mention chip at the editor caret (drop handler).
    inputRef.current?.editor
      ?.chain()
      .focus()
      .insertContent([
        { type: 'mention', attrs: { refId: label, label, kind: 'context' } },
        { type: 'text', text: ' ' },
      ])
      .run();
  }, []);

  // "Test Connection" for the connection/auth error tail: force-respawn the
  // runtime and probe reachability. Desktop sends the workspace cwd; cloud
  // sends the workspaceId (backend derives the sandbox cwd).
  const handleTestConnection = useCallback(async () => {
    if (activeProject?.cwd) return checkRuntimeHealth({ cwd: activeProject.cwd });
    if (activeProject?.id) return checkRuntimeHealth({ workspaceId: activeProject.id });
    return { ok: false, detail: 'no active workspace' };
  }, [activeProject?.cwd, activeProject?.id]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    endDrag();
    // The assistant takes no files (see useFileDropZone above).
    if (attachmentRestricted) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    if (!embedded) focusPane(nodeId);
    await attachFiles(files);
  }, [attachFiles, attachmentRestricted, embedded, endDrag, focusPane, nodeId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderAnchorRef = useRef<{ id: string; top: number } | null>(null);
  // Scroll events arrive faster than the loading state re-renders.
  const loadingOlderRef = useRef(false);
  const loadOlder = useCallback(async () => {
    if (loadingOlder || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    cancelScrollRestoreRef.current?.();
    followRef.current = false;
    const el = scrollRef.current;
    const anchor = el?.querySelector<HTMLElement>('[data-msg-id]');
    if (anchor?.dataset.msgId) olderAnchorRef.current = { id: anchor.dataset.msgId, top: anchor.getBoundingClientRect().top };
    setLoadingOlder(true);
    try { await loadOlderMessages(nodeId); }
    catch (error) { olderAnchorRef.current = null; toast.error((error as Error).message); }
    finally { loadingOlderRef.current = false; setLoadingOlder(false); }
  }, [loadOlderMessages, loadingOlder, nodeId]);
  useLayoutEffect(() => {
    const anchor = olderAnchorRef.current;
    const el = scrollRef.current;
    if (!anchor || !el || loadingOlder) return;
    const target = [...el.querySelectorAll<HTMLElement>('[data-msg-id]')].find(item => item.dataset.msgId === anchor.id);
    if (!target) { olderAnchorRef.current = null; return; }
    // Prepending brings content-visibility frames into view. Their estimated
    // heights settle over several paints, so one scrollTop write would drift.
    let frame = 0;
    let done = false;
    const started = performance.now();
    let lastMove = started;
    const finish = () => {
      done = true;
      cancelAnimationFrame(frame);
      if (olderAnchorRef.current === anchor) olderAnchorRef.current = null;
    };
    const apply = () => {
      if (done) return;
      const now = performance.now();
      const delta = target.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > 1) {
        programmaticScrollUntilRef.current = now + PROGRAMMATIC_SCROLL_WINDOW_MS;
        el.scrollTop += delta;
        prevScrollTopRef.current = el.scrollTop;
        lastMove = now;
      }
      if (now - started >= RESTORE_MAX_MS || now - lastMove >= RESTORE_QUIET_MS) finish();
      else frame = requestAnimationFrame(apply);
    };
    apply();
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const event of events) el.addEventListener(event, finish, { passive: true });
    return () => {
      finish();
      for (const event of events) el.removeEventListener(event, finish);
    };
  }, [loadingOlder, nodeId]);
  // "Follow mode": while true and the agent is streaming, new content
  // pins the viewport to the bottom. Toggles on/off based on the user's
  // scroll direction (see onScroll handler below). Initial value is true
  // so a freshly-opened pane tails the conversation by default.
  const followRef = useRef<boolean>(true);
  // Previous scrollTop sample — used by onScroll to detect direction.
  const prevScrollTopRef = useRef<number>(0);
  // ID of the last user message we've already auto-scrolled for. Used to
  // detect a *new* user send (vs. a re-render of the same message) so we
  // only fire the send glide (sendScroll.ts) once per send.
  // Initialise to the current latest user message so a freshly-mounted
  // (reopened) pane doesn't mistake existing history for a new send.
  // Compared by sentMessageKey: realign-assistant-id renames a sent message
  // to the server's id, which is not a new send.
  const prevSentMsgIdRef = useRef<string | null>((() => {
    const msgs = n?.messages;
    if (!msgs) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') return sentMessageKey(msgs[i]);
    }
    return null;
  })());
  // performance.now() timestamp until which follow-mode auto-pinning is
  // suppressed. Set when a user message lands so the send glide owns the
  // scroll until it lands; it clears this itself when it ends.
  const userMsgPinUntilRef = useRef<number>(0);
  // Cancels the send glide in progress (sendScroll.ts), if any.
  const sendGlideRef = useRef<(() => void) | null>(null);
  useEffect(() => () => sendGlideRef.current?.(), []);
  // Until when the next send glide rides the keyboard (KEYBOARD_MOVE): the
  // composer's send lowered it. The message lands a commit or two later.
  const keyboardSendUntilRef = useRef<number>(0);
  // Programmatic smooth-scroll emits ordinary scroll events. Without this
  // guard, the first in-between frame can look like an upward user scroll and
  // incorrectly disable follow mode for the rest of the streaming turn.
  const programmaticScrollUntilRef = useRef<number>(0);
  const cancelScrollRestoreRef = useRef<(() => void) | null>(null);
  // Layout reflow during a long stream can move scrollTop upward by itself
  // (markdown blocks forming, browser scroll anchoring). Only
  // leave follow mode when that upward scroll is tied to recent user input.
  const userScrollIntentUntilRef = useRef<number>(0);
  // A click in the transcript that changes its height (Show more on a long
  // user message, opening a thinking or tool card) is the reader asking to
  // see that content, not new output to tail. Follow mode used to pin the
  // grown transcript to its tail, so expanding a message above the reply
  // threw the viewport to the bottom. The click records the transcript
  // height; the first pin that finds it changed by the clicked message
  // (clickChangedLayout) leaves follow mode. The record lasts
  // USER_CLICK_LAYOUT_WINDOW_MS, as an opening animates its height from a
  // frame or two later (motion), or after an outgoing part has faded.
  const userClickLayoutRef = useRef<UserClickLayout | null>(null);
  // A new branch is output to tail, even when its insertion follows a click
  // inside the transcript. Keep the existing follow mode instead of treating
  // the new anchor row as a reader expanding a message.
  const prepareBranchScroll = useCallback(() => {
    userClickLayoutRef.current = null;
  }, []);
  // Latest pin function — set inside the streaming-follow effect so the
  // ResizeObserver/animation-end pin can run the same anchor-vs-tail
  // logic without recapturing message state in its `[]` deps closure.
  const pinFnRef = useRef<(() => void) | null>(null);
  // Whether the last follow pass saw the node streaming, and until when the
  // answer that stream left may still settle (TAIL_SETTLE_MS).
  const followSawStreamingRef = useRef(false);
  const tailSettleUntilRef = useRef(0);

  // ── Scroll persistence ─────────────────────────────────────────────────
  // True while the mount-time restore below is still positioning the
  // viewport. Saves are suppressed during that window: a save would capture
  // the half-restored position AND advance the lastSeen horizon — under
  // StrictMode's dev double-mount the first cleanup fires exactly then, and
  // without the guard it poisons the entry the second mount restores from
  // (read chats snapped to the bottom, unread chats lost their horizon).
  const restoreInFlightRef = useRef(false);
  // Tracks whether the mount-time restore (or its lazy-load retry below)
  // successfully positioned the viewport. When mount fires with no messages
  // (lazy-loaded tree), this stays false so the retry effect can run.
  const didRestoreRef = useRef(false);
  // Capture where the user is in this pane as a message anchor plus the
  // newest message timestamp (see PaneScrollEntry). Runs on unmount,
  // debounced while scrolling, and on beforeunload so a refresh keeps it
  // fresh too.
  const savePaneScroll = useCallback(() => {
    if (restoreInFlightRef.current) return;
    const el = scrollRef.current;
    const node = nLatestRef.current;
    if (!el || !node || node.messages.length === 0) return;
    const lastSeen = node.messages.reduce((mx, m) => Math.max(mx, m.createdAt ?? 0), 0);
    // Mid-stream the tail keeps growing after the pane closes, so "at the
    // bottom now" is not "at the bottom on reopen" — save the anchor instead
    // and the user resumes at the point they stopped watching.
    const atBottom =
      node.status !== 'streaming' &&
      el.scrollTop >= el.scrollHeight - el.clientHeight - 24;
    let anchorId: string | null = null;
    let offset = 0;
    if (!atBottom) {
      const viewTop = el.getBoundingClientRect().top;
      for (const f of Array.from(el.querySelectorAll<HTMLElement>('[data-msg-id]'))) {
        const r = f.getBoundingClientRect();
        if (r.bottom > viewTop + 1) { // topmost message still (partly) visible
          anchorId = f.getAttribute('data-msg-id');
          offset = r.top - viewTop;
          break;
        }
      }
    }
    paneScrollCache.set(nodeId, { anchorId, offset, atBottom, lastSeen });
  }, [nodeId]);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePaneScrollSave = useCallback(() => {
    if (scrollSaveTimerRef.current != null) clearTimeout(scrollSaveTimerRef.current);
    scrollSaveTimerRef.current = setTimeout(() => {
      scrollSaveTimerRef.current = null;
      savePaneScroll();
    }, 250);
  }, [savePaneScroll]);

  // Position the viewport on mount. Streaming panes are handled by follow
  // mode; idle panes land on the target picked by resolvePaneRestore()
  // (unseen message → bottom).
  // A single scrollTop assignment cannot work here: message frames use
  // content-visibility:auto, so heights inflate from 72px estimates to real
  // values progressively after mount — and each write moves the viewport,
  // which makes the browser render more frames near it, which shifts the
  // anchor again. With overflow-anchor:none on the container, nothing
  // compensates for that drift, so the restore keeps re-deriving the target
  // from the anchor's live rect (ResizeObserver on the content) until the
  // layout goes quiet, the hard cap elapses, or the user scrolls. The first
  // pass runs synchronously inside the layout effect so the pre-paint frame
  // is already positioned.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let finishRestore: (() => void) | null = null;
    let liveTrustRaf: number | null = null;
    const live = n?.status === 'streaming' || !!n?.followUpsGenerating;
    const restore = live
      ? null
      : resolvePaneRestore(paneScrollCache.get(nodeId), n?.messages ?? []);
    if (restore) {
      didRestoreRef.current = true;
      // Follow mode stays on only when we land at the bottom — otherwise the
      // streaming-follow / resize pins would yank the restored position back
      // down (this is what previously sent every followUps-bearing pane to
      // the bottom on open). The bottom case keeps follow ON, so the
      // existing follow pins take over once this restore finishes.
      followRef.current = restore.kind === 'bottom';
      const targetFor = (): number => {
        if (restore.kind === 'unseen' && restore.anchorId) {
          const msgEl = el.querySelector<HTMLElement>(`[data-msg-id="${restore.anchorId}"]`);
          if (msgEl) {
            const delta = msgEl.getBoundingClientRect().top - el.getBoundingClientRect().top;
            return Math.max(0, el.scrollTop + delta - el.clientHeight * UNSEEN_TOP_FRACTION);
          }
          // Anchor message gone (deleted/trimmed) — fall through to bottom.
        }
        return el.scrollHeight - el.clientHeight;
      };
      let done = false;
      let ro: ResizeObserver | null = null;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let capTimer: ReturnType<typeof setTimeout> | null = null;
      restoreInFlightRef.current = true;
      const finish = () => {
        if (done) return;
        done = true;
        restoreInFlightRef.current = false;
        ro?.disconnect();
        if (quietTimer != null) clearTimeout(quietTimer);
        if (capTimer != null) clearTimeout(capTimer);
        el.removeEventListener('wheel', finish);
        el.removeEventListener('touchstart', finish);
        el.removeEventListener('pointerdown', finish);
      };
      finishRestore = finish;
      cancelScrollRestoreRef.current = finish;
      const armQuiet = () => {
        if (quietTimer != null) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, RESTORE_QUIET_MS);
      };
      const apply = () => {
        if (done) return;
        const target = targetFor();
        if (Math.abs(el.scrollTop - target) > 1) {
          // Our own writes emit scroll events; keep the follow-mode
          // direction detector from reading them as user intent.
          programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
          el.scrollTop = target;
          prevScrollTopRef.current = el.scrollTop;
          armQuiet();
        }
      };
      apply();
      armQuiet();
      capTimer = setTimeout(finish, RESTORE_MAX_MS);
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => apply());
        ro.observe(el);
        if (el.firstElementChild) ro.observe(el.firstElementChild);
      }
      el.addEventListener('wheel', finish, { passive: true });
      el.addEventListener('touchstart', finish, { passive: true });
      el.addEventListener('pointerdown', finish);
    } else {
      // Live pane (streaming / follow-ups generating) or no messages yet:
      // there is no restore pass, but StrictMode's dev double-mount still
      // fires this effect's cleanup synchronously, before any frame — where
      // the layout is the unsettled content-visibility estimate. Guard that
      // window too so the cleanup save can't poison the entry; the flag
      // clears one frame after mount, once geometry is real.
      restoreInFlightRef.current = true;
      liveTrustRaf = requestAnimationFrame(() => {
        liveTrustRaf = null;
        restoreInFlightRef.current = false;
      });
    }
    window.addEventListener('beforeunload', savePaneScroll);
    return () => {
      // Unmounting mid-restore (StrictMode's dev double-mount, or an
      // open-and-close within RESTORE_QUIET_MS) skips the save: the
      // half-restored position would overwrite the entry this restore was
      // reading, and the stale entry is strictly better data.
      const restoreWasActive = restoreInFlightRef.current;
      finishRestore?.();
      if (liveTrustRaf != null) {
        cancelAnimationFrame(liveTrustRaf);
        restoreInFlightRef.current = false;
      }
      window.removeEventListener('beforeunload', savePaneScroll);
      if (scrollSaveTimerRef.current != null) {
        clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      if (!restoreWasActive) savePaneScroll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Lazy-load scroll restore retry ───────────────────────────────────
  // When a tree is lazy-loaded, the mount effect fires with messages === []
  // and resolvePaneRestore returns null — the pane stays at the top. Once
  // `messages-loaded` installs the real message bodies (messagesLoaded flips
  // to true and messages.length > 0), this effect runs the restore that the
  // mount effect couldn't. It only fires once (guarded by didRestoreRef) and
  // applies the same unseen-or-bottom logic.
  const messagesLoaded = n?.messagesLoaded || !!n?.historyBefore;
  const messagesLen = n?.messages.length ?? 0;
  useLayoutEffect(() => {
    if (didRestoreRef.current) return;
    if (!n || messagesLoaded === false || messagesLen === 0) return;
    didRestoreRef.current = true;
    const el = scrollRef.current;
    if (!el) return;
    const live = n.status === 'streaming' || !!n.followUpsGenerating;
    if (live) return; // follow-mode handles live panes
    const restore = resolvePaneRestore(paneScrollCache.get(nodeId), n.messages);
    if (!restore || restore.kind === 'bottom') {
      programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
      el.scrollTop = el.scrollHeight - el.clientHeight;
      prevScrollTopRef.current = el.scrollTop;
      followRef.current = true;
    } else if (restore.kind === 'unseen' && restore.anchorId) {
      followRef.current = false;
      const msgEl = el.querySelector<HTMLElement>(`[data-msg-id="${restore.anchorId}"]`);
      if (msgEl) {
        programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
        const delta = msgEl.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop = Math.max(0, el.scrollTop + delta - el.clientHeight * UNSEEN_TOP_FRACTION);
        prevScrollTopRef.current = el.scrollTop;
      } else {
        // Anchor message not in DOM — fall back to bottom
        programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
        el.scrollTop = el.scrollHeight - el.clientHeight;
        prevScrollTopRef.current = el.scrollTop;
        followRef.current = true;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesLoaded, messagesLen]);

  const composerHandle = useRef<ComposerShellHandle>(null);
  // Whether the composer is in the pane's bottom slot. A permission request
  // takes its place only after the composer has faded out, and the composer
  // comes back only after the banner has left (ComposerSlot), so the
  // transcript's clearance and the composer's observers follow its mount,
  // not pendingPermission. Until the shell first reports in, the guess is
  // taken from the first node this pane sees (it can render once before its
  // node arrives) and then held: a banner that was pending at mount keeps
  // its 12px clearance while it leaves. Mocked shells that drop the ref keep
  // the guess.
  const [composerAttached, setComposerAttached] = useState<boolean | null>(null);
  const composerGuessRef = useRef<boolean | null>(null);
  if (composerGuessRef.current === null && n) composerGuessRef.current = !n.pendingPermission;
  const composerMounted = readOnly ? false : composerAttached ?? composerGuessRef.current ?? true;
  const composerHandleRef = useCallback((handle: ComposerShellHandle | null) => {
    composerHandle.current = handle;
    setComposerAttached(handle !== null);
  }, []);
  // The commit that swaps the leaving banner for the composer still has the
  // banner's 12px clearance (composerMounted flips in the next, synchronous
  // render). Anything that reads layout in that commit (the phone composer
  // snapshots itself) makes the browser clamp scrollTop to the taller, less
  // padded transcript, and the clearance growing back does not undo it. So
  // the banner records how far the transcript sat from its end as it
  // leaves, and the composer's arrival puts it back there.
  const slotSwapFromEndRef = useRef<number | null>(null);
  const recordSlotSwap = useCallback(() => {
    const el = scrollRef.current;
    slotSwapFromEndRef.current = el ? el.scrollHeight - el.clientHeight - el.scrollTop : null;
  }, []);
  useLayoutEffect(() => {
    const fromEnd = slotSwapFromEndRef.current;
    slotSwapFromEndRef.current = null;
    const el = scrollRef.current;
    if (!composerMounted || fromEnd === null || !el) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight - fromEnd);
    if (Math.abs(top - el.scrollTop) < 1) return;
    programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
    el.scrollTop = top;
    prevScrollTopRef.current = el.scrollTop;
  }, [composerMounted]);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerToolbarRef = useRef<HTMLDivElement>(null);
  // Measured height of the floating composer card. Drives the scroll area's
  // bottom padding so the last message can scroll above the card instead of
  // being trapped behind it.
  const [composerHeight, setComposerHeight] = useState(96);
  // Width-driven compaction tier for the toolbar:
  // 0 = full labels, 1 = compact model settings and agent glyph,
  // 2 = hide the agent chip; model settings remain reachable.
  const [toolbarTier, setToolbarTier] = useState<0 | 1 | 2>(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusNonce, setFindFocusNonce] = useState(0);
  const isFocused = focusedPane === nodeId;
  // When another pane is being dragged over us, show a drop indicator on the
  // appropriate side. `null` means no pane drag is currently hovering.
  const [paneDropSide, setPaneDropSide] = useState<'left' | 'right' | null>(null);
  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = performance.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);
  // The phone scrubber moves the transcript for the reader: stop tailing the
  // reply and any glide or restore still running. Dragging back to the
  // bottom resumes following through the ordinary scroll handler. Like a
  // drag on the transcript, it lowers the keyboard.
  const handleScrub = useCallback((phase: 'start' | 'move') => {
    if (phase === 'start') {
      blurWithin(composerHandle.current?.el);
      cancelScrollRestoreRef.current?.();
      sendGlideRef.current?.();
      followRef.current = false;
    }
    markUserScrollIntent();
  }, [markUserScrollIntent]);
  const markUserScrollIntentFromKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      e.key === 'ArrowUp' ||
      e.key === 'PageUp' ||
      e.key === 'Home' ||
      (e.key === ' ' && e.shiftKey)
    ) {
      markUserScrollIntent();
    }
  }, [markUserScrollIntent]);

  // Listen for the global ⌘F dispatch — only act when the event targets this pane.
  // Each press: open if closed, and bump the focus nonce so PaneFind refocuses
  // its input even when already open.
  useEffect(() => {
    const onOpenFind = (e: Event) => {
      const detail = (e as CustomEvent).detail as { nodeId?: string };
      if (detail?.nodeId !== nodeId) return;
      setFindOpen(true);
      setFindFocusNonce((n) => n + 1);
    };
    window.addEventListener('michi:open-pane-find', onOpenFind as EventListener);
    return () => window.removeEventListener('michi:open-pane-find', onOpenFind as EventListener);
  }, [nodeId]);

  // Auto-close find when this pane loses focus (user switched panes / pages).
  useEffect(() => {
    if (!isFocused && findOpen) setFindOpen(false);
  }, [isFocused, findOpen]);

  // Files the Dashboard receives outside any chat pane reach this composer
  // when it is the pane under the cursor or the focused one.
  useEffect(() => {
    if (embedded) return;
    return registerPaneFileDropTarget(nodeId, async (files) => {
      if (attachmentRestricted) return false;
      focusPane(nodeId);
      return attachFiles(files);
    });
  }, [attachFiles, attachmentRestricted, embedded, focusPane, nodeId]);

  // Intercept internal-link clicks from MarkdownContent anchors and open them
  // as artifact panes (prevents white-screen navigation for relative URLs).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onInternalLink = (e: Event) => {
      const href = (e as CustomEvent).detail?.href;
      if (typeof href === 'string' && href.trim()) {
        void openArtifactPane(href, { parseSourceLocation: true });
      }
    };
    el.addEventListener('michi:internal-link', onInternalLink);
    return () => el.removeEventListener('michi:internal-link', onInternalLink);
  }, [openArtifactPane]);

  // Auto-grow now lives inside MentionEditor (its contenteditable owns the
  // min/max-height sizing).

  // Track the floating composer's actual rendered height so the scroll area can
  // reserve matching bottom clearance. Without this, multi-line input + a quote
  // bar push the card taller than any fixed padding can cover.
  useEffect(() => {
    const el = composerHandle.current?.el;
    composerRef.current = el ?? null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setComposerHeight(Math.ceil(el.offsetHeight));
    // Border box: the card's padding and border are part of what the
    // transcript must clear (contentRect left the resting phone card 14px short).
    const ro = new ResizeObserver((entries) => {
      if (sidebarAnimatingRef.current) return;
      const h = entries[0]?.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
      setComposerHeight(Math.ceil(h));
    });
    ro.observe(el, { box: 'border-box' });
    animationEndCallbacks.add(measure);
    return () => {
      ro.disconnect();
      animationEndCallbacks.delete(measure);
    };
  }, [composerMounted]);

  // The floating card covers the transcript's bottom, so when it grows (a
  // phone composer opening from its one-row rest, a quote bar, more lines)
  // scroll by the growth to keep the last lines in view. Tail-follow only
  // pins while a reply is live; an idle transcript would otherwise lose its
  // last lines under the card. A transcript read above its bottom stays
  // where it is. Shrinking needs nothing: the browser clamps.
  // The first measurement replaces the initial 96px guess and is not growth.
  const prevComposerHeightRef = useRef<number | 'guess'>('guess');
  useLayoutEffect(() => {
    const prev = prevComposerHeightRef.current;
    prevComposerHeightRef.current = composerHeight === 96 && prev === 'guess' ? 'guess' : composerHeight;
    if (prev === 'guess') return;
    const grew = composerHeight - prev;
    const el = scrollRef.current;
    if (!el || grew <= 0 || !composerMounted) return;
    // The bottom padding has already grown by `grew`; measure against the old end.
    const fromOldBottom = el.scrollHeight - grew - el.clientHeight - el.scrollTop;
    if (fromOldBottom > 24) return;
    programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
    el.scrollTop += grew;
    prevScrollTopRef.current = el.scrollTop;
  }, [composerHeight, composerMounted]);

  // Width-driven compaction for the composer toolbar. Below ~360px the
  // agent / model chips drop their text labels (glyph-only); below ~260px
  // they are hidden entirely. The action buttons on the right never shrink,
  // and individual chip labels also clip with an ellipsis on the way down,
  // so the transition between tiers stays smooth. Measured before paint, so
  // a narrow pane never shows the full toolbar first.
  useLayoutEffect(() => {
    const el = composerToolbarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const tierFor = (w: number): 0 | 1 | 2 => (w < 260 ? 2 : w < 360 ? 1 : 0);
    // The toolbar's content width. A phone composer at rest folds the
    // toolbar into its one row (display: contents, no box); the chips are
    // then sized for the open toolbar, which spans the composer, so they are
    // ready, at their final size, when it opens.
    const contentWidth = () => {
      const style = getComputedStyle(el);
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const width = style.display === 'contents' ? el.parentElement?.clientWidth ?? 0 : el.clientWidth;
      return width > 0 ? width - padding : 0;
    };
    const measure = () => {
      const width = contentWidth();
      if (width <= 0) return;
      const next = tierFor(width);
      setToolbarTier((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(() => {
      if (sidebarAnimatingRef.current) return;
      measure();
    });
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    animationEndCallbacks.add(measure);
    return () => {
      ro.disconnect();
      animationEndCallbacks.delete(measure);
    };
  }, [composerMounted]);

  const activeProjectEdges = activeProject?.edges ?? EMPTY_EDGES;
  const mentionContexts = activeProject?.artifacts ?? EMPTY_CONTEXTS;

  const contextNamesSet = useMemo(() => {
    if (mentionContexts.length === 0) return EMPTY_CONTEXT_NAMES;
    return new Set(mentionContexts.map(c => c.name.toLowerCase()));
  }, [mentionContexts]);

  const parentTitle = useStructuralSelector(
    useCallback((nodesMap) => {
      const parentId = nodesMap[nodeId]?.parentNodeId;
      return parentId ? nodesMap[parentId]?.title : undefined;
    }, [nodeId]),
  );
  // A multi-model branch: the banner opens its plan, a failed step retries through the run.
  const multiModelBranch = useMultiModelBranch({
    nodeId, workspaceId: n?.projectId, runId: n?.multiModelRunId, parentNodeId: n?.parentNodeId,
  });

  // Compute same-tree nodes for @mention popup at structural cadence. Streaming
  // chunks do not change titles, deletion, kind, tree placement, or message
  // count, so every open pane can skip this selector while another pane is
  // receiving tokens.
  const sameTreeNodes = useStructuralSelector(useCallback((nodesMap) => {
    if (!activeProject) return EMPTY_SAME_TREE_NODES;
    const treeId = findTreeIdForNode(nodeId, activeProject);
    if (!treeId) return EMPTY_SAME_TREE_NODES;
    const out: ChatNodeState[] = [];
    for (const nid of activeProject.chatIds) {
      const nd = nodesMap[nid];
      if (!nd || nd.deletedAt || nd.kind !== 'chat') continue;
      if (findTreeIdForNode(nid, activeProject) !== treeId) continue;
      out.push(nd);
    }
    return out.length > 0 ? out : EMPTY_SAME_TREE_NODES;
  }, [activeProject, nodeId]), shallowArrayEqual);

  // Cross-tree nodes for @mention popup: nodes from OTHER threads in the same
  // workspace, grouped by thread title. See collectCrossTreeGroups for the
  // ordering/cap rules (shared with the Home composer).
  const crossTreeNodes = useStructuralSelector(useCallback((nodesMap) => {
    if (spacesAssistant) {
      const groups = projects.filter(project => !project.system && !project.deletedAt && !project.archivedAt && backendConnectionIdForWorkspace(project.id) === LOCAL_BACKEND_CONNECTION_ID)
        .flatMap(project => collectCrossTreeGroups(nodesMap, project, null).map(group => ({ ...group, treeTitle: `${project.name} · ${group.treeTitle}` })));
      let count = 0;
      return groups.flatMap(group => {
        const nodes = group.nodes.slice(0, Math.max(0, 50 - count));
        count += nodes.length;
        return nodes.length ? [{ ...group, nodes }] : [];
      });
    }
    if (!activeProject) return EMPTY_CROSS_TREE_NODES;
    const currentTreeId = findTreeIdForNode(nodeId, activeProject);
    if (!currentTreeId) return EMPTY_CROSS_TREE_NODES;
    return collectCrossTreeGroups(nodesMap, activeProject, currentTreeId);
  }, [activeProject, nodeId, projects, spacesAssistant]), shallowArrayEqual);

  const mergeSourceLabels = useStructuralSelector(useCallback((nodesMap) => {
    const node = nodesMap[nodeId];
    if (!node || (node.mergeSources?.length ?? 0) === 0) return EMPTY_MERGE_SOURCE_LABELS;
    const sourceIds = [
      ...(node.parentNodeId ? [node.parentNodeId] : []),
      ...(node.mergeSources ?? []),
    ];
    return sourceIds.map((sid) => {
      const src = nodesMap[sid];
      return src?.title || chatLabel(src) || sid;
    });
  }, [nodeId]), shallowArrayEqual);

  // Compute which child branches are anchored to which assistant message in
  // this pane. Passed to PaneMessageList so it can render BranchAnchorRow
  // turn markers after each anchored message.
  //
  // The anchor row only needs structural fields (title/status/message count
  // and anchored message ids). Keeping it on the structural channel prevents
  // a streaming child from waking every parent pane on each token.
  const anchorsByMessage = useStructuralSelector(
    useCallback(
      (nodesMap) => buildAnchorMap(nodeId, activeProjectEdges, nodesMap),
      [nodeId, activeProjectEdges],
    ),
    anchorMapEqual,
  );

  const lastMsg = n?.messages[n ? n.messages.length - 1 : 0];
  // Tool calls and thinking streams grow without touching `text`, so include
  // them in the deps — otherwise the viewport stays put while a tool chip or
  // reasoning chunk pushes content below the fold.
  const lastToolSig = lastMsg?.toolCalls
    .map((t) => `${t.id}:${t.status}:${t.title.length}:${t.kind?.length ?? 0}:${t.detail?.length ?? 0}`)
    .join('|');
  const lastPlanSig = lastMsg?.plan
    ?.map((p) => `${p.status}:${p.priority}:${p.content.length}`)
    .join('|');
  const subagentSig = n?.subagents
    ?.map((s) => `${s.sessionId}:${s.status}:${s.currentTool?.length ?? 0}:${s.statusMessage?.length ?? 0}`)
    .join('|');
  // Streaming assistant content lands in `blocks` (via
  // projectAssistantStreamEvent), NOT in `m.text`. So the effect below has to
  // depend on a block-derived signature, not just text length, otherwise it
  // never re-runs while the agent is streaming.
  const lastBlockSig = lastMsg?.blocks
    ?.map((b) =>
      b.kind === 'tool'
        ? `t:${b.toolCallId}`
        : b.kind === 'image'
          ? `i:${b.path}`
          : b.kind === 'user-input'
            ? `u:${b.requestId}`
            : `${b.kind[0]}:${b.rawText.length}`,
    )
    .join('|');
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Two distinct behaviours:
    //   1. Just-sent user message → glide the thread up by what the send
    //      added, so the message and the reply's placeholder rest just above
    //      the composer (sendScroll.ts). Re-engages follow mode so streaming
    //      output that arrives next keeps tailing the bottom.
    //   2. Streaming assistant content → if follow mode is on, schedule a
    //      pinFollow via rAF. The ResizeObserver below handles keeping
    //      scroll pinned as content height grows (line breaks).
    // Find the most-recent user message — the reducer pairs every user
    // send with an empty assistant placeholder on the same tick, so
    // `lastMsg.role` is usually 'assistant' even right after a send.
    // Backward scan (no array copy): this effect re-runs on nearly every
    // stream chunk, so a full [...messages].reverse() per chunk is wasteful.
    let latestUser: NonNullable<typeof n>['messages'][number] | undefined;
    if (n?.messages) {
      for (let i = n.messages.length - 1; i >= 0; i--) {
        if (n.messages[i].role === 'user') { latestUser = n.messages[i]; break; }
      }
    }
    if (latestUser && sentMessageKey(latestUser) !== prevSentMsgIdRef.current) {
      prevSentMsgIdRef.current = sentMessageKey(latestUser);
      followRef.current = true;
      sendGlideRef.current?.();
      // Follow-pinning waits for the glide; the cap only matters if the glide
      // never ends (a background tab pauses its frames).
      userMsgPinUntilRef.current = performance.now() + 1500;
      const release = () => {
        sendGlideRef.current = null;
        userMsgPinUntilRef.current = 0;
      };
      // A phone send that lowered the keyboard: Safari carries the page down
      // as it leaves, so the thread rises on the keyboard's curve, not its own.
      const withKeyboard = performance.now() < keyboardSendUntilRef.current;
      keyboardSendUntilRef.current = 0;
      sendGlideRef.current = glideToTail(el, {
        target: () => Math.max(0, el.scrollHeight - el.clientHeight),
        reduce: prefersReducedMotion(),
        timing: withKeyboard ? KEYBOARD_MOVE : undefined,
        onFrame: () => {
          programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
          prevScrollTopRef.current = el.scrollTop;
        },
        onDone: () => {
          release();
          pinFnRef.current?.();
        },
        onInterrupt: () => {
          // The reader took the scroll mid-glide: leave it with them, and let
          // their next scroll events count as theirs.
          release();
          followRef.current = false;
          programmaticScrollUntilRef.current = 0;
        },
      });
      return;
    }
    // Follow: track the reply's tail so its bottom edge sits just above the
    // floating composer card, as the send glide left it.
    const pinFollow = () => {
      if (!followRef.current) return;
      const click = userClickLayoutRef.current;
      if (click && el.scrollHeight !== click.scrollHeight && clickChangedLayout(click)) {
        userClickLayoutRef.current = null;
        followRef.current = false;
        return;
      }
      if (performance.now() < userMsgPinUntilRef.current) return;
      // Tail anchor uses the bottom of the *last visible content child*
      // — not just the last assistant message — so newly-rendered
      // siblings (follow-ups placeholder, mcp errors, subagent banner)
      // get tracked too. Skip aria-hidden children so decoration doesn't
      // push the tail past the real content.
      const inner = el.firstElementChild;
      let contentBottom = 0;
      if (inner) {
        for (const c of Array.from(inner.children) as HTMLElement[]) {
          if (c.getAttribute('aria-hidden') === 'true') continue;
          const b = c.offsetTop + c.offsetHeight;
          if (b > contentBottom) contentBottom = b;
        }
      }
      const composerClearance = composerHeight + COMPOSER_CLEARANCE;
      const tail = contentBottom > 0
        ? contentBottom - el.clientHeight + composerClearance
        : el.scrollHeight - el.clientHeight;
      const maxScroll = el.scrollHeight - el.clientHeight;
      // Streaming markdown can briefly shrink/reflow as blocks become lists,
      // code fences, or headings. While follow-mode is active, avoid chasing
      // those transient upward measurements; only advance toward the tail.
      const nextScrollTop = nextFollowScrollTop({
        currentScrollTop: el.scrollTop,
        maxScroll,
        tail,
      });
      if (nextScrollTop !== el.scrollTop) {
        el.scrollTop = nextScrollTop;
      }
      prevScrollTopRef.current = el.scrollTop;
    };
    // Keep tail-following active through the follow-up phase too. The
    // follow-up tool often lands after text streaming has already flipped
    // the node back to idle; if we stop pinning at that boundary, the final
    // question can render underneath the floating composer.
    const streaming = n?.status === 'streaming';
    // The answer itself can reach its full height a frame or two after the
    // node goes idle (a stream whose last chunk and end arrive together), so
    // following outlasts the stream by TAIL_SETTLE_MS. Without it the end of
    // a long answer stays below the fold (send-scroll.spec.ts).
    if (followSawStreamingRef.current && !streaming) tailSettleUntilRef.current = performance.now() + TAIL_SETTLE_MS;
    followSawStreamingRef.current = streaming;
    const pinsLive = streaming || !!n?.followUpsGenerating || (n?.followUps.length ?? 0) > 0;
    const settling = !pinsLive && performance.now() < tailSettleUntilRef.current;
    const shouldPinTail = pinsLive || settling;
    // The settling pin checks its window when the ResizeObserver runs it, so it
    // lapses without this effect running again.
    pinFnRef.current = pinsLive
      ? pinFollow
      : settling
        ? () => { if (performance.now() < tailSettleUntilRef.current) pinFollow(); }
        : null;
    if (followRef.current && lastMsg?.role === 'assistant' && shouldPinTail) {
      if (performance.now() < userMsgPinUntilRef.current) return;
      requestAnimationFrame(pinFollow);
    }
  }, [
    n?.messages.length,
    n?.status,
    n?.followUpsGenerating,
    n?.followUps.length,
    !!n?.mcpServerError,
    n?.subagents?.length,
    subagentSig,
    lastMsg?.id,
    lastMsg?.role,
    lastMsg?.toolCalls.length,
    lastToolSig,
    lastPlanSig,
    lastBlockSig,
    composerHeight,
    anchorsByMessage,
  ]);

  // When the pane's width changes (e.g. opening a sibling shrinks the grid
  // column), or streamed markdown grows/reflows between network chunks, the
  // scroll position no longer reads as "at bottom" even though the user was.
  // Re-pin if follow-mode is still active.
  //
  // ResizeObserver fires BEFORE paint in modern browsers (after layout, before
  // the next composite/paint step). By calling pinFnRef.current() synchronously
  // here (no rAF wrapper), the scrollTop adjustment lands in the same frame as
  // the height change — eliminating the 1-frame flash where new content appears
  // below the viewport before scroll catches up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let frame: number | null = null;
    const pin = () => {
      // Synchronous pin — ResizeObserver already fires after layout/before paint,
      // so this scrollTop write takes effect within the same frame.
      pinFnRef.current?.();
    };
    // Fallback rAF pin for animation-end callbacks (non-critical path)
    const pinDeferred = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        pinFnRef.current?.();
      });
    };
    const ro = new ResizeObserver(() => {
      if (sidebarAnimatingRef.current) return;
      pin();
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    animationEndCallbacks.add(pinDeferred);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      ro.disconnect();
      animationEndCallbacks.delete(pinDeferred);
    };
  }, []);

  // Auto-focus the composer textarea when the user's intent is clearly to
  // type into this pane: the pane just became the focused pane, the agent
  // just finished streaming on a focused pane, or a quote was just attached
  // to a focused pane. We skip the focus pull when the user is already
  // typing somewhere else (another input/textarea/contenteditable) so we
  // don't yank focus mid-keystroke.
  const streaming = n?.status === 'streaming';

  // Blur the composer once when streaming starts, removing the distracting
  // blinking cursor while the user is reading the AI response. We only blur
  // once (on the idle→streaming transition); user can click back any time.
  const prevStreamingForBlur = useRef(streaming);
  useEffect(() => {
    const justStarted = !prevStreamingForBlur.current && streaming;
    prevStreamingForBlur.current = streaming;
    if (justStarted) {
      inputRef.current?.editor?.commands.blur();
    }
  }, [streaming]);

  // A send that isn't the composer's — a prompt a caller asked the ⌘J
  // assistant to send, a follow-up, or a reply to a selection where branches
  // are off — goes out like one: the pending assistant context as its quote (framed as
  // attached context), the pane's runtime binding, queued while the node
  // answers. The user's draft and quote stay as they are.
  const sendBesideComposer = (prompt: string, selectionQuote: string | null, queue = false): void => {
    const text = prompt.trim();
    if (!text) return;
    const context = pendingAssistantContext(nodeId);
    const quote = mergeContextQuote(context, selectionQuote?.trim() || null);
    const quoteSource = context ? ATTACHED_QUOTE_SOURCE : undefined;
    noteAssistantContextSent(nodeId);
    if (queue || nLatestRef.current?.status === 'streaming') {
      queueMessage(nodeId, {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        value: text,
        mentions: [],
        attachments: [],
        ...(quote ? { quotedText: quote } : {}),
        ...(quote && quoteSource ? { quoteSource } : {}),
        queuedAt: Date.now(),
      });
      return;
    }
    sendMessage(nodeId, joinMessageParts(null, quote, text, quoteSource), {
      ...(quote ? { quotedText: quote } : {}),
      ...(quote && quoteSource ? { quoteSource } : {}),
      displayText: text,
      // Not the composer's send: its draft stays as the user left it.
      keepDraft: true,
      ...consumeBindingMeta(),
    });
  };
  const sendBesideComposerRef = useRef(sendBesideComposer);
  sendBesideComposerRef.current = sendBesideComposer;
  // A branch that isn't the composer's (a follow-up's, a selection's) runs
  // on the composer's runtime binding, as its Branch button's does, and
  // leaves the user on this pane.
  const branchBesideComposer = (firstMessage: string, meta: UserSendMeta | undefined, opts: CreateChildChatOptions): void => {
    prepareBranchScroll();
    void createChildChat(nodeId, firstMessage, { ...meta, ...consumeBindingMeta() }, { ...opts, focus: false }).catch(() => {});
  };
  const branchBesideComposerRef = useRef(branchBesideComposer);
  branchBesideComposerRef.current = branchBesideComposer;

  // Sends requested through the assistant's composer store (openMichiAssistant
  // with send): taken once, the first sent and any further ones queued behind it.
  const requestedSends = useAssistantPendingSends(nodeId);
  useEffect(() => {
    if (requestedSends.length === 0) return;
    const node = nLatestRef.current;
    if (!node || node.deletedAt) return;
    takeAssistantSends(nodeId).forEach((send, i) => sendBesideComposerRef.current(send.prompt, null, i > 0));
  }, [nodeId, requestedSends]);

  const prevFocusedRef = useRef(isFocused);
  const wasStreamingRef = useRef(streaming);
  const lastQuoteRef = useRef(quotedText);
  const phone = usePhoneLayout();
  useHoldScrollOnKeyboard(scrollRef, phone, () => {
    programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
  });
  useDismissKeyboardOnDrag(scrollRef, phone, () => composerHandle.current?.el);
  // A focus pull that lands while the permission banner still holds the slot
  // (a turn that ends as its request is withdrawn) waits for the composer.
  const composerFocusPendingRef = useRef(false);
  const composerMountedRef = useRef(composerMounted);
  composerMountedRef.current = composerMounted;
  useEffect(() => {
    const becameFocused = !prevFocusedRef.current && isFocused;
    const justFinishedStreaming = wasStreamingRef.current && !streaming;
    const quoteJustAdded = !!quotedText && quotedText !== lastQuoteRef.current;
    prevFocusedRef.current = isFocused;
    wasStreamingRef.current = streaming;
    lastQuoteRef.current = quotedText;

    if (!isFocused) return;
    if (!becameFocused && !justFinishedStreaming && !quoteJustAdded) return;
    // A phone composer rests as one row until it is tapped. Focusing it here
    // would open it after every reply (on iOS without the keyboard), so only
    // a new quote, which the user is about to answer, still focuses it.
    if (phone && !quoteJustAdded) return;

    // Don't steal focus from a control or an open dialog (our composer counts).
    if (focusIsTaken(scrollRef.current)) return;
    if (!composerMountedRef.current) {
      composerFocusPendingRef.current = true;
      return;
    }
    // Dashboard owns horizontal reveal; focus fallback must not scroll it again.
    const frame = requestAnimationFrame(() => inputRef.current?.editor?.commands.focus(undefined, { scrollIntoView: false }));
    return () => cancelAnimationFrame(frame);
  }, [isFocused, streaming, quotedText, phone]);
  useEffect(() => {
    if (!composerFocusPendingRef.current) return;
    if (!isFocused) { composerFocusPendingRef.current = false; return; }
    if (!composerMounted) return;
    composerFocusPendingRef.current = false;
    if (focusIsTaken(scrollRef.current)) return;
    const frame = requestAnimationFrame(() => inputRef.current?.editor?.commands.focus(undefined, { scrollIntoView: false }));
    return () => cancelAnimationFrame(frame);
  }, [composerMounted, isFocused]);

  // The pane's one way to scroll to a message. The message may still be
  // loading, so it is looked for over a few seconds. The mount restore and
  // follow mode stand down, or they would pull the view back to the tail.
  // Frames above it render at their real height as they come into view; hold
  // the message (or the matched text) in the middle until its position settles.
  const jumpToMessage = useCallback((messageId: string | null, options: {
    /** 'message', or the find bar's match: PaneFind's own Range, so it lands on what the counter counts. */
    flash?: 'message' | { range: Range };
    onDone?: () => void;
  } = {}): (() => void) => {
    let frame = 0;
    let tries = 0;
    let cancelFlash: (() => void) | null = null;
    const done = () => options.onDone?.();
    const step = () => {
      const target = messageId ? scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${messageId.replace(/["\\]/g, '\\$&')}"]`) : null;
      if (messageId && !target && ++tries < 300) { frame = requestAnimationFrame(step); return; }
      if (!target) { frame = requestAnimationFrame(() => { frame = requestAnimationFrame(done); }); return; }
      cancelScrollRestoreRef.current?.();
      followRef.current = false;
      let anchor = target;
      const flash = options.flash;
      if (flash === 'message') {
        target.classList.add('t-msg-flash');
        window.setTimeout(() => target.classList.remove('t-msg-flash'), 600);
      } else if (flash) {
        // Find flashes only its match.
        anchor = flash.range.startContainer.parentElement ?? target;
        cancelFlash = flashMatchOverlay(flash.range);
      }
      let last = Number.NaN;
      let stable = 0;
      let settle = 0;
      const hold = () => {
        programmaticScrollUntilRef.current = performance.now() + 200;
        anchor.scrollIntoView({ block: 'center' });
        const top = anchor.getBoundingClientRect().top;
        stable = Math.abs(top - last) < 1 ? stable + 1 : 0;
        last = top;
        frame = requestAnimationFrame(stable < 3 && ++settle < 60 ? hold : done);
      };
      hold();
    };
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); cancelFlash?.(); };
  }, []);

  // A jump asked for from outside the pane (a page's source, search, the ask
  // bar): scroll to the message once, then put the cursor in the composer
  // (Continue), keep it out (Open full chat) or leave focus where it is.
  const sourceJump = useSourceJump(nodeId);
  useEffect(() => {
    if (!sourceJump) return;
    const { token, messageId, focus, flash } = sourceJump;
    let frame = 0;
    let composerTries = 0;
    const finish = () => {
      const editor = inputRef.current?.editor;
      // The message can render before the lazy composer. Keep the explicit
      // Continue request pending until its editor exists, within the same
      // bounded window as message loading; unmount cancels the frame.
      if (focus === 'composer' && !editor && ++composerTries < 300) {
        frame = requestAnimationFrame(finish);
        return;
      }
      claimSourceJump(token);
      const composer = composerHandle.current?.el;
      if (focus === 'composer') editor?.commands.focus('end', { scrollIntoView: false });
      else if (focus === 'message' && composer && document.activeElement instanceof HTMLElement && composer.contains(document.activeElement)) document.activeElement.blur();
    };
    const cancel = jumpToMessage(messageId, { flash: flash ? 'message' : undefined, onDone: finish });
    return () => { cancel(); cancelAnimationFrame(frame); };
  }, [sourceJump, jumpToMessage]);

  const insertMentionTrigger = useCallback(() => inputRef.current?.startMention(), []);

  // "Cite" from the Artifacts drawer: append `@name ` as plain text at the
  // caret. resolveAtMentions parses the wire token on send, so no formal chip
  // node is required. Only the focused pane (event's target nodeId) reacts.
  useEffect(() => {
    const onCite = (e: Event) => {
      const detail = (e as CustomEvent).detail as { nodeId?: string; name?: string } | undefined;
      if (!detail || detail.nodeId !== nodeId || !detail.name) return;
      const ed = inputRef.current?.editor;
      if (!ed) return;
      ed.commands.focus();
      ed.commands.insertContent(`${spaceBeforeMention(ed)}@${detail.name} `);
    };
    window.addEventListener('michi:cite-artifact', onCite);
    return () => window.removeEventListener('michi:cite-artifact', onCite);
  }, [nodeId]);

  const openModelMenu = useCallback((
    anchor: PaneMenuAnchor,
  ) => {
    setAgentMenu(null);
    setModelMenu((current) => current ? null : anchor);
  }, []);
  // Same toggle contract as the model trigger: a second press closes.
  const openAgentMenu = useCallback((anchor: PaneMenuAnchor) => {
    setModelMenu(null);
    setAgentMenu((current) => current ? null : anchor);
  }, []);

  // A node of the shown thread opens beside this pane. Any other node, or any
  // node from the ⌘J panel, opens wherever it lives, never in this slot.
  const openNodePane = useCallback((targetNodeId: string) => {
    if (!embedded && activeProject && findTreeIdForNode(targetNodeId, activeProject) === activeProject.activeTreeId) {
      focusPane(targetNodeId);
      return;
    }
    revealNode(targetNodeId);
  }, [embedded, focusPane, activeProject, revealNode]);

  const handleOpenBranch = useCallback((childNodeId: string) => {
    openNodePane(childNodeId);
  }, [openNodePane]);

  const handleMentionClick = useCallback((name: string, kind: string, mentionNodeId?: string) => {
    if (kind === 'node' && mentionNodeId) {
      // Open the referenced conversation node as a pane
      openNodePane(mentionNodeId);
    } else {
      // Context/artifact mention — find the artifact by name and open it as the drawer would.
      const artifact = mentionContexts.find(
        a => a.name.toLowerCase() === name.toLowerCase(),
      );
      if (!artifact) return;
      void openArtifact(artifact, {
        project: activeProject,
        openArtifactPane,
        onLightbox: () => showArtifactInDrawer(artifact.id),
        onPreview: () => showArtifactInDrawer(artifact.id),
        onError: (message) => toast.error(`Could not open ${artifact.name}: ${message}`),
      });
    }
  }, [openNodePane, mentionContexts, activeProject, openArtifactPane]);

  const handleRetryTurn = useCallback((userIdx: number) => {
    retryLastTurn(nodeId, userIdx, consumeBindingMetaRef.current());
  }, [nodeId, retryLastTurn]);

  const handleRunAgain = useCallback((userIdx: number) => {
    rerunLastTurn(nodeId, userIdx, consumeBindingMetaRef.current());
  }, [nodeId, rerunLastTurn]);

  const handleEditUserMessage = useCallback((text: string) => {
    // Past messages contain wire-format tokens; reset mentions metadata
    // since we can't reconstruct chip anchors from just the text.
    setDraft({ value: text, mentions: [] });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [setDraft]);

  // --- In-place edit state ---
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const handleEditStart = useCallback((messageId: string) => {
    setEditingMessageId(messageId);
  }, []);

  const handleEditCancel = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const handleEditSave = useCallback((messageIndex: number, newText: string) => {
    setEditingMessageId(null);
    editAndResend(nodeId, messageIndex, newText, consumeBindingMetaRef.current());
  }, [nodeId, editAndResend]);

  // DESIGN-v2 §2.8 T3: chips a check-in's post offered are check-in material. One only fills the
  // composer for the user to read and send (never sends, never branches), and the message then
  // says it replies to that post (metaAgentContext.refs), so its turn starts in Ask (T4).
  const followUpsPostId = useMemo(() => {
    const source = n?.followUpsSourceMessageId;
    if (source) {
      if (companionPostRunId(source)) return source;
      return n?.messages.find((m) => m.id === source)?.companionPost ? source : null;
    }
    const lastAssistant = n?.messages.findLast((m) => m.role === 'assistant');
    return lastAssistant && (lastAssistant.companionPost || companionPostRunId(lastAssistant.id)) ? lastAssistant.id : null;
  }, [n?.followUpsSourceMessageId, n?.messages]);
  const fillFromPostChip = useCallback((question: string, postId: string) => {
    persistComposerDraft({ value: question, mentions: [] }, latestQuotedTextRef.current);
    noteCompanionPostReply(nodeId, postId);
    inputRef.current?.focus();
  }, [nodeId, persistComposerDraft]);
  // DESIGN-v2 D8: quoting, commenting on or replying to a selection inside a post carries its text,
  // check-in material, so the message that sends it replies to that post (refs `post`, §2.8 T4).
  const notePostSelection = (range?: Range, anchorMessageId?: string): void => {
    const messageId = anchorMessageId ?? (range ? findMessageIdForRange(range) : undefined);
    if (!messageId) return;
    const message = nLatestRef.current?.messages.find((m) => m.id === messageId);
    if (message?.role === 'assistant' && (message.companionPost || companionPostRunId(message.id))) noteCompanionPostReply(nodeId, message.id);
  };

  const handleContinueFollowUp = useCallback((question: string) => {
    if (followUpsPostId) {
      fillFromPostChip(question, followUpsPostId);
      return;
    }
    sendBesideComposerRef.current(question, null);
  }, [followUpsPostId, fillFromPostChip]);

  const handleBranchFollowUp = useCallback((question: string) => {
    if (followUpsPostId) {
      fillFromPostChip(question, followUpsPostId);
      return;
    }
    if (branchesOff) {
      sendBesideComposerRef.current(question, null);
      return;
    }
    branchBesideComposerRef.current(question, undefined, { anchorMessageId: n?.followUpsSourceMessageId });
  }, [branchesOff, n?.followUpsSourceMessageId, followUpsPostId, fillFromPostChip]);

  // Not offered at all when branches are off (see onBranchFromMessage below).
  const handleBranchFromMessage = useCallback((messageId: string) => {
    prepareBranchScroll();
    void createBlankChild(nodeId, { anchorMessageId: messageId }).catch(() => {});
  }, [createBlankChild, nodeId, prepareBranchScroll]);

  const innerWrap = useMemo<React.CSSProperties>(
    () => (
      contentMaxWidth != null
        ? { maxWidth: contentMaxWidth, marginLeft: 'auto', marginRight: 'auto', width: '100%' }
        : { width: '100%' }
    ),
    [contentMaxWidth],
  );

  // Flash a toast in the header when the agent mode changes. We track the
  // previous currentModeId with a ref so the first render (initial mode) does
  // not flash.
  if (!n) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--term-surface)',
          borderRight: '1px solid var(--term-line)',
          minWidth: 0,
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 'var(--fs-sm)',
        }}
      >
        — empty pane —
      </div>
    );
  }

  // A node can become `deletedAt` while this pane is still open — e.g. it was
  // deleted in another tree/tab, or a backend sync flipped the flag. The tree
  // and sidebar already hide trashed nodes; render a placeholder instead of the
  // chat surface + composer so a lingering pane can't keep chatting with a
  // deleted node. The reactive pane prune (chatStore) closes the pane shortly
  // after; this is the render-time backstop.
  if (n.deletedAt) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--term-surface)',
          borderRight: '1px solid var(--term-line)',
          minWidth: 0,
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 'var(--fs-sm)',
          gap: 4,
        }}
      >
        <div>— this conversation was deleted —</div>
      </div>
    );
  }

  const currentMode = n.currentModeId
    ? availableModes.find((m) => m.id === n.currentModeId)
    : undefined;

  const steerQueuedEntry = async (queueId: string) => {
    const entry = (nLatestRef.current?.pendingQueued ?? []).find((queued) => queued.id === queueId);
    if (!entry || entry.steering || steeringQueueId !== null) return;
    setSteeringQueueId(queueId);
    const expandedValue = expandMentions(entry.value, entry.mentions);
    const finalText = appendAttachmentsSentinel(
      joinMessageParts(entry.commentBlock ?? null, entry.quotedText ?? null, expandedValue, entry.quoteSource),
      entry.attachments,
    );
    try {
      const accepted = await steerMessage(nodeId, finalText, {
        queueId,
        displayText: joinMessageParts(entry.comments?.length ? null : entry.commentBlock ?? null, null, expandedValue),
        userMetadata: {
          quotedText: entry.quotedText,
          ...(entry.quoteSource ? { quoteSource: entry.quoteSource } : {}),
          ...(entry.comments?.length ? { comments: entry.comments as unknown as Array<Record<string, unknown>> } : {}),
          attachments: entry.attachments.length ? entry.attachments.map((attachment) => ({ ...attachment })) : undefined,
        },
      });
      if (accepted) {
        dequeueMessage(nodeId, queueId);
      } else {
        toast.error('Steer was not accepted. The message remains queued.');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Steer failed. The message remains queued.');
    } finally {
      setSteeringQueueId(null);
    }
  };

  // An unsent message back in the composer (a rejected send, a dequeued one)
  // brings its attachments, comments and / pick, in front of the draft's own.
  const restoreUnsentExtras = (unsent: { attachments: PanePendingAttachment[]; comments?: readonly PendingComment[]; slash?: SlashPick }) => {
    if (unsent.slash) slashPickRef.current = unsent.slash;
    setPendingAttachments((current) => [
      ...unsent.attachments,
      ...current.filter((attachment) => !unsent.attachments.some((restored) => restored.absPath === attachment.absPath)),
    ]);
    for (const comment of unsent.comments ?? []) addPendingComment(nodeId, comment.quotedText, comment.body, comment.source);
  };

  const onSubmit = async (branchRequested = false) => {
    if (savingAssistantModel || composerDisabled) return;
    // The assistant's conversation sends a branch request to itself.
    const forceBranch = branchRequested && !branchesOff;
    const submitDraft = latestDraftRef.current;
    // A pending Michi handoff rides on this send as (the start of) its quote.
    // So do the ⌘J assistant's attachments and page context, framed on the
    // wire as attached context rather than a selection from a reply.
    const assistantContext = pendingAssistantContext(nodeId);
    const submitQuoteSource = assistantContext ? ATTACHED_QUOTE_SOURCE : latestQuoteSourceRef.current;
    const submitQuotedText = mergeContextQuote(assistantContext, latestQuotedTextRef.current?.trim() || null);
    // Expand mention chips back to wire-format tokens (`@node:<id>` for nodes,
    // `@<name>` for artifacts) before any downstream parsing — fanout, branch
    // prefix stripping, etc. all see the wire string, not the chip-display.
    const raw = expandMentions(submitDraft.value, submitDraft.mentions).trim();
    const pending = n.pendingComments ?? [];
    // Comment-only sends are allowed: empty text is fine as long as there's
    // at least one pending comment to flush. Attachment-only sends are also
    // allowed.
    if (!raw && pending.length === 0 && pendingAttachments.length === 0) return;
    const slashPick = slashPickRef.current ?? undefined;
    slashPickRef.current = null;
    // A skill row picked for the name of one of Michi's own commands (/explore,
    // /branch) runs the skill, so neither command reads the text.
    const skillPicked = resolveSlashRun(raw, [], pickedSlashEntry(slashPick, slashRuntimeId))?.kind === 'skill';
    clearComposerDraft();
    // A phone composer rests as one row again once the message is on its way;
    // a desktop one lets its height settle to the emptied field. The field
    // empties a frame later (the draft store commits on the next frame).
    // Leaving a phone field lowers the keyboard; the send glide then rides it.
    const loweredKeyboard = composerHandle.current?.settle() ?? false;
    keyboardSendUntilRef.current = loweredKeyboard ? performance.now() + KEYBOARD_SEND_WINDOW_MS : 0;
    const attachmentsForSend = pendingAttachments.map(p => ({ name: p.name, absPath: p.absPath, relPath: p.relPath }));
    // Attachments stay scoped to this turn — the agent reads them via the
    // [Attached files: …] sentinel appended below. We deliberately do NOT
    // promote them to workspace artifacts: that registered every uploaded image
    // as a workspace-level context row, which the first-turn manifest then
    // advertised to *every other* conversation in the workspace, so sibling
    // threads kept reading unrelated screenshots.
    setPendingAttachments([]);

    // Fanout commands (`/fan topic1, topic2`) bypass the normal pipeline. The
    // parser requires text so it short-circuits on comment-only sends
    // automatically; we still guard explicitly so the intent is readable.
    if (raw && !branchesOff && !skillPicked) {
      const fanout = parseFanoutCommand(raw);
      if (fanout) {
        const lastAssistantId = [...(n.messages ?? [])].reverse().find((m) => m.role === 'assistant')?.id;
        await fanoutBranches(nodeId, fanout.topics, { anchorMessageId: lastAssistantId });
        return;
      }
    }

    const { branched: slashRequested, text } = raw && !skillPicked
      ? stripBranchPrefix(raw)
      : { branched: false, text: raw };
    const slashBranched = slashRequested && !branchesOff;

    // With comment-only enabled, `text` can legitimately be empty. Only bail
    // when there's nothing outgoing at all (no comments AND no text AND no
    // attachments).
    if (!text && pending.length === 0 && attachmentsForSend.length === 0) return;
    // Resumed from Michi: if the runtime cannot load the session, its restart
    // starts from these. A branch forks from this node instead.
    // The handoff goes with this send; the stored Michi lines shrink to the last answer.
    noteAssistantContextSent(nodeId);

    // Compute commentBlock BEFORE the queue branch so it can be folded into
    // the queue payload. quotedText is already captured in scope from the
    // pre-clear draft snapshot.
    const commentBlock = pending.length > 0 ? formatCommentsBlock(pending) : null;
    const queuedQuote = submitQuotedText;

    // Streaming + plain Enter (no force, no slash-branch) → queue path.
    // Branch button still bypasses (forceBranch=true) and calls
    // createChildChat as before. Pending-comment-only sends also queue
    // during streaming (text empty, but comments exist) — otherwise they
    // would fall through to sendMessage on a streaming node and the
    // chatStore guard would no-op them with a console warning.
    if (
      streaming &&
      !forceBranch &&
      !slashBranched &&
      (text || attachmentsForSend.length > 0 || pending.length > 0)
    ) {
      queueMessage(nodeId, {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        value: submitDraft.value,           // literal text (chip labels intact)
        mentions: [...submitDraft.mentions],
        attachments: attachmentsForSend.map(a => ({ ...a })),
        quotedText: queuedQuote ?? undefined,
        ...(queuedQuote && submitQuoteSource ? { quoteSource: submitQuoteSource } : {}),
        commentBlock: commentBlock ?? undefined,
        ...(pending.length ? { comments: pending.map(comment => ({ ...comment })) } : {}),
        ...(slashPick ? { slash: slashPick } : {}),
        queuedAt: Date.now(),
      });
      // Comments were folded into the queue entry — clear them off the node
      // so they don't double-fire when the next idle send runs.
      if (pending.length > 0) clearPendingComments(nodeId);
      return;
    }

    const baseFinal = joinMessageParts(commentBlock, submitQuotedText, text, submitQuoteSource);
    const finalText = appendAttachmentsSentinel(baseFinal, attachmentsForSend);
    if (pending.length > 0) clearPendingComments(nodeId);

    // The wire payload (`finalText`) carries the flattened quote + sentinel.
    // The optimistic user message renders only the bare prose plus structured
    // quotedText / attachments / comments, so the bubble can show them as modules.
    const meta = {
      // The store puts the rejected text back in front of the draft.
      rejectedDraft: { ...submitDraft, quotedText: submitQuotedText ?? undefined, ...(submitQuoteSource ? { quoteSource: submitQuoteSource } : {}) },
      onRejected: () => restoreUnsentExtras({ attachments: pendingAttachments, comments: pending, slash: slashPick }),
      quotedText: submitQuotedText ?? undefined,
      ...(submitQuotedText && submitQuoteSource ? { quoteSource: submitQuoteSource } : {}),
      attachments: attachmentsForSend.length > 0 ? attachmentsForSend.map(a => ({ ...a })) : undefined,
      comments: pending.length > 0 ? pending.map(c => ({ ...c })) : undefined,
      displayText: text,
      mentions: submitDraft.mentions.length > 0
        ? submitDraft.mentions.map(m => ({ kind: m.kind, refId: m.refId, label: m.label }))
        : undefined,
      ...(slashPick ? { slash: slashPick } : {}),
      ...(slashRuntimeId ? { slashRuntimeId } : {}),
      // Per-node runtime binding: pass resolved binding to ensureSession
      // so it uses the right runtime/model/effort instead of the global config.
      ...consumeBindingMeta(),
    };

    // Comment-only sends do not branch: branching semantics tie to the user's
    // current turn, and flushing pending reply-to-selection comments is the
    // opposite of starting a new line of inquiry.
    const shouldBranch =
      !!text && shouldBranchOnSubmit({ forceBranch, slashBranched, streaming });
    if (shouldBranch) {
      // Keep the user on the current pane — the branch streams in the
      // background and appears in the sidebar / Map (see createChildChat).
      prepareBranchScroll();
      await createChildChat(nodeId, finalText, meta, { focus: false });
    } else {
      sendMessage(nodeId, finalText, meta);
    }
  };

  const canAttach = !attachmentRestricted && (!!getElectron()?.chooseFiles || !!activeProject);
  const sendDisabledBase = !draftHasText
    && pendingAttachments.length === 0
    && (n.pendingComments?.length ?? 0) === 0;
  const sendDisabled = sendDisabledBase || savingAssistantModel || composerDisabled;

  const isError = n.status === 'error';
  const planStep = multiModelBranch && failedPlanStep(n) ? multiModelBranch : undefined;
  // composerEmpty mirrors the same predicate used in the onSubmit early-return above.
  const composerEmpty = sendDisabledBase;
  const sendMode: PaneComposerSendMode =
    composerEmpty && streaming ? 'stop'
    : composerEmpty && isError ? 'retry'
    : 'send';

  const PANE_DRAG_MIME = 'application/x-michi-pane-id';

  const handlePaneDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const next: 'left' | 'right' = e.clientX < r.left + r.width / 2 ? 'left' : 'right';
    // dragOver fires ~60 Hz; gate setState so an unchanged side doesn't
    // re-render the whole pane (MessageBlock + composer) every tick.
    setPaneDropSide((cur) => (cur === next ? cur : next));
  };
  const handlePaneDragLeave = (e: React.DragEvent) => {
    // Ignore leaves into descendants
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
    setPaneDropSide(null);
  };
  const handlePaneDrop = (e: React.DragEvent) => {
    const fromId = e.dataTransfer.getData(PANE_DRAG_MIME);
    setPaneDropSide(null);
    if (!fromId || fromId === nodeId) return;
    e.preventDefault();
    reorderPane(fromId, nodeId);
  };

  return (
    <div
      data-node-id={nodeId}
      className="terminal-pane"
      data-density={prefs.terminalDensity}
      onMouseDown={embedded ? undefined : () => {
        focusPane(nodeId);
        setFocusedNodeId(nodeId);
      }}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
        handleDragEnter(e);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
          handlePaneDragOver(e);
          return;
        }
        handleDragOver(e);
      }}
      onDragLeave={(e) => {
        if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
          handlePaneDragLeave(e);
          return;
        }
        handleDragLeave(e);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
          handlePaneDrop(e);
          return;
        }
        void handleDrop(e);
      }}
      style={paneShellStyle}
    >
      {(n.spawnedByAgent || n.multiModelRunId) && (
        <div
          data-testid="pane-spawn-banner"
          style={{
            padding: '6px 14px',
            background: 'var(--term-mauve-f)',
            borderBottom: '1px solid var(--term-line)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--term-mauve)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 700 }}>⎇</span>
          <span style={{ letterSpacing: 'var(--ls-wide)', flex: 1, minWidth: 0 }}>
            {n.multiModelRunId
              ? n.freshContext ? 'multi-model branch · fresh context, prompt only' : `multi-model branch${parentTitle ? ` · inherits ${parentTitle}` : ''}`
              : `spawned by agent${parentTitle ? ` · inherits ${parentTitle}` : ''}`}
          </span>
          {n.multiModelRunId && multiModelBranch && (
            <button
              type="button"
              className="t-hover-fg"
              data-testid="pane-open-plan"
              onClick={multiModelBranch.openPlan}
              style={{
                flexShrink: 0,
                // A larger target on a phone, without a taller banner.
                padding: phone ? '8px 10px' : '2px 6px',
                margin: phone ? '-8px -10px' : '-2px -6px',
                border: 'none',
                background: 'none',
                color: 'var(--term-mauve)',
                font: 'inherit',
                fontWeight: 600,
                letterSpacing: 'var(--ls-wide)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Open plan
            </button>
          )}
        </div>
      )}

      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {!readOnly && <SelectionActions
          containerRef={scrollRef}
          onQuote={(q, range) => {
            notePostSelection(range);
            setQuotedText(q);
          }}
          onBranch={(q, p, anchorMessageId, range) => {
            if (branchesOff) {
              // A reply here, quoting the selection, instead of a branch
              // (queued while the assistant is still answering).
              notePostSelection(range, anchorMessageId);
              sendBesideComposer(p, q);
              return;
            }
            branchBesideComposer(formatQuotedMessage(q, p), { quotedText: q, displayText: p }, { anchorMessageId });
          }}
          onComment={(q, body, range) => {
            notePostSelection(range);
            addPendingComment(nodeId, q, body);
          }}
        />}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: prefs.paneTopFadeHeight,
          background: 'var(--term-pane-bg)',
          maskImage: 'linear-gradient(to bottom, black, transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, black, transparent)',
          pointerEvents: 'none',
          zIndex: 2,
        }}
      />
      <div
        ref={scrollRef}
        onWheel={(e) => {
          if (e.deltaY < 0) markUserScrollIntent();
        }}
        onTouchMove={markUserScrollIntent}
        onPointerDown={markUserScrollIntent}
        onClickCapture={(e) => {
          // Capture runs before the toggle's own handler (which may stop
          // propagation), so this is the height before the click's change.
          const block = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-msg-id]') : null;
          const record: UserClickLayout = {
            scrollHeight: e.currentTarget.scrollHeight,
            block,
            blockHeight: block?.offsetHeight ?? 0,
          };
          userClickLayoutRef.current = record;
          window.setTimeout(() => {
            if (userClickLayoutRef.current === record) userClickLayoutRef.current = null;
          }, USER_CLICK_LAYOUT_WINDOW_MS);
        }}
        onKeyDown={markUserScrollIntentFromKey}
        onScroll={(e) => {
          // Keep the persisted anchor fresh so a refresh (which skips React
          // unmount) still restores to the latest position.
          schedulePaneScrollSave();
          const el = e.currentTarget;
          const prev = prevScrollTopRef.current;
          const cur = el.scrollTop;
          const distFromBottom = el.scrollHeight - cur - el.clientHeight;
          const programmatic = performance.now() < programmaticScrollUntilRef.current;
          if (programmatic) {
            prevScrollTopRef.current = cur;
            return;
          }
          const userInitiated = performance.now() < userScrollIntentUntilRef.current;
          if (userInitiated && cur < prev - 4 && distFromBottom > 64) {
            followRef.current = false;
          } else if (distFromBottom < 24) {
            followRef.current = true;
          }
          // Reading upward toward the start of the loaded page fetches the
          // previous one before the reader reaches it. Only the reader's own
          // scrolling counts: mount positioning starts at the top for a frame.
          if (userInitiated && cur < prev && cur < el.clientHeight * OLDER_PREFETCH_VIEWPORTS
            && nLatestRef.current?.historyBefore) {
            void loadOlder();
          }
          prevScrollTopRef.current = cur;
        }}
        className="term-scrollbar terminal-pane__transcript"
        data-density={prefs.terminalDensity}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowAnchor: 'none',
          // Sides + top scale with density (index.css); bottom always reserves clearance for
          // the floating composer (~card height + 12px gutter on each side, plus a
          // bit extra for the optional quote bar) so the last message can scroll
          // above the card instead of being trapped behind it.
          // The top also clears the pane-top fade overlay, so the first
          // message is not drawn under it while the pane is scrolled to top.
          paddingTop: `calc(${prefs.paneTopFadeHeight || 0}px + var(--pane-pad-top))`,
          paddingLeft: 'var(--pane-gutter)',
          paddingRight: 'var(--pane-gutter)',
          // Reserve clearance equal to the measured composer height + the
          // card's bottom inset + the tail gap, so the last line of content
          // scrolls clear of the card rather than resting against it.
          // A docked phone selection can add room below it (SelectionActions).
          paddingBottom: `calc(${
            composerMounted
              ? composerHeight + COMPOSER_CLEARANCE
              : COMPOSER_BOTTOM_INSET
          }px + var(${DOCK_ROOM_VAR}, 0px))`,
          fontSize: 'var(--pane-font-size)',
          lineHeight: 'var(--pane-leading)',
          color: 'var(--term-fg)',
        }}
      >
        <PaneMessageList
          node={n}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
          mergeSourceLabels={mergeSourceLabels}
          prefs={prefs}
          contentStyle={innerWrap}
          streaming={streaming}
          onRetryTurn={handleRetryTurn}
          onRunAgain={handleRunAgain}
          onEditUserMessage={handleEditUserMessage}
          onContinueFollowUp={handleContinueFollowUp}
          onBranchFollowUp={handleBranchFollowUp}
          followUpsDisabled={false}
          anchorsByMessage={anchorsByMessage}
          onOpenBranch={handleOpenBranch}
          onMentionClick={handleMentionClick}
          onBranchFromMessage={branchesOff ? undefined : handleBranchFromMessage}
          contextNames={contextNamesSet}
          editingMessageId={editingMessageId}
          onEditStart={handleEditStart}
          onEditSave={handleEditSave}
          onEditCancel={handleEditCancel}
          onTestConnection={handleTestConnection}
          readOnly={readOnly}
          planStep={planStep}
          replySources={memorySetting}
        />
      </div>
      {phone && (
        <TranscriptScrubber
          scrollRef={scrollRef}
          messages={n.messages}
          hasOlder={Boolean(n.historyBefore)}
          top={(prefs.paneTopFadeHeight || 0) + 6}
          bottom={(composerMounted ? composerHeight + COMPOSER_CLEARANCE : COMPOSER_BOTTOM_INSET) + 8}
          onScrub={handleScrub}
        />
      )}
      <MergeBanner nodeId={nodeId} />
      <AnimatePresence initial={false} mode="wait">
      {n.pendingPermission ? (
        <PermissionSlot key="permission" room={composerHeight + 12} onLeave={recordSlotSwap}>
          <PermissionBanner
            permission={n.pendingPermission}
            onRespond={(optionId) => resolvePermission(nodeId, optionId)}
          />
        </PermissionSlot>
      ) : readOnly ? null : (
      <ComposerSlot key="composer">
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          // On a phone the strip also runs under the card and fades out 24px
          // above it (below COMPOSER_TAIL_GAP, so settled text is never dimmed),
          // softening text that scrolls under the card's top edge.
          height: phone ? COMPOSER_BOTTOM_INSET + composerHeight + COMPOSER_TOP_FADE : 12,
          background: 'var(--term-pane-bg, var(--term-surface))',
          ...(phone ? {
            maskImage: `linear-gradient(to top, black calc(100% - ${COMPOSER_TOP_FADE}px), transparent)`,
            WebkitMaskImage: `linear-gradient(to top, black calc(100% - ${COMPOSER_TOP_FADE}px), transparent)`,
          } : null),
          zIndex: 1,
          pointerEvents: 'none',
        }}
      />
      <ComposerShell
        ref={composerHandleRef}
        position="absolute"
        contentMaxWidth={contentMaxWidth ?? null}
        dragHover={dragHover}
        toolbarRef={composerToolbarRef}
        collapsible
        hasContent={draftHasText}
        holdOpen={!!agentMenu || !!modelMenu}
        collapsedHint="Reply…"
        onDragEnter={(e) => {
          // Always preventDefault so the browser doesn't navigate to a
          // dropped file in pure-browser dev mode.
          e.preventDefault();
          e.stopPropagation();
          if (!canAttach) return;
          setDragHover(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!canAttach) return;
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Ignore leaves into our own descendants — only clear when truly leaving.
          if (composerHandle.current?.el?.contains(e.relatedTarget as Node | null)) return;
          setDragHover(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragHover(false);
          void handleDrop(e);
        }}
        preBlocks={
          <>
            {typeof composerPreBlocks === 'function' ? composerPreBlocks(draftHasText) : composerPreBlocks}
            {n.commandResult && <ChatCommandResult result={n.commandResult} onDismiss={() => dispatch({ type: 'command-result', nodeId, result: null })} />}
            <UploadProgressBar progress={uploadProgress} />
            <PaneComposerPreBlocks
              node={n}
              quoteMaxLines={prefs.quoteMaxLines}
              quotedText={quotedText}
              pendingAttachments={pendingAttachments}
              workspaceId={activeProject?.id}
              canSteerQueued={streaming && shouldSteerInsteadOfQueue(agentStatus?.capabilityDescriptor)}
              slashEntries={slashEntries}
              steeringQueueId={steeringQueueId}
              onSteerQueued={(queueId) => { void steerQueuedEntry(queueId); }}
              onRestoreQueued={(queueId) => {
                // Restore the entry to the composer so the user can edit or
                // branch it, in front of what was typed since, as a rejected
                // send comes back. Order: read entry, splice from queue, populate draft.
                const entry = (n.pendingQueued ?? []).find((x) => x.id === queueId);
                if (!entry) return;
                dequeueMessage(nodeId, queueId);
                const legacyCommentPrefix = !entry.comments?.length && entry.commentBlock ? entry.commentBlock + '\n\n' : '';
                const restored = mergeComposerDraft(
                  { ...prependToDraft(legacyCommentPrefix, { value: entry.value, mentions: entry.mentions }),
                    quotedText: entry.quotedText, quoteSource: entry.quoteSource },
                  { ...latestDraftRef.current, quotedText: latestQuotedTextRef.current ?? undefined, quoteSource: latestQuoteSourceRef.current },
                );
                if (restored) persistComposerDraft(restored, restored.quotedText ?? null, restored.quoteSource ?? null);
                restoreUnsentExtras({
                  attachments: entry.attachments.map((a, idx) => ({
                    id: `att-restored-${Date.now()}-${idx}`,
                    name: a.name,
                    absPath: a.absPath,
                    relPath: a.relPath,
                  })),
                  comments: entry.comments,
                  slash: entry.slash,
                });
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              onEditPendingComment={(commentId, body) => editPendingComment(nodeId, commentId, body)}
              onRemovePendingComment={(commentId) => removePendingComment(nodeId, commentId)}
              onDismissQuote={() => setQuotedText(null)}
              onRemovePendingAttachment={removePendingAttachment}
            />
          </>
        }
        input={
          <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
            <LazyMentionEditor
              ref={inputRef}
              value={draft.value}
              mentions={draft.mentions}
              onChange={setDraft}
              className="hide-sb"
              artifacts={mentionContexts}
              sameTreeNodes={sameTreeNodes}
              crossTreeNodes={crossTreeNodes}
              currentNodeId={nodeId}
              slashEntries={slashEntries}
              onSlashOpen={loadSlashCatalog}
              onSlashPick={(entry) => { slashPickRef.current = entry ? { entry, runtimeId: slashRuntimeId } : null; }}
              availableModes={availableModes}
              currentModeId={n.currentModeId}
              onSwitchAgent={(modeId) => switchAgent(nodeId, modeId).catch(() => {})}
              onSubmit={({ branch }) => void onSubmit(branch)}
              onPaste={(e) => { void handlePaste(e as unknown as React.ClipboardEvent<HTMLTextAreaElement>); }}
            />
          </div>
        }
        toolbarLeft={
          <PaneComposerToolbarLeft
            canAttach={canAttach}
            // Spaces uses the shared context controls; the global assistant keeps its restricted toolbar.
            contextTools={!isAssistantConversation || spacesAssistant}
            enableAgentChip={!isAssistantConversation}
            toolbarTier={toolbarTier}
            currentMode={currentMode}
            currentModeId={n.currentModeId ?? undefined}
            availableModesCount={availableModes.length}
            agentStatus={agentStatus}
            onPickFile={() => void onPickFile()}
            onInsertMentionTrigger={insertMentionTrigger}
            onOpenAgentMenu={openAgentMenu}
            agentMenuOpen={!!agentMenu}
          />
        }
        toolbarRight={
          <>
          {memorySetting && (
            <ConversationMemoryControl apiBase={workspaceBackendApiBase(n.projectId)} nodeId={nodeId} toolbarTier={toolbarTier} disabled={streaming} />
          )}
          {permissionControl && !permissionPreferences.global && <ComposerPermissionControl apiBase={workspaceBackendApiBase(n.projectId)}
            mode={effectiveChatPermissionChoice(permissionPreferences, n)}
            runtimeIds={[resolvedBinding.runtime]} approveForMeRuntimeIds={approveForMeRuntimeIds(agentStatus)}
            compact={toolbarTier > 0} disabled={streaming || permissionPreferences.loading}
            yoloRestartHint={claudeWorkflowRunning ? 'Claude restarts on your next message, which stops the running workflow.' : undefined}
            onChange={(mode) => setChatPermissionMode(nodeId, mode)} />}
          <ComposerModelTrigger
            toolbarTier={toolbarTier}
            agentStatus={agentStatus}
            resolvedBinding={resolvedBinding}
            catalogCapabilities={catalogCapabilities}
            providerModels={providerModels}
            providers={catalogProviders}
            isStreaming={streaming}
            locked={isAssistantConversation && !currentAssistant}
            modelMenuOpen={!!modelMenu && !streaming}
            onOpenModelMenu={openModelMenu}
            switchHint={claudeWorkflowRunning ? 'Switching the model also stops the running workflow.' : undefined}
            ultracode={ultracode}
          />
          <PaneComposerActions
            allowBranch={!branchesOff}
            draftHasText={draftHasText}
            sendMode={sendMode}
            streaming={streaming}
            sendDisabled={sendDisabled}
            onBranch={() => void onSubmit(true)}
            onSend={() => void onSubmit()}
            onStop={() => cancelStream(nodeId)}
            // A failed plan step is the run's to retry (or the plan's to show), as in its error tail.
            onRetry={planStep
              ? planStep.retry ?? planStep.openPlan
              : () => retryLastTurn(nodeId, undefined, consumeBindingMeta())}
            inspectOriginal={!planStep && turnErrorAction(n.errorKind) === 'inspect-existing-turn'}
            checkingOriginal={!planStep && n.errorRecovery === 'checking'}
            resumeTurn={!planStep && turnErrorAction(n.errorKind) === 'resume-turn'}
            contextUsagePercentage={n.contextUsagePercentage}
            usageSummary={n.usageSummary}
            stopHint={claudeWorkflowRunning ? 'Also stops the running workflow.' : undefined}
          />
          </>
        }
      />
      </ComposerSlot>
      )}
      </AnimatePresence>
      <PaneFind
        open={findOpen}
        rootRef={scrollRef}
        focusNonce={findFocusNonce}
        onClose={() => setFindOpen(false)}
        onVisitMatch={(range) => jumpToMessage(
          range.startContainer.parentElement?.closest('[data-msg-id]')?.getAttribute('data-msg-id') ?? null,
          { flash: { range } },
        )}
      />
      </div>

      {/* The ask_user card renders inline in the message flow (see
          InlineUserInputSegment in MessageBlock), not as a docked overlay, so
          it scrolls with the transcript and never shifts the page or hides
          behind the composer. */}
      <PaneAgentMenus
        agentMenu={agentMenu}
        modelMenu={modelMenu}
        disabled={streaming || savingAssistantModel}
        availableModes={availableModes}
        agentModesLoading={agentModesLoading}
        agentModesError={agentModesError}
        onRetryAgentModes={retryAgentModes}
        currentModeId={n.currentModeId ?? undefined}
        agentStatus={currentAssistant && agentStatus ? { ...agentStatus, availableRuntimes: agentStatus.availableRuntimes?.filter(runtime => assistantInfo?.supportedRuntimes.includes(runtime.id)) } : agentStatus}
        resolvedBinding={resolvedBinding}
        catalogCapabilities={catalogCapabilities}
        providerModels={providerModels}
        providers={catalogProviders}
        modelsLoading={modelsLoading}
        modelsWaiting={modelsWaiting}
        modelsError={modelsError}
        defaultModeId={defaultModeId}
        runtimeId={agentStatus?.runtime}
        onSwitchAgent={(modeId) => void switchAgent(nodeId, modeId)}
        onSwitchRuntime={(runtimeId) => currentAssistant ? saveAssistantModel({ runtimeId, providerId: null, modelId: null, reasoning: null }) : setPendingBindingOverride({ runtime: runtimeId })}
        onSaveProvider={(provider) => {
          if (currentAssistant) return saveAssistantModel({ providerId: provider, modelId: null });
          // Provider change invalidates the pending model (models are
          // provider-scoped); resolution re-derives a valid one.
          setPendingBindingOverride((prev) => ({ ...prev, provider, model: undefined }));
        }}
        onSaveModel={(model) => {
          if (currentAssistant) return saveAssistantModel({ modelId: model });
          setPendingBindingOverride((prev) => ({ ...prev, model }));
        }}
        onSaveReasoning={(reasoning) => {
          if (currentAssistant) return saveAssistantModel({ reasoning });
          setPendingBindingOverride((prev) => ({ ...prev, reasoning }));
        }}
        ultracode={ultracode}
        onSaveUltracode={ultracode ? (enabled) => setChatUltracode(nodeId, enabled) : undefined}
        onRetryModels={retryModels}
        onCloseAgentMenu={() => setAgentMenu(null)}
        onCloseModelMenu={() => setModelMenu(null)}
      />

      <PaneDropIndicator side={paneDropSide} />
      <FileDropOverlay visible={dropzoneVisible} fileCount={droppedFileCount} />
    </div>
  );
}

/*
 * The bottom of a pane is one slot (AnimatePresence mode="wait"): the
 * composer or, while the agent waits on an approval, the permission banner
 * in its place. The outgoing side fades and stops being live at once (inert,
 * hidden from assistive tech: a stale Allow must not answer twice); then the
 * incoming side comes in. The composer floats over the transcript with a
 * matching bottom clearance while the banner takes room in the pane's flow,
 * so the banner grows from the room the composer took (card + gutter) to its
 * own height and gives that room back as it leaves. The transcript's bottom
 * edge therefore moves once, smoothly, and the follow pin tracks it through
 * the viewport's resize. A pane that mounts with either side shows it as it
 * is (initial={false}).
 */
const SLOT_FADE_OUT = { duration: DUR.soft, ease: EASE.out };
const SLOT_FADE_IN = { duration: 0.14, ease: 'linear' } as const;

function ComposerSlot({ children }: { children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: SLOT_FADE_IN }}
      exit={{ opacity: 0, transition: SLOT_FADE_OUT }}
      inert={!present}
      aria-hidden={present ? undefined : true}
    >
      {children}
    </motion.div>
  );
}

function PermissionSlot({ room, onLeave, children }: { room: number; onLeave: () => void; children: React.ReactNode }) {
  const present = useIsPresent();
  // Runs in the commit that removes the banner, before its box leaves the
  // DOM and the composer takes its place.
  useLayoutEffect(() => () => onLeave(), [onLeave]);
  return (
    <motion.div
      initial={{ height: room, opacity: 0 }}
      animate={{
        height: 'auto',
        opacity: 1,
        transition: {
          height: { duration: DUR.enter, ease: EASE.drawer },
          opacity: { ...SLOT_FADE_IN, delay: 0.06 },
        },
      }}
      exit={{
        height: room,
        opacity: 0,
        transition: { height: { duration: DUR.collapse, ease: EASE.drawer }, opacity: SLOT_FADE_OUT },
      }}
      inert={!present}
      aria-hidden={present ? undefined : true}
      style={{ overflow: 'hidden', flexShrink: 0 }}
    >
      {children}
    </motion.div>
  );
}

const MemoizedTPane = React.memo(TPane);

MemoizedTPane.displayName = 'TPane';

export default MemoizedTPane;
