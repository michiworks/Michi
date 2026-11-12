// Must stay first: agentConfig would otherwise persist settings to ~/.michi/config.json.
import './isolatedConfigDir';
// Reply sources (services/memory/replySources.ts, spec round 10 §T): the
// ledger of what a session was given, the "used" rule at turn end (recall's
// own gate, then the reply adds what matched), the guards, the rows' triggers,
// the API and Don't recall.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import type { MemoryRecord } from 'michi-shared';
import { memoryTool } from '../src/agents/memoryTools';
import { setupMemoryRoutes } from '../src/routes/memories';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import type { MemoryPack, MemoryPackItem } from '../src/services/memory/contextBuilder';
import { installMemoryExtractionHooks } from '../src/services/memory/extractionService';
import { purgeOwnerMemories } from '../src/services/memory/memoryRepository';
import { conversationRef, memoryRef } from '../src/services/memory/memoryRefs';
import {
  createMemory, deleteMemory, forgetMemory, mergeMemoryInto, resetMemories, setConversationMemoryMode, setMemorySettings,
  supersedeMemory, type CreateMemoryInput,
} from '../src/services/memory/memoryService';
import { indexTurn, recallTurnMatch, recallTurnsMatching, setTurnKeys } from '../src/services/memory/recallIndex';
import {
  attributeTurn, forgetRecalledTurn, noteDelivered, noteSearched, recalledTurnScope, replySourceGateCalls, replySourcesView, resetReplySources,
  type AttributionTurn,
} from '../src/services/memory/replySources';

const ME = LOCAL_AGENT_OWNER_ID;
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
let dataDir: string;
let uninstall: (() => void) | null = null;
let serial = 0;
let now = Date.now();

function chat(nodeId: string, workspaceId = 'ws'): void {
  getDb().prepare("INSERT OR IGNORE INTO nodes (id, workspace_id, kind, status, created_at, title) VALUES (?, ?, 'chat', 'idle', ?, ?)")
    .run(nodeId, workspaceId, now, `Chat ${nodeId}`);
}

/** A finished turn of the conversation: its durable row and its recall document. */
function past(nodeId: string, user: string, reply: string, turnId = `p-${++serial}`): string {
  chat(nodeId);
  now += 1_000;
  getDb().prepare(`INSERT OR REPLACE INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, last_seq, started_at, updated_at)
    VALUES (?, ?, ?, ?, 'completed', 0, ?, ?)`).run(turnId, nodeId, `u-${turnId}`, `a-${turnId}`, now, now);
  indexTurn({ ownerUserId: null, nodeId, turnId, humanOrigin: true, userText: user, assistantText: reply, completedAt: now, userMessageAt: now });
  return turnId;
}

function docOf(turnId: string): number {
  return (getDb().prepare("SELECT id FROM memory_recall_docs WHERE doc_kind = 'turn' AND ref_id = ?").get(turnId) as { id: number }).id;
}

function memory(body: string, extra: Partial<CreateMemoryInput> = {}): MemoryRecord {
  return createMemory({ ownerUserId: ME }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'extracted', ...extra });
}

function rowOf(record: { id: string }): { row: number; version: number } {
  const row = getDb().prepare('SELECT row_id, version FROM memories WHERE id = ?').get(record.id) as { row_id: number; version: number };
  return { row: row.row_id, version: row.version };
}

function memoryItem(record: MemoryRecord, section: MemoryPackItem['section']): MemoryPackItem {
  const { row, version } = rowOf(record);
  return { ref: memoryRef(row, version), section, kind: 'memory', id: record.id, nodeId: record.source?.nodeId ?? null, turnId: record.source?.turnId ?? null, at: 0 };
}

function excerptItem(turnId: string, shown: string, section: MemoryPackItem['section'] = 'related'): MemoryPackItem {
  return { ref: conversationRef(docOf(turnId)), section, kind: 'conversation', id: turnId, nodeId: null, turnId, at: 0, shown };
}

function deliver(nodeId: string, turnId: string, items: MemoryPackItem[], options: { framed?: boolean; pinned?: boolean } = {}): void {
  const pack: Pick<MemoryPack, 'off' | 'framed' | 'signature' | 'items'> = {
    off: false, framed: options.framed ?? false, signature: options.pinned === false ? null : `sig-${++serial}`, items,
  };
  noteDelivered({ ownerUserId: ME, nodeId, turnId, pack });
}

/** The turn as ChatHub finalizes it: indexed for recall, then attributed. */
function finish(nodeId: string, turnId: string, user: string, reply: string, extra: Partial<AttributionTurn> = {}) {
  past(nodeId, user, reply, turnId);
  return attributeTurn({ ownerUserId: null, nodeId, turnId, humanOrigin: true, userText: user, assistantText: reply, outcome: 'completed',
    status: 'ended', persisted: true, ...extra });
}

function sources(turnId: string): Array<{ kind: string; id: string }> {
  return (getDb().prepare('SELECT item_kind, item_id FROM memory_turn_sources WHERE turn_id = ? ORDER BY rank').all(turnId) as Array<{ item_kind: string; item_id: string }>)
    .map((row) => ({ kind: row.item_kind, id: row.item_id }));
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-reply-sources-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  resetReplySources();
  serial = 0;
  now = Date.now() - 86_400_000;
  getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Home', 1, 1), ('ws2', 'Work', 1, 1)").run();
  uninstall = installMemoryExtractionHooks();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.data;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('recall\'s gate', () => {
  test('recallTurnMatch agrees with recallTurnsMatching: Chinese, English, mixed, identifiers, common and weak words', () => {
    const turns = [
      past('n-1', '我家的狗叫 Biscuit', '好的，记住了 Biscuit。'),
      past('n-1', 'Deploy to us-east-1 with node v22', 'Done: us-east-1, node v22.'),
      past('n-2', 'I like good food', 'Good choice.'),
      past('n-2', '周末去爬山', '天气不错，适合爬山。'),
      past('n-3', 'The kestrel-9 build failed', 'Rebuilding kestrel-9.'),
    ];
    const queries = ['Biscuit', '狗', 'us-east-1 v22', 'good', 'like good', '爬山 hiking', 'kestrel-9', 'the', '用户的狗叫 Biscuit\ndog\n狗'];
    const docs = turns.map(docOf);
    for (const query of queries) {
      const all = new Set(recallTurnsMatching({ ownerUserId: ME, workspaceId: 'ws', query, docIds: docs }));
      for (const docId of docs) {
        const one = recallTurnMatch({ ownerUserId: ME, workspaceId: 'ws', query, docId });
        assert.equal(one !== null, all.has(docId), `${query} on doc ${docId}`);
      }
    }
    assert.ok(recallTurnMatch({ ownerUserId: ME, workspaceId: 'ws', query: 'kestrel-9', docId: docs[4]! })!.length > 0, 'the matched parts');
  });
});

describe('the ledger', () => {
  test('pinned sections are replaced when a pack carries them; a new session clears the carry; the carry is this turn and the two before', () => {
    const dog = memory('The user\'s dog is called Biscuit.', { keywords: ['dog', 'Biscuit'] });
    const cat = memory('The user\'s cat is called Mochi.', { keywords: ['cat', 'Mochi'] });
    deliver('n-chat', 't-1', [memoryItem(dog, 'preferences')], { framed: true });
    assert.deepEqual(sources('t-1'), []);
    assert.deepEqual(finish('n-chat', 't-1', 'What is my dog called?', 'Your dog is Biscuit.')!.used.map((entry) => entry.id), [dog.id]);
    // The pinned sections changed: the dog is no longer pinned, the cat is.
    deliver('n-chat', 't-2', [memoryItem(cat, 'preferences')]);
    assert.deepEqual(finish('n-chat', 't-2', 'And the dog?', 'The dog is Biscuit.')!.used, []);
    // A related item carries over two more turns, then drops out.
    const owl = memory('The user is a night owl and sleeps after 2 a.m.', { keywords: ['night owl'] });
    deliver('n-chat', 't-3', [memoryItem(owl, 'related')], { pinned: false });
    finish('n-chat', 't-3', 'Plan my evening', 'Start late.');
    deliver('n-chat', 't-4', [], { pinned: false });
    assert.deepEqual(finish('n-chat', 't-4', 'When do I sleep?', 'As a night owl, after 2 a.m.')!.used.map((entry) => entry.id), [owl.id]);
    deliver('n-chat', 't-5', [], { pinned: false });
    finish('n-chat', 't-5', 'Thanks', 'Anytime.');
    deliver('n-chat', 't-6', [], { pinned: false });
    assert.deepEqual(finish('n-chat', 't-6', 'When do I sleep again?', 'Night owl: after 2 a.m.')!.used, [], 'three turns later it is no longer carried');
    // A new session starts over.
    deliver('n-chat', 't-7', [memoryItem(owl, 'related')], { pinned: false });
    deliver('n-chat', 't-7', [], { framed: true, pinned: false });
    assert.deepEqual(finish('n-chat', 't-7', 'Sleep?', 'Night owl, after 2 a.m.')!.used, []);
  });

  test('memory_search hits, its excerpts and ref lookups are recorded for the running turn; an Off conversation drops the ledger', () => {
    chat('n-chat');
    getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, last_seq, started_at, updated_at)
      VALUES ('t-live', 'n-chat', NULL, 'a-t-live', 'active', 0, ?, ?)`).run(now, now);
    const tPast = past('n-old', 'The Falcon launch is on March 3', 'Noted: Falcon launches March 3.');
    const plant = memory('The user\'s fern needs water every Thursday.', { keywords: ['fern', 'Thursday'] });
    const caller = { ownerUserId: null, workspaceId: 'ws', nodeId: 'n-chat', isAgentRun: false };
    assert.notEqual(memoryTool('memory_search', caller, { query: 'Falcon launch' }).isError, true);
    assert.notEqual(memoryTool('memory_search', caller, { query: 'fern' }).isError, true);
    getDb().prepare("UPDATE turns SET status = 'completed' WHERE turn_id = 't-live'").run();
    const result = finish('n-chat', 't-live', 'when is the launch, and when do I water the plant?', 'Falcon launches March 3; water the fern on Thursday.')!;
    assert.deepEqual(new Set(result.used.map((entry) => entry.id)), new Set([plant.id, String(docOf(tPast))]));
    assert.ok(result.used.every((entry) => entry.section === 'search'));
    // Off: the retraction drops what the conversation held.
    noteDelivered({ ownerUserId: ME, nodeId: 'n-chat', turnId: null, pack: { off: true, framed: false, signature: null, items: [] } });
    assert.deepEqual(finish('n-chat', 't-after', 'water day?', 'Thursday, for the fern.')!.used, []);
  });

  test('the bounds hold: 30 items a turn, the excerpt text a turn holds', () => {
    const long = 'x'.repeat(20_000);
    noteSearched({ ownerUserId: ME, nodeId: 'n-chat', turnId: 't-1', items: Array.from({ length: 40 }, (_, i) => ({ kind: 'memory' as const, id: `mem-${i}` })) });
    noteSearched({ ownerUserId: ME, nodeId: 'n-chat', turnId: 't-1', items: [{ kind: 'conversation', docId: 1, text: long }, { kind: 'conversation', docId: 2, text: long }] });
    const result = finish('n-chat', 't-1', 'hello', 'hi');
    assert.ok(result, 'attributed (nothing used)');
    assert.ok(result.candidates.length <= 30);
  });
});

describe('the "used" rule', () => {
  test('what the user stated this turn is not used; a question and its answer is; cross-language through keywords', () => {
    const dog = memory('用户的狗叫 Biscuit', { keywords: ['dog', 'Biscuit', '狗'] });
    deliver('n-chat', 't-1', [memoryItem(dog, 'preferences')], { framed: true });
    assert.deepEqual(finish('n-chat', 't-1', 'My dog Biscuit is sick', 'Sorry to hear Biscuit is unwell.')!.used, [], 'the user said it');
    deliver('n-chat', 't-2', [], { pinned: false });
    assert.deepEqual(finish('n-chat', 't-2', 'What is my dog called?', 'Your dog is called Biscuit.')!.used.map((entry) => entry.id), [dog.id]);
  });

  test('an excerpt is used through its shown text plus its keys; one whose turn a used memory came from is dropped', () => {
    const tPast = past('n-old', 'We picked the codename Falcon for the March launch', 'Falcon it is.');
    setTurnKeys(ME, tPast, ['codename', 'launch', '代号']);
    deliver('n-chat', 't-1', [excerptItem(tPast, 'We picked the codename Falcon for the March launch → Falcon it is.')], { framed: true });
    assert.deepEqual(finish('n-chat', 't-1', '代号是什么？', 'The codename is Falcon.')!.used.map((entry) => entry.kind), ['conversation']);
    const fromPast = memory('The launch codename is Falcon.', { keywords: ['codename', 'Falcon'], source: { nodeId: 'n-old', turnId: tPast } });
    deliver('n-chat', 't-2', [memoryItem(fromPast, 'related'), excerptItem(tPast, 'We picked the codename Falcon for the March launch → Falcon it is.')]);
    assert.deepEqual(finish('n-chat', 't-2', 'remind me of the codename', 'Falcon.')!.used.map((entry) => entry.id), [fromPast.id]);
  });

  test('the digit clause: a number in the item and the reply that the user did not write', () => {
    const room = memory('Room A-1207 is booked for the offsite.', { keywords: ['offsite', 'room'] });
    deliver('n-chat', 't-1', [memoryItem(room, 'related')], { framed: true });
    assert.deepEqual(finish('n-chat', 't-1', 'Which room did I book for the offsite?', 'It is room 1207.')!.used.map((entry) => entry.id), [room.id]);
  });

  test('words below the gate are not used; the prefilter asks no search; at most 12 checks and 6 sources', () => {
    const vague = memory('Likes good things.');
    const unrelated = memory('The user\'s passport expires in 2031.', { keywords: ['passport'] });
    deliver('n-chat', 't-1', [memoryItem(vague, 'related'), memoryItem(unrelated, 'related')], { framed: true });
    const before = replySourceGateCalls();
    const result = finish('n-chat', 't-1', 'how was it?', 'That was a good one, I like it.')!;
    assert.deepEqual(result.used, []);
    assert.equal(replySourceGateCalls() - before, 1, 'the vague note is searched; the passport note holds no term of the turn, so it is not');
    const many = Array.from({ length: 16 }, (_, i) => memory(`Zephyrine note ${i}: the zephyrine valve ${i} is calibrated.`, { keywords: ['zephyrine'] }));
    deliver('n-chat', 't-2', many.map((record) => memoryItem(record, 'related')), { pinned: false });
    const busy = finish('n-chat', 't-2', 'status?', `All zephyrine valves are calibrated: ${many.map((_, i) => `valve ${i}`).join(', ')}.`)!;
    assert.ok(busy.evaluated <= 12, `${busy.evaluated} checks`);
    assert.equal(busy.used.length, 6);
    assert.equal(sources('t-2').length, 6);
  });

  test('the reply\'s own turn does not make what it repeats look common (ported from round 10\'s attribution)', () => {
    const cat = memory('The user\'s cat is called Mochi.', { keywords: ['cat', 'Mochi'] });
    past('n-old', 'My cat Mochi turned five today', 'Happy birthday, Mochi!');
    past('n-old', 'Mochi knocked a glass off the table', 'Classic.');
    deliver('n-chat', 't-1', [memoryItem(cat, 'preferences')], { framed: true });
    // Mochi is in the two past turns and this reply: rare among the other documents.
    assert.deepEqual(finish('n-chat', 't-1', 'What should I buy for dinner?', 'Grab some fish, and a treat for Mochi.')!.used.map((entry) => entry.id), [cat.id]);
  });

  test('one word alone is used only as one of the item\'s keywords; a short number never alone; three digits or a decimal are', () => {
    const move = memory('The user plans to move abroad next spring.', { keywords: ['abroad', 'relocation'] });
    deliver('n-chat', 't-1', [memoryItem(move, 'related')], { framed: true });
    assert.deepEqual(finish('n-chat', 't-1', 'Any chess opening tips?', 'Make your first move toward the centre.')!.used, [], 'move is no keyword of it');
    deliver('n-chat', 't-2', [memoryItem(move, 'related')], { pinned: false });
    assert.deepEqual(finish('n-chat', 't-2', 'Any tips for next year?', 'Since you are going abroad, start the paperwork early.')!.used.map((entry) => entry.id),
      [move.id], 'abroad is');
    const years = memory('用户已做护理 14 年', { keywords: ['14', '护理'] });
    deliver('n-chat', 't-3', [memoryItem(years, 'related')], { pinned: false });
    assert.deepEqual(finish('n-chat', 't-3', '今天几号？', '今天是 14 号。')!.used, [], 'a two-digit number alone, even a keyword');
    const spot = memory('The user\'s parking spot is 1650.', { keywords: ['parking'] });
    deliver('n-chat', 't-4', [memoryItem(spot, 'related')], { pinned: false });
    assert.deepEqual(finish('n-chat', 't-4', 'Where did I leave the car?', 'In spot 1650.')!.used.map((entry) => entry.id), [spot.id]);
    const weight = memory('The user\'s target weight is 62.5 kg.', { keywords: ['weight'] });
    deliver('n-chat', 't-5', [memoryItem(weight, 'related')], { pinned: false });
    assert.deepEqual(finish('n-chat', 't-5', 'What is my goal?', 'Your goal is 62.5.')!.used.map((entry) => entry.id), [weight.id]);
    // Two words of it the user did not write are enough, keywords or not.
    const hikes = memory('用户周末常去爬山和游泳');
    deliver('n-chat', 't-6', [memoryItem(hikes, 'related')], { pinned: false });
    assert.deepEqual(finish('n-chat', 't-6', '帮我写个周末计划', '周六上午爬山，下午游泳。')!.used.map((entry) => entry.id), [hikes.id]);
    deliver('n-chat', 't-7', [memoryItem(hikes, 'related')], { pinned: false });
    assert.deepEqual(finish('n-chat', 't-7', '帮我写个周末计划', '周六上午可以去爬山。')!.used, [], 'one of them alone is not');
  });

  test('what the turn itself saved is not its source', () => {
    deliver('n-chat', 't-1', [], { framed: true });
    chat('n-chat');
    const saved = memory('The user\'s locker is 4471.', { source: { nodeId: 'n-chat', turnId: 't-1' } });
    noteSearched({ ownerUserId: ME, nodeId: 'n-chat', turnId: 't-1', items: [{ kind: 'memory', id: saved.id }] });
    assert.deepEqual(finish('n-chat', 't-1', 'remember my locker', 'Saved: locker 4471.')!.used, []);
  });
});

describe('guards', () => {
  function setup() {
    const dog = memory('The user\'s dog is called Biscuit.', { keywords: ['dog', 'Biscuit'] });
    deliver('n-chat', 't', [memoryItem(dog, 'preferences')], { framed: true });
    return dog;
  }

  test('cancelled, failed, unpersisted, not typed by a person: nothing is written', () => {
    for (const [index, extra] of ([{ outcome: 'cancelled' }, { status: 'error', outcome: 'error' }, { persisted: false }, { humanOrigin: false }] as Array<Partial<AttributionTurn>>).entries()) {
      setup();
      const turnId = `t-guard-${index}`;
      deliver('n-chat', turnId, [], { pinned: false });
      assert.equal(finish('n-chat', turnId, 'What is my dog called?', 'Your dog is Biscuit.', extra), null);
      assert.deepEqual(sources(turnId), []);
    }
  });

  test('a Use only or Off chat, a hidden document, memory off or another cloud owner: nothing is written', () => {
    setup();
    chat('n-use');
    setConversationMemoryMode({ ownerUserId: ME }, 'n-use', 'use_only');
    assert.equal(finish('n-use', 't-use', 'What is my dog called?', 'Your dog is Biscuit.'), null, 'Use only indexes nothing');
    setup();
    past('n-chat', 'What is my dog called?', 'Your dog is Biscuit.', 't-hidden');
    forgetRecalledTurn(recalledTurnScope(ME, docOf('t-hidden')));
    assert.equal(attributeTurn({ ownerUserId: null, nodeId: 'n-chat', turnId: 't-hidden', humanOrigin: true, userText: 'x', assistantText: 'Biscuit' }), null);
    setup();
    setMemorySettings(ME, { mode: 'off' });
    assert.equal(finish('n-chat', 't-off', 'dog name?', 'Your dog is Biscuit.'), null);
    setMemorySettings(ME, { mode: 'auto' });
    process.env.MICHI_CLOUD = '1';
    getDb().prepare("UPDATE workspaces SET owner_user_id = 'alice' WHERE id = 'ws'").run();
    past('n-chat', 'dog name?', 'Biscuit.', 't-cloud');
    assert.equal(attributeTurn({ ownerUserId: 'mallory', nodeId: 'n-chat', turnId: 't-cloud', humanOrigin: true, userText: 'dog name?', assistantText: 'Biscuit.' }), null);
    delete process.env.MICHI_CLOUD;
  });

  test('rows exist before the listener returns, and the listener never throws', () => {
    const dog = setup();
    finish('n-chat', 't', 'What is my dog called?', 'Your dog is Biscuit.');
    assert.deepEqual(sources('t'), [{ kind: 'memory', id: dog.id }]);
    assert.doesNotThrow(() => attributeTurn(null as never));
    assert.doesNotThrow(() => attributeTurn({ nodeId: 'n-chat', turnId: 't', humanOrigin: true } as never));
  });
});

describe('triggers', () => {
  const NAMES = ['Falcon', 'Kestrel', 'Osprey', 'Merlin', 'Harrier'];
  let call = 0;
  /** A reply (its own turn) that used a memory and an excerpt, each with words of its own. */
  function used(): { dog: MemoryRecord; tPast: string; turnId: string } {
    call += 1;
    const pet = `Biscuit${call}`;
    const name = NAMES[call % NAMES.length]!;
    const dog = memory(`The user's dog is called ${pet}.`, { keywords: ['dog', pet] });
    const tPast = past('n-old', `The ${name} launch is on March ${call}`, 'Noted.');
    const turnId = `t-used-${call}`;
    deliver('n-chat', turnId, [memoryItem(dog, 'preferences'), excerptItem(tPast, `The ${name} launch is on March ${call} → Noted.`)], { framed: true });
    finish('n-chat', turnId, 'dog and launch?', `${pet}, and ${name} launches March ${call}.`);
    assert.equal(sources(turnId).length, 2);
    return { dog, tPast, turnId };
  }

  test('forget, delete, reset and owner purges take memory rows', () => {
    const first = used();
    forgetMemory({ ownerUserId: ME }, first.dog.id);
    assert.deepEqual(sources(first.turnId).map((row) => row.kind), ['conversation']);
    const second = used();
    deleteMemory({ ownerUserId: ME }, second.dog.id);
    assert.deepEqual(sources(second.turnId).map((row) => row.kind), ['conversation']);
    const third = used();
    resetMemories({ ownerUserId: ME });
    assert.deepEqual(sources(third.turnId), []);
    // An owner purge takes whatever rows are left.
    const fourth = used();
    purgeOwnerMemories(ME);
    assert.deepEqual(sources(fourth.turnId), []);
  });

  test('Don\'t recall, Use only and deleting the conversation take conversation rows; purging or deleting the node takes its own', () => {
    const first = used();
    forgetRecalledTurn(recalledTurnScope(ME, docOf(first.tPast)));
    assert.deepEqual(sources(first.turnId).map((row) => row.kind), ['memory']);
    const second = used();
    setConversationMemoryMode({ ownerUserId: ME }, 'n-old', 'use_only');
    assert.deepEqual(sources(second.turnId).map((row) => row.kind), ['memory']);
    setConversationMemoryMode({ ownerUserId: ME }, 'n-old', 'learn');
    const tWords = past('n-old2', 'Peregrine kestrel launch notes', 'ok');
    // One word alone names an excerpt only as one of its keys.
    setTurnKeys(ME, tWords, ['Peregrine', 'launch notes']);
    deliver('n-chat', 't-words', [excerptItem(tWords, 'Peregrine kestrel launch notes → ok')], { framed: true });
    finish('n-chat', 't-words', 'launch notes?', 'The Peregrine notes.');
    assert.deepEqual(sources('t-words').map((row) => row.kind), ['conversation']);
    // Forgetting a memory leaves chat history and its rows as they are.
    const tPlain = past('n-old2', 'nothing to see', 'ok');
    assert.ok(tPlain);
    forgetMemory({ ownerUserId: ME }, memory('The Peregrine launch notes live in the wiki.').id);
    assert.deepEqual(sources('t-words').map((row) => row.kind), ['conversation']);
    const tGone = past('n-gone', 'The Saturn review is Friday', 'ok');
    deliver('n-chat', 't-gone', [excerptItem(tGone, 'The Saturn review is Friday → ok')], { pinned: false });
    finish('n-chat', 't-gone', 'when is the review?', 'The Saturn review is on Friday.');
    assert.equal(sources('t-gone').length, 1);
    getDb().prepare("DELETE FROM nodes WHERE id = 'n-gone'").run();
    assert.deepEqual(sources('t-gone'), [], 'the conversation it came from was deleted');
    used();
    getDb().prepare("UPDATE nodes SET purged_at = 1 WHERE id = 'n-chat'").run();
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM memory_turn_sources WHERE node_id = 'n-chat'").get() as { n: number }).n, 0, 'purged');
    chat('n-chat2');
    deliver('n-chat2', 't-del', [], { framed: true });
    getDb().prepare(`INSERT INTO memory_turn_sources (turn_id, item_kind, item_id, owner_user_id, node_id, rank, created_at)
      VALUES ('t-del', 'memory', 'mem-x', ?, 'n-chat2', 0, 1)`).run(ME);
    getDb().prepare("DELETE FROM nodes WHERE id = 'n-chat2'").run();
    assert.deepEqual(sources('t-del'), [], 'deleted');
  });
});

describe('the view', () => {
  test('a merged memory shows the note it went into; a corrected one and a hidden, trashed or Use only excerpt show nothing', () => {
    const tA = past('n-a', 'My dog is Biscuit', 'Cute.');
    const dog = memory('The user\'s dog is called Biscuit.', { keywords: ['dog', 'Biscuit'], source: { nodeId: 'n-a', turnId: tA } });
    const pup = memory('用户的狗叫 Biscuit', { keywords: ['dog', 'Biscuit', '狗'] });
    const cat = memory('The user\'s cat is called Mochi.', { keywords: ['cat', 'Mochi'] });
    const tB = past('n-b', 'The Falcon launch is on March 3', 'Noted.');
    deliver('n-chat', 't-1', [memoryItem(dog, 'preferences'), memoryItem(pup, 'preferences'), memoryItem(cat, 'preferences'),
      excerptItem(tB, 'The Falcon launch is on March 3 → Noted.')], { framed: true });
    finish('n-chat', 't-1', 'pets and launch?', 'Biscuit the dog, Mochi the cat; Falcon launches March 3.');
    const view = () => replySourcesView({ ownerUserId: ME }, 'n-chat', ['a-t-1', 'a-unknown'])
      .messages.flatMap((message) => message.sources.map((source) => (source.kind === 'memory' ? source.memoryId : `c:${source.docId}`)));
    assert.deepEqual(new Set(view()), new Set([dog.id, pup.id, cat.id, `c:${docOf(tB)}`]));
    const first = replySourcesView({ ownerUserId: ME }, 'n-chat', ['a-t-1']).messages[0]!.sources.find((source) => source.kind === 'memory' && source.memoryId === dog.id)!;
    assert.deepEqual(first.kind === 'memory' && first.from, { nodeId: 'n-a', messageId: `u-${tA}`, title: 'Chat n-a' });
    // Merged: the head shows, once.
    mergeMemoryInto(ME, pup, dog.id, now);
    assert.deepEqual(view().filter((id) => id === dog.id || id === pup.id), [dog.id]);
    // Corrected: gone from the view.
    supersedeMemory({ ownerUserId: ME }, cat.id, { body: 'The user\'s cat is called Mochi II.', status: 'active', origin: 'extracted' });
    assert.ok(!view().includes(cat.id));
    // The source conversation's title follows a rename.
    getDb().prepare("UPDATE nodes SET title = 'Biscuit vet visit' WHERE id = 'n-a'").run();
    const after = replySourcesView({ ownerUserId: ME }, 'n-chat', ['a-t-1']).messages[0]?.sources.find((source) => source.kind === 'memory' && source.memoryId === dog.id);
    assert.equal(after?.kind === 'memory' ? after.from?.title : 'gone', 'Biscuit vet visit');
    // A hidden excerpt (Don't recall).
    const tC = past('n-c', 'The Osprey review is in room Kestrel at 15:30', 'Noted.');
    deliver('n-chat', 't-2', [excerptItem(tC, 'The Osprey review is in room Kestrel at 15:30 → Noted.')]);
    finish('n-chat', 't-2', 'where is the review?', 'The Osprey review is in room Kestrel at 15:30.');
    const shownC = () => replySourcesView({ ownerUserId: ME }, 'n-chat', ['a-t-2']).messages.flatMap((message) => message.sources.map((source) => source.kind));
    assert.deepEqual(shownC(), ['conversation']);
    forgetRecalledTurn(recalledTurnScope(ME, docOf(tC)));
    assert.deepEqual(shownC(), []);
    // A trashed excerpt conversation.
    getDb().prepare("UPDATE nodes SET deleted_at = 1 WHERE id = 'n-b'").run();
    assert.ok(!view().includes(`c:${docOf(tB)}`));
    // Off, or memory off: nothing.
    setConversationMemoryMode({ ownerUserId: ME }, 'n-chat', 'off');
    assert.deepEqual(replySourcesView({ ownerUserId: ME }, 'n-chat', ['a-t-1']), { messages: [] });
    setConversationMemoryMode({ ownerUserId: ME }, 'n-chat', 'learn');
    setMemorySettings(ME, { mode: 'off' });
    assert.deepEqual(replySourcesView({ ownerUserId: ME }, 'n-chat', ['a-t-1']), { messages: [] });
  });
});

describe('the API (cloud: two owners)', () => {
  let server: ReturnType<typeof express.application.listen>;
  let base: string;

  async function call(method: string, route: string, owner: string | null, body?: unknown): Promise<{ status: number; json: any }> {
    const response = await fetch(`${base}${route}`, {
      method, headers: { 'content-type': 'application/json', ...(owner ? { 'x-user': owner } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  beforeEach(async () => {
    process.env.MICHI_CLOUD = '1';
    getDb().prepare("UPDATE workspaces SET owner_user_id = 'alice' WHERE id = 'ws'").run();
    getDb().prepare("UPDATE workspaces SET owner_user_id = 'bob' WHERE id = 'ws2'").run();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const owner = req.header('x-user');
      if (owner) req.user = { id: owner, email: `${owner}@example.com` };
      next();
    });
    app.use('/api', setupMemoryRoutes());
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.MICHI_CLOUD;
  });

  function aliceTurn(): { dog: MemoryRecord; tPast: string } {
    const dog = createMemory({ ownerUserId: 'alice' }, { scope: { kind: 'user' }, kind: 'fact', body: 'The user\'s dog is called Biscuit.', status: 'active',
      origin: 'explicit', keywords: ['dog', 'Biscuit'] });
    const tPast = past('n-old', 'The Falcon launch is on March 3', 'Noted.');
    noteDelivered({ ownerUserId: 'alice', nodeId: 'n-chat', turnId: 't-1', pack: { off: false, framed: true, signature: 's', items: [
      memoryItem(dog, 'saved'), excerptItem(tPast, 'The Falcon launch is on March 3 → Noted.')] } });
    past('n-chat', 'dog and launch?', 'Biscuit, and Falcon launches March 3.', 't-1');
    attributeTurn({ ownerUserId: 'alice', nodeId: 'n-chat', turnId: 't-1', humanOrigin: true, userText: 'dog and launch?',
      assistantText: 'Biscuit, and Falcon launches March 3.' });
    return { dog, tPast };
  }

  test('the owner reads what a reply was based on; another owner gets 404; ids of another node are ignored; ids are validated', async () => {
    const { dog } = aliceTurn();
    const read = await call('GET', '/nodes/n-chat/memory-sources?messages=a-t-1,a-t-1,a-other', 'alice');
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.messages.map((message: { messageId: string }) => message.messageId), ['a-t-1']);
    const kinds = read.json.messages[0].sources.map((source: { kind: string }) => source.kind);
    assert.deepEqual(kinds, ['memory', 'conversation']);
    assert.equal(read.json.messages[0].sources[0].memoryId, dog.id);
    assert.equal(read.json.messages[0].sources[0].savedBy, 'user');
    assert.equal((await call('GET', '/nodes/n-chat/memory-sources?messages=a-t-1', 'bob')).status, 404, 'another owner\'s conversation');
    chat('n-bob', 'ws2');
    assert.deepEqual((await call('GET', '/nodes/n-bob/memory-sources?messages=a-t-1', 'bob')).json, { messages: [] }, 'another node\'s ids');
    for (const query of ['', '?messages=', '?messages=a,,b', `?messages=${'x'.repeat(201)}`, `?messages=${Array.from({ length: 101 }, (_, i) => `m${i}`).join(',')}`,
      '?messages=a&messages=b']) {
      assert.equal((await call('GET', `/nodes/n-chat/memory-sources${query}`, 'alice')).status, 400, query);
    }
    assert.equal((await call('GET', '/nodes/n-chat/memory-sources?messages=a-t-1', null)).status, 401, 'no access');
  });

  test('Don\'t recall hides that turn alone and bars extraction from it; it is idempotent; another owner gets 404; memory_delete with a c: ref only bars extraction', async () => {
    const { tPast } = aliceTurn();
    const docId = docOf(tPast);
    assert.equal((await call('POST', '/memory-recall/hide', 'bob', { docId })).status, 404);
    assert.equal((await call('POST', '/memory-recall/hide', 'alice', { docId: 'x' })).status, 400);
    assert.equal((await call('POST', '/memory-recall/hide', 'alice', { docId, extra: 1 })).status, 400);
    const hidden = await call('POST', '/memory-recall/hide', 'alice', { docId });
    assert.deepEqual(hidden, { status: 200, json: { hidden: true } });
    const isHidden = (turnId: string) => !!getDb().prepare("SELECT 1 FROM memory_recall_docs WHERE doc_kind = 'turn' AND ref_id = ? AND hidden = 1").get(turnId);
    assert.ok(isHidden(tPast));
    assert.equal(isHidden('t-1'), false, 'the reply that repeated it is chat history of its own conversation');
    assert.ok(getDb().prepare('SELECT 1 FROM memory_extraction_tombstones WHERE source_turn_id = ?').get(tPast), 'barred from extraction');
    assert.deepEqual((await call('POST', '/memory-recall/hide', 'alice', { docId })).json, { hidden: true }, 'again: done');
    assert.equal((await call('POST', '/memory-recall/hide', 'alice', { docId: 999_999 })).status, 404);
    // The agent's forget of a past conversation's turn leaves it chat history (nothing hidden) and keeps it out of automatic memory.
    const tOther = past('n-old', 'The Saturn review is Friday', 'ok');
    getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, last_seq, started_at, updated_at)
      VALUES ('t-forget', 'n-chat', NULL, 'a-t-forget', 'active', 0, ?, ?)`).run(now, now);
    const kept = memoryTool('memory_delete', { ownerUserId: 'alice', workspaceId: 'ws', nodeId: 'n-chat', isAgentRun: false }, { ref: conversationRef(docOf(tOther)) });
    assert.equal(kept.isError, undefined, kept.content[0]!.text);
    assert.equal(JSON.parse(kept.content[0]!.text).status, 'kept_out');
    assert.equal(isHidden(tOther), false);
    assert.ok(getDb().prepare('SELECT 1 FROM memory_extraction_tombstones WHERE source_turn_id = ?').get(tOther), 'barred from extraction');
  });
});

describe('review fixes: what counts, cost', () => {
  test('one past turn under Recent (a long message\'s start and end) and under Related (around a match): what the user said in either counts', () => {
    const filler = 'We still need to sort out the catering, the projector and the shuttle times. ';
    const tPast = past('n-old', `Notes for the offsite. ${filler.repeat(4)}The venue is Hall Lark at 14 Kestrel Road. ${filler.repeat(4)}Thanks.`, 'Got it.');
    deliver('n-chat', 't-1', [
      excerptItem(tPast, `Notes for the offsite. ${filler} … ${filler}Thanks.`, 'recent'),
      excerptItem(tPast, `… shuttle times. The venue is Hall Lark at 14 Kestrel Road. We still need … → Got it.`),
    ], { framed: true });
    assert.deepEqual(finish('n-chat', 't-1', 'Which venue did we pick?', 'You picked Hall Lark at 14 Kestrel Road.')!.used.map((entry) => entry.kind),
      ['conversation'], 'the venue only Related showed');
  });

  test('a past chat is a source by what the user typed there, not by what Michi replied there', () => {
    const tPast = past('n-old', 'Where is the offsite?', 'At the Hilton Garden Inn, Seattle.');
    deliver('n-chat', 't-1', [excerptItem(tPast, 'Where is the offsite? → At the Hilton Garden Inn, Seattle.')], { framed: true });
    assert.deepEqual(finish('n-chat', 't-1', 'Book me a taxi to the offsite', 'Booked a taxi to the Hilton Garden Inn.')!.used, [],
      'the reply repeats what Michi said there; the user told nothing of it');
    const tTold = past('n-old', 'My flight to Osaka is JL123, leaving Narita at 09:40.', 'Noted.');
    deliver('n-chat', 't-2', [excerptItem(tTold, 'My flight to Osaka is JL123, leaving Narita at 09:40. → Noted.')]);
    assert.deepEqual(finish('n-chat', 't-2', 'which flight again?', 'Your flight is JL123 from Narita.')!.used.map((entry) => entry.kind), ['conversation']);
  });

  test('a candidate whose words the reply cannot add is never searched; a large workspace checks fewer', () => {
    const notes = Array.from({ length: 4 }, (_, i) => memory(`Quillfeather note ${i}: the quillfeather valve ${i} is calibrated.`, { keywords: ['quillfeather'] }));
    deliver('n-chat', 't-1', notes.map((record) => memoryItem(record, 'related')), { framed: true });
    const before = replySourceGateCalls();
    // The user wrote every word the reply holds: nothing to add, no search.
    const said = 'Quillfeather valves 0, 1, 2 and 3 are calibrated';
    assert.deepEqual(finish('n-chat', 't-1', said, said)!.used, []);
    assert.equal(replySourceGateCalls() - before, 0);
    // A workspace of more documents than LIMITS.evaluatedDocs allows one check per turn.
    const insert = getDb().prepare(`INSERT INTO memory_recall_docs (id, owner_user_id, workspace_id, doc_kind, ref_id, node_id, turn_id, at, title, snippet, keys, active, hidden)
      VALUES (?, ?, 'ws', 'turn', ?, NULL, NULL, 1, NULL, '', '', 1, 1)`);
    for (let i = 0; i < 30_001; i += 1) insert.run(1_000_000 + i, ME, `filler-${i}`);
    deliver('n-chat', 't-2', notes.map((record) => memoryItem(record, 'related')));
    const busy = finish('n-chat', 't-2', 'status?', `All quillfeather valves are calibrated: ${notes.map((_, i) => `valve ${i}`).join(', ')}.`)!;
    assert.equal(busy.evaluated, 1);
    assert.equal(busy.used.length, 1);
  });
});
