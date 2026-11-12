import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isWorkflowContainerNode,
  isWorkflowWorkNode,
  type WorkflowNodeDto,
  type WorkflowNodeKind,
} from '../src/index';

const node = (id: string, kind: WorkflowNodeKind): WorkflowNodeDto => ({ id, kind, title: id, status: 'queued' });

test('every node kind has one role: containers hold work, agents and steps do it, a watch waits', () => {
  const kinds: WorkflowNodeKind[] = ['phase', 'agent', 'step', 'parallel', 'loop', 'branch', 'group', 'watch'];
  assert.deepEqual(kinds.filter((kind) => isWorkflowContainerNode(node(kind, kind))), ['phase', 'parallel', 'loop', 'branch', 'group']);
  assert.deepEqual(kinds.filter((kind) => isWorkflowWorkNode(node(kind, kind))), ['agent', 'step']);
  assert.deepEqual(kinds.filter((kind) => !isWorkflowContainerNode(node(kind, kind)) && !isWorkflowWorkNode(node(kind, kind))), ['watch']);
});
