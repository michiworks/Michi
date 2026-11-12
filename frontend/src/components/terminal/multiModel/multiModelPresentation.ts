import {
  MULTI_MODEL_STEP_IN_FLIGHT,
  MULTI_MODEL_STEP_RETRYABLE,
  WORKFLOW_LIMITS,
  multiModelLatestRunIndex,
  multiModelLeafId,
  multiModelStepsInFlight,
  parseMultiModelLeafId,
  multiModelStepsReplaceable,
  multiModelStepsRetryable,
  type MultiModelRunView,
  type MultiModelStepKind,
  type MultiModelStepStatus,
  type MultiModelStepView,
  type MultiModelThreadView,
  type WorkflowApprovalDto,
  type WorkflowRunDtoV1,
} from 'michi-shared';
import { formatDuration as formatLength } from '../../../lib/duration';
import { WORKFLOW_CHIP, WORKFLOW_NEEDS_YOU_CHIP } from '../workflows/workflowPresentation';

/**
 * Pure presentation of a multi-model run (MultiModelRunView) for the in-chat
 * card and the Background work drawer: glyphs, step and row labels, the
 * step circles, collapsed step summaries, the run's chip and late work, and
 * the one action model both cards draw their controls from (runActions,
 * threadActions: the backend's rules). Imports only shared code and the
 * workflow chip's colours.
 */

export interface RuntimeGlyph {
  letter: string;
  color: string;
}

/** One letter per runtime, on theme tokens. */
export const RUNTIME_GLYPH: Record<string, RuntimeGlyph> = {
  claude: { letter: 'C', color: 'var(--term-accent)' },
  codex: { letter: 'X', color: 'var(--term-fg)' },
  kiro: { letter: 'K', color: 'var(--term-mauve)' },
  crew: { letter: 'K', color: 'var(--term-muted)' },
  pi: { letter: 'π', color: 'var(--term-digest)' },
  antigravity: { letter: 'A', color: 'var(--term-run)' },
};

/** The runtime's glyph; another runtime gets its label's first letter. */
export function runtimeGlyph(runtimeId: string, label: string): RuntimeGlyph {
  return RUNTIME_GLYPH[runtimeId] ?? { letter: (label.trim().charAt(0) || '?').toUpperCase(), color: 'var(--term-mid)' };
}

/** The statuses a row's Retry re-runs are the ones that ended without an answer. */
const ENDED_WITHOUT_ANSWER = MULTI_MODEL_STEP_RETRYABLE;
/** A row's step that ended without an answer, skipped included: Retry and Replace model sit there. */
export const ENDED_ROW: ReadonlySet<MultiModelStepStatus> = new Set([...MULTI_MODEL_STEP_RETRYABLE, 'skipped']);
/** What run Retry re-runs: not a row the user stopped. */
const RERUNNABLE: ReadonlySet<string> = new Set(['failed', 'cancelled', 'interrupted']);
/** Ended without an answer and not failed: the step circle shows a neutral stop. */
const STOPPED: ReadonlySet<MultiModelStepStatus> = new Set(['stopped', 'cancelled', 'interrupted']);

const ANSWER_LABEL: Record<MultiModelStepStatus, string> = {
  pending: 'Waiting',
  queued: 'Queued',
  running: 'Answering',
  waiting: 'Needs you',
  completed: 'Answered',
  failed: 'Failed',
  stopped: 'Stopped',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

const REVIEW_LABEL: Record<MultiModelStepStatus, string> = { ...ANSWER_LABEL, running: 'Reviewing', completed: 'Revised' };

/** A row's status word: "Answering", "Revised", "Needs you", … */
export function stepLabel(kind: MultiModelStepKind, status: MultiModelStepStatus): string {
  return (kind === 'review' ? REVIEW_LABEL : ANSWER_LABEL)[status];
}

export type StepTone = 'ok' | 'run' | 'wait' | 'fail' | 'stop' | 'skip' | 'idle';

/** A row's icon: `dot` renders the live dot (breathing while running). Intentional stops are not errors. */
export function stepIcon(status: MultiModelStepStatus): { icon: '✓' | '✕' | '–' | '○' | '■' | 'dot'; tone: StepTone } {
  switch (status) {
    case 'completed': return { icon: '✓', tone: 'ok' };
    case 'running': return { icon: 'dot', tone: 'run' };
    case 'waiting': return { icon: 'dot', tone: 'wait' };
    case 'failed': return { icon: '✕', tone: 'fail' };
    case 'stopped':
    case 'cancelled':
    case 'interrupted': return { icon: '■', tone: 'stop' };
    case 'skipped': return { icon: '–', tone: 'skip' };
    case 'pending':
    case 'queued': return { icon: '○', tone: 'idle' };
  }
}

/** "48s", "1m 12s", "1h 5m", in whole seconds as a live clock counts them. */
export function formatDuration(ms: number): string {
  return formatLength(ms, { live: true });
}

/** How long a row's step has run (or ran); undefined before it began. */
export function threadElapsed(step: Pick<MultiModelStepView, 'startedAt' | 'endedAt'> | undefined, now: number): number | undefined {
  if (step?.startedAt === undefined) return undefined;
  return Math.max(0, (step.endedAt ?? now) - step.startedAt);
}

/** The chat's permission mode as the cards say it. */
export function permissionText(view: Pick<MultiModelRunView, 'permissionMode' | 'approveForMe'>): string {
  if (view.permissionMode === 'trust') return 'Trust';
  if (view.permissionMode === 'yolo') return 'YOLO';
  return view.approveForMe ? 'Ask · Approve for me' : 'Ask';
}

/** Rows the user did not remove. */
export function liveThreads(view: Pick<MultiModelRunView, 'threads'>): MultiModelThreadView[] {
  return view.threads.filter((thread) => !thread.removed);
}

/** The live rows' current branch nodes, in plan order (for Side by side). */
export function childNodeIds(view: Pick<MultiModelRunView, 'threads'>): string[] {
  return liveThreads(view).flatMap((thread) => (thread.childNodeId ? [thread.childNodeId] : []));
}

function statusesAt(view: MultiModelRunView, step: number): MultiModelStepStatus[] {
  return liveThreads(view).flatMap((thread) => (thread.steps[step] ? [thread.steps[step].status] : []));
}

/** `stopped`: ended without an answer, not by a failure (an intentional stop is not an error). */
export type StepState = 'done' | 'running' | 'idle' | 'failed' | 'stopped';

/** The step circles: one per answer/review step, then the synthesis. */
export function stepStates(view: MultiModelRunView): StepState[] {
  const steps = Array.from({ length: 1 + view.reviewRounds }, (_, step): StepState => {
    if (view.phase === 'proposed') return 'idle';
    const statuses = statusesAt(view, step);
    if (statuses.some((status) => MULTI_MODEL_STEP_IN_FLIGHT.has(status))) return 'running';
    if (statuses.includes('completed')) return 'done';
    if (statuses.includes('failed')) return 'failed';
    if (statuses.some((status) => STOPPED.has(status))) return 'stopped';
    return 'idle';
  });
  const synthesis = view.synthesis.status;
  const last: StepState = synthesis === 'queued' || synthesis === 'running' ? 'running'
    : synthesis === 'completed' ? 'done'
      : synthesis === 'failed' ? 'failed'
        : synthesis === 'cancelled' || synthesis === 'interrupted' ? 'stopped'
          : 'idle';
  return [...steps, last];
}

/**
 * The step the card opens: while running, the current one (the first step
 * with a row in flight, else the synthesis once it runs); on a run that was
 * interrupted, failed or cancelled, the last step a row did not finish (where
 * its Retry is); on a finished run, the last step with an answered row (so a
 * run whose reviews were all skipped opens the answer step); else the answer step.
 */
export function defaultOpenStep(view: MultiModelRunView): number {
  const rounds = view.reviewRounds;
  if (view.phase === 'running') {
    for (let step = 0; step <= rounds; step += 1) {
      if (statusesAt(view, step).some((status) => MULTI_MODEL_STEP_IN_FLIGHT.has(status))) return step;
    }
    if (view.synthesis.status === 'queued' || view.synthesis.status === 'running') return rounds + 1;
  }
  if (view.phase === 'interrupted' || view.phase === 'failed' || view.phase === 'cancelled') {
    for (let step = rounds; step >= 0; step -= 1) {
      if (statusesAt(view, step).some((status) => ENDED_WITHOUT_ANSWER.has(status))) return step;
    }
  }
  for (let step = rounds; step >= 0; step -= 1) {
    if (statusesAt(view, step).includes('completed')) return step;
  }
  return 0;
}

export interface SummaryPart {
  text: string;
  tone?: 'select' | 'run' | 'danger';
}

export function branches(count: number): string {
  return `${count} ${count === 1 ? 'branch' : 'branches'}`;
}

/** The rows that took part in a review: neither skipped nor still pending. */
function tookPart(status: MultiModelStepStatus): boolean {
  return status !== 'skipped' && status !== 'pending';
}

/**
 * A step's header count: answered (revised) of the rows that took part,
 * "Skipped" for a review none took part in; `started` once a row of a
 * review left pending (the answer step has started with the run).
 */
export function stepProgress(view: MultiModelRunView, step: number): { started: boolean; label: string } {
  const statuses = statusesAt(view, step);
  const done = statuses.filter((status) => status === 'completed').length;
  if (step === 0) return { started: true, label: `${done}/${statuses.length} done` };
  const of = statuses.filter(tookPart).length;
  return { started: statuses.some((status) => status !== 'pending'), label: of === 0 ? 'Skipped' : `${done}/${of} done` };
}

function liveSummary(thread: MultiModelThreadView, status: MultiModelStepStatus, review: boolean): SummaryPart | null {
  const who = thread.runtimeLabel;
  switch (status) {
    case 'waiting': return { text: `${who} waits for your approval`, tone: 'select' };
    case 'queued':
    case 'running': return { text: `${who} ${review ? 'reviewing' : 'answering'}`, tone: 'run' };
    case 'completed': return { text: `${who} ${review ? 'revised' : 'answered'}` };
    case 'failed': return { text: `${who} failed`, tone: 'danger' };
    case 'stopped':
    case 'cancelled':
    case 'interrupted': return { text: `${who} stopped` };
    case 'pending':
    case 'skipped': return null;
  }
}

/** A collapsed step's one line, as parts joined with " · " (a part's tone colors it). */
export function collapsedSummary(view: MultiModelRunView, step: number): SummaryPart[] {
  const review = step > 0;
  const rows = liveThreads(view).flatMap((thread) => (thread.steps[step] ? [{ thread, status: thread.steps[step].status }] : []));
  if (rows.some((row) => MULTI_MODEL_STEP_IN_FLIGHT.has(row.status))) {
    return rows.flatMap((row) => { const part = liveSummary(row.thread, row.status, review); return part ? [part] : []; });
  }
  const failed = rows.filter((row) => row.status === 'failed').map((row): SummaryPart => ({ text: `${row.thread.runtimeLabel} failed`, tone: 'danger' }));
  const count = (statuses: readonly MultiModelStepStatus[]) => rows.filter((row) => statuses.includes(row.status)).length;
  // Rows that ended without an answer and were not the branch's fault: Retry picks them up.
  const unfinished: SummaryPart[] = [
    ...(count(['interrupted']) ? [{ text: `${count(['interrupted'])} interrupted` }] : []),
    ...(count(['stopped', 'cancelled']) ? [{ text: `${count(['stopped', 'cancelled'])} stopped` }] : []),
  ];
  const done = count(['completed']);
  if (!review) {
    return [{ text: branches(liveThreads(view).length) }, { text: `${done} answered` }, ...unfinished, ...failed];
  }
  const took = rows.filter((row) => tookPart(row.status)).length;
  // Rows still pending will review: the round is not down to one answer.
  if (took <= 1 && !rows.some((row) => row.status === 'pending')) {
    // What the review had to read: the rows with an answer from an earlier step.
    const answers = rows.filter((row) => row.thread.steps.slice(0, step).some((earlier) => earlier.status === 'completed')).length;
    return [{ text: 'Skipped' }, { text: answers === 0 ? 'no answers' : 'only one answer' }];
  }
  if (done === took) return [{ text: `${branches(took)} read each other's answers and revised their conclusions` }];
  return [{ text: branches(took) }, { text: `${done} revised` }, ...unfinished, ...failed];
}

/** The approval of one row (its step's leaf, multiModelLeafId); one approval attaches to exactly one row. */
export function approvalForRow(run: Pick<WorkflowRunDtoV1, 'approvals'>, key: string, step: number): WorkflowApprovalDto | undefined {
  return run.approvals?.find((approval) => approval.nodeId === multiModelLeafId(key, step));
}

/** The row an approval belongs to (approvalForRow's inverse). */
export function threadOfApproval(view: Pick<MultiModelRunView, 'threads'>, approval: Pick<WorkflowApprovalDto, 'nodeId'>): MultiModelThreadView | undefined {
  const leaf = approval.nodeId ? parseMultiModelLeafId(approval.nodeId) : null;
  return leaf ? view.threads.find((thread) => thread.key === leaf.key) : undefined;
}

export type ChipTone = 'run' | 'ok' | 'fail' | 'stop' | 'wait';

export interface RunChip {
  label: string;
  tone: ChipTone;
  time?: string;
}

/** Each chip tone in the workflow chip's colour and fill. */
export const RUN_CHIP_COLOR: Record<ChipTone, { color: string; fill: string }> = {
  run: WORKFLOW_CHIP.running,
  ok: WORKFLOW_CHIP.completed,
  fail: WORKFLOW_CHIP.failed,
  stop: WORKFLOW_CHIP.cancelled,
  wait: WORKFLOW_NEEDS_YOU_CHIP,
};

/**
 * The run's chip (copy table 5.6), in RUN_CHIP_COLOR: Running with the time
 * since Start, late work with the time since it began, Done with how long
 * the run took to its synthesis, else how it ended.
 */
export function runChip(run: Pick<WorkflowRunDtoV1, 'startedAt' | 'endedAt' | 'updatedAt'>, view: MultiModelRunView, now: number): RunChip {
  const startedAt = view.startedAt ?? run.startedAt;
  switch (view.phase) {
    case 'running': {
      const late = lateWork(view);
      if (!late) return { label: 'Running', tone: 'run', time: formatDuration(now - startedAt) };
      const chip: RunChip = { label: lateWorkLabel(late), tone: 'run' };
      if (late.since !== undefined) chip.time = formatDuration(now - late.since);
      return chip;
    }
    case 'completed': return { label: 'Done', tone: 'ok', time: formatDuration((view.synthesis.endedAt ?? run.endedAt ?? run.updatedAt) - startedAt) };
    case 'failed': return { label: 'Failed', tone: 'fail' };
    case 'interrupted': return { label: 'Interrupted', tone: 'stop' };
    case 'cancelled': return { label: view.startedAt === undefined ? 'Cancelled' : 'Stopped', tone: 'stop' };
    case 'proposed': return { label: 'Needs you', tone: 'wait' };
  }
}

const RUN_TITLE = /^(Approve\s+)?(Bash|execute_bash|shell|run_command|Running\b|Run\b)/i;
const EDIT_TITLE = /^(Approve\s+)?(Edit|Write|MultiEdit|fs_write|apply_patch|edit|write)\b/i;
/** Pi's shell titles ("Run: wc -l README.md"); the row's kind word already says Run. */
const RUN_PREFIX = /^Run:\s*/i;
/** Programs a bare shell command title (Kiro's: "wc -l README.md") starts with. */
const SHELL_PROGRAMS = new Set([
  'awk', 'bash', 'bun', 'cargo', 'cat', 'cd', 'chmod', 'cp', 'curl', 'deno', 'diff', 'docker', 'du', 'echo', 'env', 'find',
  'gh', 'git', 'go', 'grep', 'head', 'jq', 'kubectl', 'less', 'ls', 'make', 'mkdir', 'mv', 'node', 'npm', 'npx', 'pip',
  'pip3', 'pnpm', 'pwd', 'pytest', 'python', 'python3', 'rg', 'rm', 'sed', 'sh', 'sort', 'stat', 'tail', 'tar', 'touch',
  'tree', 'uniq', 'wc', 'which', 'xargs', 'yarn', 'zsh',
]);
/** A lowercase program, or a path to one. */
const PROGRAM = /^(?:\.{0,2}\/)?[a-z][\w.+/-]*$/;
/** A flag, pipe, redirect or chain among a command's arguments. */
const SHELL_SYNTAX = /(?:^|\s)(?:--?\w|\||&&|;|>>?)/;

/** A title that is the shell command itself, as Kiro gives it. */
function isBareCommand(title: string): boolean {
  const [program = '', ...args] = title.trim().split(/\s+/);
  if (!PROGRAM.test(program)) return false;
  return SHELL_PROGRAMS.has(program.slice(program.lastIndexOf('/') + 1)) || SHELL_SYNTAX.test(args.join(' '));
}

/** The approval row's first word: "Run" for shell commands, "Edit" for file edits, else "Allow". */
export function approvalKindWord(approval: Pick<WorkflowApprovalDto, 'title'>): 'Run' | 'Edit' | 'Allow' {
  if (RUN_TITLE.test(approval.title)) return 'Run';
  if (EDIT_TITLE.test(approval.title)) return 'Edit';
  if (isBareCommand(approval.title)) return 'Run';
  return 'Allow';
}

/**
 * What the approval row shows after its kind word: the request's detail, else
 * its title (Pi's tool approvals carry none), without Pi's leading "Run: ".
 */
export function approvalText(approval: Pick<WorkflowApprovalDto, 'title' | 'detail'>): string {
  if (approval.detail) return approval.detail;
  return approval.title.replace(RUN_PREFIX, '').trim();
}

/** parseApprovals cuts details at WORKFLOW_LIMITS.prompt chars (shared/src/workflowRuns.ts). */
const CLAMPED_DETAIL = WORKFLOW_LIMITS.prompt - 1;

/** A multi-line or clamped request (its approvalText) is checked in the branch, not on the card. */
export function isLongApproval(approval: Pick<WorkflowApprovalDto, 'title' | 'detail'>): boolean {
  const text = approvalText(approval);
  return text.includes('\n') || text.length >= CLAMPED_DETAIL;
}

/**
 * The row's last step that ran (neither pending nor skipped), or -1: the
 * step its Retry re-runs.
 */
export function latestRunIndex(thread: Pick<MultiModelThreadView, 'steps'>): number {
  return multiModelLatestRunIndex(thread.steps);
}

function latestRunStep(thread: Pick<MultiModelThreadView, 'steps'>): MultiModelStepView | undefined {
  return thread.steps[latestRunIndex(thread)];
}

/**
 * Retry applies: the latest step that ran failed, was stopped, cancelled or interrupted.
 * Skipped reviews after a failed answer do not count, as in the backend's retryThread.
 * A review of a deleted branch cannot run again (only Replace model applies).
 */
export function isThreadRetryable(thread: MultiModelThreadView): boolean {
  if (thread.removed || !multiModelStepsRetryable(thread.steps)) return false;
  return !thread.branchGone || latestRunIndex(thread) === 0;
}

/** Replace model applies where the row's last run step ended without an answer (never after a completed step). */
export function isThreadReplaceable(thread: MultiModelThreadView): boolean {
  return !thread.removed && multiModelStepsReplaceable(thread.steps);
}

/**
 * A row's Retry and Replace model wait: the run was stopped and its turns
 * are still settling, which the backend refuses (reopenForRetry). A running
 * run is always settling and accepts them.
 */
export function rowCommandsWait(view: Pick<MultiModelRunView, 'settling' | 'phase'>): boolean {
  return !!view.settling && view.phase !== 'running';
}

/** Stop applies: a step of the row is queued, running or waiting. */
export function isThreadStoppable(thread: MultiModelThreadView): boolean {
  return !thread.removed && multiModelStepsInFlight(thread.steps);
}

/** A step that is queued, running or waiting: its row's Stop sits there. */
export function isStepInFlight(status: MultiModelStepStatus): boolean {
  return MULTI_MODEL_STEP_IN_FLIGHT.has(status);
}

/**
 * Whether row `step` of a thread carries the thread's Retry and Replace
 * model: its last run step, and the steps skipped after it (a failed answer
 * is skipped in review).
 */
export function fixesAtStep(thread: Pick<MultiModelThreadView, 'steps'>, step: number): boolean {
  const ran = latestRunIndex(thread);
  return ran >= 0 && (step === ran || (step > ran && thread.steps[step]?.status === 'skipped'));
}

// ─── the action model ───────────────────────────────────────────────────
// Both cards and a branch's Retry draw every run and row control from
// these, on the backend's rules (routes/multiModelRuns.ts answers a 409
// otherwise).

/** A control a card shows, and whether it waits. */
interface Control {
  disabled: boolean;
}

export interface ActionOptions {
  /** No plan or run controls (a Scheduled-only transcript, an archived thread); approvals stay answerable. */
  readOnly?: boolean;
  /** A command of the run is in flight: every control waits. */
  busy?: boolean;
}

/**
 * What run Retry re-runs, which says where a card puts it: a failed
 * synthesis or addendum (in the synthesis step), the rest of a stopped or
 * interrupted run (under the title), or the failed rows of a run that
 * finished without them (with the failure).
 */
type RunRetryTarget = 'synthesis' | 'addendum' | 'run' | 'rows';

interface RunActions {
  /** Stop all: the run is running. */
  stopAll?: Control;
  retry?: Control & { target: RunRetryTarget };
}

export interface ThreadActions {
  /** A step is in flight (queued rows too). */
  stop?: Control;
  /** isThreadRetryable. */
  retry?: Control;
  /** isThreadReplaceable: where Retry applies (and on a deleted branch's review), never after a completed step. */
  replace?: Control;
}

function runRetryTarget(view: MultiModelRunView): RunRetryTarget | null {
  // A cancelled proposal was never started: nothing to retry.
  if (view.startedAt === undefined) return null;
  const { phase, synthesis } = view;
  if (phase === 'failed') return synthesis.status === 'failed' ? 'synthesis' : 'rows';
  if (phase === 'cancelled' || phase === 'interrupted') return 'run';
  if (phase !== 'completed') return null;
  if (synthesis.lastAddendumStatus && RERUNNABLE.has(synthesis.lastAddendumStatus)) return 'addendum';
  // The backend's rerunnable(): not a row the user stopped, nor a deleted branch's review.
  const rerunnable = liveThreads(view).some((thread) => {
    const last = latestRunStep(thread);
    return !!last && RERUNNABLE.has(last.status) && (!thread.branchGone || latestRunIndex(thread) === 0);
  });
  return rerunnable ? 'rows' : null;
}

/** The run's controls: Stop all while it runs, Retry once it ended with something to re-run. */
export function runActions(view: MultiModelRunView, options: ActionOptions = {}): RunActions {
  if (options.readOnly) return {};
  const actions: RunActions = {};
  const busy = !!options.busy;
  if (view.phase === 'running') actions.stopAll = { disabled: busy };
  const target = runRetryTarget(view);
  if (target) actions.retry = { disabled: busy || rowCommandsWait(view), target };
  return actions;
}

/** A row's controls: Stop while a step is in flight, else Retry and Replace model after a step that ended without an answer. */
export function threadActions(view: MultiModelRunView, thread: MultiModelThreadView, options: ActionOptions = {}): ThreadActions {
  if (options.readOnly || thread.removed) return {};
  const busy = !!options.busy;
  if (isThreadStoppable(thread)) return { stop: { disabled: busy } };
  const wait = busy || rowCommandsWait(view);
  const actions: ThreadActions = {};
  if (isThreadRetryable(thread)) actions.retry = { disabled: wait };
  if (isThreadReplaceable(thread)) actions.replace = { disabled: wait };
  return actions;
}

// ─── late work, the synthesis step ──────────────────────────────────────

const answersText = (count: number) => `${count} late ${count === 1 ? 'answer' : 'answers'}`;

interface LateWork {
  /** Late rows answering now; 0 while the addendum is written. */
  answering: number;
  /** When the late work began, for its timer. */
  since?: number;
}

/**
 * Work after the synthesis was written: rows retried or replaced late, then
 * the addendum that adds their answers. Null unless the run is running with
 * its synthesis written.
 */
export function lateWork(view: MultiModelRunView): LateWork | null {
  if (view.phase !== 'running' || view.synthesis.status !== 'completed') return null;
  const late = liveThreads(view).filter((thread) => thread.late);
  const answering = late.flatMap((thread) => thread.steps.filter((step) => MULTI_MODEL_STEP_IN_FLIGHT.has(step.status)));
  // While they answer, the first of them to start; while the addendum is written, the latest late row's start.
  const ran = late.flatMap((thread) => latestRunStep(thread) ?? []);
  const starts = (answering.length > 0 ? answering : ran).flatMap((step) => (step.startedAt === undefined ? [] : [step.startedAt]));
  const result: LateWork = { answering: answering.length };
  if (starts.length > 0) result.since = answering.length > 0 ? Math.min(...starts) : Math.max(...starts);
  return result;
}

/** "Adding 1 late answer", or "Adding to the synthesis" once they answered. */
function lateWorkLabel(late: LateWork): string {
  return late.answering > 0 ? `Adding ${answersText(late.answering)}` : 'Adding to the synthesis';
}

interface Outcome {
  text: string;
  tone: 'ok' | 'fail' | 'stop';
}

/** How the last addendum went once the late work is over: added, failed or stopped; null without one or while it runs. */
export function addendumOutcome(view: MultiModelRunView): Outcome | null {
  const status = view.synthesis.lastAddendumStatus;
  if (!status || view.phase === 'running' || view.synthesis.status !== 'completed') return null;
  const count = liveThreads(view).filter((thread) => thread.late && latestRunStep(thread)?.status === 'completed').length;
  const answers = count === 0 ? 'the late answers' : answersText(count);
  if (status === 'completed') return { text: `Added ${answers} to the synthesis`, tone: 'ok' };
  if (status === 'cancelled') return { text: `Stopped adding ${answers}`, tone: 'stop' };
  if (status === 'failed' || status === 'interrupted') return { text: `Couldn't add ${answers}`, tone: 'fail' };
  return null;
}

/**
 * What the synthesis step says when the synthesis is neither written nor
 * being written: what happened to it. Null while it is still to come (the
 * card then says who writes it).
 */
export function synthesisNote(view: MultiModelRunView): { text: string; tone: 'fail' | 'quiet' } | null {
  switch (view.synthesis.status) {
    case 'completed':
    case 'queued':
    case 'running': return null;
    case 'failed': return { text: "Couldn't write the synthesis", tone: 'fail' };
    case 'cancelled': return { text: 'Stopped while writing the synthesis', tone: 'quiet' };
    case 'interrupted': return { text: 'Interrupted while writing the synthesis', tone: 'quiet' };
    case 'pending':
    case 'skipped': break;
  }
  switch (view.phase) {
    case 'failed': {
      const answered = liveThreads(view).some((thread) => thread.steps.some((step) => step.status === 'completed'));
      return { text: answered ? 'Not written' : 'Not written: no branch answered', tone: 'quiet' };
    }
    case 'cancelled': return { text: 'Not written: the run was stopped', tone: 'quiet' };
    case 'interrupted': return { text: 'Not written: the run was interrupted', tone: 'quiet' };
    default: return null;
  }
}
