import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { HomeSectionItem, SpacesHomeSectionsDto } from 'michi-shared';
import type { ChatNodeState } from '../../../../state/chatTypes';

const mocks = vi.hoisted(() => ({
  sections: null as unknown,
  nodes: {} as Record<string, Partial<ChatNodeState>>,
  focusedNodeId: null as string | null,
}));
vi.mock('../../../../state/pages/useSpacesHome', () => ({
  useHomeSections: () => ({ data: mocks.sections, status: 'ready', error: null, stale: false, refresh: () => {} }),
}));
vi.mock('../../../../state/chatStore', () => ({
  useOptionalChatProjects: () => ({ focusedNodeId: mocks.focusedNodeId }),
  useStructuralSelector: (select: (nodes: unknown) => unknown) => select(mocks.nodes),
}));

import { homeWaitingTotal, openedSinceDone, openedSinceFailed, useSpacesHomeSections, withoutOpenedDone, withoutOpenedFailures } from './homeCounts';

const done = (nodeId: string, at: number | null): HomeSectionItem => ({
  id: `conversation:${nodeId}`, kind: 'conversation', workspaceId: 'ws', workspaceName: 'w', title: nodeId, at, summary: '', agentClaim: false,
  target: { kind: 'conversation', nodeId, workspaceId: 'ws', messageId: null },
});
const node = (extra: Partial<ChatNodeState>) => extra as ChatNodeState;

describe('Spaces Home counts', () => {
  it('reads the sidebar unread mark: opened after the last reply, or on screen now', () => {
    expect(openedSinceDone(done('a', 100), node({ viewedAt: 100 }), null)).toBe(true);
    expect(openedSinceDone(done('a', 100), node({ viewedAt: 99 }), null)).toBe(false);
    expect(openedSinceDone(done('a', 100), node({ viewedAt: 150, lastAssistantAt: 200 }), null)).toBe(false);
    expect(openedSinceDone(done('a', 100), node({}), null)).toBe(false);
    expect(openedSinceDone(done('a', 100), undefined, null)).toBe(false);
    expect(openedSinceDone(done('a', 100), undefined, 'a')).toBe(true);
    const page: HomeSectionItem = { ...done('a', 1), kind: 'proposal', target: { kind: 'page', pageId: 'p', blockId: null, changeId: 'c' } };
    expect(openedSinceDone(page, node({ viewedAt: 9 }), 'a')).toBe(false);
  });

  it('drops opened Just done rows and their count, and leaves Waiting and Stalled alone', () => {
    const sections: SpacesHomeSectionsDto = {
      waiting: { items: [done('w', 1)], total: 3 }, stalled: { items: [], total: 0 },
      done: { items: [done('a', 1), done('b', 1)], total: 9, ruleIds: ['r'] }, conversations: { available: true },
      byWorkspace: { ws: { waiting: 3, stalled: 0 } },
    };
    const after = withoutOpenedDone(sections, new Set(['conversation:a']));
    expect(after.done).toEqual({ items: [done('b', 1)], total: 8, ruleIds: ['r'] });
    expect(after.waiting).toBe(sections.waiting);
    expect(withoutOpenedDone(sections, new Set())).toBe(sections);
    expect(homeWaitingTotal(after)).toBe(3);
  });

  it('reads the sidebar Failed mark for a failed row: still failed, and opened at or after the failure, or on screen now', () => {
    expect(openedSinceFailed(done('a', 100), node({ status: 'error', viewedAt: 100 }), null)).toBe(true);
    expect(openedSinceFailed(done('a', 100), node({ status: 'error', viewedAt: 99 }), null)).toBe(false);
    expect(openedSinceFailed(done('a', 100), node({ status: 'error', viewedAt: 150, errorCompletedAt: 200 }), null), 'a retry failed again since: not seen').toBe(false);
    expect(openedSinceFailed(done('a', 100), node({ status: 'error', viewedAt: 200, errorCompletedAt: 200 }), null)).toBe(true);
    expect(openedSinceFailed(done('a', 100), node({ status: 'error' }), 'a')).toBe(true);
    expect(openedSinceFailed(done('a', 100), node({ status: 'idle', viewedAt: 200 }), null), 'a question it asked, or a retry since').toBe(false);
    expect(openedSinceFailed(done('a', 100), undefined, 'a'), 'not loaded here: the backend decides').toBe(false);
    expect(openedSinceFailed(done('a', null), node({ status: 'error', viewedAt: 200 }), null)).toBe(false);
    const page: HomeSectionItem = { ...done('a', 1), kind: 'proposal', target: { kind: 'page', pageId: 'p', blockId: null, changeId: 'c' } };
    expect(openedSinceFailed(page, node({ status: 'error', viewedAt: 9 }), 'a')).toBe(false);
  });

  it('drops opened failed rows from Waiting and Stalled, with their totals and their workspace counts', () => {
    const other = { ...done('o', 1), id: 'conversation:o', workspaceId: 'ws-2' };
    const sections: SpacesHomeSectionsDto = {
      waiting: { items: [done('w', 1), other], total: 4 }, stalled: { items: [done('s', 1)], total: 2 },
      done: { items: [done('a', 1)], total: 1 }, conversations: { available: true },
      byWorkspace: { ws: { waiting: 3, stalled: 2 }, 'ws-2': { waiting: 1, stalled: 0 } },
    };
    const after = withoutOpenedFailures(sections, new Set(['conversation:w', 'conversation:s']));
    expect(after.waiting).toEqual({ items: [other], total: 3 });
    expect(after.stalled).toEqual({ items: [], total: 1 });
    expect(after.byWorkspace).toEqual({ ws: { waiting: 2, stalled: 1 }, 'ws-2': { waiting: 1, stalled: 0 } });
    expect(after.done).toBe(sections.done);
    expect(homeWaitingTotal(after)).toBe(3);
    expect(withoutOpenedFailures(sections, new Set(['conversation:a'])), 'a Just done row is not a failure').toBe(sections);
    expect(withoutOpenedFailures(sections, new Set())).toBe(sections);
  });

  it('gives every reader the same sections, already without the rows you opened', () => {
    mocks.sections = { waiting: { items: [], total: 0 }, stalled: { items: [], total: 0 },
      done: { items: [done('a', 5), done('b', 5), done('c', 5)], total: 3 }, conversations: { available: true } };
    mocks.nodes = { a: { viewedAt: 6 } };
    mocks.focusedNodeId = 'c';
    const { result } = renderHook(() => useSpacesHomeSections('local'));
    expect(result.current.data?.done.items.map((item) => item.title)).toEqual(['b']);
    expect(result.current.data?.done.total).toBe(1);
  });

  it('drops a failed Waiting or Stalled row you opened since, and keeps one that failed after your look', () => {
    mocks.sections = { waiting: { items: [done('f', 5), done('later', 9), done('q', 5)], total: 3 }, stalled: { items: [done('old', 2)], total: 1 },
      done: { items: [], total: 0 }, conversations: { available: true }, byWorkspace: { ws: { waiting: 3, stalled: 1 } } };
    mocks.nodes = {
      f: { status: 'error', viewedAt: 6 }, later: { status: 'error', viewedAt: 6 },
      q: { status: 'idle', viewedAt: 6 }, old: { status: 'error', viewedAt: 3 },
    };
    mocks.focusedNodeId = null;
    const { result } = renderHook(() => useSpacesHomeSections('local'));
    expect(result.current.data?.waiting.items.map((item) => item.title)).toEqual(['later', 'q']);
    expect(result.current.data?.stalled.items).toEqual([]);
    expect(result.current.data?.byWorkspace).toEqual({ ws: { waiting: 2, stalled: 0 } });
  });
});
