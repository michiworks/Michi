import { isWorkflowContainerNode, isWorkflowWorkNode, type WorkflowNodeDto, type WorkflowRunDtoV1 } from 'michi-shared';
import { workflowNodeRows } from '../workflows/workflowPresentation';

/**
 * What the Background work drawer's workflow card shows, derived from a run:
 * its sections (a Claude phase, a Kiro parallel/loop, or the steps between
 * them), each leaf's state, and the names and model the card states once
 * instead of on every row.
 */

/** A leaf's state on the card: its node status, or `waiting` while an approval names it. */
export type CardLeafState = WorkflowNodeDto['status'] | 'waiting';

/** running: a leaf runs or waits. done: every leaf ended. queued: nothing started. */
type CardSectionState = 'running' | 'done' | 'queued';

export interface CardSection {
  /** The top-level container this section is; absent for top-level leaves. */
  node?: WorkflowNodeDto;
  /** Every node that is not a container (agents, steps, watches), nested containers flattened, in tree order. */
  leaves: WorkflowNodeDto[];
  state: CardSectionState;
}

function sectionState(node: WorkflowNodeDto | undefined, leaves: readonly WorkflowNodeDto[]): CardSectionState {
  if (leaves.length === 0) {
    if (node?.status === 'running' || node?.status === 'paused') return 'running';
    return node && node.status !== 'queued' && node.status !== 'skipped' ? 'done' : 'queued';
  }
  if (leaves.some((leaf) => leaf.status === 'running' || leaf.status === 'paused')) return 'running';
  if (leaves.every((leaf) => leaf.status === 'queued' || leaf.status === 'skipped')) return 'queued';
  if (leaves.some((leaf) => leaf.status === 'queued')) return 'running';
  return 'done';
}

/**
 * The run as sections: each top-level container is one, with every leaf
 * under it; leaves at the top level between containers form untitled ones.
 */
export function workflowCardSections(nodes: readonly WorkflowNodeDto[]): CardSection[] {
  const sections: Array<{ node?: WorkflowNodeDto; leaves: WorkflowNodeDto[] }> = [];
  let current: { node?: WorkflowNodeDto; leaves: WorkflowNodeDto[] } | undefined;
  for (const { node, depth } of workflowNodeRows(nodes)) {
    if (depth === 0) {
      if (isWorkflowContainerNode(node)) {
        current = { node, leaves: [] };
        sections.push(current);
        continue;
      }
      if (!current || current.node) {
        current = { leaves: [] };
        sections.push(current);
      }
      current.leaves.push(node);
      continue;
    }
    if (!isWorkflowContainerNode(node)) current?.leaves.push(node);
  }
  return sections.map((section) => ({ ...section, state: sectionState(section.node, section.leaves) }));
}

/** Leaves the card counts: agents and steps. */
export function workflowCardLeaves(nodes: readonly WorkflowNodeDto[]): WorkflowNodeDto[] {
  return nodes.filter(isWorkflowWorkNode);
}

/** Claude-style runs are a sequence of phases: the card draws them as steps. */
export function hasPhaseSteps(sections: readonly CardSection[]): boolean {
  return sections.length > 0 && sections.every((section) => section.node?.kind === 'phase');
}

/** Node ids an open approval names. */
export function waitingNodeIds(run: Pick<WorkflowRunDtoV1, 'approvals'>): ReadonlySet<string> {
  return new Set((run.approvals ?? []).flatMap((approval) => (approval.nodeId ? [approval.nodeId] : [])));
}

export function cardLeafState(node: WorkflowNodeDto, waiting: ReadonlySet<string>): CardLeafState {
  const open = node.status === 'running' || node.status === 'paused' || node.status === 'queued';
  return open && waiting.has(node.id) ? 'waiting' : node.status;
}

/** "investigate:sdk-cli" under Investigate reads "sdk-cli": the section already says the phase. */
export function leafLabel(node: WorkflowNodeDto, section?: WorkflowNodeDto): string {
  const title = node.title.trim();
  const prefix = section?.title.trim().toLowerCase();
  if (!prefix) return title;
  for (const separator of [':', '/', ' · ', ' - ']) {
    const head = `${prefix}${separator}`;
    if (title.toLowerCase().startsWith(head) && title.length > head.length) return title.slice(head.length).trim();
  }
  return title;
}

/** "claude-runtime-ultracode-feasibility" → "Claude runtime ultracode feasibility". */
export function workflowDisplayName(name: string): string {
  const trimmed = name.trim();
  const words = /\s/.test(trimmed) ? trimmed : trimmed.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** The one model every leaf that names a model uses, so the card says it once. */
export function sharedModel(leaves: readonly WorkflowNodeDto[]): string | undefined {
  const models = new Set(leaves.flatMap((leaf) => (leaf.model ? [leaf.model] : [])));
  return models.size === 1 ? [...models][0] : undefined;
}

const TOOL_NAME = /^(?:[A-Z][A-Za-z0-9_]*|mcp__[\w-]+)$/;

/** "Bash cd /tmp && ls" → tool "Bash", argument "cd /tmp && ls"; a line not led by a tool name is all argument. */
export function splitToolLine(line: string): { tool?: string; arg: string } {
  const text = line.trim();
  const space = text.search(/\s/);
  const head = space < 0 ? text : text.slice(0, space);
  if (!TOOL_NAME.test(head)) return { arg: text };
  return { tool: head, arg: space < 0 ? '' : text.slice(space).trim() };
}

/** Wall time of a section: first start to last end (now while running). */
export function sectionDurationMs(leaves: readonly WorkflowNodeDto[], now: number): number | undefined {
  const starts = leaves.flatMap((leaf) => (leaf.startedAt !== undefined ? [leaf.startedAt] : []));
  if (starts.length === 0) return undefined;
  const ends = leaves.map((leaf) => leaf.endedAt ?? (leaf.status === 'running' || leaf.status === 'paused' ? now : leaf.startedAt ?? 0));
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}
