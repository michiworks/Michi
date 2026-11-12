import { afterEach, describe, expect, it, vi } from 'vitest';
import { companionItem, companionSnapshotDto, jsonResponse } from '../../test/companionFixtures';
import {
  CompanionApiError,
  applyCompanionCard,
  resetCompanionConversation,
  stopCompanionDelegationAutoSend,
  undoCompanionRun,
  fetchCompanion,
  isCompanionUnavailable,
  parseCompanionNotice,
  parseCompanionSnapshot,
  postCompanionPresence,
  subscribeCompanionEvents,
} from './companion';

const stream = vi.hoisted(() => ({ fetchStream: vi.fn() }));
vi.mock('./streamTransport', () => ({ fetchStream: stream.fetchStream }));

afterEach(() => {
  vi.unstubAllGlobals();
  stream.fetchStream.mockReset();
});

describe('Companion snapshot shape', () => {
  it('reads a full snapshot as the backend sends it', () => {
    const snapshot = parseCompanionSnapshot({ ...companionSnapshotDto({ items: [companionItem('cmi-1')] }), quietMessageIds: ['self-n-cmp-1'] });
    expect(snapshot?.items.map((item) => item.id)).toEqual(['cmi-1']);
    // v2 hides nothing (DESIGN-v2 §3.8): an older backend's quiet ids are dropped.
    expect(snapshot).not.toHaveProperty('quietMessageIds');
    expect(snapshot?.conversation?.assistant?.treeId).toBe('tree-c');
  });

  it('defaults what older backends leave out and drops records it cannot read', () => {
    const { rules, reminders, demotedSubtypes, notesRevision, ...older } = companionSnapshotDto();
    void rules; void reminders; void demotedSubtypes; void notesRevision;
    const snapshot = parseCompanionSnapshot({
      ...older,
      conversation: { workspaceId: 'ws-assistant', nodeId: 'companion-node' },
      counts: { needsYou: 1, newItems: 1 },
      settings: { ...older.settings, workdays: undefined },
      items: [companionItem('ok'), { id: 'broken', title: 7 }, null],
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.rules).toBe('');
    expect(snapshot!.reminders).toEqual([]);
    expect(snapshot!.counts.unreadMessages).toBe(0);
    expect(snapshot!.settings.workdays).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot!.conversation).toEqual({ workspaceId: 'ws-assistant', nodeId: 'companion-node', assistant: null });
    expect(snapshot!.items.map((item) => item.id)).toEqual(['ok']);
  });

  it('is not a snapshot when the shape is another answer (the e2e mock, another backend)', () => {
    expect(parseCompanionSnapshot({ __unmocked: '/companion' })).toBeNull();
    expect(parseCompanionSnapshot({ ...companionSnapshotDto(), revision: '3' })).toBeNull();
    expect(parseCompanionSnapshot({ ...companionSnapshotDto(), settings: { enabled: 'yes' } })).toBeNull();
    expect(parseCompanionSnapshot(null)).toBeNull();
  });
});

describe('Companion requests', () => {
  it('treats a 404 and a wrong shape as no Companion here', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'not available', code: 'not_found' }, 404)));
    await expect(fetchCompanion()).rejects.toSatisfy(isCompanionUnavailable);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ __unmocked: '/companion' })));
    await expect(fetchCompanion()).rejects.toSatisfy(isCompanionUnavailable);
  });

  it('keeps a failing backend apart from a missing one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'boom', code: 'internal' }, 500)));
    const error = await fetchCompanion().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CompanionApiError);
    expect(isCompanionUnavailable(error)).toBe(false);
  });

  it('carries the card a refused decision names', async () => {
    const card = { id: 'cmc-1', kind: 'goal.add', payload: { text: 'Ship it' }, summary: 'Add the goal “Ship it”', reason: null, status: 'expired', error: null, createdAt: 1, decidedAt: null, expiresAt: 2 };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'expired', code: 'card_expired', card }, 409)));
    const error = await applyCompanionCard('cmc-1').catch((cause: unknown) => cause) as CompanionApiError;
    expect(error.code).toBe('card_expired');
    expect(error.card?.status).toBe('expired');
  });

  it('sends the presence beacon with composing, accepting 204 or an older 200 answer', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(null, 204));
    vi.stubGlobal('fetch', fetchMock);
    await postCompanionPresence({ active: true, companionFocused: true, lastInputAt: 5, composing: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/companion\/presence$/);
    expect(JSON.parse(String(init.body))).toEqual({ active: true, companionFocused: true, lastInputAt: 5, composing: true });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ catchUp: null })));
    await expect(postCompanionPresence({ active: false, companionFocused: false, lastInputAt: null, composing: false })).resolves.toBeUndefined();
  });
});

describe('the Companion change feed', () => {
  const sse = (text: string) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const notice = { id: 'cmn-1', title: 'Companion', body: 'CR-1 needs attention', target: { kind: 'companion', tab: 'today' }, itemIds: ['cmi-1'], createdAt: 1, expiresAt: 2 };

  it('hands on changes, and the notices the backend’s gate sends; nothing else', async () => {
    stream.fetchStream.mockResolvedValue(sse([
      `event: companion_changed\ndata: ${JSON.stringify({ type: 'companion_changed', revision: 3, reason: 'status' })}\n\n`,
      `event: companion_notice\ndata: ${JSON.stringify(notice)}\n\n`,
      `event: companion_notice\ndata: ${JSON.stringify({ ...notice, id: 'cmn-2', target: { kind: 'elsewhere' } })}\n\n`,
      'event: companion_notice\ndata: {"id":"cmn-3"}\n\n',
      `event: other\ndata: ${JSON.stringify(notice)}\n\n`,
    ].join('')));
    const onEvent = vi.fn();
    const onNotice = vi.fn();
    const ended = new Promise<Error | undefined>((resolve) => subscribeCompanionEvents({ onEvent, onNotice, onDisconnect: resolve }));
    expect(await ended).toBeUndefined();
    expect(String(stream.fetchStream.mock.calls[0][0])).toMatch(/\/companion\/events$/);
    expect(onEvent.mock.calls).toEqual([[{ type: 'companion_changed', revision: 3, reason: 'status' }]]);
    expect(onNotice.mock.calls).toEqual([[notice]]);
  });

  it('keeps the item a Companion target names on Today, and only a well-formed one', () => {
    const today = { kind: 'companion', tab: 'today' } as const;
    expect(parseCompanionNotice({ ...notice, target: { ...today, itemId: 'cmi-1' } })?.target).toEqual({ ...today, itemId: 'cmi-1' });
    for (const itemId of ['', 7, null, 'x'.repeat(161)]) {
      expect(parseCompanionNotice({ ...notice, target: { ...today, itemId } })?.target, String(itemId)).toEqual(today);
    }
    // Chat has no item to bring into view.
    expect(parseCompanionNotice({ ...notice, target: { kind: 'companion', tab: 'chat', itemId: 'cmi-1' } })?.target).toEqual({ kind: 'companion', tab: 'chat' });
    // An item's own target keeps it too (a reminder about another item opens Today there).
    const snapshot = parseCompanionSnapshot(companionSnapshotDto({ items: [companionItem('cmi-r', { target: { ...today, itemId: 'cmi-1' } })] }));
    expect(snapshot?.items[0].target).toEqual({ ...today, itemId: 'cmi-1' });
  });

  it('reads a notice only with a target this window can open and item ids', () => {
    expect(parseCompanionNotice(notice)).toEqual(notice);
    expect(parseCompanionNotice({ ...notice, target: { kind: 'node', workspaceId: 'ws-1', nodeId: 'n-1' } })?.target).toEqual({ kind: 'node', workspaceId: 'ws-1', nodeId: 'n-1' });
    expect(parseCompanionNotice({ ...notice, target: { kind: 'companion', tab: 'elsewhere' } })).toBeNull();
    expect(parseCompanionNotice({ ...notice, itemIds: [7] })).toBeNull();
    expect(parseCompanionNotice({ ...notice, expiresAt: Number.NaN })).toBeNull();
    expect(parseCompanionNotice(null)).toBeNull();
  });
});

describe('v2 snapshot fields (DESIGN-v2 §8.1)', () => {
  const delegation = {
    id: 'd1', workspaceId: 'ws1', nodeId: 'n1', title: 'Fix CI', state: 'following', origin: 'card', autoSend: true,
    createdAt: 5, lastSentAt: null, lastReportedAt: 7, closedAt: null, closedReason: null,
  };

  it('reads status.firstLook, welcome, delegations, origins, check-in changes and run changes', () => {
    const base = companionSnapshotDto();
    const snapshot = parseCompanionSnapshot({
      ...base,
      settings: { ...base.settings, reasoning: 'medium' },
      status: { ...base.status, working: true, firstLook: true },
      welcome: { wanted: false, nameMe: true },
      delegations: [delegation, { id: 'broken' }],
      notesOrigin: 'checkin',
      goals: [{ id: 'g1', text: 'Ship', progress: null, progressAt: null, createdAt: 1, updatedAt: 1, textOrigin: 'checkin' }],
      checkinChanges: [
        { id: 'c1', runId: 'r1', targetKind: 'item', targetId: 'i1', action: 'dismiss', reason: 'done', title: 'CR 1', at: 9, undoneAt: null },
        { id: 'c2', runId: 'r1', targetKind: 'page', targetId: 'p1', action: 'dismiss', at: 9 },
      ],
      activity: [
        { id: 'r1', kind: 'heartbeat', trigger: 'timer', outcome: 'superseded', detail: null, startedAt: 1, finishedAt: 2,
          postedMessageId: 'cmp-post-r1', undoneAt: 3,
          changes: [{ kind: 'page', id: 'p1', title: 'Tasks', applied: 3, proposed: 0 }, { kind: 'nope', id: 'x', applied: 1, proposed: 0 }] },
      ],
    });
    expect(snapshot?.settings.reasoning).toBe('medium');
    expect(snapshot?.status.firstLook).toBe(true);
    expect(snapshot?.welcome, 'an older backend’s nameMe is dropped').toEqual({ wanted: false });
    expect(snapshot?.delegations).toEqual([delegation]);
    expect(snapshot?.notesOrigin).toBe('checkin');
    expect(snapshot?.goals[0].textOrigin).toBe('checkin');
    expect(snapshot?.checkinChanges?.map((change) => change.id)).toEqual(['c1']);
    // A superseded run is a run (the MVP parser dropped it); its changes keep the good entries.
    expect(snapshot?.activity).toHaveLength(1);
    expect(snapshot?.activity[0]).toMatchObject({ outcome: 'superseded', postedMessageId: 'cmp-post-r1', undoneAt: 3,
      changes: [{ kind: 'page', id: 'p1', title: 'Tasks', applied: 3, proposed: 0 }] });
  });

  it('reads whether a check-in’s change still stands, and when its snooze ends (W3-F3-review #1)', () => {
    const base = companionSnapshotDto();
    const change = { runId: 'r1', targetKind: 'item', targetId: 'i1', reason: 'later', title: 'CR 1', at: 9, undoneAt: null };
    const snapshot = parseCompanionSnapshot({
      ...base,
      checkinChanges: [
        { ...change, id: 'c1', action: 'snooze', standing: true, snoozedUntil: 99 },
        { ...change, id: 'c2', action: 'dismiss', standing: false, snoozedUntil: null },
        // A backend that does not say: nothing stands.
        { ...change, id: 'c3', action: 'dismiss' },
        { ...change, id: 'c4', action: 'dismiss', standing: 'yes', snoozedUntil: 'soon' },
      ],
    });
    expect(snapshot?.checkinChanges?.map(({ id, standing, snoozedUntil }) => [id, standing, snoozedUntil])).toEqual([
      ['c1', true, 99], ['c2', false, null], ['c3', false, null], ['c4', false, null],
    ]);
  });

  it('leaves the v2 fields out when an older backend sends none', () => {
    const snapshot = parseCompanionSnapshot(companionSnapshotDto());
    expect(snapshot?.welcome).toBeUndefined();
    expect(snapshot?.delegations).toBeUndefined();
    expect(snapshot?.status.firstLook).toBeUndefined();
    expect(snapshot?.settings.reasoning).toBeNull();
  });

  it('keeps a notice\'s channel, reading null as the agent\'s own', () => {
    const notice = { id: 'n1', title: 't', body: 'b', target: { kind: 'companion', tab: 'chat' }, itemIds: [], createdAt: 1, expiresAt: 2 };
    expect(parseCompanionNotice({ ...notice, channel: 'chat' })?.channel).toBe('chat');
    expect(parseCompanionNotice({ ...notice, channel: null })?.channel).toBe('companion');
  });

  it('Undo all posts to the run\'s undo path and reads the result', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ reverted: ['pc1', 'c1'], conflicts: [{ changeId: 'pc2', message: 'Edited since' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(undoCompanionRun('r/1')).resolves.toEqual({ reverted: ['pc1', 'c1'], conflicts: [{ changeId: 'pc2', message: 'Edited since' }] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/companion\/runs\/r%2F1\/undo$/);
    expect(init.method).toBe('POST');
  });

  it('turns a delegation\'s auto-send off with PATCH {autoSend:false}', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ...delegation, autoSend: false }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(stopCompanionDelegationAutoSend('d1')).resolves.toMatchObject({ id: 'd1', autoSend: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/companion\/delegations\/d1$/);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ autoSend: false });
  });

  it('New conversation resets the assistant (no /companion/reset) and reads the snapshot again', async () => {
    const info = { nodeId: 'v2', workspaceId: 'ws-assistant', treeId: 't2', settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] };
    const fetchMock = vi.fn(async (url: string) => (url.endsWith('/assistant/reset') ? jsonResponse(info) : jsonResponse(companionSnapshotDto())));
    vi.stubGlobal('fetch', fetchMock);
    await resetCompanionConversation('v1');
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown as [string])[0]));
    expect(urls[0]).toMatch(/\/assistant\/reset$/);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ nodeId: 'v1' });
    expect(urls.some((url) => url.endsWith('/companion/reset'))).toBe(false);
    expect(urls[1]).toMatch(/\/companion$/);
  });
});
