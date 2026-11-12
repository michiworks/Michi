/**
 * DESIGN-v2 §3.3: chatHub.postSelfMessage posts a message into the
 * assistant's conversation V as a complete turn of its own, on a real
 * database:
 * - queued behind a turn running in V, so it lands after that reply;
 * - written as begin + finalize in ONE transaction, with no user message,
 *   through the normal finalize projection (chips, watermark, node status);
 *   a failure inside that transaction leaves no row and no active V;
 * - broadcast only after the commit (turn_start{selfInitiated,
 *   assistantMetadata} → chunk → done), and replayable to a window;
 * - idempotent per turn id (`existing`), and marked untrusted;
 * - refused for a check-in node, a node outside the assistant workspace and
 *   the ids of other Companion turns; first-run narration (`mna-*`, its own
 *   metadata) posts too.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTurnMetadata, type ChatStreamEvent, type CompanionPostMetadata } from 'michi-shared';
import { ChatHub, TurnGuardError, type BackgroundSubscriber, type TurnPersistence } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { assistantPurposeKey } from '../src/assistant/identity';
import { ensureAssistant } from '../src/assistant/store';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, recoverInterruptedTurns, saveMessage } from '../src/services/dbRepository';
import { coreBeginAndFinalizeTurn, type DbPrimitives } from '../src/services/turnPersistence.core';
import { mainThreadDb } from '../src/services/turnPersistence.mainAdapter';
import { TURN_SQL } from '../src/services/turnPersistence.recipes';
import { getTurnTrust } from '../src/services/turnTrust';
import { chatOwner } from './helpers/owners';

const POST: CompanionPostMetadata = {
  runId: 'run1',
  kind: 'heartbeat',
  changes: [{ kind: 'page', id: 'pg-tasks', title: 'Tasks', applied: 3, proposed: 0 }],
};

function hub(persistence?: TurnPersistence): ChatHub {
  return new ChatHub({
    retentionMs: 5_000,
    memoryInjector: null,
    titleGenerator: null,
    pageManifestBuilder: (() => '') as never,
    ...(persistence ? { persistence } : {}),
  });
}

function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function userSession(id: string, wait: Promise<void>): AgentSession {
  return {
    id, runtimeId: 'kiro', owner: chatOwner(id), getHistory: () => [], getPendingAssistant: () => undefined,
    async *send(): AsyncIterableIterator<NormalizedEvent> {
      yield { kind: 'chunk', text: 'the reply' };
      await wait;
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    },
    cancel: () => {},
  } as unknown as AgentSession;
}

const rows = (nodeId: string) => getDb().prepare('SELECT id, role, content, metadata, seq FROM messages WHERE node_id = ? ORDER BY seq')
  .all(nodeId) as Array<{ id: string; role: string; content: string; metadata: string | null; seq: number }>;
const turn = (turnId: string) => getDb().prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId) as Record<string, unknown> | undefined;
const turnCount = () => (getDb().prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n;

function feed(includeForeground = false) {
  const events: Array<{ chatId: string; ev: ChatStreamEvent; selfInitiated?: boolean }> = [];
  const sub: BackgroundSubscriber = { includeForeground, send: (chatId, ev, selfInitiated) => events.push({ chatId, ev, selfInitiated }), close() {} };
  return { events, sub };
}

describe('ChatHub.postSelfMessage', () => {
  let tmpDir: string;
  let V: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-post-self-message-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    V = ensureAssistant().nodeId;
    getDb().prepare("INSERT INTO workspaces (id,name,owner_user_id,cwd,created_at,updated_at) VALUES ('ws-work','Work',NULL,?,1,1)").run(tmpDir);
    getDb().prepare(`INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at)
      VALUES ('n-worker','ws-work','chat','idle',0,0,1)`).run();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes one complete turn with no user message, then broadcasts it to windows', async () => {
    const chatHub = hub();
    const window = feed();
    chatHub.subscribeBackground(window.sub);
    const result = await chatHub.postSelfMessage({
      chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: 'Tidied Tasks for you.\n[FOLLOW-UPS: Show me | Undo it]',
      metadata: { companionPost: POST },
    });
    assert.equal(result, 'posted');

    const stored = rows(V);
    assert.equal(stored.length, 1, 'one assistant row, no user row');
    assert.equal(stored[0].id, 'cmp-post-run1');
    assert.equal(stored[0].role, 'assistant');
    assert.equal(stored[0].content, 'Tidied Tasks for you.');
    assert.deepEqual(JSON.parse(stored[0].metadata!).companionPost, POST);
    const receipt = turn('cmp-post-run1')!;
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.user_message_id, null);
    assert.equal(receipt.assistant_message_id, 'cmp-post-run1');
    const node = getNode(V)!;
    assert.equal(node.status, 'idle');
    assert.equal(node.last_applied_turn_id, 'cmp-post-run1');
    assert.equal(node.last_applied_seq, 3);
    assert.deepEqual(JSON.parse(node.follow_ups!), ['Show me', 'Undo it'], 'chips come from the normal finalize projection');
    assert.equal(node.follow_ups_source_message_id, 'cmp-post-run1');
    assert.deepEqual(getTurnTrust({ nodeId: V, turnId: 'cmp-post-run1' }).sources.map((source) => [source.tool, source.detail]),
      [['companion_post', 'checkin']], 'the post is untrusted for memory extraction');

    assert.deepEqual(window.events.map(({ ev }) => ev.event), ['turn_start', 'chunk', 'follow_ups', 'done']);
    assert.ok(window.events.every(({ chatId, ev, selfInitiated }) => chatId === V && selfInitiated === true
      && ev.data.turnId === 'cmp-post-run1' && ev.data.assistantId === 'cmp-post-run1'));
    assert.deepEqual(window.events.map(({ ev }) => ev.data.seq), [0, 1, 2, 3]);
    const start = window.events[0].ev as Extract<ChatStreamEvent, { event: 'turn_start' }>;
    assert.equal(start.data.selfInitiated, true);
    assert.equal(start.data.userText, '');
    assert.deepEqual(start.data.assistantMetadata, { companionPost: POST });
    assert.equal((window.events[1].ev as Extract<ChatStreamEvent, { event: 'chunk' }>).data.text, 'Tidied Tasks for you.',
      'windows stream the text the message stores');
    assert.deepEqual((window.events[2].ev as Extract<ChatStreamEvent, { event: 'follow_ups' }>).data.followUps, ['Show me', 'Undo it'],
      'the text\'s chips travel as a frame');
    assert.equal((window.events[3].ev as Extract<ChatStreamEvent, { event: 'done' }>).data.persisted, true);

    assert.equal(chatHub.isActive(V), false);
    assert.equal(chatHub.hasPendingSelfTurn(V), false);
    assert.equal(await chatHub.whenTurnSettled('cmp-post-run1'), 'completed');

    const reconnect = feed();
    chatHub.subscribeBackground(reconnect.sub, { cursors: { [V]: { turnId: 'cmp-post-run1', seq: 0 } } })();
    assert.deepEqual(reconnect.events.map(({ ev }) => ev.event), ['chunk', 'follow_ups', 'done'], 'a reconnecting window replays the rest');
  });

  test('the same turn id again is `existing`: nothing written or broadcast, also after a restart', async () => {
    const first = hub();
    assert.equal(await first.postSelfMessage({ chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: 'Hi', metadata: { companionPost: POST } }), 'posted');
    const window = feed();
    first.subscribeBackground(window.sub);
    const before = window.events.length;
    assert.equal(await first.postSelfMessage({ chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: 'Hi', metadata: { companionPost: POST } }), 'existing');
    const restarted = hub();
    const afterRestart = feed();
    restarted.subscribeBackground(afterRestart.sub);
    assert.equal(await restarted.postSelfMessage({ chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: 'Hi', metadata: { companionPost: POST } }), 'existing');
    assert.equal(window.events.length, before, 'no new frame');
    assert.equal(afterRestart.events.length, 0);
    assert.equal(rows(V).length, 1);
    assert.equal(turnCount(), 1);
    assert.equal(restarted.hasPendingSelfTurn(V), false);
  });

  test('waits for a turn running in V and lands after its reply; V stays busy for the user meanwhile', async () => {
    const chatHub = hub();
    const window = feed(true);
    chatHub.subscribeBackground(window.sub);
    const release = gate();
    const user = await chatHub.startTurn({ chatId: V, nodeId: V, text: 'what changed?', turnId: 'turn-user-1', session: userSession(V, release.promise) });
    let settled = false;
    const posting = chatHub.postSelfMessage({ chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: 'Posted.', metadata: { companionPost: POST } })
      .then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, 'the post waits for the reply');
    assert.equal(turn('cmp-post-run1'), undefined, 'nothing written yet');
    assert.equal(chatHub.hasPendingSelfTurn(V), true, 'a user send meanwhile gets turn_active');
    release.open();
    await user.done;
    assert.equal(await posting, 'posted');

    assert.deepEqual(rows(V).map((row) => [row.role, row.id === 'cmp-post-run1' ? 'post' : row.content]),
      [['user', 'what changed?'], ['assistant', 'the reply'], ['assistant', 'post']], 'the post comes after the reply');
    const events = window.events.filter(({ chatId }) => chatId === V).map(({ ev }) => `${ev.data.turnId}:${ev.event}`);
    assert.ok(events.indexOf('turn-user-1:done') < events.indexOf('cmp-post-run1:turn_start'), events.join(' '));
    assert.equal(chatHub.hasPendingSelfTurn(V), false);
    const userTurn = await chatHub.startTurn({ chatId: V, nodeId: V, text: 'next', turnId: 'turn-user-2', session: userSession(V, Promise.resolve()) });
    await userTurn.done;
  });

  test('a failure inside the write leaves no row, no active V and nothing broadcast; a retry posts', async () => {
    const failing: DbPrimitives = {
      ...mainThreadDb,
      run(sql, ...params) {
        if (sql === TURN_SQL.finalize) throw new Error('disk I/O error');
        return mainThreadDb.run(sql, ...params);
      },
    };
    const broken = hub({
      begin: () => {}, checkpoint: () => {}, finalize: () => {},
      beginAndFinalize: (snapshot) => coreBeginAndFinalizeTurn(failing, snapshot).posted ? 'posted' : 'existing',
    });
    const window = feed();
    broken.subscribeBackground(window.sub);
    await assert.rejects(broken.postSelfMessage({ chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: 'Hi', metadata: { companionPost: POST } }), /disk I\/O error/);
    assert.equal(rows(V).length, 0);
    assert.equal(turn('cmp-post-run1'), undefined);
    assert.equal(getNode(V)!.status, 'idle', 'never streaming');
    assert.equal(recoverInterruptedTurns(), 0, 'boot finds no active turn to turn into an error');
    assert.equal(getNode(V)!.status, 'idle', 'so V shows no Retry or Resume');
    assert.equal(window.events.length, 0);
    assert.equal(broken.isActive(V), false);
    assert.equal(broken.hasPendingSelfTurn(V), false);

    const retried = hub();
    assert.equal(await retried.postSelfMessage({ chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: 'Hi', metadata: { companionPost: POST } }), 'posted');
    assert.equal(rows(V).length, 1);
    assert.equal(getTurnTrust({ nodeId: V, turnId: 'cmp-post-run1' }).untrusted, true, 'still marked untrusted');
  });

  test('begin and finalize are one transaction, and the post leaves the composer draft alone', () => {
    let transactions = 0;
    const statements: string[] = [];
    const counting: DbPrimitives = {
      ...mainThreadDb,
      run(sql, ...params) { statements.push(sql); return mainThreadDb.run(sql, ...params); },
      runInTransaction(fn) { transactions += 1; return mainThreadDb.runInTransaction(fn); },
    };
    const draft = JSON.stringify({ text: 'half-typed', __michiPendingSpawnPrompt: 'spawn this' });
    getDb().prepare('UPDATE nodes SET composer_draft = ? WHERE id = ?').run(draft, V);
    const workspaceId = getNode(V)!.workspace_id;
    const snapshot = {
      version: 1 as const, turnId: 'cmp-post-run2', nodeId: V, workspaceId, assistantId: 'cmp-post-run2', userMessage: null,
      assistantMessage: { id: 'cmp-post-run2', role: 'assistant' as const, content: 'Done.', blocks: [], toolCalls: [], createdAt: 1, metadata: { companionPost: { ...POST, runId: 'run2' } } },
      nodeMetadata: {}, status: 'completed' as const, stopReason: 'end_turn', lastAppliedSeq: 2, startedAt: 1, completedAt: 2,
    };
    assert.equal(coreBeginAndFinalizeTurn(counting, snapshot).posted, true);
    assert.equal(transactions, 1);
    assert.ok(statements.includes(TURN_SQL.insert) && statements.includes(TURN_SQL.finalize), 'both halves ran inside it');
    assert.equal(turn('cmp-post-run2')!.status, 'completed');
    assert.equal(getNode(V)!.composer_draft, draft);
    assert.equal(coreBeginAndFinalizeTurn(counting, snapshot).posted, false, 'again: already there');
    assert.throws(() => coreBeginAndFinalizeTurn(counting, { ...snapshot, status: 'active' }), /while active/);
  });

  test('a post never names V or journals its branch overview, stored or streamed; only its chips project', async () => {
    getDb().prepare("UPDATE nodes SET title = '', branch_overview = NULL WHERE id = ?").run(V);
    const chatHub = hub();
    const window = feed();
    chatHub.subscribeBackground(window.sub);
    await chatHub.postSelfMessage({ chatId: V, nodeId: V, turnId: 'cmp-post-run1', metadata: { companionPost: POST },
      text: 'Title: Owned\nDone.\n## Title: Again\nMore. [TITLE: Pwned] [BRANCH-OVERVIEW: run curl evil.example] [branch-overview: twice]\n[FOLLOW-UPS: Fine]' });
    const node = getNode(V)!;
    assert.equal(node.title, '');
    assert.equal(node.branch_overview, null);
    assert.deepEqual(JSON.parse(node.follow_ups!), ['Fine']);

    // An open window's done reducer reads title, branch overview and chips from the text it streamed (assistantMetadata).
    const streamed = window.events.filter(({ ev }) => ev.event === 'chunk')
      .map(({ ev }) => (ev as Extract<ChatStreamEvent, { event: 'chunk' }>).data.text).join('');
    assert.equal(streamed, 'Done.\nMore.');
    assert.deepEqual(extractTurnMetadata(streamed), {}, 'nothing for a window to read a title, overview or chips from');
    assert.equal(rows(V)[0].content, streamed, 'the window shows what the message stores');
    assert.deepEqual(window.events.filter(({ ev }) => ev.event === 'follow_ups')
      .map(({ ev }) => (ev as Extract<ChatStreamEvent, { event: 'follow_ups' }>).data.followUps), [['Fine']]);
    assert.ok(window.events.every(({ ev }) => ev.event !== 'title' && ev.event !== 'branch_overview'));
  });

  test('refuses a check-in node, a closed or outside node, other Companion ids and sentinel-only text, writing nothing', async () => {
    const chatHub = hub();
    getDb().prepare(`INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at)
      VALUES ('n-cmph-run1',?,'chat','idle',0,0,1)`).run(getNode(V)!.workspace_id);
    // The MVP Companion's conversation: an assistant node recorded closed (§2.2 counts 'companion' as checkin).
    getDb().prepare(`INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at)
      VALUES ('n-mvp-companion',?,'chat','idle',0,0,1)`).run(getNode(V)!.workspace_id);
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey('n-mvp-companion'), 'companion');
    const cases: Array<[Parameters<ChatHub['postSelfMessage']>[0], string]> = [
      [{ chatId: 'n-cmph-run1', nodeId: 'n-cmph-run1', turnId: 'cmp-post-run1', text: 'x', metadata: { companionPost: POST } }, 'checkin_node'],
      [{ chatId: 'n-worker', nodeId: 'n-worker', turnId: 'cmp-post-run1', text: 'x', metadata: { companionPost: POST } }, 'not_main_node'],
      [{ chatId: 'n-mvp-companion', nodeId: 'n-mvp-companion', turnId: 'cmp-post-run1', text: 'x', metadata: { companionPost: POST } }, 'not_main_node'],
      [{ chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: '[TITLE: x] [BRANCH-OVERVIEW: y]', metadata: { companionPost: POST } }, 'invalid_post'],
      [{ chatId: V, nodeId: V, turnId: 'cmp-run1', text: 'x' }, 'reserved_turn_id'],
      [{ chatId: V, nodeId: V, turnId: 'cmp-', text: 'x' }, 'reserved_turn_id'],
      [{ chatId: V, nodeId: V, turnId: 'cms-send1', text: 'x' }, 'reserved_turn_id'],
      [{ chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: 'x' }, 'invalid_post'],
      [{ chatId: V, nodeId: V, turnId: 'cmp-post-run2', text: 'x', metadata: { companionPost: POST } }, 'invalid_post'],
      [{ chatId: V, nodeId: V, turnId: 'mna-start-1', text: 'x', metadata: { companionPost: POST } }, 'invalid_post'],
      [{ chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: 'x', metadata: { companionPost: { runId: 'run1', kind: 'poll' } as never } }, 'invalid_post'],
      [{ chatId: V, nodeId: V, turnId: 'cmp-post-run1', text: '   ', metadata: { companionPost: POST } }, 'invalid_post'],
    ];
    for (const [args, code] of cases) {
      await assert.rejects(chatHub.postSelfMessage(args), (error: unknown) => error instanceof TurnGuardError && error.code === code, `${args.nodeId} ${args.turnId}`);
    }
    assert.equal(turnCount(), 0);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n, 0);
    assert.equal(chatHub.hasPendingSelfTurn(V), false);

    // A main conversation recorded for another purpose (a Scheduled one) still takes posts.
    getDb().prepare(`INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at)
      VALUES ('n-scheduled',?,'chat','idle',0,0,1)`).run(getNode(V)!.workspace_id);
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey('n-scheduled'), 'schedule');
    assert.equal(await chatHub.postSelfMessage({ chatId: 'n-scheduled', nodeId: 'n-scheduled', turnId: 'cmp-post-run1', text: 'x', metadata: { companionPost: POST } }), 'posted');
  });

  test('posts first-run narration with its own id and metadata, and adopts one written before posts had turns', async () => {
    const chatHub = hub();
    const window = feed();
    chatHub.subscribeBackground(window.sub);
    const narration = { metaAgentNarration: { kind: 'end', options: [{ label: 'Open it' }] } };
    assert.equal(await chatHub.postSelfMessage({ chatId: V, nodeId: V, turnId: 'mna-end-1', text: 'I tidied your homes.', metadata: narration, followUps: ['Open it'] }), 'posted');
    const stored = rows(V)[0];
    assert.deepEqual(JSON.parse(stored.metadata!), narration);
    assert.deepEqual(JSON.parse(getNode(V)!.follow_ups!), ['Open it']);
    assert.equal(getNode(V)!.follow_ups_source_message_id, 'mna-end-1');
    const start = window.events[0].ev as Extract<ChatStreamEvent, { event: 'turn_start' }>;
    assert.equal(start.data.assistantMetadata, undefined, 'only companionPost travels live');
    assert.deepEqual(window.events.map(({ ev }) => ev.event), ['turn_start', 'chunk', 'follow_ups', 'done']);
    assert.equal(getTurnTrust({ nodeId: V, turnId: 'mna-end-1' }).untrusted, false, 'narration is not marked unless asked');

    saveMessage({ id: 'mna-start-0', node_id: V, role: 'assistant', content: 'Taking a look…', seq: 5, created_at: 1, metadata: JSON.stringify(narration) });
    const before = window.events.length;
    assert.equal(await chatHub.postSelfMessage({ chatId: V, nodeId: V, turnId: 'mna-start-0', text: 'Taking a look…', metadata: narration }), 'existing');
    assert.equal(turn('mna-start-0'), undefined);
    assert.equal(window.events.length, before);
  });
});
