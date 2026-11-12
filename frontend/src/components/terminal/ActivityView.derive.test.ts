import { describe, expect, it } from 'vitest';
import { deriveActivityData } from './ActivityView';
import type { ChatNodeState, Project } from '../../state/chatTypes';

const node = (nodeId: string, extra: Partial<ChatNodeState> = {}) => ({
  nodeId, chatId: null, projectId: 'p1', kind: 'chat', messages: [], followUps: [], status: 'idle', ...extra,
}) as ChatNodeState;

describe('deriveActivityData', () => {
  it('lists the user’s threads but not Meta agent maintenance runs or page helpers', () => {
    const project: Project = {
      id: 'p1', name: 'One', createdAt: 0, activeTreeId: 't-user', chatIds: ['user', 'run', 'helper'], edges: [],
      trees: [
        { id: 't-user', rootNodeId: 'user', createdAt: 0, lastActiveAt: 10 },
        { id: 't-run', rootNodeId: 'run', createdAt: 0, lastActiveAt: 30 },
        { id: 't-helper', rootNodeId: 'helper', createdAt: 0, lastActiveAt: 20 },
      ],
    };
    const nodes = { user: node('user'), run: node('run', { maintenanceJobId: 'job-maint' }), helper: node('helper', { pageId: 'page-1' }) };
    expect(deriveActivityData([project], nodes).map((item) => item.tree.id)).toEqual(['t-user']);
  });

  it('puts a thread in Now while a workflow one of its conversations launched still runs', () => {
    const noon = new Date().setHours(12, 0, 0, 0);
    const project: Project = {
      id: 'p1', name: 'One', createdAt: 0, activeTreeId: 't-a', chatIds: ['a', 'b', 'b-child'],
      edges: [{ source: 'b', target: 'b-child', kind: 'branch' }],
      trees: [
        { id: 't-a', rootNodeId: 'a', createdAt: 0, lastActiveAt: noon },
        { id: 't-b', rootNodeId: 'b', createdAt: 0, lastActiveAt: noon - 1_000 },
      ],
    };
    const nodes = { a: node('a'), b: node('b'), 'b-child': node('b-child') };
    const buckets = (items: ReturnType<typeof deriveActivityData>) => items.map((item) => [item.tree.id, item.bucket]);
    expect(buckets(deriveActivityData([project], nodes))).toEqual([['t-a', 'today'], ['t-b', 'today']]);
    // b's branch launched it; its turn has ended (idle).
    expect(buckets(deriveActivityData([project], nodes, new Set(['b-child'])))).toEqual([['t-b', 'now'], ['t-a', 'today']]);
    // A deleted branch's run does not keep the thread in Now.
    const deleted = { ...nodes, 'b-child': node('b-child', { deletedAt: 1 }) };
    expect(buckets(deriveActivityData([project], deleted, new Set(['b-child'])))).toEqual([['t-a', 'today'], ['t-b', 'today']]);
  });

  it('puts unread threads above Now and read ones below it', () => {
    const noon = new Date().setHours(12, 0, 0, 0);
    const project: Project = {
      id: 'p1', name: 'One', createdAt: 0, activeTreeId: 't-read', chatIds: ['read', 'run', 'old', 'old-child'],
      edges: [{ source: 'old', target: 'old-child', kind: 'branch' }],
      trees: [
        { id: 't-read', rootNodeId: 'read', createdAt: 0, lastActiveAt: noon },
        { id: 't-run', rootNodeId: 'run', createdAt: 0, lastActiveAt: noon - 1_000 },
        { id: 't-old', rootNodeId: 'old', createdAt: 0, lastActiveAt: noon - 3 * 86_400_000 },
      ],
    };
    const nodes = {
      read: node('read', { lastAssistantAt: 5, viewedAt: 5 }),
      // Running wins over an unseen earlier reply.
      run: node('run', { status: 'streaming', lastAssistantAt: 5, viewedAt: 1 }),
      old: node('old'),
      'old-child': node('old-child', { lastAssistantAt: 5, viewedAt: 1 }),
    };
    const buckets = (items: ReturnType<typeof deriveActivityData>) => items.map((item) => [item.tree.id, item.bucket]);
    expect(buckets(deriveActivityData([project], nodes))).toEqual([['t-old', 'unread'], ['t-run', 'now'], ['t-read', 'today']]);
    // The branch the user is looking at counts as read.
    expect(buckets(deriveActivityData([project], nodes, undefined, 'old-child')))
      .toEqual([['t-run', 'now'], ['t-read', 'today'], ['t-old', 'earlier']]);
  });

  it('keeps a thread opened from Unread there until the user switches to another thread', () => {
    const noon = new Date().setHours(12, 0, 0, 0);
    const project: Project = {
      id: 'p1', name: 'One', createdAt: 0, activeTreeId: 't-read', chatIds: ['read', 'old', 'old-child'],
      edges: [{ source: 'old', target: 'old-child', kind: 'branch' }],
      trees: [
        { id: 't-read', rootNodeId: 'read', createdAt: 0, lastActiveAt: noon },
        { id: 't-old', rootNodeId: 'old', createdAt: 0, lastActiveAt: noon - 3 * 86_400_000 },
      ],
    };
    // Opening the thread marked its reply seen.
    const nodes = { read: node('read'), old: node('old'), 'old-child': node('old-child', { lastAssistantAt: 5, viewedAt: 6 }) };
    const buckets = (items: ReturnType<typeof deriveActivityData>) => items.map((item) => [item.tree.id, item.bucket]);
    const shown = new Set(['t-old']);
    // Anywhere in the thread, root or branch, it keeps its place.
    expect(buckets(deriveActivityData([project], nodes, undefined, 'old-child', shown)))
      .toEqual([['t-old', 'unread'], ['t-read', 'today']]);
    expect(buckets(deriveActivityData([project], nodes, undefined, 'old', shown)))
      .toEqual([['t-old', 'unread'], ['t-read', 'today']]);
    // Another thread takes the focus: it joins the read ones.
    expect(buckets(deriveActivityData([project], nodes, undefined, 'read', shown)))
      .toEqual([['t-read', 'today'], ['t-old', 'earlier']]);
    // Only a thread the list showed under Unread is held.
    expect(buckets(deriveActivityData([project], nodes, undefined, 'old', new Set(['t-read']))))
      .toEqual([['t-read', 'today'], ['t-old', 'earlier']]);
    // A reply the user sends moves it to Now as usual.
    const replying = { ...nodes, old: node('old', { status: 'streaming' }) };
    expect(buckets(deriveActivityData([project], replying, undefined, 'old', shown)))
      .toEqual([['t-old', 'now'], ['t-read', 'today']]);
  });
});
