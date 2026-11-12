/**
 * Internal plan and state of a multi-model run (multi_model_runs.plan_json /
 * state_json). The UI never reads these; it reads the MultiModelRunView the
 * orchestrator derives from them (shared/src/multiModel.ts).
 *
 * Turn ids are deterministic per node: `mm-<uuid>-<key>-g<generation>-s<step>-a<attempt>`
 * for steps, `mm-<uuid>-syn-a<attempt>` for the synthesis and
 * `mm-<uuid>-add<n>-a<attempt>` for addenda (`uuid` is the native id without
 * `mm_`). Restarting from durable state returns the same turn; a retry mints
 * a new attempt, and a replaced child a new generation, since ChatHub rejects
 * a durable turn id reused on another node.
 */
import type {
  MultiModelContext,
  MultiModelPermissionMode,
  MultiModelStepStatus,
  MultiModelSynthesisStatus,
} from 'michi-shared';

export interface MultiModelModelChoice {
  runtimeId: string;
  providerId: string | null;
  modelId: string | null;
  reasoning: string | null;
  runtimeLabel: string;
  modelLabel: string;
}

export interface MultiModelThreadPlan extends MultiModelModelChoice {
  key: string;
  context: MultiModelContext;
  prompt: string;
  removed: boolean;
  addedByUser: boolean;
}

export interface MultiModelPlan {
  version: 1;
  /** ≤ 120 chars. */
  title: string;
  /** ≤ 400 chars. */
  askPreview: string;
  reviewRounds: 0 | 1 | 2;
  /** Prompt and context for a row the user adds (tool sharedPrompt/sharedContext; default threads[0]). */
  sharedPrompt: string;
  sharedContext: MultiModelContext;
  /** ≤ 8 rows, ≤ 5 live. */
  threads: MultiModelThreadPlan[];
  /** Next user-added row key: "a1", "a2", … */
  nextAddedKey: number;
  caller: { runtimeId: string; runtimeLabel: string; modelLabel: string };
}

export interface MultiModelStepState {
  status: MultiModelStepStatus;
  turnId: string | null;
  attempt: number;
  startedAt: number | null;
  endedAt: number | null;
  summary: string | null;
  excerpt: string | null;
  error: string | null;
  totalTokens: number | null;
  /** What the user should know though the step did not fail: an approval the runtime denied unanswered. Absent in older rows. */
  notice?: string | null;
}

export interface MultiModelThreadState {
  key: string;
  /** Minted ('n-' + uuid) and persisted BEFORE createChild is called, so a crash can never leave an unrecorded child. */
  childNodeId: string | null;
  previousChildNodeIds: string[];
  /** previousChildNodeIds.length: the turn-id generation of the current child. */
  generation: number;
  /** 1 + reviewRounds once started. */
  steps: MultiModelStepState[];
  stopRequested: boolean;
  late: boolean;
  /** The addendum turn that attempted to report this thread's late answer (any outcome); null = not yet attempted. */
  addendumTurnId: string | null;
}

export interface MultiModelSynthesisState {
  status: MultiModelSynthesisStatus;
  turnId: string | null;
  attempt: number;
  startedAt: number | null;
  endedAt: number | null;
  summary: string | null;
  error: string | null;
  messageId: string | null;
  totalTokens: number | null;
}

export interface MultiModelAddendumState {
  turnId: string;
  keys: string[];
  status: MultiModelSynthesisStatus;
  attempt: number;
  error: string | null;
  messageId: string | null;
}

export interface MultiModelRunState {
  version: 1;
  /** 0 = answer, 1..reviewRounds = review round, reviewRounds + 1 = synthesis. */
  currentStep: number;
  /** The caller's mode at the last child creation (read fresh before each createChild). */
  permissionMode: MultiModelPermissionMode;
  approveForMe: boolean;
  threads: Record<string, MultiModelThreadState>;
  synthesis: MultiModelSynthesisState;
  addenda: MultiModelAddendumState[];
  cancelRequested: boolean;
  statusDetail: string | null;
}
