/**
 * The result a Claude workflow's `.output` file carries, as the run keeps it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_LIMITS, type WorkflowRunDtoV1 } from 'michi-shared';
import { applyClaudeWorkflowOutput } from '../src/core/workflows/claudeWorkflowFold';

const run: WorkflowRunDtoV1 = { version: 1, id: 'claude:wf', runtime: 'claude', nativeId: 'wf', workspaceId: 'w', nodeId: null, parentToolCallId: null,
  name: 'wf', status: 'completed', nodes: [], log: [], actions: [], startedAt: 0, updatedAt: 0, revision: 0 };

test('a result object is kept indented when it fits and by structure when it does not', () => {
  const small = { docs: [{ file: 'tokens.md', rules: 34 }] };
  assert.equal(applyClaudeWorkflowOutput(run, { result: small }, 1).result, JSON.stringify(small, null, 2));

  const docs = ['tokens', 'motion', 'transitions', 'states'].map((name) => ({ file: `${name}.md`, notes: Array.from({ length: 12 }, (_, index) => `${name} note ${index}: ${'x'.repeat(2_000)}`) }));
  const result = applyClaudeWorkflowOutput(run, { result: { docs, core: 'Core check passed.' } }, 1).result!;
  assert.ok(result.length <= WORKFLOW_LIMITS.runResult);
  const kept = JSON.parse(result) as { docs: Array<{ file: string }>; core: string };
  assert.deepEqual(kept.docs.map((doc) => doc.file), ['tokens.md', 'motion.md', 'transitions.md', 'states.md']);
  assert.equal(kept.core, 'Core check passed.');
  assert.equal(applyClaudeWorkflowOutput(run, { result: null }, 1).result, undefined);
});
