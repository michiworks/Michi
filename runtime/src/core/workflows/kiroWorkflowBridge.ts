import { clampWorkflowText, isWorkflowRunTerminal, WORKFLOW_LIMITS, type WorkflowRunDtoV1 } from 'michi-shared';
import type { WorkflowControls, WorkflowRunContext, WorkflowRunSink } from '../../contract/host';
import { applyKiroStepUpdate, applyKiroWorkflowNotification, kiroWorkflowId } from './kiroWorkflowFold';

/**
 * Routes one Kiro CLI process's workflow traffic to the hub. Runs are
 * attributed through the parent (launching) session, which the runtime maps
 * back to the Michi chat; step sessions are learned from `node_start` and
 * their tool approvals are answered through the run.
 */

export type KiroWorkflowControlMethod = 'pause' | 'resume' | 'cancel' | 'retry';

/** AcpClient's synthetic event for a parent `Run Workflow` result. */
export const KIRO_WORKFLOW_LAUNCHED = 'michi/workflow_launched';

export interface KiroStepPermission {
  sessionId: string;
  requestId: number;
  toolCall?: Record<string, unknown>;
  /** The request's `_meta` (Kiro names the tool there). */
  meta?: Record<string, unknown>;
  options: Array<{ optionId: string; name?: string; kind?: string }>;
}

export interface KiroWorkflowBridgeDeps {
  /** The host's workflow runs (RuntimeHost.workflows; Michi: workflowRunHub). */
  hub: WorkflowRunSink;
  /** Michi identity of a native parent session; null when unknown. */
  resolve: (nativeSessionId: string) => WorkflowRunContext | null;
  control: (method: KiroWorkflowControlMethod, workflowId: string, parentSessionId: string) => Promise<void>;
  /** Whether this Kiro build accepts a control method. */
  supports?: (method: KiroWorkflowControlMethod) => boolean;
  /** Answer a step's permission request (null cancels it). */
  answerPermission?: (requestId: number, optionId: string | null) => void;
  /**
   * Whether the launching chat's own permissions (Trust, YOLO, a tool
   * grant, trust for the session) approve this step's request. Approved
   * requests are answered once with allow_once and never shown. Absent: ask.
   */
  approves?: (parentSessionId: string, request: KiroStepPermission) => boolean;
  now?: () => number;
}

export interface KiroWorkflowBridge {
  handle(method: string, params: Record<string, unknown>): void;
  /** A step session asks for a tool approval. True when the run took it. */
  requestPermission(request: KiroStepPermission): boolean;
  /** Step sessions this bridge knows (their frames never reach a chat). */
  isStepSession(sessionId: string): boolean;
  /** A workflow of this process is running or paused (it dies with the process). */
  hasOpenRuns(): boolean;
  /** Running or paused runs a session launched (Kiro wakes that session when one finishes). */
  openRunsFor(parentSessionId: string): string[];
  /** When a run this session launched last reported anything; undefined when none has. */
  lastEventAt(parentSessionId: string): number | undefined;
  /** Stop a session's open runs, as the card's Stop does. */
  stopRunsFor(parentSessionId: string): Promise<void>;
  /**
   * The session is released: its finished runs accept no more actions (a
   * Retry would wake a session nobody shows). Open runs keep theirs.
   */
  releaseParent(parentSessionId: string): void;
  release(reason: string): void;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** `_meta.kiro.workflowWatch` of a request a watch's command spawn makes on the parent session. */
function watchOf(meta: Record<string, unknown> | undefined): { workflowId: string; nodeId: string } | undefined {
  const watch = rec(rec(meta?.['kiro'])?.['workflowWatch']);
  const workflowId = str(watch?.['workflowId']);
  const nodeId = str(watch?.['nodeId']);
  return workflowId && nodeId ? { workflowId, nodeId } : undefined;
}

function joinPath(root: string | undefined, resource: string): string {
  if (resource.startsWith('/') || /^[A-Za-z]:[\\/]/.test(resource) || !root) return resource;
  return `${root.replace(/[\\/]+$/, '')}/${resource}`;
}

function consentCommand(meta: Record<string, unknown> | undefined): string | undefined {
  const kiro = rec(meta?.['kiro']);
  const consent = rec(kiro?.['consent']);
  return str(kiro?.['command']) ?? (consent?.['capability'] === 'shell' ? str(consent['resource']) : undefined);
}

/**
 * What the user is asked to allow, as text, the same on chat, multi-model and
 * workflow cards. V3 requests carry no rawInput: a plan arrives as text in
 * `toolCall.content` (and structured in `_meta.kiro.workflowPlan`), a file or
 * command in `_meta.kiro.consent`. rawInput stays one line: a multi-model card
 * takes a detail with a line break for a long request.
 */
export function kiroRequestDetail(request: Pick<KiroStepPermission, 'toolCall' | 'meta'>): string | undefined {
  const toolCall = rec(request.toolCall);
  const content = Array.isArray(toolCall?.['content'])
    ? (toolCall['content'] as unknown[]).flatMap((item) => {
      const entry = rec(item);
      const text = str(rec(entry?.['content'])?.['text']) ?? str(entry?.['text']);
      return text ? [text] : [];
    }).join('\n\n')
    : '';
  if (content) return clampWorkflowText(content, WORKFLOW_LIMITS.prompt);
  const rawInput = toolCall?.['rawInput'];
  if (rawInput !== undefined) {
    return clampWorkflowText(typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput), WORKFLOW_LIMITS.prompt);
  }
  const command = consentCommand(request.meta);
  if (command) return clampWorkflowText(`$ ${command}`, WORKFLOW_LIMITS.prompt);
  const consent = rec(rec(request.meta?.['kiro'])?.['consent']);
  const resource = str(consent?.['resource']);
  if (!resource) return undefined;
  const path = joinPath(str(consent?.['workspaceRoot']), resource);
  const verb = consent?.['capability'] === 'fs_write' ? 'Write' : consent?.['capability'] === 'fs_read' ? 'Read' : str(consent?.['capability']);
  return clampWorkflowText(verb ? `${verb} ${path}` : path, WORKFLOW_LIMITS.prompt);
}

/**
 * A workflow card's detail. A watch's command also says that allowing it covers
 * the watch's later polls; only the run's bridge makes that true, so a chat
 * that gets the request never says it.
 */
export function kiroApprovalDetail(request: Pick<KiroStepPermission, 'toolCall' | 'meta'>): string | undefined {
  const detail = kiroRequestDetail(request);
  const watch = watchOf(request.meta);
  const command = consentCommand(request.meta);
  if (!watch || !command || detail !== clampWorkflowText(`$ ${command}`, WORKFLOW_LIMITS.prompt)) return detail;
  return clampWorkflowText(`$ ${command}\n\nWatch "${watch.nodeId}" runs this command on every poll. Allowing it here allows the same command for the rest of this run.`, WORKFLOW_LIMITS.prompt);
}

export function createKiroWorkflowBridge(deps: KiroWorkflowBridgeDeps): KiroWorkflowBridge {
  const now = deps.now ?? Date.now;
  const runs = new Map<string, { context: WorkflowRunContext; parentSessionId: string }>();
  const stepSessions = new Map<string, { workflowId: string; nodeId: string }>();
  /** Runs still running or paused in this process. */
  const open = new Set<string>();
  /** Parent session → when one of its runs last reported anything. */
  const lastEvent = new Map<string, number>();
  /**
   * Watch commands the user allowed, per run (`nodeId\ncommand`): a watch
   * asks before every poll, so one answer covers the same command until the
   * run ends. Never Kiro's own always-allow, which would outlive the run.
   */
  const allowedWatch = new Map<string, Set<string>>();
  const track = (workflowId: string, run: WorkflowRunDtoV1 | null) => {
    if (!run) return;
    if (isWorkflowRunTerminal(run.status)) open.delete(workflowId);
    else open.add(workflowId);
  };
  const heard = (entry: { parentSessionId: string } | undefined) => {
    if (entry) lastEvent.set(entry.parentSessionId, now());
  };
  const runsOf = (parentSessionId: string) => [...runs].filter(([, entry]) => entry.parentSessionId === parentSessionId);

  function attach(workflowId: string, parentSessionId: string | undefined): { context: WorkflowRunContext; parentSessionId: string } | null {
    const known = runs.get(workflowId);
    if (known) return known;
    const context = parentSessionId ? deps.resolve(parentSessionId) : null;
    if (!context || !parentSessionId) return null;
    const entry = { context, parentSessionId };
    runs.set(workflowId, entry);
    return entry;
  }

  function controls(workflowId: string, entry: { context: WorkflowRunContext; parentSessionId: string }): WorkflowControls {
    const out: WorkflowControls = {};
    const supported = (method: KiroWorkflowControlMethod) => deps.supports?.(method) ?? true;
    if (supported('pause')) out.pause = () => deps.control('pause', workflowId, entry.parentSessionId);
    if (supported('cancel')) out.stop = () => deps.control('cancel', workflowId, entry.parentSessionId);
    if (supported('retry')) out.retry = () => deps.control('retry', workflowId, entry.parentSessionId);
    if (supported('resume')) {
      out.resume = async () => {
        await deps.control('resume', workflowId, entry.parentSessionId);
        // Kiro announces no "resumed" event; the next node_start would.
        deps.hub.update(entry.context, 'kiro', workflowId, (run) => run.status === 'paused'
          ? { ...run, status: 'running', statusDetail: undefined }
          : run);
      };
    }
    return out;
  }

  function forgetSteps(workflowId: string): void {
    for (const [sessionId, step] of stepSessions) if (step.workflowId === workflowId) stepSessions.delete(sessionId);
    allowedWatch.delete(workflowId);
  }

  /** The run step a request belongs to: a step session's, or a watch spawn on the parent. */
  function stepOf(request: KiroStepPermission): { workflowId: string; nodeId: string; watchKey?: string } | undefined {
    const step = stepSessions.get(request.sessionId);
    if (step) return step;
    const watch = watchOf(request.meta);
    const entry = watch ? runs.get(watch.workflowId) : undefined;
    if (!watch || !entry || entry.parentSessionId !== request.sessionId || !open.has(watch.workflowId)) return undefined;
    const command = str(rec(request.meta?.['kiro'])?.['command']) ?? str(rec(request.toolCall)?.['title']) ?? '';
    return { ...watch, watchKey: `${watch.nodeId}\n${command}` };
  }

  return {
    handle(method, params) {
      if (method === KIRO_WORKFLOW_LAUNCHED) {
        const workflowId = str(params['workflowId']);
        const toolCallId = str(params['toolCallId']);
        if (!workflowId) return;
        const fresh = !runs.has(workflowId);
        const entry = attach(workflowId, str(params['sessionId']));
        if (!entry) return;
        heard(entry);
        track(workflowId, deps.hub.update(entry.context, 'kiro', workflowId, (run) => toolCallId && !run.parentToolCallId
          ? { ...run, parentToolCallId: toolCallId }
          : run));
        if (fresh) deps.hub.registerControls(entry.context.ownerUserId, 'kiro', workflowId, controls(workflowId, entry));
        return;
      }
      const workflowId = kiroWorkflowId(params);
      if (!workflowId) return;
      if (method === 'session/update') {
        heard(runs.get(workflowId));
        deps.hub.updateKnown('kiro', workflowId, (run) => applyKiroStepUpdate(run, params, now()));
        return;
      }
      const fresh = !runs.has(workflowId);
      // Workflow notifications name the parent; notify names it as sessionId.
      const entry = attach(workflowId, str(params['parentSessionId']) ?? str(params['sessionId']));
      if (!entry) return;
      heard(entry);
      if (method === '_kiro/workflow/node_start') {
        const sessionId = str(params['sessionId']);
        const nodeId = str(params['nodeId']);
        if (sessionId && nodeId && sessionId !== entry.parentSessionId) stepSessions.set(sessionId, { workflowId, nodeId });
      }
      const run = deps.hub.update(entry.context, 'kiro', workflowId, (current) => applyKiroWorkflowNotification(current, method, params, now()));
      track(workflowId, run);
      if (fresh) deps.hub.registerControls(entry.context.ownerUserId, 'kiro', workflowId, controls(workflowId, entry));
      if (method === '_kiro/workflow/run_complete' && params['status'] !== 'paused') {
        forgetSteps(workflowId);
        // A completed run accepts nothing; failed/aborted ones keep Retry.
        if (run?.status === 'completed') deps.hub.registerControls(entry.context.ownerUserId, 'kiro', workflowId, {});
      }
    },

    requestPermission(request) {
      const step = stepOf(request);
      const entry = step ? runs.get(step.workflowId) : undefined;
      if (!step || !entry || !deps.answerPermission || request.options.length === 0) return false;
      heard(entry);
      // As in the chat: a single-use answer, never Kiro's own always-allow.
      const allow = request.options.find((option) => option.kind === 'allow_once');
      const allowedBefore = !!step.watchKey && allowedWatch.get(step.workflowId)?.has(step.watchKey) === true;
      let approved = false;
      try { approved = !!allow && (allowedBefore || deps.approves?.(entry.parentSessionId, request) === true); } catch { /* Ask instead. */ }
      if (allow && approved) {
        deps.answerPermission(request.requestId, allow.optionId);
        return true;
      }
      const toolCall = rec(request.toolCall);
      const detail = kiroApprovalDetail(request);
      // "Add 2 workflow steps to wf_…": the card already names the run.
      const title = clampWorkflowText(str(toolCall?.['title'])?.replace(` to ${step.workflowId}`, ''), WORKFLOW_LIMITS.title) ?? 'tool use';
      const answer = deps.answerPermission;
      const remember = (optionId: string | null) => {
        if (step.watchKey && allow && optionId === allow.optionId) {
          const allowed = allowedWatch.get(step.workflowId) ?? new Set<string>();
          allowed.add(step.watchKey);
          allowedWatch.set(step.workflowId, allowed);
        }
        answer(request.requestId, optionId);
      };
      return deps.hub.requestApproval(entry.context.ownerUserId, 'kiro', step.workflowId, {
        id: `kiro-${request.sessionId}-${request.requestId}`,
        nodeId: step.nodeId,
        title: `Approve ${title}?`,
        ...(detail ? { detail } : {}),
        options: request.options.map((option) => ({
          optionId: option.optionId,
          name: option.name ?? option.optionId,
          ...(option.kind ? { kind: option.kind } : {}),
        })),
      }, remember);
    },

    isStepSession(sessionId) {
      return stepSessions.has(sessionId);
    },

    hasOpenRuns() {
      return open.size > 0;
    },

    openRunsFor(parentSessionId) {
      return runsOf(parentSessionId).map(([workflowId]) => workflowId).filter((workflowId) => open.has(workflowId));
    },

    lastEventAt(parentSessionId) {
      return lastEvent.get(parentSessionId);
    },

    async stopRunsFor(parentSessionId) {
      if (!(deps.supports?.('cancel') ?? true)) return;
      for (const workflowId of this.openRunsFor(parentSessionId)) {
        try { await deps.control('cancel', workflowId, parentSessionId); } catch { /* the next sweep sees it still open */ }
      }
    },

    releaseParent(parentSessionId) {
      for (const [workflowId, entry] of runsOf(parentSessionId)) {
        if (open.has(workflowId)) continue;
        // Finished: its status stays; only its actions (Retry) go.
        deps.hub.releaseControls(entry.context.ownerUserId, 'kiro', workflowId);
        runs.delete(workflowId);
        forgetSteps(workflowId);
      }
      if (runsOf(parentSessionId).length === 0) lastEvent.delete(parentSessionId);
    },

    release(reason) {
      for (const [workflowId, entry] of runs) deps.hub.releaseControls(entry.context.ownerUserId, 'kiro', workflowId, reason);
      runs.clear();
      stepSessions.clear();
      open.clear();
      lastEvent.clear();
      allowedWatch.clear();
    },
  };
}
