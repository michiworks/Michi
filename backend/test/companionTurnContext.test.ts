import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * What the user's own turns in their conversation with the agent (V) carry
 * ahead of their message (DESIGN-v2 §3.5, §2.8 T1), through
 * services/companion/turnContext.ts:
 * - [COMPANION CONTEXT] quotes only the user's own words and Michi's facts:
 *   nothing a check-in wrote reaches it (its notes, the goals it worded, goal
 *   readings, the brief, card summaries and reasons, posts' text and
 *   reasons, item titles from the sources), while the user's rules, goals and
 *   notes do;
 * - the standing blocks (rules, goals, notes, sources off) go on a live
 *   session's first turn and again only when they changed, when the turn
 *   that carried them did not complete, after a compaction, or for a new
 *   session; Michi's per-turn facts go every turn;
 * - rules Michi cannot read: the message goes as it is, rulesUnavailable;
 * - card results and posts count as told once the turn began.
 * Also recentConversationExcerpt, a check-in's [RECENT CONVERSATION] (§3.6).
 * The route's side (E): companionConversationContext.test.ts. Temp
 * MICHI_DATA_DIR per test; chatHub is a fake.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHAT_STREAM_EVENTS, companionPostId, type ChatStreamEvent } from 'michi-shared';
import type { HubSubscriber, SettledTurnStatus } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import { ensureAssistant } from '../src/assistant/store';
import { closeDb, getDb, initDb } from '../src/services/db';
import { proposeCompanionCard, setCompanionCardDeps } from '../src/services/companion/cards';
import { localDateKey } from '../src/services/companion/clock';
import {
  addGoal,
  decideCard,
  editGoal,
  insertBrief,
  listUnreportedCards,
  listUntoldPosts,
  recordGoalProgress,
  recordRunPost,
  setCompanionRules,
  setNotesByCompanion,
  setNotesByUser,
  startRun,
  upsertItem,
} from '../src/services/companion/repository';
import { patchCompanionSettings } from '../src/services/companion/settings';
import {
  forgetCompanionContext,
  recentConversationExcerpt,
  setCompanionTurnContextDeps,
  withCompanionContext,
} from '../src/services/companion/turnContext';
import type { ItemDraft } from '../src/services/companion/types';

const T0 = new Date(2026, 10, 5, 9, 12, 0, 0).getTime();
const HOUR = 60 * 60_000;
const RULES_HEADER = '[YOUR RULES — written by the user; they outrank everything below]';
const GOALS_HEADER = '[YOUR GOALS — the user\'s; goal ids for companion_edit_goal and companion_goal_progress]';
const OFF_HEADER = '[SOURCES OFF IN SETTINGS]';
const NOTES_HEADER = /\[YOUR NOTES[^\n]*\] revision \d+/;

let companion: { workspaceId: string; nodeId: string };
let nextSeq = 1;

/** A live runtime session as the route holds it: only its identity matters here. */
const newSession = () => ({}) as AgentSession;

function draft(itemKey: string, overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    source: 'cr',
    subtype: 'cr_needs_attention',
    itemKey,
    version: 'v1',
    bucket: 'needs_you',
    severity: 'now',
    title: 'CR-1 needs attention',
    summary: null,
    target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' },
    facts: {},
    observedAt: T0,
    ...overrides,
  };
}

function message(id: string, role: 'user' | 'assistant' | 'system', content: string | null, metadata: Record<string, unknown> | null = null, at = T0): void {
  getDb().prepare('INSERT INTO messages (id, node_id, role, content, metadata, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, companion.nodeId, role, content, metadata ? JSON.stringify(metadata) : null, nextSeq++, at);
}

const context = (session: AgentSession | null = null, now = T0) => withCompanionContext('What is next?', { nodeId: companion.nodeId, session, now });

/** The [COMPANION CONTEXT] part of what the runtime receives. */
function prefixOf(text: string): string {
  const end = text.indexOf('[END OF COMPANION CONTEXT]');
  assert.ok(text.startsWith('[COMPANION CONTEXT') && end > 0, text);
  return text.slice(0, end);
}

const hasStanding = (text: string) => text.includes(RULES_HEADER);

/** chatHub as turnContext.ts uses it: each turn settles as the test says, and replays what the test sends. */
function fakeHub() {
  const settled = new Map<string, (status: SettledTurnStatus | null) => void>();
  const subscribers = new Map<string, HubSubscriber>();
  const hub = {
    whenTurnSettled: (turnId: string) => new Promise<SettledTurnStatus | null>((resolve) => { settled.set(turnId, resolve); }),
    subscribeTurn: (_chatId: string, turnId: string, subscriber: HubSubscriber) => {
      subscribers.set(turnId, subscriber);
      return () => { subscribers.delete(turnId); };
    },
  };
  setCompanionTurnContextDeps({ hub: hub as never });
  return {
    async settle(turnId: string, status: SettledTurnStatus | null): Promise<void> {
      for (let attempt = 0; attempt < 20 && !settled.has(turnId); attempt += 1) await new Promise((resolve) => setImmediate(resolve));
      const resolve = settled.get(turnId);
      assert.ok(resolve, `${turnId} is being watched`);
      resolve(status);
    },
    event(turnId: string, event: string): void {
      const subscriber = subscribers.get(turnId);
      assert.ok(subscriber, `${turnId} is subscribed`);
      subscriber.send({ event, data: { turnId } } as unknown as ChatStreamEvent);
    },
    watching: () => subscribers.size,
  };
}

describe('[COMPANION CONTEXT] ahead of the user\'s own message (§3.5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-turn-context-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    companion = ensureAssistant();
    nextSeq = 1;
    setCompanionCardDeps({});
    setCompanionTurnContextDeps({});
  });

  afterEach(() => {
    setCompanionTurnContextDeps({});
    setCompanionCardDeps({});
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('only the user\'s words and Michi\'s facts (§2.8 T1)', () => {
    test('nothing a check-in wrote reaches the prefix; the user\'s rules, goals and notes do', () => {
      const S = 'CHECKIN-WROTE';
      // The user's own words.
      setCompanionRules('Never ping me before 10:00');
      const userGoal = addGoal('Ship the auth migration', T0);
      // What check-ins wrote.
      const checkinGoal = editGoal({ action: 'add', text: `${S} goal: close the launch review`, origin: 'checkin' }, T0);
      recordGoalProgress(userGoal.id, `${S} reading: two of five merged`, T0);
      setNotesByCompanion(`${S} notes: watch CR-1`, 0, 'checkin');
      insertBrief({ date: localDateKey(T0), headline: `${S} headline`, cards: [{ title: `${S} card title`, body: `${S} card body`, itemIds: [], action: null }],
        closing: `${S} closing`, origin: 'llm', now: T0 - HOUR });
      const waiting = proposeCompanionCard({ kind: 'rules.update', payload: { rules: `${S} rule` }, reason: `${S} card reason` }, T0 - HOUR);
      const decided = proposeCompanionCard({ kind: 'goal.add', payload: { text: `${S} proposed goal` }, reason: `${S} decided reason` }, T0 - 2 * HOUR);
      decideCard(decided.id, 'applied', T0 - 30 * 60_000);
      const run = startRun({ kind: 'heartbeat', trigger: 'test', startedAt: T0 - 2 * HOUR });
      message(companionPostId(run.id), 'assistant', `${S} post body`, { companionPost: { runId: run.id, kind: 'heartbeat', changes: [] } }, T0 - HOUR);
      recordRunPost(run.id, { messageId: companionPostId(run.id), at: T0 - HOUR, changes: [
        { kind: 'item', id: 'cmi-1', applied: 1, proposed: 0, action: 'snooze', reason: `${S} item reason` },
        { kind: 'goal', id: checkinGoal.id, applied: 1, proposed: 0, action: 'add', reason: `${S} goal reason` },
        { kind: 'page', id: 'pg-1', title: 'Tasks', applied: 2, proposed: 1 },
      ] });
      // What the sources brought in.
      upsertItem(draft('cr:CR-1', { title: 'SOURCE-WROTE title', summary: 'SOURCE-WROTE summary' }), T0);

      const built = context(newSession());
      const prefix = prefixOf(built.text);
      assert.ok(built.text.endsWith('\n\nWhat is next?'), 'the user\'s message follows as they wrote it');
      assert.doesNotMatch(prefix, new RegExp(`${S}|SOURCE-WROTE`), prefix);

      // Michi's facts and the user's own words are there.
      assert.match(prefix, /Your name is Michi\./);
      assert.match(prefix, /\[CURRENT RUN TIME\][^\n]*2026-11-05T09:12[+-]\d\d:\d\d/);
      assert.match(prefix, /Michi's feed: 1 item waiting on the user, 1 new since they last looked; 1 card of yours waiting for their answer; today's brief: published at 08:12 \(read it with companion_read\)\./);
      assert.match(prefix, new RegExp(`\\[CARD RESULTS[^\\n]*\\]\\n- goal\\.add card ${decided.id}: applied by the user`));
      assert.match(prefix, new RegExp(`\\[YOUR CARDS STILL WAITING FOR THE USER[^\\n]*\\]\\n- ${waiting.id}: rules\\.update, proposed `));
      assert.match(prefix, new RegExp(`\\[CHECK-INS SINCE THE USER'S LAST MESSAGE[^\\n]*\\]\\n- 08:12 heartbeat: snoozed item cmi-1; added goal ${checkinGoal.id}; changed page pg-1 "Tasks" \\(2 applied, 1 proposed\\)`));
      assert.match(prefix, /\[YOUR RULES — written by the user; they outrank everything below\]\nNever ping me before 10:00\n\[END OF YOUR RULES\]/);
      assert.match(prefix, new RegExp(`- ${userGoal.id}: Ship the auth migration; progress recorded 09:12 \\(read it with companion_read\\)`));
      assert.match(prefix, new RegExp(`- ${checkinGoal.id}: worded by a check-in \\(read it with companion_read\\)`));
      assert.match(prefix, /\[YOUR NOTES\] revision 1: a check-in wrote them last; read them with companion_read before you rely on them\./);

      // The user's own notes are quoted.
      setNotesByUser('My own note: the offsite is Thursday');
      assert.match(prefixOf(context().text), /\[YOUR NOTES — your own scratch, may be stale\] revision 2\nMy own note: the offsite is Thursday\n\[END OF YOUR NOTES\]/);
    });

    test('the sources off in settings are named as off (conv-3)', () => {
      assert.doesNotMatch(context().text, /SOURCES OFF/);
      patchCompanionSettings({ sources: { email: { enabled: false }, calendar: { enabled: false } } });
      assert.match(prefixOf(context().text), /\[SOURCES OFF IN SETTINGS\] email, calendar: Michi does not watch them/);
      patchCompanionSettings({ sources: { email: { enabled: true }, calendar: { enabled: true } }, enabled: false });
      assert.match(prefixOf(context().text), /\[SOURCES OFF IN SETTINGS\] Michi conversations, CRs, pipelines, email, calendar:/);
    });
  });

  describe('the standing blocks once per live session (§3.5)', () => {
    test('a session\'s first turn carries them; its next turns carry only the facts until something in them changes', async () => {
      setCompanionRules('Never ping me before 10:00');
      const session = newSession();
      const first = context(session);
      assert.ok(hasStanding(first.text));
      assert.ok(!first.text.includes(GOALS_HEADER), 'no goals yet: no goals block');
      assert.match(first.text, NOTES_HEADER);
      await first.delivered();

      const second = context(session);
      assert.ok(!hasStanding(second.text), second.text);
      assert.doesNotMatch(second.text, NOTES_HEADER);
      assert.match(second.text, /Your name is Michi\.[\s\S]*Michi's feed:/, 'the facts go every turn');
      await second.delivered();
      assert.ok(!hasStanding(context(session).text));

      // Each standing block's change sends them all again, once.
      const changes: Array<[string, () => void]> = [
        ['rules', () => setCompanionRules('Never ping me before 11:00')],
        ['a goal', () => { addGoal('Ship the auth migration', T0); }],
        ['the notes', () => { setNotesByUser('Offsite on Thursday'); }],
        ['a check-in\'s notes', () => { setNotesByCompanion('Watch CR-1', 1, 'checkin'); }],
        ['a source', () => { patchCompanionSettings({ sources: { email: { enabled: false } } }); }],
      ];
      for (const [what, change] of changes) {
        change();
        const changed = context(session);
        assert.ok(hasStanding(changed.text), `${what} changed: the standing blocks go again`);
        await changed.delivered();
        assert.ok(!hasStanding(context(session).text), `${what}: once`);
      }
      const held = context(session);
      assert.ok(!held.text.includes(OFF_HEADER), 'held, so not repeated');
      // Michi's facts change every turn without resending them.
      upsertItem(draft('cr:CR-1'), T0);
      const facts = context(session);
      assert.ok(!hasStanding(facts.text));
      assert.match(facts.text, /Michi's feed: 1 item waiting on the user/);
    });

    test('without a live session, and for a new one, they go every time', async () => {
      setCompanionRules('Never ping me before 10:00');
      const once = context(null);
      await once.delivered();
      assert.ok(hasStanding(context(null).text), 'no session: every turn');
      const session = newSession();
      await context(session).delivered();
      assert.ok(!hasStanding(context(session).text));
      assert.ok(hasStanding(context(newSession()).text), 'a rebuilt or resumed session is a new object');
    });

    test('they count as held only when the turn that carried them settles completed', async () => {
      setCompanionRules('Never ping me before 10:00');
      const hub = fakeHub();
      const session = newSession();
      for (const status of ['cancelled', 'error', null] as const) {
        const turn = context(session);
        assert.ok(hasStanding(turn.text), `after ${String(status)}`);
        const delivering = turn.delivered(`turn-${String(status)}`);
        await hub.settle(`turn-${String(status)}`, status);
        await delivering;
        assert.equal(hub.watching(), 0, 'the replay subscription ends with the turn');
      }
      const completed = context(session);
      assert.ok(hasStanding(completed.text), 'no turn completed yet');
      const delivering = completed.delivered('turn-ok');
      // A turn begun while the earlier one runs carries them too: nothing is held yet.
      assert.ok(hasStanding(context(session).text));
      await hub.settle('turn-ok', 'completed');
      await delivering;
      assert.ok(!hasStanding(context(session).text));
      // A turn's facts alone (nothing standing in it) leave what is held as it is.
      const factsOnly = context(session);
      const settling = factsOnly.delivered('turn-facts');
      await hub.settle('turn-facts', 'completed');
      await settling;
      assert.ok(!hasStanding(context(session).text));
    });

    test('a compaction in the turn, or forgetCompanionContext, makes the next turn send them again', async () => {
      setCompanionRules('Never ping me before 10:00');
      const hub = fakeHub();
      const session = newSession();
      const first = context(session);
      const delivering = first.delivered('turn-1');
      await hub.settle('turn-1', 'completed');
      await delivering;
      assert.ok(!hasStanding(context(session).text));

      for (const event of [CHAT_STREAM_EVENTS.compactionStart, CHAT_STREAM_EVENTS.compactionEnd]) {
        const turn = context(session);
        assert.ok(!hasStanding(turn.text), `held before the ${event}`);
        const watching = turn.delivered(`turn-${event}`);
        await new Promise((resolve) => setImmediate(resolve));
        hub.event(`turn-${event}`, 'text_delta');
        hub.event(`turn-${event}`, event);
        await hub.settle(`turn-${event}`, 'completed');
        await watching;
        const next = context(session);
        assert.ok(hasStanding(next.text), `after a ${event} the session may no longer hold them`);
        const again = next.delivered(`turn-after-${event}`);
        await hub.settle(`turn-after-${event}`, 'completed');
        await again;
      }

      assert.ok(!hasStanding(context(session).text));
      forgetCompanionContext(session);
      assert.ok(hasStanding(context(session).text), 'a compaction or /clear outside a turn');

      // A turn begun before the session forgot them delivers nothing when it completes.
      const before = context(session);
      const pending = before.delivered('turn-before');
      await new Promise((resolve) => setImmediate(resolve));
      forgetCompanionContext(session);
      await hub.settle('turn-before', 'completed');
      await pending;
      assert.ok(hasStanding(context(session).text));
    });

    test('a failing hub is logged, never thrown: the blocks simply go again', async () => {
      setCompanionRules('Never ping me before 10:00');
      setCompanionTurnContextDeps({ hub: {
        whenTurnSettled: async () => { throw new Error('hub gone'); },
        subscribeTurn: () => null,
      } as never });
      const session = newSession();
      await context(session).delivered('turn-1');
      assert.ok(hasStanding(context(session).text));
    });
  });

  describe('rules Michi cannot read (§1.3)', () => {
    test('the message goes as it is, with no [COMPANION CONTEXT], and says so', async () => {
      getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('companion:rules', 'x'.repeat(2001));
      const proposed = proposeCompanionCard({ kind: 'goal.add', payload: { text: 'x' } }, T0 - HOUR);
      decideCard(proposed.id, 'dismissed', T0 - 60_000);
      const session = newSession();
      const built = withCompanionContext('What is next?', { nodeId: companion.nodeId, session, now: T0 });
      assert.deepEqual([built.text, built.rulesUnavailable], ['What is next?', true]);
      built.reportCards();
      built.markPostsTold();
      await built.delivered();
      assert.equal(listUnreportedCards().length, 1, 'nothing was told');

      getDb().prepare('DELETE FROM meta WHERE key = ?').run('companion:rules');
      const readable = context(session);
      assert.equal(readable.rulesUnavailable, false);
      assert.match(readable.text, /\[YOUR NOTES\] revision 0: you have no notes yet\./, 'the standing blocks go: nothing was held');
    });
  });

  describe('told once the turn began', () => {
    test('card results and posts go until the turn that carried them began', () => {
      const proposed = proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Ship it' } }, T0 - HOUR);
      decideCard(proposed.id, 'applied', T0 - 60_000);
      const runs = [0, 1, 2, 3, 4, 5].map((index) => {
        const run = startRun({ kind: 'heartbeat', trigger: 'test', startedAt: T0 - 3 * HOUR });
        recordRunPost(run.id, { messageId: companionPostId(run.id), at: T0 - (6 - index) * 10 * 60_000, changes: [] });
        return run.id;
      });
      const first = context();
      assert.match(first.text, /\[CARD RESULTS/);
      const posts = prefixOf(first.text).match(/^- \d\d:\d\d heartbeat: posted a message, changed nothing$/gm) ?? [];
      assert.equal(posts.length, 5, 'at most COMPANION_LIMITS.maxUntoldPosts');
      // Built but not begun: still untold.
      assert.match(context().text, /\[CARD RESULTS/);
      first.reportCards();
      first.markPostsTold();
      first.markPostsTold();
      const next = context();
      assert.doesNotMatch(next.text, /\[CARD RESULTS/);
      assert.deepEqual(listUntoldPosts().map((post) => post.runId), [runs[0]], 'the oldest, not listed, is still untold');
      assert.match(next.text, /\[CHECK-INS SINCE THE USER'S LAST MESSAGE[^\n]*\]\n- 08:12 heartbeat: posted a message, changed nothing\n\n/);
    });
  });
});

describe('a check-in\'s view of the conversation: recentConversationExcerpt (§3.6)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-recent-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    companion = ensureAssistant();
    nextSeq = 1;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the latest messages\' own text, oldest first, the posted ones marked; never metadata, tool output or empty messages', () => {
    message('u-1', 'user', 'Oldest question', null, T0 - 60 * 60_000);
    message('u-2', 'user', 'What changed on CR-1?', { quote: { text: 'QUOTED-TEXT' }, attachments: [{ name: 'ATTACHED.png' }] }, T0 - 50 * 60_000);
    getDb().prepare('INSERT INTO messages (id, node_id, role, content, metadata, blocks, tool_calls, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('a-1', companion.nodeId, 'assistant', '  It got a comment.  ', null, JSON.stringify([{ type: 'tool', output: 'TOOL-OUTPUT' }]),
        JSON.stringify([{ name: 'companion_item', output: 'TOOL-OUTPUT' }]), nextSeq++, T0 - 49 * 60_000);
    message('a-empty', 'assistant', '   ', null, T0 - 48 * 60_000);
    message('sys-1', 'system', 'SYSTEM-TEXT', null, T0 - 47 * 60_000);
    message(companionPostId('run-1'), 'assistant', 'I snoozed CR-2 until tomorrow.', { companionPost: { runId: 'run-1', kind: 'heartbeat', changes: [] } }, T0 - 40 * 60_000);
    message('mna-1', 'assistant', 'Your Spaces page is ready.', null, T0 - 30 * 60_000);
    message('a-narrated', 'assistant', 'Narrated by Michi.', { metaAgentNarration: { kind: 'first_run' } }, T0 - 25 * 60_000);
    message('u-3', 'user', 'Thanks', null, T0 - 20 * 60_000);
    message('a-2', 'assistant', 'Any time.', null, T0 - 19 * 60_000);
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-other', ?, 'chat', 'idle', ?)`).run(companion.workspaceId, T0);
    getDb().prepare('INSERT INTO messages (id, node_id, role, content, metadata, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('other-1', 'n-other', 'user', 'ANOTHER-CONVERSATION', null, nextSeq++, T0);

    const lines = recentConversationExcerpt(companion.nodeId);
    assert.deepEqual(lines, [
      { role: 'assistant', at: T0 - 49 * 60_000, text: 'It got a comment.' },
      { role: 'assistant', at: T0 - 40 * 60_000, text: 'I snoozed CR-2 until tomorrow.', posted: true },
      { role: 'assistant', at: T0 - 30 * 60_000, text: 'Your Spaces page is ready.', posted: true },
      { role: 'assistant', at: T0 - 25 * 60_000, text: 'Narrated by Michi.', posted: true },
      { role: 'user', at: T0 - 20 * 60_000, text: 'Thanks' },
      { role: 'assistant', at: T0 - 19 * 60_000, text: 'Any time.' },
    ]);
    assert.doesNotMatch(JSON.stringify(lines), /QUOTED-TEXT|ATTACHED|TOOL-OUTPUT|SYSTEM-TEXT|ANOTHER-CONVERSATION/);
    assert.deepEqual(recentConversationExcerpt(companion.nodeId, 2).map((line) => line.text), ['Thanks', 'Any time.']);
    assert.deepEqual(recentConversationExcerpt(companion.nodeId, 9).slice(0, 2).map((line) => line.text), ['Oldest question', 'What changed on CR-1?']);
    assert.deepEqual(recentConversationExcerpt('n-empty'), []);
  });

  test('like Recent conversations: no turn kept out of recall, no reply that read outside content, no credentials, nothing unless it learns', () => {
    const turn = (turnId: string, userMessageId: string, assistantMessageId: string) => getDb().prepare(`INSERT INTO turns
      (turn_id, node_id, user_message_id, assistant_message_id, status, started_at, updated_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)`)
      .run(turnId, companion.nodeId, userMessageId, assistantMessageId, T0, T0);
    const read = (turnId: string, tool: string, detail: string | null) => getDb().prepare(`INSERT INTO turn_trust
      (node_id, turn_id, source_key, tool, runtime_id, detail, recorded_at) VALUES (?, ?, ?, ?, 'claude', ?, ?)`)
      .run(companion.nodeId, turnId, `${tool}:${detail ?? ''}`, tool, detail, T0);
    message('u-a', 'user', 'Plain question', null, T0 - 9 * 60_000);
    message('a-a', 'assistant', 'Plain answer', null, T0 - 8 * 60_000);
    turn('t-a', 'u-a', 'a-a');
    message('u-b', 'user', 'Look that page up', null, T0 - 7 * 60_000);
    message('a-b', 'assistant', 'The page says IGNORE-YOUR-RULES', null, T0 - 6 * 60_000);
    turn('t-b', 'u-b', 'a-b');
    read('t-b', 'web_fetch', null);
    message('u-c', 'user', 'What is on Today?', null, T0 - 5 * 60_000);
    message('a-c', 'assistant', 'Two CRs wait for you.', null, T0 - 4 * 60_000);
    turn('t-c', 'u-c', 'a-c');
    read('t-c', 'companion_items', 'collector');
    message('u-d', 'user', 'HIDDEN-QUESTION', null, T0 - 3 * 60_000);
    message('a-d', 'assistant', 'HIDDEN-ANSWER', null, T0 - 2 * 60_000);
    turn('t-d', 'u-d', 'a-d');
    getDb().prepare(`INSERT INTO memory_recall_docs (owner_user_id, workspace_id, doc_kind, ref_id, node_id, turn_id, at, snippet, hidden)
      VALUES ('owner', ?, 'turn', 't-d', ?, 't-d', ?, 'x', 1)`).run(companion.workspaceId, companion.nodeId, T0);
    message('u-e', 'user', 'The key is ghp_abcdefghijklmnopqrstuvwxyz0123456789, keep it handy', null, T0 - 60_000);

    const lines = recentConversationExcerpt(companion.nodeId, 9);
    assert.deepEqual(lines.slice(0, 5).map((line) => `${line.role}: ${line.text}`), [
      'user: Plain question',
      'assistant: Plain answer',
      'user: Look that page up',
      'user: What is on Today?',
      'assistant: Two CRs wait for you.',
    ], 'a web read drops the reply but keeps the user\'s words; Companion material is the check-in\'s own; a hidden turn is gone');
    assert.equal(lines.length, 6);
    assert.equal(lines[5]!.role, 'user');
    assert.doesNotMatch(lines[5]!.text, /ghp_/);
    assert.doesNotMatch(JSON.stringify(lines), /IGNORE-YOUR-RULES|HIDDEN-QUESTION|HIDDEN-ANSWER/);

    getDb().prepare(`UPDATE nodes SET memory_mode = 'use_only' WHERE id = ?`).run(companion.nodeId);
    assert.deepEqual(recentConversationExcerpt(companion.nodeId), [], 'Use only: nothing from the conversation reaches a check-in');
    getDb().prepare(`UPDATE nodes SET memory_mode = 'off' WHERE id = ?`).run(companion.nodeId);
    assert.deepEqual(recentConversationExcerpt(companion.nodeId), [], 'Off: nothing either');
  });
});
