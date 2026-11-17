import { describe, it, expect } from 'vitest';
import { firstUnreadTurn, resolvePaneRestore, type PaneScrollEntry } from './TPane';
import type { ChatMessage } from '../../state/chatTypes';

// resolvePaneRestore decides where a freshly-mounted idle pane lands:
// first message newer than the saved lastSeen horizon ("unseen"), else the
// message that topped the viewport when the pane was left mid-history
// ("anchor"), else the bottom. The horizon deliberately comes from the
// pane's own save cache rather than node.viewedAt — activateTree resets
// viewedAt to Date.now() in the same click that opens the pane, so viewedAt
// is always "just now" by the time the pane can read it.

const entry = (over: Partial<PaneScrollEntry> = {}): PaneScrollEntry => ({
  anchorId: 'm2',
  offset: -40,
  atBottom: false,
  lastSeen: 1000,
  ...over,
});

const msgs = [
  { id: 'm1', createdAt: 500 },
  { id: 'm2', createdAt: 800 },
  { id: 'm3', createdAt: 1000 },
];

describe('resolvePaneRestore', () => {
  it('messages without createdAt are never unseen', () => {
    const legacyMsgs = [{ id: 'm1' }, { id: 'm2' }];
    const got = resolvePaneRestore(entry({ atBottom: true }), legacyMsgs);
    expect(got?.kind).toBe('bottom');
  });

  it('a pane left mid-history reopens at its saved anchor and offset', () => {
    expect(resolvePaneRestore(entry(), msgs)).toEqual({ kind: 'anchor', anchorId: 'm2', offset: -40 });
  });

  it('messages newer than the horizon win over the saved anchor', () => {
    const got = resolvePaneRestore(entry(), [...msgs, { id: 'm4', createdAt: 1200 }]);
    expect(got).toEqual({ kind: 'unseen', anchorId: 'm4', offset: 0 });
  });

  it('a pane left at the bottom, or whose anchor is gone, opens at the bottom', () => {
    expect(resolvePaneRestore(entry({ atBottom: true }), msgs)?.kind).toBe('bottom');
    expect(resolvePaneRestore(entry({ anchorId: 'deleted' }), msgs)?.kind).toBe('bottom');
    expect(resolvePaneRestore(undefined, msgs)?.kind).toBe('bottom');
  });
});

// With server completion facts, unread is the server's count of replies the
// reader has not seen: the pane opens on the first of them, at its question.
const user = (id: string): ChatMessage => ({ id, role: 'user', text: `Question ${id}`, toolCalls: [] });
const reply = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role: 'assistant', text: '', toolCalls: [], blocks: [{ id: `b-${id}`, kind: 'answer', rawText: `Answer ${id}` }], ...over,
});
const turns = [user('u1'), reply('a1'), user('u2'), reply('a2'), user('u3'), reply('a3')];

describe('firstUnreadTurn', () => {
  it('counts back the unread replies and opens on the question of the first', () => {
    expect(firstUnreadTurn(turns, 1, false)).toEqual({ openerId: 'u3', replyId: 'a3' });
    expect(firstUnreadTurn(turns, 2, false)).toEqual({ openerId: 'u2', replyId: 'a2' });
    expect(firstUnreadTurn(turns, 0, false)).toBeNull();
  });

  it('skips a reply still streaming and one that left nothing to read', () => {
    const live = [...turns, user('u4'), reply('a4', { streaming: true })];
    expect(firstUnreadTurn(live, 1, false)).toEqual({ openerId: 'u3', replyId: 'a3' });
    const empty = [...turns.slice(0, 4), user('u3'), reply('a3', { blocks: [] })];
    expect(firstUnreadTurn(empty, 1, false)).toEqual({ openerId: 'u2', replyId: 'a2' });
  });

  it('opens on a page that is unread all through when older history is still to load', () => {
    expect(firstUnreadTurn(turns.slice(2), 3, true)).toEqual({ openerId: 'u2', replyId: 'u2', pastPage: true });
    // Fully loaded, the oldest counted reply is the nearest.
    expect(firstUnreadTurn(turns, 5, false)).toEqual({ openerId: 'u1', replyId: 'a1' });
  });

  it('a reply no question opens is its own opener', () => {
    expect(firstUnreadTurn([reply('a1'), reply('a2')], 1, false)).toEqual({ openerId: 'a2', replyId: 'a2' });
  });
});

describe('resolvePaneRestore with server unread', () => {
  const withTimes = turns.map((m, i) => ({ ...m, createdAt: 100 * (i + 1) }));

  it('an unread reply wins over the saved horizon and anchor', () => {
    const got = resolvePaneRestore(entry({ anchorId: 'u1', lastSeen: 100 }), withTimes, {
      unread: { openerId: 'u3', replyId: 'a3' }, serverDecidesUnread: true,
    });
    expect(got).toEqual({ kind: 'unseen', anchorId: 'u3', replyId: 'a3', offset: 0 });
  });

  it('with nothing unread the saved place wins: what is newer was seen elsewhere', () => {
    const saved = entry({ anchorId: 'u1', lastSeen: 100 });
    expect(resolvePaneRestore(saved, withTimes, { serverDecidesUnread: true })).toEqual({ kind: 'anchor', anchorId: 'u1', offset: -40 });
    expect(resolvePaneRestore(entry({ atBottom: true, lastSeen: 100 }), withTimes, { serverDecidesUnread: true })?.kind).toBe('bottom');
    // A backend without completion facts keeps the saved horizon.
    expect(resolvePaneRestore(saved, withTimes)?.kind).toBe('unseen');
  });
});
