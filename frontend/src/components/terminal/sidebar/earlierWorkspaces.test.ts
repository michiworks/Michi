import { describe, expect, it } from 'vitest';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { EARLIER_AFTER_MS, isEarlierWorkspace, splitEarlierWorkspaces, workspaceLastActiveAt, type EarlierContext } from './earlierWorkspaces';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function workspace(id: string, lastActiveAt: number, extra: Partial<Project> = {}): Project {
  return {
    id, name: id, chatIds: [`${id}-root`], edges: [], createdAt: NOW - 400 * DAY,
    trees: [{ id: `${id}-tree`, rootNodeId: `${id}-root`, createdAt: NOW - 400 * DAY, lastActiveAt }],
    activeTreeId: `${id}-tree`,
    ...extra,
  };
}

function node(id: string, projectId: string, status: ChatNodeState['status'] = 'idle'): ChatNodeState {
  return { nodeId: id, chatId: null, projectId, kind: 'chat', messages: [], followUps: [], status };
}

const ctx = (over: Partial<EarlierContext> = {}): EarlierContext => ({
  activeProjectId: null, now: NOW, nodes: {}, openPaneIds: [], workRunning: new Set(), ...over,
});

describe('Earlier workspaces', () => {
  it('takes a workspace untouched for 30 days', () => {
    expect(isEarlierWorkspace(workspace('old', NOW - EARLIER_AFTER_MS), ctx())).toBe(true);
    expect(isEarlierWorkspace(workspace('recent', NOW - EARLIER_AFTER_MS + 1), ctx())).toBe(false);
  });

  it('dates a workspace by its latest thread, or by its creation when it has none', () => {
    const p = workspace('w', NOW - 90 * DAY);
    p.trees.push({ id: 'second', rootNodeId: 'second-root', createdAt: 0, lastActiveAt: NOW - 2 * DAY });
    expect(workspaceLastActiveAt(p)).toBe(NOW - 2 * DAY);
    expect(isEarlierWorkspace(p, ctx())).toBe(false);
    const empty = { ...workspace('empty', 0), trees: [], createdAt: NOW - DAY };
    expect(isEarlierWorkspace(empty, ctx())).toBe(false);
  });

  it('never takes the active workspace, a pinned one, one on screen or one with something running', () => {
    const old = NOW - 60 * DAY;
    expect(isEarlierWorkspace(workspace('a', old), ctx({ activeProjectId: 'a' }))).toBe(false);
    expect(isEarlierWorkspace(workspace('p', old, { pinnedAt: NOW - 100 * DAY }), ctx())).toBe(false);
    const nodes = { 'o-root': node('o-root', 'o') };
    expect(isEarlierWorkspace(workspace('o', old), ctx({ nodes, openPaneIds: ['o-root'] }))).toBe(false);
    expect(isEarlierWorkspace(workspace('s', old), ctx({ nodes: { 's-root': node('s-root', 's', 'streaming') } }))).toBe(false);
    expect(isEarlierWorkspace(workspace('r', old), ctx({ workRunning: new Set(['r-root']) }))).toBe(false);
    // A pane from another workspace does not keep this one out.
    expect(isEarlierWorkspace(workspace('x', old), ctx({ nodes, openPaneIds: ['o-root'] }))).toBe(true);
  });

  it('splits a list into Projects and Earlier, each in the order given', () => {
    const old = NOW - 45 * DAY;
    const list = [workspace('b', old), workspace('a', NOW), workspace('d', old), workspace('c', NOW)];
    const { recent, earlier } = splitEarlierWorkspaces(list, ctx());
    expect(recent.map((p) => p.id)).toEqual(['a', 'c']);
    expect(earlier.map((p) => p.id)).toEqual(['b', 'd']);
  });
});
