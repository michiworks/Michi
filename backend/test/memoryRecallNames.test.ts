// Round 10 (ported from the round-10 copy, rem-0200): a Chinese name written with a one-character stop word
// (沈一鸣, 王一凡, 李想, 周可) is found by memory_search's recall, as any other name is
// (memoryTerms.queryConcepts keeps it together), however the question puts it.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { createMemory } from '../src/services/memory/memoryService';
import { recallSearch } from '../src/services/memory/recallIndex';

const ME = LOCAL_AGENT_OWNER_ID;
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-recall-names-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare(`INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Home', 1, 1)`).run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (saved.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.data;
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
});

test('memory_search finds names written with 一, 想 or 可, however the question puts them', () => {
  const note = (body: string) => createMemory({ ownerUserId: ME }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'extracted' });
  const friend = note('孩子最好的朋友叫沈一鸣');
  const classmate = note('用户的大学同学王一凡在杭州做设计');
  const colleague = note('用户的同事李想负责前端');
  const neighbour = note('楼下邻居周可养了两只猫');
  note('用户周末常去爬山');
  // memory_search's parameters for a search the agent asks for (gate off).
  const search = (query: string) => recallSearch({
    ownerUserId: ME, workspaceIds: [], includeUserScope: true, query, kinds: ['memory'], gate: false, limit: 5,
  }).map((hit) => hit.refId);
  assert.deepEqual(search('沈一鸣'), [friend.id]);
  assert.deepEqual(search('沈一鸣是谁'), [friend.id]);
  assert.equal(search('王一凡是谁')[0], classmate.id);
  assert.equal(search('李想的生日')[0], colleague.id);
  assert.deepEqual(search('周可'), [neighbour.id]);
  assert.equal(search('周可是谁')[0], neighbour.id);
  assert.equal(search('我朋友周可')[0], neighbour.id);
  assert.equal(search('我朋友周可是做什么的')[0], neighbour.id);
});

test('automatic recall finds a name of three; a name\'s pair alone (周可) is no reason to recall, as it also spans two words (下周|可能)', () => {
  const note = (body: string) => createMemory({ ownerUserId: ME }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'extracted' });
  const friend = note('孩子最好的朋友叫沈一鸣');
  const trip = note('用户下周可能要去上海出差');
  note('用户周末常去爬山');
  const recall = (query: string) => recallSearch({ ownerUserId: ME, workspaceIds: [], includeUserScope: true, query, kinds: ['memory'], limit: 5 })
    .map((hit) => hit.refId);
  assert.deepEqual(recall('沈一鸣是谁'), [friend.id]);
  assert.deepEqual(recall('一鸣惊人是什么意思'), [], 'one pair of a name of three is only part of it');
  // Before round 10's port this found nothing too; the port recalled the trip through 周可.
  assert.deepEqual(recall('周可是谁'), []);
  assert.ok(!recall('我朋友周可').includes(trip.id), 'only 朋友 counts (the friend note holds it)');
  const neighbour = note('楼下邻居周可养了两只猫');
  assert.deepEqual(recall('周可是谁'), []);
  assert.deepEqual(recall('周可养了几只猫'), [neighbour.id], 'beside another word it ranks and passes');
  assert.ok(!recall('周可养了几只猫').includes(trip.id));
  assert.deepEqual(recall('定了什么'), []);
});

test('the words around a modal keep their characters (round 10 review: 数据|库|会|丢)', () => {
  const note = (body: string) => createMemory({ ownerUserId: ME }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'extracted' });
  const database = note('项目的数据库用的是 PostgreSQL，每周日备份');
  note('用户在做用户行为数据分析');
  note('用户的日志数据存放在 S3');
  note('用户每天看销售数据报表');
  const car = note('用户担心那辆旧车会坏在路上');
  const fridge = note('用户家里有一台海尔冰箱');
  const recall = (query: string, gate = true) => recallSearch({
    ownerUserId: ME, workspaceIds: [], includeUserScope: true, query, kinds: ['memory'], gate, limit: 5,
  }).map((hit) => hit.refId);
  assert.deepEqual(recall('我的数据库会丢吗'), [database.id]);
  assert.deepEqual(recall('数据库会丢数据吗'), [database.id]);
  assert.equal(recall('我的数据库会丢吗', false)[0], database.id);
  assert.deepEqual(recall('冰箱会坏吗'), [fridge.id], 'no 会坏 concept');
  assert.ok(!recall('冰箱会坏吗', false).includes(car.id));
});
