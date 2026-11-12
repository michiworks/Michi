import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * The conversations' notices while no window is open (services/companion/
 * chatNotices.ts, DESIGN-v2 §5.2): once the last window has been gone five
 * seconds, an approval request, a question and a finished reply each notify
 * once per turn, by the user's chat notification level, never by the
 * Companion's quiet hours, workdays, caps, level or on/off switch; V is
 * titled with the agent's name and opens the panel, any other conversation
 * by its title and opens it; a window open, or gone for less than the
 * grace, notifies nothing; posts, narration, check-ins, scheduled runs,
 * maintenance chats, Trash and other system conversations never notify; an
 * answered request is withdrawn before any notifier shows it; a stopped or
 * failed turn is no reply; V waiting on the user is a change for the tray.
 * What comes within the grace is looked at again once it is up (an approval
 * asked right after the window closed is not lost), and a restart withdraws
 * the approvals and questions the stopped backend stored. A fake chatHub
 * feed, a fake clock and timers, a real outbox in a temp MICHI_DATA_DIR;
 * then the same through the real chatHub's background feed (private
 * check-in turns never reach it; every frame names its turn).
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkinNodeId, companionCheckinTurnId, type ChatStreamEvent, type CompanionNotice } from 'michi-shared';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import { AttentionFeed } from '../src/services/attention/attentionFeed';
import { AttentionService, DESKTOP_NOTIFIER_WINDOW_ID, type DesktopChatNotice } from '../src/services/attention/attentionService';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  CHAT_NOTICE_WINDOW_GRACE_MS,
  getChatNotificationLevel,
  setChatNotificationLevel,
  startChatNotices,
  type ChatNoticeHub,
  type RunningChatNotices,
} from '../src/services/companion/chatNotices';
import { CompanionEventBus, enqueueCompanionNotice, replayCompanionNotices } from '../src/services/companion/delivery';
import { pendingNotices } from '../src/services/companion/repository';
import { patchCompanionSettings } from '../src/services/companion/settings';
import { collect, manualClock } from './helpers/attentionHarness';
import { chatOwner } from './helpers/owners';

const MINUTE = 60_000;
/** Thursday 2026-11-05, 12:00 local. */
const T0 = new Date(2026, 10, 5, 12, 0, 0, 0).getTime();
const V = 'n-v';

type Send = Parameters<ChatNoticeHub['subscribeBackground']>[0];

class FakeHub implements ChatNoticeHub {
  subscriber: Send | null = null;
  subscribeBackground(subscriber: Send): () => void {
    this.subscriber = subscriber;
    return () => { this.subscriber = null; };
  }
  emit(nodeId: string, event: ChatStreamEvent): void {
    this.subscriber?.send(nodeId, event, false);
  }
}

let tmpDir: string;
let now: number;
let hub: FakeHub;
let bus: CompanionEventBus;
let notices: CompanionNotice[];
let changes: string[];
let scheduled: Set<string>;
let running: RunningChatNotices;
let timers: Array<{ at: number; callback: () => void; cancelled: boolean }>;

/** A fake setTimer on the fake clock: elapse() runs what came due. */
function setTimer(callback: () => void, delayMs: number): () => void {
  const timer = { at: now + delayMs, callback, cancelled: false };
  timers.push(timer);
  return () => { timer.cancelled = true; };
}

function armed(): number {
  return timers.filter((timer) => !timer.cancelled).length;
}

function elapse(ms: number): void {
  const until = now + ms;
  for (;;) {
    const due = timers.filter((timer) => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    due.cancelled = true;
    now = Math.max(now, due.at);
    due.callback();
  }
  now = until;
}

function start(): RunningChatNotices {
  return startChatNotices({
    hub, bus, clock: () => now, conversationNodeId: () => V, isScheduledRun: (nodeId) => scheduled.has(nodeId), displayName: () => 'Robin', setTimer,
  });
}

function seed(): void {
  const db = getDb();
  const workspace = db.prepare('INSERT INTO workspaces (id, name, created_at, updated_at, settings, deleted_at) VALUES (?, ?, 1, 1, ?, ?)');
  workspace.run('ws-user', 'Auth', null, null);
  workspace.run('ws-assistant', 'Michi', JSON.stringify({ system: 'assistant' }), null);
  workspace.run('ws-trash', 'Old', null, 5);
  const node = db.prepare(`INSERT INTO nodes (id, workspace_id, kind, status, created_at, title, maintenance_job_id) VALUES (?, ?, 'chat', 'idle', 1, ?, ?)`);
  node.run(V, 'ws-assistant', 'Michi', null);
  node.run('n-1', 'ws-user', 'Fix the build', null);
  node.run('n-2', 'ws-user', '', null);
  node.run('n-sys', 'ws-assistant', 'An older conversation of the agent', null);
  node.run('n-trash', 'ws-trash', 'Gone', null);
  node.run('n-maint', 'ws-user', 'Pages upkeep', 'job-1');
  node.run('n-cmph-r1', 'ws-assistant', null, null);
}

/** One turn's frames, as chatHub stamps them (nodeId and turnId on each). */
function turn(nodeId: string, turnId: string, start: Record<string, unknown> = {}) {
  const frame = (event: string, data: Record<string, unknown> = {}) => hub.emit(nodeId, { event, data: { nodeId, turnId, ...data } } as unknown as ChatStreamEvent);
  frame('turn_start', { assistantId: `a-${turnId}`, userText: 'Please fix it', startedAt: now, ...start });
  return {
    approval: (title = 'Run npm test', requestId = 1) => frame('permission_request', { requestId, title, options: [] }),
    approved: (requestId = 1) => frame('permission_resolved', { requestId }),
    question: (question = 'Which branch?', requestId = 2) => frame('user_input_request', { requestId, questions: [{ question }] }),
    answered: (requestId = 2) => frame('user_input_resolved', { requestId, answers: [], outcome: 'answered' }),
    says: (text: string) => frame('chunk', { text }),
    done: (stopReason = 'end_turn') => frame('done', { stopReason }),
    failed: () => frame('error', { message: 'boom' }),
  };
}

const summary = (notice: CompanionNotice) => [notice.title, notice.body, notice.target, notice.channel];

describe('a conversation\'s approvals, questions and replies while no window is open', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-chat-notices-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    seed();
    now = T0;
    hub = new FakeHub();
    bus = new CompanionEventBus(undefined, { clock: () => now });
    notices = [];
    changes = [];
    scheduled = new Set();
    timers = [];
    bus.subscribe({ client: 'notifier', notice: (notice) => notices.push(notice), changed: (event) => changes.push(event.reason) });
    running = start();
    // No window since the backend started.
    now = T0 + CHAT_NOTICE_WINDOW_GRACE_MS;
  });

  afterEach(() => {
    running.stop();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('each kind once per turn: V under the agent\'s name, opening the panel; another conversation by its title, opening it', () => {
    const v = turn(V, 't-1');
    v.approval('Run npm test');
    v.approval('Run npm test again', 3);
    v.question('Which branch?');
    v.says('All green.\n\nDetails follow.');
    v.done();
    const panel = { kind: 'companion', tab: 'chat' };
    assert.deepEqual(notices.map(summary), [
      ['Robin: needs your approval', 'Run npm test', panel, 'chat'],
      ['Robin: has a question', 'Which branch?', panel, 'chat'],
      ['Robin replied', 'All green.', panel, 'chat'],
    ]);
    notices = [];
    const other = turn('n-1', 't-2');
    other.approval('Edit src/auth.ts');
    other.question('Ship it?');
    other.says('**Fixed** the header.');
    other.done();
    const conversation = { kind: 'node', workspaceId: 'ws-user', nodeId: 'n-1' };
    assert.deepEqual(notices.map(summary), [
      ['Fix the build', 'Needs your approval: Edit src/auth.ts', conversation, 'chat'],
      ['Fix the build', 'Has a question: Ship it?', conversation, 'chat'],
      ['Fix the build', 'Fixed the header.', conversation, 'chat'],
    ]);
    notices = [];
    turn('n-2', 't-3').approval('Run it');
    turn(V, 't-4').approval('Run it once more');
    assert.deepEqual(notices.map((notice) => notice.title), ['Conversation', 'Robin: needs your approval'], 'an untitled one; and a new turn may notify again');
    assert.ok(pendingNotices(now).some((notice) => notice.title === 'Robin: needs your approval'), 'in the outbox: replayed to a notifier that connects later');
  });

  test('a window open notifies nothing: it notifies itself; gone for less than five seconds, nothing yet, and nothing once it is back', () => {
    const closeWindow = bus.subscribe({ client: 'window' });
    const first = turn('n-1', 't-1');
    first.approval();
    first.says('Done.');
    first.done();
    assert.equal(armed(), 0, 'nothing to look at again');
    closeWindow();
    elapse(CHAT_NOTICE_WINDOW_GRACE_MS - 1);
    turn('n-1', 't-2').approval();
    assert.deepEqual(notices, [], 'a window that only reloads is back within the grace');
    const reloaded = bus.subscribe({ client: 'window' });
    elapse(1);
    assert.deepEqual(notices, [], 'it came back: it shows its own');
    reloaded();
    elapse(CHAT_NOTICE_WINDOW_GRACE_MS);
    turn('n-1', 't-3').approval();
    assert.equal(notices.length, 1);
  });

  test('an approval asked right after the last window closed is notified once the grace is up, if still unanswered (H-review #1)', () => {
    const closeWindow = bus.subscribe({ client: 'window' });
    const v = turn(V, 't-1');
    closeWindow();
    elapse(2_000);
    v.approval('Run npm test');
    v.approval('Run npm test again', 3);
    assert.deepEqual(notices, [], 'within the grace');
    elapse(CHAT_NOTICE_WINDOW_GRACE_MS - 2_000 - 1);
    assert.deepEqual(notices, []);
    elapse(1);
    assert.deepEqual(notices.map(summary), [['Robin: needs your approval', 'Run npm test again', { kind: 'companion', tab: 'chat' }, 'chat']],
      'once, about the request that still waits');
    elapse(60 * MINUTE);
    assert.equal(notices.length, 1, 'once per turn and kind');

    // Answered, or the turn ended, within the grace: nothing waits any more, so nothing goes out.
    const again = () => bus.subscribe({ client: 'window' })();
    again();
    const answered = turn('n-1', 't-2');
    answered.approval();
    answered.approved();
    const ended = turn('n-2', 't-3');
    ended.question();
    ended.failed();
    assert.equal(armed(), 0, 'their looks again are cancelled');
    elapse(CHAT_NOTICE_WINDOW_GRACE_MS);
    assert.equal(notices.length, 1);

    // A reply that came within the grace goes out once it is up; stop() leaves no look again behind.
    again();
    const replied = turn('n-1', 't-4');
    replied.says('Fixed the header.');
    replied.done();
    elapse(CHAT_NOTICE_WINDOW_GRACE_MS);
    assert.deepEqual((notices as CompanionNotice[]).slice(1).map((notice) => notice.body), ['Fixed the header.']);
    again();
    turn('n-1', 't-5').approval();
    assert.equal(armed(), 1);
    running.stop();
    assert.equal(armed(), 0);
    elapse(CHAT_NOTICE_WINDOW_GRACE_MS);
    assert.equal(notices.length, 2);
  });

  test('a restart withdraws the approvals and questions the stopped backend stored, so no replay brings them back; replies stay (H-review #6)', () => {
    turn('n-1', 't-1').approval();
    turn('n-2', 't-2').question();
    const replied = turn(V, 't-3');
    replied.says('All green.');
    replied.done();
    assert.equal(pendingNotices(now).length, 3, 'the backend stops with two requests open: no done ever comes for them');
    running.stop();
    running = start();
    assert.deepEqual(replayCompanionNotices(now + 1).map((notice) => notice.title), ['Robin replied']);
    const asked = turn('n-1', 't-4');
    asked.approval();
    assert.deepEqual(pendingNotices(now).map((notice) => notice.title).sort(), ['Fix the build', 'Robin replied'], 'what this backend asks goes out as before');
  });

  test('by the chat notification level; the Companion\'s quiet hours, workdays, caps, level and off switch change nothing', () => {
    assert.equal(getChatNotificationLevel(), 'all', 'the renderer\'s default before it has sent one');
    patchCompanionSettings({ enabled: false, notifications: 'off', quietHours: { enabled: true, start: '00:00', end: '23:59' }, workdays: [0] });
    for (let index = 0; index < 12; index++) enqueueCompanionNotice({ title: 'Michi', body: 'Earlier', target: { kind: 'companion', tab: 'today' }, itemIds: [] }, now - MINUTE + index, { bus });
    notices = [];
    const all = turn('n-1', 't-1');
    all.approval();
    all.says('Done.');
    all.done();
    assert.equal(notices.length, 2, 'level all: the approval and the reply');
    notices = [];
    assert.equal(setChatNotificationLevel('approval-only'), true);
    const approvals = turn('n-1', 't-2');
    approvals.approval();
    approvals.question();
    approvals.says('Done.');
    approvals.done();
    assert.deepEqual(notices.map((notice) => notice.body), ['Needs your approval: Run npm test', 'Has a question: Which branch?'], 'no reply');
    notices = [];
    assert.equal(setChatNotificationLevel('off'), true);
    assert.equal(setChatNotificationLevel('off'), false, 'the same level again changes nothing');
    const off = turn(V, 't-3');
    off.approval();
    off.question();
    off.done();
    assert.deepEqual(notices, []);
    assert.equal(getChatNotificationLevel(), 'off');
    assert.throws(() => setChatNotificationLevel('loud' as never));
  });

  test('never for a check-in, a post or narration, a scheduled run, a maintenance chat, Trash or another system conversation', () => {
    turn('n-cmph-r1', 't-1').approval();
    const post = turn(V, 't-2', { selfInitiated: true, userText: '', assistantMetadata: { companionPost: { runId: 'r1', kind: 'heartbeat', changes: [] } } });
    post.says('Your CR is approved.');
    post.done();
    const narration = turn(V, 't-3', { selfInitiated: true, userText: '' });
    narration.says('I tidied your home page.');
    narration.done();
    scheduled.add('n-1');
    const run = turn('n-1', 't-4');
    run.approval();
    run.done();
    scheduled.clear();
    turn('n-1', 't-5', { userMetadata: { scheduledJobId: 'job-9' } }).approval();
    for (const nodeId of ['n-maint', 'n-trash', 'n-sys', 'n-missing']) {
      const other = turn(nodeId, `t-${nodeId}`);
      other.approval();
      other.says('Done.');
      other.done();
    }
    assert.equal(notices.length, 0, JSON.stringify(notices));
    const selfTurn = turn('n-1', 't-6', { selfInitiated: true, userText: '' });
    selfTurn.approval('Run the build');
    selfTurn.says('Built.');
    selfTurn.done();
    assert.deepEqual(notices.map((notice) => notice.body), ['Needs your approval: Run the build'],
      'a turn the agent started itself still asks the user; its end is no reply to anyone');
  });

  test('an answered request is withdrawn before a notifier shows it; a stopped or failed turn is no reply', () => {
    const first = turn('n-1', 't-1');
    first.approval();
    first.approved();
    first.question();
    const [approval, question] = notices;
    first.says('Done.');
    first.done();
    const reply = notices[2]!;
    assert.equal(notices.length, 3);
    const waiting = pendingNotices(now).map((notice) => notice.id);
    assert.ok(!waiting.includes(approval!.id), 'answered: withdrawn');
    assert.ok(!waiting.includes(question!.id), 'the turn ended: nobody waits on it any more');
    assert.ok(waiting.includes(reply.id), 'the reply stays until shown');
    assert.deepEqual(replayCompanionNotices(now + 1).map((notice) => notice.id), [reply.id]);
    notices = [];
    const stopped = turn('n-1', 't-2');
    stopped.says('Half');
    stopped.done('cancelled');
    const failed = turn('n-1', 't-3');
    failed.says('Half');
    failed.failed();
    assert.deepEqual(notices, []);
  });

  test('V waiting on the user, and no longer, is a conversation change: the tray says "<name> is waiting for you"', () => {
    const v = turn(V, 't-1');
    v.approval();
    assert.deepEqual(changes, ['conversation']);
    v.approved();
    v.question();
    v.answered();
    v.done();
    assert.deepEqual(changes, ['conversation', 'conversation', 'conversation', 'conversation', 'conversation']);
    changes = [];
    const other = turn('n-1', 't-2');
    other.approval();
    other.done();
    turn(V, 't-3').done();
    assert.deepEqual(changes, [], 'another conversation, or a V turn that never waited');
  });

  test('stop() detaches it from chatHub', () => {
    running.stop();
    assert.equal(hub.subscriber, null);
    turn('n-1', 't-1').approval();
    assert.deepEqual(notices, []);
  });

  test('one OS notification per event with the attention records: what a window raised is not notified, what goes out is told', () => {
    running.stop();
    const told: string[] = [];
    const inWindow = new Set<string>();
    const named = (notice: DesktopChatNotice) => `${notice.nodeId}/${notice.turnId}/${notice.kind}/${notice.requestId ?? '-'}`;
    running = startChatNotices({
      hub, bus, clock: () => now, conversationNodeId: () => V, isScheduledRun: () => false, displayName: () => 'Robin', setTimer,
      attention: { shownInWindow: (notice) => inWindow.has(named(notice)), shownByDesktop: (notice) => { told.push(named(notice)); } },
    });
    const first = turn('n-1', 't-1');
    first.approval('Run npm test', 1);
    first.says('Done.');
    first.done();
    assert.deepEqual(told, ['n-1/t-1/approval/1', 'n-1/t-1/reply/-']);
    inWindow.add('n-1/t-2/approval/1');
    turn('n-1', 't-2').approval('Run npm test', 1);
    assert.equal(notices.length, 2, 'a window that was still there raised it: nothing from here');

    // Within the grace, the request that still waits once it is up is the one told.
    bus.subscribe({ client: 'window' })();
    const later = turn('n-1', 't-3');
    later.approval('Run npm test', 1);
    later.approval('Run npm test again', 3);
    elapse(CHAT_NOTICE_WINDOW_GRACE_MS);
    assert.deepEqual(told.slice(2), ['n-1/t-3/approval/3']);
    assert.equal(notices.length, 3);
  });
});

// ── Through the real chatHub (its background feed, foreground turns included) ──

/** A runtime session whose turn yields `events`. */
function sessionFor(id: string, events: NormalizedEvent[]): AgentSession {
  return {
    id, runtimeId: 'kiro', owner: chatOwner(id),
    getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {
      for (const event of events) yield event;
    },
    cancel: () => ({ acknowledged: true }),
  } as unknown as AgentSession;
}

/** A turn that asks for approval, then answers and ends without the request answered. */
const asksThenAnswers = (title: string): NormalizedEvent[] => [
  { kind: 'permission_request', requestId: 7, title, options: [] },
  { kind: 'chunk', text: 'Fixed the header.' },
  { kind: 'turn_end', stopReason: 'end_turn' },
];

describe('through the real chatHub feed: private check-in turns never notify; every frame names its turn', () => {
  let realHub: ChatHub;
  let frames: Array<{ chatId: string; event: ChatStreamEvent }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-chat-notices-hub-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    seed();
    now = T0;
    timers = [];
    bus = new CompanionEventBus(undefined, { clock: () => now });
    notices = [];
    bus.subscribe({ client: 'notifier', notice: (notice) => notices.push(notice) });
    realHub = new ChatHub({
      retentionMs: 60_000,
      workspaceIdForNode: (nodeId) => (nodeId === 'n-1' || nodeId === 'n-2' ? 'ws-user' : 'ws-assistant'),
      lookupDurableTurn: () => null,
      memoryInjector: null,
      isAssistantNode: (nodeId) => nodeId === V,
      persistence: { begin: () => {}, checkpoint: () => {}, finalize: () => {} },
    });
    frames = [];
    realHub.subscribeBackground({ includeForeground: true, send: (chatId, event) => frames.push({ chatId, event }), close() {} });
    running = startChatNotices({ hub: realHub, bus, clock: () => now, conversationNodeId: () => V, displayName: () => 'Robin', setTimer });
    now = T0 + CHAT_NOTICE_WINDOW_GRACE_MS;
  });

  afterEach(() => {
    running.stop();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a check-in in its node, and a turn flagged private anywhere, reach neither the feed nor a notice; an ordinary turn does', async () => {
    const checkin = checkinNodeId('run1');
    const inNode = await realHub.startRequestedSelfTurn({
      chatId: checkin, nodeId: checkin, turnId: companionCheckinTurnId('run1'), text: 'the note', private: true, memoryContext: null,
      session: sessionFor(checkin, asksThenAnswers('Run the CR query')),
    });
    await inNode.done;
    const flagged = await realHub.startRequestedSelfTurn({
      chatId: 'n-2', nodeId: 'n-2', turnId: 'req-private', text: 'the note', displayText: 'the note', private: true,
      session: sessionFor('n-2', asksThenAnswers('Read the inbox')),
    });
    await flagged.done;
    assert.equal(frames.length, 0, 'chatHub broadcast nothing of them');
    assert.equal(notices.length, 0, 'so nothing was notified');

    const ordinary = await realHub.startTurn({
      chatId: 'n-1', nodeId: 'n-1', turnId: 't-visible', text: 'Please fix it', session: sessionFor('n-1', asksThenAnswers('Edit src/auth.ts')),
    });
    await ordinary.done;
    assert.deepEqual(notices.map((notice) => [notice.title, notice.body, notice.channel]), [
      ['Fix the build', 'Needs your approval: Edit src/auth.ts', 'chat'],
      ['Fix the build', 'Fixed the header.', 'chat'],
    ]);
    assert.ok(frames.length >= 3, `the turn's frames: ${frames.map(({ event }) => event.event).join(', ')}`);
    for (const { chatId, event } of frames) {
      assert.equal(chatId, 'n-1');
      assert.deepEqual([event.data.turnId, event.data.nodeId], ['t-visible', 'n-1'], `${event.event} names its turn and node`);
    }
    assert.ok(!pendingNotices(now).some((notice) => notice.body.startsWith('Needs your approval')), 'the turn ended: its approval is withdrawn');
  });

  test('with the attention service as server.ts wires it, the approval notified here is claimed for the notifier: a window that opens later lists it without raising it', async () => {
    const clock = manualClock();
    const feed = new AttentionFeed();
    const attention = new AttentionService({ presence: { isTargetVisibleInFocusedWindow: () => false }, feed, clock });
    attention.start();
    // Subscribed before the notices, as in server.ts.
    const detach = realHub.subscribeBackground({ includeForeground: true, send: (_chatId, event) => attention.observeChatEvent(event), close() {} });
    running.stop();
    running = startChatNotices({ hub: realHub, bus, clock: () => now, conversationNodeId: () => V, displayName: () => 'Robin', setTimer, attention });
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const session = sessionFor('n-1', []);
    session.send = async function* () {
      yield { kind: 'permission_request', requestId: 7, title: 'Edit src/auth.ts', options: [] } as NormalizedEvent;
      await answered;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    } as AgentSession['send'];
    try {
      const waiting = await realHub.startTurn({ chatId: 'n-1', nodeId: 'n-1', turnId: 't-waits', text: 'Please fix it', session });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(notices.map((notice) => notice.body), ['Needs your approval: Edit src/auth.ts']);
      clock.advance(1_000);
      const [record] = collect(feed, 'local-user').of('attention_snapshot')[0].notifications;
      assert.equal(record.claimedByWindowId, DESKTOP_NOTIFIER_WINDOW_ID);
      answer();
      await waiting.done;
    } finally {
      detach();
      attention.stop();
    }
  });
});
