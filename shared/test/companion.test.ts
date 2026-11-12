import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CHAT_NOTIFICATION_LEVELS,
  CHECKIN_NODE_PREFIX,
  COMPANION_ACTOR_VIAS,
  COMPANION_CHAT_NOTIFICATION_LEVEL_PATH,
  COMPANION_CHECKIN_KINDS,
  COMPANION_LIMITS,
  COMPANION_TRAY_PATH,
  COMPANION_TURN_REF_LIMITS,
  DEFAULT_CHAT_NOTIFICATION_LEVEL,
  DEFAULT_COMPANION_NAME,
  DEFAULT_COMPANION_SETTINGS,
  MetaAgentChatContextError,
  checkinNodeId,
  checkinRunId,
  companionPostId,
  companionPostRunId,
  isChatNotificationLevel,
  isCheckinNodeId,
  isCompanionActor,
  isCompanionNotice,
  parseCompanionPostMetadata,
  parseCompanionTurnRefs,
  COMPANION_CHECKIN_TURN_PREFIX,
  COMPANION_DELEGATIONS_PATH,
  COMPANION_GOAL_CHANGE_ACTIONS,
  COMPANION_ITEM_CHANGE_ACTIONS,
  COMPANION_SEND_TURN_PREFIX,
  LEGACY_DEFAULT_COMPANION_NAME,
  companionChangeActionsFor,
  companionCheckinTurnId,
  companionCheckinTurnRunId,
  companionDelegationPath,
  companionNoticeChannel,
  companionRunUndoPath,
  companionSendTurnId,
  companionSendTurnRunId,
  isCheckinBlockSource,
  isCompanionDelegationPatch,
  parseCompanionSessionSendCardPayload,
  parseCompanionTurnMetadata,
  type BlockSource,
  type CompanionCheckinKind,
  type CompanionNotice,
  type CompanionRunKind,
  type CompanionSessionSendCardPayload,
} from '../src/index';

describe('the agent before the user names it (DESIGN-v2 Q4, §6)', () => {
  test('is called Michi, with the default reasoning', () => {
    assert.equal(DEFAULT_COMPANION_NAME, 'Michi');
    assert.equal(DEFAULT_COMPANION_SETTINGS.displayName, 'Michi');
    assert.equal(DEFAULT_COMPANION_SETTINGS.reasoning, null);
  });
});

describe('check-in node and post ids (DESIGN-v2 §2.2, §3.3)', () => {
  test('the n-cmph- prefix alone makes a node a check-in', () => {
    assert.equal(CHECKIN_NODE_PREFIX, 'n-cmph-');
    assert.equal(checkinNodeId('cmr-1'), 'n-cmph-cmr-1');
    assert.equal(isCheckinNodeId(checkinNodeId('cmr-1')), true);
    for (const id of ['n-1', 'n-cmp-1', 'N-CMPH-cmr-1', ' n-cmph-cmr-1', '', null, undefined]) {
      assert.equal(isCheckinNodeId(id), false, String(id));
    }
  });

  test('a check-in node and a posted message both lead back to their run', () => {
    assert.equal(checkinRunId('n-cmph-cmr-1'), 'cmr-1');
    assert.equal(checkinRunId('n-cmph-'), null);
    assert.equal(checkinRunId('n-1'), null);
    assert.equal(checkinRunId(null), null);
    assert.equal(companionPostId('cmr-1'), 'cmp-post-cmr-1');
    assert.equal(companionPostRunId('cmp-post-cmr-1'), 'cmr-1');
    assert.equal(companionPostRunId('cmp-cmr-1'), null, "a check-in's own turn is not a post");
    assert.equal(companionPostRunId('cmp-post-'), null);
    assert.equal(companionPostRunId(undefined), null);
  });
});

describe('run kinds (DESIGN-v2 §3.1, §4)', () => {
  test('check-in kinds are every run kind but polls and sends', () => {
    // Compile-time: this record must name every CompanionCheckinKind, and nothing else.
    const every: Record<CompanionCheckinKind, true> = { heartbeat: true, brief: true, welcome: true, catch_up: true, worker_report: true, wake: true };
    assert.deepEqual([...COMPANION_CHECKIN_KINDS].sort(), Object.keys(every).sort());
    const notCheckins: CompanionRunKind[] = ['poll', 'send'];
    for (const kind of notCheckins) assert.equal((COMPANION_CHECKIN_KINDS as readonly string[]).includes(kind), false, kind);
  });
});

describe('posted check-in metadata (DESIGN-v2 §3.3)', () => {
  test('reads a post and keeps only well-formed changes', () => {
    const post = parseCompanionPostMetadata({
      runId: 'cmr-1',
      kind: 'heartbeat',
      changes: [
        { kind: 'page', id: 'p1', title: 'Tasks', applied: 3, proposed: 1 },
        { kind: 'item', id: 'cmi-1', title: '', applied: 1, proposed: 0 },
        { kind: 'goal', id: 'cmg-1', applied: 0, proposed: 0 },
        { kind: 'block', id: 'b1', applied: 1, proposed: 0 },
        { kind: 'database', id: '', applied: 1, proposed: 0 },
        { kind: 'database', id: 'd1', applied: -1, proposed: 0 },
        { kind: 'database', id: 'd2', applied: 1.5, proposed: 0 },
        null,
        'page',
      ],
    });
    assert.deepEqual(post, {
      runId: 'cmr-1',
      kind: 'heartbeat',
      changes: [
        { kind: 'page', id: 'p1', title: 'Tasks', applied: 3, proposed: 1 },
        { kind: 'item', id: 'cmi-1', applied: 1, proposed: 0 },
        { kind: 'goal', id: 'cmg-1', applied: 0, proposed: 0 },
      ],
    });
    assert.deepEqual(parseCompanionPostMetadata({ runId: 'cmr-2', kind: 'brief' }), { runId: 'cmr-2', kind: 'brief', changes: [] });
  });

  test('is not a post without a run or a check-in kind', () => {
    for (const value of [null, 'cmr-1', [], {}, { runId: '', kind: 'heartbeat' }, { runId: 'cmr-1', kind: 'poll' }, { runId: 'cmr-1', kind: 'send' }, { runId: 7, kind: 'wake' }]) {
      assert.equal(parseCompanionPostMetadata(value), undefined, JSON.stringify(value));
    }
  });

  test('keeps what a check-in did to items and goals, and why (W0 review #6)', () => {
    const post = parseCompanionPostMetadata({
      runId: 'cmr-1',
      kind: 'heartbeat',
      changes: [
        { kind: 'item', id: 'cmi-1', applied: 1, proposed: 0, action: 'dismiss', reason: 'Merged already' },
        { kind: 'goal', id: 'cmg-1', applied: 1, proposed: 0, action: 'reword', reason: 'Clearer' },
        { kind: 'item', id: 'cmi-2', applied: 1, proposed: 0, action: 'reword', reason: 'a goal action on an item' },
        { kind: 'page', id: 'p1', applied: 2, proposed: 0, action: 'remove' },
        { kind: 'goal', id: 'cmg-2', applied: 1, proposed: 0, action: 'add', reason: '  ' },
        { kind: 'item', id: 'cmi-3', applied: 1, proposed: 0, action: 'snooze', reason: 'x'.repeat(COMPANION_LIMITS.maxChangeReasonChars + 1) },
        { kind: 'item', id: 'cmi-4', applied: 1, proposed: 0, reason: 'no action' },
      ],
    });
    assert.deepEqual(post?.changes, [
      { kind: 'item', id: 'cmi-1', applied: 1, proposed: 0, action: 'dismiss', reason: 'Merged already' },
      { kind: 'goal', id: 'cmg-1', applied: 1, proposed: 0, action: 'reword', reason: 'Clearer' },
      { kind: 'item', id: 'cmi-2', applied: 1, proposed: 0 },
      { kind: 'page', id: 'p1', applied: 2, proposed: 0 },
      { kind: 'goal', id: 'cmg-2', applied: 1, proposed: 0, action: 'add' },
      { kind: 'item', id: 'cmi-3', applied: 1, proposed: 0, action: 'snooze' },
      { kind: 'item', id: 'cmi-4', applied: 1, proposed: 0 },
    ]);
    assert.deepEqual([...companionChangeActionsFor('item')], [...COMPANION_ITEM_CHANGE_ACTIONS]);
    assert.deepEqual([...COMPANION_ITEM_CHANGE_ACTIONS], ['snooze', 'dismiss', 'restore']);
    assert.deepEqual([...companionChangeActionsFor('goal')], [...COMPANION_GOAL_CHANGE_ACTIONS]);
    assert.deepEqual([...COMPANION_GOAL_CHANGE_ACTIONS], ['add', 'reword', 'remove']);
    assert.deepEqual([...companionChangeActionsFor('page')], []);
    assert.deepEqual([...companionChangeActionsFor('database')], []);
  });
});

describe('turn ids a run leads to (DESIGN-v2 §2.5, W0 review #20)', () => {
  test('a check-in turn, its post and a follow-up each lead back to their run, and only theirs', () => {
    assert.equal(COMPANION_CHECKIN_TURN_PREFIX, 'cmp-');
    assert.equal(COMPANION_SEND_TURN_PREFIX, 'cms-');
    assert.equal(companionCheckinTurnId('cmr-1'), 'cmp-cmr-1');
    assert.equal(companionSendTurnId('cmr-1'), 'cms-cmr-1');
    const readers = { checkin: companionCheckinTurnRunId, post: companionPostRunId, send: companionSendTurnRunId };
    const ids = { checkin: companionCheckinTurnId('cmr-1'), post: companionPostId('cmr-1'), send: companionSendTurnId('cmr-1') };
    for (const [idKind, id] of Object.entries(ids)) {
      for (const [readerKind, read] of Object.entries(readers)) {
        assert.equal(read(id), idKind === readerKind ? 'cmr-1' : null, `${readerKind} reads ${id}`);
      }
    }
    for (const id of ['cmp-', 'cms-', 'self-n-1-t', 'a-1', '', null, undefined]) {
      assert.equal(companionCheckinTurnRunId(id), null, String(id));
      assert.equal(companionSendTurnRunId(id), null, String(id));
    }
  });
});

describe('what the route decided about a user message (DESIGN-v2 §1.3, §2.8 T4, W0 review #4)', () => {
  test('reads the rules line and the start taint', () => {
    assert.deepEqual(parseCompanionTurnMetadata({ rulesUnavailable: true }), { rulesUnavailable: true });
    assert.deepEqual(parseCompanionTurnMetadata({ startTaint: 'collector' }), { startTaint: 'collector' });
    assert.deepEqual(parseCompanionTurnMetadata({ rulesUnavailable: true, startTaint: 'checkin', extra: 1 }), { rulesUnavailable: true, startTaint: 'checkin' });
    assert.deepEqual(parseCompanionTurnMetadata({ rulesUnavailable: false, startTaint: 'checkin' }), { startTaint: 'checkin' });
  });

  test('says nothing for anything else', () => {
    for (const value of [null, undefined, [], 'checkin', {}, { rulesUnavailable: false }, { rulesUnavailable: 'yes' }, { startTaint: 'user' }]) {
      assert.equal(parseCompanionTurnMetadata(value), undefined, JSON.stringify(value));
    }
  });
});

describe('session.send cards (DESIGN-v2 §4, W0 review #7)', () => {
  const stored: CompanionSessionSendCardPayload = {
    nodeId: 'n-worker', text: 'Rerun the failing stage.', afterMessageId: 'a-9', workspaceId: 'w1', title: 'Fix the pipeline', permissionWhenProposed: 'trust',
  };

  test('read back what was proposed and what the target was then', () => {
    assert.deepEqual(parseCompanionSessionSendCardPayload({ ...stored, extra: true }), stored);
    assert.deepEqual(parseCompanionSessionSendCardPayload({ ...stored, afterMessageId: null }), { ...stored, afterMessageId: null });
    assert.deepEqual(parseCompanionSessionSendCardPayload({ ...stored, permissionWhenProposed: 'approve' }), { ...stored, permissionWhenProposed: 'approve' });
  });

  test('are no preview without every field', () => {
    for (const value of [
      null, [], {}, { nodeId: 'n', text: 't', afterMessageId: null },
      { ...stored, permissionWhenProposed: undefined }, { ...stored, permissionWhenProposed: 'never' }, { ...stored, text: '' },
      { ...stored, workspaceId: '' }, { ...stored, title: 3 }, { ...stored, afterMessageId: '' }, { ...stored, afterMessageId: undefined },
    ]) {
      assert.equal(parseCompanionSessionSendCardPayload(value), undefined, JSON.stringify(value));
    }
  });
});

describe('routes the W0 review added (DESIGN-v2 §2.7, §4, W0 review #5, #9)', () => {
  test('undo a run, and turn a delegation\'s "stop asking" back off', () => {
    assert.equal(companionRunUndoPath('cmr-1'), '/companion/runs/cmr-1/undo');
    assert.equal(companionRunUndoPath('a/b'), '/companion/runs/a%2Fb/undo');
    assert.equal(COMPANION_DELEGATIONS_PATH, '/companion/delegations');
    assert.equal(companionDelegationPath('cmd-1'), '/companion/delegations/cmd-1');
    assert.equal(companionDelegationPath('a/b'), '/companion/delegations/a%2Fb');
    assert.equal(isCompanionDelegationPatch({ autoSend: false }), true);
    for (const value of [null, [], {}, { autoSend: true }, { autoSend: 'false' }, { autoSend: false, state: 'closed' }]) {
      assert.equal(isCompanionDelegationPatch(value), false, JSON.stringify(value));
    }
  });
});

describe('names and sources the v2 migration and renderers rely on (W0 review #12, #13)', () => {
  test('the MVP default name is not the v2 default', () => {
    assert.equal(LEGACY_DEFAULT_COMPANION_NAME, 'Companion');
    assert.notEqual(LEGACY_DEFAULT_COMPANION_NAME, DEFAULT_COMPANION_NAME);
  });

  test('a check-in source is told by its flag once resolved, or by its node id when not', () => {
    const resolved: BlockSource = { nodeId: 'n-v', turnId: 'cmp-post-cmr-1', assistantId: 'cmp-post-cmr-1', checkin: true };
    const stored: BlockSource = { nodeId: checkinNodeId('cmr-1'), turnId: 'cmp-cmr-1', assistantId: 'self-n-cmph-cmr-1-cmp-cmr-1' };
    const conversation: BlockSource = { nodeId: 'n-v', turnId: 'a-1', assistantId: 'a-1' };
    assert.equal(isCheckinBlockSource(resolved), true);
    assert.equal(isCheckinBlockSource(stored), true);
    assert.equal(isCheckinBlockSource(conversation), false);
  });

  test('the limits the W0 review added', () => {
    assert.equal(COMPANION_LIMITS.maxChangeReasonChars, 500);
    assert.equal(COMPANION_LIMITS.maxSnapshotCheckinChanges, 50);
  });
});

describe('notices and the chat notification level (DESIGN-v2 §5.2)', () => {
  const notice: CompanionNotice = { id: 'cmn-1', title: 'Michi', body: 'Needs your approval', target: { kind: 'companion', tab: 'chat' }, itemIds: [], createdAt: 1, expiresAt: 2 };

  test('a notice may name the gate it came through', () => {
    assert.equal(isCompanionNotice(notice), true);
    assert.equal(isCompanionNotice({ ...notice, channel: 'companion' }), true);
    assert.equal(isCompanionNotice({ ...notice, channel: 'chat' }), true);
    assert.equal(isCompanionNotice({ ...notice, channel: 'email' }), false);
  });

  test('a null channel is the Companion gate, so a nullable column does not drop old notices (W0 review #15)', () => {
    assert.equal(isCompanionNotice({ ...notice, channel: null }), true);
    assert.equal(companionNoticeChannel(notice), 'companion');
    assert.equal(companionNoticeChannel({ channel: null }), 'companion');
    assert.equal(companionNoticeChannel({ channel: 'companion' }), 'companion');
    assert.equal(companionNoticeChannel({ channel: 'chat' }), 'chat');
  });

  test('the chat level takes the renderer pref values, All by default', () => {
    assert.deepEqual([...CHAT_NOTIFICATION_LEVELS], ['all', 'approval-only', 'off']);
    assert.equal(DEFAULT_CHAT_NOTIFICATION_LEVEL, 'all');
    for (const level of CHAT_NOTIFICATION_LEVELS) assert.equal(isChatNotificationLevel(level), true);
    for (const value of ['important', 'All', '', null, 1]) assert.equal(isChatNotificationLevel(value), false, String(value));
    assert.equal(COMPANION_CHAT_NOTIFICATION_LEVEL_PATH, '/companion/chat-notification-level');
    assert.equal(COMPANION_TRAY_PATH, '/companion/tray');
  });
});

describe('what a message to the agent refers to (DESIGN-v2 §1.3, §2.8 T4)', () => {
  test('reads each kind of reference', () => {
    assert.deepEqual(parseCompanionTurnRefs([
      { kind: 'page', pageId: 'p1', blockId: 'b1' },
      { kind: 'page', pageId: 'p2' },
      { kind: 'rows', databaseId: 'd1', rowIds: ['r1', 'r2'] },
      { kind: 'companion_item', itemId: 'cmi-1' },
      { kind: 'post', messageId: 'cmp-post-cmr-1' },
    ]), [
      { kind: 'page', pageId: 'p1', blockId: 'b1' },
      { kind: 'page', pageId: 'p2' },
      { kind: 'rows', databaseId: 'd1', rowIds: ['r1', 'r2'] },
      { kind: 'companion_item', itemId: 'cmi-1' },
      { kind: 'post', messageId: 'cmp-post-cmr-1' },
    ]);
    assert.deepEqual(parseCompanionTurnRefs([]), []);
  });

  test('refuses anything else with the error metaAgentContext answers 400 for', () => {
    const tooMany = Array.from({ length: COMPANION_TURN_REF_LIMITS.refs + 1 }, () => ({ kind: 'companion_item', itemId: 'cmi-1' }));
    const manyRows = Array.from({ length: COMPANION_TURN_REF_LIMITS.rowIds + 1 }, (_, index) => `r${index}`);
    for (const value of [
      null, {}, 'refs', tooMany,
      [null], [['page']], [{ kind: 'thread', id: 'n1' }],
      [{ kind: 'page' }], [{ kind: 'page', pageId: 'p 1' }], [{ kind: 'page', pageId: 'p1', text: 'quoted' }],
      [{ kind: 'page', pageId: 'p1', blockId: null }], [{ kind: 'page', pageId: 'x'.repeat(COMPANION_TURN_REF_LIMITS.idChars + 1) }],
      [{ kind: 'rows', databaseId: 'd1', rowIds: [] }], [{ kind: 'rows', databaseId: 'd1', rowIds: manyRows }], [{ kind: 'rows', databaseId: 'd1', rowIds: [1] }],
      [{ kind: 'companion_item', itemId: '' }], [{ kind: 'post', messageId: 'cmp-post-1', text: 'x' }],
    ]) {
      assert.throws(() => parseCompanionTurnRefs(value), MetaAgentChatContextError, JSON.stringify(value)?.slice(0, 80));
    }
  });
});

describe('the agent as an author (DESIGN-v2 §2.7)', () => {
  test('a companion actor names how it wrote', () => {
    for (const via of COMPANION_ACTOR_VIAS) assert.equal(isCompanionActor({ kind: 'companion', via }), true, via);
    for (const value of [null, 'meta-agent', { kind: 'companion' }, { kind: 'companion', via: 'chat' }, { kind: 'meta-agent', via: 'checkin' }, [{ kind: 'companion', via: 'checkin' }]]) {
      assert.equal(isCompanionActor(value), false, JSON.stringify(value));
    }
  });
});

describe('v2 limits (DESIGN-v2 §2.6, §3.5, §3.6, §4)', () => {
  test('are the numbers the design gives', () => {
    assert.deepEqual({
      writeCalls: COMPANION_LIMITS.checkinMaxWriteCalls,
      targets: COMPANION_LIMITS.checkinMaxChangedTargets,
      pages: COMPANION_LIMITS.checkinMaxNewPages,
      databases: COMPANION_LIMITS.checkinMaxNewDatabases,
      goals: COMPANION_LIMITS.checkinMaxGoalEdits,
      daily: COMPANION_LIMITS.checkinMaxDailyWriteCalls,
      untold: COMPANION_LIMITS.maxUntoldPosts,
      recent: COMPANION_LIMITS.recentConversationMessages,
      recentChars: COMPANION_LIMITS.maxRecentConversationChars,
      sendChars: COMPANION_LIMITS.maxSendChars,
      sendsPerTurn: COMPANION_LIMITS.maxSessionSendsPerTurn,
      sendsPerCheckin: COMPANION_LIMITS.maxSessionSendsPerCheckin,
      pendingCards: COMPANION_LIMITS.maxPendingSessionSendCards,
      cardTtlHours: COMPANION_LIMITS.sessionSendCardTtlMs / 3_600_000,
      dailySends: COMPANION_LIMITS.maxDailySendsPerDelegation,
      idleHours: COMPANION_LIMITS.delegationIdleMs / 3_600_000,
      maxAgeDays: COMPANION_LIMITS.delegationMaxAgeMs / 86_400_000,
    }, {
      writeCalls: 5, targets: 40, pages: 1, databases: 1, goals: 3, daily: 20, untold: 5, recent: 6, recentChars: 4000,
      sendChars: 4000, sendsPerTurn: 3, sendsPerCheckin: 1, pendingCards: 3, cardTtlHours: 6, dailySends: 10, idleHours: 24, maxAgeDays: 3,
    });
  });
});
