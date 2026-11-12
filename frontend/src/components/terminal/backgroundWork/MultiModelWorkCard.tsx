import React, { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  isWorkflowRunTerminal,
  MULTI_MODEL_LIMITS,
  type MultiModelRunView,
  type MultiModelStepView,
  type MultiModelThreadView,
  type WorkflowApprovalDto,
  type WorkflowRunDtoV1,
} from 'michi-shared';
import { ChatNodeStoreContext, useOptionalChatActions, useOptionalChatProjects } from '../../../state/chatStore';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { findTreeIdForNode } from '../../../state/tree';
import { useWorkflowRun } from '../../../state/workflowDomain';
import MarkdownContent from '../../MarkdownContent';
import { useNow } from '../../../hooks/useNow';
import { resultProseVars } from '../resultProseVars';
import { formatWorkflowTokens } from '../workflows/workflowPresentation';
import {
  addendumOutcome,
  approvalForRow,
  branches,
  childNodeIds,
  defaultOpenStep,
  fixesAtStep,
  formatDuration,
  isLongApproval,
  isStepInFlight,
  liveThreads,
  permissionText,
  runActions,
  RUN_CHIP_COLOR,
  runChip,
  runtimeGlyph,
  stepIcon,
  stepLabel,
  stepProgress,
  stepStates,
  synthesisNote,
  threadActions,
  threadElapsed,
  threadOfApproval,
  type StepState,
  type StepTone,
  type ThreadActions,
} from '../multiModel/multiModelPresentation';
import { ColumnsIcon, ForkIcon } from '../icons';
import { MultiModelModelPicker, useReadyModels } from '../multiModel/MultiModelModelPicker';
import { useMultiModelCommands } from '../multiModel/useMultiModelCommands';
import { FullRun } from './WorkflowWorkCard';
import { INNER_RADIUS, WORK_CARD, WORK_CARD_CLASS } from './workCardParts';
import '../workflows/runChip.css';
import './MultiModelWorkCard.css';

/**
 * A multi-model run in the Background work drawer (mock `drawerCard`):
 * what was asked, the approvals it waits on, what failed, the synthesis
 * once written, then every step with one row per branch. A row opens to
 * the start (or, while it runs, the live tail) of that branch's answer and
 * its controls. Only started runs reach the drawer (selectBackgroundWork),
 * so there is no plan layout. Opening a pane closes the drawer: it is
 * modal, and fills a phone.
 */

const MONO = 'var(--font-mono)';
const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

const TONE_COLOR: Record<StepTone, string> = {
  ok: 'var(--term-digest)', run: 'var(--term-run)', wait: 'var(--term-select)', fail: 'var(--term-danger-text)',
  stop: 'var(--term-muted)', skip: 'var(--term-muted)', idle: 'var(--term-faint)',
};

function rowId(step: number, key: string): string {
  return `${step}:${key}`;
}

function rowDomId(runId: string, step: number, key: string): string {
  return `bw-mm-${`${runId}-${step}-${key}`.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function Glyph({ runtimeId, label, small = false }: { runtimeId: string; label: string; small?: boolean }) {
  const glyph = runtimeGlyph(runtimeId, label);
  const size = small ? 15 : 18;
  return (
    <span aria-hidden style={{
      width: size, height: size, flexShrink: 0, display: 'inline-grid', placeItems: 'center', boxSizing: 'border-box',
      border: '1px solid var(--term-line-s)', background: 'var(--term-surface)', color: glyph.color,
      fontFamily: MONO, fontSize: small ? 'var(--fs-2xs)' : 'var(--fs-xs)', fontWeight: 600, lineHeight: 1,
    }}>{glyph.letter}</span>
  );
}

function Who({ thread }: { thread: MultiModelThreadView }) {
  return <><b style={{ color: 'var(--term-fg)', fontWeight: 500 }}>{thread.runtimeLabel}</b> · {thread.modelLabel}</>;
}

function Chip({ run, view, now }: { run: WorkflowRunDtoV1; view: MultiModelRunView; now: number }) {
  const chip = runChip(run, view, now);
  const { color, fill } = RUN_CHIP_COLOR[chip.tone];
  return (
    <span data-testid="background-workflow-status" className="run-chip" style={{ background: fill, color }}>
      {chip.tone === 'run' && <span aria-hidden className="term-dot-i term-dot-i--run" />}
      {chip.label}
      {chip.time && <span className="run-chip__time">{chip.time}</span>}
    </span>
  );
}

const ICON_STYLE: React.CSSProperties = { verticalAlign: -1 };

const SCHEDULED_ONLY = Symbol('scheduled-only');
/** The caller's workspace id, SCHEDULED_ONLY, or null while unknown (or outside ChatProvider). */
type CallerPlace = string | typeof SCHEDULED_ONLY | null;
const NO_SUBSCRIPTION = () => () => {};

/**
 * Whether the run's caller is read-only where it shows (an archived thread
 * or workspace; a Scheduled-only thread, which the Scheduled page shows
 * read-only until it is moved): the in-chat card has no controls there, so
 * neither has its drawer card.
 */
function isCallerReadOnly(nodeId: string, place: CallerPlace, projects: readonly Project[] | undefined): boolean {
  if (place === null) return false;
  if (place === SCHEDULED_ONLY) return true;
  const project = projects?.find((entry) => entry.id === place);
  if (!project) return false;
  if (project.archivedAt) return true;
  const treeId = findTreeIdForNode(nodeId, project);
  return !!project.trees.find((tree) => tree.id === treeId)?.archivedAt;
}

/** Where the caller lives, as a value that does not change while it streams (so its chunks do not re-render the card). */
function useCallerPlace(nodeId: string | undefined): CallerPlace {
  const store = useContext(ChatNodeStoreContext);
  const subscribe = useCallback((listener: () => void) => (store && nodeId ? store.subscribeNode(nodeId, listener) : NO_SUBSCRIPTION()), [store, nodeId]);
  const getPlace = useCallback((): CallerPlace => {
    const node: ChatNodeState | undefined = store && nodeId ? store.getNode(nodeId) : undefined;
    if (!node) return null;
    return node.scheduledOnlyJobId ? SCHEDULED_ONLY : node.projectId;
  }, [store, nodeId]);
  return useSyncExternalStore(subscribe, getPlace, getPlace);
}

/** What the drawer can do with a run; absent parts hide their controls. */
interface CardActions {
  /** Open a node's pane and close the drawer (no chat actions outside ChatProvider). */
  openNode?: (nodeId: string, messageId?: string) => void;
  /** A row's controls (threadActions): none when read-only or without a workflow domain. */
  rowActions: (thread: MultiModelThreadView) => ThreadActions;
  /** A thread command (Stop, Retry), through the domain. */
  thread: (key: string, command: 'stop' | 'retry') => void;
  /** Open (or close) the ready-models picker at `place` to replace a row's model. */
  replace: (thread: MultiModelThreadView, place: string) => void;
  /** The place whose picker is open. */
  replacingAt?: string;
  /** The open picker, rendered under the controls that opened it. */
  picker?: React.ReactNode;
  answer?: (approvalId: string, optionId: string) => void;
  /** A command is in flight: the run's buttons wait. */
  busy: boolean;
}

/** "Retry" and "Replace model" for a thread, as its row actions allow (`replaceOnly`: beside run Retry). */
function FixButtons({ thread, actions, place, link = false, replaceOnly = false }: {
  thread: MultiModelThreadView;
  actions: CardActions;
  place: string;
  link?: boolean;
  replaceOnly?: boolean;
}) {
  const { retry, replace } = actions.rowActions(thread);
  const className = link ? 'mm-dlink' : 'mm-dbtn';
  return (
    <>
      {retry && !replaceOnly && <button type="button" disabled={retry.disabled} onClick={() => actions.thread(thread.key, 'retry')} className={className}>Retry</button>}
      {replace && (
        <button type="button" disabled={replace.disabled} aria-haspopup="dialog" aria-expanded={actions.replacingAt === place} data-picker-toggle
          onClick={() => actions.replace(thread, place)} className={className}>
          Replace model
        </button>
      )}
    </>
  );
}

function ApprovalLine({ view, approval, actions }: { view: MultiModelRunView; approval: WorkflowApprovalDto; actions: CardActions }) {
  const [full, setFull] = useState(false);
  const thread = threadOfApproval(view, approval);
  const child = thread?.childNodeId;
  const long = isLongApproval(approval);
  const detailId = useId();
  return (
    <div role="group" aria-label={`Approval needed: ${approval.title}`} data-testid="workflow-approval" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
      {thread && <Glyph runtimeId={thread.runtimeId} label={thread.runtimeLabel} />}
      <div style={{ flex: 1, minWidth: 180, fontSize: 'var(--fs-md)', lineHeight: 1.45, color: 'var(--term-mid)' }}>
        <div style={{ overflowWrap: 'anywhere' }}>{thread && <><Who thread={thread} /> · </>}{approval.title}</div>
        {approval.detail && (
          // Named by what it does: the detail (up to 4000 chars) is its description, not its name.
          <button type="button" aria-expanded={full} aria-label={full ? 'Collapse the request' : 'Show the full request'} aria-describedby={detailId}
            title={full ? 'Click to collapse' : 'Click to show all'} onClick={() => setFull((value) => !value)}
            style={{ display: 'block', width: '100%', marginTop: 2, padding: 0, border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}>
            <code id={detailId} style={{ display: 'block', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-fg)', ...(full ? { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } : ellipsis) }}>{approval.detail}</code>
          </button>
        )}
        {long && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 'var(--fs-sm)', color: 'var(--term-select)' }}>
            Long request: check it in the branch
            {actions.openNode && child && (
              <button type="button" onClick={() => actions.openNode?.(child)} className="mm-dlink">Open branch</button>
            )}
          </div>
        )}
      </div>
      {actions.answer && (
        <div style={{ display: 'flex', gap: 6 }}>
          {approval.options.map((option, index) => (
            <button key={option.optionId} type="button" disabled={actions.busy} onClick={() => actions.answer?.(approval.id, option.optionId)}
              className={index === 0 && !long ? 'mm-dbtn is-warn' : 'mm-dbtn'}>
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** For a row whose step has no text of its own: the branch's latest completed text before it, and which step wrote it. */
function earlierExcerpt(thread: MultiModelThreadView, before: number): { text: string; step: number } | undefined {
  for (let index = Math.min(before, thread.steps.length) - 1; index >= 0; index -= 1) {
    const step = thread.steps[index];
    if (step.status === 'completed' && step.excerpt) return { text: step.excerpt, step: index };
  }
  return undefined;
}

function rowLine(run: WorkflowRunDtoV1, thread: MultiModelThreadView, step: MultiModelStepView, index: number): { text: string; color: string; now?: true } | undefined {
  if (step.status === 'waiting') {
    const text = approvalForRow(run, thread.key, index) ? 'Waiting for your approval, see above' : 'Waiting for your answer in the branch';
    return { text, color: 'var(--term-select)' };
  }
  if (step.status === 'running' && step.now) return { text: step.now, color: 'var(--term-muted)', now: true };
  if (step.status === 'completed') return step.summary ? { text: step.summary, color: 'var(--term-mid)' } : undefined;
  if (step.status === 'skipped') return { text: step.error ? `Didn't take part: ${step.error}` : "Didn't take part", color: 'var(--term-muted)' };
  if (step.error) return { text: step.error, color: step.status === 'failed' ? 'var(--term-danger-text)' : 'var(--term-muted)' };
  return undefined;
}

/** `text`, then `sentence` after a full stop when there is one. */
function withSentence(text: string, sentence: string | undefined): string {
  if (!sentence) return text;
  return `${text}${/[.!?。！？]$/.test(text) ? ' ' : '. '}${sentence}`;
}

/** The excerpt box's height; a longer excerpt fades out at its clipped edge, as a run's result does (WorkflowWorkCard). */
const EXCERPT_MAX_HEIGHT = 168;

/**
 * A live tail is the last 1200 visible chars streamed so far: a full one
 * starts mid-line, so it starts at the next line instead.
 */
function tailText(text: string): string {
  if (text.length < MULTI_MODEL_LIMITS.excerpt) return text;
  const newline = text.indexOf('\n');
  return newline >= 0 && newline < text.length - 1 ? text.slice(newline + 1) : text;
}

/**
 * The start of a branch's answer, or while it runs the live tail of it (with
 * the caret), rendered as Markdown in a short box: the start fades out at the
 * bottom, the tail keeps its newest lines and fades out at the top.
 */
function Excerpt({ text, tail }: { text: string; tail: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const shown = tail ? tailText(text) : text;
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    // Its children's heights, not scrollHeight: a tail overflows upward, which scrollHeight does not count.
    const content = Array.from(element.children).reduce((sum, child) => sum + (child as HTMLElement).offsetHeight, 0);
    setClipped(content > element.clientHeight + 1);
  }, [shown]);
  const fade = clipped ? `linear-gradient(to ${tail ? 'top' : 'bottom'}, #000 75%, transparent)` : undefined;
  return (
    // A div, not a blockquote: prose styles quote paragraphs anywhere under a blockquote.
    <div data-testid="multi-model-excerpt" style={{ margin: '0 0 8px', padding: '6px 10px', borderLeft: '2px solid var(--term-line-s)', background: 'color-mix(in srgb, var(--term-alt) 35%, transparent)', overflowWrap: 'anywhere' }}>
      <div ref={box} data-testid="multi-model-excerpt-body" data-clipped={clipped || undefined}
        style={{ maxHeight: EXCERPT_MAX_HEIGHT, overflow: 'hidden', ...(tail ? { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' } : {}), maskImage: fade, WebkitMaskImage: fade }}>
        <MarkdownContent text={shown} size="sm" style={{ ...resultProseVars, fontSize: 'var(--fs-md)', lineHeight: 1.55, flexShrink: 0 }} />
        {tail && <span aria-hidden data-testid="multi-model-live-caret" className="agent-glyph-run" style={{ flexShrink: 0, color: 'var(--term-run)', lineHeight: 1.2 }}>▍</span>}
      </div>
    </div>
  );
}

function ThreadRow({ run, thread, index, first, open, onToggle, now, actions }: {
  run: WorkflowRunDtoV1;
  thread: MultiModelThreadView;
  index: number;
  /** The step's first row has no rule above it. */
  first: boolean;
  open: boolean;
  onToggle: (id: string) => void;
  now: number;
  actions: CardActions;
}) {
  const step = thread.steps[index];
  const child = thread.childNodeId;
  const icon = stepIcon(step.status);
  const elapsed = threadElapsed(step, now);
  const line = rowLine(run, thread, step, index);
  const id = rowDomId(run.id, index, thread.key);
  const noAnswer = step.status === 'failed' || step.status === 'skipped';
  // A step with no text of its own (a review that has not streamed yet, or was stopped) shows the
  // branch's earlier text, saying whose it is.
  const earlier = noAnswer || step.excerpt ? undefined : earlierExcerpt(thread, index);
  const excerpt = noAnswer ? undefined : step.excerpt ?? earlier?.text;
  const rowActions = actions.rowActions(thread);
  const label = stepLabel(step.kind, step.status);
  return (
    <div data-testid="multi-model-row" data-thread-key={thread.key} data-step={index} data-status={step.status} style={first ? undefined : { borderTop: '1px solid var(--term-line)' }}>
      <button type="button" id={id} aria-expanded={open} aria-controls={open ? `${id}-detail` : undefined}
        aria-label={withSentence(`${thread.runtimeLabel} · ${thread.modelLabel}, ${label}${line ? `: ${line.text}` : ''}`, step.notice)}
        onClick={() => onToggle(rowId(index, thread.key))}
        style={{ display: 'block', width: '100%', minWidth: 0, padding: '8px 4px', border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Glyph runtimeId={thread.runtimeId} label={thread.runtimeLabel} />
          <span style={{ ...ellipsis, flex: 1, fontSize: 'var(--fs-md)', color: 'var(--term-mid)' }}><Who thread={thread} /></span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, fontSize: 'var(--fs-xs)', color: TONE_COLOR[icon.tone], whiteSpace: 'nowrap' }}>
            {icon.icon === 'dot'
              ? <span aria-hidden className={step.status === 'running' ? 'term-dot-i term-dot-i--run' : 'term-dot-i'} style={{ width: 6, height: 6, background: 'currentColor', opacity: 1 }} />
              : <span aria-hidden>{icon.icon}</span>}
            {label}
          </span>
          <span style={{ flexShrink: 0, minWidth: 42, textAlign: 'right', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {step.status === 'skipped' ? '—' : elapsed !== undefined ? formatDuration(elapsed) : ''}
          </span>
          <span aria-hidden style={{ marginLeft: 2, fontSize: 'var(--fs-xs)', color: 'var(--term-faint)' }}>{open ? '▾' : '▸'}</span>
        </span>
        {line && (
          <span style={{ display: 'block', margin: '3px 0 0 26px', minWidth: 0, lineHeight: 1.5, color: line.color, ...(line.now ? { ...ellipsis, fontFamily: MONO, fontSize: 'var(--fs-xs)' } : { fontSize: 'var(--fs-sm)' }) }}>
            {line.now && <span aria-hidden style={{ color: 'var(--term-run)' }}>❯ </span>}{line.text}
          </span>
        )}
        {step.notice && (
          <span data-testid="multi-model-notice" style={{ display: 'block', margin: '2px 0 0 26px', minWidth: 0, fontSize: 'var(--fs-xs)', lineHeight: 1.5, color: 'var(--term-select)' }}>
            {step.notice}
          </span>
        )}
      </button>
      {open && (
        <div id={`${id}-detail`} data-testid="multi-model-row-detail" style={{ margin: '0 4px 10px 30px' }}>
          {earlier && (
            <div data-testid="multi-model-excerpt-from" style={{ margin: '0 0 3px', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
              {earlier.step === 0 ? 'Its answer from step 1' : `Its revision from step ${earlier.step + 1}`}
            </div>
          )}
          {excerpt && <Excerpt text={excerpt} tail={step.status === 'running' && !!step.excerpt} />}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {actions.openNode && child && (
              <button type="button" onClick={() => actions.openNode?.(child)} className="mm-dbtn">Open branch →</button>
            )}
            {rowActions.stop && isStepInFlight(step.status) && (
              <button type="button" disabled={rowActions.stop.disabled} onClick={() => actions.thread(thread.key, 'stop')} className="mm-dbtn">Stop</button>
            )}
            {fixesAtStep(thread, index) && <FixButtons thread={thread} actions={actions} place={rowId(index, thread.key)} />}
          </div>
          {actions.replacingAt === rowId(index, thread.key) && actions.picker}
        </div>
      )}
    </div>
  );
}

function StepMark({ state, number }: { state: StepState; number: number }) {
  const base: React.CSSProperties = {
    position: 'absolute', left: 0, top: 1, width: 15, height: 15, boxSizing: 'border-box', display: 'grid', placeItems: 'center',
    border: '1px solid var(--term-line-s)', borderRadius: '50%', background: 'var(--term-surface)',
    fontFamily: MONO, fontSize: 'var(--fs-2xs)', fontWeight: 500, lineHeight: 1, color: 'var(--term-mid)',
  };
  if (state === 'done') return <span aria-hidden style={{ ...base, background: 'var(--term-digest-f)', color: 'var(--term-digest)', borderColor: 'color-mix(in srgb, var(--term-digest) 40%, transparent)' }}>✓</span>;
  if (state === 'running') return <span aria-hidden style={{ ...base, borderColor: 'var(--term-run)', color: 'var(--term-run)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--term-run) 18%, transparent)' }}>{number}</span>;
  if (state === 'failed') return <span aria-hidden style={{ ...base, color: 'var(--term-danger-text)' }}>✕</span>;
  // An intentional stop is not an error: a neutral mark, as the rows' ■.
  if (state === 'stopped') return <span aria-hidden style={{ ...base, color: 'var(--term-muted)' }}>■</span>;
  return <span aria-hidden style={{ ...base, color: 'var(--term-faint)' }}>{number}</span>;
}

/** One numbered step of the vertical list: its mark, the line to the next step, a header and a body. */
function Step({ state, number, last, title, sub, children }: {
  state: StepState;
  number: number;
  last: boolean;
  title: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li data-testid="multi-model-step" data-step-state={state} style={{ position: 'relative', listStyle: 'none', padding: `0 0 ${last ? 2 : 12}px 24px` }}>
      {!last && <span aria-hidden style={{ position: 'absolute', left: 7, top: 18, bottom: 0, width: 1, background: state === 'done' ? 'color-mix(in srgb, var(--term-digest) 40%, var(--term-line))' : 'var(--term-line)' }} />}
      <StepMark state={state} number={number} />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--fs-lg)', fontWeight: 500, color: state === 'idle' ? 'var(--term-mid)' : 'var(--term-fg)' }}>
        {title}
        {sub}
      </div>
      {children}
    </li>
  );
}

const subStyle: React.CSSProperties = { fontSize: 'var(--fs-sm)', fontWeight: 400, color: 'var(--term-muted)' };
const sdStyle: React.CSSProperties = { margin: '3px 0 0', fontSize: 'var(--fs-md)', lineHeight: 1.5, color: 'var(--term-mid)' };

function GlyphStack({ threads }: { threads: readonly MultiModelThreadView[] }) {
  return (
    <span style={{ display: 'inline-flex', gap: 3, marginLeft: 2, alignSelf: 'center' }}>
      {threads.map((thread) => <Glyph key={thread.key} runtimeId={thread.runtimeId} label={thread.runtimeLabel} small />)}
    </span>
  );
}

const NO_ROWS: ReadonlySet<string> = new Set();

/** The threads the failure line counts: failed, and with nothing in flight. */
function failedThreads(threads: readonly MultiModelThreadView[]): MultiModelThreadView[] {
  return threads.filter((thread) => !thread.steps.some((step) => isStepInFlight(step.status)) && thread.steps.some((step) => step.status === 'failed'));
}

/**
 * Whether the Replace model picker opened at `place` still shows: under the
 * failure line while its thread is the only failed one, or in its row's
 * detail while that row is open and its step lists rows.
 */
function isPickerShown(view: MultiModelRunView, replacing: { key: string; place: string }, openRows: ReadonlySet<string>): boolean {
  const threads = liveThreads(view);
  if (replacing.place === 'failed') {
    const failed = failedThreads(threads);
    return failed.length === 1 && failed[0].key === replacing.key;
  }
  if (!openRows.has(replacing.place)) return false;
  const step = Number(replacing.place.slice(0, replacing.place.indexOf(':')));
  const listed = step === 0 || threads.some((thread) => thread.steps[step] && thread.steps[step].status !== 'pending');
  return listed && !!threads.find((thread) => thread.key === replacing.key)?.steps[step];
}

export const MultiModelWorkCard = React.memo(function MultiModelWorkCard({ runKey, rowKey, expanded, focus, onClose, onMenuOpenChange }: {
  runKey: string;
  rowKey: string;
  /** The drawer's expanded item: the run's full copy is kept loaded (row excerpts). */
  expanded: boolean;
  /**
   * The row the drawer was opened on (a click on a card row): expanded and
   * scrolled into view. `seq` is the open request's requestSeq, so a new
   * request applies its focus while the card stays mounted.
   */
  focus?: { threadKey: string; step?: number; seq: number };
  onClose: () => void;
  /** The Replace model menu opened or closed: Escape belongs to it, not to the drawer, while it is open. */
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const { resource, pending, error } = useWorkflowRun(runKey);
  const chatActions = useOptionalChatActions();
  const run = resource?.value;
  const view = run?.multiModel;
  const live = !!run && !isWorkflowRunTerminal(run.status);
  const now = useNow(1_000, live);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(NO_ROWS);
  // Replace model: which row (by key) and where its picker opened (a row id, or the failure line).
  const [replacing, setReplacing] = useState<{ key: string; place: string } | null>(null);
  const ready = useReadyModels(resource?.backendConnectionId ?? '', run?.workspaceId ?? '');
  const closePicker = useCallback(() => setReplacing(null), []);
  const runId = run?.id;
  const connection = resource?.backendConnectionId;
  const chatProjects = useOptionalChatProjects();
  const commands = useMultiModelCommands(connection !== undefined && runId ? { backendConnectionId: connection, id: runId } : null);
  // A new open request opens only its row, as a fresh drawer would (the step
  // defaults to the one the card shows open, once the run is known).
  const focusStep = focus && view ? focus.step ?? defaultOpenStep(view) : undefined;
  const focusToken = focus && focusStep !== undefined ? `${focus.seq}\u0000${focus.threadKey}\u0000${focusStep}` : null;
  const [appliedFocus, setAppliedFocus] = useState<string | null>(null);
  if (focus && focusStep !== undefined && focusToken !== appliedFocus) {
    setAppliedFocus(focusToken);
    setOpenRows(new Set([rowId(focusStep, focus.threadKey)]));
  }
  const focusThreadKey = focus?.threadKey;
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusToken || focusThreadKey === undefined || focusStep === undefined || !runId || scrolledFor.current === focusToken) return;
    scrolledFor.current = focusToken;
    // A frame later: after the drawer has scrolled the card itself into view.
    requestAnimationFrame(() => document.getElementById(rowDomId(runId, focusStep, focusThreadKey))?.scrollIntoView?.({ block: 'nearest' }));
  }, [focusToken, focusThreadKey, focusStep, runId]);
  // A picker hidden without being closed (its row collapsed from the keyboard,
  // its failure line gone after a Retry) is forgotten: it does not come back
  // by itself, and Escape is the drawer's again.
  const menuOpen = !!replacing && !!view && isPickerShown(view, replacing, openRows);
  if (replacing && !menuOpen) setReplacing(null);
  useEffect(() => {
    if (!menuOpen || !onMenuOpenChange) return;
    onMenuOpenChange(true);
    return () => onMenuOpenChange(false);
  }, [menuOpen, onMenuOpenChange]);
  const callerPlace = useCallerPlace(view?.callerNodeId);
  if (!resource || !run || !view) return null;

  const identity = { backendConnectionId: resource.backendConnectionId, id: run.id };
  // Read-only, or no domain to send commands through: navigation and approvals only.
  const readOnly = !commands || isCallerReadOnly(view.callerNodeId, callerPlace, chatProjects?.projects);
  const options = { readOnly, busy: !!pending };
  const { stopAll, retry } = runActions(view, options);
  const threads = liveThreads(view);
  const states = stepStates(view);
  const approvals = run.approvals ?? [];
  const tokens = formatWorkflowTokens(view.totalTokens);
  const sideBySide = childNodeIds(view);
  const callerGlyph = <Glyph runtimeId={view.callerRuntimeId} label={view.callerRuntimeLabel} small />;

  // A chat this window does not hold (a remote run's raw id) opens nothing.
  const openNode = chatActions
    ? (nodeId: string, messageId?: string) => {
      if (chatActions.revealNode(nodeId, { messageId })) onClose();
    }
    : undefined;
  const replacingThread = replacing ? threads.find((thread) => thread.key === replacing.key) : undefined;
  const picker = replacingThread && commands && (
    // Inline, in the card's flow: the card clips, and the drawer scrolls.
    <div className="mm-dpick">
      <MultiModelModelPicker
        title={`Replace ${replacingThread.runtimeLabel} · ${replacingThread.modelLabel}`}
        ready={ready.state}
        onLoad={ready.load}
        current={replacingThread}
        taken={threads.filter((thread) => thread.key !== replacingThread.key)}
        onClose={closePicker}
        onPick={(pick) => {
          setReplacing(null);
          commands.replaceThread(replacingThread.key, pick);
        }}
      />
    </div>
  );
  const actions: CardActions = {
    openNode,
    rowActions: (thread) => threadActions(view, thread, options),
    thread: (key, command) => {
      if (commands) (command === 'stop' ? commands.stopThread : commands.retryThread)(key);
    },
    replace: (thread, place) => {
      setReplacing((open) => (open?.key === thread.key && open.place === place ? null : { key: thread.key, place }));
    },
    replacingAt: replacingThread ? replacing?.place : undefined,
    picker,
    answer: commands?.answer,
    busy: !!pending,
  };
  const retryRun = () => commands?.retryRun();
  const toggleRow = (id: string) => {
    setOpenRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const failed = failedThreads(threads);
  const firstFailed = failed[0];
  const firstError = firstFailed?.steps.find((step) => step.status === 'failed')?.error;
  const rows = (index: number) => threads.filter((thread) => thread.steps[index]);
  const stepRows = (index: number) => (
    <div style={{ marginTop: 6 }}>
      {rows(index).map((thread, position) => (
        <ThreadRow key={thread.key} run={run} thread={thread} index={index} first={position === 0} open={openRows.has(rowId(index, thread.key))} onToggle={toggleRow} now={now} actions={actions} />
      ))}
    </div>
  );
  const synthesis = view.synthesis;
  const note = synthesisNote(view);
  const addendum = addendumOutcome(view);
  // Run Retry sits by what it re-runs: a failed synthesis or addendum by the synthesis, failed rows on
  // their failure line, the rest of a stopped or interrupted run with the status under the title.
  const retryButton = (label = 'Retry') => retry && (
    <button type="button" disabled={retry.disabled} onClick={retryRun} className="mm-dlink">{label}</button>
  );
  const retryInFailureLine = retry?.target === 'rows' && !!firstFailed;
  const retryInStatus = !!retry && (retry.target === 'run' || (retry.target === 'rows' && !firstFailed));
  const detail = view.phase !== 'running' ? run.statusDetail : undefined;
  const synthesisBody = synthesis.status === 'completed'
    ? <p style={sdStyle}><span style={{ color: 'var(--term-digest)' }}>✓</span> Written to the chat</p>
    : synthesis.status === 'queued' || synthesis.status === 'running'
      ? <p style={sdStyle}>{callerGlyph} Writing the synthesis…</p>
      : note
        ? (
          <p style={{ ...sdStyle, display: 'flex', alignItems: 'baseline', gap: 8, color: note.tone === 'fail' ? 'var(--term-danger-text)' : 'var(--term-muted)' }}>
            {note.text}
            {retry?.target === 'synthesis' && retryButton()}
          </p>
        )
        : <p style={sdStyle}>{callerGlyph} Written by this chat ({view.callerModelLabel}) after reading every answer</p>;

  return (
    <article
      data-testid="background-workflow-row"
      data-background-work-key={rowKey}
      data-run-key={runKey}
      data-active={live ? 'true' : undefined}
      aria-label={`Multi-model ${run.name}, ${approvals.length > 0 ? 'needs approval' : runChip(run, view, now).label.toLowerCase()}`}
      className={WORK_CARD_CLASS}
      style={WORK_CARD}
    >
      {/* An open row's excerpt may be trimmed in the bulk snapshot: the full copy loads while one is open. */}
      {(expanded || openRows.size > 0) && <FullRun identity={identity} />}
      <div style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--term-mauve)', display: 'inline-flex' }}><ForkIcon style={ICON_STYLE} /></span>
            Multi-model · {branches(threads.length)}
          </span>
          <Chip run={run} view={view} now={now} />
        </div>
        <h3 data-testid="background-workflow-title" style={{ margin: '7px 0 0', fontSize: 'calc(var(--fs-xl) + 1px)', fontWeight: 600, lineHeight: 1.3, color: 'var(--term-fg)', overflowWrap: 'anywhere' }}>{run.name}</h3>
        {view.askPreview && <p style={{ margin: '4px 0 0', fontSize: 'var(--fs-md)', lineHeight: 1.55, color: 'var(--term-mid)' }}>{view.askPreview}</p>}
        {(detail || retryInStatus) && (
          <p data-testid="multi-model-status" style={{ margin: '8px 0 0', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 10px', fontSize: 'var(--fs-sm)' }}>
            {detail && <span style={{ color: view.phase === 'failed' ? 'var(--term-danger-text)' : 'var(--term-muted)' }}>{detail}</span>}
            {retryInStatus && retryButton(retry?.target === 'rows' && view.phase === 'completed' ? 'Retry failed' : 'Retry')}
          </p>
        )}
        {error && <p role="alert" style={{ margin: '8px 0 0', fontSize: 'var(--fs-sm)', color: 'var(--term-danger-text)' }}>{error}</p>}

        {approvals.length > 0 && (
          <div data-testid="workflow-approvals" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px', borderRadius: INNER_RADIUS, border: '1px solid color-mix(in srgb, var(--term-select) 45%, transparent)', background: 'color-mix(in srgb, var(--term-select-f) 70%, transparent)' }}>
            <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--term-select)' }}>Needs your approval</div>
            {approvals.map((approval) => <ApprovalLine key={approval.id} view={view} approval={approval} actions={actions} />)}
          </div>
        )}

        {firstFailed && (
          <div data-testid="multi-model-failed" style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: INNER_RADIUS, background: 'color-mix(in srgb, var(--term-danger) 11%, transparent)', fontSize: 'var(--fs-sm)', minWidth: 0 }}>
            <b style={{ fontWeight: 600, color: 'var(--term-danger-text)' }}>× {branches(failed.length)} failed</b>
            <span style={{ ...ellipsis, flex: 1, color: 'var(--term-mid)' }}>
              {failed.length === 1 ? `${firstFailed.runtimeLabel} · ${firstFailed.modelLabel}${firstError ? ` · ${firstError}` : ''}` : failed.map((thread) => thread.runtimeLabel).join(', ')}
            </span>
            {/* Run Retry re-runs every failed branch; one branch also has its own Replace model. */}
            {retryInFailureLine && retryButton('Retry failed')}
            {failed.length === 1 && <FixButtons thread={firstFailed} actions={actions} place="failed" link replaceOnly={retryInFailureLine} />}
          </div>
        )}
        {firstFailed && actions.replacingAt === 'failed' && picker}

        {/* Once written, the synthesis stays in view through late work and its addendum. */}
        {synthesis.status === 'completed' && (
          <div data-testid="multi-model-synthesis" style={{ marginTop: 12, padding: '10px 12px', borderRadius: INNER_RADIUS, border: '1px solid color-mix(in srgb, var(--term-digest) 30%, var(--term-line))', background: 'var(--term-surface)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--term-fg)' }}>
              {callerGlyph} Synthesis · {view.callerModelLabel}
              {openNode && (
                <button type="button" onClick={() => openNode(view.callerNodeId, synthesis.messageId)} className="mm-dlink is-dim" style={{ marginLeft: 'auto', fontWeight: 400 }}>View in chat ↗</button>
              )}
            </div>
            {synthesis.summary && <p style={{ margin: '6px 0 0', fontSize: 'var(--fs-lg)', lineHeight: 1.55, color: 'var(--term-mid)' }}>{synthesis.summary}</p>}
            {addendum && (
              <p data-testid="multi-model-addendum" style={{ margin: '6px 0 0', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 8px', fontSize: 'var(--fs-sm)', color: addendum.tone === 'fail' ? 'var(--term-danger-text)' : 'var(--term-muted)' }}>
                <span>{addendum.tone === 'ok' && <span style={{ color: 'var(--term-digest)' }}>✓ </span>}{addendum.text}</span>
                {addendum.tone === 'ok' && openNode && view.lastMessageId && (
                  <button type="button" onClick={() => openNode(view.callerNodeId, view.lastMessageId)} className="mm-dlink is-dim">View ↗</button>
                )}
                {retry?.target === 'addendum' && retryButton()}
              </p>
            )}
          </div>
        )}

        <ol aria-label="Steps" style={{ margin: '14px 0 0', padding: 0 }}>
          <Step state={states[0]} number={1} last={false} title="Answer separately"
            sub={<span style={subStyle}>{stepProgress(view, 0).label}</span>}>
            {stepRows(0)}
          </Step>
          {Array.from({ length: view.reviewRounds }, (_, offset) => {
            const index = offset + 1;
            const { started, label: progress } = stepProgress(view, index);
            // Two rounds are told apart by their number, before they start too.
            const round = view.reviewRounds > 1 ? `round ${index} of ${view.reviewRounds}` : undefined;
            const sub = started ? (round ? `${round} · ${progress}` : progress) : round;
            return (
              <Step key={index} state={states[index]} number={index + 1} last={false}
                title={view.reviewRounds === 1 ? 'Review once' : 'Review'}
                sub={<>{sub && <span style={subStyle}>{sub}</span>}{!started && <GlyphStack threads={threads} />}</>}>
                {started ? stepRows(index) : <p style={sdStyle}>Each branch reads the other answers and may revise its conclusion</p>}
              </Step>
            );
          })}
          <Step state={states[states.length - 1]} number={view.reviewRounds + 2} last title="Synthesis">
            {synthesisBody}
          </Step>
        </ol>

        {stopAll || (openNode && sideBySide.length > 0) || tokens ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {stopAll && commands && (
              <button type="button" disabled={stopAll.disabled} onClick={commands.stop} className="mm-dbtn">
                {pending === 'stop' ? 'Stop all…' : 'Stop all'}
              </button>
            )}
            {chatActions && openNode && sideBySide.length > 0 && (
              <button type="button" onClick={() => { chatActions.openPanesSideBySide(view.callerNodeId, sideBySide); onClose(); }} className="mm-dbtn">
                <ColumnsIcon style={ICON_STYLE} /> Side by side
              </button>
            )}
            {tokens && <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{tokens}</span>}
          </div>
        ) : null}
      </div>
      <div style={{ padding: '9px 16px', borderTop: '1px solid var(--term-line)', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
        {view.callerModelLabel} started · {branches(threads.length)} · Same permissions as this chat ({permissionText(view)})
      </div>
    </article>
  );
});
