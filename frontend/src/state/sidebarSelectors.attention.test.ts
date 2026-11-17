import { describe, it, expect } from 'vitest';
import {
  FAILED_MARK_MS,
  hiddenBranchAttention,
  maxAttention,
  nodeAttention,
  subtreeAttention,
  type RowAttention,
} from './sidebarSelectors';
import { workspaceAttention } from './sidebarSelectors';
import type { ChatNodeState, Project, ProjectEdge, Tree } from './chatTypes';
import type { TreeNode } from './tree';

const NOW = 1_700_000_000_000;

function node(over: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n1', kind: 'chat', chatId: 'c1', projectId: 'p1',
    messages: [], followUps: [], status: 'idle',
    ...over,
  } as ChatNodeState;
}

const permission = { requestId: 'r1', title: 'Run rg', options: [] } as unknown as ChatNodeState['pendingPermission'];
const question = { questions: [{ question: 'which one?' }] } as unknown as ChatNodeState['pendingUserInput'];
const failed = (over: Partial<ChatNodeState> = {}) =>
  node({ status: 'error', error: 'Agent exited', errorCompletedAt: NOW - 1000, viewedAt: 10, ...over });

describe('nodeAttention', () => {
  it('waits on the user for a permission request, and for a question still open', () => {
    expect(nodeAttention('n1', node({ status: 'streaming', pendingPermission: permission }), null, NOW)).toBe('waiting');
    expect(nodeAttention('n1', node({ status: 'streaming', pendingUserInput: question }), null, NOW)).toBe('waiting');
    const answered = { ...question, resolved: true } as ChatNodeState['pendingUserInput'];
    expect(nodeAttention('n1', node({ status: 'streaming', pendingUserInput: answered }), null, NOW)).toBe('none');
  });

  it('keeps waiting on the focused row: the request is open whether or not you are looking', () => {
    expect(nodeAttention('n1', node({ status: 'streaming', pendingPermission: permission }), 'n1', NOW)).toBe('waiting');
  });

  it('marks a failure the user has not looked at since', () => {
    expect(nodeAttention('n1', failed(), null, NOW)).toBe('failed');
  });

  it('drops a failure once the node was viewed after it, and on the row being read', () => {
    expect(nodeAttention('n1', failed({ viewedAt: NOW - 500 }), null, NOW)).toBe('none');
    expect(nodeAttention('n1', failed(), 'n1', NOW)).toBe('none');
  });

  it('drops a failure older than the mark window, and one with no time at all', () => {
    expect(nodeAttention('n1', failed({ errorCompletedAt: NOW - FAILED_MARK_MS - 1 }), null, NOW)).toBe('none');
    expect(nodeAttention('n1', failed({ errorCompletedAt: undefined }), null, NOW)).toBe('none');
  });

  it('leaves an interrupted turn to the Interrupted notice, which can resume it', () => {
    expect(nodeAttention('n1', failed({ errorKind: 'backend_restarted' }), null, NOW)).toBe('none');
    expect(nodeAttention('n1', failed({ errorKind: 'credentials_expired' }), null, NOW)).toBe('none');
    // Any other failure is this mark's.
    expect(nodeAttention('n1', failed({ errorKind: 'turn_persistence_failed' }), null, NOW)).toBe('failed');
  });

  it('says nothing of a conversation no thread list shows, or of a node that is gone', () => {
    expect(nodeAttention('n1', failed({ pageId: 'page-1' }), null, NOW)).toBe('none');
    expect(nodeAttention('n1', failed({ maintenanceJobId: 'job-1' }), null, NOW)).toBe('none');
    expect(nodeAttention('n1', node({ status: 'streaming', pendingPermission: permission, scheduledOnlyJobId: 'j' }), null, NOW)).toBe('none');
    expect(nodeAttention('n1', undefined, null, NOW)).toBe('none');
  });

  it('says nothing of a running or an idle turn', () => {
    expect(nodeAttention('n1', node({ status: 'streaming' }), null, NOW)).toBe('none');
    expect(nodeAttention('n1', node(), null, NOW)).toBe('none');
  });
});

describe('rolling attention up a subtree', () => {
  const edges: ProjectEdge[] = [
    { source: 'root', target: 'b1', kind: 'branch' } as ProjectEdge,
    { source: 'b1', target: 'b2', kind: 'branch' } as ProjectEdge,
    { source: 'root', target: 'dead', kind: 'branch' } as ProjectEdge,
    { source: 'dead', target: 'under-dead', kind: 'branch' } as ProjectEdge,
  ];
  const alive = (id: string) => id !== 'dead';
  const of = (marks: Record<string, RowAttention>) => (id: string) => marks[id] ?? 'none';

  it('takes the strongest state in the subtree: waiting over failed over none', () => {
    expect(subtreeAttention('root', edges, alive, of({ b2: 'failed' }))).toBe('failed');
    expect(subtreeAttention('root', edges, alive, of({ b1: 'failed', b2: 'waiting' }))).toBe('waiting');
    expect(subtreeAttention('root', edges, alive, of({}))).toBe('none');
  });

  it('skips a deleted branch with everything under it', () => {
    expect(subtreeAttention('root', edges, alive, of({ 'under-dead': 'waiting' }))).toBe('none');
    expect(subtreeAttention('dead', edges, alive, of({ dead: 'waiting' }))).toBe('none');
  });

  it('reads only below a collapsed branch, deeply', () => {
    const children: TreeNode[] = [{ nodeId: 'b1', depth: 1, children: [{ nodeId: 'b2', depth: 2, children: [] }] }];
    expect(hiddenBranchAttention(children, of({ b2: 'waiting' }))).toBe('waiting');
    expect(hiddenBranchAttention(children, of({ root: 'waiting' }))).toBe('none');
    expect(hiddenBranchAttention([], of({ b2: 'waiting' }))).toBe('none');
  });

  it('maxAttention ranks waiting over failed over none', () => {
    expect(maxAttention('failed', 'waiting')).toBe('waiting');
    expect(maxAttention('waiting', 'failed')).toBe('waiting');
    expect(maxAttention('none', 'failed')).toBe('failed');
    expect(maxAttention('none', 'none')).toBe('none');
  });
});

describe('workspaceAttention (what a folded workspace says)', () => {
  const tree = (id: string, rootNodeId: string, over: Partial<Tree> = {}): Tree =>
    ({ id, rootNodeId, createdAt: 0, lastActiveAt: NOW, ...over }) as Tree;
  const project = (trees: Tree[], edges: ProjectEdge[] = []): Pick<Project, 'trees' | 'edges'> => ({ trees, edges });

  it('takes the strongest state over its threads', () => {
    const nodes = {
      r1: failed({ nodeId: 'r1' }),
      r2: node({ nodeId: 'r2', status: 'streaming', pendingPermission: permission }),
    };
    expect(workspaceAttention(project([tree('t1', 'r1')]), nodes, null, NOW)).toBe('failed');
    expect(workspaceAttention(project([tree('t1', 'r1'), tree('t2', 'r2')]), nodes, null, NOW)).toBe('waiting');
  });

  it('reaches a branch under a thread', () => {
    const nodes = { r1: node({ nodeId: 'r1' }), b1: failed({ nodeId: 'b1' }) };
    const edges = [{ source: 'r1', target: 'b1', kind: 'branch' } as ProjectEdge];
    expect(workspaceAttention(project([tree('t1', 'r1')], edges), nodes, null, NOW)).toBe('failed');
  });

  it('marks nothing it cannot lead the user to: an archived or trashed thread', () => {
    const nodes = { r1: failed({ nodeId: 'r1' }) };
    expect(workspaceAttention(project([tree('t1', 'r1', { archivedAt: NOW })]), nodes, null, NOW)).toBe('none');
    expect(workspaceAttention(project([tree('t1', 'r1')]), { r1: failed({ nodeId: 'r1', deletedAt: NOW }) }, null, NOW)).toBe('none');
  });

  it('says nothing when every thread is quiet', () => {
    expect(workspaceAttention(project([tree('t1', 'r1')]), { r1: node({ nodeId: 'r1' }) }, null, NOW)).toBe('none');
    expect(workspaceAttention(project([]), {}, null, NOW)).toBe('none');
  });
});
