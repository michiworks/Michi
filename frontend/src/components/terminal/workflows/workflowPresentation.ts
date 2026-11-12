import {
  formatTokenCount,
  isWorkflowWorkNode,
  type WorkflowAction,
  type WorkflowApprovalDto,
  type WorkflowNodeDto,
  type WorkflowNodeStatus,
  type WorkflowRunDtoV1,
  type WorkflowRunStatus,
} from 'michi-shared';
import { formatDuration } from '../../../lib/duration';

/** Run status colors follow AgentRunCard (completed reads as digest). */
export const WORKFLOW_STATUS_COLOR: Record<WorkflowRunStatus, string> = {
  running: 'var(--term-run)',
  paused: 'var(--term-select)',
  completed: 'var(--term-digest)',
  failed: 'var(--term-danger)',
  cancelled: 'var(--term-muted)',
};

export const WORKFLOW_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
};

/** A run's status chip, on its chat card and in Background work: a filled pill. */
export const WORKFLOW_CHIP: Record<WorkflowRunStatus, { label: string; color: string; fill: string }> = {
  running: { label: 'Running', color: 'var(--term-run)', fill: 'var(--term-run-f)' },
  paused: { label: 'Paused', color: 'var(--term-waiting-text)', fill: 'var(--term-waiting-f)' },
  completed: { label: 'Done', color: 'var(--term-digest)', fill: 'var(--term-digest-f)' },
  failed: { label: 'Failed', color: 'var(--term-danger-text)', fill: 'color-mix(in srgb, var(--term-danger) 14%, transparent)' },
  cancelled: { label: 'Stopped', color: 'var(--term-muted)', fill: 'var(--term-alt)' },
};
export const WORKFLOW_NEEDS_YOU_CHIP = { label: 'Needs you', color: 'var(--term-waiting-text)', fill: 'var(--term-waiting-f)' };

export const NODE_STATUS_COLOR: Record<WorkflowNodeStatus, string> = {
  queued: 'var(--term-faint)',
  running: 'var(--term-run)',
  paused: 'var(--term-select)',
  completed: 'var(--term-muted)',
  failed: 'var(--term-danger)',
  cancelled: 'var(--term-muted)',
  skipped: 'var(--term-faint)',
};

export const NODE_STATUS_LABEL: Record<WorkflowNodeStatus, string> = {
  queued: 'queued',
  running: 'running',
  paused: 'paused',
  completed: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  skipped: 'skipped',
};

/**
 * Which step an approval comes from, for its row in chat and in Background
 * work; a session-wide request names none, and the tooltip says why.
 */
export function workflowApprovalSource(run: Pick<WorkflowRunDtoV1, 'nodes'>, approval: WorkflowApprovalDto): { label?: string; title?: string } {
  if (approval.nodeId) return { label: run.nodes.find((node) => node.id === approval.nodeId)?.title ?? approval.nodeId };
  if (approval.scope !== 'session') return {};
  return {
    label: 'from this chat',
    title: 'The runtime does not say which agent asked. This request shows on each running workflow of the chat; answering it once answers it everywhere.',
  };
}

export const ACTION_LABEL: Record<WorkflowAction, string> = {
  stop: 'Stop',
  pause: 'Pause',
  resume: 'Resume',
  retry: 'Retry',
};

export const RUNTIME_LABEL: Record<WorkflowRunDtoV1['runtime'], string> = {
  claude: 'Claude Code',
  kiro: 'Kiro CLI',
  michi: 'Michi',
};

/** What a run's members are called: Claude's agents, Kiro's steps, a multi-model run's branches. */
export const RUN_NOUN: Record<WorkflowRunDtoV1['runtime'], string> = {
  claude: 'agents',
  kiro: 'steps',
  michi: 'branches',
};

/** RUN_NOUN capitalized, for headings ('Agents', 'Steps', 'Branches'). */
export function runNounTitle(runtime: WorkflowRunDtoV1['runtime']): string {
  const noun = RUN_NOUN[runtime];
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

function workflowRunOpen(run: Pick<WorkflowRunDtoV1, 'endedAt' | 'status'>): boolean {
  return run.endedAt === undefined && (run.status === 'running' || run.status === 'paused');
}

export function workflowElapsedMs(run: Pick<WorkflowRunDtoV1, 'startedAt' | 'endedAt' | 'status'>, now = Date.now()): number {
  const end = run.endedAt ?? (workflowRunOpen(run) ? now : run.startedAt);
  return Math.max(0, end - run.startedAt);
}

/** Counted in whole seconds while the run is open, like every live clock. */
export function workflowElapsedLabel(run: Pick<WorkflowRunDtoV1, 'startedAt' | 'endedAt' | 'status'>, now = Date.now()): string {
  return formatDuration(workflowElapsedMs(run, now), { live: workflowRunOpen(run) });
}

export function nodeDurationMs(node: WorkflowNodeDto, now = Date.now()): number | undefined {
  if (node.usage?.durationMs !== undefined) return node.usage.durationMs;
  if (node.startedAt === undefined) return undefined;
  const end = node.endedAt ?? (node.status === 'running' ? now : undefined);
  return end !== undefined && end >= node.startedAt ? end - node.startedAt : undefined;
}

/** Nodes in tree order with their depth (parents precede children). */
export function workflowNodeRows(nodes: readonly WorkflowNodeDto[]): Array<{ node: WorkflowNodeDto; depth: number }> {
  const byParent = new Map<string | undefined, WorkflowNodeDto[]>();
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : undefined;
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  const rows: Array<{ node: WorkflowNodeDto; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, depth: number) => {
    for (const node of byParent.get(parent) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      rows.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

/**
 * What the run is doing right now: the one running step, when there is
 * one, and what it does (its tool, status message or the run's latest word).
 */
export function workflowNow(run: WorkflowRunDtoV1): { step?: string; detail: string } | undefined {
  if (run.status !== 'running' && run.status !== 'paused') return undefined;
  if (run.status === 'paused') return run.statusDetail ? { detail: run.statusDetail } : undefined;
  const active = run.nodes.filter((node) => node.status === 'running' && isWorkflowWorkNode(node));
  if (active.length === 1) {
    const [node] = active;
    const detail = node.currentTool ?? node.statusMessage;
    return detail ? { step: node.title, detail } : { detail: node.title };
  }
  if (active.length > 1) return { detail: `${active.length} agents: ${active.map((node) => node.title).join(', ')}` };
  const latest = run.log.at(-1)?.text ?? run.statusDetail;
  return latest ? { detail: latest } : undefined;
}

export function formatWorkflowTokens(tokens: number | undefined): string | undefined {
  if (tokens === undefined || tokens <= 0) return undefined;
  return `${formatTokenCount(tokens)} tokens`;
}
