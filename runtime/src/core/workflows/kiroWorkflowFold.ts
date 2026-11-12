import {
  clampWorkflowText,
  isWorkflowRunTerminal,
  settleWorkflowNodes,
  WORKFLOW_LIMITS,
  type WorkflowLoopDto,
  type WorkflowNodeDto,
  type WorkflowNodeKind,
  type WorkflowNodeRoundDto,
  type WorkflowNodeStatus,
  type WorkflowRunDtoV1,
  type WorkflowRunStatus,
  type WorkflowWatchDto,
} from 'michi-shared';
import { appendWorkflowLog } from './claudeWorkflowFold';

/**
 * Kiro CLI V3 workflows. Notifications (no request id):
 *
 *   _kiro/workflow/run_start      { workflowId, workflowName, inputs, nodeTree, parentSessionId }
 *   _kiro/workflow/node_start     { workflowId, nodeId, nodePath, type, agentName, sessionId?, branchId?, iteration? }
 *   _kiro/workflow/node_complete  { workflowId, nodeId, status, capturedOutput?, failureReason?, credits?, artifacts? }
 *   _kiro/workflow/node_paused    { workflowId, nodeId, reason }
 *   _kiro/workflow/paused         { workflowId, pauseReason }
 *   _kiro/workflow/loop_iteration { workflowId, loopId, iteration, stopConditionMet }
 *   _kiro/workflow/steps_queued   { workflowId, pendingSteps, resolution?: { outcome: applied | rejected | dropped } }
 *   _kiro/workflow/watch_poll     { workflowId, nodeId, outcome: idle | new-activity | terminal-state, at }
 *   _kiro/workflow/run_complete   { workflowId, status, finalState, credits? }
 *   _kiro/session/notify          { workflowId, nodeId, message, severity, sender: 'step' }
 *
 * Every `_kiro/workflow/*` frame also carries the run's `attention` list
 * (`{ kind: permission | question, nodeId }`). Node trees (`nodeTree`,
 * `pendingSteps`) are Kiro's buildNodePlan descriptors: parallel children in
 * `branches`, sequence/repeat children in `steps`; a repeat names its budget
 * and exit rule, a watch its handler as `agentName`. A step inside a repeat
 * keeps its id every iteration, with `iteration` set and `iter-N` in its
 * nodePath; `finalState.root` has each iteration as a `<loop>#N` sequence.
 *
 * Step sessions also stream ordinary `session/update` frames tagged
 * `_meta.kiro.workflow { workflowId, nodeId }`; their tool calls become the
 * node's current tool. Pure functions; the bridge owns routing.
 */

type Params = Record<string, unknown>;

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isoMs(value: unknown): number | undefined {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

const KINDS: Record<string, WorkflowNodeKind> = {
  step: 'step', agent: 'step', parallel: 'parallel', repeat: 'loop', loop: 'loop', branch: 'branch', conditional: 'branch',
  group: 'group', sequence: 'group', watch: 'watch',
};
const CHILD_KEYS = ['branches', 'children', 'steps', 'body', 'nodes'];
const ITERATION_SEGMENT = /^iter-\d+$/;

function nodeKind(type: unknown): WorkflowNodeKind {
  return (typeof type === 'string' && KINDS[type]) || 'step';
}

function nodeStatus(raw: string | undefined): WorkflowNodeStatus {
  switch (raw) {
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'skipped':
      return 'skipped';
    // Kiro's terminal status for a stopped run or node is `aborted`.
    case 'aborted':
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'paused':
      return 'paused';
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    default:
      return 'completed';
  }
}

/** Kiro run statuses: running | paused | completed | failed | aborted. */
function runStatus(raw: string | undefined): WorkflowRunStatus {
  if (raw === 'failed' || raw === 'error') return 'failed';
  if (raw === 'aborted' || raw === 'cancelled' || raw === 'canceled') return 'cancelled';
  if (raw === 'paused') return 'paused';
  if (raw === 'running') return 'running';
  return 'completed';
}

/** A repeat's exit rule as one line: `review.json verdict = "APPROVED"`, `wait finishes`. */
function untilLine(stopCondition: unknown, stopWhen: unknown): string | undefined {
  const when = str(stopWhen);
  if (when) {
    const watch = /^([^\s{}]+)\.terminal$/.exec(when);
    return clampWorkflowText(watch ? `${watch[1]} finishes` : when, WORKFLOW_LIMITS.line);
  }
  const stop = rec(stopCondition);
  if (!stop) return undefined;
  const parts: string[] = [];
  const file = rec(stop['fileCheck']);
  if (file && str(file['path'])) {
    const name = str(file['path'])!.split(/[\\/]/).pop();
    const value = file['value'];
    const target = Array.isArray(value) ? `in ${JSON.stringify(value)}` : `= ${JSON.stringify(value)}`;
    parts.push(`${name}${str(file['jsonPath']) ? ` ${str(file['jsonPath'])}` : ''} ${target}`);
  }
  if (str(stop['containsText'])) parts.push(`output contains "${str(stop['containsText'])}"`);
  if (str(stop['completionSignal'])) parts.push(`last step signals ${str(stop['completionSignal'])}`);
  return parts.length > 0 ? clampWorkflowText(parts.join(' or '), WORKFLOW_LIMITS.line) : undefined;
}

function loopOf(item: Record<string, unknown>): WorkflowLoopDto | undefined {
  if (item['type'] !== 'repeat' && item['type'] !== 'loop') return undefined;
  const loop: WorkflowLoopDto = {};
  const max = num(item['maxIterations']);
  if (max !== undefined) loop.maxIterations = max;
  const onMax = item['onMaxIterations'];
  if (onMax === 'abort' || onMax === 'continue' || onMax === 'pause') loop.onMaxIterations = onMax;
  const until = untilLine(item['stopCondition'], item['stopWhen']);
  if (until) loop.until = until;
  return Object.keys(loop).length > 0 ? loop : undefined;
}

/** Flatten a node tree (nodeTree, pendingSteps), parents before children; `skip` names nodes left out. */
export function kiroWorkflowNodes(tree: unknown, skip?: ReadonlySet<string>): WorkflowNodeDto[] {
  const nodes: WorkflowNodeDto[] = [];
  const walk = (items: unknown, parentId?: string) => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      const item = rec(raw);
      const id = str(item?.['nodeId']);
      if (!item || !id || skip?.has(id) || nodes.length >= WORKFLOW_LIMITS.nodes) continue;
      const loop = loopOf(item);
      nodes.push({
        id,
        kind: nodeKind(item['type']),
        title: clampWorkflowText(item['name'], WORKFLOW_LIMITS.title) ?? id,
        status: 'queued',
        ...(parentId ? { parentId } : {}),
        ...(str(item['agentName']) ? { agentName: str(item['agentName']) } : {}),
        ...(loop ? { loop } : {}),
      });
      for (const key of CHILD_KEYS) walk(item[key], id);
    }
  };
  walk(tree);
  return nodes;
}

function updateNode(
  run: WorkflowRunDtoV1,
  nodeId: string,
  patch: (node: WorkflowNodeDto) => WorkflowNodeDto,
  create?: () => WorkflowNodeDto,
): WorkflowRunDtoV1 {
  const index = run.nodes.findIndex((node) => node.id === nodeId);
  if (index >= 0) {
    const nodes = [...run.nodes];
    nodes[index] = patch(nodes[index]);
    return { ...run, nodes };
  }
  if (!create) return run;
  const roomy = makeRoom(run);
  return roomy ? { ...roomy, nodes: [...roomy.nodes, patch(create())] } : run;
}

/** True when a loop contains `node`: its steps run again under the same id. */
function inLoop(node: WorkflowNodeDto, byId: ReadonlyMap<string, WorkflowNodeDto>): boolean {
  let parentId = node.parentId;
  for (let depth = 0; parentId && depth < byId.size; depth += 1) {
    const parent = byId.get(parentId);
    if (parent?.kind === 'loop') return true;
    parentId = parent?.parentId;
  }
  return false;
}

/**
 * Room for one more node. A full run drops its oldest completed step outside
 * any loop, which can no longer change; the step stays counted in
 * `omittedLeaves` and its id in `omittedLeafIds`. Undefined when nothing
 * can go.
 */
function makeRoom(run: WorkflowRunDtoV1): WorkflowRunDtoV1 | undefined {
  if (run.nodes.length < WORKFLOW_LIMITS.nodes) return run;
  const ids = run.omittedLeafIds ?? {};
  if (Object.keys(ids).length >= WORKFLOW_LIMITS.omittedIds) return undefined;
  const byId = new Map(run.nodes.map((node) => [node.id, node]));
  let victim: WorkflowNodeDto | undefined;
  for (const node of run.nodes) {
    if (node.kind !== 'step' || node.status !== 'completed' || node.needsInput || node.iteration !== undefined || inLoop(node, byId)) continue;
    if (!victim || (node.endedAt ?? Infinity) < (victim.endedAt ?? Infinity)) victim = node;
  }
  if (!victim) return undefined;
  const parent = victim.parentId ?? '';
  const counts = run.omittedLeaves?.[parent] ?? {};
  return {
    ...run,
    nodes: run.nodes.filter((node) => node !== victim),
    omittedLeaves: { ...run.omittedLeaves, [parent]: { ...counts, completed: (counts.completed ?? 0) + 1 } },
    omittedLeafIds: { ...ids, [victim.id]: parent },
  };
}

/** An omitted step Kiro starts again (a retry) leaves the counts and comes back as a node. */
function restoreOmitted(run: WorkflowRunDtoV1, nodeId: string): WorkflowRunDtoV1 {
  const ids = run.omittedLeafIds;
  if (!ids || !Object.prototype.hasOwnProperty.call(ids, nodeId)) return run;
  const parent = ids[nodeId];
  const { [nodeId]: _restored, ...restIds } = ids;
  const omittedLeaves = { ...run.omittedLeaves };
  const completed = (omittedLeaves[parent]?.completed ?? 0) - 1;
  const { completed: _completed, ...otherCounts } = omittedLeaves[parent] ?? {};
  if (completed > 0) omittedLeaves[parent] = { ...otherCounts, completed };
  else if (Object.keys(otherCounts).length > 0) omittedLeaves[parent] = otherCounts;
  else delete omittedLeaves[parent];
  const next: WorkflowRunDtoV1 = { ...run };
  if (Object.keys(restIds).length > 0) next.omittedLeafIds = restIds;
  else delete next.omittedLeafIds;
  if (Object.keys(omittedLeaves).length > 0) next.omittedLeaves = omittedLeaves;
  else delete next.omittedLeaves;
  return next;
}

/** The nearest real container in a nodePath (iteration segments are not nodes). */
function parentFromPath(path: unknown, workflowId: string): string | undefined {
  if (!Array.isArray(path)) return undefined;
  for (let index = path.length - 2; index >= 0; index -= 1) {
    const segment = path[index];
    if (typeof segment !== 'string' || ITERATION_SEGMENT.test(segment)) continue;
    return segment !== workflowId ? segment : undefined;
  }
  return undefined;
}

/** Kiro credit usage entries (`[{ usage, unit: 'credit' }]`) as one number. */
function creditsOf(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  let total: number | undefined;
  for (const item of value) {
    const entry = rec(item);
    const usage = num(entry?.['usage']);
    const unit = str(entry?.['unit']);
    if (usage === undefined || (unit !== undefined && unit !== 'credit')) continue;
    total = (total ?? 0) + usage;
  }
  return total === undefined ? undefined : Math.round(total * 1000) / 1000;
}

function artifactsOf(value: unknown): Record<string, string> | undefined {
  const raw = rec(value);
  if (!raw) return undefined;
  const entries = Object.entries(raw).flatMap(([key, path]): Array<[string, string]> => {
    const file = clampWorkflowText(path, WORKFLOW_LIMITS.line);
    return file ? [[key, file]] : [];
  }).slice(0, WORKFLOW_LIMITS.artifacts);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function withCredits(node: WorkflowNodeDto, credits: number | undefined): WorkflowNodeDto {
  return credits === undefined ? node : { ...node, usage: { ...node.usage, credits } };
}

function roundOf(node: WorkflowNodeDto, iteration: number): WorkflowNodeRoundDto {
  const result = clampWorkflowText(node.result, WORKFLOW_LIMITS.roundText);
  const error = clampWorkflowText(node.error, WORKFLOW_LIMITS.roundText);
  return {
    iteration,
    status: node.status,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
    ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}),
    ...(node.usage?.credits !== undefined ? { credits: node.usage.credits } : {}),
  };
}

/**
 * A node starting iteration `iteration`: the finished previous iteration
 * moves to `rounds` and the node's per-iteration fields start over.
 */
function beginIteration(node: WorkflowNodeDto, iteration: number | undefined, now: number): WorkflowNodeDto {
  if (iteration === undefined || node.iteration === undefined || iteration === node.iteration) return node;
  if (node.status === 'queued' || node.status === 'running' || node.status === 'paused') return { ...node, iteration };
  const rounds = [...(node.rounds ?? []).filter((round) => round.iteration !== node.iteration), roundOf(node, node.iteration)]
    .slice(-WORKFLOW_LIMITS.rounds);
  const { result: _result, error: _error, endedAt: _endedAt, usage: _usage, currentTool: _tool, statusMessage: _message,
    toolCount: _tools, watch: _watch, artifacts: _artifacts, ...rest } = node;
  return { ...rest, rounds, iteration, startedAt: now };
}

function withoutKey<K extends keyof WorkflowNodeDto>(node: WorkflowNodeDto, key: K): WorkflowNodeDto {
  if (node[key] === undefined) return node;
  const { [key]: _drop, ...rest } = node;
  return rest as WorkflowNodeDto;
}

/** Ids of `rootIds` and everything under them. */
function subtreeIds(nodes: readonly WorkflowNodeDto[], rootIds: Iterable<string>): Set<string> {
  const ids = new Set(rootIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * A plan update (`update_workflow` replace_remaining, or the creator's
 * launch): the proposed steps replace the top-level steps that have not
 * started, marked `planned` until Kiro applies them.
 */
function applyStepsQueued(run: WorkflowRunDtoV1, params: Params): WorkflowRunDtoV1 {
  let nodes = run.nodes;
  const pending = params['pendingSteps'];
  if (Array.isArray(pending) && pending.length > 0) {
    const proposed = new Map(kiroWorkflowNodes(pending).map((node) => [node.id, node]));
    const status = new Map(nodes.map((node) => [node.id, node.status]));
    const untouched = (id: string) => [...subtreeIds(nodes, [id])].every((sub) => status.get(sub) === 'queued');
    // Top-level steps that have not started at all are what the update replaces.
    const replaced = subtreeIds(nodes, nodes.filter((node) => !node.parentId && untouched(node.id)).map((node) => node.id));
    const kept = nodes
      .filter((node) => !replaced.has(node.id) || proposed.has(node.id))
      .map((node) => {
        const loop = proposed.get(node.id)?.loop;
        return loop ? { ...node, loop } : node;
      });
    const keptIds = new Set(kept.map((node) => node.id));
    const added = [...proposed.values()].filter((node) => !keptIds.has(node.id)).map((node) => ({ ...node, planned: true as const }));
    nodes = [...kept, ...added].slice(0, WORKFLOW_LIMITS.nodes);
  }
  const outcome = str(rec(params['resolution'])?.['outcome']);
  if (outcome === 'applied') nodes = nodes.map((node) => withoutKey(node, 'planned'));
  if (outcome === 'rejected' || outcome === 'dropped') {
    const dropped = subtreeIds(nodes, nodes.filter((node) => node.planned && node.status === 'queued').map((node) => node.id));
    nodes = nodes.filter((node) => !dropped.has(node.id));
  }
  return nodes === run.nodes ? run : { ...run, nodes };
}

/** The run's `attention` list says which steps wait on an answer (question). */
function syncAttention(run: WorkflowRunDtoV1, params: Params): WorkflowRunDtoV1 {
  const list = params['attention'];
  if (!Array.isArray(list)) return run;
  const asking = new Set(list.flatMap((item) => {
    const entry = rec(item);
    return entry?.['kind'] === 'question' && str(entry['nodeId']) ? [str(entry['nodeId'])!] : [];
  }));
  let changed = false;
  const nodes = run.nodes.map((node) => {
    const wants = asking.has(node.id);
    if (wants === (node.needsInput === true)) return node;
    changed = true;
    return wants ? { ...node, needsInput: true as const } : withoutKey(node, 'needsInput');
  });
  return changed ? { ...run, nodes } : run;
}

interface FinalEntry {
  iteration?: number;
  status: WorkflowNodeStatus;
  result?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  credits?: number;
  artifacts?: Record<string, string>;
}

/** Per-node entries of `finalState.root`, every iteration of a loop step included. */
function finalEntries(root: unknown): Map<string, FinalEntry[]> {
  const out = new Map<string, FinalEntry[]>();
  const walk = (raw: unknown) => {
    const node = rec(raw);
    if (!node) return;
    const id = str(node['nodeId']);
    // `<loop>#N` sequences are Kiro's per-iteration wrappers, not nodes.
    if (id && !id.includes('#')) {
      const entry: FinalEntry = { status: nodeStatus(str(node['status'])) };
      const iteration = num(node['iteration']);
      if (iteration !== undefined) entry.iteration = iteration;
      const result = clampWorkflowText(node['capturedOutput'], WORKFLOW_LIMITS.result);
      if (result) entry.result = result;
      const error = clampWorkflowText(node['failureReason'], WORKFLOW_LIMITS.error);
      if (error) entry.error = error;
      const startedAt = isoMs(node['startedAt']);
      if (startedAt !== undefined) entry.startedAt = startedAt;
      const endedAt = isoMs(node['endedAt']);
      if (endedAt !== undefined) entry.endedAt = endedAt;
      const credits = creditsOf(node['credits']);
      if (credits !== undefined) entry.credits = credits;
      const artifacts = artifactsOf(node['artifacts']);
      if (artifacts) entry.artifacts = artifacts;
      out.set(id, [...(out.get(id) ?? []), entry]);
    }
    if (Array.isArray(node['children'])) for (const child of node['children']) walk(child);
  };
  walk(root);
  return out;
}

/** Kiro's final record is the whole history: earlier iterations, credits, files. */
function reconcileFinalState(run: WorkflowRunDtoV1, root: unknown): WorkflowRunDtoV1 {
  const entries = finalEntries(root);
  if (entries.size === 0) return run;
  const nodes = run.nodes.map((node) => {
    const list = entries.get(node.id);
    if (!list || list.length === 0) return node;
    const ordered = list.some((entry) => entry.iteration !== undefined)
      ? [...list].sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0))
      : list;
    const latest = ordered[ordered.length - 1];
    let next: WorkflowNodeDto = withCredits(node, latest.credits);
    if (latest.artifacts) next = { ...next, artifacts: { ...next.artifacts, ...latest.artifacts } };
    if (!next.result && latest.result) next = { ...next, result: latest.result };
    if (ordered.length > 1) {
      const rounds = ordered.slice(0, -1).map((entry, index): WorkflowNodeRoundDto => {
        const result = clampWorkflowText(entry.result, WORKFLOW_LIMITS.roundText);
        const error = clampWorkflowText(entry.error, WORKFLOW_LIMITS.roundText);
        return {
          iteration: entry.iteration ?? index,
          status: entry.status,
          ...(result ? { result } : {}),
          ...(error ? { error } : {}),
          ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
          ...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
          ...(entry.credits !== undefined ? { credits: entry.credits } : {}),
        };
      }).slice(-WORKFLOW_LIMITS.rounds);
      next = { ...next, rounds, ...(latest.iteration !== undefined ? { iteration: latest.iteration } : {}) };
    }
    return next;
  });
  return { ...run, nodes };
}

/** The workflow a notification or tagged step update belongs to. */
export function kiroWorkflowId(params: Params): string | undefined {
  const direct = str(params['workflowId']);
  if (direct) return direct;
  const workflow = rec(rec(rec(rec(params['update'])?.['_meta'])?.['kiro'])?.['workflow']);
  return str(workflow?.['workflowId']);
}

/** Fold one `_kiro/workflow/*` or `_kiro/session/notify` notification. */
export function applyKiroWorkflowNotification(run: WorkflowRunDtoV1, method: string, params: Params, now: number): WorkflowRunDtoV1 {
  let next = applyNotification(run, method, params, now);
  // `interrupted` holds only while the run stays cancelled.
  if (next.interrupted && next.status !== 'cancelled') next = withoutInterrupted(next);
  return method.startsWith('_kiro/workflow/') ? syncAttention(next, params) : next;
}

function withoutInterrupted(run: WorkflowRunDtoV1): WorkflowRunDtoV1 {
  if (!('interrupted' in run)) return run;
  const { interrupted: _interrupted, ...rest } = run;
  return rest;
}

/**
 * A run stored before `interrupted` existed: only Michi's own two messages
 * marked it (WorkflowRunHub.recover, the Kiro bridge's release), never
 * Kiro's text.
 */
function interruptedBeforeTheFlag(statusDetail: string | undefined): boolean {
  return !!statusDetail && (statusDetail.startsWith('Interrupted: Michi restarted')
    || statusDetail.startsWith('Interrupted: the Kiro session ended'));
}

function applyNotification(run: WorkflowRunDtoV1, method: string, params: Params, now: number): WorkflowRunDtoV1 {
  const event = method.startsWith('_kiro/workflow/') ? method.slice('_kiro/workflow/'.length) : method;
  const nodeId = str(params['nodeId']);
  if (event === 'run_start') {
    // Also sent again on resume and retry: keep what the nodes already did.
    const inputs = params['inputs'];
    const definition = inputs !== undefined ? clampWorkflowText(JSON.stringify(inputs, null, 2), WORKFLOW_LIMITS.definition) : undefined;
    // Steps already omitted stay omitted (and counted).
    const tree = kiroWorkflowNodes(params['nodeTree'], new Set(Object.keys(run.omittedLeafIds ?? {})));
    const known = new Map(run.nodes.map((node) => [node.id, node]));
    const nodes = tree.length === 0 ? run.nodes : tree.map((node) => {
      const prior = known.get(node.id);
      if (!prior) return node;
      // The tree is the plan in force: nothing in it is merely proposed.
      const kept = withoutKey(prior, 'planned');
      return {
        ...kept,
        ...(node.loop ? { loop: node.loop } : {}),
        // Paused work, and work a stop skipped before it started, waits its turn
        // again; a step Kiro itself skipped has an end time and stays skipped.
        ...(prior.status === 'paused' || (prior.status === 'skipped' && prior.startedAt === undefined && prior.endedAt === undefined)
          ? { status: 'queued' as const } : {}),
      };
    });
    const { endedAt: _endedAt, ...open } = run;
    return {
      ...open,
      name: clampWorkflowText(params['workflowName'], WORKFLOW_LIMITS.title) ?? run.name,
      ...(definition ? { definition } : {}),
      status: 'running',
      statusDetail: undefined,
      nodes,
    };
  }
  if (event === 'run_complete' && str(params['status']) === 'paused') {
    // A pause ends the run loop with status `paused`; the run is resumable.
    return { ...run, status: 'paused', statusDetail: run.statusDetail ?? 'Paused' };
  }
  if (event === 'run_complete') {
    const status = runStatus(str(params['status']));
    const finalState = rec(params['finalState']);
    const captured = rec(finalState?.['capturedOutputs']);
    const credits = creditsOf(params['credits']);
    // Kiro ended it itself: whatever Michi marked before no longer holds.
    let next: WorkflowRunDtoV1 = { ...withoutInterrupted(run), status, endedAt: run.endedAt ?? now, ...(credits !== undefined ? { usage: { ...run.usage, credits } } : {}) };
    if (captured) {
      for (const [id, output] of Object.entries(captured)) {
        const text = clampWorkflowText(typeof output === 'string' ? output : JSON.stringify(output), WORKFLOW_LIMITS.result);
        if (text) next = updateNode(next, id, (node) => node.result ? node : { ...node, result: text });
      }
    }
    next = reconcileFinalState(next, finalState?.['root']);
    const explicit = finalState?.['result'] ?? finalState?.['output'];
    const lastCompleted = [...next.nodes].reverse().find((node) => !node.parentId && node.result);
    const result = clampWorkflowText(typeof explicit === 'string' ? explicit : explicit !== undefined ? JSON.stringify(explicit, null, 2) : lastCompleted?.result, WORKFLOW_LIMITS.result);
    const failure = clampWorkflowText(finalState?.['failureReason'] ?? finalState?.['error'], WORKFLOW_LIMITS.line);
    return {
      ...next,
      ...(result ? { result } : {}),
      ...(failure ? { statusDetail: failure } : status === 'completed' ? { statusDetail: undefined } : {}),
      nodes: settleWorkflowNodes(next.nodes.map((node) => withoutKey(node, 'planned')), status, now),
    };
  }
  // Kiro keeps workflow state on disk; a run Michi marked interrupted (its
  // session or Michi went away) can be resumed by Kiro and start nodes again.
  if (event === 'node_start' && run.status === 'cancelled' && (run.interrupted || interruptedBeforeTheFlag(run.statusDetail))) {
    run = { ...withoutInterrupted(run), status: 'running', statusDetail: undefined, endedAt: undefined };
  }
  if (isWorkflowRunTerminal(run.status)) return run;
  if (event === 'paused') {
    return { ...run, status: 'paused', statusDetail: clampWorkflowText(params['pauseReason'] ?? params['reason'], WORKFLOW_LIMITS.line) ?? 'Paused' };
  }
  if (event === 'steps_queued') return applyStepsQueued(run, params);
  if (!nodeId && event !== 'notify' && event !== '_kiro/session/notify') return run;
  if (event === 'node_start' && nodeId) {
    run = restoreOmitted(run, nodeId);
    const resumed = run.status === 'paused' ? { status: 'running' as const, statusDetail: undefined } : {};
    const iteration = num(params['iteration']);
    return {
      ...updateNode(run, nodeId, (node) => {
        const { endedAt: _endedAt, ...current } = withoutKey(beginIteration(node, iteration, now), 'planned');
        return {
          ...current,
          status: 'running',
          startedAt: current.startedAt ?? now,
          ...(str(params['agentName']) ? { agentName: str(params['agentName']) } : {}),
          ...(iteration !== undefined ? { iteration } : {}),
        };
      }, () => ({
        id: nodeId,
        kind: nodeKind(params['type']),
        title: nodeId,
        status: 'running',
        ...(parentFromPath(params['nodePath'], run.nativeId) ? { parentId: parentFromPath(params['nodePath'], run.nativeId) } : {}),
      })),
      ...resumed,
    };
  }
  if (event === 'node_complete' && nodeId) {
    const status = nodeStatus(str(params['status']));
    const result = clampWorkflowText(params['capturedOutput'], WORKFLOW_LIMITS.result);
    const error = clampWorkflowText(params['failureReason'], WORKFLOW_LIMITS.error);
    const credits = creditsOf(params['credits']);
    const artifacts = artifactsOf(params['artifacts']);
    return updateNode(run, nodeId, (node) => withCredits({
      ...node,
      status,
      currentTool: undefined,
      endedAt: now,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
      ...(artifacts ? { artifacts: { ...node.artifacts, ...artifacts } } : {}),
    }, credits));
  }
  if (event === 'node_paused' && nodeId) {
    return updateNode(run, nodeId, (node) => ({ ...node, status: 'paused', statusMessage: clampWorkflowText(params['reason'], WORKFLOW_LIMITS.line) ?? node.statusMessage }));
  }
  if (event === 'watch_poll' && nodeId) {
    const outcome = params['outcome'];
    if (outcome !== 'idle' && outcome !== 'new-activity' && outcome !== 'terminal-state') return run;
    const at = isoMs(params['at']) ?? now;
    return updateNode(run, nodeId, (node) => {
      const watch: WorkflowWatchDto = { polls: (node.watch?.polls ?? 0) + 1, lastPollAt: at, lastOutcome: outcome };
      return { ...node, watch };
    });
  }
  if (event === 'loop_iteration') {
    const loopId = str(params['loopId']) ?? nodeId;
    const iteration = num(params['iteration']);
    if (!loopId || iteration === undefined) return run;
    return updateNode(run, loopId, (node) => ({ ...node, iteration, statusMessage: `Iteration ${iteration}${params['stopConditionMet'] === true ? ' · stop condition met' : ''}` }));
  }
  if (method === '_kiro/session/notify') {
    const text = clampWorkflowText(params['message'], WORKFLOW_LIMITS.line);
    if (!text) return run;
    const severity = str(params['severity']);
    const next: WorkflowRunDtoV1 = {
      ...run,
      log: appendWorkflowLog(run.log, {
        at: now,
        text,
        ...(nodeId ? { nodeId } : {}),
        ...(severity === 'info' || severity === 'success' || severity === 'warning' || severity === 'error' ? { severity } : {}),
      }),
    };
    return nodeId ? updateNode(next, nodeId, (node) => ({ ...node, statusMessage: text })) : next;
  }
  return run;
}

/** A step session's own `session/update` (tagged `_meta.kiro.workflow`). */
export function applyKiroStepUpdate(run: WorkflowRunDtoV1, params: Params, now: number): WorkflowRunDtoV1 {
  if (isWorkflowRunTerminal(run.status)) return run;
  const update = rec(params['update']);
  const workflow = rec(rec(rec(update?.['_meta'])?.['kiro'])?.['workflow']);
  const nodeId = str(workflow?.['nodeId']);
  const kind = str(update?.['sessionUpdate']);
  if (!update || !nodeId || (kind !== 'tool_call' && kind !== 'tool_call_update')) return run;
  const title = clampWorkflowText(update['title'], WORKFLOW_LIMITS.line);
  const status = str(update['status']);
  const running = !status || status === 'pending' || status === 'in_progress';
  return updateNode(run, nodeId, (node) => ({
    ...node,
    ...(kind === 'tool_call' ? { toolCount: (node.toolCount ?? 0) + 1 } : {}),
    ...(running && title ? { currentTool: title } : {}),
    ...(!running && (!title || node.currentTool === title) ? { currentTool: undefined } : {}),
    ...(node.status === 'queued' ? { status: 'running', startedAt: node.startedAt ?? now } : {}),
  }));
}
