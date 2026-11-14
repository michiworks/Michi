import { ASSISTANT_THREAD_MESSAGE_TITLE, closesFence, formatTokenCount, isCheckinNodeId, openingFence, type DurableUserInput, type MarkdownFence, type ThreadMessagePlanSource, type ThreadMessageSource, type UsageCharge } from 'michi-shared';
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, PresenceContext, animate, motion, useIsPresent, useReducedMotionConfig } from 'motion/react';
import { DUR, EASE, SPRING } from '../../motion/tokens';
import { AssistantBlock, ChatMessage, ToolCallState, SubagentInfo, UserInputRequest } from '../../state/chatTypes';
import { turnErrorAction } from '../../state/turnErrorRecovery';
import { interruptionCauseOfKind } from '../../state/turnInterruption';
import { useRuntimeLabel } from '../../state/skillCatalog';
import { skillSourceLabel } from '../../state/slashEntries';
import { isSubagentActive } from '../../state/backgroundWork';
import { isRunningStatus, isHiddenInternalTool, formatDurationMs, toolSpanMs, summarizeWork, failedToolCount } from './toolCallGrouping';
import { AgentTurnContext, LineRun, LineWorkFold, useAgentTurnInfo, type LineRunItem } from './AgentLineBlocks';
import { splitFinishedTurn } from './workFold';
import { ownGroupTools, visibleGroupTools } from './subagents/subagentPresentation';
import { activityWindow, activityWindowMs } from './agentBlockTiming';
import { ToolCallGroup } from './ToolCallGroup';
import { useHoldHeightWhileLive } from './useHoldHeightWhileLive';
import { TurnReceipts } from './TurnReceipts';
import { MultiModelReceipt } from './multiModel/MultiModelReceipt';
import { MessageWorkflowRuns } from './workflows/MessageWorkflowRuns';
import type { WorkflowPlacement } from '../../state/workflowDomain';
import type { AgentResourceIdentity } from '../../state/agentIdentity';
import { type TerminalDensity, useAgentBlockStyle } from '../../state/prefs';
import { CardSpinner, SparkleIcon, LiveTimerLabel } from './AgentBlockVariants';
import { GlyphSwap, LabelSwap, Reveal } from './agentBlockMotion';
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
  thinkingRunRawText,
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
import { SteeringReports } from './SteeringReports';
import { streamingMarkdownBlocksEnabled } from './streamingMarkdownBlocksFlag';
import UserInputBanner, { ResolvedUserInput } from './UserInputBanner';
import { useChatActions } from '../../state/chatStore';
import { useIsCompanionNodeId } from '../../state/companion/companionStore';
import { openCompanionPanel } from '../../state/companion/companionPanel';
import { useCompanionName } from '../../state/companion/companionName';
import { BranchIcon, CheckIcon, CopyIcon, EditIcon, ForkIcon, RetryIcon } from './icons';
import { useMetaChatDecorations } from '../../state/metaChat/metaChatDecorations';
import { formatMessageTime } from '../../lib/messageTime';
import { useCopyFeedback } from '../../hooks/useCopyFeedback';
import { isImeComposing } from '../../lib/ime';
import { kbd } from '../../lib/platform';
import { lastInputWasTouch } from '../../lib/inputModality';
import type { MultiModelBranchControls } from './multiModelBranch';
import { ReplyMemorySources } from './ReplyMemorySources';
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
 * What a tap inside a message acts on by itself. On a touch screen the tap's
 * hover must not reveal the message's actions when it lands on one: WebKit
 * drops a tap whose mouseover makes something visible, so the control would
 * only take the second tap. index.css's run-part hover rule repeats this list.
 */
const TAP_CONTROL = 'a[href], button, input, select, textarea, summary, [role="button"], [data-mention], [data-tap-target]';

/**
 * A message's action row. Under a user message: copy, retry, edit, branch
 * and the time, on hover. Under an answer it is the answer's meta line
 * (`answer`): copy, retry and branch, then "time · tokens" at the chrome's
 * 12px, all of it shown together. Shown while `visible`, and while focus is
 * in the answer or on the row's own buttons (index.css), so a keyboard
 * reaches them visibly.
 */
function MessageActions({
  visible,
  restVisible = false,
  answer = false,
  time,
  copyText,
  onRetry,
  onEdit,
  onBranch,
  usageInfo,
}: {
  visible: boolean;
  /** Touch screens show this row without a tap (index.css). */
  restVisible?: boolean;
  answer?: boolean;
  time: string;
  /** The words Copy puts on the clipboard, read at the press. */
  copyText: () => string;
  onRetry?: () => void;
  onEdit?: () => void;
  onBranch?: () => void;
  usageInfo?: TurnUsageInfo | null;
}) {
  const { result: copyResult, status: copyStatus, copy } = useCopyFeedback();
  const btnStyle: React.CSSProperties = {
    color: 'var(--term-muted)',
  };
  const iconSize = answer ? 14 : 13;
  const usageText = answer && usageInfo ? usageMetaText(usageInfo) : null;
  const usageDetails = answer && usageInfo ? usageTitle(usageInfo) : '';
  return (
    <div
      data-msg-actions={restVisible ? 'rest' : undefined}
      data-find-skip
      className={answer ? 't-answer-meta' : undefined}
      style={answer ? undefined : { display: 'flex', alignItems: 'center', marginTop: 4, paddingLeft: 0 }}
    >
      <div
        className="t-msg-actions"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          minWidth: 0,
          opacity: visible ? 1 : 0,
          transition: 'opacity var(--t-soft) ease-out',
          pointerEvents: visible ? 'auto' : 'none',
        }}
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void copy(copyText()); }}
          className="t-icon-btn"
          style={btnStyle}
          title="copy message"
          aria-label="copy message"
        >
          {copyResult === 'copied' ? <CheckIcon size={iconSize} /> : <CopyIcon size={iconSize} />}
        </button>
        {/* Only while there is a result: a transcript would otherwise hold a live region per message. */}
        {copyStatus && <span className="sr-only" role="status">{copyStatus}</span>}
        {onRetry && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="t-icon-btn"
            style={btnStyle}
            title="retry this turn"
            aria-label="retry this turn"
          >
            <RetryIcon size={iconSize} />
          </button>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="t-icon-btn"
            style={btnStyle}
            title="edit and resend"
            aria-label="edit and resend"
          >
            <EditIcon size={iconSize} />
          </button>
        )}
        {onBranch && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onBranch(); }}
            className="t-icon-btn"
            style={btnStyle}
            title="branch from here"
            aria-label="branch from here"
          >
            <BranchIcon size={iconSize} />
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
            {e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '›' : '·'}
          </span>
          <span style={{ textDecoration: e.status === 'completed' ? 'line-through' : 'none' }}>{e.content}</span>
        </div>
      ))}
    </div>
  );
}

// Tail-mode height cap: ~10 lines at line-height 1.5, font-size 11px.
const THOUGHT_TAIL_MAX_HEIGHT = 10 * 11 * 1.5;

type ThoughtMode = 'tail' | 'expanded' | 'collapsed';

/* ── Motion (motion.dev) ──
   Only what arrives while a message is on screen animates: everything a
   MessageBlock renders on its first commit (hydration, lazy loads, remounts)
   is settled. Streamed Markdown never animates and loops stay in CSS. */

interface MessageMotionScope {
  /** True once the message has committed; blocks mounting later are new. */
  mounted: { current: boolean };
  /** The pending dots' height while they show, so the block replacing them
   *  grows from there. Cleared once they hide. */
  pendingHeight: { current: number | null };
}

const MessageMotionContext = createContext<MessageMotionScope | null>(null);

/** Where a block grows from (px) when it arrives live, or null to render it
 *  settled. Decided on the block's first render. */
function useBlockEntrance(live: boolean | undefined): number | null {
  const scope = useContext(MessageMotionContext);
  const [from] = useState(() => (live && scope?.mounted.current ? scope.pendingHeight.current ?? 0 : null));
  return from;
}

/** Disclosure chevron: one ▸ that turns to point down while open. */
function Chevron({ open, style }: { open: boolean; style?: React.CSSProperties }) {
  return (
    <motion.span
      aria-hidden
      initial={false}
      animate={{ rotate: open ? 90 : 0 }}
      transition={SPRING.snappy}
      style={{ display: 'inline-block', fontSize: 'var(--fs-2xs)', color: 'var(--term-faint)', flexShrink: 0, ...style }}
    >
      ▸
    </motion.span>
  );
}

/** A thought body closing because its block finished, not because the user collapsed it. */
const THOUGHT_FINISH = { duration: 0.22, ease: EASE.drawer } as const;

const BLOCK_GROW = { duration: 0.2, ease: EASE.out } as const;
const BLOCK_FADE = { duration: 0.12, ease: 'linear' } as const;

/**
 * Grows `ref` from `from` px to its natural height (200ms ease-out), then
 * releases it. The natural height is measured every frame, so content
 * streaming in meanwhile is neither clipped nor snapped to, and a block that
 * finishes (shrinks) mid-grow is followed down. Hand-written, so it skips
 * itself under reduced motion; the fade stays on the motion root.
 */
function useGrowFrom(ref: React.RefObject<HTMLElement | null>, from: number | null, ready: boolean) {
  const reduce = useReducedMotionConfig();
  useLayoutEffect(() => {
    const el = ref.current;
    if (from === null || !ready || reduce || !el) return;
    let done = false;
    const release = () => {
      done = true;
      el.style.height = '';
      el.style.overflow = '';
    };
    el.style.overflow = 'hidden';
    el.style.height = `${from}px`;
    const controls = animate(0, 1, {
      ...BLOCK_GROW,
      onUpdate: (progress) => {
        // A skipped animation can report its last frame after completing.
        if (done) return;
        if (progress >= 1) return release();
        el.style.height = '';
        const to = el.offsetHeight;
        el.style.height = `${from + (to - from) * progress}px`;
      },
      onComplete: release,
    });
    return () => {
      controls.stop();
      release();
    };
  }, [ref, from, ready, reduce]);
}

interface ThoughtHeaderBase {
  streaming: boolean;
  phase?: StreamPhase;
  /** The body is expanded: the chevron points down. */
  open: boolean;
  /** Stable across streamed chunks, so the memoized header skips them. */
  onToggle: () => void;
}

// Headers re-render on state changes only (live ↔ done, phase, open), never
// per streamed thought chunk. Done-state text is passed only once finished.

const CardThoughtHeader = React.memo(function CardThoughtHeader({
  streaming, phase, open, onToggle, startedAt, clockKey, workText, workFailed, durText, base, suffix,
}: ThoughtHeaderBase & {
  startedAt?: number;
  clockKey?: string;
  /** Finished with tools: what it did, failures, duration at the right. */
  workText?: string;
  workFailed?: number;
  durText?: string;
  /** Finished otherwise: "Thought for 4s" and its "· 3 steps" suffix. */
  base?: string;
  suffix?: string;
}) {
  // Finishing swaps the header in place: spinner → sparkle by scale, the live
  // label up and out as the summary rises in.
  return (
    <div
      onClick={onToggle}
      className="t-hover-fg"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 11px',
        cursor: 'pointer',
        userSelect: 'none',
        color: 'var(--term-muted)',
      }}
    >
      <GlyphSwap glyph={streaming ? 'spinner' : 'sparkle'} justify="center">
        {streaming ? <CardSpinner /> : <SparkleIcon size={13} color="var(--term-muted)" />}
      </GlyphSwap>
      <LabelSwap as="div" k={streaming ? 'live' : 'done'} style={{ flex: 1 }}>
        {streaming ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="term-shimmer" style={{ fontSize: 'var(--fs-md)', fontWeight: 500 }}>
              {phase === 'working' ? 'Working…' : 'Thinking…'}
            </span>
            <LiveTimerLabel active={streaming} startedAt={startedAt} clockKey={clockKey} />
          </span>
        ) : workText ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span
              title={workText}
              style={{ fontSize: 'var(--fs-md)', fontWeight: 500, color: 'var(--term-mid)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {workText}
            </span>
            {!!workFailed && (
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-danger-text)', flexShrink: 0 }}>
                · {workFailed} failed
              </span>
            )}
            <span style={{ marginLeft: 'auto', paddingLeft: 4, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {durText}
            </span>
            <Chevron open={open} />
          </span>
        ) : (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 'var(--fs-md)', fontWeight: 500, color: 'var(--term-mid)' }}>{base}</span>
            {suffix && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{suffix}</span>}
            <Chevron open={open} style={{ marginLeft: 'auto' }} />
          </span>
        )}
      </LabelSwap>
    </div>
  );
});

const TerminalThoughtHeader = React.memo(function TerminalThoughtHeader({
  streaming, phase, open, onToggle, hasTools, rightMeta,
}: ThoughtHeaderBase & { hasTools?: boolean; rightMeta?: string }) {
  return (
    <LabelSwap as="div" k={streaming ? 'live' : 'done'}>
      {streaming ? (
        <div
          onClick={onToggle}
          style={{ display: 'flex', alignItems: 'baseline', gap: 7, cursor: 'pointer', userSelect: 'none', color: 'var(--term-muted)' }}
        >
          <span aria-hidden style={{ fontFamily: 'var(--font-mono)', color: 'var(--term-accent)', fontSize: 'var(--fs-sm)', flexShrink: 0 }}>❯</span>
          <span className="term-shimmer">{phase === 'working' ? 'working' : 'thinking'}</span>
          <span aria-hidden className="agent-caret" />
        </div>
      ) : (
        <div
          onClick={onToggle}
          className="t-hover-fg"
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none', color: 'var(--term-muted)' }}
        >
          <Chevron open={open} />
          <span style={{ fontSize: 'var(--fs-2xs)', letterSpacing: 'var(--ls-caps-wide)', textTransform: 'uppercase', color: 'var(--term-muted)', fontWeight: 500, flexShrink: 0 }}>
            {hasTools ? 'working' : 'thinking'}
          </span>
          <span aria-hidden style={{ flex: 1, borderTop: '1px dotted var(--term-line)', transform: 'translateY(1px)' }} />
          {rightMeta && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', flexShrink: 0 }}>{rightMeta}</span>
          )}
        </div>
      )}
    </LabelSwap>
  );
});

const PlainThoughtHeader = React.memo(function PlainThoughtHeader({
  streaming, phase, open, onToggle, doneLabel,
}: ThoughtHeaderBase & { doneLabel?: string }) {
  // The live dot shows while streaming unless the body is open; otherwise the
  // chevron, which turns rather than swapping glyphs.
  const liveDot = streaming && !open;
  return (
    <div
      onClick={onToggle}
      style={{
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'baseline',
        gap: 7,
        fontSize: 'var(--fs-sm)',
        color: 'var(--term-muted)',
        fontFamily: 'var(--ui-font)',
        userSelect: 'none',
      }}
      className="t-hover-fg"
    >
      <GlyphSwap glyph={liveDot ? 'dot' : 'chevron'} style={{ width: 8, alignSelf: liveDot ? 'center' : undefined }}>
        {liveDot ? (
          <span aria-hidden style={{ display: 'inline-flex' }}>
            <span className="term-dot-i term-dot-i--run" />
          </span>
        ) : (
          <Chevron open={open} />
        )}
      </GlyphSwap>
      <LabelSwap k={streaming ? 'live' : 'done'}>
        {streaming
          ? <span className="term-shimmer">{phase === 'working' ? 'working' : 'thinking'}</span>
          : <span>{doneLabel}</span>}
      </LabelSwap>
    </div>
  );
});

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
              {done ? '✓' : '●'}
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
  children,
  toolCount,
  runtimeId,
  durationMs,
  startedAt,
  endedAt,
  clockKey,
  segments,
  subagents,
  tools,
  initialMode,
}: {
  text: string;
  streaming?: boolean;
  phase?: StreamPhase;
  children?: React.ReactNode;
  toolCount?: number;
  runtimeId?: string | null;
  /** Fallback duration (e.g. tool-span of the run) for hydrated turns. */
  durationMs?: number;
  /** Durable activity window (backend clock, see agentBlockTiming). The live
   *  timer counts from `startedAt`, so remounts, reloads and other windows
   *  agree; with `endedAt` too it also gives the finished duration. */
  startedAt?: number;
  endedAt?: number;
  /** Backend clock key (the assistant message id) for the live timer. */
  clockKey?: string;
  /** When provided, the body renders these interleaved chunks instead of
   *  `text` + `children` (which are then only used for the header label). */
  segments?: readonly ThoughtSegment[];
  /** Roster for tool groups rendered from `segments`. */
  subagents?: readonly SubagentInfo[];
  /** Tools this block ran, for the card header's work summary. Defaults to
   *  the tools inside `segments`. */
  tools?: readonly ToolCallState[];
  /** Initial user-mode override — used by the dev specimen to show an
   *  expanded body statically. Live rendering leaves this unset. */
  initialMode?: ThoughtMode;
}) {
  // Default mode: tail while streaming, collapsed once finished.
  // User clicks cycle: tail/collapsed → expanded → (streaming ? tail : collapsed).
  const [userMode, setUserMode] = useState<ThoughtMode | null>(initialMode ?? null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const expandedRef = useRef<HTMLDivElement | null>(null);
  const expandedStickyRef = useRef(true);
  const [expandedScrollable, setExpandedScrollable] = useState(false);
  const liveElapsed = useThinkingTimer(streaming);
  const variant = useAgentBlockStyle();
  const workLine = useMetaChatDecorations()?.workLine;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hasContent = !!(text || children || segments?.length);
  // A block that starts streaming while its message is on screen grows in
  // (from the pending dots it replaces); one already there renders settled.
  const enterFrom = useBlockEntrance(streaming);
  useGrowFrom(rootRef, enterFrom, hasContent);

  // Once streaming flips false, drop any sticky 'tail' override so the block
  // auto-collapses to 0 rows. 'expanded' is preserved (user is reading).
  useEffect(() => {
    if (!streaming && userMode === 'tail') setUserMode(null);
  }, [streaming, userMode]);

  const mode: ThoughtMode = userMode ?? (streaming ? 'tail' : 'collapsed');
  const showBody = mode === 'tail' || mode === 'expanded';
  // The mode the body last showed in. A hiding tail is the block finishing;
  // a hiding expanded body is the user collapsing it.
  const shownModeRef = useRef<ThoughtMode>(mode);
  useLayoutEffect(() => {
    if (showBody) shownModeRef.current = mode;
  });
  const finishing = shownModeRef.current === 'tail';

  // Stable while chunks stream (mode and streaming change rarely), so the
  // memoized headers skip them.
  const handleToggle = useCallback(() => {
    if (mode === 'expanded') {
      // Expanded → tail (still streaming) or collapsed (done).
      setUserMode(streaming ? 'tail' : 'collapsed');
    } else {
      // Tail or collapsed → expanded.
      expandedStickyRef.current = true;
      setUserMode('expanded');
    }
  }, [mode, streaming]);

  useLayoutEffect(() => {
    const el = expandedRef.current;
    if (mode !== 'expanded' || !el) return;
    const measure = () => setExpandedScrollable(el.scrollHeight > el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [mode, text, segments, children, variant]);

  // Pin tail-mode scroll to the bottom as new tokens arrive. `segments`
  // changes identity when cluster content grows (new tool rows), and the
  // plain variant passes its tool groups as `children`.
  useEffect(() => {
    if (mode === 'tail' && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
    if (mode === 'expanded' && streaming && expandedStickyRef.current && expandedRef.current) {
      expandedRef.current.scrollTop = expandedRef.current.scrollHeight;
    }
  }, [text, mode, streaming, segments, children]);

  // Tool rows and their headers grow in over several frames after the render
  // that added them, so a pin taken then lands short and the live row stays
  // below the tail. Re-pin whenever the content itself resizes.
  useEffect(() => {
    const content = contentRef.current;
    const viewport = mode === 'tail' ? tailRef.current : mode === 'expanded' && streaming ? expandedRef.current : null;
    if (!content || !viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (mode === 'expanded' && !expandedStickyRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [mode, streaming, hasContent]);

  if (!hasContent) return null;

  // Pure reasoning → "thought for 12s". Any tool activity → "worked for".
  // Duration is the durable activity window when the blocks carry it;
  // otherwise (legacy turns) the mount-scoped live timer when this block
  // streamed here, or the tool-span for hydrated turns.
  const hasTools = (toolCount ?? 0) > 0;
  const dur = activityWindowMs(startedAt, endedAt) ?? liveElapsed ?? durationMs;
  const codexStepCount = runtimeId === 'codex'
    ? text.split('\n').filter((s) => s.trim().length > 0).length
    : 0;
  const base = dur != null
    ? `${hasTools ? 'worked' : 'thought'} for ${formatDurationMs(dur)}`
    : (hasTools ? 'worked' : 'thoughts');
  const suffix = hasTools
    ? ` · ${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}`
    : codexStepCount > 0
      ? ` · ${codexStepCount} ${codexStepCount === 1 ? 'step' : 'steps'}`
      : '';
  const doneLabel = `${base}${suffix}`;

  const thoughtProse = (chunk: string, chunkStreaming: boolean | undefined, key?: string) =>
    runtimeId === 'codex' ? (
      <CodexStepList key={key} text={chunk} streaming={chunkStreaming} />
    ) : (
      <MarkdownContent
        key={key}
        text={chunk}
        size="xs"
        style={thoughtProseVars}
        className="[&_a]:underline"
      />
    );

  // ── line chrome (W2): one disclosure line, the same box live and settled.
  if (variant === 'line') {
    const items: LineRunItem[] = segments
      ? segments.flatMap((seg): LineRunItem[] => (seg.kind === 'text'
        ? [{ kind: 'text', key: seg.key, text: seg.text }]
        : visibleGroupTools(seg.tools, subagents).map((tool) => ({ kind: 'tool', key: tool.id, tool }))))
      : text ? [{ kind: 'text', key: 'thought', text }] : [];
    // Only hidden plumbing tools and no thought: nothing to say once settled.
    if (!streaming && items.length === 0 && !(children && !segments)) return null;
    return (
      <LineRun
        items={items}
        live={!!streaming}
        phase={phase}
        startedAt={startedAt}
        durationMs={dur}
        subagents={subagents}
        renderProse={thoughtProse}
        extraBody={segments ? undefined : children}
        initialOpen={initialMode === 'expanded'}
        enter={enterFrom !== null}
        kind="thought"
      />
    );
  }

  const lastTextSegKey = segments
    ? [...segments].reverse().find((s) => s.kind === 'text')?.key
    : undefined;
  // The newest tool group stays open while the block is live: folding it the
  // moment its tools finish shrank the card before the answer had arrived.
  // It folds with the rest of the body when the block finishes.
  const lastToolSegKey = segments
    ? [...segments].reverse().find((s) => s.kind === 'tools')?.key
    : undefined;

  const bodyContent = segments ? (
    segments.map((seg) =>
      seg.kind === 'text' ? (
        thoughtProse(seg.text, streaming && seg.key === lastTextSegKey, seg.key)
      ) : (
        <ToolCallGroup
          key={seg.key}
          tools={seg.tools}
          defaultExpanded={seg.tools.some((t) => isRunningStatus(t.status))}
          holdOpen={!!streaming && seg.key === lastToolSegKey}
          subagents={subagents}
          receipts={false}
        />
      ),
    )
  ) : (
    <>
      {text ? thoughtProse(text, streaming) : null}
      {children}
    </>
  );

  const body = (ref: React.Ref<HTMLDivElement>, tail: boolean, chrome?: React.CSSProperties) => (
    <div
      ref={ref}
      tabIndex={!tail && expandedScrollable ? 0 : undefined}
      role={!tail && expandedScrollable ? 'region' : undefined}
      aria-label={!tail && expandedScrollable ? 'Activity details' : undefined}
      onScroll={tail ? undefined : (event) => {
        const el = event.currentTarget;
        // Nested tool lists also scroll; only this activity viewport controls
        // whether newly streamed content follows the bottom.
        if (event.target !== el) return;
        expandedStickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      style={{
        ...(chrome ?? {
          paddingLeft: 10,
          marginLeft: 2,
          borderLeft: '1px solid var(--term-line)',
          color: 'var(--term-muted)',
          lineHeight: 1.55,
          marginTop: 4,
        }),
        ...(tail ? { maxHeight: THOUGHT_TAIL_MAX_HEIGHT, overflow: 'hidden' } : null),
        ...(!tail ? { maxHeight: 'min(60vh, 480px)', overflowY: 'auto' } : null),
      }}
    >
      {/* Measured by the tail pin: its height tracks the content, uncapped. */}
      <div ref={contentRef}>{bodyContent}</div>
    </div>
  );

  const bodyRef = mode === 'tail' ? tailRef : expandedRef;
  const open = mode === 'expanded';
  const live = !!streaming;

  // Arrival: the whole block grows by height (useGrowFrom) and fades in. The
  // tail body inside it never animates per streamed chunk; it only opens and
  // closes as a whole. A settled block keeps a plain root (enterFrom never
  // changes, so neither does the element type).
  const root = (children: React.ReactNode, extra?: React.CSSProperties) => {
    const style: React.CSSProperties = { marginBottom: 8, fontSize: 'var(--fs-sm)', ...extra };
    return enterFrom === null ? (
      <div data-agent-block style={style}>{children}</div>
    ) : (
      <motion.div ref={rootRef} data-agent-block initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={BLOCK_FADE} style={style}>
        {children}
      </motion.div>
    );
  };
  const bodySlot = (chrome?: React.CSSProperties) => (
    <Reveal show={showBody} exitTransition={finishing ? THOUGHT_FINISH : undefined}>
      {body(bodyRef, mode === 'tail', chrome)}
    </Reveal>
  );

  // ── 1b · card chrome: hairline square-corner card, spinner/sparkle header,
  //    hairline-divided serif body. ──
  if (variant === 'card') {
    const cardBase = dur != null
      ? `${hasTools ? 'Worked' : 'Thought'} for ${formatDurationMs(dur)}`
      : (hasTools ? 'Worked' : 'Thoughts');
    const cardSuffix = toolCount && toolCount > 0
      ? `· ${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}`
      : codexStepCount > 0
        ? `· ${codexStepCount} ${codexStepCount === 1 ? 'step' : 'steps'}`
        : '';
    // Finished blocks with tools lead with what they did; the duration moves
    // to the right edge. Computed only once done, never per streamed token.
    // A window that words its own tools (the Companion's workLine) shows its
    // line without the duration: next to one tool's name, the block's span
    // (the reasoning before and after the call) reads as that tool's time.
    const blockTools = !streaming && hasTools
      ? ownGroupTools(tools ?? segments?.flatMap((s) => (s.kind === 'tools' ? s.tools : [])) ?? [], subagents)
      : null;
    const ownWork = blockTools && workLine ? workLine(blockTools) : null;
    const work = ownWork ? { text: ownWork, failed: failedToolCount(blockTools ?? []) }
      : blockTools ? summarizeWork(blockTools) : null;
    return root(
        <div style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface)' }}>
          <CardThoughtHeader
            streaming={live}
            phase={phase}
            open={open}
            onToggle={handleToggle}
            startedAt={startedAt}
            clockKey={clockKey}
            workText={work?.text || undefined}
            workFailed={work?.failed}
            durText={!ownWork && work?.text && dur != null ? formatDurationMs(dur) : undefined}
            base={live ? undefined : cardBase}
            suffix={live ? undefined : cardSuffix}
          />
          {bodySlot({
            borderTop: '1px solid var(--term-line)',
            padding: '9px 12px',
            color: 'var(--term-mid)',
            lineHeight: 1.6,
            // Mock spec: thought prose sits a step below the answer body
            // (12px at the default 15px slider). Scales with the size slider.
            ['--message-body-size' as never]: 'calc(var(--message-body-size-base, 15px) * 0.8)',
            ['--message-body-leading' as never]: '1.6',
          })}
        </div>,
      { fontFamily: 'var(--ui-font)' },
    );
  }

  // ── 1d · terminal chrome: ❯-prompt streaming row with a blinking caret,
  //    tracking-caps collapsed row with a dotted leader, accent-rule body. ──
  if (variant === 'terminal') {
    const rightMeta = [
      dur != null ? formatDurationMs(dur) : null,
      toolCount && toolCount > 0
        ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`
        : codexStepCount > 0
          ? `${codexStepCount} ${codexStepCount === 1 ? 'step' : 'steps'}`
          : null,
    ].filter(Boolean).join(' · ');
    return root(
      <>
        <TerminalThoughtHeader
          streaming={live}
          phase={phase}
          open={open}
          onToggle={handleToggle}
          hasTools={live ? undefined : hasTools}
          rightMeta={live ? undefined : rightMeta}
        />
        {bodySlot({
          marginTop: 5,
          marginLeft: 3,
          paddingLeft: 11,
          borderLeft: '2px solid var(--term-accent-f)',
          color: 'var(--term-muted)',
          lineHeight: 1.55,
          ['--message-body-size' as never]: 'calc(var(--message-body-size-base, 15px) * 0.8)',
          ['--message-body-leading' as never]: '1.55',
        })}
      </>,
      { fontFamily: 'var(--ui-font)' },
    );
  }

  return root(
    <>
      <PlainThoughtHeader
        streaming={live}
        phase={phase}
        open={open}
        onToggle={handleToggle}
        doneLabel={live ? undefined : doneLabel}
      />
      {bodySlot()}
    </>,
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
      animate={{ opacity: 1, transition: { duration: 0.12 } }}
      exit={{ opacity: 0, transition: { duration: 0.08 } }}
      // Leaving dots are no longer a status.
      aria-hidden={present ? undefined : true}
    >
      <ThinkingIndicator />
    </motion.div>
  );
}

/**
 * Where the pending dots sit. When the first content replaces them they fade
 * out in place (popped out of the flow, so nothing jumps) while the arriving
 * block grows from their height. Placed before the message's content.
 * Memoized: streamed chunks re-render its parent, not it.
 */
const PendingIndicatorSlot = React.memo(function PendingIndicatorSlot({ show }: { show: boolean }) {
  const scope = useContext(MessageMotionContext);
  const dotsRef = useRef<HTMLDivElement>(null);
  // Record the dots' height when they show; clear it in the commit that hides
  // them, after the block replacing them has rendered.
  useLayoutEffect(() => {
    if (scope) scope.pendingHeight.current = show ? dotsRef.current?.offsetHeight ?? null : null;
  }, [scope, show]);
  return (
    // The positioned parent popLayout needs for the leaving dots.
    <div style={{ position: 'relative' }}>
      <AnimatePresence initial={false} mode="popLayout">
        {show && <PendingDots key="pending" ref={dotsRef} />}
      </AnimatePresence>
    </div>
  );
});

/**
 * Under a user message of an ordinary chat whose live session read
 * check-in material on an earlier turn (the route's companionTurn.carriedTaint,
 * w3-fix D17): why its tools ask. The agent's own conversation draws its
 * route lines itself (CompanionChatTab's afterMessage decoration).
 */
function CarriedTaintNote({ message }: { message: Pick<ChatMessage, 'role' | 'companionTurn'> }) {
  const turn = message.role === 'user' ? message.companionTurn : undefined;
  if (!turn?.carriedTaint || turn.startTaint) return null;
  return (
    <p
      role="note"
      className="terminal-message-turn-note"
      style={{ margin: '4px 0 0', textAlign: 'right', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}
    >
      Anything that would leave this machine asks first: this conversation read check-in material earlier.
    </p>
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
  '--tw-prose-links': 'var(--term-accent)',
  '--tw-prose-counters': 'var(--term-mid)',
  '--tw-prose-bullets': 'var(--term-mid)',
} as React.CSSProperties;

const thoughtProseVars: React.CSSProperties = {
  '--tw-prose-body': 'inherit',
  '--tw-prose-headings': 'inherit',
  '--tw-prose-bold': 'inherit',
  '--tw-prose-code': 'inherit',
  '--tw-prose-links': 'var(--term-accent)',
} as React.CSSProperties;

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
    const groupKey = seg.tools[0].id;
    const defaultExpanded = seg.tools.some((t) => isRunningStatus(t.status));
    chipIdx += 1;
    return (
      <ToolCallGroup
        key={groupKey}
        tools={seg.tools}
        defaultExpanded={defaultExpanded}
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

function thinkingToolGroups(blocks: readonly AssistantBlock[], toolsById: ReadonlyMap<string, ToolCallState>): ToolCallState[][] {
  const groups: ToolCallState[][] = [];
  let current: ToolCallState[] | null = null;
  for (const block of blocks) {
    if (block.kind !== 'tool') {
      current = null;
      continue;
    }
    const tool = toolsById.get(block.toolCallId);
    if (!tool) continue;
    if (!current) {
      current = [];
      groups.push(current);
    }
    current.push(tool);
  }
  return groups;
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

interface ThinkingRunViewProps {
  blocks: AssistantBlock[];
  tools: ToolCallState[];
  streaming: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  /** Durable activity window and clock key, forwarded to TermThoughtBlock. */
  startedAt?: number;
  endedAt?: number;
  clockKey?: string;
}

function ThinkingRunViewInner({
  blocks, tools, streaming, subagents, runtimeId, startedAt, endedAt, clockKey,
}: ThinkingRunViewProps) {
  const toolsById = useMemo(() => toolMap(tools), [tools]);
  const text = useMemo(() => thinkingRunRawText(blocks), [blocks]);
  const groups = useMemo(() => thinkingToolGroups(blocks, toolsById), [blocks, toolsById]);
  const groupedTools = useMemo(() => groups.flat(), [groups]);
  const toolCount = useMemo(() => ownGroupTools(groupedTools, subagents).length, [groupedTools, subagents]);
  const toolsActive = tools.some((t) => isRunningStatus(t.status));
  // Hydrated turns have no live thinking timer; the run's tool-call span is
  // the best available duration approximation. Keep the block live while
  // tools still run so the timer covers thinking + tool work, not thought only.
  const spanMs = useMemo(() => toolSpanMs(tools), [tools]);
  return (
    <>
      <TermThoughtBlock
        text={text}
        streaming={streaming || toolsActive}
        phase={streaming ? 'thinking' : toolsActive ? 'working' : 'done'}
        toolCount={toolCount}
        runtimeId={runtimeId}
        durationMs={spanMs}
        startedAt={startedAt}
        endedAt={endedAt}
        clockKey={clockKey}
        tools={groupedTools}
        subagents={subagents}
      >
        {groups.length > 0
          ? groups.map((group) => (
              <ToolCallGroup
                key={group[0].id}
                tools={group}
                defaultExpanded={group.some((t) => isRunningStatus(t.status))}
                subagents={subagents}
                receipts={false}
              />
            ))
          : null}
      </TermThoughtBlock>
      {/* Outside the block: it collapses once the turn ends. */}
    </>
  );
}

const ThinkingRunView = React.memo(ThinkingRunViewInner, (prev, next) =>
  sameBlockRefs(prev.blocks, next.blocks) &&
  sameToolRefs(prev.tools, next.tools) &&
  prev.streaming === next.streaming &&
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId &&
  prev.startedAt === next.startedAt &&
  prev.endedAt === next.endedAt &&
  prev.clockKey === next.clockKey,
);

/* ── Agent-run clustering (card / terminal variants) ──
   Consecutive thinking runs and tool-only answer runs merge into ONE agent
   block: a single thought header whose body interleaves thought prose and
   tool groups in stream order. Answer runs with visible text break clusters.
   The plain variant keeps the historical one-block-per-run rendering. */

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
  /** Durable activity window and clock key, forwarded to TermThoughtBlock. */
  startedAt?: number;
  endedAt?: number;
  clockKey?: string;
}

function AgentClusterViewInner({
  runs, tools, streaming, phase, subagents, runtimeId, startedAt, endedAt, clockKey,
}: AgentClusterViewProps) {
  const toolsById = useMemo(() => toolMap(tools), [tools]);
  const segments = useMemo(() => {
    const out: ThoughtSegment[] = [];
    for (const run of runs) {
      for (const block of run.blocks) {
        if (block.kind === 'thinking') {
          if (!block.rawText) continue;
          const last = out[out.length - 1];
          // Adjacent thinking blocks are stream fragments of one thought —
          // concatenate raw (mirrors thinkingRunRawText's '' join).
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
  const text = useMemo(
    () => segments.filter((s) => s.kind === 'text').map((s) => (s as { text: string }).text).join('\n\n'),
    [segments],
  );
  const spanMs = useMemo(() => toolSpanMs(tools), [tools]);
  const segmentTools = useMemo(
    () => segments.flatMap((s) => (s.kind === 'tools' ? s.tools : [])),
    [segments],
  );
  return (
    <>
      <TermThoughtBlock
        text={text}
        segments={segments}
        streaming={streaming}
        phase={phase}
        toolCount={ownGroupTools(tools, subagents).length}
        runtimeId={runtimeId}
        durationMs={spanMs}
        startedAt={startedAt}
        endedAt={endedAt}
        clockKey={clockKey}
        subagents={subagents}
      />
      {/* Outside the block: it collapses once the turn ends. */}
    </>
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
  prev.endedAt === next.endedAt &&
  prev.clockKey === next.clockKey,
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
 * The assistant body. In the line chrome a finished turn folds its work into
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
  const variant = useAgentBlockStyle();
  const [smoothing, setSmoothing] = useState(false);
  const reportSmoothing = useCallback((isSmoothing: boolean) => {
    setSmoothing(isSmoothing);
    onSmoothingChange?.(isSmoothing);
  }, [onSmoothingChange]);
  const settled = variant === 'line' && !turnActive && !smoothing && !subagents?.some(isSubagentActive);
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
  const variant = useAgentBlockStyle();
  const clusters = useMemo(
    () =>
      variant === 'plain'
        ? runs.map((run): RenderCluster => ({ kind: 'run', run }))
        // With thoughts hidden there is no agent block to join; keep tools
        // under the prose that introduced them.
        : clusterAgentRuns(showThoughts ? detachEdgeTools(runs, byId) : runs),
    [runs, variant, showThoughts, byId],
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
              clockKey={m.id}
            />
          );
        }
        const run = cluster.run;
        const tools = relevantTools(run.blocks, byId);
        if (run.kind === 'image') {
          return <ImageBlockView key={run.id} blocks={run.blocks} />;
        }
        if (run.kind === 'thinking') {
          if (!showThoughts) return null;
          const activity = activityWindow(run.blocks, byId, nextBlock);
          return (
            <ThinkingRunView
              key={run.id}
              blocks={run.blocks}
              tools={tools}
              streaming={run.id === liveThinkingId}
              subagents={subagents}
              runtimeId={runtimeId}
              startedAt={activity.startedAt}
              endedAt={activity.endedAt}
              clockKey={m.id}
            />
          );
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

// The user bubble's background — kept in sync with `.terminal-message-user`
// (index.css) so the collapse gradient fades into the bubble instead of a
// flat neutral.
const USER_BUBBLE_BG = 'var(--term-user-bubble-bg)';

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
  const reduceMotion = useReducedMotionConfig() ?? false;
  /** The height a toggle starts from, measured on the click. */
  const toggleFromRef = useRef<number | null>(null);
  const heightMotionRef = useRef<{ stop: () => void } | null>(null);

  const toggle = () => {
    const el = contentRef.current;
    heightMotionRef.current?.stop();
    heightMotionRef.current = null;
    const from = el && clampHeight != null && !reduceMotion ? el.getBoundingClientRect().height : null;
    toggleFromRef.current = from;
    const next = !expanded;
    setExpanded(next);
    if (next || from === null) setClamping(!next);
  };

  // Show more 260ms / Show less 160ms. Hand-written (skipped under reduced
  // motion). The first frame lands in the click's own commit, 1px past the
  // start, so the transcript height changes there and TPane leaves follow
  // mode, as it did when the clamp just snapped.
  useLayoutEffect(() => {
    const el = contentRef.current;
    const from = toggleFromRef.current;
    toggleFromRef.current = null;
    if (!el || from === null || clampHeight == null) return;
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
      if (!expanded) setClamping(true);
    };
    heightMotionRef.current = animate(start, to, {
      duration: expanded ? DUR.expand : DUR.collapse,
      ease: EASE.drawer,
      onUpdate: (h) => {
        if (!done) el.style.height = `${h}px`;
      },
      onComplete: finish,
    });
    // clampHeight is read, not watched: a re-measure must not restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  useEffect(() => () => heightMotionRef.current?.stop(), []);

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
        style={
          collapsed && clamping && clampHeight != null
            ? { position: 'relative', maxHeight: clampHeight, overflow: 'hidden' }
            : { position: 'relative' }
        }
      >
        {children}
        {collapsed && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: '2.6em',
              pointerEvents: 'none',
              background: `linear-gradient(to bottom, transparent, ${USER_BUBBLE_BG})`,
            }}
          />
        )}
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

  const runTest = async () => {
    if (!onTestConnection || testState === 'testing') return;
    setTestState('testing');
    setTestDetail(undefined);
    const result = await onTestConnection();
    setTestState(result.ok ? 'ok' : 'fail');
    setTestDetail(result.detail);
  };

  const btnStyle: React.CSSProperties = {
    border: '1px solid var(--term-danger)',
    color: 'var(--term-danger-text)',
    padding: '3px 10px',
    font: '600 var(--fs-sm) var(--ui-font)',
    letterSpacing: 'var(--ls-wide)',
    cursor: 'pointer',
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
          <button type="button" data-testid="error-tail-retry" disabled style={{ ...btnStyle, cursor: 'default', opacity: 0.6 }}>
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
            ↻ retry
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
            {resumable ? '▶ Resume' : inspectOriginal ? checking ? 'Checking original turn…' : 'Check original turn' : '↻ retry'}
          </button>
        )}
        {inspectOriginal && onRunAgain && (
          <button type="button" disabled={checking} className="t-danger-outline-btn" style={btnStyle}
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
            style={{ ...btnStyle, cursor: testState === 'testing' ? 'default' : 'pointer', opacity: testState === 'testing' ? 0.6 : 1 }}
          >
            {testState === 'testing' ? 'Testing…' : '⚙ Test Connection'}
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
          <button type="button" className="t-danger-outline-btn" style={btnStyle} onClick={(e) => { e.stopPropagation(); setConfirmRerun(false); onRunAgain(); }}>Run again anyway</button>
          {' '}
          <button type="button" className="t-danger-outline-btn" style={btnStyle} onClick={(e) => { e.stopPropagation(); setConfirmRerun(false); }}>Keep current result</button>
        </div>
      )}
      {planStep?.error && (
        <div role="status" style={{ marginTop: 6, maxWidth: 720, color: 'var(--term-muted)', font: 'var(--fs-sm) var(--ui-font)', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
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
  fontFamily: string;
  density: TerminalDensity;
  usageInfo?: TurnUsageInfo | null;
  isErrorTail?: boolean;
  errorMessage?: string;
  /** Runtime/storage/transport classification, including uncertain turn outcomes. */
  errorKind?: string;
  errorRecovery?: 'checking' | 'unavailable';
  onRunAgain?: () => void;
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
  transition: { duration: 0.12, ease: 'linear' },
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
  fontFamily,
  density,
  usageInfo,
  isErrorTail,
  errorMessage,
  errorKind,
  errorRecovery,
  onRunAgain,
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
  const [hover, setHover] = useState(false);
  // A plan's review prompt shows its instruction line, a synthesis or addendum wake its caption, until opened.
  const [planBodyOpen, setPlanBodyOpen] = useState(false);
  const [editText, setEditText] = useState(m.text);
  const editAreaRef = useRef<HTMLTextAreaElement>(null);
  const assistantRef = useRef<HTMLDivElement>(null);
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
  const [motionScope] = useState<MessageMotionScope>(() => ({ mounted: { current: false }, pendingHeight: { current: null } }));
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
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeComposing(e)) return;
                  if (e.key === 'Escape') { e.preventDefault(); onEditCancel?.(); }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    const trimmed = editText.trim();
                    if (trimmed && trimmed !== m.text) onEditSave?.(trimmed);
                    else onEditCancel?.();
                  }
                }}
                spellCheck={false}
              />
              <div className="user-edit-footer">
                <button className="user-edit-action" onClick={() => onEditCancel?.()}>
                  Cancel <kbd>Esc</kbd>
                </button>
                <span style={{ flex: 1 }} />
                <button
                  className="user-edit-action"
                  onClick={() => {
                    const trimmed = editText.trim();
                    if (trimmed && trimmed !== m.text) onEditSave?.(trimmed);
                    else onEditCancel?.();
                  }}
                >
                  Save <kbd>{kbd('mod', 'enter')}</kbd>
                </button>
              </div>
            </div>
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
            {planBodyOpen && (
              <div
                className="terminal-message terminal-message-user"
                data-density={density}
                style={{ fontFamily: 'var(--ui-font)', lineHeight: 'var(--message-body-leading)', letterSpacing: 0, color: 'var(--term-fg)', wordBreak: 'break-word' }}
              >
                <MarkdownContent text={userMarkdown(m.text)} size="sm" className={isDark ? 'prose-invert' : ''} style={proseVars} />
              </div>
            )}
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
              />
            ) : reviewHead !== undefined ? (
              <>
                <MarkdownContent
                  text={userMarkdown(planBodyOpen ? m.text : reviewHead)}
                  size="sm"
                  className={isDark ? 'prose-invert' : ''}
                  style={proseVars}
                />
                <button
                  type="button"
                  className="t-hover-fg t-user-text-toggle"
                  aria-expanded={planBodyOpen}
                  onClick={(e) => { e.stopPropagation(); setPlanBodyOpen((open) => !open); }}
                  style={USER_TEXT_TOGGLE_STYLE}
                >
                  {planBodyOpen ? 'Show less' : 'Show all'}
                </button>
              </>
            ) : (
              <CollapsibleUserText contentKey={m.text}>
                <MarkdownContent
                  text={userMarkdown(m.text)}
                  size="sm"
                  className={isDark ? 'prose-invert' : ''}
                  style={proseVars}
                />
              </CollapsibleUserText>
            )}
            {m.streaming && (
              <span
                style={{
                  display: 'inline-block',
                  width: 7,
                  height: 12,
                  background: 'var(--term-select)',
                  marginLeft: 2,
                  verticalAlign: 'middle',
                  animation: 'tblink var(--t-loop-fast) infinite',
                }}
              />
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
            fontFamily,
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
      {!isUser && <TurnReceipts tools={m.toolCalls} workspaceId={workspaceId} backendConnectionId={backendConnectionId} />}
      {!isUser && <MultiModelReceipt tools={m.toolCalls} backendConnectionId={backendConnectionId} readOnly={readOnly} />}
      {/* What the reply was based on: it reads its own store (only where PaneMessageList offers it), so this block's props stay as they are. */}
      {!isUser && !(m.streaming || hideActions) && <ReplyMemorySources messageId={m.id} settled />}
      {!isUser && workflowRuns && workflowRuns.length > 0 && (
        <MessageWorkflowRuns runs={workflowRuns} onOpen={onOpenWorkflowRun} />
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
          <div
            className="t-user-msg-actions"
            style={{ display: 'flex', justifyContent: 'flex-end', pointerEvents: hover ? undefined : 'none' }}
          >
            <MessageActions
              visible={hover}
              time={formatMessageTime(m.createdAt)}
              copyText={copyText}
              onRetry={onRetry}
              onEdit={onEdit}
              onBranch={onBranch}
              usageInfo={usageInfo}
            />
          </div>
        ) : (
          // The answer's meta line. Edit belongs to the user's message.
          <MessageActions
            answer
            visible={hover || (!!pinned && !decorations)}
            restVisible={actionsAtRest}
            time={formatMessageTime(m.createdAt)}
            copyText={copyText}
            onRetry={isErrorTail && turnErrorAction(errorKind) === 'inspect-existing-turn' ? undefined : onRetry}
            onBranch={onBranch}
            usageInfo={usageInfo}
          />
        )
      )}
      {decorations?.afterMessage ? decorations.afterMessage(m) : <CarriedTaintNote message={m} />}
    </>
  );
  // mouseover rather than mouseenter: after a tap on a control, a tap on the
  // text lands inside the message already, where no mouseenter fires.
  const onMouseOver = (e: React.MouseEvent<HTMLElement>) => {
    if (hover) return;
    const control = e.target instanceof Element ? e.target.closest(TAP_CONTROL) : null;
    if (control && lastInputWasTouch() && e.currentTarget.contains(control)) return;
    setHover(true);
  };
  const onMouseLeave = () => setHover(false);
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
        <motion.div
          onMouseOver={onMouseOver}
          onMouseLeave={onMouseLeave}
          {...entrance}
          style={rootStyle}
        >
          {body}
        </motion.div>
      ) : (
        <div onMouseOver={onMouseOver} onMouseLeave={onMouseLeave} style={rootStyle}>
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
  prev.fontFamily === next.fontFamily &&
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
