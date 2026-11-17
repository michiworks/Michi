import type { WorkflowNodeDto, WorkflowRunDtoV1 } from './workflowRuns';

/**
 * A live change to a workflow run against the revision its subscriber last
 * got on the same feed: the run's fields that changed, as whole values, and
 * of its steps only the fields that changed (a new step whole); `order`
 * lists every step id when steps came, went or moved. A long run's progress
 * then costs a few hundred bytes a change instead of the whole run. A
 * subscriber holding another revision reads the run whole instead.
 */
export interface WorkflowRunPatchV1 {
  id: string;
  baseRevision: number;
  revision: number;
  set?: Partial<WorkflowRunDtoV1>;
  unset?: string[];
  nodes?: WorkflowNodePatchV1[];
  order?: string[];
}

export interface WorkflowNodePatchV1 {
  id: string;
  set?: Partial<WorkflowNodeDto>;
  unset?: string[];
}

/** Run fields a patch never carries: the steps go by `nodes`, the rest never change or are the patch's own. */
const RUN_KEYS_APART = new Set(['id', 'version', 'revision', 'nodes', 'partial']);
const NODE_KEYS_APART = new Set(['id']);

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && JSON.stringify(a) === JSON.stringify(b));
}

function fieldChanges(previous: object, next: object, apart: ReadonlySet<string>): { set?: Record<string, unknown>; unset?: string[] } {
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (!apart.has(key) && value !== undefined && !sameValue(before[key], value)) set[key] = value;
  }
  for (const [key, value] of Object.entries(before)) {
    if (!apart.has(key) && value !== undefined && after[key] === undefined) unset.push(key);
  }
  return { ...(Object.keys(set).length > 0 ? { set } : {}), ...(unset.length > 0 ? { unset } : {}) };
}

/** What changed from `previous` to `next`, the same run a revision later. */
export function diffWorkflowRun(previous: WorkflowRunDtoV1, next: WorkflowRunDtoV1): WorkflowRunPatchV1 {
  const patch: WorkflowRunPatchV1 = { id: next.id, baseRevision: previous.revision, revision: next.revision, ...fieldChanges(previous, next, RUN_KEYS_APART) };
  const before = new Map(previous.nodes.map((node) => [node.id, node]));
  const nodes: WorkflowNodePatchV1[] = [];
  for (const node of next.nodes) {
    const old = before.get(node.id);
    if (old === node) continue;
    const change = old ? fieldChanges(old, node, NODE_KEYS_APART) : fieldChanges({}, node, NODE_KEYS_APART);
    if (change.set || change.unset) nodes.push({ id: node.id, ...change });
  }
  if (nodes.length > 0) patch.nodes = nodes;
  if (next.nodes.length !== previous.nodes.length || next.nodes.some((node, index) => previous.nodes[index].id !== node.id)) {
    patch.order = next.nodes.map((node) => node.id);
  }
  return patch;
}

/**
 * `run` with `patch` applied; null when the patch is for another run or
 * another revision. The result is not validated: parse it like any run.
 */
export function applyWorkflowRunPatch(run: WorkflowRunDtoV1, patch: WorkflowRunPatchV1): WorkflowRunDtoV1 | null {
  if (run.id !== patch.id || run.revision !== patch.baseRevision) return null;
  const out: Record<string, unknown> = { ...run };
  for (const [key, value] of Object.entries(patch.set ?? {})) if (!RUN_KEYS_APART.has(key)) out[key] = value;
  for (const key of patch.unset ?? []) if (!RUN_KEYS_APART.has(key)) delete out[key];
  out.revision = patch.revision;
  const changes = new Map((patch.nodes ?? []).map((change) => [change.id, change]));
  const current = new Map(run.nodes.map((node) => [node.id, node]));
  const nodes: WorkflowNodeDto[] = [];
  for (const id of patch.order ?? run.nodes.map((node) => node.id)) {
    const node = current.get(id);
    const change = changes.get(id);
    if (!change) {
      if (node) nodes.push(node);
      continue;
    }
    const merged: Record<string, unknown> = { ...node };
    for (const [key, value] of Object.entries(change.set ?? {})) if (!NODE_KEYS_APART.has(key)) merged[key] = value;
    for (const key of change.unset ?? []) if (!NODE_KEYS_APART.has(key)) delete merged[key];
    merged.id = id;
    nodes.push(merged as unknown as WorkflowNodeDto);
  }
  out.nodes = nodes;
  return out as unknown as WorkflowRunDtoV1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A patch's shape; what it sets is checked when the patched run is parsed. */
export function parseWorkflowRunPatch(value: unknown): WorkflowRunPatchV1 | null {
  const raw = record(value);
  const id = typeof raw?.id === 'string' && raw.id ? raw.id : undefined;
  const baseRevision = finite(raw?.baseRevision);
  const revision = finite(raw?.revision);
  if (!raw || !id || baseRevision === undefined || revision === undefined) return null;
  const patch: WorkflowRunPatchV1 = { id, baseRevision, revision };
  const set = record(raw.set);
  if (set) patch.set = set as Partial<WorkflowRunDtoV1>;
  const unset = strings(raw.unset);
  if (unset) patch.unset = unset;
  const order = strings(raw.order);
  if (order) patch.order = order;
  if (Array.isArray(raw.nodes)) {
    const nodes: WorkflowNodePatchV1[] = [];
    for (const item of raw.nodes) {
      const node = record(item);
      if (!node || typeof node.id !== 'string' || !node.id) return null;
      const change: WorkflowNodePatchV1 = { id: node.id };
      const fields = record(node.set);
      if (fields) change.set = fields as Partial<WorkflowNodeDto>;
      const removed = strings(node.unset);
      if (removed) change.unset = removed;
      nodes.push(change);
    }
    patch.nodes = nodes;
  }
  return patch;
}
