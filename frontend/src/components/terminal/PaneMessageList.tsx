import React from 'react';
import { animate } from 'motion/react';
import type { ChatNodeState } from '../../state/chatTypes';
import type { Prefs } from '../../state/prefs';
import { messageDensity } from '../../state/density';
import { visibleMessageText } from '../../state/assistantBlocks';
import { FollowUpRow } from '../FollowUpRow';
import { DARK_PALETTES } from './tokens';
import { MessageBlock, NodeUserInputContext, type TurnUsageInfo } from './MessageBlock';
import { mergeRunUsage, messageRunPositions } from './messageRuns';
import { DiffReceipt } from './DiffReceipt';
import { MessagesLoadingPlaceholder } from './MessagesLoadingPlaceholder';
import { StreamActivityIndicator, deriveStreamActivity } from './StreamActivityIndicator';
import type { ChildAnchor } from '../../state/branchAnchors';
import { countRender } from '../../services/renderCounters';
import { shouldShowFollowUps } from '../../state/followUpsVisibility';
import { usageIsUnverifiable, type RuntimeWarning } from 'michi-shared';
import { useOptionalAgentDomain } from '../../state/agentDomain';
import { useOptionalChatActions, useOptionalStructuralSelector } from '../../state/chatStore';
import { backendConnectionIdForWorkspace, LOCAL_BACKEND_CONNECTION_ID, workspaceBackendApiBase } from '../../config/backendConnections';
import { ReplySourcesContext, type ReplySourcesTarget } from '../../state/memory/replySources';
import { AgentRunCardGroup } from './agentRuns/AgentRunCard';
import { MessageSubagents } from './subagents/SubagentRoster';
import { useWorkflowPlacementsForNode, workflowRunKey, type WorkflowPlacement } from '../../state/workflowDomain';
import { latestAssistantMessageId, messageSubagentRoster, workflowMessageResolver } from '../../state/backgroundWork';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { inlineSubagentRoster } from './subagents/subagentPresentation';
import { BackgroundWorkNodeContext, openWorkflowRunDrawer } from './backgroundWork/backgroundWorkEvents';
import { MichiLinkConnectionContext } from './assistant/linkConnection';
import { groupParentRunCards, type LocatedAgentRun } from './agentRuns/agentRunSelectors';
import { agentResourceKey, type AgentResourceIdentity } from '../../state/agentIdentity';
import { useSourceReference } from '../../state/sourceNav/sourceNav';
import { SourceReferenceMark } from './source/SourceReferenceMark';
import { isFresh } from '../../motion/useFresh';
import { DUR } from '../../motion/tokens';
import { useMetaChatDecorations } from '../../state/metaChat/metaChatDecorations';
import type { MultiModelBranchControls } from './multiModelBranch';
import { unloadedOlderMessageCount } from '../../state/nodeMessageCount';
import { ChatIcon, ChevronDownIcon, CloseIcon, SpinnerIcon, WarningIcon } from './icons';
import { DeferredToolCallsScope } from '../../state/deferredToolCalls';
import { useDeferredToolPrefetch } from './deferredToolPrefetch';

const NO_RUNS: readonly LocatedAgentRun[] = [];

// The chrome under the messages, memoized: each takes only the fields it
// shows, so streamed chunks skip it (MO-17).
const MergeSourcesNotice = React.memo(MergeSourcesNoticeInner);
const McpServerError = React.memo(McpServerErrorInner);
const RuntimeWarningBanner = React.memo(RuntimeWarningBannerInner);
const FollowUpsSection = React.memo(FollowUpsSectionInner);

// The un-dim keeps the transition too, so leaving edit mode fades back in.
const FRAME_STYLE: React.CSSProperties = { transition: 'opacity var(--t-enter)' };
const DIMMED_FRAME_STYLE: React.CSSProperties = { ...FRAME_STYLE, opacity: 0.38 };

/**
 * Whether a message plays its entrance: it was created while this list was
 * on screen, moments ago. Hydrated, lazily loaded and older history predate
 * the list, and a remounted list starts with everything settled.
 */
export function isFreshMessage(createdAt: number | undefined, listMountedAt: number, now = Date.now()): boolean {
  return createdAt !== undefined && createdAt >= listMountedAt && isFresh(createdAt, now);
}

/** The usage line a finished reply shows, from its own or the node's summary. */
function replyUsageInfo(node: ChatNodeState, i: number): TurnUsageInfo | undefined {
  const m = node.messages[i];
  const usage = m.usageSummary ?? (i === node.messages.length - 1 ? node.usageSummary : undefined);
  if (m.role === 'user' || m.streaming || !usage) return undefined;
  if (usage.source === 'unverifiable' || (!usage.charge && usageIsUnverifiable(usage.source, usage.totalCredits))) {
    return { durationMs: usage.turnDurationMs, unverifiable: true };
  }
  return {
    durationMs: usage.turnDurationMs,
    credits: usage.charge ? undefined : usage.totalCredits,
    charge: usage.charge,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    contextUsagePercentage: node.contextUsagePercentage,
  };
}

function useOptionalAgentRunUi() {
  const domain = useOptionalAgentDomain();
  const actions = useOptionalChatActions();
  // PaneMessageList also supports provider-free render/perf unit tests.
  return domain && actions ? { domain, actions } : null;
}

interface PaneMessageListProps {
  node: ChatNodeState;
  /**
   * The first message to mount (TPane's progressiveMount): those above it
   * come in later batches. 0, the default, mounts them all.
   */
  mountFrom?: number;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  mergeSourceLabels?: readonly string[];
  prefs: Prefs;
  contentStyle: React.CSSProperties;
  streaming: boolean;
  onRetryTurn: (userMessageIndex: number) => void;
  onRunAgain?: (userMessageIndex: number) => void;
  /** Carry on the latest turn its answer marks stopped or ended early (chatStore resumeLastTurn). */
  onContinueTurn?: () => void;
  onEditUserMessage: (text: string) => void;
  onContinueFollowUp: (question: string) => void;
  onBranchFollowUp: (question: string) => void;
  followUpsDisabled?: boolean;
  editingMessageId?: string | null;
  onEditStart?: (messageId: string) => void;
  onEditSave?: (messageIndex: number, newText: string) => void;
  onEditCancel?: () => void;
  /**
   * Map from assistant message id → child branch anchors forked from that
   * message. Built by buildAnchorMap() in TPane and passed down so this
   * component stays pure/testable.
   *
   * Every anchor renders as a BranchAnchorRow turn marker after the anchored
   * message. A branch made from a selection (quotedText) also underlines the
   * quoted passage inside the message (BranchQuoteUnderline).
   */
  anchorsByMessage?: Map<string, ChildAnchor[]>;
  /** Called when the user clicks a child-branch title. */
  onOpenBranch?: (childNodeId: string) => void;
  /** Called when user clicks the per-message branch icon. */
  onBranchFromMessage?: (messageId: string) => void;
  /** Lowercased context names for highlighting @mentions in user messages. */
  contextNames?: ReadonlySet<string>;
  /** Called when user clicks a mention chip. */
  onMentionClick?: (name: string, kind: string, nodeId?: string) => void;
  /** Probe backend connectivity for the connection/auth error-tail button. */
  onTestConnection?: () => Promise<{ ok: boolean; detail?: string }>;
  /** A transcript to read only: no retry, edit, branch or follow-up actions. */
  readOnly?: boolean;
  /**
   * The node's last turn was a multi-model plan step and failed
   * (failedPlanStep): its Retry goes through the run's row, which follows
   * only the turns it started, or the tail points to the plan.
   */
  planStep?: MultiModelBranchControls;
  /**
   * A chat that learns from and reads memory (TPane's memory setting rule: an ordinary chat, or the agent's current
   * conversation V): its replies show what they were based on (ReplyMemorySources). Never a page's, a Meta agent run's,
   * a check-in's or a Scheduled-only thread.
   */
  replySources?: boolean;
}

function PaneMessageListInner({
  node,
  mountFrom = 0,
  loadingOlder = false,
  onLoadOlder,
  mergeSourceLabels,
  prefs,
  contentStyle,
  streaming,
  onRetryTurn,
  onRunAgain,
  onContinueTurn,
  onEditUserMessage,
  onContinueFollowUp,
  onBranchFollowUp,
  followUpsDisabled = false,
  anchorsByMessage,
  onOpenBranch,
  onBranchFromMessage,
  editingMessageId,
  onEditStart,
  onEditSave,
  onEditCancel,
  contextNames,
  onMentionClick,
  onTestConnection,
  readOnly = false,
  planStep,
  replySources = false,
}: PaneMessageListProps) {
  const agentRunUi = useOptionalAgentRunUi();
  const sourceReference = useSourceReference(node.nodeId);
  const referenceLabel = sourceReference?.label ?? null;
  const referenceMark = React.useMemo(() => <SourceReferenceMark label={referenceLabel} />, [referenceLabel]);
  const nodeWorkflowRuns = useWorkflowPlacementsForNode(node.nodeId);
  const nodeId = node.nodeId;
  // "Open →" shows the run in the Background work drawer. Stable across
  // stream chunks, so memoized workflow cards skip them.
  // Placements are this node's runs, so the node is the run's owner.
  const openWorkflowRun = React.useCallback((identity: AgentResourceIdentity) => {
    openWorkflowRunDrawer(nodeId, workflowRunKey(identity));
  }, [nodeId]);
  const backendConnectionId = backendConnectionIdForWorkspace(node.projectId);
  const projectId = node.projectId;
  // Run cards by the message that started them, grouped once per change to
  // the runs, never per streamed chunk; the open handlers keep their identity
  // too, so the memoized card groups skip the chunks.
  const agentRuns = agentRunUi?.domain.state.runs;
  const agentRunActions = agentRunUi?.actions;
  const runsByMessage = React.useMemo(
    () => groupParentRunCards(agentRuns ? Object.values(agentRuns) : [], backendConnectionId),
    [agentRuns, backendConnectionId],
  );
  const openRun = React.useCallback((identity: AgentResourceIdentity) => {
    const resource = agentRuns?.[agentResourceKey(identity)];
    agentRunActions?.openAgentRunPane(identity, projectId, resource?.value.effectiveDefinition.name);
  }, [agentRuns, agentRunActions, projectId]);
  const openRuns = React.useCallback((identities: AgentResourceIdentity[]) => {
    for (const identity of identities) openRun(identity);
  }, [openRun]);
  // The reply whose turn still runs after its visible answer asks once the turn is done (the backend stores its sources then).
  const runningMessageId = node.backgroundTurnAssistantId ?? null;
  const replySourcesTarget = React.useMemo<ReplySourcesTarget | null>(() => (replySources ? {
    apiBase: workspaceBackendApiBase(projectId), nodeId, backendConnectionId, workspaceId: projectId,
    local: backendConnectionId === LOCAL_BACKEND_CONNECTION_ID, runningMessageId,
  } : null), [replySources, projectId, nodeId, backendConnectionId, runningMessageId]);
  // Recomputes on every stream chunk (the reducer hands a fresh messages
  // array each chunk); the helper scans backward without copying.
  const tailAssistantId = React.useMemo(() => latestAssistantMessageId(node.messages), [node.messages]);
  const inlineSubagents = React.useMemo(() => inlineSubagentRoster(node), [node]);
  // Workflow runs this chat launched, attached to the message whose tool
  // call launched them. A run without a known launcher goes to the last
  // assistant message that existed when it started, so it stays in place
  // as the conversation grows.
  // The Background work drawer applies the same placement (history rule).
  const workflowsByMessage = React.useMemo(() => {
    const byMessage = new Map<string, WorkflowPlacement[]>();
    if (nodeWorkflowRuns.length === 0) return byMessage;
    const messageFor = workflowMessageResolver(node.messages);
    for (const placement of nodeWorkflowRuns) {
      const messageId = messageFor(placement);
      if (!messageId) continue;
      const list = byMessage.get(messageId) ?? [];
      list.push(placement);
      byMessage.set(messageId, list);
    }
    return byMessage;
  }, [nodeWorkflowRuns, node.messages]);
  const [tailAnswerSmoothing, setTailAnswerSmoothing] = React.useState(false);
  const handleTailSmoothingChange = React.useCallback((isSmoothing: boolean) => {
    setTailAnswerSmoothing(isSmoothing);
  }, []);
  const [listMountedAt] = React.useState(() => Date.now());
  // Replies this list watched stream: the diff receipt their turn's end
  // brings grows in, once. One that comes with the history (opened, lazily
  // loaded, remounted by a retry or edit) renders settled.
  const streamedHereRef = React.useRef(new Set<string>());
  // The reply whose turn ended while this list watched it: its follow-ups pop
  // in once (TR-29), whether they show in that commit or once its text has
  // drained. Restored, remounted and re-expanded follow-ups render settled.
  const followUpsArriveForRef = React.useRef<string | null>(null);
  const tailMessage = node.messages[node.messages.length - 1];
  const tailReplyKey = tailMessage?.role === 'assistant' ? tailMessage.clientKey ?? tailMessage.id : null;
  React.useLayoutEffect(() => {
    if (!tailReplyKey) return;
    if (node.status === 'streaming') streamedHereRef.current.add(tailReplyKey);
    // The turn ended and its text drained: its receipt, if any, has mounted.
    else if (!tailAnswerSmoothing && streamedHereRef.current.delete(tailReplyKey)) followUpsArriveForRef.current = tailReplyKey;
  }, [node.status, tailReplyKey, tailAnswerSmoothing]);
  const followUpsArrive = !!tailReplyKey
    && (streamedHereRef.current.has(tailReplyKey) || followUpsArriveForRef.current === tailReplyKey);
  const followUpsArrived = React.useCallback(() => { followUpsArriveForRef.current = null; }, []);
  // Kept across turns: the section unmounts while a turn runs. A toggle ends
  // the pop, so re-expanding never replays it.
  const [followUpsCollapsed, setFollowUpsCollapsed] = React.useState(false);
  const toggleFollowUps = React.useCallback(() => {
    followUpsArriveForRef.current = null;
    setFollowUpsCollapsed((value) => !value);
  }, []);
  // Suppress follow-ups while the turn is still running, and after it failed:
  // any left are an earlier reply's. node.status is persisted in the DB and
  // survives hydration, unlike message-level m.streaming which mapMessageRow()
  // resets to false on load.
  const turnStillRunning = node.status === 'streaming';

  const showFollowUps = node.messagesLoaded === false && !node.historyBefore
    ? false
    : turnStillRunning || node.status === 'error'
    ? false
    : shouldShowFollowUps(
        node.followUps.length,
        tailAnswerSmoothing,
        // The runtime boundary only marks received text as complete. Its
        // typewriter backlog must finish before follow-ups appear, including
        // while a hidden metadata tail drains and after the final done event.
        !!node.followUpsGenerating && !node.visibleResponseComplete,
      );

  // A send clears the follow-ups: the section stays, as it last was, while
  // it fades out (120ms) and the new bubble fades in. Any other removal (a
  // loading state replaced, the answer still typing) is immediate, as it
  // always was.
  const showSection = prefs.enableFollowUps && (followUpsLoading(node) || showFollowUps);
  const lastShownRef = React.useRef<ChatNodeState | null>(null);
  React.useLayoutEffect(() => {
    if (showSection) lastShownRef.current = node;
  });
  const [wasShown, setWasShown] = React.useState(showSection);
  const [leavingNode, setLeavingNode] = React.useState<ChatNodeState | null>(null);
  if (wasShown !== showSection) {
    setWasShown(showSection);
    setLeavingNode(!showSection && sentFromHere(lastShownRef.current, node) ? lastShownRef.current : null);
  }
  const followUpsLeft = React.useCallback(() => setLeavingNode(null), []);
  const followUpsNode = showSection ? node : leavingNode;

  countRender('PaneMessageList', node.nodeId, {
    status: node.status,
    messages: node.messages.length,
    followUps: node.followUps.length,
  });
  const isDark = DARK_PALETTES.has(prefs.terminalPalette);

  // Placeholder state: node has messages in the DB but they haven't loaded yet.
  // Show a subtle loading indicator instead of bare follow-ups.
  const isPlaceholder = node.messagesLoaded === false && node.messages.length === 0 && (node.messageCount ?? 0) > 0;
  // Messages before this cut were copied from the parent chain by extraction.
  const historyOffset = unloadedOlderMessageCount(node);
  const inheritedCount = Math.max(0, Math.min((node.inheritedMessageCount ?? 0) - historyOffset, node.messages.length));

  const runPositions = React.useMemo(
    () => messageRunPositions(node.messages, inheritedCount > 0 ? inheritedCount : undefined),
    [node.messages, inheritedCount],
  );

  // The failed plan step's turn: its user message and what follows it.
  const failedStepFrom = planStep && !readOnly ? node.messages.findLastIndex((message) => message.role === 'user') : -1;

  const userInputCtx = React.useMemo(
    () => ({ userInput: node.pendingUserInput, nodeId: node.nodeId }),
    [node.pendingUserInput, node.nodeId],
  );
  // A window may leave messages out (the Companion's quiet turns); a hidden
  // last message takes its live activity row and reply space along.
  const decorations = useMetaChatDecorations();
  const hideMessage = decorations?.hideMessage;
  // Finished turns whose calls came without their bodies: read when on screen.
  const listRef = React.useRef<HTMLDivElement>(null);
  const deferredSignature = React.useMemo(() => node.messages
    .filter((message) => message.role === 'assistant' && message.toolCalls.some((tool) => tool.deferred))
    .map((message) => message.id).join('\n'), [node.messages]);
  useDeferredToolPrefetch(listRef, node.nodeId, deferredSignature);
  const tailHidden = !!hideMessage && !!tailMessage && hideMessage(tailMessage, node.messages.length - 1, node.messages);
  // The tail chrome below takes only the fields it shows, so chunk commits skip it.
  const activity = deriveStreamActivity(node, { showThoughts: prefs.showThoughts });

  return (
    <NodeUserInputContext.Provider value={userInputCtx}>
    <BackgroundWorkNodeContext.Provider value={nodeId}>
    <ReplySourcesContext.Provider value={replySourcesTarget}>
    {/* An agent on the thread's backend wrote its michi:// links in that backend's ids. */}
    <MichiLinkConnectionContext.Provider value={backendConnectionId}>
    <div style={contentStyle} ref={listRef}>
      {node.historyBefore && onLoadOlder && mountFrom === 0 && (
        <button type="button" disabled={loadingOlder} onClick={onLoadOlder}
          className="mb-4 w-full rounded border border-line px-3 py-2 text-sm text-fg-subtle hover:bg-surface disabled:opacity-50">
          {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
        </button>
      )}
      <MergeSourcesNotice mergeSources={node.mergeSources} parentNodeId={node.parentNodeId} sourceLabels={mergeSourceLabels} />
      {!node.historyBefore && !isPlaceholder && mountFrom === 0 && decorations?.leading}

      {isPlaceholder && (
        <MessagesLoadingPlaceholder key={node.nodeId} nodeId={node.nodeId} connectionId={backendConnectionId}
          reduceMotion={prefs.reduceMotion} />
      )}
      {node.messages.map((m, i) => {
        if (i < mountFrom || hideMessage?.(m, i, node.messages)) return null;
        const isUser = m.role === 'user';
        let retryText: string | undefined;
        if (isUser) {
          retryText = m.text;
        } else {
          for (let j = i - 1; j >= 0; j--) {
            if (node.messages[j].role === 'user') {
              retryText = node.messages[j].text;
              break;
            }
          }
        }

        // Replies with no user message between them read as one message:
        // the meta line (actions and the run's usage) shows on its last
        // part, and copy takes the whole run.
        const run = runPositions[i];
        const endsRun = run.continuesRun && !run.runContinues;
        const runParts = endsRun ? node.messages.slice(run.start, i + 1) : null;
        const isErrorTail =
          !isUser &&
          i === node.messages.length - 1 &&
          node.status === 'error';
        const isStreamingTail =
          !isUser &&
          i === node.messages.length - 1 &&
          node.status === 'streaming';
        // The latest answer, finished: its meta line stays shown. A failed one
        // has the error row's own actions instead; a streaming one has none yet.
        const isLatestAnswer = !isUser && i === node.messages.length - 1 && !isStreamingTail && !isErrorTail;

        // Collect branch anchors for this message. They are passed into
        // MessageBlock and rendered between the message body and the
        // MessageActions row, so the marker sits closer to the message
        // content than the action chrome; quoted passages are underlined in
        // the body. The array comes from the anchor map, stable across chunks.
        const anchorsForMsg = anchorsByMessage?.get(m.id) ?? [];

        const editingIdx = editingMessageId
          ? node.messages.findIndex((msg) => msg.id === editingMessageId)
          : -1;
        const isDownstream = editingIdx >= 0 && i > editingIdx;
        const parentRuns = isUser ? NO_RUNS : runsByMessage.get(m.id) ?? NO_RUNS;
        // The durable roster lives on the message that spawned the agents.
        // Messages saved before rosters were persisted fall back to the live
        // node roster, which only ever belongs to the tail turn.
        const roster = messageSubagentRoster(node, m, tailAssistantId);
        const rowKey = m.clientKey ?? m.id;
        const fresh = isFreshMessage(m.arrivedAt ?? m.createdAt, listMountedAt);
        const inFailedStep = failedStepFrom >= 0 && i >= failedStepFrom;

        return (
          // clientKey survives realign-assistant-id, so the rename does not
          // remount the row (and replay its entrance or drop its state).
          <React.Fragment key={rowKey}>
            {i === inheritedCount && inheritedCount > 0 && (
              <div
                className="t-inherited-divider"
                role="separator"
                aria-label={`Inherited history: ${inheritedCount} messages`}
                data-inherited-count={inheritedCount}
                title={node.forkedFromNodeId
                  ? `Copied from ${node.forkedFromNodeId} when this thread was extracted.`
                  : 'Copied from the parent conversation when this thread was extracted.'}
              >
                <span>Inherited history · {inheritedCount} messages</span>
              </div>
            )}
            <div
              data-msg-id={m.id}
              data-role={m.role}
              // Spacing before the next turn and the user action row's
              // placement depend on what follows (index.css).
              data-next-role={node.messages[i + 1]?.role}
              data-streaming-tail={isStreamingTail ? 'true' : undefined}
              data-source-referenced={sourceReference?.messageId === m.id ? 'true' : undefined}
              data-run-part={run.runContinues ? 'true' : undefined}
              data-run-end={endsRun ? 'true' : undefined}
              data-deferred-tools={!isUser && m.toolCalls.some((tool) => tool.deferred) ? 'true' : undefined}
              className="terminal-message-frame"
              style={isDownstream ? DIMMED_FRAME_STYLE : FRAME_STYLE}
            >
              <DeferredToolCallsScope nodeId={node.nodeId} messageId={m.id}>
              <MessageBlock
                m={m}
                fresh={fresh}
                highlight={sourceReference?.messageId === m.id ? referenceMark : undefined}
                workspaceId={node.projectId}
                backendConnectionId={backendConnectionId}
                index={i}
                isDark={isDark}
                editing={m.id === editingMessageId}
                // The meta line, like the follow-ups, waits for the typewriter to drain.
                hideActions={isStreamingTail || (m.id === tailAssistantId && tailAnswerSmoothing)}
                pinned={isLatestAnswer}
                continuesRun={run.continuesRun}
                runContinues={run.runContinues}
                actionsAtRest={m.role !== 'user' && i === node.messages.length - 1}
                hidePendingIndicator={isStreamingTail && activity !== null}
                onEditSave={m.id === editingMessageId ? (newText) => onEditSave?.(i, newText) : undefined}
                onEditCancel={m.id === editingMessageId ? onEditCancel : undefined}
                copyText={() => (runParts
                  ? runParts.map(visibleMessageText).filter(Boolean).join('\n\n')
                  : visibleMessageText(m))}
                onRetry={
                  readOnly || streaming || !retryText
                    ? undefined
                    : inFailedStep
                    ? planStep?.retry
                    : () => {
                        const userIdx = isUser
                          ? i
                          : node.messages.slice(0, i).findLastIndex((msg) => msg.role === 'user');
                        if (userIdx < 0) return;
                        onRetryTurn(userIdx);
                      }
                }
                onEdit={
                  !readOnly && isUser && !streaming && !editingMessageId
                    ? () => onEditStart?.(m.id)
                    : undefined
                }
                onBranch={
                  !readOnly && !streaming && onBranchFromMessage
                    ? () => onBranchFromMessage(m.id)
                    : undefined
                }
                isErrorTail={isErrorTail}
                errorMessage={isErrorTail ? node.error : undefined}
                errorKind={isErrorTail ? node.errorKind : undefined}
                errorRecovery={isErrorTail ? node.errorRecovery : undefined}
                onRunAgain={!readOnly && isErrorTail && onRunAgain && !streaming && !inFailedStep ? () => {
                  const userIdx = node.messages.slice(0, i).findLastIndex((msg) => msg.role === 'user');
                  if (userIdx >= 0) onRunAgain(userIdx);
                } : undefined}
                onContinue={!readOnly && isLatestAnswer && m.turnEnd && !inFailedStep ? onContinueTurn : undefined}
                onTestConnection={isErrorTail ? onTestConnection : undefined}
                planStep={isErrorTail && inFailedStep ? planStep : undefined}
                freshContext={isUser && m.threadMessage?.plan ? node.freshContext : undefined}
                showThoughts={prefs.showThoughts}
                density={messageDensity(prefs.sidebarDensity)}
                usageInfo={endsRun
                  ? mergeRunUsage(runParts!.map((_, k) => replyUsageInfo(node, run.start + k)))
                  : replyUsageInfo(node, i)}
                subagents={roster}
                runtimeId={node.runtimeId}
                quoteAnchors={anchorsForMsg.some((a) => a.quotedText) ? anchorsForMsg : undefined}
                turnAnchors={anchorsForMsg.length > 0 ? anchorsForMsg : undefined}
                workflowRuns={isUser ? undefined : workflowsByMessage.get(m.id)}
                onOpenWorkflowRun={openWorkflowRun}
                onOpenBranch={onOpenBranch}
                contextNames={contextNames}
                onMentionClick={onMentionClick}
                onVisibleSmoothingChange={
                  !isUser && m.id === tailAssistantId ? handleTailSmoothingChange : undefined
                }
                readOnly={readOnly}
              />
              </DeferredToolCallsScope>
              {!isUser &&
                node.status !== 'streaming' &&
                !tailAnswerSmoothing &&
                i === node.messages.length - 1 && (
                  <DiffReceipt message={m} workspaceId={node.projectId} enter={streamedHereRef.current.has(rowKey)} />
                )}
              {/* Agents no delegation chip claims (Crew runs, background
                  completions, legacy rosters): one roster, under the newest
                  message that lists one. */}
              {inlineSubagents?.messageId === m.id && <MessageSubagents subagents={inlineSubagents.subagents} />}
              {parentRuns.length > 0 && (
                <div style={{ margin: '8px 0 2px' }}>
                  <AgentRunCardGroup runs={parentRuns} onOpen={openRun} onOpenAll={openRuns} />
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}

      {inheritedCount > 0 && inheritedCount === node.messages.length && (
        <div
          className="t-inherited-divider"
          role="separator"
          aria-label={`Inherited history: ${inheritedCount} messages`}
          data-inherited-count={inheritedCount}
          title={node.forkedFromNodeId
            ? `Copied from ${node.forkedFromNodeId} when this thread was extracted.`
            : 'Copied from the parent conversation when this thread was extracted.'}
        >
          <span>Inherited history · {inheritedCount} messages</span>
        </div>
      )}

      {!tailHidden && (
        <StreamActivityIndicator
          label={activity?.label}
          detail={activity?.detail}
          streamingStartedAt={node.streamingStartedAt}
          live={node.status === 'streaming' && !node.visibleResponseComplete}
        />
      )}
      <McpServerError error={node.mcpServerError} />
      <RuntimeWarningBanner nodeId={nodeId} />
      {followUpsNode && !readOnly && (
        <FollowUpsSection
          followUps={followUpsNode.followUps}
          status={followUpsNode.status}
          visibleResponseComplete={followUpsNode.visibleResponseComplete}
          followUpsGenerating={followUpsNode.followUpsGenerating}
          leaving={!showSection}
          onLeft={followUpsLeft}
          // Rows show only once the turn ended: set while it runs, the flag
          // would only re-render the memoized section on a streamed chunk.
          arriving={showSection && !turnStillRunning && followUpsArrive}
          onArrived={followUpsArrived}
          collapsed={followUpsCollapsed}
          onToggleCollapsed={toggleFollowUps}
          onContinueFollowUp={onContinueFollowUp}
          onBranchFollowUp={onBranchFollowUp}
          disabled={followUpsDisabled}
        />
      )}
    </div>
    </MichiLinkConnectionContext.Provider>
    </ReplySourcesContext.Provider>
    </BackgroundWorkNodeContext.Provider>
    </NodeUserInputContext.Provider>
  );
}

export const PaneMessageList = React.memo(PaneMessageListInner, (prev, next) =>
  prev.node === next.node &&
  (prev.mountFrom ?? 0) === (next.mountFrom ?? 0) &&
  prev.mergeSourceLabels === next.mergeSourceLabels &&
  prev.prefs === next.prefs &&
  prev.contentStyle === next.contentStyle &&
  prev.streaming === next.streaming &&
  prev.onRetryTurn === next.onRetryTurn &&
  prev.onContinueTurn === next.onContinueTurn &&
  prev.onEditUserMessage === next.onEditUserMessage &&
  prev.onContinueFollowUp === next.onContinueFollowUp &&
  prev.onBranchFollowUp === next.onBranchFollowUp &&
  (prev.followUpsDisabled ?? false) === (next.followUpsDisabled ?? false) &&
  (prev.readOnly ?? false) === (next.readOnly ?? false) &&
  prev.anchorsByMessage === next.anchorsByMessage &&
  prev.onOpenBranch === next.onOpenBranch &&
  prev.onBranchFromMessage === next.onBranchFromMessage &&
  prev.contextNames === next.contextNames &&
  prev.onMentionClick === next.onMentionClick &&
  prev.editingMessageId === next.editingMessageId &&
  prev.onEditStart === next.onEditStart &&
  prev.onEditSave === next.onEditSave &&
  prev.onEditCancel === next.onEditCancel &&
  prev.onTestConnection === next.onTestConnection &&
  prev.planStep === next.planStep &&
  (prev.replySources ?? false) === (next.replySources ?? false),
);

PaneMessageList.displayName = 'PaneMessageList';

function MergeSourcesNoticeInner({
  mergeSources,
  parentNodeId,
  sourceLabels,
}: {
  mergeSources?: readonly string[];
  parentNodeId?: string;
  sourceLabels?: readonly string[];
}) {
  if ((mergeSources?.length ?? 0) === 0) return null;
  const sourceIds = [
    ...(parentNodeId ? [parentNodeId] : []),
    ...(mergeSources ?? []),
  ];
  const allSources = sourceLabels ?? sourceIds;

  return (
    <div className="t-pre-block tone-mauve" style={{ margin: '0 0 12px 0' }}>
      <div className="t-pre-block-col">
        <div className="t-pre-block-cap">
          synthesizing <b>{allSources.length}</b> threads
        </div>
        {allSources.map((label, i) => {
          return (
            <div key={`${label}-${i}`} className="t-pre-block-quoted" title={label}>
              <ChatIcon size="sm" style={{ verticalAlign: 'text-bottom' }} /> {label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface LatestWarning {
  warning: RuntimeWarning;
  /** The message that carries it, else the turn it came in. */
  ownerId: string;
}

/** The node's newest runtime warning, from a message or else the node. */
function latestWarning(node: ChatNodeState | undefined): LatestWarning | null {
  if (!node) return null;
  const owner = node.messages.findLast(message => message.warnings?.length);
  const warning = owner?.warnings?.at(-1) ?? node.warning;
  return warning ? { warning, ownerId: owner?.id ?? node.activeTurnId ?? '' } : null;
}

const sameWarning = (a: LatestWarning | null, b: LatestWarning | null) =>
  a === b || (!!a && !!b && a.warning === b.warning && a.ownerId === b.ownerId);

/**
 * Reads the warning on the structure channel: the 'warning' action is not
 * HIGH_FREQ, so streamed chunks neither re-render the banner nor re-scan the
 * messages.
 */
function RuntimeWarningBannerInner({ nodeId }: { nodeId: string }) {
  const select = React.useCallback((nodes: Record<string, ChatNodeState>) => latestWarning(nodes[nodeId]), [nodeId]);
  const latest = useOptionalStructuralSelector(select, sameWarning);
  const [dismissedKey, setDismissedKey] = React.useState<string>();
  const warning = latest?.warning;
  const key = latest ? `${latest.ownerId}:${latest.warning.source}:${latest.warning.category}:${latest.warning.message}` : undefined;
  if (!warning || key === dismissedKey) return null;
  const label = warning.source === 'mcp' ? `MCP server "${warning.serverName ?? 'unknown'}"` : warning.source;
  return <div role="status" className="t-pre-block" style={{ margin: '8px 0', display: 'flex', gap: 8 }}>
    <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{label}: {warning.message}</span>
    <button type="button" aria-label="Dismiss warning" onClick={() => setDismissedKey(key)}><CloseIcon size="sm" /></button>
  </div>;
}

function McpServerErrorInner({ error }: { error: ChatNodeState['mcpServerError'] }) {
  const [dismissed, setDismissed] = React.useState(false);

  // Reset local dismiss when the error identity changes (new failure on same node).
  const errorKey = error ? `${error.serverName}::${error.error}` : null;
  React.useEffect(() => { setDismissed(false); }, [errorKey]);

  if (!error || dismissed) return null;

  return (
    <div
      role="alert"
      style={{
        margin: '8px 0',
        padding: '6px 10px',
        fontSize: 'var(--fs-sm)',
        color: 'var(--term-danger-text)',
        border: '1px solid var(--term-danger)',
        borderRadius: 'var(--ui-radius)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <WarningIcon size="sm" style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        MCP server &quot;{error.serverName}&quot; failed: {error.error}
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        style={{
          cursor: 'pointer',
          color: 'var(--term-danger)',
          background: 'none',
          border: 'none',
          padding: '0 4px',
          font: 'inherit',
          fontSize: 'var(--fs-lg)',
          lineHeight: 1,
          opacity: 0.7,
          flexShrink: 0,
          display: 'inline-flex',
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

type FollowUpFields = Pick<ChatNodeState, 'followUps' | 'status' | 'visibleResponseComplete' | 'followUpsGenerating'>;

function followUpsLoading(node: FollowUpFields): boolean {
  return node.status === 'streaming' && !!node.followUpsGenerating && node.followUps.length === 0;
}

function lastUserKey(node: ChatNodeState): string | undefined {
  const message = node.messages.findLast((m) => m.role === 'user');
  return message ? message.clientKey ?? message.id : undefined;
}

/**
 * The follow-ups the section last showed went because a message was just
 * sent (user-send clears them and starts the turn under a new user
 * message). A loading state, a turn without a new message, or follow-ups
 * that ran out are not sends.
 */
function sentFromHere(shown: ChatNodeState | null, node: ChatNodeState): boolean {
  if (!shown || shown.followUps.length === 0) return false;
  if (node.status !== 'streaming' || node.followUps.length > 0 || node.followUpsGenerating) return false;
  const sent = node.messages.findLast((m) => m.role === 'user');
  return !!sent && isFresh(sent.createdAt) && lastUserKey(node) !== lastUserKey(shown);
}

function FollowUpsSectionInner({
  followUps,
  status,
  visibleResponseComplete,
  followUpsGenerating,
  leaving,
  onLeft,
  arriving,
  onArrived,
  collapsed,
  onToggleCollapsed,
  onContinueFollowUp,
  onBranchFollowUp,
  disabled,
}: FollowUpFields & {
  /** A send cleared it: fade out (120ms), then onLeft. */
  leaving: boolean;
  onLeft: () => void;
  /** Its turn ended on screen: the rows pop in; the last one's end calls onArrived. */
  arriving: boolean;
  onArrived: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onContinueFollowUp: (question: string) => void;
  onBranchFollowUp: (question: string) => void;
  disabled: boolean;
}) {
  const contentId = React.useId();
  const present = !leaving;
  const sectionRef = React.useRef<HTMLElement>(null);
  React.useLayoutEffect(() => {
    const el = sectionRef.current;
    if (!leaving || !el) return;
    const controls = animate(el, { opacity: 0 }, { duration: DUR.brief, ease: 'linear', onComplete: onLeft });
    return () => {
      controls.stop();
      // Shown again (the send was refused and its follow-ups came back).
      el.style.opacity = '';
    };
  }, [leaving, onLeft]);
  const loading = followUpsLoading({ followUps, status, followUpsGenerating });
  // On a phone a background branch leaves the screen as it was, so the button
  // keeps the trace: it reads Branched. New follow-ups start clean.
  const phone = usePhoneLayout();
  const [branched, setBranched] = React.useState<ReadonlySet<string>>(() => new Set());
  const [branchedFor, setBranchedFor] = React.useState(followUps);
  if (branchedFor !== followUps) {
    setBranchedFor(followUps);
    setBranched(new Set());
  }

  return (
    <section
      ref={sectionRef}
      className="t-followups"
      aria-label="Suggested follow-ups"
      aria-busy={loading}
      // A leaving section is no longer part of the page.
      aria-hidden={present ? undefined : true}
      inert={!present}
    >
      <h3 className="t-followups-heading">
        <button
          type="button"
          className="t-followups-toggle"
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={onToggleCollapsed}
        >
          Explore further
          <span className="t-followups-chevron" aria-hidden><ChevronDownIcon /></span>
        </button>
      </h3>
      <div id={contentId} hidden={collapsed}>
        {loading ? (
          <>
            <div className="t-followups-loading" role="status"><SpinnerIcon className="motion-safe:animate-spin" />Preparing next steps…</div>
            <div aria-hidden>{[0, 1, 2].map(i => <div key={i} className="t-followup-skeleton" />)}</div>
          </>
        ) : followUps.slice(0, 3).map((q, i, shown) => (
          <FollowUpRow
            key={i}
            index={i}
            question={q}
            arriving={arriving}
            onArrived={i === shown.length - 1 ? onArrived : undefined}
            disabled={disabled || (status === 'streaming' && !visibleResponseComplete)}
            onContinue={onContinueFollowUp}
            onBranch={(question) => {
              if (phone) setBranched((prev) => new Set(prev).add(question));
              onBranchFollowUp(question);
            }}
            branched={phone && branched.has(q)}
          />
        ))}
      </div>
    </section>
  );
}
