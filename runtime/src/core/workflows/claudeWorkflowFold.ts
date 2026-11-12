import {
  clampWorkflowText,
  isWorkflowRunTerminal,
  settledWorkflowNodeStatus,
  settleWorkflowNodes,
  type SubagentUsage,
  WORKFLOW_LIMITS,
  type WorkflowLogEntry,
  type WorkflowNodeDto,
  type WorkflowNodeStatus,
  type WorkflowOmittedLeaves,
  type WorkflowRunDtoV1,
  type WorkflowRunStatus,
  type WorkflowUsage,
} from 'michi-shared';

/**
 * Claude Code dynamic workflows (the `Workflow` tool) as `system` task
 * frames with `task_type: 'local_workflow'`:
 *
 *   task_started   { task_id, tool_use_id, workflow_name, description, prompt (script) }
 *   task_progress  { usage, description, workflow_progress?: snapshot of
 *                    workflow_phase / workflow_agent items }
 *   task_updated   { patch: { status, end_time, error } }
 *   task_notification { status, summary, usage, output_file }
 *
 * `workflow_progress` is a full snapshot each time it is present, so the
 * node list is rebuilt from it. Pure functions; the tap owns I/O.
 */

type Envelope = Record<string, unknown>;

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function isClaudeWorkflowStart(env: Envelope): boolean {
  return env['type'] === 'system' && env['subtype'] === 'task_started' && env['task_type'] === 'local_workflow';
}

export function claudeTaskId(env: Envelope): string | undefined {
  return env['type'] === 'system' && typeof env['subtype'] === 'string' && (env['subtype'] as string).startsWith('task_')
    ? str(env['task_id'])
    : undefined;
}

/** Task usage: snake_case in system task frames, camelCase in Task tool results. */
export function claudeTaskUsage(raw: Record<string, unknown> | undefined): SubagentUsage | undefined {
  if (!raw) return undefined;
  const usage: SubagentUsage = {};
  const tokens = num(raw['total_tokens']) ?? num(raw['totalTokens']);
  const tools = num(raw['tool_uses']) ?? num(raw['totalToolUseCount']);
  const duration = num(raw['duration_ms']) ?? num(raw['totalDurationMs']);
  if (tokens !== undefined) usage.totalTokens = tokens;
  if (tools !== undefined) usage.toolUses = tools;
  if (duration !== undefined) usage.durationMs = duration;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function agentStatus(state: string | undefined, startedAt: number | undefined): WorkflowNodeStatus {
  switch (state) {
    case 'done':
    case 'completed':
      return 'completed';
    case 'error':
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'killed':
    case 'stopped':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      return startedAt !== undefined || state === 'start' || state === 'running' ? 'running' : 'queued';
  }
}

function phaseStatus(children: readonly WorkflowNodeDto[]): WorkflowNodeStatus {
  if (children.length === 0) return 'queued';
  if (children.some((child) => child.status === 'running')) return 'running';
  if (children.every((child) => child.status === 'completed' || child.status === 'skipped')) return 'completed';
  if (children.some((child) => child.status === 'failed')) return 'failed';
  if (children.some((child) => child.status === 'cancelled')) return 'cancelled';
  return 'running';
}

type ClaudeWorkflowGraph = Pick<WorkflowRunDtoV1, 'nodes' | 'omittedLeaves'>;

/**
 * Rebuild the node list from a `workflow_progress` snapshot. Beyond
 * WORKFLOW_LIMITS.nodes, phases stay, and so do running and the newest
 * agents; the rest are only counted, in `omittedLeaves`.
 */
export function claudeWorkflowNodes(progress: unknown, now: number): ClaudeWorkflowGraph {
  if (!Array.isArray(progress)) return { nodes: [] };
  const phases: WorkflowNodeDto[] = [];
  const agents: WorkflowNodeDto[] = [];
  for (const raw of progress) {
    const item = rec(raw);
    if (!item) continue;
    const index = num(item['index']);
    if (index === undefined) continue;
    if (item['type'] === 'workflow_phase') {
      phases.push({ id: `phase:${index}`, kind: 'phase', title: clampWorkflowText(item['title'], WORKFLOW_LIMITS.title) ?? `Phase ${index}`, status: 'queued' });
    } else if (item['type'] === 'workflow_agent') {
      const startedAt = num(item['startedAt']);
      const status = agentStatus(str(item['state']), startedAt);
      const durationMs = num(item['durationMs']);
      const tool = str(item['lastToolName']);
      const toolSummary = str(item['lastToolSummary']);
      const usage: WorkflowUsage = {};
      if (num(item['tokens']) !== undefined) usage.totalTokens = num(item['tokens']);
      if (num(item['toolCalls']) !== undefined) usage.toolUses = num(item['toolCalls']);
      if (durationMs !== undefined) usage.durationMs = durationMs;
      const phaseIndex = num(item['phaseIndex']);
      const node: WorkflowNodeDto = {
        id: `agent:${index}`,
        kind: 'agent',
        title: clampWorkflowText(item['label'], WORKFLOW_LIMITS.title) ?? `Agent ${index}`,
        status,
        ...(phaseIndex !== undefined ? { parentId: `phase:${phaseIndex}` } : {}),
        ...(str(item['model']) ? { model: str(item['model']) } : {}),
        ...(num(item['attempt']) !== undefined ? { attempt: num(item['attempt']) } : {}),
        ...(clampWorkflowText(item['promptPreview'], WORKFLOW_LIMITS.prompt) ? { prompt: clampWorkflowText(item['promptPreview'], WORKFLOW_LIMITS.prompt) } : {}),
        ...(status === 'running' && tool ? { currentTool: clampWorkflowText(toolSummary ? `${tool} ${toolSummary}` : tool, WORKFLOW_LIMITS.line) } : {}),
        ...(clampWorkflowText(item['resultPreview'], WORKFLOW_LIMITS.result) ? { result: clampWorkflowText(item['resultPreview'], WORKFLOW_LIMITS.result) } : {}),
        ...(clampWorkflowText(item['error'], WORKFLOW_LIMITS.error) ? { error: clampWorkflowText(item['error'], WORKFLOW_LIMITS.error) } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(status !== 'running' && status !== 'queued' && startedAt !== undefined
          ? { endedAt: durationMs !== undefined ? startedAt + durationMs : now }
          : {}),
        ...(Object.keys(usage).length > 0 ? { usage } : {}),
        ...(usage.toolUses !== undefined ? { toolCount: usage.toolUses } : {}),
      };
      agents.push(node);
    }
  }
  // A phase mentioned only by its agents still gets a node.
  for (const agent of agents) {
    if (agent.parentId && !phases.some((phase) => phase.id === agent.parentId)) {
      phases.push({ id: agent.parentId, kind: 'phase', title: agent.parentId.replace('phase:', 'Phase '), status: 'queued' });
    }
  }
  // Phase status counts every child, kept or not.
  const shownPhases = phases
    .sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)))
    .slice(0, WORKFLOW_LIMITS.nodes)
    .map((phase) => ({ ...phase, status: phaseStatus(agents.filter((agent) => agent.parentId === phase.id)) }));
  const kept = keptAgents(agents, WORKFLOW_LIMITS.nodes - shownPhases.length);
  const omittedLeaves: WorkflowOmittedLeaves = {};
  for (const agent of agents) {
    if (kept.has(agent)) continue;
    const counts = omittedLeaves[agent.parentId ?? ''] ??= {};
    counts[agent.status] = (counts[agent.status] ?? 0) + 1;
  }
  const nodes: WorkflowNodeDto[] = [];
  for (const phase of shownPhases) {
    nodes.push(phase, ...agents.filter((agent) => agent.parentId === phase.id && kept.has(agent)));
  }
  nodes.push(...agents.filter((agent) => !agent.parentId && kept.has(agent)));
  return { nodes, ...(Object.keys(omittedLeaves).length > 0 ? { omittedLeaves } : {}) };
}

function agentIndex(agent: WorkflowNodeDto): number {
  return Number(agent.id.slice(6));
}

/**
 * The agents a capped run keeps: running and paused ones, then the newest.
 * The oldest finished agents are dropped first; their counts stay.
 */
function keptAgents(agents: readonly WorkflowNodeDto[], budget: number): ReadonlySet<WorkflowNodeDto> {
  if (agents.length <= budget) return new Set(agents);
  const open = (agent: WorkflowNodeDto) => agent.status === 'running' || agent.status === 'paused';
  const ranked = [...agents].sort((a, b) => Number(open(b)) - Number(open(a)) || agentIndex(b) - agentIndex(a));
  return new Set(ranked.slice(0, Math.max(0, budget)));
}

/** `run` with the node list (and omitted counts) of `graph`. */
function withGraph(run: WorkflowRunDtoV1, graph: ClaudeWorkflowGraph): WorkflowRunDtoV1 {
  const next: WorkflowRunDtoV1 = { ...run, nodes: graph.nodes };
  if (graph.omittedLeaves) next.omittedLeaves = graph.omittedLeaves;
  else delete next.omittedLeaves;
  return next;
}

function terminalStatus(raw: string | undefined): WorkflowRunStatus | undefined {
  if (raw === 'completed') return 'completed';
  if (raw === 'failed') return 'failed';
  if (raw === 'killed' || raw === 'stopped' || raw === 'cancelled') return 'cancelled';
  return undefined;
}

/** Close nodes, omitted ones included, still open when the run ends. */
function closeNodes(graph: ClaudeWorkflowGraph, status: WorkflowRunStatus, now: number): ClaudeWorkflowGraph {
  const nodes = settleWorkflowNodes(graph.nodes, status, now);
  if (!graph.omittedLeaves) return { nodes };
  const omittedLeaves: WorkflowOmittedLeaves = {};
  for (const [parentId, counts] of Object.entries(graph.omittedLeaves)) {
    const next: Partial<Record<WorkflowNodeStatus, number>> = {};
    for (const [from, count] of Object.entries(counts) as Array<[WorkflowNodeStatus, number]>) {
      const to = settledWorkflowNodeStatus(from, status) ?? from;
      next[to] = (next[to] ?? 0) + count;
    }
    omittedLeaves[parentId] = next;
  }
  return { nodes, omittedLeaves };
}

export function appendWorkflowLog(log: readonly WorkflowLogEntry[], entry: WorkflowLogEntry): WorkflowLogEntry[] {
  const last = log[log.length - 1];
  if (last && last.text === entry.text && last.nodeId === entry.nodeId) return [...log];
  return [...log, entry].slice(-WORKFLOW_LIMITS.log);
}

/** Seed fields from task_started. */
export function claudeWorkflowSeed(env: Envelope): Partial<WorkflowRunDtoV1> {
  const description = clampWorkflowText(env['description'], WORKFLOW_LIMITS.line);
  return {
    name: clampWorkflowText(env['workflow_name'], WORKFLOW_LIMITS.title) ?? description ?? 'Workflow',
    ...(description ? { description } : {}),
    ...(clampWorkflowText(env['prompt'], WORKFLOW_LIMITS.definition) ? { definition: clampWorkflowText(env['prompt'], WORKFLOW_LIMITS.definition) } : {}),
    parentToolCallId: str(env['tool_use_id']) ?? null,
  };
}

/** Fold one task frame of a tracked workflow into its run. */
export function applyClaudeWorkflowEnvelope(run: WorkflowRunDtoV1, env: Envelope, now: number): WorkflowRunDtoV1 {
  const subtype = str(env['subtype']);
  if (subtype === 'task_started') return { ...run, ...claudeWorkflowSeed(env), status: 'running' };
  if (isWorkflowRunTerminal(run.status) && subtype !== 'task_notification') return run;
  if (subtype === 'task_progress') {
    const usage = claudeTaskUsage(rec(env['usage']));
    const progress = env['workflow_progress'];
    return {
      ...(Array.isArray(progress) ? withGraph(run, claudeWorkflowNodes(progress, now)) : run),
      ...(usage ? { usage: { ...run.usage, ...usage } } : {}),
      ...(clampWorkflowText(env['description'], WORKFLOW_LIMITS.line) && run.status === 'running'
        ? { statusDetail: clampWorkflowText(env['description'], WORKFLOW_LIMITS.line) }
        : {}),
    };
  }
  if (subtype === 'task_updated') {
    const patch = rec(env['patch']);
    const status = terminalStatus(str(patch?.['status']));
    if (!status) return run;
    const endedAt = num(patch?.['end_time']) ?? now;
    const error = clampWorkflowText(patch?.['error'], WORKFLOW_LIMITS.line);
    return {
      ...withGraph(run, closeNodes(run, status, endedAt)),
      status,
      endedAt: run.endedAt ?? endedAt,
      ...(error ? { statusDetail: error } : {}),
    };
  }
  if (subtype === 'task_notification') {
    const status = terminalStatus(str(env['status'])) ?? run.status;
    const summary = clampWorkflowText(env['summary'], WORKFLOW_LIMITS.line);
    const usage = claudeTaskUsage(rec(env['usage']));
    const endedAt = run.endedAt ?? now;
    // The summary restates the workflow's description; on a stop or failure
    // it must not replace the reason already recorded.
    const keepDetail = status !== 'completed' && isWorkflowRunTerminal(run.status) && !!run.statusDetail;
    return {
      ...(isWorkflowRunTerminal(status) ? withGraph(run, closeNodes(run, status, endedAt)) : run),
      status,
      endedAt,
      ...(summary && !keepDetail ? { statusDetail: summary } : {}),
      ...(usage ? { usage: { ...run.usage, ...usage } } : {}),
    };
  }
  return run;
}

/**
 * The `.output` file written when the workflow ends:
 * `{ summary, agentCount, logs, result, workflowProgress }`.
 */
export function applyClaudeWorkflowOutput(run: WorkflowRunDtoV1, output: unknown, now: number): WorkflowRunDtoV1 {
  const raw = rec(output);
  if (!raw) return run;
  const resultValue = raw['result'];
  const result = typeof resultValue === 'string'
    ? clampWorkflowText(resultValue, WORKFLOW_LIMITS.result)
    : resultValue !== undefined && resultValue !== null
      ? clampWorkflowText(JSON.stringify(resultValue, null, 2), WORKFLOW_LIMITS.result)
      : undefined;
  let log = run.log;
  if (Array.isArray(raw['logs'])) {
    for (const line of raw['logs'] as unknown[]) {
      const text = clampWorkflowText(typeof line === 'string' ? line : rec(line)?.['message'], WORKFLOW_LIMITS.line);
      if (text) log = appendWorkflowLog(log, { at: now, text });
    }
  }
  const graph = Array.isArray(raw['workflowProgress'])
    ? closeNodes(claudeWorkflowNodes(raw['workflowProgress'], now), run.status, run.endedAt ?? now)
    : undefined;
  return { ...(graph && graph.nodes.length > 0 ? withGraph(run, graph) : run), ...(result ? { result } : {}), log };
}

/**
 * A CLI `control_response` (reply to a control_request Michi wrote):
 * `{ type: 'control_response', response: { subtype: 'success' | 'error', request_id, error? } }`.
 */
export function claudeControlResponse(env: Envelope): { requestId: string; ok: boolean; error?: string } | null {
  if (env['type'] !== 'control_response') return null;
  const response = rec(env['response']);
  const requestId = str(response?.['request_id']);
  if (!requestId) return null;
  const ok = response?.['subtype'] !== 'error';
  return { requestId, ok, ...(ok ? {} : { error: str(response?.['error']) ?? 'Claude rejected the request' }) };
}
