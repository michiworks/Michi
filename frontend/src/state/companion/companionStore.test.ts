import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { companionItem, companionSnapshotDto, jsonResponse } from '../../test/companionFixtures';
import { companionBadgeCount } from 'michi-shared';
import {
  actOnCompanionItem,
  adoptCompanionAssistant,
  companionBriefSeenBefore,
  companionItemShowsOnToday,
  getCompanionAssistant,
  getCompanionState,
  isCompanionNodeId,
  loadCompanion,
  markCompanionItemsSeen,
  noteCompanionChanged,
  noteCompanionTurnEnded,
  refreshCompanion,
  loadCompanionAssistant,
  resetCompanionStoreForTests,
  subscribeCompanion,
  subscribeCompanionTurnEnd,
  updateCompanionSnapshot,
} from './companionStore';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let handler: Handler;
const calls: Array<{ method: string; path: string; body: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  resetCompanionStoreForTests();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname.replace(/^.*\/api/, '');
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return handler(path, init);
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetCompanionStoreForTests();
});

const gets = () => calls.filter((call) => call.method === 'GET' && call.path === '/companion').length;
const seenPosts = () => calls.filter((call) => call.method === 'POST' && call.path === '/companion/items/seen').length;

describe('the Companion store', () => {
  it('adopts the snapshot and knows its conversation', async () => {
    handler = () => jsonResponse(companionSnapshotDto({ items: [companionItem('a')] }));
    await loadCompanion();
    const state = getCompanionState();
    expect(state.availability).toBe('available');
    expect(state.snapshot?.items.map((item) => item.id)).toEqual(['a']);
    expect(isCompanionNodeId('companion-node')).toBe(true);
    expect(isCompanionNodeId('other')).toBe(false);
  });

  it('remembers on this machine that a brief reached it, so the next one is not worded as the first', async () => {
    localStorage.removeItem('michi:companion:brief-seen');
    try {
      handler = () => jsonResponse(companionSnapshotDto());
      await loadCompanion();
      expect(companionBriefSeenBefore()).toBe(false);
      const brief = { id: 'brf-1', date: '2026-11-05', headline: 'Quiet day', cards: [], closing: '', origin: 'llm' as const, createdAt: 1, cardFeedback: {} };
      handler = () => jsonResponse(companionSnapshotDto({ brief, revision: 2 }));
      await refreshCompanion();
      expect(companionBriefSeenBefore()).toBe(true);
      // Another window, or the next launch, reads it back.
      resetCompanionStoreForTests();
      expect(companionBriefSeenBefore()).toBe(true);
    } finally {
      localStorage.removeItem('michi:companion:brief-seen');
    }
  });

  it('takes an answer of another shape before any snapshot as "no Companion here"', async () => {
    handler = () => jsonResponse({ __unmocked: '/companion' });
    await loadCompanion();
    expect(getCompanionState().availability).toBe('unavailable');
    expect(getCompanionState().snapshot).toBeNull();
  });

  it('keeps the last snapshot when the backend cannot be reached (hydration barrier)', async () => {
    handler = () => jsonResponse(companionSnapshotDto({ items: [companionItem('a')] }));
    await loadCompanion();
    handler = () => { throw new TypeError('Failed to fetch'); };
    await refreshCompanion();
    expect(getCompanionState().stale).toBe(true);
    expect(getCompanionState().snapshot?.items.map((item) => item.id)).toEqual(['a']);
    // A wrong answer after a good one is a hiccup too, not "unavailable".
    handler = () => jsonResponse({ __unmocked: '/companion' });
    await refreshCompanion();
    expect(getCompanionState().availability).toBe('available');
    expect(getCompanionState().snapshot?.items).toHaveLength(1);
  });

  it('reads again 150ms after changes, once for a burst, and not for the revision it has', async () => {
    handler = () => jsonResponse(companionSnapshotDto({ revision: 4 }));
    await loadCompanion();
    vi.useFakeTimers();
    noteCompanionChanged({ revision: 4 });
    await vi.advanceTimersByTimeAsync(500);
    expect(gets()).toBe(1);
    handler = () => jsonResponse(companionSnapshotDto({ revision: 7 }));
    noteCompanionChanged({ revision: 5 });
    await vi.advanceTimersByTimeAsync(100);
    noteCompanionChanged({ revision: 6 });
    await vi.advanceTimersByTimeAsync(100);
    noteCompanionChanged({ revision: 7 });
    await vi.advanceTimersByTimeAsync(149);
    expect(gets()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gets()).toBe(2);
    expect(getCompanionState().snapshot?.revision).toBe(7);
  });

  it('shows an item action at once and keeps it when the backend agrees', async () => {
    const item = companionItem('a');
    handler = () => jsonResponse(companionSnapshotDto({ items: [item, companionItem('b')] }));
    await loadCompanion();
    let answer!: (response: Response) => void;
    handler = (path) => (path === '/companion/items/a' ? new Promise<Response>((resolve) => { answer = resolve; }) : jsonResponse(companionSnapshotDto({ items: [item, companionItem('b')] })));
    const acting = actOnCompanionItem('a', { action: 'snooze', until: Date.now() + 3_600_000 });
    // Snoozed into the future: off the list before the backend answers.
    expect(getCompanionState().snapshot?.items.map((entry) => entry.id)).toEqual(['b']);
    answer(jsonResponse({ ...item, status: 'snoozed', snoozedUntil: Date.now() + 3_600_000 }));
    await acting;
    expect(getCompanionState().snapshot?.items.map((entry) => entry.id)).toEqual(['b']);
    expect(calls.find((call) => call.path === '/companion/items/a')?.body).toMatchObject({ action: 'snooze' });
  });

  it('puts back an item it no longer lists only when Today would show it (W3-F3-review #1)', async () => {
    const base = companionSnapshotDto();
    const crOff = { ...base.settings, sources: { ...base.settings.sources, cr: { ...base.settings.sources.cr, enabled: false } } };
    handler = () => jsonResponse(companionSnapshotDto({ settings: crOff, items: [companionItem('p', { source: 'pipeline', subtype: 'pipeline_blocked' })] }));
    await loadCompanion();
    // Restored, but its source is off: the backend keeps it out of sight, so the window does too.
    handler = (path) => (path === '/companion/items/cr1' ? jsonResponse(companionItem('cr1', { status: 'seen' })) : new Promise<Response>(() => {}));
    const answer = await actOnCompanionItem('cr1', { action: 'restore' });
    expect(answer.status).toBe('seen');
    expect(getCompanionState().snapshot?.items.map((entry) => entry.id)).toEqual(['p']);
    // A pipeline item whose source is on comes back at once.
    handler = (path) => (path === '/companion/items/p2' ? jsonResponse(companionItem('p2', { source: 'pipeline', subtype: 'pipeline_blocked', status: 'seen' })) : new Promise<Response>(() => {}));
    await actOnCompanionItem('p2', { action: 'restore' });
    expect(getCompanionState().snapshot?.items.map((entry) => entry.id)).toEqual(['p2', 'p']);
  });

  it('knows an item shows on Today when it is open and its source is on', () => {
    const settings = companionSnapshotDto().settings;
    const off = { ...settings, sources: { ...settings.sources, email: { ...settings.sources.email, enabled: false } } };
    expect(companionItemShowsOnToday(companionItem('a'), settings)).toBe(true);
    expect(companionItemShowsOnToday(companionItem('a', { status: 'resolved' }), settings)).toBe(false);
    expect(companionItemShowsOnToday(companionItem('a', { status: 'snoozed', snoozedUntil: Date.now() + 60_000 }), settings)).toBe(false);
    expect(companionItemShowsOnToday(companionItem('e', { source: 'email', subtype: 'email_unread' }), off)).toBe(false);
    // The source's trouble item goes with it; a system item of another source does not.
    expect(companionItemShowsOnToday(companionItem('t', { source: 'system', subtype: 'system_source_error', itemKey: 'system:source:email' }), off)).toBe(false);
    expect(companionItemShowsOnToday(companionItem('t', { source: 'system', subtype: 'system_source_error', itemKey: 'system:source:cr' }), off)).toBe(true);
  });

  it('rolls an action back when the backend refuses it', async () => {
    handler = () => jsonResponse(companionSnapshotDto({ items: [companionItem('a')] }));
    await loadCompanion();
    handler = (path) => (path === '/companion/items/a' ? jsonResponse({ error: 'Item not found', code: 'not_found' }, 404) : jsonResponse(companionSnapshotDto({ items: [companionItem('a')] })));
    await expect(actOnCompanionItem('a', { action: 'dismiss' })).rejects.toThrow('Item not found');
    expect(getCompanionState().snapshot?.items.map((entry) => entry.id)).toEqual(['a']);
  });

  it('a read that started before an action answered does not undo it', async () => {
    const item = companionItem('a');
    handler = () => jsonResponse(companionSnapshotDto({ items: [item] }));
    await loadCompanion();
    let staleRead!: (response: Response) => void;
    handler = (path) => {
      if (path === '/companion') return new Promise<Response>((resolve) => { staleRead = resolve; });
      return jsonResponse({ ...item, status: 'dismissed' });
    };
    const reading = refreshCompanion();
    await actOnCompanionItem('a', { action: 'dismiss' });
    const shown: string[][] = [];
    const unsubscribe = subscribeCompanion(() => shown.push(getCompanionState().snapshot?.items.map((entry) => entry.id) ?? []));
    handler = () => jsonResponse(companionSnapshotDto({ items: [], revision: 2 }));
    // The read began before the dismiss landed and still lists the item.
    staleRead(jsonResponse(companionSnapshotDto({ items: [item] })));
    await reading;
    // It is read again, and the dismissed item never comes back meanwhile.
    await vi.waitFor(() => expect(getCompanionState().snapshot?.revision).toBe(2));
    unsubscribe();
    expect(gets()).toBe(3);
    expect(shown.flat()).not.toContain('a');
    expect(getCompanionState().snapshot?.items).toEqual([]);
  });

  it('marks items seen at once and counts the badge from new needs-you items and unread messages', async () => {
    handler = () => jsonResponse(companionSnapshotDto({
      items: [companionItem('a'), companionItem('b', { bucket: 'update' }), companionItem('c', { status: 'seen' })],
      counts: { needsYou: 2, newItems: 2, unreadMessages: 1 },
    }));
    await loadCompanion();
    expect(companionBadgeCount(getCompanionState().snapshot)).toBe(2);
    handler = () => jsonResponse(null, 204);
    markCompanionItemsSeen(['a', 'b', 'c']);
    expect(getCompanionState().snapshot?.items.map((item) => item.status)).toEqual(['seen', 'seen', 'seen']);
    expect(companionBadgeCount(getCompanionState().snapshot)).toBe(1);
    await vi.waitFor(() => expect(calls.find((call) => call.path === '/companion/items/seen')?.body).toEqual({ ids: ['a', 'b'] }));
  });

  it('keeps a failed seen mark on screen: no loop, no read thrown away, and a snapshot after the wait marks it again', async () => {
    handler = () => jsonResponse(companionSnapshotDto({ items: [companionItem('a')] }));
    await loadCompanion();
    handler = (path) => (path === '/companion/items/seen'
      ? jsonResponse({ error: 'disk I/O error', code: 'internal' }, 500)
      : jsonResponse(companionSnapshotDto({ items: [companionItem('a')], revision: 2 })));
    const statuses = () => getCompanionState().snapshot?.items.map((item) => item.status);
    markCompanionItemsSeen(['a']);
    await vi.waitFor(() => expect(seenPosts()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still marked: whoever marked it (Today, an open) has nothing to mark again, and no read was dropped or rescheduled.
    expect(statuses()).toEqual(['seen']);
    expect(seenPosts()).toBe(1);
    expect(gets()).toBe(1);
    // A snapshot while the wait runs: marked on screen again, not sent.
    await refreshCompanion();
    expect(statuses()).toEqual(['new']);
    markCompanionItemsSeen(['a']);
    expect(statuses()).toEqual(['seen']);
    expect(seenPosts()).toBe(1);
    // Past the wait, the next snapshot's mark goes out once more, and sticks.
    await refreshCompanion();
    handler = (path) => (path === '/companion/items/seen' ? jsonResponse(null, 204) : jsonResponse(companionSnapshotDto({ items: [companionItem('a', { status: 'seen' })], revision: 3 })));
    markCompanionItemsSeen(['a'], Date.now() + 5_001);
    await vi.waitFor(() => expect(seenPosts()).toBe(2));
    expect(calls.filter((call) => call.path === '/companion/items/seen').map((call) => call.body)).toEqual([{ ids: ['a'] }, { ids: ['a'] }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statuses()).toEqual(['seen']);
    // A success ends the wait: the next mark goes out at once.
    handler = (path) => (path === '/companion/items/seen'
      ? jsonResponse(null, 204)
      : jsonResponse(companionSnapshotDto({ items: [companionItem('a', { status: 'seen' }), companionItem('b')], revision: 3 })));
    await refreshCompanion();
    markCompanionItemsSeen(['b']);
    await vi.waitFor(() => expect(seenPosts()).toBe(3));
    expect(calls.filter((call) => call.path === '/companion/items/seen').at(-1)?.body).toEqual({ ids: ['b'] });
  });

  it('a read that started before a saved change does not put the old record back', async () => {
    handler = () => jsonResponse(companionSnapshotDto({ notes: 'Old notes.', revision: 1 }));
    await loadCompanion();
    let staleRead!: (response: Response) => void;
    handler = () => new Promise<Response>((resolve) => { staleRead = resolve; });
    const reading = refreshCompanion();
    // The user's notes were saved while that read was on its way.
    updateCompanionSnapshot((snapshot) => ({ ...snapshot, notes: 'My notes.', notesRevision: 1 }));
    handler = () => jsonResponse(companionSnapshotDto({ notes: 'My notes.', notesRevision: 1, revision: 2 }));
    const shown: string[] = [];
    const unsubscribe = subscribeCompanion(() => shown.push(getCompanionState().snapshot?.notes ?? ''));
    staleRead(jsonResponse(companionSnapshotDto({ notes: 'Old notes.', revision: 1 })));
    await reading;
    await vi.waitFor(() => expect(getCompanionState().snapshot?.revision).toBe(2));
    unsubscribe();
    expect(shown).not.toContain('Old notes.');
    expect(getCompanionState().snapshot?.notes).toBe('My notes.');
  });

  it('notes when this window first saw items that arrived after its first snapshot', async () => {
    handler = () => jsonResponse(companionSnapshotDto({ items: [companionItem('old')], revision: 1 }));
    await loadCompanion();
    expect(getCompanionState().arrivals).toEqual({});
    handler = () => jsonResponse(companionSnapshotDto({ items: [companionItem('new'), companionItem('old')], revision: 2 }));
    await refreshCompanion();
    expect(Object.keys(getCompanionState().arrivals)).toEqual(['new']);
  });
});

describe('the conversation (DESIGN-v2 §1.3: Chat needs /assistant, not the snapshot)', () => {
  const info = (nodeId: string) => ({
    nodeId, workspaceId: 'ws-assistant', treeId: `tree-${nodeId}`,
    settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'],
  });

  it('loads V from /assistant without any Companion snapshot, and knows it as the agent\'s node', async () => {
    handler = (path) => (path === '/assistant' ? jsonResponse(info('v1')) : jsonResponse({ error: 'nope' }, 404));
    await loadCompanionAssistant();
    expect(getCompanionAssistant()).toMatchObject({ status: 'ready', info: { nodeId: 'v1' } });
    expect(getCompanionState().snapshot).toBeNull();
    expect(isCompanionNodeId('v1')).toBe(true);
  });

  it('is final when this backend has no assistant', async () => {
    handler = () => jsonResponse({ error: 'not found' }, 404);
    await loadCompanionAssistant();
    expect(getCompanionAssistant().status).toBe('unsupported');
    adoptCompanionAssistant(info('v2'));
    expect(getCompanionAssistant().info).toBeNull();
  });

  it('follows a newer V the snapshot names (New conversation in another window)', async () => {
    handler = (path) => (path === '/assistant' ? jsonResponse(info('v1')) : jsonResponse(companionSnapshotDto({
      conversation: { workspaceId: 'ws-assistant', nodeId: 'v2', assistant: info('v2') as never },
    })));
    await loadCompanionAssistant();
    await loadCompanion();
    expect(getCompanionAssistant().info?.nodeId).toBe('v2');
  });

  it('does not switch back to the old V for a snapshot read that began before a New conversation (F1a-review #11)', async () => {
    let answer: (response: Response) => void = () => {};
    handler = (path) => (path === '/assistant' ? jsonResponse(info('v1'))
      : new Promise<Response>((resolve) => { answer = resolve; }));
    await loadCompanionAssistant();
    const read = refreshCompanion();
    // New conversation (or History's activate) answers while that read is on its way.
    adoptCompanionAssistant(info('v2'));
    answer(jsonResponse(companionSnapshotDto({ conversation: { workspaceId: 'ws-assistant', nodeId: 'v1', assistant: info('v1') as never } })));
    await read;
    expect(getCompanionAssistant().info?.nodeId).toBe('v2');
    expect(getCompanionState().availability).toBe('available');
  });

  it('reads V again after each of its turns, and tells pages waiting for that turn to end (F1a-review #7)', async () => {
    handler = (path) => (path === '/assistant'
      ? jsonResponse({ ...info('v1'), runtimeSwitches: [{ afterMessageId: 'a-1', runtimeId: 'codex' }] })
      : jsonResponse({ error: 'nope' }, 404));
    resetCompanionStoreForTests({ assistant: { status: 'ready', info: info('v1') as never, error: null } });
    const ended = vi.fn();
    const stop = subscribeCompanionTurnEnd(ended);
    noteCompanionTurnEnded('other-node');
    expect(ended).not.toHaveBeenCalled();
    noteCompanionTurnEnded('v1');
    expect(ended).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(getCompanionAssistant().info?.runtimeSwitches).toEqual([{ afterMessageId: 'a-1', runtimeId: 'codex' }]));
    stop();
  });
});
