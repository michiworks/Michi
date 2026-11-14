import './isolatedConfigDir';
import { enableSyntheticCompanionSources } from './helpers/companionSources';
/**
 * The agent's check-ins (DESIGN-v2 §3.1, §3.3, §3.4): createCompanionTurnRunner
 * on a fake chatHub and chatManager over a real temp database. Each check-in
 * runs in its own throwaway node S = `n-cmph-<runId>` (in the assistant's
 * workspace, recorded on its run) on a fresh ephemeral session, as a
 * private requested self-turn `cmp-<runId>` whose memory context is the
 * resident Michi Memory pack it starts with, its note composed with the
 * user's rules read fresh. What reaches the conversation V is one post
 * `cmp-post-<runId>`: its reply when it spoke (with its chips), else
 * Michi's receipt when it changed something, nothing when it was quiet and
 * changed nothing; when the user wrote in V after it began, its reply is not
 * posted (superseded: Activity keeps the length only); when what its memory
 * pack showed changed while it ran, nothing is posted and its changes are
 * undone (withdrawn, D5), and the next check-in reads memory again. Then S's session
 * and native record are discarded (deferred/unsupported: never recorded as
 * gone) and S is purged. Outcomes: spoke, quiet, superseded, skipped,
 * preempted, error. companionCheckinRun.test.ts runs it on the real chatHub.
 * Temp MICHI_DATA_DIR per test; no runtime runs.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkinNodeId, companionCheckinTurnId, companionPostId, type CompanionPostChange } from 'michi-shared';
import type { PostSelfMessageArgs, PostSelfMessageResult, SettledTurnStatus, StartRequestedSelfTurnArgs, StartedRequestedSelfTurn } from '../src/agents/chatHub';
import { MetaAgentGuardError } from '../src/agents/metaAgentGuard';
import type { AgentSession } from '../src/agents/types';
import { assistantPurposeKey } from '../src/assistant/identity';
import { ensureAssistant } from '../src/assistant/store';
import type { AssistantToolContext } from '../src/assistant/tools';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import type { EphemeralDiscardResult, EphemeralSessionRecord } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveMessage, saveWorkspace } from '../src/services/dbRepository';
import { getTurnTrust } from '../src/services/turnTrust';
import { proposeCompanionCard } from '../src/services/companion/cards';
import {
  COMPANION_NATIVE_KEPT_NOTE,
  COMPANION_WITHDRAWN_NOTE,
  companionTurnId,
  createCompanionTurnRunner,
  type CompanionTurnChatHub,
  type CompanionTurnChatManager,
  type CompanionTurnRunnerDeps,
} from '../src/services/companion/conversation';
import { localDateKey } from '../src/services/companion/clock';
import { checkinMemoryHolds } from '../src/services/companion/checkinNode';
import { CHECKIN_TOOL_NAMES } from '../src/assistant/policy';
import { MEMORY_TOOL_NAMES } from '../src/agents/memoryToolNames';
import { createMemory, deleteMemory, setMemorySettings, updateMemory, type CreateMemoryInput } from '../src/services/memory/memoryService';
import { companionPostReceipt } from '../src/services/companion/prompts';
import {
  applyItemAction,
  briefForDate,
  cardDto,
  companionHeadline,
  currentRevision,
  decideCard,
  finishRun,
  getItem,
  getRun,
  insertBrief,
  listCheckinRunsToClean,
  listUnreportedCards,
  recordRunChange,
  setBriefCardFeedback,
  setCompanionRules,
  startRun,
  upsertItem,
} from '../src/services/companion/repository';
import { getCompanionSettings } from '../src/services/companion/settings';
import { COMPANION_OWN_TOOLS, setCompanionToolDeps } from '../src/services/companion/tools';
import type {
  CompanionMaterial,
  CompanionMessageNotifier,
  CompanionTurnKind,
  CompanionTurnRequest,
  ItemDraft,
} from '../src/services/companion/types';

const T0 = new Date(2026, 10, 5, 9, 12, 0, 0).getTime();
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

type Status = 'active' | 'completed' | 'cancelled' | 'error';
type Attribution = { turnId: string; assistantId: string };

function turnRow(nodeId: string, turnId: string, assistantId: string): void {
  getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, started_at, updated_at)
    VALUES (?, ?, NULL, ?, 'active', ?, ?)`).run(turnId, nodeId, assistantId, T0, T0);
}

/** A promise and the function that resolves it. */
function signal<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The slice of ChatHub the runner uses, as a script: each started turn does what `respond` says; posts land in V's messages. */
class FakeChatHub implements CompanionTurnChatHub {
  readonly starts: StartRequestedSelfTurnArgs[] = [];
  readonly cancels: Array<[string, string | undefined]> = [];
  readonly posts: PostSelfMessageArgs[] = [];
  /** Posts shouldPost withdrew when their turn came. */
  readonly withdrawn: PostSelfMessageArgs[] = [];
  readonly settleWaits: string[] = [];
  readonly statuses = new Map<string, Status>();
  readonly active = new Set<string>();
  readonly ownerTurns = new Set<string>();
  readonly pending = new Set<string>();
  /** Nodes whose running turn ignores a cancel. */
  readonly stubborn = new Set<string>();
  postError: Error | null = null;
  respond: (args: StartRequestedSelfTurnArgs) => Promise<StartedRequestedSelfTurn> = (args) => this.answer(args, 'Hello.');

  startRequestedSelfTurn(args: StartRequestedSelfTurnArgs): Promise<StartedRequestedSelfTurn> {
    this.starts.push(args);
    return this.respond(args);
  }

  requestedTurnStatus(turnId: string): Status | null {
    return this.statuses.get(turnId) ?? null;
  }

  cancel(chatId: string, turnId?: string): boolean {
    this.cancels.push([chatId, turnId]);
    if (!this.stubborn.has(chatId)) this.active.delete(chatId);
    return true;
  }

  isActive(chatId: string): boolean { return this.active.has(chatId); }
  isOwnerTurnActive(chatId: string): boolean { return this.ownerTurns.has(chatId); }
  hasPendingSelfTurn(chatId: string): boolean { return this.pending.has(chatId); }

  async postSelfMessage(args: PostSelfMessageArgs): Promise<PostSelfMessageResult> {
    if (this.postError) throw this.postError;
    const id = args.messageId ?? args.turnId;
    const existing = !!getDb().prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
    // As chatHub: when the post's turn comes, shouldPost may still withdraw it, before anything is written.
    if (!existing && args.shouldPost && !args.shouldPost()) {
      this.withdrawn.push(args);
      return 'withdrawn';
    }
    this.posts.push(args);
    if (existing) return 'existing';
    saveMessage({ id, node_id: args.nodeId, role: 'assistant', content: args.text, seq: 100 + this.posts.length, created_at: T0,
      metadata: JSON.stringify(args.metadata ?? {}) } as Parameters<typeof saveMessage>[0]);
    return 'posted';
  }

  async whenTurnSettled(turnId: string): Promise<SettledTurnStatus | null> {
    this.settleWaits.push(turnId);
    return new Promise<SettledTurnStatus | null>(() => {});
  }

  /**
   * A turn that runs to its end as chatHub records one: its durable row, what
   * the model does meanwhile (`during`, e.g. a tool call), then the assistant
   * message it leaves and its final status.
   */
  async answer(args: StartRequestedSelfTurnArgs, content: string, options: { status?: Status | null; error?: string; during?: (turn: Attribution) => Promise<void> | void } = {}): Promise<StartedRequestedSelfTurn> {
    const assistantId = `self-${args.nodeId}-${args.turnId}`;
    turnRow(args.nodeId, args.turnId, assistantId);
    const done = (async () => {
      await options.during?.({ turnId: args.turnId, assistantId });
      saveMessage({ id: assistantId, node_id: args.nodeId, role: 'assistant', content, seq: 1, created_at: T0 });
      const status = options.status === undefined ? 'completed' : options.status;
      getDb().prepare('UPDATE turns SET status = ?, error = ? WHERE turn_id = ?').run(status ?? 'active', options.error ?? null, args.turnId);
      if (status) this.statuses.set(args.turnId, status);
    })();
    return { turnId: args.turnId, assistantId, done, existing: false };
  }

  /** A turn that keeps running; `began` runs once it started. */
  hanging(began?: (args: StartRequestedSelfTurnArgs) => void) {
    return async (args: StartRequestedSelfTurnArgs): Promise<StartedRequestedSelfTurn> => {
      const assistantId = `self-${args.nodeId}-${args.turnId}`;
      turnRow(args.nodeId, args.turnId, assistantId);
      this.active.add(args.chatId);
      began?.(args);
      return { turnId: args.turnId, assistantId, done: new Promise<void>(() => {}), existing: false };
    };
  }
}

class FakeChatManager implements CompanionTurnChatManager {
  readonly opened: Array<{ ownerUserId: string; workspaceId: string; nodeId: string }> = [];
  readonly discards: Array<{ ownerUserId: string; nodeId: string; recorded?: EphemeralSessionRecord }> = [];
  open: (input: { nodeId: string }) => Promise<AgentSession> = async (input) =>
    ({ id: input.nodeId, runtimeId: 'claude', nativeSessionId: 'native-1' } as unknown as AgentSession);
  discard: EphemeralDiscardResult = 'discarded';

  openEphemeralSession(input: { ownerUserId: string; workspaceId: string; nodeId: string }): Promise<AgentSession> {
    this.opened.push(input);
    return this.open(input);
  }

  async discardEphemeralSession(input: { ownerUserId: string; nodeId: string; recorded?: EphemeralSessionRecord }): Promise<EphemeralDiscardResult> {
    this.discards.push(input);
    return this.discard;
  }
}

function draft(itemKey: string, overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    source: 'cr', subtype: 'cr_needs_attention', itemKey, version: 'v1', bucket: 'needs_you', severity: 'now',
    title: 'CR-1 needs attention', summary: null, target: { kind: 'url', url: 'https://reviews.example.com/reviews/CR-1' },
    facts: {}, observedAt: T0, ...overrides,
  };
}

function material(overrides: Partial<CompanionMaterial> = {}): CompanionMaterial {
  return {
    now: T0, lastLookAt: T0 - HOUR, changes: [], open: [], goals: [], notes: '', notesRevision: 0, rules: '', reminders: [],
    displayName: 'Michi', focus: [], cardResults: [], reports: [], catchUp: null, briefCurate: null, ...overrides,
  };
}

/** A check-in's request for a run that is in companion_runs, as the coordinator starts one. */
function request(kind: CompanionTurnKind = 'wake', overrides: Partial<CompanionMaterial> = {}): CompanionTurnRequest {
  const run = startRun({ kind, trigger: 'schedule', startedAt: T0 });
  return { kind, trigger: 'schedule', runId: run.id, material: material(overrides) };
}

const nothingToDo = COMPANION_OWN_TOOLS.find((tool) => tool.name === 'nothing_to_do')!;
const headlineTool = COMPANION_OWN_TOOLS.find((tool) => tool.name === 'companion_headline')!;

function toolContext(nodeId: string, workspaceId: string, turn: Attribution): AssistantToolContext {
  return {
    ownerUserId: null, workspaceId, nodeId,
    approveThreadMessage: async () => ({ approved: false, reason: 'unavailable' }),
    getActivePageTurnAttribution: () => turn,
  } as AssistantToolContext;
}

function nodeRow(nodeId: string): { workspace_id: string; tree_id: string } | undefined {
  const row = getDb().prepare('SELECT workspace_id, tree_id FROM nodes WHERE id = ?').get(nodeId) as { workspace_id: string; tree_id: string } | undefined;
  return row ? { ...row } : undefined;
}
const SESSION_RECORD = { runtimeId: 'claude', nativeSessionId: 'native-1', cwd: '/tmp/michi-checkin', profileHash: null };

describe('the agent\'s check-ins', () => {
  // The runner's timeout and settle waits unref their timers, so nothing else
  // would keep the event loop alive and node:test would cancel the file.
  let keepAlive: ReturnType<typeof setInterval>;
  before(() => { keepAlive = setInterval(() => {}, 2 ** 30); });
  after(() => clearInterval(keepAlive));

  let tmpDir: string;
  let hub: FakeChatHub;
  let manager: FakeChatManager;
  let spoke: Array<Parameters<CompanionMessageNotifier['companionSpoke']>[0]>;
  let events: string[];

  const runner = (deps: Partial<CompanionTurnRunnerDeps> = {}) => createCompanionTurnRunner({
    chatHub: hub,
    chatManager: manager,
    notifier: { companionSpoke: (input) => { spoke.push(input); } },
    events: { emitChanged: (...kinds: string[]) => { events.push(...kinds); } } as CompanionTurnRunnerDeps['events'],
    clock: { now: () => T0 },
    sessionRecord: () => SESSION_RECORD,
    settleWaitMs: 20,
    ...deps,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-conversation-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb(); enableSyntheticCompanionSources();
    setCompanionToolDeps({ clock: { now: () => T0 } });
    hub = new FakeChatHub();
    manager = new FakeChatManager();
    spoke = [];
    events = [];
  });

  afterEach(() => {
    setCompanionToolDeps({});
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('it runs in its own node S on a fresh ephemeral session, private, with the memory pack it starts with; it spoke: its reply and chips are posted into V, then S goes', async () => {
    const changed = upsertItem(draft('cr:CR-1'), T0);
    const baseline = upsertItem(draft('cr:CR-2', { title: 'CR-2 was already there' }), T0, { baseline: true });
    // The material is a few seconds old; the user's rules are read when the check-in starts.
    setCompanionRules('No pings before 10:00');
    const req = request('wake', { changes: [changed.event!, baseline.event!], open: [changed.item, baseline.item] });
    const S = checkinNodeId(req.runId);
    const turnId = companionCheckinTurnId(req.runId);
    const postId = companionPostId(req.runId);
    const v = ensureAssistant();
    let during: unknown[] = [];
    hub.respond = (args) => hub.answer(args, 'CR-1 needs your review.\n[FOLLOW-UPS: Open CR-1 | Later]', {
      during: () => {
        during = [nodeRow(S), { ...(getDb().prepare('SELECT value FROM meta WHERE key = ?').get(assistantPurposeKey(S)) as object) }, getRun(req.runId)?.checkinNodeId];
      },
    });
    const turns = runner();
    assert.equal(turns.isIdle(), true);
    const outcome = await turns.run(req);

    assert.equal(companionTurnId(req.runId), `cmp-${req.runId}`);
    assert.deepEqual(outcome, { outcome: 'spoke', messageText: 'CR-1 needs your review.', turnId, postedMessageId: postId });
    assert.deepEqual(during, [{ workspace_id: v.workspaceId, tree_id: `t-cmph-${req.runId}` }, { value: 'companion' }, S],
      'while it runs, S is a node of its own tree in the assistant workspace, closed, and named on its run');
    assert.deepEqual(manager.opened, [{ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: v.workspaceId, nodeId: S }]);
    assert.equal(hub.starts.length, 1);
    const started = hub.starts[0];
    assert.deepEqual([started.chatId, started.nodeId, started.ownerUserId, started.turnId, started.private, started.memoryContext], [S, S, null, turnId, true, null],
      'nobody saved anything yet: no memory block');
    assert.equal('displayText' in started, false, 'no user bubble');
    assert.equal((started.session as { id: string }).id, S);
    assert.match(started.text, /^\[Wake\]/);
    assert.match(started.text, /\[YOUR RULES[^\n]*\]\nNo pings before 10:00\n/);
    assert.ok(started.text.indexOf('No pings before 10:00') < started.text.indexOf('<<<collector data'), 'the rules come before the data');
    assert.match(started.text, /CR-1 needs attention/);

    assert.equal(hub.posts.length, 1);
    const post = hub.posts[0];
    assert.deepEqual([post.chatId, post.nodeId, post.turnId, post.messageId, post.text, post.followUps, post.ownerUserId],
      [v.nodeId, v.nodeId, postId, postId, 'CR-1 needs your review.', ['Open CR-1', 'Later'], null], 'into V, under the run\'s post id, its sentinels as chips');
    assert.deepEqual(post.metadata, { companionPost: { runId: req.runId, kind: 'wake', changes: [] } });
    assert.deepEqual(post.untrusted, { tool: 'companion_post', detail: 'checkin' });
    assert.deepEqual(spoke, [{ runId: req.runId, runKind: 'wake', itemIds: [changed.item.id] }]);
    assert.ok(events.includes('conversation'), 'the snapshot hears of the post (unread count)');

    const run = getRun(req.runId)!;
    assert.deepEqual([run.postedMessageId, run.postedAt, run.session, run.discardedAt],
      [postId, T0, SESSION_RECORD, T0], 'the post, the session it ran on, and that its native record is gone');
    assert.deepEqual(manager.discards, [{ ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: S }]);
    assert.equal(nodeRow(S), undefined, 'S is purged');
    assert.equal(getDb().prepare('SELECT 1 FROM meta WHERE key = ?').get(assistantPurposeKey(S)), undefined);
    assert.equal(getDb().prepare('SELECT 1 FROM messages WHERE node_id = ?').get(S), undefined);
    assert.equal(turns.isIdle(), true);
  });

  test('S\'s turn reads collector material: it is marked untrusted', async () => {
    manager.discard = 'busy';
    const req = request();
    await runner().run(req);
    assert.deepEqual(getTurnTrust({ nodeId: checkinNodeId(req.runId), turnId: companionCheckinTurnId(req.runId) }).sources.map((source) => source.tool), ['companion_note']);
  });

  test('messageText is the reply\'s first 200 characters; the post carries all of it', async () => {
    const reply = `${'🙂'.repeat(250)} ${'x'.repeat(3000)}`;
    hub.respond = (args) => hub.answer(args, reply);
    const outcome = await runner().run(request());
    assert.equal(outcome.outcome, 'spoke');
    assert.equal(outcome.messageText, '🙂'.repeat(200));
    assert.equal(hub.posts[0].text, reply);
  });

  test('quiet and nothing changed: nothing reaches V', async () => {
    const v = ensureAssistant();
    const req = request();
    hub.respond = (args) => hub.answer(args, '', {
      during: async (turn) => {
        const result = await nothingToDo.execute(toolContext(args.nodeId, v.workspaceId, turn), { note: 'Nothing changed since 08:00' });
        assert.equal(result.isError, undefined, JSON.stringify(result));
      },
    });
    assert.deepEqual(await runner().run(req), { outcome: 'quiet', detail: 'Quiet: Nothing changed since 08:00', turnId: companionCheckinTurnId(req.runId) });
    // Sentinels alone are not words, and stray text around nothing_to_do is not a message.
    hub.respond = (args) => hub.answer(args, '[FOLLOW-UPS: Yes | No]');
    assert.equal((await runner().run(request())).outcome, 'quiet');
    hub.respond = (args) => hub.answer(args, 'Let me check CR-123 first.', {
      during: async (turn) => { await nothingToDo.execute(toolContext(args.nodeId, v.workspaceId, turn), {}); },
    });
    const stray = await runner().run(request('wake'));
    assert.deepEqual([stray.outcome, stray.detail], ['quiet', 'Nothing worth a message · it also wrote: "Let me check CR-123 first."']);
    assert.deepEqual([hub.posts, spoke], [[], []]);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM nodes WHERE id LIKE 'n-cmph-%'").get()!.n, 0, 'each S is purged');
  });

  test('Michi\'s line for Home (Q45): a check-in that ran keeps the line it wrote; one that wrote none or failed leaves the last', async () => {
    const v = ensureAssistant();
    const line = (text: string, then?: (turn: Attribution, nodeId: string) => Promise<unknown>) => (args: StartRequestedSelfTurnArgs) => hub.answer(args, then ? '' : 'CR-1 needs your review.', {
      during: async (turn) => {
        await headlineTool.execute(toolContext(args.nodeId, v.workspaceId, turn), { text });
        await then?.(turn, args.nodeId);
      },
    });
    const revision = currentRevision();
    hub.respond = line('Watching the release pipeline', (turn, nodeId) => nothingToDo.execute(toolContext(nodeId, v.workspaceId, turn), {}));
    const quietRun = await runner().run(request('heartbeat'));
    assert.equal(quietRun.outcome, 'quiet', JSON.stringify(quietRun));
    assert.deepEqual(companionHeadline(), { text: 'Watching the release pipeline', at: T0, kind: 'heartbeat' }, 'a quiet check-in keeps it');
    assert.ok(currentRevision() > revision, 'the snapshot moves on');

    hub.respond = (args) => hub.answer(args, '');
    await runner().run(request('wake'));
    assert.equal(companionHeadline()?.text, 'Watching the release pipeline', 'one that wrote none leaves the last');

    hub.respond = line('CR-1 is ready for your review');
    assert.equal((await runner().run(request('wake'))).outcome, 'spoke');
    assert.deepEqual([companionHeadline()?.text, companionHeadline()?.kind], ['CR-1 is ready for your review', 'wake']);

    hub.respond = (args) => hub.answer(args, '', { status: 'error', error: 'boom', during: async (turn) => {
      await headlineTool.execute(toolContext(args.nodeId, v.workspaceId, turn), { text: 'Should not stay' });
    } });
    assert.equal((await runner().run(request('wake'))).outcome, 'error');
    assert.equal(companionHeadline()?.text, 'CR-1 is ready for your review', 'a failed one leaves the last');
  });

  test('a check-in that changed something must post: quiet, its receipt is posted with the changes and Undo all', async () => {
    const item = upsertItem(draft('cr:CR-1'), T0).item;
    const req = request();
    hub.respond = (args) => hub.answer(args, '', {
      during: () => {
        recordRunChange({ runId: req.runId, targetKind: 'item', targetId: item.id, action: 'snooze',
          before: { status: 'new', snoozedUntil: null }, after: { status: 'snoozed', snoozedUntil: T0 + HOUR }, reason: 'Waits on its author', now: T0 });
      },
    });
    const outcome = await runner().run(req);
    const changes: CompanionPostChange[] = [{ kind: 'item', id: item.id, applied: 1, proposed: 0, action: 'snooze', reason: 'Waits on its author' }];
    assert.deepEqual(outcome, { outcome: 'quiet', detail: 'Nothing worth a message', turnId: companionCheckinTurnId(req.runId), postedMessageId: companionPostId(req.runId) });
    assert.equal(hub.posts.length, 1);
    assert.equal(hub.posts[0].text, companionPostReceipt(getCompanionSettings().displayName, changes, { stopped: false }));
    assert.equal('followUps' in hub.posts[0], false, 'a receipt has no chips');
    assert.deepEqual(hub.posts[0].metadata, { companionPost: { runId: req.runId, kind: 'wake', changes } });
    assert.deepEqual(getRun(req.runId)?.changes, changes);
    assert.equal(spoke.length, 1, 'the notification gate judges the receipt too');
  });

  test('superseded: the user wrote in V after it began, so its reply is not posted and only its length is kept; its changes still get a receipt', async () => {
    const v = ensureAssistant();
    const userSays = (id: string, at: number) =>
      saveMessage({ id, node_id: v.nodeId, role: 'user', content: 'What about CR-2?', seq: 50, created_at: at } as Parameters<typeof saveMessage>[0]);
    userSays('m-before', T0 - 1);
    hub.respond = (args) => hub.answer(args, 'Here is what I found.');
    assert.equal((await runner().run(request())).outcome, 'spoke', 'what the user wrote before it began does not count');

    const item = upsertItem(draft('cr:CR-1'), T0).item;
    const first = request();
    hub.respond = (args) => hub.answer(args, 'Here is what I found.', { during: () => userSays('m-after', T0) });
    const outcome = await runner().run(first);
    assert.deepEqual(outcome, { outcome: 'superseded', detail: 'Your message came first, so its reply (21 characters) was not posted', turnId: companionCheckinTurnId(first.runId) });
    assert.equal(getRun(first.runId)?.replyChars, 21);
    assert.equal(hub.posts.length, 1, 'nothing more was posted');

    const second = request();
    hub.respond = (args) => hub.answer(args, 'I snoozed CR-1.', {
      during: () => {
        recordRunChange({ runId: second.runId, targetKind: 'item', targetId: item.id, action: 'dismiss',
          before: { status: 'new', snoozedUntil: null }, after: { status: 'dismissed', snoozedUntil: null }, reason: 'Merged', now: T0 });
      },
    });
    const withChanges = await runner().run(second);
    assert.equal(withChanges.outcome, 'superseded');
    assert.equal(withChanges.postedMessageId, companionPostId(second.runId));
    assert.notEqual(hub.posts[1].text, 'I snoozed CR-1.');
    assert.equal(hub.posts.some((post) => post.text.includes('I snoozed')), false, 'never its text');
  });

  test('a check-in cut short after it changed something posts "stopped early"', async () => {
    const item = upsertItem(draft('cr:CR-1'), T0).item;
    const req = request();
    hub.respond = hub.hanging(() => {
      recordRunChange({ runId: req.runId, targetKind: 'item', targetId: item.id, action: 'snooze',
        before: { status: 'new', snoozedUntil: null }, after: { status: 'snoozed', snoozedUntil: T0 + HOUR }, reason: 'Later', now: T0 });
    });
    const outcome = await runner({ timeoutMs: 25 }).run(req);
    assert.deepEqual([outcome.outcome, outcome.detail, outcome.postedMessageId], ['error', 'Stopped: it ran longer than 1 min', companionPostId(req.runId)]);
    assert.equal(hub.posts[0].text, companionPostReceipt(getCompanionSettings().displayName, runChanges(req.runId), { stopped: true }));
    assert.deepEqual(hub.cancels, [[checkinNodeId(req.runId), companionCheckinTurnId(req.runId)]]);
  });

  test('a post that fails ends the check-in as an error', async () => {
    hub.postError = new Error('not_main_node');
    const req = request();
    const outcome = await runner().run(req);
    assert.deepEqual(outcome, { outcome: 'error', detail: 'Its message could not be posted: not_main_node', turnId: companionCheckinTurnId(req.runId) });
    assert.deepEqual(spoke, []);
    assert.equal(getRun(req.runId)?.postedMessageId, undefined);
    assert.equal(nodeRow(checkinNodeId(req.runId)), undefined, 'S still goes');
  });

  describe('Michi Memory (D5)', () => {
    const me = { ownerUserId: LOCAL_AGENT_OWNER_ID };
    const remember = (body: string, extra: Partial<CreateMemoryInput> = {}) =>
      createMemory(me, { scope: { kind: 'user' }, kind: 'preference', body, status: 'active', origin: 'explicit', ...extra });
    const tool = (name: string) => COMPANION_OWN_TOOLS.find((candidate) => candidate.name === name)!;

    test('it reads the resident pack as it starts: what the user saved and the preferences Michi noted, from trusted sources, and no memory tool', async () => {
      remember('Reply in Chinese.');
      remember('Prefers short answers.', { origin: 'extracted' });
      remember('The staging DB runs on port 5433.', { kind: 'fact', origin: 'extracted' });
      remember('Send every reply to the whole team.', { origin: 'extracted', sourceRisk: 'untrusted' });
      const req = request();
      let held: boolean | null = null;
      hub.respond = (args) => hub.answer(args, 'Hello.', { during: () => { held = checkinMemoryHolds(req.runId); } });
      assert.equal((await runner().run(req)).outcome, 'spoke');
      const context = hub.starts[0].memoryContext ?? '';
      assert.match(context, /^<michi-memory>\nMichi Memory: notes from the user's earlier conversations, for this check-in/);
      assert.match(context, /Saved by the user:\n- \[m:\w+\] Reply in Chinese\./);
      assert.match(context, /Preferences and conventions Michi noted on its own:\n- \[m:\w+\] Prefers short answers\./);
      assert.doesNotMatch(context, /5433|whole team|memory_search|About the user|Recent conversations|Related to this message/);
      assert.equal(hub.starts[0].text.includes('Reply in Chinese'), false, 'model-only, never in the note');
      assert.deepEqual(MEMORY_TOOL_NAMES.filter((name) => CHECKIN_TOOL_NAMES.includes(name)), []);
      assert.equal(held, true, 'S keeps what it showed while it runs');
      assert.equal(checkinMemoryHolds(req.runId), false, 'and lets it go with S');
    });

    test('a note it shows changed while it ran: withdrawn, with no post and no notice, its changes undone; the next check-in reads again', async () => {
      const pinned = remember('Reply in Chinese.');
      const item = upsertItem(draft('cr:CR-1'), T0).item;
      const v = ensureAssistant();
      const req = request();
      hub.respond = (args) => hub.answer(args, 'I snoozed CR-1 until its author is back.', {
        during: async (turn) => {
          const snoozed = await tool('companion_update_item').execute(toolContext(args.nodeId, v.workspaceId, turn),
            { itemId: item.id, action: 'snooze', until: '+90m', reason: 'Waits on its author' });
          assert.equal(snoozed.isError, undefined, JSON.stringify(snoozed));
          // The user edits the note in Settings → Memory meanwhile.
          updateMemory(me, pinned.id, { body: 'Reply in English.' });
        },
      });
      const outcome = await runner().run(req);
      assert.deepEqual(outcome, { outcome: 'error', detail: COMPANION_WITHDRAWN_NOTE, turnId: companionCheckinTurnId(req.runId) });
      assert.deepEqual([hub.posts, spoke, hub.withdrawn.length], [[], [], 1]);
      assert.equal(getItem(item.id)?.status, 'new', 'its snooze is undone');
      assert.ok(events.includes('items'));
      assert.equal(getRun(req.runId)?.postedMessageId, undefined);
      assert.equal(nodeRow(checkinNodeId(req.runId)), undefined, 'S still goes');

      hub.respond = (args) => hub.answer(args, 'Hello.');
      assert.equal((await runner().run(request())).outcome, 'spoke');
      assert.match(hub.starts[1].memoryContext ?? '', /Reply in English\./);
    });

    test('a quiet one is withdrawn too when a note it shows changed: its silence was the result, so its material waits for the next check-in', async () => {
      const pinned = remember('Reply in Chinese.');
      const v = ensureAssistant();
      const req = request();
      hub.respond = (args) => hub.answer(args, '', {
        during: async (turn) => {
          updateMemory(me, pinned.id, { body: 'Reply in English.' });
          await nothingToDo.execute(toolContext(args.nodeId, v.workspaceId, turn), { note: 'Nothing new' });
        },
      });
      assert.deepEqual(await runner().run(req), { outcome: 'error', detail: COMPANION_WITHDRAWN_NOTE, turnId: companionCheckinTurnId(req.runId) });
      assert.deepEqual([hub.posts, hub.withdrawn, spoke], [[], [], []]);
    });

    test('memory turned on or off while it ran counts as a change; one it does not show (a fact) does not, nor does memory off throughout', async () => {
      remember('Reply in Chinese.');
      hub.respond = (args) => hub.answer(args, 'Hello.', { during: () => { remember('The staging DB runs on port 5433.', { kind: 'fact', origin: 'extracted' }); } });
      assert.equal((await runner().run(request())).outcome, 'spoke');
      hub.respond = (args) => hub.answer(args, 'Hello.', { during: () => setMemorySettings(LOCAL_AGENT_OWNER_ID, { mode: 'off' }) });
      assert.equal((await runner().run(request())).detail, COMPANION_WITHDRAWN_NOTE);
      hub.respond = (args) => hub.answer(args, 'Hello.');
      assert.equal((await runner().run(request())).outcome, 'spoke');
      assert.equal(hub.starts[2].memoryContext, null, 'memory off: nothing read');
      hub.respond = (args) => hub.answer(args, 'Hello.', { during: () => setMemorySettings(LOCAL_AGENT_OWNER_ID, { mode: 'auto' }) });
      assert.equal((await runner().run(request())).detail, COMPANION_WITHDRAWN_NOTE);
      assert.equal(hub.posts.length, 2);
    });

    test('once withdrawn it stays so: a brief refused mid-turn is never published, even when the note changes back before its reply', async () => {
      const v = ensureAssistant();
      const req = request('brief');
      let refused = '';
      hub.respond = (args) => hub.answer(args, 'Your brief is up.', {
        during: async (turn) => {
          const note = remember('No briefs on Fridays.');
          const result = await tool('companion_publish_brief').execute(toolContext(args.nodeId, v.workspaceId, turn), { headline: 'Today', cards: [], closing: 'Done.' });
          refused = result.content.map((part) => part.text).join('');
          deleteMemory(me, note.id);
        },
      });
      const outcome = await runner().run(req);
      assert.match(refused, /^WITHDRAWN: /);
      assert.equal(briefForDate(localDateKey(T0)), null, 'no brief of its own');
      assert.deepEqual([outcome.outcome, outcome.detail, hub.posts.length], ['error', COMPANION_WITHDRAWN_NOTE, 0]);
    });
  });

  describe('S\'s native record and S itself (step 9)', () => {
    test('absent: nothing to discard, so it is gone; S is purged', async () => {
      manager.discard = 'absent';
      const req = request();
      await runner().run(req);
      assert.equal(getRun(req.runId)?.discardedAt, T0);
      assert.equal(nodeRow(checkinNodeId(req.runId)), undefined);
      assert.deepEqual(listCheckinRunsToClean().map((run) => run.id), [req.runId], 'until the coordinator records how it ended');
      finishRun(req.runId, { outcome: 'spoke', finishedAt: T0 + 1 });
      assert.deepEqual(listCheckinRunsToClean().map((run) => run.id), [], 'nothing left for boot cleanup');
    });

    test('deferred: S is purged but the run stays pending, for the next start to retry from what it recorded', async () => {
      manager.discard = 'deferred';
      const req = request();
      const outcome = await runner().run(req);
      assert.equal(outcome.outcome, 'spoke');
      assert.equal(outcome.detail, undefined);
      assert.equal(nodeRow(checkinNodeId(req.runId)), undefined);
      assert.equal(getRun(req.runId)?.discardedAt, null, 'never recorded as gone');
      assert.deepEqual(listCheckinRunsToClean().map((run) => [run.id, run.session]), [[req.runId, SESSION_RECORD]]);
    });

    test('unsupported (Kiro keeps it): S is purged, the run records that its runtime keeps the transcript, final (D11), and its outcome says so', async () => {
      manager.discard = 'unsupported';
      const v = ensureAssistant();
      hub.respond = (args) => hub.answer(args, '', {
        during: async (turn) => { await nothingToDo.execute(toolContext(args.nodeId, v.workspaceId, turn), { note: 'All calm' }); },
      });
      const req = request();
      const outcome = await runner().run(req);
      assert.deepEqual([outcome.outcome, outcome.detail], ['quiet', `Quiet: All calm · ${COMPANION_NATIVE_KEPT_NOTE}`], 'in the outcome, which the coordinator writes to Activity');
      assert.equal(getRun(req.runId)?.discardedAt, null, 'not gone');
      assert.ok(getRun(req.runId)?.nativeKeptAt, 'kept: a final state');
      finishRun(req.runId, { outcome: 'quiet', finishedAt: T0, detail: outcome.detail });
      assert.deepEqual(listCheckinRunsToClean().map((run) => run.id), [], 'once its run ends, boot cleanup never asks about it again');
      assert.equal(nodeRow(checkinNodeId(req.runId)), undefined);
      hub.respond = (args) => hub.answer(args, 'Hi.');
      assert.equal((await runner().run(request())).detail, COMPANION_NATIVE_KEPT_NOTE, 'a run without a detail gets just the note');
    });

    test('a turn still running after a stop gets a moment to settle; if it holds on (busy), S stays for boot cleanup', async () => {
      manager.discard = 'busy';
      const req = request();
      const S = checkinNodeId(req.runId);
      hub.stubborn.add(S);
      hub.respond = hub.hanging();
      const outcome = await runner({ timeoutMs: 25 }).run(req);
      assert.equal(outcome.outcome, 'error');
      assert.deepEqual(hub.settleWaits, [companionCheckinTurnId(req.runId)], 'it waited for the turn to settle first');
      assert.ok(nodeRow(S), 'S is left as it is');
      assert.equal(getRun(req.runId)?.discardedAt, null);
      assert.deepEqual(listCheckinRunsToClean().map((run) => run.id), [req.runId]);
    });
  });

  test('the morning brief\'s note carries the last brief with the user\'s thumbs, and the kinds they rated useful (conv-1)', async () => {
    const draftCr = upsertItem(draft('cr:CR-1:mine', { subtype: 'cr_unpublished', bucket: 'stalled', severity: 'digest', title: 'CR-1: draft not published' }), T0 - 3 * DAY).item;
    const review = upsertItem(draft('cr:CR-2:review', { subtype: 'cr_review_requested', severity: 'digest', title: 'Review requested: CR-2' }), T0 - 3 * DAY).item;
    const moved = upsertItem(draft('pipeline:P', { source: 'pipeline', subtype: 'pipeline_blocked', bucket: 'needs_you', title: 'P is blocked' }), T0 - 3 * DAY).item;
    applyItemAction(draftCr.id, { action: 'feedback', feedback: 'down', reason: 'too_noisy' }, T0 - 2 * DAY);
    applyItemAction(review.id, { action: 'feedback', feedback: 'up' }, T0 - 2 * DAY);
    applyItemAction(review.id, { action: 'dismiss' }, T0 - 2 * DAY);
    applyItemAction(moved.id, { action: 'feedback', feedback: 'up' }, T0 - 2 * DAY);
    upsertItem(draft('pipeline:P', { source: 'pipeline', subtype: 'pipeline_blocked', bucket: 'needs_you', title: 'P is blocked', version: 'v2' }), T0 - DAY);
    const yesterday = insertBrief({
      date: localDateKey(T0 - DAY), headline: 'A draft and a review', origin: 'llm', now: T0 - DAY, closing: 'That is all.',
      cards: [
        { title: 'Drafts not published', body: 'One draft.', itemIds: [draftCr.id], action: null },
        { title: 'A review waits', body: 'CR-2.', itemIds: [review.id], action: null },
      ],
    })!;
    setBriefCardFeedback(yesterday.id, 0, 'down');

    await runner().run(request('brief', { open: [draftCr] }));
    const text = hub.starts[0].text;
    assert.match(text, /\[YOUR LAST BRIEF — 2026-11-04; the thumbs on its cards are the user's\]\n- headline: "A draft and a review"/);
    assert.ok(text.includes('- rated down · "Drafts not published" · items'), text);
    assert.match(text, /\n- cr_review_requested items: 1 rated useful\n/, 'thumbs on items no longer open count too');
    assert.doesNotMatch(text, /pipeline_blocked items/, 'a thumb on an older version is not this version\'s (conv-1)');
    assert.doesNotMatch(text, /cr_unpublished items/, 'thumbs down are about one item, never a kind');
    assert.ok(text.indexOf('[YOUR LAST BRIEF') < text.indexOf('>>>end of collector data'), 'inside the collector data');

    await runner().run(request('wake', { open: [draftCr] }));
    assert.doesNotMatch(hub.starts[1].text, /\[YOUR LAST BRIEF|rated useful/, 'only the brief reads its past');
  });

  test('every note lists the agent\'s cards still waiting for the user', async () => {
    proposeCompanionCard({ kind: 'goal.add', payload: { text: 'Ship the auth fix' } }, T0 - 10 * 60_000);
    await runner().run(request());
    assert.match(hub.starts[0].text, /\[YOUR CARDS STILL WAITING FOR THE USER[^\n]*\]\n- Add a goal: "Ship the auth fix" \(goal\.add, proposed 10 min ago/);
  });

  test('a conversation a stopped Michi left starting is failed before the note is written, so the check-in hears it', async () => {
    saveWorkspace({ id: 'ws-1', name: 'My Project', created_at: T0, updated_at: T0, settings: null } as Parameters<typeof saveWorkspace>[0]);
    const card = proposeCompanionCard({ kind: 'conversation.start', payload: { workspaceId: 'ws-1', title: 'Fix the pipeline', text: 'It is blocked.' } }, T0 - HOUR);
    decideCard(card.id, 'applied', T0 - HOUR);
    getDb().prepare('UPDATE companion_cards SET reported_at = -1 WHERE id = ?').run(card.id);
    assert.deepEqual(listUnreportedCards(), []);
    await runner().run(request());
    assert.match(hub.starts[0].text, /\[CARD RESULTS[^\n]*\]\n- Failed: Start a conversation in "My Project": "Fix the pipeline" [^\n]* — Michi stopped before this conversation finished starting, so it may not have started/);
    assert.deepEqual(listUnreportedCards(), [], 'told once');
  });

  test('the card results it was not told go into the note, and count as told once the turn started', async () => {
    const card = proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'No pings before 10:00' } }, T0);
    decideCard(card.id, 'dismissed', T0 + 1);
    await runner().run(request());
    assert.match(hub.starts[0].text, /\[CARD RESULTS[^\n]*\]\n[^\n]*Dismissed by the user/);
    assert.deepEqual(listUnreportedCards(), []);

    // The coordinator's own list wins, and is marked the same way.
    const other = proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'Never email' } }, T0);
    const decided = decideCard(other.id, 'applied', T0 + 2)!;
    await runner().run(request('wake', { cardResults: [cardDto(decided)] }));
    assert.match(hub.starts[1].text, /Applied by the user/);
    assert.deepEqual(listUnreportedCards(), []);
  });

  test('existing: true is a turn already handled: skipped, nothing posted, its card results stay untold, and S still goes', async () => {
    const card = proposeCompanionCard({ kind: 'rules.update', payload: { rules: 'No pings' } }, T0);
    decideCard(card.id, 'dismissed', T0 + 1);
    hub.respond = async (args) => ({ turnId: args.turnId, assistantId: `self-${args.nodeId}-${args.turnId}`, done: Promise.resolve(), existing: true });
    const req = request();
    assert.deepEqual(await runner().run(req), { outcome: 'skipped', detail: 'Already handled', turnId: companionCheckinTurnId(req.runId) });
    assert.deepEqual([hub.posts, spoke], [[], []]);
    assert.equal(listUnreportedCards().length, 1);
    assert.equal(nodeRow(checkinNodeId(req.runId)), undefined);
  });

  test('a turn still running after the timeout is cancelled and ends as an error; nothing changed, nothing posted', async () => {
    hub.respond = hub.hanging();
    const turns = runner({ timeoutMs: 25 });
    const req = request();
    const outcome = await turns.run(req);
    assert.deepEqual(outcome, { outcome: 'error', detail: 'Stopped: it ran longer than 1 min', turnId: companionCheckinTurnId(req.runId) });
    assert.deepEqual(hub.cancels, [[checkinNodeId(req.runId), companionCheckinTurnId(req.runId)]]);
    assert.deepEqual([hub.posts, spoke, hub.settleWaits], [[], [], []], 'its turn let go at once, so nothing waited for it');
    assert.equal(turns.isIdle(), true);
  });

  test('preempt() stops a running check-in at once', async () => {
    const began = signal();
    hub.respond = hub.hanging(() => began.resolve());
    const turns = runner();
    const req = request();
    const running = turns.run(req);
    await began.promise;
    assert.equal(turns.isIdle(), false);
    assert.deepEqual(await turns.run(request()), { outcome: 'skipped', detail: 'Another check-in is running' });
    await turns.preempt();
    const outcome = await running;
    assert.deepEqual(outcome, { outcome: 'preempted', detail: 'The user started typing; this waits for the next check-in', turnId: companionCheckinTurnId(req.runId) });
    assert.deepEqual(hub.cancels, [[checkinNodeId(req.runId), companionCheckinTurnId(req.runId)]]);
    assert.equal(hub.starts.length, 1);
    assert.equal(turns.isIdle(), true);
    await turns.preempt();
  });

  test('preempt() while the session opens: nothing starts and nothing needs cancelling; S still goes', async () => {
    const opening = signal();
    manager.open = () => { opening.resolve(); return new Promise<AgentSession>(() => {}); };
    const turns = runner();
    const req = request();
    const running = turns.run(req);
    await opening.promise;
    await turns.preempt();
    assert.deepEqual(await running, { outcome: 'preempted', detail: 'The user started typing; this waits for the next check-in' });
    assert.deepEqual([hub.starts, hub.cancels], [[], []]);
    assert.equal(manager.discards.length, 1);
    assert.equal(nodeRow(checkinNodeId(req.runId)), undefined);
  });

  test('only while V is idle; a catch-up runs no model turn', async () => {
    const turns = runner();
    const v = ensureAssistant();
    for (const busy of [hub.active, hub.ownerTurns, hub.pending]) {
      busy.add(v.nodeId);
      assert.equal(turns.isIdle(), false);
      const req = request();
      assert.deepEqual(await turns.run(req), { outcome: 'skipped', detail: 'The conversation is busy' });
      assert.equal(getRun(req.runId)?.checkinNodeId, null, 'no S was made');
      busy.delete(v.nodeId);
    }
    assert.deepEqual([manager.opened, hub.starts], [[], []]);
    const catchUp = await turns.run(request('catch_up'));
    assert.equal(catchUp.outcome, 'skipped');
    assert.match(catchUp.detail ?? '', /deterministic/);
    assert.deepEqual([manager.opened, hub.starts], [[], []]);
  });

  test('no check-in runs without the user\'s rules', async () => {
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('companion:rules', 'x'.repeat(5000));
    const req = request();
    assert.deepEqual(await runner().run(req), { outcome: 'error', detail: 'The user\'s rules could not be read, so the check-in did not run' });
    assert.deepEqual([manager.opened, hub.starts], [[], []]);
    assert.equal(getRun(req.runId)?.checkinNodeId, null);
  });

  test('no session: the launch check failing closed, or a session that cannot open; S still goes', async () => {
    manager.open = async () => { throw new MetaAgentGuardError({ runtimeId: 'codex', toolset: 'chat', unexpectedTools: ['shell'] }); };
    const guardedReq = request();
    const guarded = await runner().run(guardedReq);
    assert.equal(guarded.outcome, 'error');
    assert.match(guarded.detail ?? '', /^The check-in did not run: its session offered tools outside its allow-list \(.*shell/);
    manager.open = async () => { throw new Error('Kiro is not signed in'); };
    assert.deepEqual(await runner().run(request()), { outcome: 'error', detail: 'The check-in\'s session could not open: Kiro is not signed in' });
    assert.deepEqual(hub.starts, []);
    assert.equal(manager.discards.length, 2);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM nodes WHERE id LIKE 'n-cmph-%'").get()!.n, 0);
    assert.equal(getRun(guardedReq.runId)?.session, null, 'no session was recorded');
  });

  test('a turn that could not start, failed, was stopped elsewhere or ended without a result', async () => {
    hub.respond = async () => { throw new Error('queue closed'); };
    const a = request();
    assert.deepEqual(await runner().run(a), { outcome: 'error', detail: 'The turn could not start: queue closed', turnId: companionCheckinTurnId(a.runId) });
    hub.respond = (args) => hub.answer(args, 'partial', { status: 'error', error: 'The model is overloaded' });
    const b = request();
    assert.deepEqual(await runner().run(b), { outcome: 'error', detail: 'The model is overloaded', turnId: companionCheckinTurnId(b.runId) });
    hub.respond = (args) => hub.answer(args, 'partial', { status: 'cancelled' });
    const c = request();
    assert.deepEqual(await runner().run(c), { outcome: 'preempted', detail: 'Stopped before it finished', turnId: companionCheckinTurnId(c.runId) });
    hub.respond = (args) => hub.answer(args, 'partial', { status: null });
    const d = request();
    assert.deepEqual(await runner().run(d), { outcome: 'error', detail: 'The turn ended without a result', turnId: companionCheckinTurnId(d.runId) });
    assert.deepEqual([hub.posts, spoke], [[], []], 'a partial reply is never posted');
  });

  test('a worker report names the delegated conversation and its workspace', async () => {
    saveWorkspace({ id: 'ws-1', name: 'My Project', created_at: T0, updated_at: T0, settings: null } as Parameters<typeof saveWorkspace>[0]);
    const delegation = { id: 'cmd-1', workspaceId: 'ws-1', nodeId: 'n-worker', title: 'Fix the pipeline', createdAt: T0,
      lastReportedMessageId: null, lastReportedAt: null, closedAt: null };
    await runner().run(request('worker_report', { reports: [{ delegation, messageId: 'm-1', status: 'completed', excerpt: 'The pipeline is green again.' }] }));
    assert.match(hub.starts[0].text, /^\[Worker report\]/);
    assert.match(hub.starts[0].text, /The conversation "Fix the pipeline" you started in "My Project" \(michi:\/\/node\/n-worker\) just ended a turn: completed\./);
    assert.match(hub.starts[0].text, /<<<worker reply[^\n]*\nThe pipeline is green again\.\n>>>end of worker reply/);
  });
});

/** What run `runId` recorded it changed in Today and goals, as its receipt lists it. */
function runChanges(runId: string): CompanionPostChange[] {
  return (getDb().prepare('SELECT target_kind, target_id, action, reason FROM companion_run_changes WHERE run_id = ? ORDER BY created_at, rowid').all(runId) as Array<{ target_kind: string; target_id: string; action: string; reason: string | null }>)
    .map((row) => ({ kind: row.target_kind as 'item', id: row.target_id, applied: 1, proposed: 0, action: row.action as 'snooze', ...(row.reason ? { reason: row.reason } : {}) }));
}
