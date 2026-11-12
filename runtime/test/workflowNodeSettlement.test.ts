/**
 * How the runtime folds close a run's open nodes when the run ends, and how
 * Kiro reopens them when it starts the run again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowNodeDto, WorkflowRunDtoV1 } from 'michi-shared';
import { applyClaudeWorkflowEnvelope } from '../src/core/workflows/claudeWorkflowFold';
import { applyKiroWorkflowNotification } from '../src/core/workflows/kiroWorkflowFold';

function run(runtime: 'claude' | 'kiro', nodes: WorkflowNodeDto[]): WorkflowRunDtoV1 {
  return { version: 1, id: `${runtime}:wf`, runtime, nativeId: 'wf', workspaceId: 'w', nodeId: null, parentToolCallId: null,
    name: 'wf', status: 'running', nodes, log: [], actions: [], startedAt: 0, updatedAt: 0, revision: 0 };
}

const settled = (value: WorkflowRunDtoV1) => value.nodes.map((node) => [node.id, node.status, node.endedAt, node.currentTool]);

test('Claude: a killed run stops its running agents at the end time and skips the queued ones', () => {
  const start = run('claude', [
    { id: 'phase:0', kind: 'phase', title: 'Investigate', status: 'running' },
    { id: 'agent:0', kind: 'agent', title: 'a', parentId: 'phase:0', status: 'completed', startedAt: 1, endedAt: 4 },
    { id: 'agent:1', kind: 'agent', title: 'b', parentId: 'phase:0', status: 'running', startedAt: 2, currentTool: 'Read x' },
    { id: 'agent:2', kind: 'agent', title: 'c', parentId: 'phase:0', status: 'queued' },
  ]);
  const ended = applyClaudeWorkflowEnvelope(start, { type: 'system', subtype: 'task_updated', task_id: 'wf', patch: { status: 'killed', end_time: 9 } }, 10);
  assert.equal(ended.status, 'cancelled');
  assert.deepEqual(settled(ended), [
    ['phase:0', 'cancelled', 9, undefined],
    ['agent:0', 'completed', 4, undefined],
    ['agent:1', 'cancelled', 9, undefined],
    ['agent:2', 'skipped', undefined, undefined],
  ]);
});

test('Kiro: an aborted run stops its running and paused steps and skips the queued ones', () => {
  const start = run('kiro', [
    { id: 'a', kind: 'step', title: 'a', status: 'running', startedAt: 1, currentTool: 'Write a' },
    { id: 'b', kind: 'step', title: 'b', status: 'paused', startedAt: 2, statusMessage: 'Step requested user input via send_message.' },
    { id: 'c', kind: 'step', title: 'c', status: 'queued', planned: true },
  ]);
  const ended = applyKiroWorkflowNotification(start, '_kiro/workflow/run_complete', { workflowId: 'wf', status: 'aborted' }, 10);
  assert.equal(ended.status, 'cancelled');
  assert.deepEqual(settled(ended), [
    ['a', 'cancelled', 10, undefined],
    ['b', 'cancelled', 10, undefined],
    ['c', 'skipped', undefined, undefined],
  ]);
  assert.equal(ended.nodes[2].planned, undefined);
});

test('Kiro: starting the run again puts steps that never started back in the queue, and keeps what ran', () => {
  const tree = [{ nodeId: 'a', type: 'step' }, { nodeId: 'skip', type: 'step' }, { nodeId: 'b', type: 'step' }, { nodeId: 'c', type: 'step' }];
  let value = applyKiroWorkflowNotification(run('kiro', []), '_kiro/workflow/run_start', { workflowId: 'wf', nodeTree: tree }, 0);
  value = applyKiroWorkflowNotification(value, '_kiro/workflow/node_complete', { workflowId: 'wf', nodeId: 'skip', status: 'skipped' }, 1);
  value = applyKiroWorkflowNotification(value, '_kiro/workflow/node_start', { workflowId: 'wf', nodeId: 'a', nodePath: ['wf', 'a'], type: 'step' }, 1);
  value = applyKiroWorkflowNotification(value, '_kiro/workflow/run_complete', { workflowId: 'wf', status: 'aborted' }, 2);
  assert.deepEqual(value.nodes.map((node) => node.status), ['cancelled', 'skipped', 'skipped', 'skipped']);
  const retried = applyKiroWorkflowNotification(value, '_kiro/workflow/run_start', { workflowId: 'wf', nodeTree: tree }, 3);
  assert.equal(retried.status, 'running');
  assert.deepEqual(retried.nodes.map((node) => [node.id, node.status]), [['a', 'cancelled'], ['skip', 'skipped'], ['b', 'queued'], ['c', 'queued']]);
  const restarted = applyKiroWorkflowNotification(retried, '_kiro/workflow/node_start', { workflowId: 'wf', nodeId: 'a', nodePath: ['wf', 'a'], type: 'step' }, 4);
  const a = restarted.nodes.find((node) => node.id === 'a');
  assert.deepEqual([a?.status, a?.startedAt, a?.endedAt], ['running', 1, undefined]);
});
