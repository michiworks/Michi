// The topic pass (services/memory/memoryTopics.ts): which memories it lists
// and how, the answer's checks, and what saving one changes (only the topic).
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryRecord } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createMemory, getMemory, updateMemory, type CreateMemoryInput } from '../src/services/memory/memoryService';
import {
  advanceTopicPass, buildTopicPassPrompt, commitTopicsPayload, topicPassCursor, topicPassPending, TOPIC_PASS_LIMITS, TopicsPayloadError,
  validateTopicsPayload,
} from '../src/services/memory/memoryTopics';
import { memoryRef } from '../src/services/memory/memoryRefs';
import { recallSearch } from '../src/services/memory/recallIndex';

const ME = 'alice';
const NOW = Date.UTC(2026, 10, 12, 9);
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
let dataDir: string;
const live = (workspaceId: string) => workspaceId !== 'ws-archived';

function workspace(id: string, name: string): void {
  getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(id, name, ME);
}

function note(body: string, extra: Partial<CreateMemoryInput> = {}): MemoryRecord {
  return createMemory({ ownerUserId: ME }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'extracted', ...extra });
}

function refOf(record: MemoryRecord): string {
  const row = getDb().prepare('SELECT row_id, version FROM memories WHERE id = ?').get(record.id) as { row_id: number; version: number };
  return memoryRef(row.row_id, row.version);
}

function listedRefs(prompt: string): string[] {
  return [...prompt.matchAll(/^- (m:[0-9a-z]+v\d+) · /gmu)].map((match) => match[1]!);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-topics-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  workspace('ws', 'Sample Project');
  workspace('ws-archived', 'Old project');
});

afterEach(() => {
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.data;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('the prompt', () => {
  test('lists active memories without a topic past the cursor, oldest first, with scope, origin and the topics in use', () => {
    note('The user trains at the gym on Tuesdays.', { topic: 'Fitness' });
    const job = note('The user works on the Aurora frontend at Example Studio.', { origin: 'explicit' });
    const repo = note('This repo deploys from the release branch.', { scope: { kind: 'workspace', workspaceId: 'ws' }, kind: 'convention' });
    const archived = note('Old project uses yarn.', { scope: { kind: 'workspace', workspaceId: 'ws-archived' }, kind: 'convention' });
    const gone = note('The user lived in Boston.');
    updateMemory({ ownerUserId: ME }, gone.id, { topic: null });
    getDb().prepare("UPDATE memories SET status = 'superseded' WHERE id = ?").run(gone.id);
    getDb().prepare("UPDATE memories SET import_source = 'claude', import_ref = 'p/note.md' WHERE id = ?").run(repo.id);

    assert.equal(topicPassPending(ME), true);
    const prompt = buildTopicPassPrompt({ ownerUserId: ME, now: NOW, liveWorkspace: live })!;
    assert.deepEqual(listedRefs(prompt.prompt), [refOf(job), refOf(repo)], 'not tagged, superseded or in an archived workspace');
    assert.match(prompt.prompt, /^Topics in use: "Fitness"$/mu);
    assert.match(prompt.prompt, new RegExp(`^- ${refOf(job)} · fact · everywhere · said \\d{4}-\\d{2}-\\d{2}: The user works on the Aurora frontend`, 'mu'));
    assert.match(prompt.prompt, new RegExp(`^- ${refOf(repo)} · convention · workspace "Sample Project" · from Claude Code · said `, 'mu'));
    assert.match(prompt.system, /broad area of the user's life or work/);
    assert.match(prompt.system, /Answer with the JSON object only/);
    assert.ok(prompt.through >= Number((getDb().prepare('SELECT row_id FROM memories WHERE id = ?').get(archived.id) as { row_id: number }).row_id),
      'the cursor passes the archived workspace\'s note too');

    advanceTopicPass(ME, prompt.through);
    assert.equal(topicPassPending(ME), false);
    assert.equal(buildTopicPassPrompt({ ownerUserId: ME, now: NOW, liveWorkspace: live }), null);
    const later = note('The user started swimming.');
    assert.deepEqual(listedRefs(buildTopicPassPrompt({ ownerUserId: ME, now: NOW, liveWorkspace: live })!.prompt), [refOf(later)], 'only what came after');
    advanceTopicPass(ME, 1);
    assert.ok(topicPassCursor(ME) > 1, 'the cursor never moves back');
  });

  test('a batch holds at most TOPIC_PASS_LIMITS.batch notes; the rest wait for the next run', () => {
    for (let i = 0; i < TOPIC_PASS_LIMITS.batch + 5; i += 1) note(`Note number ${i} about the garden.`);
    const first = buildTopicPassPrompt({ ownerUserId: ME, now: NOW, liveWorkspace: live })!;
    assert.equal(first.listed.length, TOPIC_PASS_LIMITS.batch);
    advanceTopicPass(ME, first.through);
    assert.equal(buildTopicPassPrompt({ ownerUserId: ME, now: NOW, liveWorkspace: live })!.listed.length, 5);
  });
});

describe('the answer', () => {
  test('refs must be listed (strict) or are left out; refs are read as written; one topic per note, the last wins', () => {
    const a = note('The user likes jazz.');
    const b = note('The user plays the cello.');
    const listed = [a, b].map((record) => ({ ref: refOf(record), memoryId: record.id }));
    const answer = { topics: [{ ref: `[${refOf(a).toUpperCase()}]`, topic: ' Music ' }, { ref: refOf(b), topic: 'Hobbies' }, { ref: refOf(b), topic: 'Music' },
      { ref: 'm:zzzv1', topic: 'Other' }] };
    assert.throws(() => validateTopicsPayload(answer, listed, { strict: true }), (error: unknown) => error instanceof TopicsPayloadError && /not a listed note/.test(error.message));
    assert.deepEqual(validateTopicsPayload(answer, listed), { topics: [{ ref: refOf(a), topic: 'Music' }, { ref: refOf(b), topic: 'Music' }] });
    assert.throws(() => validateTopicsPayload({ topics: 'Music' }, listed), TopicsPayloadError);
  });
});

describe('saving', () => {
  test('sets only the topic, spelled as the owner spells it, of notes that still have none; search finds them by it', () => {
    note('The user works at Example Studio.', { topic: 'Work' });
    const mine = note('Reply in Chinese unless I write in English.', { origin: 'explicit', kind: 'preference' });
    const review = note('Reviews go through Alex.');
    const meanwhile = note('The user moved to Nakano.');
    const before = getMemory({ ownerUserId: ME }, mine.id);
    const listed = [mine, review, meanwhile].map((record) => ({ ref: refOf(record), memoryId: record.id }));
    updateMemory({ ownerUserId: ME }, meanwhile.id, { topic: 'Home' });
    const labeled = commitTopicsPayload({ topics: [{ ref: listed[0].ref, topic: 'Communication' }, { ref: listed[1].ref, topic: 'work' },
      { ref: listed[2].ref, topic: 'Travel' }] }, { ownerUserId: ME, listed });
    assert.equal(labeled, 2);
    const after = getMemory({ ownerUserId: ME }, mine.id);
    assert.equal(after.topic, 'Communication');
    assert.deepEqual([after.body, after.version, after.updatedAt, after.origin], [before.body, before.version, before.updatedAt, before.origin],
      'the user\'s own note: only its topic');
    assert.equal(getMemory({ ownerUserId: ME }, review.id).topic, 'Work', 'one spelling per owner');
    assert.equal(getMemory({ ownerUserId: ME }, meanwhile.id).topic, 'Home', 'a topic set meanwhile stays');
    const hits = recallSearch({ ownerUserId: ME, workspaceIds: [], includeUserScope: true, currentWorkspaceId: null, query: 'Communication', kinds: ['memory'], now: NOW });
    assert.ok(hits.some((hit) => hit.refId === mine.id));
  });
});
