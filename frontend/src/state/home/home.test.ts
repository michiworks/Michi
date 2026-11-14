import { describe, expect, it } from 'vitest';
import type { ChatNodeState, Project } from '../chatTypes';
import { homeGreetingText, timeOfDayGreeting } from './homeGreeting';
import { homeRecentStatus, homeWhen, selectHomeRecent } from './homeRecent';
import { homeWorkCounts } from './homeWork';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 12, 14, 20);

function node(nodeId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, chatId: null, projectId: 'p1', kind: 'chat', title: nodeId, messages: [], followUps: [], status: 'idle', ...extra } as ChatNodeState;
}

describe('Home greeting (Q45)', () => {
  it('greets by the time of day', () => {
    expect([at(2026, 11, 12, 4), at(2026, 11, 12, 5), at(2026, 11, 12, 11, 59), at(2026, 11, 12, 12), at(2026, 11, 12, 18)].map(timeOfDayGreeting))
      .toEqual(['Good evening', 'Good morning', 'Good morning', 'Good afternoon', 'Good evening']);
  });

  it('uses Michi\'s latest line while it is fresh, then the time of day', () => {
    expect(homeGreetingText(NOW, { text: 'Two reviews came back overnight.', at: NOW - 3_600_000 })).toBe('Two reviews came back overnight.');
    expect(homeGreetingText(NOW, { text: 'Three check-ins ago.', at: NOW - 3 * 3_600_000 })).toBe('Three check-ins ago.');
    expect(homeGreetingText(NOW, { text: 'Old news.', at: NOW - 3 * 3_600_000 - 1 })).toBe('Good afternoon');
    expect(homeGreetingText(NOW, { text: '  ', at: NOW })).toBe('Good afternoon');
    expect(homeGreetingText(NOW, null)).toBe('Good afternoon');
  });
});

describe('Jump back in (Q46)', () => {
  const projects = [
    { id: 'p1', name: 'Michi', createdAt: 0, activeTreeId: null, chatIds: [], edges: [{ id: 'e', source: 'a', target: 'a2', kind: 'branch' }], trees: [
      { id: 't-a', rootNodeId: 'a', createdAt: 0, lastActiveAt: 50 },
      { id: 't-helper', rootNodeId: 'helper', createdAt: 0, lastActiveAt: 60 },
      { id: 't-archived', rootNodeId: 'old', createdAt: 0, lastActiveAt: 70, archivedAt: 71 },
      { id: 't-b', rootNodeId: 'b', createdAt: 0, lastActiveAt: 40 },
    ] },
    { id: 'ws-assistant', name: 'Assistant', createdAt: 0, system: 'assistant', activeTreeId: null, chatIds: [], edges: [], trees: [{ id: 't-v', rootNodeId: 'v', createdAt: 0, lastActiveAt: 99 }] },
    { id: 'p2', name: 'AFTFMC', createdAt: 0, activeTreeId: null, chatIds: [], edges: [], trees: [
      { id: 't-c', rootNodeId: 'c', createdAt: 0, lastActiveAt: 30 },
      { id: 't-d', rootNodeId: 'd', createdAt: 0, lastActiveAt: 20 },
    ] },
  ] as unknown as Project[];
  const nodes = {
    a: node('a', { title: 'Fix pane focus', branchOverviewEntries: [{ at: 0, text: 'Legacy line.' }, { at: 2, text: 'Found it.' }] }),
    a2: node('a2', { branchOverviewEntries: [{ at: 9, text: 'Fixed after a reload.' }], status: 'streaming' }),
    helper: node('helper', { pageId: 'pg' }),
    old: node('old'),
    b: node('b', { title: 'Kiro flake', completionSeq: 3, seenCompletionSeq: 2 }),
    v: node('v'),
    c: node('c', { title: 'Release notes', branchOverviewEntries: [{ at: 0, text: 'First.' }, { at: 0, text: 'Second, legacy.' }] }),
    d: node('d'),
  };

  it('takes the three latest listed conversations of the user\'s workspaces, with the newest line their agent wrote', () => {
    const recent = selectHomeRecent(projects, nodes, { michiStarted: new Set(['b']) });
    expect(recent.map((thread) => [thread.workspaceName, thread.title, thread.overview, thread.running, thread.unread, thread.startedByMichi])).toEqual([
      ['Michi', 'Fix pane focus', 'Fixed after a reload.', true, false, false],
      ['Michi', 'Kiro flake', null, false, true, true],
      ['AFTFMC', 'Release notes', 'Second, legacy.', false, false, false],
    ]);
    expect(selectHomeRecent(projects, nodes, { limit: 5 }).map((thread) => thread.treeId)).toEqual(['t-a', 't-b', 't-c', 't-d']);
  });

  it('leaves temporary chats out, and the next latest conversation takes the place', () => {
    const withTemporary = projects.map((project) => (project.id === 'p1'
      ? { ...project, trees: [...project.trees, { id: 't-temp', rootNodeId: 'temp', createdAt: 0, lastActiveAt: 80 }] }
      : project)) as Project[];
    const recent = selectHomeRecent(withTemporary, { ...nodes, temp: node('temp', { title: 'Off the record', temporary: true }) });
    expect(recent.map((thread) => thread.treeId)).toEqual(['t-a', 't-b', 't-c']);
    expect(selectHomeRecent(withTemporary, { ...nodes, temp: node('temp', { title: 'Kept', temporary: false }) }).map((thread) => thread.treeId))
      .toEqual(['t-temp', 't-a', 't-b']);
  });

  it('says what a conversation is doing, or when it was last active', () => {
    const today = { running: false, unread: false, startedByMichi: false, at: NOW - 2 * 3_600_000 };
    expect(homeRecentStatus({ ...today, running: true, startedByMichi: true }, NOW, 'Robin')).toBe('Started by Robin · running');
    expect(homeRecentStatus({ ...today, running: true }, NOW, 'Robin')).toBe('Running');
    expect(homeRecentStatus({ ...today, unread: true }, NOW, 'Robin')).toBe('Done · 2h ago');
    expect(homeRecentStatus({ ...today, startedByMichi: true }, NOW, 'Robin')).toBe('Started by Robin · 2h ago');
    expect(homeRecentStatus({ ...today, unread: true, at: NOW - 20_000 }, NOW, 'Robin')).toBe('Done · just now');
  });

  it('dates a card the way the sidebar reads: today\'s age, Yesterday, the weekday, then the date', () => {
    expect(homeWhen(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(homeWhen(at(2026, 11, 11, 23), NOW)).toBe('Yesterday');
    expect(homeWhen(at(2026, 11, 10, 9), NOW)).toBe('Tue');
    expect(homeWhen(at(2026, 11, 3, 9), NOW)).toBe('Nov 3');
  });
});

describe('the work strip (Q44)', () => {
  it('counts the conversations Michi follows, what needs the user and today\'s finished ones', () => {
    const item = (subtype: string, changedAt: number) => ({ subtype, changedAt }) as never;
    const counts = homeWorkCounts({
      delegations: [{ state: 'following' }, { state: 'following' }, { state: 'closed' }] as never,
      counts: { needsYou: 3, newItems: 0, unreadMessages: 0 },
      items: [item('michi_done', at(2026, 11, 12, 9)), item('michi_done', at(2026, 11, 11, 23)), item('cr_merged', NOW)],
    }, NOW);
    expect(counts).toEqual({ working: 2, waiting: 3, doneToday: 1 });
  });
});
