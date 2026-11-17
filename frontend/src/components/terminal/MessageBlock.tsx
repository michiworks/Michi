import { ASSISTANT_THREAD_MESSAGE_TITLE, closesFence, formatTokenCount, isCheckinNodeId, openingFence, type DurableUserInput, type MarkdownFence, type ThreadMessagePlanSource, type ThreadMessageSource, type UsageCharge } from 'michi-shared';
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionGlobalConfig, PresenceContext, animate, motion, useIsPresent, useReducedMotionConfig } from 'motion/react';
import { DUR, EASE } from '../../motion/tokens';
import { AssistantBlock, ChatMessage, ToolCallState, SubagentInfo, UserInputRequest } from '../../state/chatTypes';
import { turnErrorAction } from '../../state/turnErrorRecovery';
import { interruptionCauseOfKind } from '../../state/turnInterruption';
import { useRuntimeLabel } from '../../state/skillCatalog';
import { skillSourceLabel } from '../../state/slashEntries';
import { isSubagentActive } from '../../state/backgroundWork';
import { isRunningStatus, isHiddenInternalTool, toolSpanMs } from './toolCallGrouping';
import { AgentTurnContext, LineRun, LineWorkFold, useAgentTurnInfo, type LineRunItem } from './AgentLineBlocks';
import { splitFinishedTurn } from './workFold';
import { visibleGroupTools } from './subagents/subagentPresentation';
import { activityWindow, activityWindowMs } from './agentBlockTiming';
import { ToolCallGroup } from './ToolCallGroup';
import { useHoldHeightWhileLive } from './useHoldHeightWhileLive';
import { TurnReceipts } from './TurnReceipts';
import { MultiModelReceipt } from './multiModel/MultiModelReceipt';
import { MessageWorkflowRuns } from './workflows/MessageWorkflowRuns';
import type { WorkflowPlacement } from '../../state/workflowDomain';
import type { AgentResourceIdentity } from '../../state/agentIdentity';
import type { TerminalDensity } from '../../state/prefs';
import { Reveal, RevealOnShow, revealOpened } from './agentBlockMotion';
import type { PlanEntry } from '../../services/api';
import MarkdownContent from '../MarkdownContent';
import { MarkdownTableLiveContext } from '../MarkdownFeatureTable';
import { QuoteChip } from './QuoteChip';
import { AttachmentPills } from './AttachmentPills';
import { CommentChips } from './CommentChips';
import {
  carryEqual,
  isClusterableAnswerRun,
  sameBlockRefs,
  sameToolRefs,
  splitAssistantRuns,
  useAnswerRunStream,
  useVisibleStream,
  type AssistantRun,
  type SentinelCarry,
} from '../../state/streamingProjection';
import { hasAssistantBlocks } from '../../state/assistantBlocks';
import type { ChildAnchor } from '../../state/branchAnchors';
import { ANCHOR_GROW_FROM, ANCHOR_GROW_STYLE, ANCHOR_GROW_TO, BranchAnchorRow } from './BranchAnchorRow';
import { isFresh } from '../../motion/useFresh';
import { BranchQuoteMarks } from './BranchQuoteMarks';
import { ImageBlockView } from './ImageBlockView';
import { ChatBlocksView } from './ChatBlocksView';
import { SteeringReports } from './SteeringReports';
import { streamingMarkdownBlocksEnabled } from './streamingMarkdownBlocksFlag';
import { focusPaneComposer } from './paneFocus';
import UserInputBanner, { ResolvedUserInput } from './UserInputBanner';
import { useChatActions } from '../../state/chatStore';
import { useIsCompanionNodeId } from '../../state/companion/companionStore';
import { openCompanionPanel } from '../../state/companion/companionPanel';
import { useCompanionName } from '../../state/companion/companionName';
import { BranchIcon, CheckIcon, CopyIcon, EditIcon, ForkIcon, PlayIcon, RetryIcon, SettingsIcon } from './icons';
import { useMetaChatDecorations } from '../../state/metaChat/metaChatDecorations';
import { formatMessageTime } from '../../lib/messageTime';
import { useCopyFeedback } from '../../hooks/useCopyFeedback';
import { isImeComposing } from '../../lib/ime';
import { kbd } from '../../lib/platform';
import type { MultiModelBranchControls } from './multiModelBranch';
import { ReplyMemorySources } from './ReplyMemorySources';
import { TurnEndNote } from './TurnEndNote';
import { MarkdownLinkRendererContext } from '../markdownLinkRenderer';

const StreamingMarkdownContent = React.lazy(() => import('./StreamingMarkdownContent'));

/**
 * Context providing the current node's pendingUserInput so that inline
 * user-input segments can render without prop-drilling through memoized layers.
 */
export interface NodeUserInputContextValue {
  userInput: UserInputRequest | null | undefined;
  nodeId: string;
}

export const NodeUserInputContext = createContext<NodeUserInputContextValue | null>(null);

/** Renders a user-input segment inline within the weave pipeline. */
function InlineUserInputSegment({ requestId, interaction }: { requestId: number; interaction?: DurableUserInput }) {
  const ctx = useContext(NodeUserInputContext);
  const current = ctx?.userInput;
  const matchesCurrent = current?.requestId === requestId && (!interaction || !current.interactionId || current.interactionId === interaction.interactionId);
  const ui: UserInputRequest | undefined = interaction
    ? { ...interaction, resolved: interaction.status !== 'pending', interrupted: interaction.status === 'interrupted', receivedAt: matchesCurrent ? current?.receivedAt : undefined }
    : matchesCurrent ? current : undefined;
  if (!ui) return null;
  if (ui.resolved) return <ResolvedUserInput userInput={ui} />;
  if (!matchesCurrent || !ctx) return <UserInputBanner userInput={ui} readOnly onSubmit={() => {}} onSkip={() => {}} />;
  return <ActiveUserInputSegment userInput={ui} nodeId={ctx.nodeId} />;
}

function ActiveUserInputSegment({ userInput, nodeId }: { userInput: UserInputRequest; nodeId: string }) {
  const { resolveUserInputRequest, skipUserInputRequest } = useChatActions();
  return <UserInputBanner userInput={userInput}
    onSubmit={(answers) => resolveUserInputRequest(nodeId, answers)}
    onSkip={() => skipUserInputRequest(nodeId)} />;
}

export interface TurnUsageInfo {
  durationMs?: number;
  credits?: number;
  charge?: UsageCharge;
  unverifiable?: boolean;
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  contextUsagePercentage?: number;
}

/**
 * The usage part of an answer's meta line: its tokens, else its cost. The
 * in/out breakdown, the duration and the context share are in usageTitle.
 */
function usageMetaText(usage: TurnUsageInfo): string | null {
  if (usage.unverifiable) return 'usage unverifiable';
  if (usage.totalTokens !== undefined) return `${formatTokenCount(usage.totalTokens)} tokens`;
  if (usage.charge) {
    const estimate = usage.charge.provenance === 'sdk_estimate' || usage.charge.provenance === 'catalog_estimate' ? 'estimated ' : '';
    return `${estimate}${usage.charge.amount.toFixed(usage.charge.unit === 'USD' ? 4 : 2)} ${usage.charge.unit}`;
  }
  if (usage.credits !== undefined) return `${usage.credits.toFixed(2)} credits`;
  return null;
}

function usageTitle(usage: TurnUsageInfo): string {
  const details = usage.durationMs === undefined ? [] : [`Duration ${(usage.durationMs / 1000).toFixed(1)} seconds`];
  if (usage.charge) details.push(`${usage.charge.amount} ${usage.charge.unit} (${usage.charge.provenance.replaceAll('_', ' ')})`);
  if (usage.totalTokens !== undefined) details.push(`${Math.round(usage.totalTokens).toLocaleString('en-US')} total tokens`);
  if (usage.inputTokens !== undefined) details.push(`${Math.round(usage.inputTokens).toLocaleString('en-US')} input tokens`);
  if (usage.cachedInputTokens !== undefined && usage.cachedInputTokens > 0) {
    details.push(`${Math.round(usage.cachedInputTokens).toLocaleString('en-US')} cached input tokens`);
  }
  if (usage.outputTokens !== undefined) details.push(`${Math.round(usage.outputTokens).toLocaleString('en-US')} output tokens`);
  if (usage.reasoningOutputTokens !== undefined && usage.reasoningOutputTokens > 0) {
    details.push(`${Math.round(usage.reasoningOutputTokens).toLocaleString('en-US')} reasoning tokens`);
  }
  if (usage.contextUsagePercentage !== undefined) {
    details.push(`${usage.contextUsagePercentage.toFixed(1)}% context used`);
  }
  return details.join(', ');
}

/**
 * A message's action row. Under a user message: copy, retry, edit, branch
 * and the time, on hover. Under an answer it is the answer's meta line
 * (`answer`): copy, retry and branch, then "time · tokens" at the chrome's
 * 12px, all of it shown together. index.css shows it while its message is
 * hovered (a tap on a touch screen, unless it lands on a control), while
 * keyboard focus is in the answer or on the row's own buttons, and at rest
 * when `pinned`; a pointer over a message, even a streaming one, commits no
 * render (ST-27).
 */
function MessageActions({
  pinned = false,
  restVisible = false,
  answer = false,
  time,
  copyText,
  onRetry,
  onEdit,
  editRef,
  onBranch,
  usageInfo,
}: {
  /** Shown at rest: the latest answer's meta line. */
  pinned?: boolean;
  /** Touch screens show this row without a tap (index.css). */
  restVisible?: boolean;
  answer?: boolean;
  time: string;
  /** The words Copy puts on the clipboard, read at the press. */
  copyText: () => string;
  onRetry?: () => void;
  onEdit?: () => void;
  /** The Edit button, which takes focus back when its inline edit closes. */
  editRef?: React.Ref<HTMLButtonElement>;
  onBranch?: () => void;
  usageInfo?: TurnUsageInfo | null;
}) {
  const { result: copyResult, status: copyStatus, copy } = useCopyFeedback();
  const usageText = answer && usageInfo ? usageMetaText(usageInfo) : null;
  const usageDetails = answer && usageInfo ? usageTitle(usageInfo) : '';
  return (
    <div
      data-msg-actions={pinned ? 'pinned' : restVisible ? 'rest' : undefined}
      data-find-skip
      className={answer ? 't-answer-meta' : undefined}
      style={answer ? undefined : { display: 'flex', alignItems: 'center', marginTop: 4, paddingLeft: 0 }}
    >
      <div className="t-msg-actions" style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void copy(copyText()); }}
          className="t-icon-btn t-rest-ink"
          title="copy message"
          aria-label="copy message"
        >
          {copyResult === 'copied' ? <CheckIcon /> : <CopyIcon />}
        </button>
        {/* Only while there is a result: a transcript would otherwise hold a live region per message. */}
        {copyStatus && <span className="sr-only" role="status">{copyStatus}</span>}
        {onRetry && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="t-icon-btn t-rest-ink"
            title="retry this turn"
            aria-label="retry this turn"
          >
            <RetryIcon />
          </button>
        )}
        {onEdit && (
          <button
            ref={editRef}
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="t-icon-btn t-rest-ink"
            title="edit and resend"
            aria-label="edit and resend"
          >
            <EditIcon />
          </button>
        )}
        {onBranch && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onBranch(); }}
            className="t-icon-btn t-rest-ink"
            title="branch from here"
            aria-label="branch from here"
          >
            <BranchIcon />
          </button>
        )}
        {answer ? (
          (time || usageText) && (
            // Parts are joined by a CSS "·" (index.css), so a surface that
            // hides the usage part (the Meta agent window) leaves no stray dot.
            <span className="t-answer-meta__text" title={usageDetails || undefined}>
              {time && <span className="t-answer-meta__part">{time}</span>}
              {usageText && <span className="t-answer-meta__part" data-testid="turn-usage">{usageText}</span>}
            </span>
          )
        ) : time && (
          <span
            className="t-msg-meta"
            style={{ fontSize: 'var(--msg-meta-size, var(--fs-xs))', fontFamily: 'var(--ui-font)', color: 'var(--term-muted)', marginLeft: 4 }}
          >
            {time}
          </span>
        )}
      </div>
    </div>
  );
}

function TermPlanBlock({ entries }: { entries: PlanEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div style={{ borderLeft: '2px solid var(--term-muted)', paddingLeft: 8, marginBottom: 8, fontSize: 'var(--fs-sm)' }}>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', letterSpacing: 'var(--ls-caps-wide)', marginBottom: 4, fontFamily: 'var(--ui-font)' }}>
        PLAN
      </div>
      {entries.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, lineHeight: 1.5, color: e.status === 'completed' ? 'var(--term-muted)' : 'var(--term-fg)' }}>
          <span style={{ fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-xs)', flexShrink: 0 }}>
            {e.status === 'completed' ? <CheckIcon size="sm" style={{ verticalAlign: 'text-bottom' }} /> : e.status === 'in_progress' ? '›' : '·'}
          </span>
          <span style={{ textDecoration: e.status === 'completed' ? 'line-through' : 'none' }}>{e.content}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Motion (motion.dev) ──
   Only what arrives while a message is on screen animates: everything a
   MessageBlock renders on its first commit (hydration, lazy loads, remounts)
   is settled. Streamed Markdown never animates and loops stay in CSS. */

interface MessageMotionScope {
  /** True once the message has committed; blocks mounting later are new. */
  mounted: { current: boolean };
}

const MessageMotionContext = createContext<MessageMotionScope | null>(null);

/** True when a block arrives live (it fades in), false to render it settled.
 *  Decided on the block's first render. */
function useBlockEntrance(live: boolean | undefined): boolean {
  const scope = useContext(MessageMotionContext);
  const [enters] = useState(() => !!live && !!scope?.mounted.current);
  return enters;
}

/** Step-list renderer for Codex reasoning summaries (split by \n). */
/** Strip lightweight Markdown formatting (bold, italic, code) so step text renders as plain text. */
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1');
}

function CodexStepList({ text, streaming }: { text: string; streaming?: boolean }) {
  const parts = text.split('\n').filter((s) => s.trim().length > 0);
  if (parts.length === 0) return null;
  return (
    <div style={{ paddingLeft: 4, lineHeight: 1.7 }}>
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1;
        const done = !isLast || !streaming;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{ opacity: done ? 0.5 : 1, fontSize: 'var(--fs-xs)' }}>
              {done ? <CheckIcon size="sm" style={{ verticalAlign: 'text-bottom' }} /> : '●'}
            </span>
            <span style={{ opacity: done ? 0.7 : 1 }}>
              {stripInlineMarkdown(part)}
              {!done && (
                <span className="typing-dot" style={{ marginLeft: 2, animationDelay: '0s' }} />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Ephemeral thinking timer: stamps when `streaming` first turns true and
 * reports elapsed ms once it turns false. Hydrated (never-streaming) messages
 * return undefined — the label degrades to a duration-less form.
 */
function useThinkingTimer(streaming: boolean | undefined): number | undefined {
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (streaming && startRef.current == null) {
      startRef.current = Date.now();
      return;
    }
    if (!streaming && startRef.current != null) {
      setElapsed((prev) => prev ?? Date.now() - startRef.current!);
    }
  }, [streaming]);
  return elapsed;
}

/** Interleaved thought-body content for merged agent clusters: thought prose
 *  chunks and tool groups in their original stream order. */
export type ThoughtSegment =
  | { key: string; kind: 'text'; text: string }
  | { key: string; kind: 'tools'; tools: ToolCallState[] };

export function TermThoughtBlock({
  text,
  streaming,
  phase,
  runtimeId,
  durationMs,
  startedAt,
  endedAt,
  segments,
  subagents,
}: {
  text?: string;
  streaming?: boolean;
  phase?: StreamPhase;
  runtimeId?: string | null;
  /** Fallback duration (e.g. tool-span of the run) for hydrated turns. */
  durationMs?: number;
  /** Durable activity window (backend clock, see agentBlockTiming). With
   *  `endedAt` too it gives the finished duration. */
  startedAt?: number;
  endedAt?: number;
  /** When provided, the run renders these interleaved chunks instead of `text`. */
  segments?: readonly ThoughtSegment[];
  /** Roster for tool groups rendered from `segments`. */
  subagents?: readonly SubagentInfo[];
}) {
  const liveElapsed = useThinkingTimer(streaming);
  // A block that starts streaming while its message is on screen fades in;
  // one already there renders settled.
  const enters = useBlockEntrance(streaming);
  if (!text && !segments?.length) return null;

  // Duration is the durable activity window when the blocks carry it;
  // otherwise (legacy turns) the mount-scoped live timer when this block
  // streamed here, or the tool-span for hydrated turns.
  const dur = activityWindowMs(startedAt, endedAt) ?? liveElapsed ?? durationMs;

  const thoughtProse = (chunk: string, chunkStreaming: boolean | undefined, key?: string) => {
    if (runtimeId === 'codex') return <CodexStepList key={key} text={chunk} streaming={chunkStreaming} />;
    const prose = { text: chunk, size: 'xs', style: thoughtProseVars, className: '[&_a]:underline' } as const;
    const settled = <MarkdownContent key={key} {...prose} />;
    if (!chunkStreaming || !streamingMarkdownBlocksEnabled()) return settled;
    // The streaming segment re-parses at the answer's cadence (MO-18), not on
    // every commit; it takes no character fade, which stays the answer's.
    return (
      <React.Suspense key={key} fallback={settled}>
        <StreamingMarkdownContent {...prose} />
      </React.Suspense>
    );
  };

  // One disclosure line, the same box live and settled.
  const items: LineRunItem[] = segments
    ? segments.flatMap((seg): LineRunItem[] => (seg.kind === 'text'
      ? [{ kind: 'text', key: seg.key, text: seg.text }]
      : visibleGroupTools(seg.tools, subagents).map((tool) => ({ kind: 'tool', key: tool.id, tool }))))
    : text ? [{ kind: 'text', key: 'thought', text }] : [];
  // Only hidden plumbing tools and no thought: nothing to say once settled.
  if (!streaming && items.length === 0) return null;
  return (
    <LineRun
      items={items}
      live={!!streaming}
      phase={phase}
      startedAt={startedAt}
      durationMs={dur}
      subagents={subagents}
      renderProse={thoughtProse}
      enter={enters}
      kind="thought"
    />
  );
}

function ThinkingIndicator() {
  // Three bouncing dots — purely a "something is happening" placeholder
  // shown only while the assistant has streaming=true but no blocks/text/
  // thought/tools have arrived yet. Replaces the older "Thinking…" copy
  // which overclaimed what was actually happening (mostly network wait,
  // not reasoning). Reuses the existing bounce-dot @keyframes in index.css.
  // Entrance and exit belong to PendingIndicatorSlot.
  return (
    <div style={{ padding: '6px 0' }} aria-label="loading" role="status">
      <span className="typing-dot" />
      <span className="typing-dot" style={{ animationDelay: '.15s' }} />
      <span className="typing-dot" style={{ animationDelay: '.3s' }} />
    </div>
  );
}

function PendingDots({ ref }: { ref?: React.Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: DUR.brief } }}
      exit={{ opacity: 0, transition: { duration: DUR.dismiss } }}
      // Leaving dots are no longer a status.
      aria-hidden={present ? undefined : true}
    >
      <ThinkingIndicator />
    </motion.div>
  );
}

/**
 * Where the pending dots sit. When the first content replaces them they fade
 * out in place (popped out of the flow, so nothing jumps). Placed before the
 * message's content. Memoized: streamed chunks re-render its parent, not it.
 */
const PendingIndicatorSlot = React.memo(function PendingIndicatorSlot({ show }: { show: boolean }) {
  return (
    // The positioned parent popLayout needs for the leaving dots.
    <div style={{ position: 'relative' }}>
      <AnimatePresence initial={false} mode="popLayout">
        {show && <PendingDots key="pending" />}
      </AnimatePresence>
    </div>
  );
});

/**
 * Under a user message of an ordinary chat whose live session read
 * check-in material on an earlier turn (the route's companionTurn.carriedTaint,
 * w3-fix D17): why its tools ask. The agent's own conversation draws its
 * route lines itself (CompanionChatTab's afterMessage decoration). The route
 * arrives after the send: under a message sent on screen (`enter`) the note
 * grows in.
 */
function CarriedTaintNote({ message, enter }: { message: Pick<ChatMessage, 'role' | 'companionTurn'>; enter: boolean }) {
  const turn = message.role === 'user' ? message.companionTurn : undefined;
  return (
    <RevealOnShow show={!!turn?.carriedTaint && !turn.startTaint} enter={enter}>
      <p
        role="note"
        className="terminal-message-turn-note"
        style={{ margin: '4px 0 0', textAlign: 'right', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}
      >
        Anything that would leave this machine asks first: this conversation read check-in material earlier.
      </p>
    </RevealOnShow>
  );
}

/**
 * A relayed user message's source line. A follow-up the agent sent
 * (DESIGN-v2 §4: `companionSend`, or any message from its conversation, a
 * check-in, or an earlier assistant conversation: ⌘J's or Scheduled's,
 * which send as ASSISTANT_THREAD_MESSAGE_TITLE) reads "From <name>", says
 * "Sent by <name>", and opens the panel: those conversations live in the
 * hidden workspace, never opened as a pane there. The store is subscribed,
 * so a message drawn before /assistant answered follows once it does
 * (W3-F3-review #6). Any other thread's message names that thread and opens
 * it (ThreadSourceCaption: a reply, a multi-model plan step).
 */
function ThreadMessageSourceLine({ message, freshContext, onMentionClick }: {
  message: Pick<ChatMessage, 'threadMessage' | 'companionSend'>;
  freshContext?: boolean;
  onMentionClick?: (name: string, kind: string, nodeId?: string) => void;
}) {
  const source = message.threadMessage;
  const fromNodeId = source?.fromNodeId ?? '';
  const fromCompanion = useIsCompanionNodeId(fromNodeId);
  if (message.companionSend || isCheckinNodeId(fromNodeId) || fromCompanion
    || source?.fromTitle === ASSISTANT_THREAD_MESSAGE_TITLE) return <CompanionSendSourceLine source={source} />;
  if (!source) return null;
  return <ThreadSourceCaption source={source} freshContext={freshContext} onMentionClick={onMentionClick} />;
}

/** "From <name>", in ThreadSourceCaption's words for a reply or a plan step. */
function CompanionSendSourceLine({ source }: { source?: ThreadMessageSource }) {
  const name = useCompanionName();
  const plan = source?.plan;
  return (
    <div className="terminal-message-thread-source" data-companion-send="" title={plan ? PLAN_SOURCE_TITLE : `Sent by ${name}`}>
      {plan && <span className="mm-plan-caption-icon"><ForkIcon /></span>}
      {source?.kind === 'reply' && !plan ? 'Reply from' : 'From'}{' '}
      <button
        type="button"
        className="terminal-message-thread-link"
        onClick={(event) => {
          // Not a mention: the bubble's own handler would open the hidden conversation as a pane.
          event.stopPropagation();
          openCompanionPanel({ tab: 'chat' });
        }}
      >
        {name}
      </button>
      {plan && planStepCaption(plan)}
    </div>
  );
}

/**
 * Wrap `@name` tokens inside `text` in `<span class="mention-chip">` tags
 * so they render as styled clickable chips. Matches known context names greedily
 * (longest first) so names with spaces resolve correctly.
 *
 * When `nodeMentions` are provided, also wraps `@title` tokens for node mentions
 * with an additional `data-node-id` attribute for click navigation.
 */
export function highlightMentions(
  text: string,
  contextNames: ReadonlySet<string>,
  nodeMentions?: ReadonlyArray<{ label: string; nodeId: string }>,
): string {
  if (contextNames.size === 0 && (!nodeMentions || nodeMentions.length === 0)) return text;
  let result = text;

  // Handle node mentions first (they carry unique nodeId for navigation)
  if (nodeMentions && nodeMentions.length > 0) {
    const sorted = [...nodeMentions].sort((a, b) => b.label.length - a.label.length);
    for (const { label, nodeId } of sorted) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|(?<=\\s))@(${escaped})(?=\\s|[,;:!?）)}\\]"]|$)`, 'giu');
      result = result.replace(re, (_full, matched: string) => {
        const htmlEsc = matched.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const nodeIdEsc = nodeId.replace(/"/g, '&quot;');
        return `<span class="mention-chip" data-mention="${htmlEsc}" data-mention-kind="node" data-node-id="${nodeIdEsc}">@${htmlEsc}</span>`;
      });
    }
  }

  // Handle context mentions
  if (contextNames.size > 0) {
    const sorted = [...contextNames].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|(?<=\\s))@(${escaped})(?=\\s|[,;:!?）)}\\]"]|$)`, 'giu');
      result = result.replace(re, (_full, matched: string) => {
        const htmlEsc = matched.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        return `<span class="mention-chip" data-mention="${htmlEsc}" data-mention-kind="context">@${htmlEsc}</span>`;
      });
    }
  }

  return result;
}

/**
 * Display-time markdown prep for USER message text. Chat line breaks are
 * literal `\n` (Shift+Enter, pasted email bodies), but markdown collapses a
 * single newline into a space — so suffix every plain line with the two-space
 * hard-break marker. Lines inside fenced code blocks stay verbatim (trailing
 * spaces there would leak into the code), and blank lines already separate
 * paragraphs. `m.text` itself is never modified — copy/edit/retry keep the
 * exact typed characters.
 */
export function userTextToMarkdown(text: string): string {
  const lines = text.split('\n');
  let fence: MarkdownFence | null = null;
  return lines
    .map((line, i) => {
      if (fence) {
        if (closesFence(line, fence)) fence = null;
        return line;
      }
      fence = openingFence(line.trimStart());
      if (fence || i === lines.length - 1 || line.trim() === '') return line;
      // A break before a blank line is meaningless (the blank line already
      // ends the paragraph) — keep those lines byte-identical.
      if (lines[i + 1].trim() === '') return line;
      return `${line}  `;
    })
    .join('\n');
}

const proseVars: React.CSSProperties = {
  '--tw-prose-body': 'var(--term-fg)',
  '--tw-prose-headings': 'var(--term-fg)',
  '--tw-prose-bold': 'var(--term-fg)',
  '--tw-prose-code': 'var(--term-fg)',
  '--tw-prose-quotes': 'var(--term-mid)',
  '--tw-prose-links': 'var(--term-accent-text)',
  '--tw-prose-counters': 'var(--term-mid)',
  '--tw-prose-bullets': 'var(--term-mid)',
} as React.CSSProperties;

const thoughtProseVars: React.CSSProperties = {
  '--tw-prose-body': 'inherit',
  '--tw-prose-headings': 'inherit',
  '--tw-prose-bold': 'inherit',
  '--tw-prose-code': 'inherit',
  '--tw-prose-links': 'var(--term-accent-text)',
} as React.CSSProperties;

/** A user message whose @mentions open on click: its chips are buttons. */
const USER_MENTION_FEATURES: import('../MarkdownContent').MarkdownFeatureProfile = {
  mentionButtons: true,
};

/** Feature profile for answer-segment Markdown: enables table controls
 *  (copy / download / fullscreen toolbar + auto-measure-then-lock column
 *  widths to prevent reflow during streaming). */
const ANSWER_FEATURES: import('../MarkdownContent').MarkdownFeatureProfile = {
  tableControls: true,
};

function renderSegments(
  segments: ReturnType<typeof useVisibleStream>['segments'],
  isDark: boolean,
  subagents?: readonly SubagentInfo[],
  opts?: {
    streamingMarkdownBlocks?: boolean;
    /** The last segment is the newest content of a streaming turn. */
    liveTail?: boolean;
  },
) {
  let chipIdx = 0;
  const lastTextIndex = opts?.streamingMarkdownBlocks
    ? segments.reduce((last, seg, index) => (seg.kind === 'text' ? index : last), -1)
    : -1;
  const useStreamingBlocks = lastTextIndex >= 0 && streamingMarkdownBlocksEnabled();
  return segments.map((seg, segmentIndex) => {
    if (seg.kind === 'text') {
      if (useStreamingBlocks && segmentIndex === lastTextIndex) {
        return (
          <React.Suspense
            key={`text-${chipIdx}`}
            fallback={(
              <MarkdownContent
                text={seg.text}
                size="sm"
                className={isDark ? 'prose-invert' : ''}
                style={proseVars}
                revealTailChars={seg.revealTailChars}
                features={ANSWER_FEATURES}
              />
            )}
          >
            <StreamingMarkdownContent
              text={seg.text}
              size="sm"
              className={isDark ? 'prose-invert' : ''}
              style={proseVars}
              revealTailChars={seg.revealTailChars}
              features={ANSWER_FEATURES}
            />
          </React.Suspense>
        );
      }
      return (
        <MarkdownContent
          key={`text-${chipIdx}`}
          text={seg.text}
          size="sm"
          className={isDark ? 'prose-invert' : ''}
          style={proseVars}
          revealTailChars={seg.revealTailChars}
          features={ANSWER_FEATURES}
        />
      );
    }
    if (seg.kind === 'user-input') {
      chipIdx += 1;
      return <InlineUserInputSegment key={seg.interaction?.interactionId ?? `ui-${seg.requestId}`} requestId={seg.requestId} interaction={seg.interaction} />;
    }
    chipIdx += 1;
    return (
      <ToolCallGroup
        key={seg.tools[0].id}
        tools={seg.tools}
        subagents={subagents}
        live={!!opts?.liveTail && segmentIndex === segments.length - 1}
      />
    );
  });
}

function toolMap(toolCalls: readonly ToolCallState[]): Map<string, ToolCallState> {
  return new Map(toolCalls.map((tool) => [tool.id, tool]));
}

function relevantTools(blocks: readonly AssistantBlock[], toolsById: ReadonlyMap<string, ToolCallState>): ToolCallState[] {
  return blocks.flatMap((block): ToolCallState[] => {
    if (block.kind !== 'tool') return [];
    const tool = toolsById.get(block.toolCallId);
    return tool ? [tool] : [];
  });
}

interface AnswerRunViewProps {
  blocks: AssistantBlock[];
  tools: ToolCallState[];
  incomingCarry?: SentinelCarry;
  isDark: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  onSmoothingChange?: (isSmoothing: boolean) => void;
  /** This run is the newest content of a streaming turn (ToolCallGroup `live`). */
  liveTail?: boolean;
}

function AnswerRunViewInner({
  blocks,
  tools,
  incomingCarry,
  isDark,
  subagents,
  runtimeId,
  onSmoothingChange,
  liveTail,
}: AnswerRunViewProps) {
  const toolsById = useMemo(() => toolMap(tools), [tools]);
  const { segments, isSmoothing } = useAnswerRunStream(blocks, toolsById, incomingCarry, runtimeId);
  const streaming = blocks.some((b) => b.kind === 'answer' && b.streaming);
  // Update follow-up visibility before paint, including a short answer whose
  // final text and metadata arrive together while the parent still sees false.
  useLayoutEffect(() => {
    onSmoothingChange?.(isSmoothing);
  }, [isSmoothing, onSmoothingChange]);
  return (
    <>
      {renderSegments(segments, isDark, subagents, { streamingMarkdownBlocks: streaming || isSmoothing, liveTail })}
    </>
  );
}

const AnswerRunView = React.memo(AnswerRunViewInner, (prev, next) =>
  sameBlockRefs(prev.blocks, next.blocks) &&
  sameToolRefs(prev.tools, next.tools) &&
  carryEqual(prev.incomingCarry, next.incomingCarry) &&
  prev.isDark === next.isDark &&
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId &&
  prev.onSmoothingChange === next.onSmoothingChange &&
  prev.liveTail === next.liveTail,
);

/* ── Agent-run clustering ──
   Consecutive thinking runs and tool-only answer runs merge into ONE agent
   block: a single thought line whose body interleaves thought prose and
   tool groups in stream order. Answer runs with visible text break clusters. */

type RenderCluster =
  | { kind: 'agent'; id: string; runs: AssistantRun[] }
  | { kind: 'run'; run: AssistantRun };

function isToolOnlyAnswerRun(run: AssistantRun): boolean {
  return run.kind === 'answer' && run.blocks.length > 0 && run.blocks.every((b) => b.kind === 'tool');
}

const isAgentRun = (run: AssistantRun) => run.kind === 'thinking' || isClusterableAnswerRun(run);

/** True when the agent-run stretch starting at `from` and walking by `step`
 *  contains a thinking run, i.e. it renders as an agent block. */
function agentStretchHasThinking(runs: readonly AssistantRun[], from: number, step: 1 | -1): boolean {
  for (let i = from; i >= 0 && i < runs.length && isAgentRun(runs[i]); i += step) {
    if (runs[i].kind === 'thinking') return true;
  }
  return false;
}

/** Tool blocks (and blank answer fragments between them) at one edge of a run.
 *  Returns how many blocks to peel; 0 unless a visible tool is among them, so
 *  hidden metadata tools never turn a "Thoughts" block into "Worked". */
function edgeToolBlockCount(
  blocks: readonly AssistantBlock[],
  fromEnd: boolean,
  byId: ReadonlyMap<string, ToolCallState>,
): number {
  let count = 0;
  let visibleTool = false;
  for (let k = 0; k < blocks.length; k++) {
    const block = blocks[fromEnd ? blocks.length - 1 - k : k];
    if (block.kind === 'tool') {
      const tool = byId.get(block.toolCallId);
      if (tool && !isHiddenInternalTool(tool.title)) visibleTool = true;
    } else if (!(block.kind === 'answer' && !block.rawText?.trim())) {
      break;
    }
    count++;
  }
  return visibleTool ? count : 0;
}

/**
 * An answer run's prose and its tool calls share one run, so tools the agent
 * ran right after saying what it would do ("Checking first:") sat in a
 * separate group next to the following thought block. Split such edge tools
 * off as tool-only runs when the neighbouring stretch forms an agent block,
 * so clusterAgentRuns merges them into it. Prose keeps the run's id and carry:
 * tool blocks contribute no text to sentinel projection.
 */
function detachEdgeTools(
  runs: AssistantRun[],
  byId: ReadonlyMap<string, ToolCallState>,
): AssistantRun[] {
  const out: AssistantRun[] = [];
  runs.forEach((run, i) => {
    if (run.kind !== 'answer' || isClusterableAnswerRun(run)) {
      out.push(run);
      return;
    }
    let { blocks } = run;
    const lead = agentStretchHasThinking(runs, i - 1, -1) ? edgeToolBlockCount(blocks, false, byId) : 0;
    const leading = blocks.slice(0, lead);
    blocks = blocks.slice(lead);
    const trail = agentStretchHasThinking(runs, i + 1, 1) ? edgeToolBlockCount(blocks, true, byId) : 0;
    const trailing = blocks.slice(blocks.length - trail);
    blocks = blocks.slice(0, blocks.length - trail);
    if (leading.length > 0) out.push({ id: leading[0].id, kind: 'answer', blocks: leading });
    out.push(leading.length > 0 || trailing.length > 0 ? { ...run, blocks } : run);
    if (trailing.length > 0) out.push({ id: trailing[0].id, kind: 'answer', blocks: trailing });
  });
  return out;
}

function clusterAgentRuns(runs: AssistantRun[]): RenderCluster[] {
  const out: RenderCluster[] = [];
  let buf: AssistantRun[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    if (buf.some((r) => r.kind === 'thinking')) {
      out.push({ kind: 'agent', id: buf[0].id, runs: buf });
    } else {
      // Tool-only answer runs with no thinking neighbours keep their plain
      // rendering — a thought header with zero thoughts would be a lie.
      for (const r of buf) out.push({ kind: 'run', run: r });
    }
    buf = [];
  };
  for (const run of runs) {
    if (run.kind === 'thinking' || isClusterableAnswerRun(run)) {
      buf.push(run);
    } else {
      flush();
      out.push({ kind: 'run', run });
    }
  }
  flush();
  return out;
}

type StreamPhase = 'thinking' | 'working' | 'done';

interface AgentClusterViewProps {
  runs: AssistantRun[];
  tools: ToolCallState[];
  streaming: boolean;
  phase: StreamPhase;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  /** Durable activity window, forwarded to TermThoughtBlock. */
  startedAt?: number;
  endedAt?: number;
}

function AgentClusterViewInner({
  runs, tools, streaming, phase, subagents, runtimeId, startedAt, endedAt,
}: AgentClusterViewProps) {
  const toolsById = useMemo(() => toolMap(tools), [tools]);
  const segments = useMemo(() => {
    const out: ThoughtSegment[] = [];
    for (const run of runs) {
      for (const block of run.blocks) {
        if (block.kind === 'thinking') {
          if (!block.rawText) continue;
          const last = out[out.length - 1];
          // Adjacent thinking blocks are stream fragments of one thought:
          // concatenate raw.
          if (last?.kind === 'text') last.text += block.rawText;
          else out.push({ key: block.id, kind: 'text', text: block.rawText });
        } else if (block.kind === 'tool') {
          const tool = toolsById.get(block.toolCallId);
          if (!tool) continue;
          const last = out[out.length - 1];
          if (last?.kind === 'tools') last.tools.push(tool);
          else out.push({ key: block.id, kind: 'tools', tools: [tool] });
        }
      }
    }
    return out;
  }, [runs, toolsById]);
  const spanMs = useMemo(() => toolSpanMs(tools), [tools]);
  return (
    <TermThoughtBlock
      segments={segments}
      streaming={streaming}
      phase={phase}
      runtimeId={runtimeId}
      durationMs={spanMs}
      startedAt={startedAt}
      endedAt={endedAt}
      subagents={subagents}
    />
  );
}

function sameRunRefs(a: AssistantRun[], b: AssistantRun[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || !sameBlockRefs(a[i].blocks, b[i].blocks)) return false;
  }
  return true;
}

const AgentClusterView = React.memo(AgentClusterViewInner, (prev, next) =>
  sameRunRefs(prev.runs, next.runs) &&
  sameToolRefs(prev.tools, next.tools) &&
  prev.streaming === next.streaming &&
  prev.phase === next.phase &&
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId &&
  prev.startedAt === next.startedAt &&
  prev.endedAt === next.endedAt,
);

function LegacyAssistantBody({
  m,
  isDark,
  subagents,
  runtimeId,
  onSmoothingChange,
}: {
  m: ChatMessage;
  isDark: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  onSmoothingChange?: (isSmoothing: boolean) => void;
}) {
  const { segments, isSmoothing } = useVisibleStream(m, runtimeId);
  useLayoutEffect(() => {
    onSmoothingChange?.(isSmoothing);
  }, [isSmoothing, onSmoothingChange]);
  return (
    <>
      {renderSegments(segments, isDark, subagents, { streamingMarkdownBlocks: !!m.streaming || isSmoothing })}
    </>
  );
}

interface BlockAssistantRunsProps {
  m: ChatMessage;
  isDark: boolean;
  showThoughts: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  onSmoothingChange?: (isSmoothing: boolean) => void;
  hidePendingIndicator?: boolean;
}

/**
 * The assistant body. A finished turn folds its work into
 * one LineWorkFold row above the final answer (workFold.splitFinishedTurn):
 * once the turn is over, not just its visible answer (`turnActive`), the answer
 * has finished revealing and no background agent it started still runs.
 */
function BlockAssistantBody({ turnActive, turnDurationMs, ...props }: BlockAssistantRunsProps & {
  turnActive: boolean;
  /** The turn's duration from its usage summary, when known. */
  turnDurationMs?: number;
}) {
  const { m, showThoughts, subagents, onSmoothingChange } = props;
  const [smoothing, setSmoothing] = useState(false);
  const reportSmoothing = useCallback((isSmoothing: boolean) => {
    setSmoothing(isSmoothing);
    onSmoothingChange?.(isSmoothing);
  }, [onSmoothingChange]);
  const settled = !turnActive && !smoothing && !subagents?.some(isSubagentActive);
  const split = useMemo(
    () => (settled ? splitFinishedTurn(m.blocks, m.toolCalls, showThoughts) : null),
    [settled, m.blocks, m.toolCalls, showThoughts],
  );
  const parts = useMemo(() => split && {
    work: { ...m, blocks: split.work },
    lifted: { ...m, blocks: split.lifted },
    final: { ...m, blocks: split.final },
  }, [m, split]);
  const durationMs = useMemo(() => {
    if (!split || turnDurationMs != null) return turnDurationMs;
    const span = activityWindow(m.blocks ?? [], toolMap(m.toolCalls));
    return activityWindowMs(span.startedAt, span.endedAt);
  }, [split, turnDurationMs, m.blocks, m.toolCalls]);
  if (!split || !parts) return <BlockAssistantRuns {...props} onSmoothingChange={reportSmoothing} />;
  return (
    <>
      <LineWorkFold tools={split.tools} notes={split.notes} durationMs={durationMs} subagents={subagents}>
        <BlockAssistantRuns {...props} m={parts.work} onSmoothingChange={undefined} />
      </LineWorkFold>
      {split.lifted.length > 0 && <BlockAssistantRuns {...props} m={parts.lifted} onSmoothingChange={undefined} />}
      <BlockAssistantRuns {...props} m={parts.final} onSmoothingChange={reportSmoothing} />
    </>
  );
}

function BlockAssistantRuns({
  m,
  isDark,
  showThoughts,
  subagents,
  runtimeId,
  onSmoothingChange,
  hidePendingIndicator,
}: BlockAssistantRunsProps) {
  const runs = useMemo(() => splitAssistantRuns(m.blocks), [m.blocks]);
  const byId = useMemo(() => toolMap(m.toolCalls), [m.toolCalls]);
  const clusters = useMemo(
    // With thoughts hidden there is no agent block to join; keep tools
    // under the prose that introduced them.
    () => clusterAgentRuns(showThoughts ? detachEdgeTools(runs, byId) : runs),
    [runs, showThoughts, byId],
  );
  // Backward scans (no array copy). `runs` is rebuilt every chunk as blocks
  // grow, so the old [...runs].reverse().find() copied+reversed on every
  // streamed token of the actively-rendering message.
  // Tool-only answer runs never smooth (no text) — the callback targets the
  // last answer run that can actually stream prose.
  const tailAnswerRunId = useMemo(() => {
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].kind === 'answer' && !isClusterableAnswerRun(runs[i])) return runs[i].id;
    }
    return undefined;
  }, [runs]);
  const liveThinkingId = useMemo(() => {
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i];
      if (run.kind === 'thinking' && run.blocks.some((b) => b.kind === 'thinking' && b.streaming)) {
        return run.id;
      }
    }
    return undefined;
  }, [runs]);
  useLayoutEffect(() => {
    if (!tailAnswerRunId) onSmoothingChange?.(false);
  }, [onSmoothingChange, tailAnswerRunId]);
  return (
    <>
      {m.streaming && <PendingIndicatorSlot show={runs.length === 0 && !hidePendingIndicator} />}
      {clusters.map((cluster, clusterIndex) => {
        const following = clusters[clusterIndex + 1];
        const nextBlock = following
          ? (following.kind === 'agent' ? following.runs[0]?.blocks[0] : following.run.blocks[0])
          : undefined;
        if (cluster.kind === 'agent') {
          const clusterTools = cluster.runs.flatMap((r) => relevantTools(r.blocks, byId));
          if (!showThoughts) {
            // Thought prose is hidden, but tool activity from answer-section
            // runs stays visible — parity with the un-clustered rendering.
            const lastRun = cluster.runs[cluster.runs.length - 1];
            return cluster.runs.filter(isClusterableAnswerRun).map((run) => (
              <AnswerRunView
                key={run.id}
                blocks={run.blocks}
                tools={relevantTools(run.blocks, byId)}
                incomingCarry={run.incomingCarry}
                isDark={isDark}
                subagents={subagents}
                runtimeId={runtimeId}
                liveTail={!!m.streaming && clusterIndex === clusters.length - 1 && run === lastRun}
              />
            ));
          }
          // Keep the block live (tail body visible) while thought tokens or
          // one of its tools are active. Also keep the tail agent cluster live
          // during a between-steps gap: its "Working…" header is then the only
          // liveness signal (StreamActivityIndicator defers to it via
          // tailRunsFormAgentCluster). Once a later answer/image run exists,
          // this cluster is no longer the tail and remains completed.
          const isTailAgentCluster = clusterIndex === clusters.length - 1;
          const isThinking =
            isTailAgentCluster && cluster.runs.some((r) => r.id === liveThinkingId);
          const isTooling =
            isTailAgentCluster &&
            !isThinking &&
            !!m.streaming &&
            clusterTools.some((t) => isRunningStatus(t.status));
          const isBetweenSteps =
            isTailAgentCluster &&
            !isThinking &&
            !isTooling &&
            !!m.streaming;
          const active = isThinking || isTooling || isBetweenSteps;
          const phase: StreamPhase = isThinking ? 'thinking' : active ? 'working' : 'done';
          const activity = activityWindow(cluster.runs.flatMap((r) => r.blocks), byId, nextBlock);
          return (
            <AgentClusterView
              key={cluster.id}
              runs={cluster.runs}
              tools={clusterTools}
              streaming={active}
              phase={phase}
              subagents={subagents}
              runtimeId={runtimeId}
              startedAt={activity.startedAt}
              endedAt={activity.endedAt}
            />
          );
        }
        const run = cluster.run;
        const tools = relevantTools(run.blocks, byId);
        if (run.kind === 'image') {
          return <ImageBlockView key={run.id} blocks={run.blocks} />;
        }
        if (run.kind === 'blocks') {
          return <ChatBlocksView key={run.id} blocks={run.blocks} messageId={m.id} />;
        }
        return (
          <AnswerRunView
            key={run.id}
            blocks={run.blocks}
            tools={tools}
            incomingCarry={run.incomingCarry}
            isDark={isDark}
            subagents={subagents}
            runtimeId={runtimeId}
            onSmoothingChange={run.id === tailAnswerRunId ? onSmoothingChange : undefined}
            liveTail={!!m.streaming && clusterIndex === clusters.length - 1}
          />
        );
      })}
    </>
  );
}

// User messages taller than this many lines collapse behind a "Show more"
// toggle with a fade-out gradient. Measured against the content's computed
// line-height so it tracks the (slider-driven) message font size.
const USER_COLLAPSE_MAX_LINES = 8;

// A collapsed message fades out at its clamp instead of cutting off. A mask
// on the clamped content, not a gradient of the bubble's colour painted over
// it: the bubble is a translucent lift over whatever it sits on
// (--term-user-bubble-bg), so there is no one colour to fade into.
const COLLAPSE_FADE = 'linear-gradient(to bottom, black calc(100% - 2.6em), transparent)';

/** "Show more" under a long user message, and the plan messages' Show toggles. */
const USER_TEXT_TOGGLE_STYLE: React.CSSProperties = {
  marginTop: 4,
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'var(--ui-font)',
  fontSize: 'var(--fs-md)',
  letterSpacing: 'var(--ls-wide)',
};

/**
 * The long-message height tween (TR-18), shared by Show more and a review
 * prompt's Show all: the body switches between a short form `shutHeight()`
 * tall and its full height. Call the returned `measure` on the click, before
 * `expanded` changes: it reads the height to start from, or returns false when
 * nothing will tween (no short height yet, reduced motion). A tween that
 * shuts calls `onShut` when it ends, so the short form can take over then.
 */
function useToggleHeightTween(
  contentRef: React.RefObject<HTMLDivElement | null>,
  expanded: boolean,
  shutHeight: () => number | null,
  onShut: () => void,
): () => boolean {
  const reduceMotion = useReducedMotionConfig() ?? false;
  /** The height a toggle starts from, measured on the click. */
  const toggleFromRef = useRef<number | null>(null);
  const heightMotionRef = useRef<{ stop: () => void } | null>(null);

  const measure = () => {
    const el = contentRef.current;
    heightMotionRef.current?.stop();
    heightMotionRef.current = null;
    const from = el && shutHeight() != null && !reduceMotion ? el.getBoundingClientRect().height : null;
    toggleFromRef.current = from;
    return from !== null;
  };

  // Open 260ms / shut 160ms. Hand-written (skipped under reduced motion).
  // The first frame lands in the click's own commit, 1px past the start, so
  // the transcript height changes there and TPane leaves follow mode, as it
  // did when the clamp just snapped. Opening then scrolls the text into view;
  // shutting scrolls nothing back.
  useLayoutEffect(() => {
    const el = contentRef.current;
    const from = toggleFromRef.current;
    toggleFromRef.current = null;
    if (!el) return;
    const smooth = !reduceMotion && !MotionGlobalConfig.skipAnimations;
    const clampHeight = shutHeight();
    if (from === null || clampHeight == null) {
      if (expanded) revealOpened(el, smooth);
      return;
    }
    const to = expanded ? el.scrollHeight : clampHeight;
    const start = expanded ? from + 1 : Math.max(clampHeight, from - 1);
    el.style.overflow = 'hidden';
    el.style.height = `${start}px`;
    // Written by hand, with a guard: an element animation can write its last
    // frame after onComplete, which would leave a fixed height behind.
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      heightMotionRef.current = null;
      el.style.height = '';
      el.style.overflow = '';
      if (!expanded) onShut();
      // At the end of the transcript there was no room to scroll into until now.
      else revealOpened(el, smooth);
    };
    heightMotionRef.current = animate(start, to, {
      duration: expanded ? DUR.expand : DUR.collapse,
      ease: EASE.drawer,
      onUpdate: (h) => {
        if (!done) el.style.height = `${h}px`;
      },
      onComplete: finish,
    });
    if (expanded) revealOpened(el, smooth, el.getBoundingClientRect().top + to);
    // The short height is read, not watched: a re-measure must not restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  useEffect(() => () => heightMotionRef.current?.stop(), []);
  return measure;
}

/**
 * Clamps long user message bodies to USER_COLLAPSE_MAX_LINES with a bottom
 * fade + "Show more"/"Show less" toggle. Measurement uses scrollHeight (which
 * ignores the max-height clamp) against `lineHeight * MAX_LINES`, re-run via a
 * ResizeObserver so wrapping changes (pane resize, font slider) stay correct.
 */
function CollapsibleUserText({
  contentKey,
  children,
}: {
  contentKey: string;
  children: React.ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = React.useId();
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clampHeight, setClampHeight] = useState<number | null>(null);
  // The clamp style is on. Expanding drops it at once; collapsing keeps it
  // off until the height has come down to it.
  const [clamping, setClamping] = useState(true);
  const measure = useToggleHeightTween(contentRef, expanded, () => clampHeight, () => setClamping(true));

  const toggle = () => {
    const tweens = measure();
    const next = !expanded;
    setExpanded(next);
    if (next || !tweens) setClamping(!next);
  };

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      // A pane mounted at zero width makes every message look overflowing;
      // the observer measures again once the content has a width.
      if (el.clientWidth === 0) return;
      const cs = window.getComputedStyle(el);
      let lineHeight = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
        lineHeight = (parseFloat(cs.fontSize) || 14) * 1.6;
      }
      const threshold = Math.round(lineHeight * USER_COLLAPSE_MAX_LINES);
      // scrollHeight reports the full content height regardless of the clamp,
      // so this stays stable across the collapsed/expanded toggle (no loop).
      const isOver = el.scrollHeight > threshold + 2;
      setOverflowing(isOver);
      setClampHeight(isOver ? threshold : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentKey]);

  const collapsed = overflowing && !expanded;

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={contentRef}
        id={contentId}
        style={{
          position: 'relative',
          // The fade lasts as long as the message is collapsed, the clamp only
          // while the height has come down to it (the disclosure tweens one
          // and not the other).
          ...(collapsed ? { maskImage: COLLAPSE_FADE, WebkitMaskImage: COLLAPSE_FADE } : null),
          ...(collapsed && clamping && clampHeight != null
            ? { maxHeight: clampHeight, overflow: 'hidden' }
            : null),
        }}
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          className="t-hover-fg t-user-text-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          style={USER_TEXT_TOGGLE_STYLE}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/**
 * A plan's review prompt: its instruction paragraph, with the peers' answers
 * behind Show all. It opens and shuts with Show more's height tween; shutting
 * keeps the whole text until the height has come down to the paragraph's.
 */
function ReviewPromptText({ text, head, renderText }: {
  text: string;
  head: string;
  renderText: (text: string) => React.ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState(false);
  /** The paragraph's height, measured while it shows alone: where Show less comes down to. */
  const headHeightRef = useRef<number | null>(null);
  const measure = useToggleHeightTween(bodyRef, open, () => headHeightRef.current, () => setWhole(false));
  const toggle = () => {
    if (!whole && bodyRef.current) headHeightRef.current = bodyRef.current.getBoundingClientRect().height;
    const tweens = measure();
    setOpen(!open);
    if (!open || !tweens) setWhole(!open);
  };
  return (
    <>
      <div ref={bodyRef}>{renderText(whole ? text : head)}</div>
      <button
        type="button"
        className="t-hover-fg t-user-text-toggle"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        style={USER_TEXT_TOGGLE_STYLE}
      >
        {open ? 'Show less' : 'Show all'}
      </button>
    </>
  );
}

/**
 * Terminal error tail below a failed assistant turn. Variants keyed by
 * `errorKind` distinguish unknown outcomes from ordinary execution failures:
 *   - restart interruption: one line and one action, Resume, which carries the
 *     turn on from its kept partial output. Typing a message works as well.
 *   - unknown outcome: check the existing turn; an explicit rerun preserves output.
 *   - connection: the backend already auto-retried once and still failed →
 *     friendly banner + Retry + Test Connection (force-respawn probe).
 *   - auth: SSO/login expired → prompt to re-authenticate (e.g. kiro login).
 *     Retry alone won't help, so no Test Connection button.
 *   - generic / undefined: the original compact "failed · ↻ retry" row, raw
 *     message preserved.
 */
function ErrorTail({
  errorMessage,
  errorKind,
  errorRecovery,
  onRetry,
  onRunAgain,
  onTestConnection,
  planStep,
}: {
  errorMessage?: string;
  errorKind?: string;
  errorRecovery?: 'checking' | 'unavailable';
  onRetry?: () => void;
  onRunAgain?: () => void;
  onTestConnection?: () => Promise<{ ok: boolean; detail?: string }>;
  /** The turn was a multi-model plan step: its run retries it, or the plan is where to go. */
  planStep?: MultiModelBranchControls;
}) {
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testDetail, setTestDetail] = useState<string | undefined>();
  const [confirmRerun, setConfirmRerun] = useState(false);
  // Keep current result hands the keyboard back to Run again, in the commit
  // that removes the confirmation (ST-10).
  const runAgainRef = useRef<HTMLButtonElement>(null);
  const keptRef = useRef(false);
  useLayoutEffect(() => {
    if (confirmRerun || !keptRef.current) return;
    keptRef.current = false;
    runAgainRef.current?.focus();
  }, [confirmRerun]);

  const runTest = async () => {
    if (!onTestConnection || testState === 'testing') return;
    setTestState('testing');
    setTestDetail(undefined);
    const result = await onTestConnection();
    setTestState(result.ok ? 'ok' : 'fail');
    setTestDetail(result.detail);
  };

  const btnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    border: '1px solid var(--term-danger)',
    color: 'var(--term-danger-text)',
    padding: '3px 10px',
    font: '600 var(--fs-sm) var(--ui-font)',
    letterSpacing: 'var(--ls-wide)',
  };

  const isConnection = errorKind === 'connection';
  const isAuth = errorKind === 'auth';
  // A plan step's turn is the run's: no resume, inspection or rerun in the pane.
  const action = planStep ? undefined : turnErrorAction(errorKind);
  const inspectOriginal = action === 'inspect-existing-turn';
  const resumable = action === 'resume-turn';
  const credentialsExpired = resumable && interruptionCauseOfKind(errorKind) === 'credentials';
  const checking = errorRecovery === 'checking';

  // Headline scaled to the class. Connection: we already retried once, so say so.
  const headline = resumable
    ? credentialsExpired ? 'Credentials expired · sign in again , then resume' : 'Turn interrupted'
    : inspectOriginal
    ? errorKind === 'turn_persistence_failed' ? 'Result could not be saved' : 'Original result is not confirmed'
    : isConnection
    ? 'Cannot reach Kiro · auto-retry failed'
    : isAuth
      ? 'Kiro session expired · please re-authenticate'
      : 'failed';

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-sm)',
            letterSpacing: 'var(--ls-wide)',
            color: 'var(--term-danger-text)',
          }}
        >
          {headline}
        </span>
        <span style={{ color: 'var(--term-faint)' }}>·</span>
        {planStep && (planStep.retrying ? (
          <button type="button" data-testid="error-tail-retry" disabled className="t-danger-outline-btn" style={btnStyle}>
            Retrying…
          </button>
        ) : planStep.retry && !isAuth ? (
          <button
            type="button"
            data-testid="error-tail-retry"
            disabled={planStep.busy}
            onClick={(e) => { e.stopPropagation(); planStep.retry?.(); }}
            className="t-danger-outline-btn"
            style={btnStyle}
          >
            <RetryIcon size="sm" />retry
          </button>
        ) : (
          <button
            type="button"
            data-testid="error-tail-open-plan"
            onClick={(e) => { e.stopPropagation(); planStep.openPlan(); }}
            className="t-danger-outline-btn"
            style={btnStyle}
          >
            Open plan
          </button>
        ))}
        {!planStep && (resumable || !isAuth) && onRetry && (
          <button
            type="button"
            data-testid="error-tail-retry"
            disabled={checking}
            onClick={(e) => { e.stopPropagation(); setConfirmRerun(false); onRetry(); }}
            className="t-danger-outline-btn"
            style={btnStyle}
          >
            {resumable ? <><PlayIcon size="sm" />Resume</> : inspectOriginal ? checking ? 'Checking original turn…' : 'Check original turn' : <><RetryIcon size="sm" />retry</>}
          </button>
        )}
        {inspectOriginal && onRunAgain && (
          <button ref={runAgainRef} type="button" disabled={checking} className="t-danger-outline-btn" style={btnStyle}
            onClick={(e) => { e.stopPropagation(); setConfirmRerun(true); }}>
            Run again
          </button>
        )}
        {(isConnection || isAuth) && onTestConnection && (
          <button
            type="button"
            data-testid="error-tail-test-connection"
            onClick={(e) => { e.stopPropagation(); void runTest(); }}
            disabled={testState === 'testing'}
            className="t-danger-outline-btn"
            style={btnStyle}
          >
            {testState === 'testing' ? 'Testing…' : <><SettingsIcon size="sm" />Test Connection</>}
          </button>
        )}
      </div>
      {resumable && (
        <div role="status" style={{ marginTop: 6, maxWidth: 720, color: 'var(--term-muted)', font: 'var(--fs-sm) var(--ui-font)', lineHeight: 1.45 }}>
          {credentialsExpired
            ? 'The agent\'s credentials expired while this task was running. Sign in again first (for example refresh your credentials), then Resume carries on from here. The output above is kept and its tool calls may already have taken effect.'
            : 'Michi restarted while this task was running. The output above is kept and its tool calls may already have taken effect. Resume carries on from here; typing a new message works too.'}
        </div>
      )}
      {inspectOriginal && (
        <div role="status" style={{ marginTop: 6, maxWidth: 720, color: 'var(--term-muted)', font: 'var(--fs-sm) var(--ui-font)', lineHeight: 1.45 }}>
          {checking
            ? 'Checking the original task without sending it again.'
            : errorRecovery === 'unavailable'
              ? 'The original result could not be confirmed. Existing output is kept. Running again may repeat actions.'
              : 'Existing output is kept. Check the original task before running it again; it may already have performed actions.'}
        </div>
      )}
      {inspectOriginal && confirmRerun && !checking && onRunAgain && (
        <div role="group" aria-label="Confirm running again" style={{ marginTop: 8, font: 'var(--fs-sm) var(--ui-font)', color: 'var(--term-fg)' }}>
          <p style={{ margin: '0 0 8px' }}>This sends the same request again and may repeat file changes or other actions. The previous output will stay in this conversation.</p>
          {/* The rerun starts a turn, which takes this whole row away: the
              composer, already there, takes focus first. */}
          <button type="button" className="t-danger-outline-btn" style={btnStyle} onClick={(e) => { e.stopPropagation(); focusPaneComposer(e.currentTarget); setConfirmRerun(false); onRunAgain(); }}>Run again anyway</button>
          {' '}
          <button type="button" className="t-danger-outline-btn" style={btnStyle} onClick={(e) => { e.stopPropagation(); keptRef.current = true; setConfirmRerun(false); }}>Keep current result</button>
        </div>
      )}
      {planStep?.error && (
        <div role="alert" style={{ marginTop: 6, maxWidth: 720, color: 'var(--term-danger-text)', font: 'var(--fs-sm) var(--ui-font)', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
          Retry failed: {planStep.error}
        </div>
      )}
      {testState === 'ok' && (
        <div style={{ marginTop: 6, color: 'var(--term-digest)', font: 'var(--fs-sm) var(--ui-font)' }}>
          {resumable ? 'Connection restored — press Resume to carry on.' : 'Connection restored — click retry to resend.'}
        </div>
      )}
      {testState === 'fail' && (
        <div style={{ marginTop: 6, maxWidth: 720, color: 'var(--term-danger-text)', font: 'var(--fs-sm) var(--ui-font)', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
          Kiro is still unreachable{testDetail ? `: ${testDetail}` : '. Check your network or refresh your credentials, then retry.'}
        </div>
      )}
      {errorMessage && !resumable && testState !== 'ok' && (
        <div
          style={{
            marginTop: 6,
            maxWidth: 720,
            color: 'var(--term-danger-text)',
            font: 'var(--fs-sm) var(--ui-font)',
            lineHeight: 1.45,
            overflowWrap: 'anywhere',
          }}
        >
          {errorMessage}
        </div>
      )}
    </div>
  );
}

interface MessageBlockProps {
  m: ChatMessage;
  workspaceId?: string;
  backendConnectionId?: string;
  index: number;
  isDark: boolean;
  onRetry?: () => void;
  onEdit?: () => void;
  /** Fork a new blank child branch anchored at this message. */
  onBranch?: () => void;
  copyText: () => string;
  showThoughts: boolean;
  density: TerminalDensity;
  usageInfo?: TurnUsageInfo | null;
  isErrorTail?: boolean;
  errorMessage?: string;
  /** Runtime/storage/transport classification, including uncertain turn outcomes. */
  errorKind?: string;
  errorRecovery?: 'checking' | 'unavailable';
  onRunAgain?: () => void;
  /** The latest answer's turn ended early or was stopped: its line under the answer offers Continue. */
  onContinue?: () => void;
  /** Probe backend connectivity ("Test Connection"). Present only when the
   * error is connection/auth class and a cwd/workspace is resolvable. */
  onTestConnection?: () => Promise<{ ok: boolean; detail?: string }>;
  /** Error tail of a failed multi-model plan step: Retry goes through the run (or points to the plan). */
  planStep?: MultiModelBranchControls;
  /** The branch got no history (the node's fresh_context): a plan prompt's caption says Fresh, whatever it asked. */
  freshContext?: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  editing?: boolean;
  onEditSave?: (newText: string) => void;
  onEditCancel?: () => void;
  /**
   * Child branch anchors of this message. Those whose first message quotes
   * a passage of it (quotedText, from Branch on a selection) underline that
   * passage where it renders (BranchQuoteMarks / BranchQuoteUnderline), and
   * hovering it shows the branches. The branches keep their turn markers
   * too: touch screens have no hover, and a selection that crossed messages
   * or picked up UI text cannot be found again. Others are ignored.
   */
  quoteAnchors?: ChildAnchor[];
  /**
   * Turn-marker anchors for child branches forked from this message.
   * Rendered as <BranchAnchorRow> rows below the message body and above
   * the MessageActions (retry/edit/copy/time) row, so the marker sits
   * closer to the message content than the action chrome.
   */
  turnAnchors?: ChildAnchor[];
  /**
   * Workflow runs this reply launched. Their cards sit under the body and
   * above the MessageActions row, inside the message's own spacing, so the
   * next message keeps its distance and the row's arrival at the end of the
   * turn does not push them down.
   */
  workflowRuns?: readonly WorkflowPlacement[];
  onOpenWorkflowRun?: (identity: AgentResourceIdentity, name: string) => void;
  /** Called when user clicks a turn marker title or a quote-underline anchor. */
  onOpenBranch?: (childNodeId: string) => void;
  /** Lowercased context names for highlighting @mentions in user messages. */
  contextNames?: ReadonlySet<string>;
  /** Called when user clicks a mention chip in a user message. */
  onMentionClick?: (name: string, kind: string, nodeId?: string) => void;
  /** Reports whether the visible typewriter is still catching up to raw text. */
  onVisibleSmoothingChange?: (isSmoothing: boolean) => void;
  /** Hide the MessageActions row (copy/retry/edit/branch/time) for the
   *  streaming-tail message. Used by PaneMessageList to suppress completion
   *  UI when the node is still streaming after hydration (m.streaming is
   *  false but the turn has not finished). */
  hideActions?: boolean;
  /** The latest answer, complete: its meta line (copy/retry/branch, time ·
   *  tokens) stays shown instead of waiting for a hover. Earlier answers show
   *  theirs on hover or focus. The Meta agent window keeps every row on hover. */
  pinned?: boolean;
  /** A reply directly before this one, with no user message between them,
   *  reads as the same message: no speaker label of its own (the Meta agent
   *  window's decorations label replies). */
  continuesRun?: boolean;
  /** A reply follows this one in the same run, so the run's actions and
   *  usage show under that last part instead of here. */
  runContinues?: boolean;
  /** The pane's latest reply: on touch its actions show without a tap. */
  actionsAtRest?: boolean;
  /** Hide the in-bubble pending dots because the pane's activity row already
   *  shows a labelled status (e.g. "Restoring original Claude session"). */
  hidePendingIndicator?: boolean;
  /** Frames the message, with this mark above it; the hover actions stay
   *  below the frame. Pass a stable element: it takes part in memoization. */
  highlight?: React.ReactNode;
  /** Play the entrance on mount: the message was just created (PaneMessageList
   *  decides). Read on the first render only, so it is not memoized. */
  fresh?: boolean;
  /** A Scheduled-only transcript (TPane readOnly): receipts under the reply
   *  drop their run controls; approvals can still be answered. */
  readOnly?: boolean;
}

const PLAN_SOURCE_TITLE = 'Sent by the multi-model plan you started';

/** A finished reply with nothing to show: no answer, thought, plan, tool call or block. */
function isEmptyReply(m: ChatMessage): boolean {
  return !m.text.trim() && !m.thought && !m.plan?.length && m.toolCalls.length === 0 && !m.blocks?.length;
}

/** "Results from 3 branches" (the synthesis wake), "Late result from 1 branch" (an addendum). */
function planResultCaption(plan: ThreadMessagePlanSource): string {
  const count = plan.branches ?? 0;
  const branches = `${count} ${count === 1 ? 'branch' : 'branches'}`;
  return plan.step === 'synthesis' ? `Results from ${branches}` : `Late result${count === 1 ? '' : 's'} from ${branches}`;
}

/**
 * " · Plan step 1 · Fork", " · Plan step 3 · Review 2/2": what a branch's
 * relayed prompt is, numbered as the card numbers its steps (the answer is
 * step 1, review round r is step r + 1). A fork branch that got no history
 * (`freshContext`) says Fresh.
 */
function planStepCaption(plan: ThreadMessagePlanSource, freshContext?: boolean): string {
  if (plan.step === 'answer') {
    const context = freshContext ? 'fresh' : plan.context;
    return ` · Plan step 1${context ? ` · ${context === 'fresh' ? 'Fresh' : 'Fork'}` : ''}`;
  }
  const round = plan.round ?? 1;
  return ` · Plan step ${round + 1} · Review${plan.rounds === 2 ? ` ${round}/${plan.rounds}` : ''}`;
}

/**
 * Who sent a relayed message: another thread's agent, a reply, or a
 * multi-model plan step (captioned with the caller's runtime, "From Claude
 * Code · Plan step 1 · Fork"). The sender links to its thread.
 */
function ThreadSourceCaption({ source, freshContext, onMentionClick }: {
  source: ThreadMessageSource;
  freshContext?: boolean;
  onMentionClick?: (name: string, kind: string, nodeId?: string) => void;
}) {
  const plan = source.plan;
  const name = source.fromTitle ?? 'another thread';
  const label = plan?.fromLabel ?? name;
  return (
    <div
      className="terminal-message-thread-source"
      title={plan ? PLAN_SOURCE_TITLE
        : source.kind === 'reply'
          ? "Another thread's answer to a message this thread sent it, written by that thread's agent"
          : 'Written by the agent in another thread and delivered with your approval'}
    >
      {plan && <span className="mm-plan-caption-icon"><ForkIcon /></span>}
      {source.kind === 'reply' && !plan ? 'Reply from' : 'From'}{' '}
      {onMentionClick ? (
        <button
          type="button"
          className="terminal-message-thread-link"
          data-mention={name}
          data-mention-kind="node"
          data-node-id={source.fromNodeId}
        >
          {label}
        </button>
      ) : label}
      {plan && planStepCaption(plan, freshContext)}
    </div>
  );
}

/**
 * "Branches N" under a reply. A branch made just now (its edge is under a
 * second old) grows in: the whole section when it appears with it, otherwise
 * the new row. Branches there on mount (hydration, remounts) render settled.
 */
function BranchAnchorsSection({ anchors, onOpenBranch }: {
  anchors: ChildAnchor[];
  onOpenBranch?: (childNodeId: string) => void;
}) {
  const [grows] = useState(() => anchors.some((a) => isFresh(a.createdAt)));
  // Rows mounting after the section's first commit decide their own entrance.
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
  }, []);
  const section = (
    <section className="t-branch-anchors" aria-label="Branches from this reply">
      <h3 className="t-branch-anchors-heading">Branches <span>{anchors.length}</span></h3>
      <div className="t-branch-anchors-list">
        {anchors.map((a) => (
          <BranchAnchorRow
            key={`anchor-${a.childNodeId}`}
            title={a.title}
            messageCount={a.messageCount ?? 0}
            createdAt={a.createdAt}
            status={a.status}
            onOpen={() => onOpenBranch?.(a.childNodeId)}
            enter={mountedRef.current && isFresh(a.createdAt)}
          />
        ))}
      </div>
    </section>
  );
  if (!grows) return section;
  return (
    <motion.div initial={ANCHOR_GROW_FROM} animate={ANCHOR_GROW_TO} style={ANCHOR_GROW_STYLE}>
      {section}
    </motion.div>
  );
}

/** Which skill a user message ran, and who provides it: Michi for the library, Built-in for Michi's own, else the runtime's label. */
function SkillCaption({ skill, workspaceId }: { skill: NonNullable<ChatMessage['skill']>; workspaceId?: string }) {
  const runtime = useRuntimeLabel(workspaceId, skill.origin === 'runtime' ? skill.runtimeId : undefined);
  const source = skillSourceLabel(skill.origin, runtime ?? '');
  return <div className="terminal-message-skill" title={`Ran the ${skill.name} skill`}>Skill{source ? ` · ${source}` : ''}</div>;
}

/** A highlighted message's frame, its mark first; any other message as it is. */
function MessageHighlight({ mark, children }: { mark: React.ReactNode; children: React.ReactNode }) {
  if (mark == null || mark === false) return <>{children}</>;
  return <div className="terminal-message-highlight">{mark}{children}</div>;
}

// A sent bubble only fades in: the transcript's send glide (sendScroll.ts)
// carries it up from behind the composer with the thread, so it needs no
// travel or growth of its own. The reply placeholder fades in under it.
const USER_ENTRANCE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.32, delay: 0.04, ease: [0.25, 0.8, 0.25, 1] },
} as const;
const ASSISTANT_ENTRANCE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: DUR.brief, ease: 'linear' },
} as const;

function MessageBlockInner({
  m,
  workspaceId,
  backendConnectionId,
  index,
  isDark,
  onRetry,
  onEdit,
  onBranch,
  copyText,
  showThoughts,
  density,
  usageInfo,
  isErrorTail,
  errorMessage,
  errorKind,
  errorRecovery,
  onRunAgain,
  onContinue,
  onTestConnection,
  planStep,
  freshContext,
  subagents,
  runtimeId,
  quoteAnchors,
  turnAnchors,
  workflowRuns,
  onOpenWorkflowRun,
  onOpenBranch,
  contextNames,
  onMentionClick,
  onVisibleSmoothingChange,
  editing,
  onEditSave,
  onEditCancel,
  hideActions,
  pinned,
  continuesRun,
  runContinues,
  actionsAtRest,
  hidePendingIndicator,
  highlight,
  fresh,
  readOnly,
}: MessageBlockProps) {
  // A synthesis or addendum wake shows its caption until opened.
  const [planBodyOpen, setPlanBodyOpen] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [editText, setEditText] = useState(m.text);
  const editAreaRef = useRef<HTMLTextAreaElement>(null);
  const assistantRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  // Esc and Cancel hand the keyboard back to this message's Edit button, in
  // the commit that unmounts the field (ST-10). Save starts a turn, which
  // hides Edit, so TPane gives the composer focus instead.
  const editCancelledRef = useRef(false);
  const cancelEdit = () => {
    editCancelledRef.current = true;
    onEditCancel?.();
  };
  useLayoutEffect(() => {
    if (editing || !editCancelledRef.current) return;
    editCancelledRef.current = false;
    if (editButtonRef.current) editButtonRef.current.focus();
    else focusPaneComposer(rootRef.current);
  }, [editing]);
  const isUser = m.role === 'user';
  const decorations = useMetaChatDecorations();
  const reduceMotion = useReducedMotionConfig() ?? false;
  useHoldHeightWhileLive(assistantRef, !isUser && !!m.streaming, reduceMotion);
  // Line-chrome tool rows read recoveries across the whole turn and its clock.
  const agentTurn = useAgentTurnInfo(m.toolCalls, m.id);
  // Decided once: hydrated, lazily loaded and remounted messages render
  // settled. Every new user bubble fades in where it lands, whether it was
  // typed, drained from the queue, steered or picked from the follow-ups.
  const [entrance] = useState(() => (fresh ? (isUser ? USER_ENTRANCE : ASSISTANT_ENTRANCE) : null));
  // Sections that arrive later under it grow in only then (TR-36).
  const lateEnter = entrance !== null;
  const [motionScope] = useState<MessageMotionScope>(() => ({ mounted: { current: false } }));
  useLayoutEffect(() => {
    motionScope.mounted.current = true;
  }, [motionScope]);

  useEffect(() => {
    if (editing) {
      setEditText(m.text);
      requestAnimationFrame(() => {
        const ta = editAreaRef.current;
        if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
      });
    }
  }, [editing, m.text]);
  const mentionFeatures = onMentionClick ? USER_MENTION_FEATURES : undefined;
  const userMarkdown = (text: string) => userTextToMarkdown(
    highlightMentions(
      text,
      contextNames ?? new Set(),
      m.mentions?.filter(x => x.kind === 'node').map(x => ({ label: x.label, nodeId: x.refId })),
    ),
  );
  const plan = isUser ? m.threadMessage?.plan : undefined;
  // A synthesis or addendum wake reads as one line in the caller, not a bubble.
  const planResult = plan?.step === 'synthesis' || plan?.step === 'addendum' ? plan : undefined;
  // A review prompt opens with its instruction paragraph; the peers' answers follow behind Show all.
  const reviewParagraphs = plan?.step === 'review' ? m.text.trim().split(/\n\s*\n/) : [];
  const reviewHead = reviewParagraphs.length > 1 ? reviewParagraphs[0] : undefined;
  // A turn that failed before it wrote anything: the error tail stands alone,
  // without a "> michi" label over an empty body.
  const emptyFailedReply = !isUser && !!isErrorTail && !m.streaming && isEmptyReply(m) && !subagents?.length;
  const contents = (
    <>
      <BranchQuoteMarks anchors={quoteAnchors} onOpenBranch={onOpenBranch}>
      <MessageHighlight mark={highlight}>
      {/* A pane's answers carry no speaker line: every answer in a thread is
          its agent's, and the meta line under it says the rest. Its space
          under the user message stays (--answer-lead, index.css). The Meta
          agent window still labels its replies. */}
      {!isUser && !continuesRun && !emptyFailedReply && decorations?.assistantLabel != null && (
        <div
          data-find-skip
          style={{
            color: 'var(--term-muted)',
            fontSize: 'var(--msg-label-size)',
            marginBottom: 'var(--msg-label-gap)',
            textAlign: 'left',
          }}
        >
          {decorations.assistantLabelFor?.(m) ?? decorations.assistantLabel}
        </div>
      )}
      {isUser ? (
        editing ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div className="terminal-message-user-editing">
              <textarea
                ref={editAreaRef}
                className="user-edit-area"
                aria-label="Edit message"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeComposing(e)) return;
                  if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    const trimmed = editText.trim();
                    if (trimmed && trimmed !== m.text) onEditSave?.(trimmed);
                    else cancelEdit();
                  }
                }}
                spellCheck={false}
              />
              <div className="user-edit-footer">
                <button className="user-edit-action" onClick={cancelEdit}>
                  Cancel <kbd>Esc</kbd>
                </button>
                <span className="user-edit-hint">Replaces this message and everything after it</span>
                <button
                  className="user-edit-action"
                  onClick={() => {
                    const trimmed = editText.trim();
                    if (trimmed && trimmed !== m.text) onEditSave?.(trimmed);
                    else cancelEdit();
                  }}
                >
                  Resend <kbd>{kbd('mod', 'enter')}</kbd>
                </button>
              </div>
            </div>
          </div>
        ) : m.blockAnswer ? (
          // An answer to a block a reply showed (show_blocks): the block itself
          // shows what was picked, so the message is one line, its text a click away.
          <div className="t-block-answer">
            <div className="t-block-answer__line">
              <span className="t-block-answer__mark" aria-hidden>↳</span>
              <span>{m.blockAnswer.title ? `Answered “${m.blockAnswer.title}”` : 'Answered a block'}</span>
              <button
                type="button"
                className="t-hover-fg t-user-text-toggle"
                aria-expanded={answerOpen}
                onClick={() => setAnswerOpen((open) => !open)}
                style={{ ...USER_TEXT_TOGGLE_STYLE, marginTop: 0 }}
              >
                {answerOpen ? 'Hide' : 'Show'}
              </button>
            </div>
            {answerOpen && (
              <div
                className="terminal-message terminal-message-user"
                data-density={density}
                style={{ fontFamily: 'var(--ui-font)', lineHeight: 'var(--message-body-leading)', letterSpacing: 0, color: 'var(--term-fg)', wordBreak: 'break-word' }}
              >
                <MarkdownContent text={userMarkdown(m.text)} size="sm" className={isDark ? 'prose-invert' : ''} style={proseVars} />
              </div>
            )}
          </div>
        ) : planResult ? (
          <div className="mm-plan-result" title={PLAN_SOURCE_TITLE}>
            <div className="mm-plan-result__line">
              <span className="ic"><ForkIcon /></span>
              {planResultCaption(planResult)}
              <button
                type="button"
                className="t-hover-fg t-user-text-toggle"
                aria-expanded={planBodyOpen}
                onClick={() => setPlanBodyOpen((open) => !open)}
                style={{ ...USER_TEXT_TOGGLE_STYLE, marginTop: 0 }}
              >
                {planBodyOpen ? 'Hide' : 'Show'}
              </button>
            </div>
            <Reveal show={planBodyOpen}>
              <div
                className="terminal-message terminal-message-user mm-plan-result__body"
                data-density={density}
                style={{ fontFamily: 'var(--ui-font)', lineHeight: 'var(--message-body-leading)', letterSpacing: 0, color: 'var(--term-fg)', wordBreak: 'break-word' }}
              >
                <MarkdownContent text={userMarkdown(m.text)} size="sm" className={isDark ? 'prose-invert' : ''} style={proseVars} />
              </div>
            </Reveal>
          </div>
        ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div
            className="terminal-message terminal-message-user"
            data-density={density}
            onClick={onMentionClick ? (e) => {
              const chip = (e.target as HTMLElement).closest('[data-mention]');
              if (chip) {
                const el = chip as HTMLElement;
                const name = el.dataset.mention!;
                const kind = el.dataset.mentionKind ?? 'context';
                const nodeId = el.dataset.nodeId;
                onMentionClick(name, kind, nodeId);
              }
            } : undefined}
            style={{
              fontFamily: 'var(--ui-font)',
              lineHeight: 'var(--message-body-leading)',
              letterSpacing: 0,
              color: 'var(--term-fg)',
              wordBreak: 'break-word',
            }}
          >
            {(m.threadMessage || m.companionSend) && <ThreadMessageSourceLine message={m} freshContext={freshContext} onMentionClick={onMentionClick} />}
            {m.steered && <div className="terminal-message-steered" title="Sent to the active turn">Steered</div>}
            {m.skill && <SkillCaption skill={m.skill} workspaceId={workspaceId} />}
            {m.comments && m.comments.length > 0 && <CommentChips comments={m.comments} />}
            {m.quotedText && <QuoteChip text={m.quotedText} source={m.quoteSource} />}
            {m.attachments && m.attachments.length > 0 && (
              <AttachmentPills items={m.attachments} workspaceId={workspaceId} />
            )}
            {m.streaming ? (
              <MarkdownContent
                text={userMarkdown(m.text)}
                size="sm"
                className={isDark ? 'prose-invert' : ''}
                style={proseVars}
                features={mentionFeatures}
              />
            ) : reviewHead !== undefined ? (
              <ReviewPromptText
                text={m.text}
                head={reviewHead}
                renderText={(text) => (
                  <MarkdownContent
                    text={userMarkdown(text)}
                    size="sm"
                    className={isDark ? 'prose-invert' : ''}
                    style={proseVars}
                    features={mentionFeatures}
                  />
                )}
              />
            ) : (
              <CollapsibleUserText contentKey={m.text}>
                <MarkdownContent
                  text={userMarkdown(m.text)}
                  size="sm"
                  className={isDark ? 'prose-invert' : ''}
                  style={proseVars}
                  features={mentionFeatures}
                />
              </CollapsibleUserText>
            )}
          </div>
        </div>
        )
      ) : emptyFailedReply ? null : (
        <div
          ref={assistantRef}
          className="terminal-message terminal-message-assistant"
          data-density={density}
          style={{
            // The pane's density scale (index.css); the user bubble's padding is CSS too.
            paddingTop: 'var(--msg-assistant-pad)',
            paddingBottom: 'var(--msg-assistant-pad)',
            // AI is flush left; user bubble floats independently on the right.
            paddingLeft: 0,
            paddingRight: 0,
            // Explicit 'none' so jsdom serializes borderLeft to '' (asserted by MessageBlock.test.tsx).
            borderLeft: 'none',
            borderRadius: 'var(--term-message-radius, 0px)',
            background: 'transparent',
            color: 'var(--term-fg)',
            fontFamily: 'var(--ui-font)',
          }}
        >
          <AgentTurnContext.Provider value={agentTurn}>
          {/* Only a streaming reply's tables wait to settle (MarkdownFeatureTable). */}
          <MarkdownTableLiveContext.Provider value={!!m.streaming}>
          {showThoughts && m.plan && m.plan.length > 0 && (
            <TermPlanBlock entries={m.plan} />
          )}
          {!hasAssistantBlocks(m) && showThoughts && m.thought && (
            <TermThoughtBlock text={m.thought} streaming={m.streaming} runtimeId={runtimeId} />
          )}
          {m.streaming && !hasAssistantBlocks(m) && (
            <PendingIndicatorSlot show={!hidePendingIndicator && !m.text && !m.thought && m.toolCalls.length === 0} />
          )}
          {hasAssistantBlocks(m) ? (
            <BlockAssistantBody
              m={m}
              isDark={isDark}
              showThoughts={showThoughts}
              subagents={subagents}
              runtimeId={runtimeId}
              onSmoothingChange={onVisibleSmoothingChange}
              hidePendingIndicator={hidePendingIndicator}
              turnActive={!!m.streaming || !!hideActions}
              turnDurationMs={usageInfo?.durationMs}
            />
          ) : (
            <LegacyAssistantBody
              m={m}
              isDark={isDark}
              subagents={subagents}
              runtimeId={runtimeId}
              onSmoothingChange={onVisibleSmoothingChange}
            />
          )}
          </MarkdownTableLiveContext.Provider>
          </AgentTurnContext.Provider>
        </div>
      )}
      {!isUser && <SteeringReports reports={m.steeringReports} />}
      {!isUser && <TurnReceipts tools={m.toolCalls} workspaceId={workspaceId} backendConnectionId={backendConnectionId} enter={lateEnter} />}
      {!isUser && <MultiModelReceipt tools={m.toolCalls} backendConnectionId={backendConnectionId} readOnly={readOnly} />}
      {/* What the reply was based on: it reads its own store (only where PaneMessageList offers it), so this block's props stay as they are. */}
      {!isUser && !(m.streaming || hideActions) && <ReplyMemorySources messageId={m.id} settled enter={lateEnter} />}
      {!isUser && workflowRuns && workflowRuns.length > 0 && (
        <MessageWorkflowRuns runs={workflowRuns} onOpen={onOpenWorkflowRun} enter={lateEnter} />
      )}
      {!isUser && m.turnEnd && !(m.streaming || hideActions || isErrorTail) && (
        <TurnEndNote mark={m.turnEnd} onContinue={onContinue} />
      )}
      {!isUser && !m.streaming && isErrorTail && (
        <ErrorTail
          errorMessage={errorMessage}
          errorKind={errorKind}
          errorRecovery={errorRecovery}
          onRetry={onRetry}
          onRunAgain={onRunAgain}
          onTestConnection={onTestConnection}
          planStep={planStep}
        />
      )}
      {turnAnchors && turnAnchors.length > 0 && (
        <BranchAnchorsSection anchors={turnAnchors} onOpenBranch={onOpenBranch} />
      )}
      </MessageHighlight>
      </BranchQuoteMarks>
      {!(m.streaming || hideActions || runContinues) && (
        isUser ? (
          // In a pane transcript the row floats under the bubble, over the
          // next line, instead of holding space (.t-user-msg-actions in
          // index.css). It takes pointers only while its buttons show, so its
          // box never swallows a click or tap meant for that line.
          <div className="t-user-msg-actions" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <MessageActions
              time={formatMessageTime(m.createdAt)}
              copyText={copyText}
              onRetry={onRetry}
              onEdit={onEdit}
              editRef={editButtonRef}
              onBranch={onBranch}
              usageInfo={usageInfo}
            />
          </div>
        ) : (
          // The answer's meta line. Edit belongs to the user's message.
          <MessageActions
            answer
            pinned={!!pinned && !decorations}
            restVisible={actionsAtRest}
            time={formatMessageTime(m.createdAt)}
            copyText={copyText}
            onRetry={isErrorTail && turnErrorAction(errorKind) === 'inspect-existing-turn' ? undefined : onRetry}
            onBranch={onBranch}
            usageInfo={usageInfo}
          />
        )
      )}
      {decorations?.afterMessage ? decorations.afterMessage(m) : <CarriedTaintNote message={m} enter={lateEnter} />}
    </>
  );
  // A user message is the containing block of its floating action row.
  const rootStyle: React.CSSProperties = isUser
    ? { marginBottom: 'var(--msg-gap)', position: 'relative' }
    : { marginBottom: 'var(--msg-gap)' };
  // `entrance` never changes, so neither does the root's element type: a
  // settled message keeps a plain div. The null PresenceContext lets the
  // message decide its own entrances: inside an AnimatePresence child that
  // was there on first render, motion would otherwise skip the entrance of
  // everything mounting later (this bubble, arriving thought blocks).
  // One message's own link policy (a posted check-in's allow-list, DESIGN-v2 §2.8).
  const messageLinks = !isUser ? decorations?.linkRendererFor?.(m) : undefined;
  const body = messageLinks
    ? <MarkdownLinkRendererContext.Provider value={messageLinks}>{contents}</MarkdownLinkRendererContext.Provider>
    : contents;
  return (
    <PresenceContext.Provider value={null}>
    <MessageMotionContext.Provider value={motionScope}>
      {entrance ? (
        <motion.div ref={rootRef} {...entrance} style={rootStyle}>
          {body}
        </motion.div>
      ) : (
        <div ref={rootRef} style={rootStyle}>
          {body}
        </div>
      )}
    </MessageMotionContext.Provider>
    </PresenceContext.Provider>
  );
}

function usageEqual(
  a: MessageBlockProps['usageInfo'],
  b: MessageBlockProps['usageInfo'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return a.durationMs === b.durationMs
    && a.credits === b.credits
    && a.unverifiable === b.unverifiable
    && a.totalTokens === b.totalTokens
    && a.inputTokens === b.inputTokens
    && a.cachedInputTokens === b.cachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.reasoningOutputTokens === b.reasoningOutputTokens
    && a.contextUsagePercentage === b.contextUsagePercentage;
}

/** The list regroups each chunk; its placements keep their identity. */
function sameItems<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a?.length && !b?.length;
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function childAnchorsEqual(
  a: MessageBlockProps['turnAnchors'],
  b: MessageBlockProps['turnAnchors'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.childNodeId !== right.childNodeId ||
      left.title !== right.title ||
      (left.messageCount ?? 0) !== (right.messageCount ?? 0) ||
      left.createdAt !== right.createdAt ||
      left.status !== right.status ||
      left.quotedText !== right.quotedText ||
      left.question !== right.question ||
      left.reply !== right.reply
    ) {
      return false;
    }
  }
  return true;
}

const MessageBlock = React.memo(MessageBlockInner, (prev, next) =>
  prev.m === next.m &&
  prev.workspaceId === next.workspaceId &&
  prev.backendConnectionId === next.backendConnectionId &&
  prev.index === next.index &&
  prev.isDark === next.isDark &&
  prev.showThoughts === next.showThoughts &&
  prev.density === next.density &&
  !!prev.onRetry === !!next.onRetry &&
  !!prev.onEdit === !!next.onEdit &&
  prev.editing === next.editing &&
  usageEqual(prev.usageInfo, next.usageInfo) &&
  !!prev.isErrorTail === !!next.isErrorTail &&
  prev.errorMessage === next.errorMessage &&
  prev.errorKind === next.errorKind &&
  prev.errorRecovery === next.errorRecovery &&
  prev.onRunAgain === next.onRunAgain &&
  !!prev.onContinue === !!next.onContinue &&
  prev.onTestConnection === next.onTestConnection &&
  prev.planStep === next.planStep &&
  !!prev.freshContext === !!next.freshContext &&
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId &&
  childAnchorsEqual(prev.quoteAnchors, next.quoteAnchors) &&
  childAnchorsEqual(prev.turnAnchors, next.turnAnchors) &&
  sameItems(prev.workflowRuns, next.workflowRuns) &&
  prev.onOpenWorkflowRun === next.onOpenWorkflowRun &&
  prev.onOpenBranch === next.onOpenBranch &&
  prev.contextNames === next.contextNames &&
  prev.onMentionClick === next.onMentionClick &&
  prev.onVisibleSmoothingChange === next.onVisibleSmoothingChange &&
  !!prev.hidePendingIndicator === !!next.hidePendingIndicator &&
  !!prev.hideActions === !!next.hideActions &&
  !!prev.pinned === !!next.pinned &&
  !!prev.continuesRun === !!next.continuesRun &&
  !!prev.runContinues === !!next.runContinues &&
  !!prev.readOnly === !!next.readOnly &&
  // A new reply moves "latest" off the previous one, whose `m` is unchanged.
  !!prev.actionsAtRest === !!next.actionsAtRest &&
  prev.highlight === next.highlight,
  // `fresh` is left out on purpose: it is read on mount only and turns false
  // a second later, which must not re-render every recent message.
);

export { MessageBlock };
export type { MessageBlockProps };
