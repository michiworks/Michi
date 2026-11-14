import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryRecord } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { runMigrations } from '../src/services/migrate';
import { deleteWorkspace } from '../src/services/dbRepository';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import {
  approveMemory,
  createMemory,
  deleteMemory,
  forgetMemory,
  rejectMemory,
  setMemorySettings,
  supersedeMemory,
  updateMemory,
  type CreateMemoryInput,
} from '../src/services/memory/memoryService';
import { readExtractionTurn } from '../src/services/memory/extractionRun';
import { installMemoryExtractionHooks } from '../src/services/memory/extractionService';
import { commitExtractionPayload } from '../src/services/memory/extractionV2';
import { profileKeywords, segmentTerms } from '../src/services/memory/memoryTerms';
import {
  forgetConversationTurn,
  indexTurn,
  keepConversationTurnOutOfMemory,
  recallDocument,
  recallSearch,
  recallTurn,
  setTurnKeys,
  startRecallBackfill,
  turnExcerpt,
  type RecallHit,
  type RecallSearchQuery,
  type RecallTurn,
} from '../src/services/memory/recallIndex';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';

const ME = LOCAL_AGENT_OWNER_ID;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 6, 12);
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
let dataDir: string;

function workspace(id: string, opts: { settings?: Record<string, unknown>; deletedAt?: number; archivedAt?: number; owner?: string } = {}): void {
  getDb().prepare(`INSERT INTO workspaces (id, name, owner_user_id, settings, deleted_at, archived_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1)`).run(id, id, opts.owner ?? null, opts.settings ? JSON.stringify(opts.settings) : null,
    opts.deletedAt ?? null, opts.archivedAt ?? null);
}

interface NodeOptions {
  kind?: string;
  status?: string;
  deletedAt?: number;
  group?: string;
  maintenance?: string;
  scheduledOnly?: string;
  pageId?: string;
}

function node(id: string, workspaceId: string, title: string | null, opts: NodeOptions = {}): void {
  getDb().prepare(`INSERT INTO nodes (id, workspace_id, kind, title, status, deleted_at, deletion_group_id, maintenance_job_id,
      scheduled_only_job_id, page_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(id, workspaceId, opts.kind ?? 'chat', title, opts.status ?? 'idle', opts.deletedAt ?? null, opts.group ?? null,
      opts.maintenance ?? null, opts.scheduledOnly ?? null, opts.pageId ?? null);
}

let serial = 0;
function finished(nodeId: string, userText: string, assistantText: string, extra: Partial<RecallTurn> = {}): RecallTurn {
  serial += 1;
  const at = NOW - 30 * DAY + serial * 60_000;
  return {
    ownerUserId: null, nodeId, turnId: `turn-${serial}`, humanOrigin: true, userText, assistantText,
    outcome: 'completed', persisted: true, completedAt: at, userMessageAt: at, ...extra,
  };
}

/** Index a completed human turn; returns its turn id. */
function turn(nodeId: string, userText: string, assistantText: string, extra: Partial<RecallTurn> = {}): string {
  const finishedTurn = finished(nodeId, userText, assistantText, extra);
  assert.equal(indexTurn(finishedTurn), true, `indexed: ${userText}`);
  return finishedTurn.turnId;
}

function memory(body: string, extra: Partial<CreateMemoryInput> = {}, ownerUserId = ME): MemoryRecord {
  return createMemory({ ownerUserId }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'explicit', ...extra });
}

function search(query: string, extra: Partial<RecallSearchQuery> = {}): RecallHit[] {
  return recallSearch({ ownerUserId: ME, workspaceIds: ['ws-a'], includeUserScope: true, currentWorkspaceId: 'ws-a', query, now: NOW, ...extra });
}

function refs(hits: RecallHit[]): string[] {
  return hits.map((hit) => hit.refId);
}

function doc(kind: 'memory' | 'turn', refId: string) {
  return getDb().prepare('SELECT * FROM memory_recall_docs WHERE doc_kind = ? AND ref_id = ?').get(kind, refId) as
    { id: number; owner_user_id: string; workspace_id: string | null; node_id: string | null; turn_id: string | null; at: number;
      title: string | null; snippet: string; keys: string; active: number; hidden: number; content: string | null } | undefined;
}

function ftsCount(term: string, table = 'memory_recall_fts'): number {
  return (getDb().prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(`"${term}"`) as { n: number }).n;
}

function integrity(): void {
  getDb().exec("INSERT INTO memory_recall_fts(memory_recall_fts) VALUES ('integrity-check')");
  getDb().exec("INSERT INTO memory_recall_full_fts(memory_recall_full_fts) VALUES ('integrity-check')");
}

/** A ref lookup's scope for one document: any workspace recall may read. */
function lookup(docId: number) {
  return { ownerUserId: ME, docId, workspaceIds: 'all' as const, includeUserScope: true, currentWorkspaceId: 'ws-a' };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-recall-index-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  serial = 0;
  workspace('ws-a');
  workspace('ws-b');
});

afterEach(() => {
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  // Back to the per-file directory isolateUserDirs chose, never the user's own.
  if (saved.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.data;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('memory documents follow every memory write', () => {
  test('create, edit, scope, keywords, supersede, approve, reject and delete', () => {
    const home = memory('我住在目黑区，离公司很近', { observedAt: NOW - 40 * DAY, source: { nodeId: 'n-1', turnId: 't-1' } });
    // Its keys: no keywords, and the words of the profile categories it states (where the user lives, and works).
    assert.deepEqual({ ...doc('memory', home.id) }, {
      id: doc('memory', home.id)!.id, owner_user_id: ME, workspace_id: null, doc_kind: 'memory', ref_id: home.id, node_id: 'n-1',
      turn_id: 't-1', at: NOW - 40 * DAY, title: null, snippet: '我住在目黑区，离公司很近', keys: profileKeywords('我住在目黑区，离公司很近').join('\n'),
      active: 1, hidden: 0, content: null, read_outside: 0,
    });
    assert.equal(ftsCount('目黑'), 1);

    // An edit replaces the indexed text; keywords are indexed too, before the category words; a scope change moves the document.
    const edited = updateMemory({ ownerUserId: ME }, home.id, { body: '我住在目黑', keywords: ['Meguro', '住址'] });
    assert.equal(doc('memory', home.id)!.snippet, '我住在目黑');
    const keys = doc('memory', home.id)!.keys.split('\n');
    assert.deepEqual(keys.slice(0, 2), ['Meguro', '住址']);
    assert.ok(keys.includes('城市') && keys.includes('city') && keys.filter((key) => key === '住址').length === 1, keys.join(','));
    assert.equal(ftsCount('公司'), 0);
    assert.deepEqual(refs(search('meguro')), [home.id]);
    updateMemory({ ownerUserId: ME }, home.id, { scope: { kind: 'workspace', workspaceId: 'ws-a' } });
    assert.equal(doc('memory', home.id)!.workspace_id, 'ws-a');

    // A correction: the old record's document stays, inactive; only the new one is found by default.
    const moved = supersedeMemory({ ownerUserId: ME }, edited.id, { body: '我已经搬到中野了', status: 'active', origin: 'explicit' });
    assert.equal(doc('memory', home.id)!.active, 0);
    assert.equal(doc('memory', moved.id)!.active, 1);
    assert.deepEqual(refs(search('目黑')), []);
    const history = search('目黑 中野', { includeInactive: true });
    assert.deepEqual(refs(history), [moved.id, home.id]);
    assert.deepEqual(history.map((hit) => hit.active), [true, false]);

    // Pending (from older versions) is not recallable until approved; reject and delete remove the document.
    const pending = memory('我的猫叫小白', { status: 'pending', origin: 'extracted' });
    assert.equal(doc('memory', pending.id)!.active, 0);
    assert.deepEqual(refs(search('小白')), []);
    approveMemory({ ownerUserId: ME }, pending.id);
    assert.deepEqual(refs(search('小白')), [pending.id]);
    const rejected = memory('我的狗叫大黄', { status: 'pending', origin: 'extracted' });
    rejectMemory({ ownerUserId: ME }, rejected.id);
    assert.equal(doc('memory', rejected.id), undefined);
    deleteMemory({ ownerUserId: ME }, moved.id);
    assert.equal(doc('memory', moved.id), undefined);
    assert.equal(doc('memory', home.id), undefined, 'the version it corrected goes with it');
    assert.equal(ftsCount('中野'), 0);
    assert.deepEqual(refs(search('目黑 中野', { includeInactive: true })), []);
    integrity();
  });

  test('a write whose transaction rolls back leaves no document', () => {
    assert.throws(() => memory('ghost', { supersedesId: 'mem-missing' }));
    assert.equal((getDb().prepare('SELECT count(*) AS n FROM memory_recall_docs').get() as { n: number }).n, 0);
    integrity();
  });
});

describe('recallSearch: Chinese, English and mixed text', () => {
  let movedId: string;
  let homeId: string;
  let pnpmId: string;
  let storageId: string;
  let storageTurn: string;
  let deployTurn: string;
  let tripTurn: string;

  beforeEach(() => {
    homeId = memory('我住在目黑区，离公司很近', { observedAt: NOW - 60 * DAY }).id;
    movedId = supersedeMemory({ ownerUserId: ME }, homeId, { body: '我已经搬到中野了，以后寄快递用新地址', status: 'active', origin: 'explicit', observedAt: NOW - 10 * DAY }).id;
    memory('以后回复都用中文', { kind: 'preference' });
    pnpmId = memory('我们用 pnpm 管理依赖，不用 npm', { scope: { kind: 'workspace', workspaceId: 'ws-a' }, kind: 'convention', origin: 'extracted' }).id;
    storageId = memory('存储选型定了：用图数据库 Neo4j（评审单 CR-12）', {
      scope: { kind: 'workspace', workspaceId: 'ws-a' }, kind: 'decision', keywords: ['storage choice', 'graph database'],
    }).id;
    node('n-storage', 'ws-a', '存储选型讨论');
    node('n-deploy', 'ws-a', 'Release process');
    node('n-trip', 'ws-b', '出差安排');
    node('n-current', 'ws-a', '晚饭');
    storageTurn = turn('n-storage', '我们讨论一下存储选型：图数据库还是关系型数据库？', '建议用图数据库，查询关系更方便。');
    deployTurn = turn('n-deploy', 'How do we deploy the release branch to us-east-1?', 'Run the deploy job from the release/2026.11 branch every Friday.');
    tripTurn = turn('n-trip', '下周三去大阪出差，住在梅田的酒店', '好的，我帮你查一下梅田附近的酒店。');
    turn('n-current', '中野附近有什么好吃的拉面', '中野站北口有几家不错的拉面店。');
  });

  test('two-character Chinese words match inside sentences', () => {
    assert.deepEqual(refs(search('中野', { excludeNodeId: 'n-current' })), [movedId]);
    assert.deepEqual(refs(search('中野区有什么好吃的', { excludeNodeId: 'n-current' })), [movedId]);
    assert.deepEqual(refs(search('我搬到哪了')), [movedId]);
    // The current conversation is left out; its memories are not.
    assert.ok(search('中野').some((hit) => hit.nodeId === 'n-current'));
  });

  test('words the segmenter splits into characters still match (存储选型, 图数据库, 目黑)', () => {
    const storage = search('上次的存储选型最后定了什么？');
    assert.deepEqual(refs(storage), [storageId, storageTurn]);
    assert.deepEqual(storage[0].matched, ['存储', '选型']);
    assert.deepEqual(refs(search('图数据库')), [storageId, storageTurn]);
    // The conversation holds both 关系型 and 数据库; the decision only 数据库 (of 图数据库).
    assert.deepEqual(refs(search('关系型数据库')), [storageTurn, storageId]);
    assert.deepEqual(refs(search('目黑', { includeInactive: true })), [homeId]);
  });

  test('identifiers, numbers and latin words', () => {
    assert.deepEqual(refs(search('CR-12')), [storageId]);
    assert.deepEqual(refs(search('cr12 是什么')), [storageId]);
    assert.deepEqual(refs(search('pnpm 怎么升级')), [pnpmId]);
    assert.deepEqual(refs(search('Which branch do we deploy from?')), [deployTurn]);
    assert.deepEqual(refs(search('us-east-1')), [deployTurn]);
    assert.deepEqual(refs(search('release/2026.11')), [deployTurn]);
  });

  test('mixed text and keywords in the other language', () => {
    assert.deepEqual(refs(search('Neo4j 的存储选型')), [storageId, storageTurn]);
    assert.deepEqual(refs(search('what was the graph database decision')), [storageId]);
  });

  test('Traditional and Japanese spellings find Simplified text', () => {
    assert.deepEqual(refs(search('目黒区', { includeInactive: true })), [homeId]);
    assert.deepEqual(refs(search('儲存選型')), [storageId, storageTurn]);
  });

  test('a hit carries what a pack line needs', () => {
    const [stored] = search('CR-12');
    assert.equal(stored.kind, 'memory');
    assert.equal(stored.workspaceId, 'ws-a');
    assert.equal(stored.snippet, '存储选型定了：用图数据库 Neo4j（评审单 CR-12）');
    assert.deepEqual(
      { kind: stored.memory?.kind, origin: stored.memory?.origin, status: stored.memory?.status, version: stored.memory?.version },
      { kind: 'decision', origin: 'explicit', status: 'active', version: 1 },
    );
    assert.ok(Number.isInteger(stored.memory?.rowId) && stored.memory!.rowId > 0);
    assert.deepEqual(stored.memory?.keywords, ['storage choice', 'graph database']);
    const [past] = search('关系型数据库');
    assert.equal(past.kind, 'turn');
    assert.equal(past.title, '存储选型讨论');
    assert.equal(past.nodeId, 'n-storage');
    assert.equal(past.turnId, storageTurn);
    assert.equal(past.snippet, '我们讨论一下存储选型：图数据库还是关系型数据库？\n→ 建议用图数据库，查询关系更方便。');
    assert.equal(past.memory, null);
  });

  test('scope: other workspaces only when asked, kinds, and time windows', () => {
    assert.deepEqual(refs(search('大阪出差')), []);
    assert.deepEqual(refs(search('大阪出差', { workspaceIds: 'all' })), [tripTurn]);
    assert.deepEqual(refs(search('梅田', { workspaceIds: ['ws-a', 'ws-b'] })), [tripTurn]);
    // The Michi assistant's shape: the user's own memories and conversations everywhere, not workspace memories.
    assert.deepEqual(refs(search('存储选型', { workspaceIds: 'all', memoryWorkspaceIds: [] })), [storageTurn]);
    assert.deepEqual(refs(search('存储选型', { kinds: ['turn'] })), [storageTurn]);
    assert.deepEqual(refs(search('存储选型', { kinds: ['memory'] })), [storageId]);
    assert.deepEqual(refs(search('中野', { includeUserScope: false, excludeNodeId: 'n-current' })), []);
    const at = doc('turn', storageTurn)!.at;
    assert.deepEqual(refs(search('存储选型', { kinds: ['turn'], after: at + 1 })), []);
    assert.deepEqual(refs(search('存储选型', { kinds: ['turn'], before: at + 1 })), [storageTurn]);
  });

  test('without a query (gate off) the newest documents come first', () => {
    assert.deepEqual(search('', {}), []);
    const newest = search('', { gate: false, kinds: ['turn'], limit: 2 });
    assert.equal(newest.length, 2);
    assert.ok(newest[0].at >= newest[1].at);
  });

  test('memory off: nothing is recalled and nothing new is indexed', () => {
    setMemorySettings(ME, { mode: 'off' });
    assert.deepEqual(search('中野'), []);
    assert.equal(indexTurn(finished('n-storage', '新的存储方案', '好的')), false);
    setMemorySettings(ME, { mode: 'auto' });
    assert.deepEqual(refs(search('中野', { excludeNodeId: 'n-current' })), [movedId]);
  });
});

describe('recallSearch: the relevance gate', () => {
  beforeEach(() => {
    node('n-weekly', 'ws-a', '周会');
    for (let i = 0; i < 30; i += 1) {
      turn('n-weekly', `项目进度第${i + 10}周：会议安排和代码评审`, `本周项目进度正常，会议照常，代码评审排在周${(i % 5) + 1}。`);
    }
    node('n-trip', 'ws-a', '出差');
    turn('n-trip', '下周三去大阪出差，住在梅田的酒店', '好的。');
  });

  test('only common words: nothing for automatic recall, results when the agent searches', () => {
    assert.deepEqual(search('项目进度和会议怎么安排？'), []);
    assert.equal(search('项目进度和会议怎么安排？', { gate: false }).length, 2);
    assert.equal(search('项目进度和会议怎么安排？', { gate: false, perConversation: 10 }).length, 10);
  });

  test('one rare word passes; small talk has no concepts at all', () => {
    assert.equal(search('梅田那家酒店叫什么？').length, 1);
    assert.deepEqual(search('你好，今天怎么样？', { gate: false }), []);
  });

  test('a question about the user\'s own work or home finds the memory of it by its category, in either language; others do not', () => {
    // The live run's job memory: the model's keywords name no company, 公司 or 工作 (imp-04/B); a move with no 城市 (upd-019).
    const job = memory('The user just started a new job at Lumenfield Robotics as a firmware engineer.', { origin: 'extracted',
      keywords: ['Lumenfield Robotics', 'firmware engineer', 'new job', '新工作', '固件工程师', '职业', 'career'] });
    const home = memory('用户上个月搬到了成都', { origin: 'extracted', keywords: ['成都', 'Chengdu', '搬家', 'moved'] });
    for (const question of ['Remind me, which company am I working at now?', '我现在在哪家公司上班？', 'Who do I work for these days?']) {
      assert.deepEqual(refs(search(question)), [job.id], question);
    }
    assert.deepEqual(refs(search('Which city do I live in now?')), [home.id], 'a turn that only says 住在 (a hotel) is no match for the category alone');
    // 住在 is the query's own word here: the trip turn that says it comes second.
    assert.deepEqual(refs(search('我现在住在哪个城市？'))[0], home.id);
    assert.deepEqual(search('How do I bake a sourdough loaf?'), []);
  });

  test('a memory passes with one specific word; a past conversation needs more', () => {
    node('n-tools', 'ws-a', 'tools');
    const installs = [turn('n-tools', 'pnpm 安装第一步', '完成'), turn('n-tools', 'pnpm 安装第二步', '完成')];
    const convention = memory('我们用 pnpm 管理依赖', { scope: { kind: 'workspace', workspaceId: 'ws-a' }, kind: 'convention', origin: 'extracted' });
    // pnpm is in 3 of 34 documents: not rare (at most 2), but within 5% (at least 3), which a memory needs.
    assert.deepEqual(refs(search('pnpm 有新版本吗')), [convention.id]);
    assert.deepEqual(refs(search('pnpm 有新版本吗', { gate: false })), [convention.id, ...installs.reverse()]);
  });
});

describe('recallSearch: what earns the gate in a small store (weak, everyday and content words)', () => {
  let years: string;
  let cafe: string;
  let water: string;
  beforeEach(() => {
    // Round-1 intrusion probe int-009: three turns, where every word is rare by count.
    node('n-catch-up', 'ws-a', 'Catching up');
    years = turn('n-catch-up', "Just realized I've been working as a nurse educator for 14 years now. Crazy how fast it went.",
      'Fourteen years is a long stretch, congrats on the milestone.');
    cafe = turn('n-catch-up', "Thanks! Celebrating this weekend at my friend Elena's café, it's called Marmalade Owl. Their cardamom buns are unreal.",
      'Sounds like a lovely way to mark it. Pick one highlight to share, and enjoy the buns!');
    node('n-kids', 'ws-a', 'Science for kids');
    water = turn('n-kids', 'Can you explain the water cycle to a kid?', "Sure! It's like a big adventure, one step at a time: the sun warms the water and it rises.");
  });

  test('conversational words cannot admit a document; a content word still does', () => {
    const question = "Quick one: what's the difference between RAM and storage on a laptop? I keep mixing them up like a bun and a bakery.";
    // quick, one, keep and like are in the café turn, one and like in the water one; bun is under four letters.
    assert.deepEqual(search(question), []);
    // A search the agent asks for is unchanged: any match counts.
    assert.deepEqual(refs(search(question, { gate: false })).sort(), [cafe, water].sort());
    assert.deepEqual(refs(search('What was the café with the cardamom buns called?')), [cafe]);
    assert.deepEqual(search('What did I like?'), []);
    assert.deepEqual(refs(search('the water cycle')), [water]);
    assert.deepEqual(refs(search('那个 Marmalade Owl 好吃吗')), [cafe]);
  });

  test('an everyday word alone is not rare beside other content; as all the query asks, two together, or with a rare word, it counts', () => {
    // friend and birthday are each in at most one document here, but common in any conversation (round-1 int-011: food).
    assert.deepEqual(search('Can you help me write a birthday message for a friend?'), []);
    assert.deepEqual(refs(search('Can you help me write a birthday message for a friend?', { gate: false })), [cafe]);
    assert.deepEqual(refs(search('anything about my friend?')), [cafe]);
    assert.deepEqual(refs(search('my friend and her café')), [cafe]);
    node('n-plans', 'ws-a', 'Plans');
    const dinner = turn('n-plans', 'We booked dinner in the city for Friday', 'Have a great time.');
    assert.deepEqual(refs(search('that dinner in the city')), [dinner]);
    // A memory still passes with one specific word, everyday or not.
    const friend = memory('The user\'s best friend is called Elena', { origin: 'extracted' });
    assert.deepEqual(refs(search('a gift for my friend')), [friend.id]);
  });

  test('cooked finds cooking, and noise-cancelling finds noise cancelling, with the gate on (crossconv xcv-0008)', () => {
    node('n-anc', 'ws-a', '降噪耳机原理');
    const how = turn('n-anc', '降噪耳机到底是怎么工作的啊？', '主要是主动降噪：耳机上的麦克风收集环境噪音，再生成相位相反的声波。');
    const dish = turn('n-anc', '对了我刚煮完 Golden Pumpkin Rumble 那道菜。那 transparency mode 又是怎么回事？', '通透模式就是反过来用外部麦克风。');
    // Extraction's keyphrases, as round 1 gave them.
    assert.equal(setTurnKeys(ME, how, ['降噪耳机', 'noise cancelling headphones', 'how it works']), true);
    assert.equal(setTurnKeys(ME, dish, ['通透模式', 'transparency mode', 'Golden Pumpkin Rumble', 'cooking']), true);
    const hits = search("Hey, the other day when we were talking about how noise-cancelling headphones work, I mentioned a dish I'd cooked. What was it called?");
    assert.deepEqual(refs(hits).sort(), [how, dish].sort());
    assert.deepEqual(hits.find((hit) => hit.refId === dish)!.matched, ['cook']);
    assert.deepEqual(hits.find((hit) => hit.refId === how)!.matched, ['nois', 'headphon']);
    assert.deepEqual(refs(search('noise-cancelling')), [how]);
    assert.deepEqual(refs(search('what have I been baking or cooking lately?')), [dish]);
  });
});

describe('recallSearch: what recall may read', () => {
  test('conversations Michi never indexes: self-turns, failed, system, maintenance, page, digest, Scheduled-only', () => {
    workspace('ws-system', { settings: { system: 'assistant' } });
    getDb().prepare(`INSERT INTO pages (id, owner_user_id, workspace_id, title, blocks, updated_at, created_at)
      VALUES ('page-1', ?, 'ws-a', 'Page', '[]', 1, 1)`).run(ME);
    node('n-chat', 'ws-a', 'chat');
    // A check-in's node: of the assistant's workspace only V is indexed (companionMemoryLearning.test.ts).
    node('n-cmph-system', 'ws-system', 'check-in');
    node('n-maintenance', 'ws-a', 'upkeep', { maintenance: 'job-1' });
    node('n-page', 'ws-a', 'page helper', { pageId: 'page-1' });
    node('n-digest', 'ws-a', 'digest', { kind: 'digest' });
    node('n-scheduled', 'ws-a', 'scheduled', { scheduledOnly: 'job-2' });
    const text = '梅田的酒店订好了';
    assert.equal(indexTurn(finished('n-chat', text, 'ok', { humanOrigin: false })), false);
    assert.equal(indexTurn(finished('n-chat', text, 'ok', { outcome: 'cancelled' })), false);
    assert.equal(indexTurn(finished('n-chat', text, 'ok', { outcome: 'error' })), false);
    assert.equal(indexTurn(finished('n-chat', text, 'ok', { persisted: false })), false);
    assert.equal(indexTurn(finished('n-chat', '   ', 'ok')), false);
    assert.equal(indexTurn(finished('n-missing', text, 'ok')), false);
    for (const nodeId of ['n-cmph-system', 'n-maintenance', 'n-page', 'n-digest', 'n-scheduled']) {
      assert.equal(indexTurn(finished(nodeId, text, 'ok')), false, nodeId);
    }
    assert.equal((getDb().prepare('SELECT count(*) AS n FROM memory_recall_docs').get() as { n: number }).n, 0);
    // A steer alone is still what a person typed.
    assert.equal(indexTurn(finished('n-chat', '', 'ok', { steers: [{ text }] })), true);
  });

  test('Trash and AI navigation off are skipped unless they are the current workspace; archived content is recallable', () => {
    workspace('ws-trash', { deletedAt: 1 });
    workspace('ws-private', { settings: { aiGlobalContext: false } });
    workspace('ws-archived', { archivedAt: 1 });
    node('n-trash-ws', 'ws-trash', 'a');
    node('n-private', 'ws-private', 'b');
    node('n-archived-ws', 'ws-archived', 'c');
    node('n-archived', 'ws-a', 'd', { status: 'archived' });
    node('n-archived-lane', 'ws-a', 'e', { deletedAt: 1, group: 'arch-1' });
    node('n-trashed', 'ws-a', 'f', { deletedAt: 1, group: 'del-1' });
    const ids = Object.fromEntries(['n-trash-ws', 'n-private', 'n-archived-ws', 'n-archived', 'n-archived-lane', 'n-trashed']
      .map((nodeId) => [nodeId, turn(nodeId, `梅田 ${nodeId}`, 'ok')]));
    const found = (extra: Partial<RecallSearchQuery>) => search('梅田', { gate: false, perConversation: 5, ...extra }).map((hit) => hit.nodeId).sort();
    assert.deepEqual(found({ workspaceIds: 'all', currentWorkspaceId: 'ws-a' }), ['n-archived', 'n-archived-lane', 'n-archived-ws']);
    assert.deepEqual(found({ workspaceIds: ['ws-trash', 'ws-private'], currentWorkspaceId: 'ws-a' }), []);
    assert.deepEqual(found({ workspaceIds: ['ws-private'], currentWorkspaceId: 'ws-private' }), ['n-private']);
    assert.deepEqual(found({ workspaceIds: 'all', currentWorkspaceId: 'ws-trash' }), ['n-archived', 'n-archived-lane', 'n-archived-ws', 'n-trash-ws']);
    // Memories in such a workspace follow the same rule.
    const secret = memory('梅田的会员卡号在抽屉里', { scope: { kind: 'workspace', workspaceId: 'ws-private' } });
    assert.ok(!refs(search('会员卡', { workspaceIds: 'all' })).includes(secret.id));
    assert.deepEqual(refs(search('会员卡', { workspaceIds: ['ws-private'], currentWorkspaceId: 'ws-private' })), [secret.id]);
    assert.ok(ids['n-trashed']);
  });

  test('a thread that moves, becomes Scheduled-only, or is purged or deleted', () => {
    node('n-1', 'ws-a', 'one');
    node('n-2', 'ws-a', 'two');
    node('n-3', 'ws-a', 'three');
    const first = turn('n-1', '梅田的酒店', 'ok');
    const second = turn('n-2', '梅田的酒店', 'ok');
    const third = turn('n-3', '梅田的酒店', 'ok');
    getDb().prepare("UPDATE nodes SET workspace_id = 'ws-b' WHERE id = 'n-1'").run();
    assert.deepEqual(refs(search('梅田', { gate: false })).sort(), [second, third].sort());
    assert.deepEqual(search('梅田', { gate: false, workspaceIds: ['ws-b'] }).map((hit) => [hit.refId, hit.workspaceId]), [[first, 'ws-b']]);
    getDb().prepare("UPDATE nodes SET scheduled_only_job_id = 'job-1' WHERE id = 'n-2'").run();
    assert.deepEqual(refs(search('梅田', { gate: false })), [third]);
    // Purged or deleted: the documents go with the conversation (0071's triggers).
    getDb().prepare('UPDATE nodes SET purged_at = 1 WHERE id = ?').run('n-3');
    assert.equal(doc('turn', third), undefined);
    getDb().prepare('DELETE FROM nodes WHERE id = ?').run('n-1');
    assert.equal(doc('turn', first), undefined);
    assert.ok(doc('turn', second));
    deleteWorkspace('ws-a');
    assert.equal(doc('turn', second), undefined);
    integrity();
  });

  test('owners are isolated in the cloud', () => {
    process.env.MICHI_CLOUD = '1';
    workspace('ws-alice', { owner: 'alice' });
    workspace('ws-bob', { owner: 'bob' });
    node('n-alice', 'ws-alice', 'alice');
    node('n-bob', 'ws-bob', 'bob');
    const aliceMemory = memory('我已经搬到中野了', {}, 'alice');
    const bobMemory = memory('我也住在中野', {}, 'bob');
    const aliceTurn = turn('n-alice', '中野的拉面店', 'ok', { ownerUserId: 'alice' });
    const bobTurn = turn('n-bob', '中野的咖啡店', 'ok', { ownerUserId: 'bob' });
    // A session whose user is not the workspace's owner indexes nothing.
    assert.equal(indexTurn(finished('n-bob', '中野的书店', 'ok', { ownerUserId: 'alice' })), false);
    assert.equal(doc('turn', aliceTurn)!.owner_user_id, 'alice');
    const as = (ownerUserId: string, extra: Partial<RecallSearchQuery>) => refs(recallSearch({
      ownerUserId, workspaceIds: 'all', includeUserScope: true, query: '中野', gate: false, ...extra,
    })).sort();
    assert.deepEqual(as('bob', {}), [bobMemory.id, bobTurn].sort());
    assert.deepEqual(as('bob', { workspaceIds: ['ws-alice'], currentWorkspaceId: 'ws-alice' }), [bobMemory.id]);
    assert.deepEqual(as('alice', {}), [aliceMemory.id, aliceTurn].sort());
    assert.deepEqual(as('mallory', {}), []);
  });

  test('on the desktop every conversation is the local user\'s, unless ownerFor keeps owners apart (eval harness)', () => {
    workspace('ws-eval-1', { owner: 'eval-1' });
    workspace('ws-eval-2', { owner: 'eval-2' });
    node('n-eval-1', 'ws-eval-1', 'one');
    node('n-eval-2', 'ws-eval-2', 'two');
    const desktop = turn('n-eval-1', '中野的拉面店', 'ok');
    assert.equal(doc('turn', desktop)!.owner_user_id, ME);
    const own = { ownerFor: (id: string | null) => id };
    const first = finished('n-eval-1', '中野的咖啡店', 'ok');
    const second = finished('n-eval-2', '中野的书店', 'ok');
    assert.equal(indexTurn(first, own), true);
    assert.equal(indexTurn(second, own), true);
    assert.equal(indexTurn(finished('n-eval-2', '中野的花店', 'ok'), { ownerFor: () => 'eval-1' }), false);
    const as = (ownerUserId: string) => refs(recallSearch({ ownerUserId, workspaceIds: 'all', includeUserScope: true, query: '中野', gate: false }));
    assert.deepEqual(as('eval-1'), [first.turnId]);
    assert.deepEqual(as('eval-2'), [second.turnId]);
  });
});

describe('turn documents', () => {
  test('snippet: the user words (steers too) and the reply, head and tail, sentinels removed', () => {
    node('n-1', 'ws-a', null);
    const long = `${'开头'.repeat(400)}中间${'结尾'.repeat(400)}`;
    const turnId = turn('n-1', '帮我看看这个方案', `${long}\n[TITLE: 方案评审]`, { steers: [{ text: '再加上预算' }] });
    const stored = doc('turn', turnId)!;
    const [user, reply] = stored.snippet.split('\n→ ');
    assert.equal(user, '帮我看看这个方案\n再加上预算');
    assert.equal([...reply].length, 1_200);
    assert.ok(reply.startsWith('开头开头') && reply.endsWith('结尾结尾') && reply.includes(' … '));
    assert.ok(!stored.snippet.includes('TITLE'));
  });

  test('the conversation title is searchable and follows renames on the next turn', () => {
    node('n-1', 'ws-a', null);
    const first = turn('n-1', '先看看这个', '好的');
    assert.equal(doc('turn', first)!.title, null);
    getDb().prepare("UPDATE nodes SET title = '梅田酒店预订' WHERE id = 'n-1'").run();
    const second = turn('n-1', '第二个问题', '好的');
    assert.equal(doc('turn', first)!.title, '梅田酒店预订');
    assert.deepEqual(refs(search('梅田酒店', { gate: false })).sort(), [first, second].sort());
  });

  test('setTurnKeys adds keyphrases to a turn document and indexes them', () => {
    node('n-1', 'ws-a', 'x');
    const turnId = turn('n-1', '我下个月搬到中野', '好的');
    assert.deepEqual(search('relocation Nakano'), []);
    assert.equal(setTurnKeys(ME, turnId, [' moving   house ', 'Nakano', 'nakano', '', 'x'.repeat(200)]), true);
    assert.equal(doc('turn', turnId)!.keys, 'moving house\nNakano');
    assert.deepEqual(refs(search('Nakano moving')), [turnId]);
    assert.equal(setTurnKeys('someone-else', turnId, ['Nakano']), false);
    assert.equal(setTurnKeys(ME, 'turn-missing', ['Nakano']), false);
    // Indexing the turn again keeps them.
    indexTurn(finished('n-1', '我下个月搬到中野', '好的，记住了', { turnId }));
    assert.equal(doc('turn', turnId)!.keys, 'moving house\nNakano');
    integrity();
  });

  test('ChatHub.onTurnFinalized indexes a completed human turn, not a cancelled one', async () => {
    node('chat', 'ws-a', '晚饭');
    const hub = new ChatHub({ retentionMs: 50, pageManifestBuilder: () => '', titleGenerator: null, memoryInjector: null });
    hub.onTurnFinalized(indexTurn);
    let stop = false;
    const session = {
      id: 'chat', owner: { mode: 'interactive', key: 'chat' }, runtimeId: 'fake', getHistory: () => [], getPendingAssistant: () => undefined,
      cancel: () => {}, steer: async () => ({ accepted: false }),
      send: () => (async function* (): AsyncIterableIterator<NormalizedEvent> {
        yield { kind: 'chunk', text: '中野站北口有几家拉面店。' };
        yield { kind: 'turn_end', stopReason: stop ? 'cancelled' : 'end_turn' };
      })(),
    } as unknown as AgentSession;
    const done = await hub.startTurn({ chatId: 'chat', nodeId: 'chat', text: '中野附近有什么好吃的拉面', session, humanOrigin: true });
    await done.done;
    const [hit] = search('中野拉面', { gate: false });
    assert.equal(hit?.turnId, done.turnId);
    assert.equal(hit.snippet, '中野附近有什么好吃的拉面\n→ 中野站北口有几家拉面店。');
    stop = true;
    const cancelled = await hub.startTurn({ chatId: 'chat', nodeId: 'chat', text: '梅田的酒店', session, humanOrigin: true });
    await cancelled.done;
    assert.equal(doc('turn', cancelled.turnId), undefined);
  });
});

describe('migration 0073_memory_recall_forget', () => {
  test('adds hidden and content without rebuilding the table, and a content index that follows deletions', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-recall-0073-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(__dirname, '../src/db/migrations');
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE nodes (id TEXT PRIMARY KEY, workspace_id TEXT, purged_at INTEGER)');
    for (const file of ['0059_memories.sql', '0071_memory_v3.sql']) fs.copyFileSync(path.join(source, file), path.join(dir, file));
    runMigrations(db, dir);
    db.prepare(`INSERT INTO memory_recall_docs (id, owner_user_id, workspace_id, doc_kind, ref_id, node_id, at, snippet)
      VALUES (7, 'alice', 'ws-1', 'turn', 'turn-old', 'n-1', 1, 'from before')`).run();
    const createSql = () => (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_recall_docs'").get() as { sql: string }).sql;
    const before = createSql();

    fs.copyFileSync(path.join(source, '0073_memory_recall_forget.sql'), path.join(dir, '0073_memory_recall_forget.sql'));
    runMigrations(db, dir);
    assert.deepEqual({ ...db.prepare("SELECT hidden, content, snippet FROM memory_recall_docs WHERE id = 7").get() },
      { hidden: 0, content: null, snippet: 'from before' });
    assert.equal(createSql().replace(', hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)), content TEXT', ''), before,
      'additive: the two columns only');
    assert.throws(() => db.prepare('UPDATE memory_recall_docs SET hidden = 2 WHERE id = 7').run(), /CHECK constraint/);
    const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_recall_full_fts'").get() as { sql: string };
    for (const option of [/content=''/, /contentless_delete=1/, /detail=none/, /unicode61 remove_diacritics 2/]) assert.match(fts.sql, option);
    db.prepare("INSERT INTO memory_recall_full_fts (rowid, terms) VALUES (7, 'plesiosaur fossil')").run();
    db.prepare('DELETE FROM memory_recall_docs WHERE id = 7').run();
    assert.equal((db.prepare(`SELECT count(*) AS n FROM memory_recall_full_fts WHERE memory_recall_full_fts MATCH '"plesiosaur"'`).get() as { n: number }).n, 0);
    runMigrations(db, dir);
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version = '0073_memory_recall_forget'").get());
  });
});

describe('forgetting: a forgotten memory goes, chat history stays; Don\'t recall hides an excerpt', () => {
  test('forgetMemory: every version and its document go, with a tombstone each; the turns stay as chat history', (t) => {
    t.after(installMemoryExtractionHooks());
    node('n-laptop', 'ws-a', '笔记本型号');
    node('n-other', 'ws-a', '同事的电脑');
    const source = turn('n-laptop', '我这台笔记本是联想小新Pro14，最近老是卡，存一下到记忆里吧', '好，记下了：联想小新Pro14。');
    const repeat = turn('n-laptop', '行，我回头清一下后台。', '好的，小新Pro14 清完后台还卡的话再跟我说。');
    const elsewhere = turn('n-other', '同事也买了小新Pro14', '挺好的机器。');
    const first = memory('我的笔记本是联想小新Pro14', { source: { nodeId: 'n-laptop', turnId: source }, keywords: ['小新Pro14', 'Lenovo laptop'] });
    const second = supersedeMemory({ ownerUserId: ME }, first.id, {
      body: '我的笔记本是联想小新Pro14，16G 内存', status: 'active', origin: 'explicit', source: { nodeId: 'n-laptop', turnId: source },
    });
    const removed = forgetMemory({ ownerUserId: ME }, second.id);
    assert.deepEqual(removed.removed.map((record) => record.id), [second.id, first.id]);
    assert.equal(doc('memory', first.id), undefined);
    assert.equal(doc('memory', second.id), undefined);
    // includeInactive brings back no version; the conversations are chat history, as in ChatGPT and Claude.
    const found = search('小新Pro14', { gate: false, includeInactive: true, perConversation: 5 });
    assert.equal(found.some((hit) => hit.kind === 'memory'), false);
    assert.deepEqual(refs(found).sort(), [source, repeat, elsewhere].sort());
    for (const turnId of [source, repeat, elsewhere]) assert.equal(doc('turn', turnId)!.hidden, 0, turnId);
    const tombstones = (getDb().prepare('SELECT source_turn_id AS turn FROM memory_extraction_tombstones WHERE owner_user_id = ?')
      .all(ME) as Array<{ turn: string }>).map((row) => row.turn);
    assert.deepEqual(tombstones, [source, source], 'one per version: extraction never saves it again from that turn');
    integrity();
  });

  test('deleteMemory (Settings\' older path) hides nothing either', () => {
    node('n-1', 'ws-a', 'x');
    const turnId = turn('n-1', '我最喜欢的一家是望江楼小馆', '酸菜鱼很有名。');
    deleteMemory({ ownerUserId: ME }, memory('望江楼小馆的酸菜鱼', { source: { nodeId: 'n-1', turnId } }).id);
    assert.equal(doc('turn', turnId)!.hidden, 0);
    integrity();
  });

  test('forgetConversationTurn hides one excerpt a scope may read', () => {
    node('n-1', 'ws-a', 'x');
    workspace('ws-private', { settings: { aiGlobalContext: false } });
    node('n-private', 'ws-private', 'y');
    const turnId = turn('n-1', '我的储物柜号码是 318', '好的。');
    const privateTurn = turn('n-private', '储物柜 318 在三楼', '好的。');
    assert.equal(forgetConversationTurn(lookup(doc('turn', privateTurn)!.id)), false, 'AI navigation off');
    assert.equal(forgetConversationTurn(lookup(doc('turn', turnId)!.id)), true);
    assert.equal(forgetConversationTurn(lookup(doc('turn', turnId)!.id)), true, 'already hidden: still forgotten');
    assert.equal(forgetConversationTurn({ ...lookup(doc('turn', turnId)!.id), ownerUserId: 'someone-else' }), false);
    assert.equal(forgetConversationTurn(lookup(9_999)), false);
    assert.deepEqual(search('储物柜', { gate: false }), []);
    assert.equal(doc('turn', privateTurn)!.hidden, 0);
  });

  test('Don\'t recall bars extraction from the excerpt\'s turn; a forgotten memory bars its own turn', (t) => {
    t.after(installMemoryExtractionHooks());
    node('n-code', 'ws-a', '副业');
    const codenameTurn = turn('n-code', '我周末在搞个副业项目，代号叫栖霞', '好名字。');
    const codename = memory('用户的副业项目代号是栖霞', { origin: 'extracted', source: { nodeId: 'n-code', turnId: codenameTurn } });
    const excerpt = turn('n-code', '栖霞就是个记账小工具，慢慢做', '实用。');
    forgetMemory({ ownerUserId: ME }, codename.id);
    assert.equal(forgetConversationTurn(lookup(doc('turn', excerpt)!.id)), true);
    const tombstones = (getDb().prepare('SELECT source_turn_id AS turn FROM memory_extraction_tombstones WHERE owner_user_id = ?')
      .all(ME) as Array<{ turn: string }>).map((row) => row.turn);
    assert.deepEqual(tombstones.sort(), [codenameTurn, excerpt].sort());
    const committed = commitExtractionPayload({
      memories: [
        { op: 'add', kind: 'fact', about: 'user', body: '用户的副业项目代号是栖霞', keywords: ['栖霞'], quote: '代号叫栖霞', source_turn: codenameTurn },
        { op: 'add', kind: 'fact', about: 'user', body: '用户的副业项目是记账小工具', keywords: ['记账'], quote: '记账小工具', source_turn: excerpt },
      ],
      turn_keys: [],
      exclude_turns: [],
      forget: [],
    }, { ownerUserId: ME, workspaceId: 'ws-a', turns: [
      { turnId: codenameTurn, nodeId: 'n-code', userText: '我周末在搞个副业项目，代号叫栖霞', userAt: NOW },
      { turnId: excerpt, nodeId: 'n-code', userText: '栖霞就是个记账小工具，慢慢做', userAt: NOW },
    ] });
    assert.deepEqual(committed.dropped.map((drop) => drop.reason), ['tombstoned', 'tombstoned']);
    // Indexing a hidden turn again, or adding its keyphrases, changes nothing.
    assert.equal(indexTurn(finished('n-code', '栖霞就是个记账小工具，慢慢做', '实用。', { turnId: excerpt })), false);
    assert.equal(doc('turn', excerpt)!.hidden, 1);
    assert.equal(setTurnKeys(ME, excerpt, ['栖霞']), false);
  });
});

describe('a turn is indexed as it was said', () => {
  let said = 0;
  /** A completed turn as ChatHub leaves it (its messages and turn row), then indexed as at its end. */
  function spoken(nodeId: string, userText: string, reply: string): string {
    said += 1;
    const turnId = `dt-${said}`;
    const at = NOW - 10 * DAY + said * 60_000;
    const insert = getDb().prepare('INSERT INTO messages (id, node_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(`u-${turnId}`, nodeId, 'user', userText, said * 10, at);
    insert.run(`a-${nodeId}-${turnId}`, nodeId, 'assistant', reply, said * 10 + 5, at + 2);
    getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, started_at, completed_at, updated_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`).run(turnId, nodeId, `u-${turnId}`, `a-${nodeId}-${turnId}`, at, at + 3, at + 3);
    indexTurn({ ownerUserId: null, nodeId, turnId, humanOrigin: true, userText, assistantText: reply, outcome: 'completed', persisted: true,
      completedAt: at + 3, userMessageAt: at });
    return turnId;
  }

  test('what the user asked not to remember is the extractor\'s to honor: the index reads no declines and masks no names', () => {
    node('n-1', 'ws-a', '临时分支 hotfix-wenhe-1203');
    const declined = spoken('n-1', '我建了个临时分支叫 hotfix-wenhe-1203，这个不用记，就用一次。合并前要先 rebase 吗？', '好，不记。看团队习惯。');
    assert.match(doc('turn', declined)!.snippet, /hotfix-wenhe-1203.*→ 好，不记。看团队习惯。/su);
    assert.equal(doc('turn', declined)!.title, '临时分支 hotfix-wenhe-1203', 'the title as the app shows it');
    assert.equal(setTurnKeys(ME, declined, ['hotfix-wenhe-1203', 'rebase']), true);
  });

  test('extraction reads what the user typed as written, and never a turn recall hid or a removal names', (t) => {
    t.after(installMemoryExtractionHooks());
    node('n-4', 'ws-a', 'x');
    const read = (turnId: string) => readExtractionTurn({ turnId, nodeId: 'n-4', userMessageId: `u-${turnId}`,
      assistantMessageId: `a-n-4-${turnId}`, completedAt: NOW }, ME);
    const declined = spoken('n-4', '我建了个临时分支叫 hotfix-wenhe-1203，这个不用记。合并前要先 rebase 吗？', '看团队习惯。');
    assert.equal(read(declined)!.userText, '我建了个临时分支叫 hotfix-wenhe-1203，这个不用记。合并前要先 rebase 吗？');
    const pointed = spoken('n-4', '我的工位在 7 楼西侧', '好的。');
    assert.equal(forgetConversationTurn(lookup(doc('turn', pointed)!.id)), true);
    assert.equal(read(pointed), null, 'recall hid it');
    // A turn the user asked to forget (memory_delete with its c: ref) stays chat history, and extraction never reads it, nor
    // the reply to it as the message the next turn answered.
    const forgotten = spoken('n-4', '我下周四去 Zephyr Labs 面试。', '祝你面试顺利！');
    assert.equal(keepConversationTurnOutOfMemory(lookup(doc('turn', forgotten)!.id)), forgotten, 'it names the turn it keeps out');
    assert.equal(doc('turn', forgotten)!.hidden, 0, 'recall still shows it');
    assert.equal(read(forgotten), null);
    const answered = spoken('n-4', '谢谢，我会准备好的。', '加油。');
    assert.equal(read(answered)!.previousAssistantText, null);
    // Nor a turn a removed memory came from.
    const source = spoken('n-4', '我的车是蓝色的', '好的。');
    forgetMemory({ ownerUserId: ME }, memory('用户的车是蓝色的', { origin: 'extracted', source: { nodeId: 'n-4', turnId: source } }).id);
    assert.equal(read(source), null);
    assert.equal(keepConversationTurnOutOfMemory(lookup(999_999)), null, 'no such turn');
  });
});

describe('search results: a soft cap per conversation', () => {
  test('a third turn of the conversation that holds the answer replaces weak matches elsewhere', () => {
    node('n-sneakers', 'ws-a', '鞋');
    const sneakers = ['我新买的球鞋是白色的', '球鞋要不要放鞋盒里', '球鞋我一般放床底下'].map((text) => turn('n-sneakers', text, '好的。'));
    // Weak matches: a word many documents hold.
    const weak: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      node(`n-sport-${i}`, 'ws-a', `聊天 ${i}`);
      weak.push(turn(`n-sport-${i}`, '周末去运动一下', '好的。'), turn(`n-sport-${i}`, '运动完喝点水', '好的。'));
    }
    const hits = search('球鞋 运动', { gate: false, limit: 3, perConversation: 2 });
    assert.deepEqual(refs(hits).sort(), [...sneakers].sort(), 'the cap gives way to a much better match');
    node('n-other', 'ws-a', '洗鞋');
    const other = turn('n-other', '球鞋怎么洗', '好的。');
    const close = search('球鞋 运动', { gate: false, limit: 3, perConversation: 2 });
    assert.ok(refs(close).includes(other), 'a match about as good elsewhere keeps its place');
    assert.equal(refs(close).filter((ref) => sneakers.includes(ref)).length, 2);
  });
});

describe('whole turns: memory_search reads all of a turn, automatic recall what its snippet shows', () => {
  test('a word deep in a long reply: found with the gate off, not by automatic recall; excerpts are windows around it', () => {
    node('n-1', 'ws-a', '博物馆');
    const reply = `${'开头的介绍。'.repeat(150)}其中最有名的是 Plesiosaur 化石。${'结尾的总结。'.repeat(150)}`;
    const turnId = turn('n-1', '博物馆里有哪些恐龙化石？', reply);
    const stored = doc('turn', turnId)!;
    assert.equal(stored.snippet.includes('Plesiosaur'), false);
    assert.equal(stored.content, `博物馆里有哪些恐龙化石？\n→ ${reply}`);
    assert.equal(ftsCount('plesiosaur'), 0);
    assert.equal(ftsCount('plesiosaur', 'memory_recall_full_fts'), 1);

    assert.deepEqual(search('plesiosaur'), [], 'automatic recall matches what its snippet shows');
    assert.deepEqual(refs(search('plesiosaur', { match: 'full' })), [turnId]);
    const [hit] = search('Plesiosaurs', { gate: false });
    assert.equal(hit?.turnId, turnId);
    assert.equal(hit.content, stored.content);
    const shown = turnExcerpt(hit, { user: 300, reply: 120 });
    assert.equal(shown.user, '博物馆里有哪些恐龙化石？');
    assert.match(shown.reply, /^….*Plesiosaur.*…$/u);
    assert.ok([...shown.reply].length <= 122, shown.reply);
    assert.match(turnExcerpt({ ...hit, matched: [] }, { user: 300, reply: 120 }).reply, /^开头的介绍/u, 'no match: its start');
    // Each side keeps at most 16k characters in content; the snippet stays short.
    const huge = turn('n-1', 'x'.repeat(40_000), 'y'.repeat(40_000));
    const big = doc('turn', huge)!;
    assert.ok([...big.snippet].length <= 2 * 1_200 + 3);
    const [user, answer] = big.content!.split('\n→ ');
    assert.deepEqual([[...user].length, [...answer].length], [16_000, 16_000]);
    integrity();
  });

  test('turnExcerpt: a window starts at a word, spends its budget, and costs characters as told', () => {
    const text = `${'alpha beta gamma delta '.repeat(20)}the plesiosaur skeleton is in hall three ${'epsilon zeta eta theta '.repeat(20)}`;
    const shown = turnExcerpt({ snippet: `question\n→ ${text}`, content: null, matched: ['plesiosaur'] }, { user: 50, reply: 60 });
    assert.match(shown.reply, /^…(?:alpha|beta|gamma|delta|the) /u);
    assert.match(shown.reply, /plesiosaur/u);
    const tokens = (char: string) => (/[一-鿿]/u.test(char) ? 1 : 0.25);
    const cjk = turnExcerpt({ snippet: `${'问'.repeat(50)}中野${'答'.repeat(50)}`, content: null, matched: ['中野'] }, { user: 20, reply: 20 }, tokens);
    assert.match(cjk.user, /中野/u);
    assert.ok([...cjk.user].length <= 42, cjk.user);
  });
});

describe('recallTurn: a ref lookup', () => {
  test('the whole turn and the turns around it in its conversation, hidden ones skipped', () => {
    node('n-1', 'ws-a', '行程');
    node('n-2', 'ws-a', '别的');
    const first = turn('n-1', '第一天去哪？', '先去浅草寺。');
    const second = turn('n-1', '第二天呢？', `${'上午'.repeat(1_000)}MIDDLE-MARKER${'下午'.repeat(1_000)}`);
    const third = turn('n-1', '第三天呢？', '去镰仓。');
    const fourth = turn('n-1', '第四天呢？', '回东京购物。');
    turn('n-2', '别的对话', '好的。');
    const id = (turnId: string) => doc('turn', turnId)!.id;

    const view = recallTurn(lookup(id(second)))!;
    assert.equal(view.hit.turnId, second);
    assert.match(view.text, /MIDDLE-MARKER/, 'the middle a snippet leaves out');
    assert.deepEqual([view.previous?.docId, view.next?.docId], [id(first), id(third)]);
    assert.equal(view.previous?.text, '第一天去哪？ → 先去浅草寺。');
    assert.equal(recallTurn(lookup(id(first)))!.previous, null);
    assert.equal(recallTurn(lookup(id(fourth)))!.next, null);

    assert.equal(forgetConversationTurn(lookup(id(third))), true);
    assert.equal(recallTurn(lookup(id(second)))!.next?.docId, id(fourth));
    assert.equal(recallTurn(lookup(id(third))), null);

    const long = turn('n-1', '第五天呢？', '很长的回答。'.repeat(2_000));
    const longView = recallTurn(lookup(id(long)))!;
    assert.ok([...longView.text].length <= 6_000 + 10, `${[...longView.text].length}`);
    assert.match(longView.text, /^第五天呢？\n→ 很长的回答/u);
    assert.ok([...(recallTurn(lookup(id(second)))!.previous!.text)].length <= 201);
  });
});

describe('startRecallBackfill', () => {
  let seq = 0;
  function storedTurn(nodeId: string, userText: string, reply: string, opts: { assistantId?: string; status?: string; metadata?: Record<string, unknown>; steers?: string[] } = {}): string {
    const turnId = `bt-${++seq}`;
    const at = NOW - 20 * DAY + seq * 60_000;
    const insert = getDb().prepare('INSERT INTO messages (id, node_id, role, content, seq, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run(`u-${turnId}`, nodeId, 'user', userText, seq * 10, at, opts.metadata ? JSON.stringify(opts.metadata) : null);
    (opts.steers ?? []).forEach((steer, index) => insert.run(`s-${turnId}-${index}`, nodeId, 'user', steer, seq * 10 + 1 + index, at + 1, '{"steered":true}'));
    const assistantId = opts.assistantId ?? `a-${nodeId}-${turnId}`;
    insert.run(assistantId, nodeId, 'assistant', reply, seq * 10 + 5, at + 2, null);
    getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, started_at, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(turnId, nodeId, `u-${turnId}`, assistantId, opts.status ?? 'completed', at, at + 3, at + 3);
    return turnId;
  }

  test('indexes existing memories and completed human turns once, in slices, then never again', async () => {
    workspace('ws-system', { settings: { system: 'assistant' } });
    node('n-1', 'ws-a', '出差');
    node('n-cmph-system', 'ws-system', 'check-in');
    node('n-upkeep', 'ws-a', 'upkeep', { maintenance: 'job-1' });
    const human = [
      storedTurn('n-1', '下周三去大阪出差', '好的', { steers: ['住在梅田'] }),
      storedTurn('n-1', '酒店订在梅田站附近', '已记下'),
      storedTurn('n-1', '大阪回程是周五晚上', '好的'),
    ];
    storedTurn('n-1', '大阪的天气', '晴', { assistantId: 'self-n-1-x' });
    storedTurn('n-1', '大阪定时汇总', '好的', { metadata: { scheduledJobId: 'job-9' } });
    storedTurn('n-1', '大阪取消了', '…', { status: 'cancelled' });
    storedTurn('n-cmph-system', '大阪是哪', '日本');
    storedTurn('n-upkeep', '大阪页面', 'ok');
    const before = memory('我住在中野');
    getDb().exec('DELETE FROM memory_recall_docs');
    assert.deepEqual(search('中野'), []);

    const first = startRecallBackfill({ batchSize: 2, sliceMs: 1, pauseMs: 0 });
    assert.equal(startRecallBackfill(), first, 'one run at a time');
    assert.deepEqual(await first, { memories: 1, turns: 3, done: true });
    assert.deepEqual(refs(search('中野')), [before.id]);
    assert.deepEqual(refs(search('大阪 梅田', { gate: false, perConversation: 5 })).sort(), [...human].sort());
    assert.equal(doc('turn', human[0])!.snippet, '下周三去大阪出差\n住在梅田\n→ 好的');
    assert.equal(doc('turn', human[0])!.title, '出差');
    assert.equal((getDb().prepare("SELECT value FROM meta WHERE key = 'memory_recall_backfill_v5'").get() as { value: string }).value, 'done');
    storedTurn('n-1', '新的大阪行程', '好的');
    assert.deepEqual(await startRecallBackfill(), { memories: 0, turns: 0, done: true });
    integrity();
  });

  test('resumes from its cursor and skips owners whose memory is off', async () => {
    node('n-1', 'ws-a', 'x');
    storedTurn('n-1', '大阪一', 'ok');
    const rowId = (getDb().prepare('SELECT max(rowid) AS n FROM turns').get() as { n: number }).n;
    const later = storedTurn('n-1', '大阪二', 'ok');
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('memory_recall_backfill_v5', ?)").run(`turns:${rowId}`);
    assert.deepEqual(await startRecallBackfill({ pauseMs: 0 }), { memories: 0, turns: 1, done: true });
    assert.deepEqual(refs(search('大阪', { gate: false })), [later]);

    getDb().prepare("DELETE FROM meta WHERE key = 'memory_recall_backfill_v5'").run();
    getDb().exec('DELETE FROM memory_recall_docs');
    setMemorySettings(ME, { mode: 'off' });
    assert.deepEqual(await startRecallBackfill({ pauseMs: 0 }), { memories: 0, turns: 0, done: true });
  });

  test('v5 indexes every memory again with the words of the profile categories it states', async () => {
    const job = memory('用户在青禾数据做数据分析师', { origin: 'extracted', keywords: ['青禾数据', 'Qinghe Data', '数据分析师'] });
    assert.match(doc('memory', job.id)!.keys, /公司/, 'a new write carries them at once');
    // As an index before v5 left it: the keywords alone.
    const keys = (job.keywords ?? []).join('\n');
    getDb().prepare("UPDATE memory_recall_docs SET keys = ? WHERE doc_kind = 'memory' AND ref_id = ?").run(keys, job.id);
    getDb().prepare('DELETE FROM memory_recall_fts WHERE rowid = ?').run(doc('memory', job.id)!.id);
    getDb().prepare('INSERT INTO memory_recall_fts (rowid, terms) VALUES (?, ?)').run(doc('memory', job.id)!.id, segmentTerms(`${job.body}\n${keys}`).join(' '));
    getDb().prepare("DELETE FROM meta WHERE key = 'memory_recall_backfill_v5'").run();
    assert.deepEqual(search('Where do I work now?'), []);
    assert.deepEqual(await startRecallBackfill({ pauseMs: 0 }), { memories: 1, turns: 0, done: true });
    assert.deepEqual(refs(search('Where do I work now?')), [job.id]);
    integrity();
  });

  test('a new index version indexes every turn again, with its content; hidden documents stay hidden', async () => {
    node('n-1', 'ws-a', 'x');
    const declined = storedTurn('n-1',
      "I made a throwaway branch called quokka-hotfix-77. No need to remember that name. How do I delete a local branch?",
      "Understood, I won't keep quokka-hotfix-77.");
    const long = storedTurn('n-1', '博物馆里有什么？', `${'介绍'.repeat(2_000)}Plesiosaur${'总结'.repeat(2_000)}`);
    const gone = storedTurn('n-1', '储物柜号码是 318', '好的');
    // As the first backfill left them: everything indexed, nothing hidden, no content.
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('memory_recall_backfill_v1', 'done')").run();
    assert.deepEqual(await startRecallBackfill({ pauseMs: 0 }), { memories: 0, turns: 3, done: true });
    assert.match(doc('turn', declined)!.snippet, /quokka-hotfix-77/u, 'the index reads no declines: the extractor honors them');
    assert.match(doc('turn', long)!.content!, /Plesiosaur/);
    assert.deepEqual(refs(search('plesiosaur', { gate: false })), [long]);

    assert.equal(forgetConversationTurn(lookup(doc('turn', gone)!.id)), true);
    getDb().prepare("DELETE FROM meta WHERE key = 'memory_recall_backfill_v5'").run();
    assert.deepEqual(await startRecallBackfill({ pauseMs: 0 }), { memories: 0, turns: 2, done: true });
    assert.equal(doc('turn', gone)!.hidden, 1);
    assert.deepEqual(search('储物柜', { gate: false }), []);
    integrity();
  });

  test('v3 writes every document\'s terms again, with folded word endings', async () => {
    node('n-1', 'ws-a', 'x');
    const cooking = storedTurn('n-1', 'I was cooking a pumpkin stew', 'Sounds cozy.');
    const baking = memory('The user bakes sourdough on Sundays');
    await startRecallBackfill({ pauseMs: 0 });
    // As an index before v3 left them: the words with their endings.
    for (const [id, terms] of [[doc('turn', cooking)!.id, 'cooking pumpkin stew sounds cozy'], [doc('memory', baking.id)!.id, 'user bakes sourdough sundays']] as const) {
      getDb().prepare('DELETE FROM memory_recall_fts WHERE rowid = ?').run(id);
      getDb().prepare('INSERT INTO memory_recall_fts (rowid, terms) VALUES (?, ?)').run(id, terms);
    }
    getDb().prepare("UPDATE meta SET value = 'done' WHERE key = 'memory_recall_backfill_v2'").run();
    getDb().prepare("DELETE FROM meta WHERE key = 'memory_recall_backfill_v5'").run();
    assert.deepEqual(search('cooked', { gate: false }), []);
    assert.deepEqual(search('baked', { gate: false }), []);

    assert.deepEqual(await startRecallBackfill({ pauseMs: 0 }), { memories: 1, turns: 1, done: true });
    assert.deepEqual(refs(search('cooked', { gate: false })), [cooking]);
    assert.deepEqual(refs(search('baked', { gate: false })), [baking.id]);
    integrity();
  });

  test('stops when the database closes, and resumes at the next start', async () => {
    node('n-1', 'ws-a', 'x');
    for (let i = 0; i < 5; i += 1) storedTurn('n-1', `大阪第${i + 1}天`, 'ok');
    const run = startRecallBackfill({ batchSize: 1, sliceMs: 1, pauseMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    closeDb();
    const stopped = await run;
    assert.equal(stopped.done, false);
    initDb();
    const resumed = await startRecallBackfill({ pauseMs: 0 });
    assert.equal(stopped.turns + resumed.turns, 5);
    assert.equal(resumed.done, true);
  });
});

describe('performance', () => {
  // Other processes only ever add time to a run, so the fastest of several warm runs is the search's own cost, as
  // Python's timeit reports it. The median failed busy full-suite runs (51-62 ms) that this file alone passes.
  test('10,000 documents: a search takes under 50 ms', (t) => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const chars = [...'的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处府色服清己书客照失话考影响音乐感房朋友办街站车票饭店菜鸡鱼肉茶咖啡猫狗花草树木雨雪风云海河湖桥楼门窗桌椅床灯笔纸药医院学校司板同事女儿妈爸旅周末早晚'];
    const words: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const length = random() < 0.7 ? 2 : random() < 0.8 ? 3 : 4;
      words.push(Array.from({ length }, () => chars[Math.floor(random() * chars.length)]).join(''));
    }
    const english = 'deploy memory server client database query index cache branch release build test error feature config token model agent runtime session window thread message search vector graph storage choice decision review commit merge docker cluster worker queue stream socket port latency budget meeting travel coffee'.split(' ');
    for (let i = 0; i < 2_000; i += 1) words.push(`${english[i % english.length]}${i >= english.length ? i : ''}`);
    // Word frequencies follow Zipf's law (the k-th commonest word about 1/k as often), as natural text does.
    const pick = () => words[Math.floor(Math.pow(words.length, random())) - 1];
    const sentence = (n: number) => Array.from({ length: n }, () => {
      const word = pick();
      return /[a-z]/.test(word) ? ` ${word} ` : word;
    }).join('').replace(/(.{18})/gu, '$1，');
    const insertNode = getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, title, created_at) VALUES (?, 'ws-a', 'chat', ?, 1)");
    for (let n = 0; n < 400; n += 1) insertNode.run(`p-${n}`, `对话${sentence(3)}`);
    const started = Date.now();
    getDb().exec('BEGIN');
    for (let i = 0; i < 10_000; i += 1) {
      const at = NOW - (10_000 - i) * 60_000;
      if (!indexTurn({ ownerUserId: null, nodeId: `p-${i % 400}`, turnId: `p-turn-${i}`, humanOrigin: true, outcome: 'completed',
        persisted: true, userText: sentence(10 + Math.floor(random() * 40)), assistantText: sentence(30 + Math.floor(random() * 120)),
        userMessageAt: at, completedAt: at })) throw new Error(`not indexed: ${i}`);
    }
    getDb().exec('COMMIT');
    t.diagnostic(`indexed 10,000 turns in ${Date.now() - started} ms`);
    for (let i = 0; i < 200; i += 1) memory(sentence(8), { origin: i % 2 ? 'extracted' : 'explicit' });
    const queries = [
      sentence(6), sentence(20), sentence(60), `${words[3]} memory search 的 ${words[100]}`,
      'deploy the release branch to the cluster', '我住在目黑区，离公司很近', 'CR-12',
    ];
    for (const query of queries) {
      for (const gate of [true, false]) {
        search(query, { gate, excludeNodeId: 'p-1' });
        const times: number[] = [];
        for (let run = 0; run < 5; run += 1) {
          const begin = process.hrtime.bigint();
          search(query, { gate, excludeNodeId: 'p-1' });
          times.push(Number(process.hrtime.bigint() - begin) / 1e6);
        }
        times.sort((a, b) => a - b);
        t.diagnostic(`gate=${gate} fastest ${times[0].toFixed(1)} ms, median ${times[2].toFixed(1)} ms: ${query.slice(0, 30)}`);
        assert.ok(times[0] < 50, `${times[0].toFixed(1)} ms for ${query.slice(0, 30)}`);
      }
    }
  });
});
