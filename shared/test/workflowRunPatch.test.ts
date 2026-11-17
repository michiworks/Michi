import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowRunDtoV1 } from '../src/workflowRuns';
import { applyWorkflowRunPatch, diffWorkflowRun, parseWorkflowRunPatch } from '../src/workflowRunPatch';

const run = (patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 => ({
  version: 1, id: 'wfr_1', runtime: 'claude', nativeId: 'wf', workspaceId: 'ws', nodeId: 'n1', parentToolCallId: null,
  name: 'audit', status: 'running', log: [], actions: ['stop'], startedAt: 1, updatedAt: 1, revision: 1,
  nodes: Array.from({ length: 120 }, (_, i) => ({ id: `agent:${i}`, kind: 'agent' as const, title: `slice ${i}`, status: 'running' as const, prompt: 'p'.repeat(2_000), currentTool: 'Read a.ts' })),
  ...patch,
});

test('a change to one step carries that step\'s changed fields only, and rebuilds the run', () => {
  const before = run();
  const after = run({
    revision: 2, updatedAt: 2, usage: { totalTokens: 9 },
    nodes: before.nodes.map((node, i) => (i === 7 ? { ...node, status: 'completed' as const, currentTool: undefined, result: 'done' } : node)),
  });
  const patch = diffWorkflowRun(before, after);
  assert.deepEqual(patch, {
    id: 'wfr_1', baseRevision: 1, revision: 2, set: { updatedAt: 2, usage: { totalTokens: 9 } },
    nodes: [{ id: 'agent:7', set: { status: 'completed', result: 'done' }, unset: ['currentTool'] }],
  });
  assert.ok(JSON.stringify(patch).length < JSON.stringify(after).length / 500);
  // As the wire has it: a field set to undefined is not there.
  assert.deepEqual(applyWorkflowRunPatch(before, parseWorkflowRunPatch(JSON.parse(JSON.stringify(patch)))!), JSON.parse(JSON.stringify(after)));
});

test('new, gone and moved steps come with the order; run fields can go', () => {
  const before = run({ statusDetail: 'Working', nodes: run().nodes.slice(0, 3) });
  const after = run({ revision: 5, nodes: [before.nodes[2], before.nodes[0], { id: 'agent:new', kind: 'agent', title: 'new', status: 'queued' }] });
  const patch = diffWorkflowRun(before, after);
  assert.deepEqual(patch.order, ['agent:2', 'agent:0', 'agent:new']);
  assert.deepEqual(patch.unset, ['statusDetail']);
  assert.deepEqual(applyWorkflowRunPatch(before, patch), after);
});

test('a patch applies only to the run and revision it was made against', () => {
  const patch = diffWorkflowRun(run(), run({ revision: 2 }));
  assert.equal(applyWorkflowRunPatch(run({ revision: 3 }), patch), null);
  assert.equal(applyWorkflowRunPatch(run({ id: 'wfr_2' }), patch), null);
  assert.equal(parseWorkflowRunPatch({ id: 'wfr_1', baseRevision: 1 }), null);
  assert.equal(parseWorkflowRunPatch({ id: 'wfr_1', baseRevision: 1, revision: 2, nodes: [{ set: {} }] }), null);
});
