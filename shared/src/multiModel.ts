/**
 * Multi-model runs: a chat agent proposes asking 1-5 other runtimes/models
 * the same question in parallel branches, with 0-2 review rounds in which
 * each branch reads the others' answers, then a synthesis in the chat that
 * proposed it. The user edits the plan's models and presses Start; the
 * backend (services/multiModel/) runs the rest.
 *
 * The run's UI snapshot is a workflow run with runtime 'michi'
 * (workflowRuns.ts); `MultiModelRunView` is the part both cards render.
 * This module imports nothing from workflowRuns.ts, which imports it.
 */
import { isChatPermissionMode, type ChatPermissionMode } from './chatPermissions';
import { clampText } from './text';

export const MULTI_MODEL_PHASES = ['proposed', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export const MULTI_MODEL_STEP_STATUSES = [
  'pending', 'queued', 'running', 'waiting', 'completed', 'failed', 'stopped', 'skipped', 'cancelled', 'interrupted',
] as const;
export const MULTI_MODEL_SYNTHESIS_STATUSES = [
  'pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'interrupted',
] as const;
export type MultiModelPhase = typeof MULTI_MODEL_PHASES[number];
export type MultiModelContext = 'fork' | 'fresh';
export type MultiModelStepKind = 'answer' | 'review';
export type MultiModelStepStatus = typeof MULTI_MODEL_STEP_STATUSES[number];
export type MultiModelSynthesisStatus = typeof MULTI_MODEL_SYNTHESIS_STATUSES[number];
export type MultiModelPermissionMode = ChatPermissionMode;

/** A step that is queued, running or waiting on the user: Stop applies. */
export const MULTI_MODEL_STEP_IN_FLIGHT: ReadonlySet<MultiModelStepStatus> = new Set(['queued', 'running', 'waiting']);
/** A step that ended without an answer: a row's Retry runs it again. */
export const MULTI_MODEL_STEP_RETRYABLE: ReadonlySet<MultiModelStepStatus> = new Set(['failed', 'stopped', 'cancelled', 'interrupted']);
/** A synthesis or addendum that ended without a reply: the run's Retry writes it again. */
export const MULTI_MODEL_SYNTHESIS_RETRYABLE: ReadonlySet<MultiModelSynthesisStatus> = new Set(['failed', 'cancelled', 'interrupted']);

type StatusSteps = ReadonlyArray<{ status: MultiModelStepStatus }>;

/**
 * The last step that ran (neither pending nor skipped), or -1. Skipped
 * steps only ever follow a row's last run step (a row that missed a round
 * misses every later one), so this is what Retry re-runs and what explains the row.
 */
export function multiModelLatestRunIndex(steps: StatusSteps): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const { status } = steps[index];
    if (status !== 'pending' && status !== 'skipped') return index;
  }
  return -1;
}

/** A step of the row is queued, running or waiting. */
export function multiModelStepsInFlight(steps: StatusSteps): boolean {
  return steps.some((step) => MULTI_MODEL_STEP_IN_FLIGHT.has(step.status));
}

/** Nothing runs and the latest step that ran ended without an answer (the status-only part of retryThread's rule). */
export function multiModelStepsRetryable(steps: StatusSteps): boolean {
  const index = multiModelLatestRunIndex(steps);
  return !multiModelStepsInFlight(steps) && index >= 0 && MULTI_MODEL_STEP_RETRYABLE.has(steps[index].status);
}

/**
 * Retry's rule: a row whose last run step completed (an answer whose reviews
 * were skipped, say) keeps it, so Replace model never discards an answer.
 */
export function multiModelStepsReplaceable(steps: StatusSteps): boolean {
  return multiModelStepsRetryable(steps);
}

export const MULTI_MODEL_LIMITS = {
  threads: 5,          // live (non-removed) rows
  rows: 8,             // live + removed rows kept for Undo
  reviewRounds: 2,
  prompt: 8_000,       // tool argument
  promptPreview: 4_000,
  title: 120,
  ask: 400,
  label: 80,
  summary: 280,
  error: 400,
  now: 160,
  excerpt: 1_200,
  notice: 200,
  statusDetail: 400,
} as const;

export interface MultiModelStepView {
  kind: MultiModelStepKind;
  /** 0 for the answer, 1..reviewRounds for review rounds. */
  round: number;
  status: MultiModelStepStatus;
  attempt?: number;
  turnId?: string;
  startedAt?: number;
  endedAt?: number;
  /** One-line summary of the answer (summarizeReply), when completed. */
  summary?: string;
  /** Why it failed or was skipped. */
  error?: string;
  /** Live activity line while running ("Running rg -n …", "Writing the answer"). */
  now?: string;
  /** Completed: the first 1200 visible chars of the step's answer. Running/waiting: the last 1200 visible chars
   *  streamed so far (live, from LiveRunExtras). For the drawer's expanded row. */
  excerpt?: string;
  /** Something the user should know about how the step went, though it did not fail
   *  (e.g. an approval waited too long and the runtime denied it automatically). */
  notice?: string;
}

export interface MultiModelThreadView {
  /** Stable plan key: "t1".."t5" from the agent, "a1".. for rows the user added. */
  key: string;
  runtimeId: string;
  providerId: string | null;
  modelId: string | null;
  reasoning: string | null;
  /** "Codex", "Kiro Crew", "Pi" (runtime label without a parenthetical). */
  runtimeLabel: string;
  /** Catalog label, else the model id, else "Default model". */
  modelLabel: string;
  context: MultiModelContext;
  promptPreview: string;
  /** Proposed only: removed by the user, shown struck through with Undo. */
  removed?: true;
  addedByUser?: true;
  childNodeId: string | null;
  /** Earlier child nodes of this row (replaced models). */
  previousChildNodeIds?: string[];
  /** steps[0] answer, steps[1..reviewRounds] review rounds; [] while proposed. */
  steps: MultiModelStepView[];
  /** A late retry or replacement after the run moved on. */
  late?: true;
  /** The branch was deleted or archived: a review cannot run again there; Replace model (or Retry of the answer) opens a new one. */
  branchGone?: true;
}

export interface MultiModelSynthesisView {
  status: MultiModelSynthesisStatus;
  turnId?: string;
  /** `self-<callerNodeId>-<turnId>`: the synthesis reply in the caller. */
  messageId?: string;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  /** Addendum turns written after late answers. */
  addenda?: number;
  /** Status of the last addendum, when one exists. */
  lastAddendumStatus?: MultiModelSynthesisStatus;
}

export interface MultiModelRunView {
  version: 1;
  phase: MultiModelPhase;
  title: string;
  /** The user's message that asked (start of it). */
  askPreview: string;
  callerNodeId: string;
  /** Assistant message holding the propose call (placement, drawer history rule). */
  callerMessageId: string | null;
  callerRuntimeId: string;
  callerRuntimeLabel: string;
  callerModelLabel: string;
  permissionMode: MultiModelPermissionMode;
  approveForMe?: true;
  reviewRounds: 0 | 1 | 2;
  threads: MultiModelThreadView[];
  synthesis: MultiModelSynthesisView;
  /** Sum of usage_summary.totalTokens over the run's turns, when reported. */
  totalTokens?: number;
  /** When Start was pressed; absent for a plan that was never started (proposed, or a cancelled proposal). */
  startedAt?: number;
  /** The latest caller message the run wrote (synthesis or addendum reply), for the drawer's latest-turn rule. */
  lastMessageId?: string;
  /** Turns of this run are still open (e.g. cancels settling after Stop all): run Retry is disabled. */
  settling?: true;
}

/**
 * The workflow node of one row's step (`<key>@<step>`, step as in `steps`),
 * which its approval's `nodeId` also names.
 */
export function multiModelLeafId(key: string, step: number): string {
  return `${key}@${step}`;
}

/** The workflow node of the synthesis in the caller. */
export const MULTI_MODEL_SYNTHESIS_LEAF_ID = 'synthesis@caller';

/** The row and step a multiModelLeafId names; null for any other node, the synthesis included. */
export function parseMultiModelLeafId(id: string): { key: string; step: number } | null {
  const match = /^(.+)@(\d+)$/.exec(id);
  return match ? { key: match[1], step: Number(match[2]) } : null;
}

// ---- Parsing (untrusted JSON from the network or the database) ----------

const PHASES: ReadonlySet<MultiModelPhase> = new Set(MULTI_MODEL_PHASES);
const CONTEXTS = new Set<MultiModelContext>(['fork', 'fresh']);
const STEP_KINDS = new Set<MultiModelStepKind>(['answer', 'review']);
const STEP_STATUSES: ReadonlySet<MultiModelStepStatus> = new Set(MULTI_MODEL_STEP_STATUSES);
const SYNTHESIS_STATUSES: ReadonlySet<MultiModelSynthesisStatus> = new Set(MULTI_MODEL_SYNTHESIS_STATUSES);
const PREVIOUS_CHILDREN_MAX = 8;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strOrNull(value: unknown): string | null {
  return str(value) ?? null;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function enumOf<T extends string>(set: ReadonlySet<T>, value: unknown, fallback: T): T {
  return set.has(value as T) ? value as T : fallback;
}

function reviewRoundsOf(value: unknown): 0 | 1 | 2 {
  const n = num(value);
  if (n === undefined) return 0;
  return Math.min(MULTI_MODEL_LIMITS.reviewRounds, Math.max(0, Math.trunc(n))) as 0 | 1 | 2;
}

function parseStep(value: unknown, index: number): MultiModelStepView | null {
  const raw = record(value);
  if (!raw) return null;
  const round = Number.isSafeInteger(raw.round) && (raw.round as number) >= 0 ? raw.round as number : index;
  const step: MultiModelStepView = {
    kind: enumOf(STEP_KINDS, raw.kind, round === 0 ? 'answer' : 'review'),
    round,
    status: enumOf(STEP_STATUSES, raw.status, 'pending'),
  };
  for (const key of ['attempt', 'startedAt', 'endedAt'] as const) {
    if (num(raw[key]) !== undefined) step[key] = num(raw[key]);
  }
  if (str(raw.turnId)) step.turnId = str(raw.turnId);
  const texts = [['summary', MULTI_MODEL_LIMITS.summary], ['error', MULTI_MODEL_LIMITS.error], ['now', MULTI_MODEL_LIMITS.now],
    ['excerpt', MULTI_MODEL_LIMITS.excerpt], ['notice', MULTI_MODEL_LIMITS.notice]] as const;
  for (const [key, max] of texts) {
    const text = clampText(raw[key], max);
    if (text) step[key] = text;
  }
  return step;
}

function parseThread(value: unknown, reviewRounds: number): MultiModelThreadView | null {
  const raw = record(value);
  const key = str(raw?.key);
  const runtimeId = str(raw?.runtimeId);
  if (!raw || !key || !runtimeId) return null;
  const modelId = strOrNull(raw.modelId);
  const steps = Array.isArray(raw.steps)
    ? raw.steps.slice(0, 1 + reviewRounds).flatMap((item, index) => { const step = parseStep(item, index); return step ? [step] : []; })
    : [];
  const thread: MultiModelThreadView = {
    key,
    runtimeId,
    providerId: strOrNull(raw.providerId),
    modelId,
    reasoning: strOrNull(raw.reasoning),
    runtimeLabel: clampText(raw.runtimeLabel, MULTI_MODEL_LIMITS.label) ?? clampText(runtimeId, MULTI_MODEL_LIMITS.label) ?? runtimeId,
    modelLabel: clampText(raw.modelLabel, MULTI_MODEL_LIMITS.label) ?? clampText(modelId, MULTI_MODEL_LIMITS.label) ?? 'Default model',
    context: enumOf(CONTEXTS, raw.context, 'fresh'),
    promptPreview: clampText(raw.promptPreview, MULTI_MODEL_LIMITS.promptPreview) ?? '',
    childNodeId: strOrNull(raw.childNodeId),
    steps,
  };
  if (raw.removed === true) thread.removed = true;
  if (raw.addedByUser === true) thread.addedByUser = true;
  if (raw.late === true) thread.late = true;
  if (raw.branchGone === true) thread.branchGone = true;
  if (Array.isArray(raw.previousChildNodeIds)) {
    const previous = raw.previousChildNodeIds.filter((id): id is string => !!str(id)).slice(0, PREVIOUS_CHILDREN_MAX);
    if (previous.length > 0) thread.previousChildNodeIds = previous;
  }
  return thread;
}

function parseSynthesis(value: unknown): MultiModelSynthesisView {
  const raw = record(value);
  const synthesis: MultiModelSynthesisView = { status: enumOf(SYNTHESIS_STATUSES, raw?.status, 'pending') };
  if (!raw) return synthesis;
  if (str(raw.turnId)) synthesis.turnId = str(raw.turnId);
  if (str(raw.messageId)) synthesis.messageId = str(raw.messageId);
  for (const key of ['startedAt', 'endedAt'] as const) {
    if (num(raw[key]) !== undefined) synthesis[key] = num(raw[key]);
  }
  const summary = clampText(raw.summary, MULTI_MODEL_LIMITS.summary);
  if (summary) synthesis.summary = summary;
  const error = clampText(raw.error, MULTI_MODEL_LIMITS.error);
  if (error) synthesis.error = error;
  if (Number.isSafeInteger(raw.addenda) && (raw.addenda as number) >= 0) synthesis.addenda = raw.addenda as number;
  if (SYNTHESIS_STATUSES.has(raw.lastAddendumStatus as MultiModelSynthesisStatus)) {
    synthesis.lastAddendumStatus = raw.lastAddendumStatus as MultiModelSynthesisStatus;
  }
  return synthesis;
}

/** Validate an untrusted run view; null when unusable. Every field is whitelisted and clamped. */
export function parseMultiModelRunView(value: unknown): MultiModelRunView | null {
  const raw = record(value);
  if (!raw || raw.version !== 1 || !PHASES.has(raw.phase as MultiModelPhase)) return null;
  const callerNodeId = str(raw.callerNodeId);
  if (!callerNodeId || !Array.isArray(raw.threads)) return null;
  const reviewRounds = reviewRoundsOf(raw.reviewRounds);
  const threads = raw.threads
    .flatMap((item) => { const thread = parseThread(item, reviewRounds); return thread ? [thread] : []; })
    .slice(0, MULTI_MODEL_LIMITS.rows);
  const view: MultiModelRunView = {
    version: 1,
    phase: raw.phase as MultiModelPhase,
    title: clampText(raw.title, MULTI_MODEL_LIMITS.title) ?? 'Multi-model plan',
    askPreview: clampText(raw.askPreview, MULTI_MODEL_LIMITS.ask) ?? '',
    callerNodeId,
    callerMessageId: strOrNull(raw.callerMessageId),
    callerRuntimeId: str(raw.callerRuntimeId) ?? '',
    callerRuntimeLabel: clampText(raw.callerRuntimeLabel, MULTI_MODEL_LIMITS.label) ?? '',
    callerModelLabel: clampText(raw.callerModelLabel, MULTI_MODEL_LIMITS.label) ?? '',
    permissionMode: isChatPermissionMode(raw.permissionMode) ? raw.permissionMode : 'ask',
    reviewRounds,
    threads,
    synthesis: parseSynthesis(raw.synthesis),
  };
  if (raw.approveForMe === true) view.approveForMe = true;
  if (num(raw.totalTokens) !== undefined) view.totalTokens = num(raw.totalTokens);
  if (num(raw.startedAt) !== undefined) view.startedAt = num(raw.startedAt);
  if (str(raw.lastMessageId)) view.lastMessageId = str(raw.lastMessageId);
  if (raw.settling === true) view.settling = true;
  return view;
}

/**
 * One trimming pass of boundWorkflowRun: prompt previews, excerpts,
 * summaries, live lines and errors clamped to `max` (with 0, prompt previews
 * become '' and the rest is dropped). Labels, statuses and ids stay whole.
 */
export function trimMultiModelRunView(view: MultiModelRunView, max: number): MultiModelRunView {
  const cut = (value: string | undefined) => (max === 0 || value === undefined ? undefined : clampText(value, max));
  const threads = view.threads.map((thread) => {
    const steps = thread.steps.map((step) => {
      const out: MultiModelStepView = { ...step };
      for (const key of ['excerpt', 'summary', 'now', 'error'] as const) {
        const text = cut(step[key]);
        if (text === undefined) delete out[key];
        else out[key] = text;
      }
      return out;
    });
    return { ...thread, promptPreview: cut(thread.promptPreview) ?? '', steps };
  });
  const synthesis: MultiModelSynthesisView = { ...view.synthesis };
  const summary = cut(view.synthesis.summary);
  if (summary === undefined) delete synthesis.summary;
  else synthesis.summary = summary;
  return { ...view, threads, synthesis };
}

// ---- Requests and responses ---------------------------------------------

export interface MultiModelModelPick {
  runtimeId: string;
  providerId?: string | null;
  modelId?: string | null;
  reasoning?: string | null;
}

export type MultiModelPlanEdit =
  | { op: 'remove'; key: string }
  | { op: 'restore'; key: string }
  | { op: 'replace'; key: string; pick: MultiModelModelPick }
  | { op: 'add'; pick: MultiModelModelPick };

const REQUEST_STRING_MAX = 200;

function requestString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= REQUEST_STRING_MAX ? value : undefined;
}

/** Validate an untrusted model pick: a runtime id and optional provider/model/reasoning, each at most 200 chars. */
export function parseMultiModelModelPick(value: unknown): MultiModelModelPick | null {
  const raw = record(value);
  const runtimeId = requestString(raw?.runtimeId);
  if (!raw || !runtimeId) return null;
  const pick: MultiModelModelPick = { runtimeId };
  for (const key of ['providerId', 'modelId', 'reasoning'] as const) {
    const field = raw[key];
    if (field === undefined) continue;
    if (field === null) { pick[key] = null; continue; }
    const text = requestString(field);
    if (!text) return null;
    pick[key] = text;
  }
  return pick;
}

/** Validate an untrusted plan edit (PATCH /multi-model-runs/:runId/plan). */
export function parseMultiModelPlanEdit(value: unknown): MultiModelPlanEdit | null {
  const raw = record(value);
  if (!raw) return null;
  if (raw.op === 'add') {
    const pick = parseMultiModelModelPick(raw.pick);
    return pick ? { op: 'add', pick } : null;
  }
  const key = requestString(raw.key);
  if (!key) return null;
  if (raw.op === 'remove' || raw.op === 'restore') return { op: raw.op, key };
  if (raw.op === 'replace') {
    const pick = parseMultiModelModelPick(raw.pick);
    return pick ? { op: 'replace', key, pick } : null;
  }
  return null;
}

/** GET /multi-model/ready-models and the list_ready_models tool. */
export interface ReadyModelOption {
  modelId: string;
  label: string;
  isDefault?: true;
  reasoningLevels?: string[];
  defaultReasoning?: string;
}
export interface ReadyProviderOption { providerId: string; label: string; models: ReadyModelOption[] }
export interface ReadyRuntimeOption {
  runtimeId: string;
  /** Short label (no parenthetical). */
  label: string;
  defaultModelId: string | null;
  defaultProviderId: string | null;
  /** Runtimes without providers. */
  models: ReadyModelOption[];
  /** Provider runtimes (capabilities.providerModels): ready providers only. */
  providers?: ReadyProviderOption[];
}
export interface ReadyModelsDto {
  version: 1;
  runtimes: ReadyRuntimeOption[];
  /** The calling chat's own runtime/model, when known. */
  current?: { runtimeId: string; providerId: string | null; modelId: string | null };
}

const READY_LIMITS = { runtimes: 12, providers: 8, models: 40 } as const;

function parseReadyModels(value: unknown): ReadyModelOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ReadyModelOption[] => {
    const raw = record(item);
    const modelId = str(raw?.modelId);
    if (!raw || !modelId) return [];
    const model: ReadyModelOption = { modelId, label: clampText(raw.label, MULTI_MODEL_LIMITS.label) ?? clampText(modelId, MULTI_MODEL_LIMITS.label) ?? modelId };
    if (raw.isDefault === true) model.isDefault = true;
    if (Array.isArray(raw.reasoningLevels)) {
      const levels = raw.reasoningLevels.filter((level): level is string => !!str(level)).slice(0, READY_LIMITS.models);
      if (levels.length > 0) model.reasoningLevels = levels;
    }
    if (str(raw.defaultReasoning)) model.defaultReasoning = str(raw.defaultReasoning);
    return [model];
  }).slice(0, READY_LIMITS.models);
}

/** Validate an untrusted ready-models list; null when unusable. Lists beyond the caps are cut. */
export function parseReadyModelsDto(value: unknown): ReadyModelsDto | null {
  const raw = record(value);
  if (!raw || raw.version !== 1 || !Array.isArray(raw.runtimes)) return null;
  const runtimes = raw.runtimes.flatMap((item): ReadyRuntimeOption[] => {
    const r = record(item);
    const runtimeId = str(r?.runtimeId);
    if (!r || !runtimeId) return [];
    const runtime: ReadyRuntimeOption = {
      runtimeId,
      label: clampText(r.label, MULTI_MODEL_LIMITS.label) ?? clampText(runtimeId, MULTI_MODEL_LIMITS.label) ?? runtimeId,
      defaultModelId: strOrNull(r.defaultModelId),
      defaultProviderId: strOrNull(r.defaultProviderId),
      models: parseReadyModels(r.models),
    };
    if (Array.isArray(r.providers)) {
      runtime.providers = r.providers.flatMap((entry): ReadyProviderOption[] => {
        const p = record(entry);
        const providerId = str(p?.providerId);
        if (!p || !providerId) return [];
        return [{
          providerId,
          label: clampText(p.label, MULTI_MODEL_LIMITS.label) ?? clampText(providerId, MULTI_MODEL_LIMITS.label) ?? providerId,
          models: parseReadyModels(p.models),
        }];
      }).slice(0, READY_LIMITS.providers);
    }
    return [runtime];
  }).slice(0, READY_LIMITS.runtimes);
  const dto: ReadyModelsDto = { version: 1, runtimes };
  const current = record(raw.current);
  const currentRuntimeId = str(current?.runtimeId);
  if (current && currentRuntimeId) {
    dto.current = { runtimeId: currentRuntimeId, providerId: strOrNull(current.providerId), modelId: strOrNull(current.modelId) };
  }
  return dto;
}

/** The propose tool's JSON result (agents/multiModelTool.ts), parsed by the receipt. */
export interface MultiModelProposalResult {
  status: 'proposed';
  runId: string;
  nativeId: string;
  threads: Array<{ key: string; label: string; context: MultiModelContext }>;
  reviewRounds: number;
  next: string;
}

/** Null unless the value is a proposal result: status 'proposed', a `wfr_` run id and an `mm_` native id. */
export function parseMultiModelProposalResult(value: unknown): MultiModelProposalResult | null {
  const raw = record(value);
  const runId = str(raw?.runId);
  const nativeId = str(raw?.nativeId);
  if (!raw || raw.status !== 'proposed' || !runId?.startsWith('wfr_') || !nativeId?.startsWith('mm_')) return null;
  const threads = Array.isArray(raw.threads)
    ? raw.threads.flatMap((item): MultiModelProposalResult['threads'] => {
      const t = record(item);
      const key = str(t?.key);
      if (!t || !key) return [];
      return [{ key, label: clampText(t.label, MULTI_MODEL_LIMITS.label) ?? key, context: enumOf(CONTEXTS, t.context, 'fresh') }];
    }).slice(0, MULTI_MODEL_LIMITS.rows)
    : [];
  return {
    status: 'proposed',
    runId,
    nativeId,
    threads,
    reviewRounds: reviewRoundsOf(raw.reviewRounds),
    next: typeof raw.next === 'string' ? raw.next : '',
  };
}
