import { streamMessage } from '../services/api';
import type { StreamHandlers } from '../services/api';
import { parseFollowUpSentinelLine } from 'michi-shared';
import { withMetaAgentTurnContext } from '../services/api/assistant';
import { parseInlineFollowUpsSentinel } from './assistantParsing';
import type { ChatAction } from './chatTypes';
import { subagentActivityAction, subagentListAction } from './subagentStreamActions';
import { createTurnStreamEffects, doneOutcome } from './turnStreamEffects';
import { savedTurnResult } from './turnErrorRecovery';

type Ref<T> = { current: T };

export type TurnEndReason = 'done' | 'cancel' | 'error';

// Sentinel prefixes the inline metadata side-effect dispatcher holds. Visible
// stripping is separate (shared's scanTurnMetadataSentinels), but this list
// must match shared's even though only titles and follow-ups dispatch here,
// so a sentinel quoted inside a branch overview is not dispatched on its own.
// sentinelParity.test.ts keeps the two lists equal.
const SENTINEL_PREFIXES = ['[TITLE:', '[BRANCH-OVERVIEW:', '[FOLLOW-UP'];
const FOLLOW_UP_ITEM_PREFIX_RE = /^\[FOLLOW-UP\s+[1-3]/i;

function couldStillBeSentinel(buf: string): boolean {
  const upper = buf.toUpperCase();
  return SENTINEL_PREFIXES.some(
    (p) => (upper.length <= p.length ? p.startsWith(upper) : upper.startsWith(p)),
  );
}

interface RunChatStreamOptions {
  prompt: string;
  nodeId: string;
  assistantId: string;
  workspaceId?: string;
  dispatch: (action: ChatAction) => void;
  // Kept in the type for backward-compat with the chatStore caller. The
  // runner no longer owns a side buffer; chunk/thought events go straight to
  // the reducer's assistant blocks.
  assistantTextBufs: Ref<Record<string, string>>;
  cancelFns: Ref<Record<string, () => void>>;
  displayText?: string;
  rejectedDraft?: import('./chatTypes').ComposerDraft;
  onRejected?: () => void;
  enableKiroSidecarTitle?: boolean;
  userMetadata?: {
    quotedText?: string;
    quoteSource?: import('../lib/quoteFormat').AnyQuoteSource;
    attachments?: Array<{ name: string; absPath: string }>;
    comments?: Array<Record<string, unknown>>;
    /** What a message to the agent referred to, kept on the stored row so a retry after a reload still sends it. */
    companionRefs?: import('michi-shared').CompanionTurnRef[];
  };
  /** The skill this message runs; see streamMessage. */
  skill?: import('michi-shared').SkillInvocationRequest;
  /** The backend would not run `skill`: it has no such skill for this chat (skill_not_found), or runs none (skills_unavailable). */
  onSkillRejected?: () => void;
  /**
   * The agent's conversation: the metaAgentContext captured when the user sent
   * this message (UserSendMeta.metaAgentContext). The request carries it, not
   * what the screen shows now; undefined leaves it to the registered provider.
   */
  metaAgentContext?: import('michi-shared').MetaAgentChatTurnContext | null;
  extraHandlers?: Omit<Partial<StreamHandlers>, 'onTurnStart' | 'onDone' | 'onAborted' | 'onError' | 'onErrorPayload' | 'onSavedTurn'>;
  /** Fires after finishAsDone completes — safe place for side-effects like notifications. */
  onStreamComplete?: () => void;
  /**
   * Fires from each terminal path (done / cancel / error) immediately after
   * the corresponding dispatch + cleanup. Used by the chat store to flush a
   * queued message on natural turn end / cancel and to mark the queue errored
   * on stream error.
   */
  onTurnEnd?: (reason: TurnEndReason, nodeId: string) => void;
}

export function runChatStream({
  prompt,
  nodeId,
  assistantId,
  workspaceId,
  dispatch,
  cancelFns,
  displayText,
  rejectedDraft,
  onRejected,
  enableKiroSidecarTitle,
  userMetadata,
  skill,
  onSkillRejected,
  metaAgentContext,
  extraHandlers,
  onStreamComplete,
  onTurnEnd,
}: RunChatStreamOptions): () => void {
  // ── Sentinel side-effect dispatcher ──
  // The runner is now a thin pipe: every SSE text chunk goes straight to the
  // reducer as an answer block append. Assistant blocks are the source of
  // truth.
  //
  // The PREAMBLE asks the agent to wrap metadata in `[TITLE: ...]` and
  // `[FOLLOW-UP n/3: ...]` sentinels. We still want to react to those
  // mid-stream — set the sidebar title as soon as it's known, populate
  // follow-ups incrementally — so we walk the raw stream char-by-char,
  // accumulate `[...]` segments, and dispatch a side-effect action when a
  // sentinel completes. We do NOT modify or hide the raw text here; visible
  // projection (sentinel stripping) is render-time work.
  let bracketHold = '';
  // A follow-up stays held until its line ends, so a `]` inside the question
  // only updates it; each `]` re-reads the line.
  let followUpLine = false;
  let openTicks = 0; // backtick run that opened the current inline code span
  let tickRun = 0; // backticks seen since the last other character
  let titleDispatched = false;
  let visibleResponseCompleteDispatched = false;
  let currentAssistantId = assistantId;
  let currentTurnId = '';
  let lastAcceptedTurnId = '';
  let lastAcceptedSeq = -1;
  let streamCancel: (() => void) | null = null;
  const streamedFollowUps: string[] = [];
  const MAX_BRACKET_HOLD = 4096; // safety cap for malformed / unclosed brackets
  const effects = createTurnStreamEffects({ nodeId, workspaceId: () => workspaceId });
  const observePageTool = (tool: Parameters<typeof effects.tool>[0] & { turnId?: string }) => {
    effects.tool(tool, tool.turnId || currentTurnId || currentAssistantId);
  };

  const dispatchFollowUps = () => {
    const followUps = streamedFollowUps
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 3);
    if (followUps.length > 0) {
      dispatch({ type: 'set-follow-ups', nodeId, followUps });
    }
    const completeSet = [0, 1, 2].every(
      (index) => streamedFollowUps[index]?.trim().length > 0,
    );
    if (completeSet && !visibleResponseCompleteDispatched) {
      visibleResponseCompleteDispatched = true;
      dispatch({
        type: 'visible-response-complete',
        nodeId,
        assistantId: currentAssistantId,
      });
    }
  };

  const handleSentinelCompletion = (segment: string): void => {
    const upper = segment.toUpperCase();
    if (upper.startsWith('[TITLE:')) {
      if (!titleDispatched) {
        const title = segment.slice('[TITLE:'.length, -1).trim();
        if (title) {
          dispatch({ type: 'set-title', nodeId, title });
          titleDispatched = true;
        }
      }
      return;
    }
    const legacy = parseInlineFollowUpsSentinel(segment);
    if (legacy.length > 0) {
      streamedFollowUps.splice(0, streamedFollowUps.length, ...legacy);
      dispatchFollowUps();
    }
  };

  const handleFollowUpLine = (held: string): void => {
    const items = parseFollowUpSentinelLine(held);
    if (items.length === 0) return;
    for (const item of items) streamedFollowUps[item.index] = item.followUp;
    dispatchFollowUps();
  };

  const cleanup = () => {
    if (streamCancel && cancelFns.current[nodeId] === streamCancel) {
      delete cancelFns.current[nodeId];
    }
  };

  const trackSeq = (seq?: number, turnId?: string): void => {
    if (turnId) currentTurnId = turnId;
  };

  const handlers: StreamHandlers = {
    onEnvelope: (envelope) => {
      if (envelope.turnId) currentTurnId = envelope.turnId;
      if (typeof envelope.seq !== 'number' || !envelope.turnId) return true;
      if (lastAcceptedTurnId === envelope.turnId && envelope.seq <= lastAcceptedSeq) return false;
      lastAcceptedTurnId = envelope.turnId;
      lastAcceptedSeq = envelope.seq;
      dispatch({ type: 'apply-seq', nodeId, turnId: envelope.turnId, seq: envelope.seq });
      return true;
    },
    onTurnStart: (data) => {
      const env = data as typeof data & { seq?: number };
      if (data.assistantId && data.assistantId !== currentAssistantId) {
        dispatch({
          type: 'realign-assistant-id',
          nodeId,
          fromId: currentAssistantId,
          toId: data.assistantId,
        });
        currentAssistantId = data.assistantId;
      } else if (data.assistantId) {
        currentAssistantId = data.assistantId;
      }
      dispatch({ type: 'active-turn', nodeId, assistantId: currentAssistantId, turnId: data.turnId });
      // What the route decided about this message (DESIGN-v2 §1.3) reaches the sender on its turn_start too.
      if (data.userMetadata || data.assistantMetadata) {
        dispatch({
          type: 'turn-start-metadata',
          nodeId,
          assistantId: currentAssistantId,
          ...(data.userMetadata ? { userMetadata: data.userMetadata } : {}),
          ...(data.assistantMetadata ? { assistantMetadata: data.assistantMetadata } : {}),
        });
      }
      trackSeq(env.seq, data.turnId);
    },
    onChunk: (text, seq, _assistantId, turnId, observedAt) => {
      trackSeq(seq, turnId);
      // Forward raw chunk to reducer immediately as block-first assistant data.
      dispatch({ type: 'chunk', nodeId, assistantId: currentAssistantId, text, observedAt });

      // Walk the raw chunk char-by-char for sentinel side effects only. The
      // text itself is already on its way to the reducer; nothing here
      // affects what gets stored or rendered.
      for (const ch of text) {
        // Track inline code as shared's scanner does: a `[` inside a backtick
        // span on its line is quoted prose, never a sentinel.
        if (ch === '`') {
          tickRun += 1;
        } else if (tickRun > 0) {
          if (openTicks === 0) openTicks = tickRun;
          else if (tickRun === openTicks) openTicks = 0;
          tickRun = 0;
        }
        if (ch === '\n' || ch === '\r') openTicks = 0;
        if (bracketHold || (ch === '[' && openTicks === 0)) {
          bracketHold += ch;
          if (followUpLine) {
            if (ch === '\n' || ch === '\r' || bracketHold.length > MAX_BRACKET_HOLD) {
              bracketHold = '';
              followUpLine = false;
            } else if (ch === ']') {
              handleFollowUpLine(bracketHold);
            }
          } else if (ch === ']' && FOLLOW_UP_ITEM_PREFIX_RE.test(bracketHold)) {
            followUpLine = true;
            handleFollowUpLine(bracketHold);
          } else if (ch === ']') {
            const buf = bracketHold;
            bracketHold = '';
            handleSentinelCompletion(buf);
          } else if (ch === '\n' || ch === '\r' || !couldStillBeSentinel(bracketHold) || bracketHold.length > MAX_BRACKET_HOLD) {
            // Prefix can't grow into a sentinel, or runaway bracket — abandon
            // the hold. The text is already in reducer state from the dispatch above;
            // we just stop treating it as a sentinel candidate.
            bracketHold = '';
          }
        }
      }
    },
    onThought: (text, seq, _assistantId, turnId, observedAt) => {
      trackSeq(seq, turnId);
      dispatch({ type: 'thought', nodeId, assistantId: currentAssistantId, text, observedAt });
    },
    onSteerAccepted: (data) => {
      trackSeq(data.seq, data.turnId);
      dispatch({ type: 'steer-accepted', nodeId, data: { ...data, assistantId: data.assistantId ?? currentAssistantId } });
    },
    onSteeringReport: (data) => {
      trackSeq(data.seq, data.turnId);
      dispatch({ type: 'steering-report', nodeId, assistantId: currentAssistantId, reports: data.reports });
    },
    onPlan: (entries) => dispatch({ type: 'plan', nodeId, assistantId: currentAssistantId, entries }),
    onToolCall: (toolCall) => {
      const env = toolCall as typeof toolCall & { seq?: number; turnId?: string };
      trackSeq(env.seq, env.turnId);
      observePageTool(toolCall);
      dispatch({
        type: 'tool-call',
        observedAt: toolCall.observedAt,
        nodeId,
        assistantId: currentAssistantId,
        tool: {
          id: toolCall.toolCallId || `t-${Date.now()}`,
          title: toolCall.title,
          status: toolCall.status,
          kind: toolCall.kind,
          detail: toolCall.detail,
          inputJson: toolCall.inputJson,
        },
      });
    },
    onToolCallUpdate: (toolCall) => {
      const env = toolCall as typeof toolCall & { seq?: number; turnId?: string };
      trackSeq(env.seq, env.turnId);
      dispatch({
        type: 'tool-call-update',
        observedAt: toolCall.observedAt,
        nodeId,
        assistantId: currentAssistantId,
        tool: {
          id: toolCall.toolCallId,
          title: toolCall.title,
          status: toolCall.status,
          kind: toolCall.kind,
          detail: toolCall.detail,
          inputJson: toolCall.inputJson,
          output: toolCall.output,
        },
      });
      observePageTool(toolCall);
    },
    onImage: (data) => {
      // Must use currentAssistantId (not the outer `assistantId`): onTurnStart
      // can retarget the assistant message id mid-stream, and the image block
      // must land on the live message — same as every other dispatch here.
      // workspaceId is derived reducer-side from the node's projectId.
      dispatch({
        type: 'image-block',
        nodeId,
        assistantId: currentAssistantId,
        path: data.path,
        caption: data.caption,
        mimeType: data.mimeType,
        size: data.size,
      });
    },
    onHeartbeat: (idleMs) => dispatch({ type: 'heartbeat', nodeId, idleMs }),
    onTitle: (title) => dispatch({ type: 'set-title', nodeId, title }),
    onBranchOverview: (overview, seq, _assistantId, turnId) => {
      trackSeq(seq, turnId);
      dispatch({ type: 'set-branch-overview', nodeId, overview, assistantId: currentAssistantId });
    },
    onFollowUps: (followUps) => dispatch({ type: 'set-follow-ups', nodeId, followUps }),
    onFollowUpsStatus: (status) =>
      dispatch({ type: 'follow-ups-status', nodeId, status }),
    onSessionState: (state) => dispatch({ type: 'session-state', nodeId, state }),
    onCommands: (commands) => dispatch({ type: 'set-commands', nodeId, commands }),
    onSubagentListUpdate: (data) => dispatch(subagentListAction(nodeId, currentAssistantId, data)),
    onSubagentToolActivity: (data) => dispatch(subagentActivityAction(nodeId, currentAssistantId, data)),
    onContextUsage: (data) =>
      dispatch({ type: 'context-usage', nodeId, contextUsagePercentage: data.contextUsagePercentage }),
    onUsageSummary: (data) =>
      dispatch({
        type: 'usage-summary',
        nodeId,
        assistantId: currentAssistantId,
        contextUsagePercentage: data.contextUsagePercentage,
        totalCredits: data.totalCredits,
        charge: data.charge,
        turnDurationMs: data.turnDurationMs,
        source: data.source,
        totalTokens: data.totalTokens,
        inputTokens: data.inputTokens,
        cachedInputTokens: data.cachedInputTokens,
        outputTokens: data.outputTokens,
        reasoningOutputTokens: data.reasoningOutputTokens,
      }),
    onCancelPhase: (data) => dispatch({ type: 'cancel-phase', nodeId, phase: data.phase }),
    onCompactionStart: () => dispatch({ type: 'compaction', nodeId, active: true }),
    onCompactionEnd: () => dispatch({ type: 'compaction', nodeId, active: false }),
    onRetryStart: (data) => {
      dispatch({ type: 'runtime-activity', nodeId, assistantId: currentAssistantId, detail: data.detail ?? 'Reconnecting' });
    },
    onRetryEnd: () => dispatch({ type: 'runtime-activity', nodeId, assistantId: currentAssistantId }),
    onWarning: (data) => {
      dispatch({ type: 'warning', nodeId, assistantId: currentAssistantId, warning: data });
      effects.runtimeMessage(data.message);
    },
    onMcpServerError: (data) => {
      dispatch({ type: 'mcp-server-error', nodeId, serverName: data.serverName, error: data.error });
      effects.runtimeMessage(data.error);
    },
    onDone: (stopReason, _assistantId, turnId, persisted, completedAt, completion) => {
      if (turnId) currentTurnId = turnId;
      const { error, aborted } = doneOutcome(stopReason, persisted);
      if (error) {
        dispatch({ type: 'error', nodeId, assistantId: currentAssistantId, ...error, turnId: currentTurnId });
        cleanup();
        onTurnEnd?.('error', nodeId);
        return;
      }
      // Reducer extracts metadata from assistant answer blocks.
      effects.end(!aborted);
      dispatch({
        type: 'done', nodeId, assistantId: currentAssistantId, completedAt, aborted,
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
        ...(completion ? { completion } : {}),
      });
      cleanup();
      onTurnEnd?.('done', nodeId);
      // A turn cancelled elsewhere (another window, the phone) did not finish; like onAborted below.
      if (!aborted) onStreamComplete?.();
    },
    onAborted: () => {
      dispatch({ type: 'done', nodeId, assistantId: currentAssistantId, aborted: true });
      cleanup();
      onTurnEnd?.('cancel', nodeId);
      // Note: intentionally NOT calling onStreamComplete for aborted streams
    },
    onCancelRecovery: (status) => dispatch({
      type: 'cancel-recovery', nodeId, assistantId: currentAssistantId, ...status,
    }),
    onSavedTurn: (saved) => {
      const result = savedTurnResult(saved);
      if (!result) return false;
      if (saved.assistantId !== currentAssistantId) {
        // turn_start never reached this window; adopt the identity it carried.
        dispatch({ type: 'realign-assistant-id', nodeId, fromId: currentAssistantId, toId: saved.assistantId });
        currentAssistantId = saved.assistantId;
      }
      currentTurnId = saved.turnId;
      dispatch({
        type: 'recover-original-result', nodeId, turnId: saved.turnId, assistantId: currentAssistantId,
        assistant: result.assistant, lastSeq: result.lastSeq, cursor: 'foreground',
      });
      handlers.onDone?.(result.stopReason, currentAssistantId, saved.turnId, true, result.completedAt);
      return true;
    },
    onErrorPayload: (data) => {
      handleError(data.message, data.turnId, data.code, data.recoverable, data.completedAt);
    },
    onError: (message, _assistantId, turnId, code) => handleError(message, turnId, code),
    ...extraHandlers,
  };

  function handleError(message: string, turnId?: string, code?: string, recoverable?: boolean, completedAt?: number) {
      effects.runtimeMessage(message);
      if (skill && (code === 'skill_not_found' || code === 'skills_unavailable')) onSkillRejected?.();
      if (turnId) currentTurnId = turnId;
      dispatch({ type: 'error', nodeId, assistantId: currentAssistantId, message, errorKind: code, recoverable, completedAt, turnId: currentTurnId || undefined });
      // Not reached through streamMessage, which waits out a 409 turn_active
      // and resends instead of reporting it (stream.ts).
      if (code === 'turn_active' && rejectedDraft) {
        dispatch({ type: 'set-composer-draft', nodeId, draft: rejectedDraft, preserveExisting: true });
        onRejected?.();
      }
      cleanup();
      onTurnEnd?.('error', nodeId);
  }

  // streamMessage builds its request synchronously: it reads the captured context here.
  const cancelTransport = withMetaAgentTurnContext(nodeId, metaAgentContext, () => streamMessage(nodeId, prompt, handlers, {
    displayText,
    enableKiroSidecarTitle,
    userMetadata,
    ...(skill ? { skill } : {}),
  }));
  streamCancel = cancelTransport;
  return streamCancel;
}
