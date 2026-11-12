import { describe, expect, it, vi } from 'vitest';
import type { Project, Tree } from './chatTypes';
import { navigateToNode } from './navigateToNode';

const tree = (id: string, rootNodeId: string): Tree => ({ id, rootNodeId, createdAt: 1, lastActiveAt: 1 });

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    chatIds: ['r1', 'a', 'r2', 'b', 'digest'],
    edges: [
      { source: 'r1', target: 'a' },
      { source: 'r2', target: 'b' },
      { source: 'b', target: 'digest', kind: 'digest-source' },
    ],
    trees: [tree('t1', 'r1'), tree('t2', 'r2')],
    activeTreeId: 't1',
    createdAt: 1,
    ...overrides,
  };
}

function deps(projects: Project[], activeProjectId: string | null) {
  return {
    projects,
    activeProjectId,
    selectProject: vi.fn(),
    openPane: vi.fn(),
    openPaneInTree: vi.fn(),
    activateTree: vi.fn(),
    setFocusedNodeId: vi.fn(),
  };
}

describe('navigateToNode', () => {
  it('opens a node of the shown thread in the current slot', () => {
    const d = deps([project('w1')], 'w1');
    navigateToNode(d, 'a');
    expect(d.openPane).toHaveBeenCalledWith('a');
    expect(d.openPaneInTree).not.toHaveBeenCalled();
    expect(d.selectProject).not.toHaveBeenCalled();
    expect(d.activateTree).not.toHaveBeenCalled();
    expect(d.setFocusedNodeId).toHaveBeenCalledWith('a');
  });

  it('seeds another thread\'s slot before switching to it', () => {
    const d = deps([project('w1')], 'w1');
    navigateToNode(d, 'b');
    expect(d.openPaneInTree).toHaveBeenCalledWith('w1', 't2', 'b');
    expect(d.activateTree).toHaveBeenCalledWith('t2', 'w1');
    expect(d.openPane).not.toHaveBeenCalled();
    expect(d.setFocusedNodeId).toHaveBeenCalledWith('b');
  });

  it('switches workspace and seeds the destination slot', () => {
    const d = deps([project('w1'), project('w2', { chatIds: ['x'], edges: [], trees: [tree('tx', 'x')], activeTreeId: 'tx' })], 'w1');
    navigateToNode(d, 'x');
    expect(d.selectProject).toHaveBeenCalledWith('w2');
    expect(d.openPaneInTree).toHaveBeenCalledWith('w2', 'tx', 'x');
    expect(d.activateTree).toHaveBeenCalledWith('tx', 'w2');
    expect(d.setFocusedNodeId).toHaveBeenCalledWith('x');
  });

  it('opens a digest in its source\'s thread, which no branch edge reaches', () => {
    const d = deps([project('w1')], 'w1');
    navigateToNode(d, 'digest');
    expect(d.openPaneInTree).toHaveBeenCalledWith('w1', 't2', 'digest');
    expect(d.activateTree).toHaveBeenCalledWith('t2', 'w1');
    expect(d.openPane).not.toHaveBeenCalled();
    expect(d.setFocusedNodeId).toHaveBeenCalledWith('digest');
  });

  it('opens a digest of another workspace there, not in the shown slot', () => {
    const d = deps([project('w0', { chatIds: ['z'], edges: [], trees: [tree('tz', 'z')], activeTreeId: 'tz' }), project('w1')], 'w0');
    navigateToNode(d, 'digest');
    expect(d.selectProject).toHaveBeenCalledWith('w1');
    expect(d.openPaneInTree).toHaveBeenCalledWith('w1', 't2', 'digest');
    expect(d.openPane).not.toHaveBeenCalled();
  });

  it('returns a digest to the thread it was recorded in', () => {
    const d = deps([project('w1', { activeTreeId: 't2' })], 'w1');
    navigateToNode(d, 'digest', 'w1', 't1');
    expect(d.openPaneInTree).toHaveBeenCalledWith('w1', 't1', 'digest');
    expect(d.activateTree).toHaveBeenCalledWith('t1', 'w1');
  });

  it('opens a digest without a live source thread in the workspace\'s shown thread', () => {
    const d = deps([project('w0', { chatIds: ['z'], edges: [], trees: [tree('tz', 'z')], activeTreeId: 'tz' }), project('w1', { edges: [] })], 'w0');
    navigateToNode(d, 'digest');
    expect(d.selectProject).toHaveBeenCalledWith('w1');
    expect(d.openPaneInTree).toHaveBeenCalledWith('w1', 't1', 'digest');
    expect(d.setFocusedNodeId).toHaveBeenCalledWith('digest');
  });

  it('opens an id no workspace holds in the current slot', () => {
    const d = deps([project('w1')], 'w1');
    navigateToNode(d, 'missing');
    expect(d.openPane).toHaveBeenCalledWith('missing');
    expect(d.openPaneInTree).not.toHaveBeenCalled();
    expect(d.selectProject).not.toHaveBeenCalled();
  });
});
