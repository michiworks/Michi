import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatNodeStoreContext } from '../state/chatStore';
import type { ChatNodeState, Project } from '../state/chatTypes';
import { backendEntityId } from '../config/backendIdentity';
import { paneMentionCandidates, useMentionCandidates } from './mentionCandidates';

const node = (nodeId: string, projectId = 'p1', over: Partial<ChatNodeState> = {}): ChatNodeState => ({
  nodeId, projectId, kind: 'chat', chatId: null, title: `Chat ${nodeId}`, followUps: [], status: 'idle',
  messages: [{ id: `${nodeId}-m`, role: 'user', text: 'Hello', toolCalls: [] }], ...over,
});
const project = (id: string, name: string, roots: string[], over: Partial<Project> = {}): Project => ({
  id, name, chatIds: roots, edges: [], createdAt: 1, activeTreeId: null,
  trees: roots.map((root, i) => ({ id: `${id}-t${i}`, rootNodeId: root, createdAt: 1, lastActiveAt: 10 - i })), ...over,
});

describe('useMentionCandidates', () => {
  it('builds the candidates from the store as it is when asked, never on render', () => {
    let nodes: Record<string, ChatNodeState> = { a: node('a') };
    const store = { getNodes: () => nodes } as unknown as NonNullable<React.ContextType<typeof ChatNodeStoreContext>>;
    const wrapper = ({ children }: { children: ReactNode }) => <ChatNodeStoreContext.Provider value={store}>{children}</ChatNodeStoreContext.Provider>;
    const build = vi.fn((map: Record<string, ChatNodeState>) => ({ sameTree: Object.values(map), crossTree: [] }));
    const { result, rerender } = renderHook(() => useMentionCandidates(build), { wrapper });
    rerender();
    expect(build).not.toHaveBeenCalled();
    nodes = { ...nodes, b: node('b') };
    expect(result.current().sameTree.map((item) => item.nodeId)).toEqual(['a', 'b']);
    expect(build).toHaveBeenCalledOnce();
  });
});

describe('paneMentionCandidates', () => {
  it('lists the pane\'s own thread first and leaves it out of the other threads', () => {
    const p1: Project = { ...project('p1', 'Work', ['a', 'b']), chatIds: ['a', 'a2', 'b'], edges: [{ source: 'a', target: 'a2' }] };
    const nodes = { a: node('a'), a2: node('a2'), b: node('b') };
    const got = paneMentionCandidates(nodes, { nodeId: 'a2', project: p1, projects: [p1], assistant: false });
    expect(got.sameTree.map((item) => item.nodeId)).toEqual(['a', 'a2']);
    expect(got.crossTree.map((group) => [group.treeTitle, group.nodes.map((item) => item.nodeId)])).toEqual([['Chat b', ['b']]]);
  });

  it('gives the assistant every live local user workspace\'s threads, titled with the workspace', () => {
    const remoteId = backendEntityId('remote-a', 'r1');
    const projects = [
      project('p1', 'Work', ['a']),
      project('sys', 'Assistant', ['s'], { system: 'assistant' }),
      project('gone', 'Old', ['g'], { deletedAt: 5 }),
      project(remoteId, 'Remote', ['r']),
      project('p2', 'Home', ['h']),
    ];
    const nodes = { a: node('a'), s: node('s', 'sys'), g: node('g', 'gone'), r: node('r', remoteId), h: node('h', 'p2') };
    const got = paneMentionCandidates(nodes, { nodeId: 's', project: projects[1], projects, assistant: true });
    expect(got.crossTree.map((group) => group.treeTitle)).toEqual(['Work · Chat a', 'Home · Chat h']);
  });
});
