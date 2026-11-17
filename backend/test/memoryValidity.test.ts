// Must stay first: agentConfig would otherwise persist settings to ~/.michi/config.json.
import './isolatedConfigDir';
// How long a memory holds (services/memory/validity.ts, migration 0091): the
// end a note is given (memory_save, memory_update, extraction, Settings),
// packs and recall leaving out a note past it (memory_search with history
// still finds it), confirmations (last_confirmed_at), and Michi's stale
// workspace notes ranking after the others.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryRecord } from 'michi-shared';
import { memoryTool, type MemoryToolCaller, type MemoryToolName } from '../src/agents/memoryTools';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { buildMemoryPack, createMemoryPackHolder, deliverMemoryPack, type BuildMemoryPackInput } from '../src/services/memory/contextBuilder';
import { commitExtractionPayload, validateExtractionPayload } from '../src/services/memory/extractionV2';
import { readScopeVersion, storedMemoryByRowId } from '../src/services/memory/memoryRepository';
import { memoryRef, parseRef } from '../src/services/memory/memoryRefs';
import { createMemory, updateMemory, type CreateMemoryInput } from '../src/services/memory/memoryService';
import { recallSearch } from '../src/services/memory/recallIndex';
import { commitProfilePayload } from '../src/services/memory/userProfile';
import { endOfDay, lastValidDay, STALE_AFTER_MS } from '../src/services/memory/validity';

const ME = LOCAL_AGENT_OWNER_ID;
const DAY = 24 * 60 * 60 * 1000;
/** Friday 2026-11-06, noon local time. */
const NOW = new Date(2026, 10, 6, 12).getTime();
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
let dataDir: string;
let turnSerial = 0;

const chat: MemoryToolCaller = { ownerUserId: null, workspaceId: 'ws', nodeId: 'n-chat', isAgentRun: false };

function call(name: MemoryToolName, args: unknown) {
  const result = memoryTool(name, chat, args);
  const text = result.content.map((part) => part.text).join('');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* an error result is text */ }
  return { result, text, json };
}

/** A running turn of the chat, as chatHub's durable row. */
function runningTurn(): string {
  getDb().prepare("UPDATE turns SET status = 'completed' WHERE node_id = 'n-chat'").run();
  const turnId = `turn-${++turnSerial}`;
  getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, last_seq, started_at, updated_at)
    VALUES (?, 'n-chat', NULL, ?, 'active', 0, ?, ?)`).run(turnId, `a-${turnId}`, Date.now(), Date.now());
  return turnId;
}

function note(body: string, extra: Partial<CreateMemoryInput> = {}): MemoryRecord {
  return createMemory({ ownerUserId: ME }, { scope: { kind: 'user' }, kind: 'preference', body, status: 'active', origin: 'explicit', ...extra });
}

function columns(id: string): { valid_until: number | null; last_used_at: number | null; last_confirmed_at: number | null; version: number; updated_at: number } {
  return getDb().prepare('SELECT valid_until, last_used_at, last_confirmed_at, version, updated_at FROM memories WHERE id = ?').get(id) as never;
}

function refOf(record: MemoryRecord): string {
  const row = getDb().prepare('SELECT row_id, version FROM memories WHERE id = ?').get(record.id) as { row_id: number; version: number };
  return memoryRef(row.row_id, row.version);
}

function byRef(ref: string): MemoryRecord {
  const parsed = parseRef(ref);
  assert.ok(parsed?.kind === 'memory', ref);
  return storedMemoryByRowId(ME, parsed.rowId)!.record;
}

function pack(input: Partial<BuildMemoryPackInput> = {}) {
  return buildMemoryPack({ consumer: 'chat', ownerUserId: ME, workspaceId: 'ws', nodeId: 'n-chat', query: '', now: NOW, ...input });
}

/** Sets a memory's times as if it was written long ago. */
function writtenAt(record: MemoryRecord, at: number): void {
  getDb().prepare('UPDATE memories SET created_at = ?, observed_at = ? WHERE id = ?').run(at, at, record.id);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-validity-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Project', 1, 1), ('ws-2', 'Other', 1, 1)").run();
  getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, title, status, created_at) VALUES ('n-chat', 'ws', 'chat', 'Chat', 'idle', 1)").run();
  // A profile that has read every note, so packs do not wait for a first build.
  getDb().prepare(`INSERT INTO memory_user_profiles (owner_user_id, lines, version, built_at, updated_at) VALUES (?, '[]', 1, ?, 1)`)
    .run(ME, 8_640_000_000_000_000);
});

afterEach(() => {
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.data;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('migration 0091', () => {
  test('adds valid_until, last_used_at and last_confirmed_at to memories, all nullable, and leaves existing rows without them', () => {
    const info = new Map((getDb().prepare('PRAGMA table_info(memories)').all() as Array<{ name: string; notnull: number; type: string }>)
      .map((column) => [column.name, column]));
    for (const name of ['valid_until', 'last_used_at', 'last_confirmed_at']) {
      assert.equal(info.get(name)?.type, 'INTEGER', name);
      assert.equal(info.get(name)?.notnull, 0, name);
    }
    const record = note('Reply in English.');
    assert.deepEqual({ ...columns(record.id), version: 0, updated_at: 0 }, { valid_until: null, last_used_at: null, last_confirmed_at: null, version: 0, updated_at: 0 });
    assert.equal(record.validUntil, null);
  });
});

describe('an end', () => {
  test('endOfDay is the next local midnight; lastValidDay shows the day again; impossible dates are null', () => {
    assert.equal(endOfDay('2026-11-08'), new Date(2026, 10, 9).getTime());
    assert.equal(lastValidDay(endOfDay('2026-11-08')!), '2026-11-08');
    assert.equal(endOfDay('2026-02-30'), null);
    assert.equal(endOfDay('soon'), null);
  });

  test('a pack leaves out a note past its end from the pinned sections and Related; its line said the last day before', () => {
    const tokyo = note('This week the user is in Tokyo for a conference.', { validUntil: endOfDay('2026-11-08')!, keywords: ['Tokyo', '东京'] });
    note('Answer in English.');
    const before = pack({ query: 'Tokyo', now: NOW });
    assert.match(before.text ?? '', /in Tokyo for a conference\. \(\d{4}-\d{2}-\d{2}, until 2026-11-08\)/u);
    assert.ok(before.pinnedIds.includes(tokyo.id));
    const after = pack({ query: 'Tokyo conference', now: endOfDay('2026-11-08')! + DAY });
    assert.doesNotMatch(after.text ?? '', /Tokyo/u);
    assert.ok(!after.pinnedIds.includes(tokyo.id) && !after.relatedIds.includes(tokyo.id));
    assert.match(after.text ?? '', /Answer in English/u);
  });

  test('a session that was shown a note gets the pinned sections again, without it, on the first turn after its end', () => {
    note('The user is in Tokyo until Sunday.', { validUntil: endOfDay('2026-11-08')! });
    note('Answer in English.');
    const holder = createMemoryPackHolder();
    const first = pack({ holder, now: NOW });
    deliverMemoryPack(holder, first);
    assert.match(first.text ?? '', /in Tokyo until Sunday/u);
    const sameDay = pack({ holder, now: NOW + 60_000 });
    assert.equal(sameDay.signature, null, 'nothing changed: the pinned sections are not sent again');
    const later = pack({ holder, now: endOfDay('2026-11-08')! + 60_000 });
    assert.match(later.text ?? '', /Michi Memory, updated: these sections replace the ones shown earlier/u);
    assert.doesNotMatch(later.text ?? '', /Tokyo/u);
    assert.match(later.text ?? '', /Answer in English/u);
  });

  test('recall without history leaves it out; with history (memory_search history true) it is found, its validUntil shown', () => {
    note('The user is in Tokyo this week.', { validUntil: NOW - DAY, keywords: ['Tokyo'] });
    const search = (includeInactive: boolean) => recallSearch({
      ownerUserId: ME, workspaceIds: ['ws'], includeUserScope: true, query: 'Tokyo', kinds: ['memory'], includeInactive, gate: false, now: NOW,
    });
    assert.equal(search(false).length, 0);
    assert.equal(search(true).length, 1);
    runningTurn();
    assert.equal(call('memory_search', { query: 'Tokyo' }).json.count, 0);
    const history = call('memory_search', { query: 'Tokyo', history: true }).json;
    assert.equal(history.count, 1);
    assert.equal(history.results[0].validUntil, lastValidDay(NOW - DAY));
  });

  test('a profile line citing a note past its end is not shown', () => {
    const a = note('The user lives in Osaka.', { origin: 'extracted', kind: 'fact' });
    const b = note('The user is in Tokyo until Sunday.', { origin: 'extracted', kind: 'fact', validUntil: NOW + DAY });
    const committed = commitProfilePayload({ sections: [{ topic: 'Where', lines: [{ text: 'Lives in Osaka', refs: [refOf(a)] }, { text: 'In Tokyo this week', refs: [refOf(b)] }] }] }, {
      ownerUserId: ME, sources: [a, b].map((record) => ({ ref: refOf(record), memoryId: record.id })), sourceVersion: readScopeVersion(ME, null),
      language: 'en', now: NOW,
    });
    assert.equal(committed.saved, true);
    assert.match(pack({ now: NOW }).text ?? '', /In Tokyo this week/u);
    assert.doesNotMatch(pack({ now: NOW + 2 * DAY }).text ?? '', /In Tokyo this week/u);
    assert.match(pack({ now: NOW + 2 * DAY }).text ?? '', /Lives in Osaka/u);
  });

  test('the tools take no end; the same text and an automatic note made the user\'s own keep it, a corrected text has none', (t) => {
    t.mock.method(Date, 'now', () => NOW);
    const tokyo = note('The user is in Tokyo this week.', { origin: 'extracted', kind: 'fact', validUntil: endOfDay('2026-11-15')! });
    runningTurn();
    const keywords = call('memory_update', { ref: refOf(tokyo), keywords: ['Tokyo', '东京'] }).json;
    assert.equal(keywords.status, 'updated');
    assert.equal(keywords.memory.validUntil, '2026-11-15');
    assert.equal(byRef(keywords.ref).validUntil, endOfDay('2026-11-15'));
    const theirs = call('memory_save', { body: 'The user is in Tokyo this week.', kind: 'fact', userAsked: true }).json;
    assert.equal(theirs.status, 'saved');
    assert.equal(byRef(theirs.ref).origin, 'explicit');
    assert.equal(byRef(theirs.ref).validUntil, endOfDay('2026-11-15'));
    const moved = call('memory_update', { ref: theirs.ref, body: 'The user moved to Tokyo.' }).json;
    assert.equal(byRef(moved.ref).validUntil, null);
  });

  test('saying a note again after its end saves a new one rather than "already saved"', () => {
    note('The user is in Tokyo this week.', { kind: 'fact', validUntil: Date.now() - DAY });
    runningTurn();
    const again = call('memory_save', { body: 'The user is in Tokyo this week.', kind: 'fact', userAsked: true }).json;
    assert.equal(again.status, 'saved');
    assert.equal(byRef(again.ref).validUntil, null);
  });

  test('Settings sets and clears it (PATCH validUntil); the edit confirms the note', () => {
    const record = note('The release freeze is on.', { origin: 'extracted', kind: 'fact' });
    const set = updateMemory({ ownerUserId: ME }, record.id, { validUntil: endOfDay('2026-12-01') }, record.version, { byUser: true });
    assert.equal(set.validUntil, endOfDay('2026-12-01'));
    assert.ok(columns(record.id).last_confirmed_at !== null);
    const cleared = updateMemory({ ownerUserId: ME }, record.id, { validUntil: null }, set.version, { byUser: true });
    assert.equal(cleared.validUntil, null);
  });
});

describe('extraction', () => {
  const turn = (turnId: string, userText: string, at = NOW) => ({
    turnId, nodeId: 'n-chat', userText, assistantText: 'Noted.', userAt: at, untrusted: false, previousUntrusted: false,
  });
  const memory = (body: string, quote: string, sourceTurn: string, extra: Record<string, unknown> = {}) => ({
    op: 'add', kind: 'fact', about: 'user', body, keywords: ['Tokyo'], quote, source_turn: sourceTurn, ...extra,
  });

  test('valid_until is a real day, stored as the next midnight; a body a note already holds confirms that note', () => {
    assert.throws(() => validateExtractionPayload({ memories: [memory('b', 'q', 't', { valid_until: '2026-02-30' })], turn_keys: [] }),
      /valid_until must be a real date/u);
    const payload = validateExtractionPayload({
      memories: [memory('The user is in Tokyo this week.', "I'm in Tokyo this week", 't-1', { valid_until: '2026-11-08' })], turn_keys: [],
    });
    const first = commitExtractionPayload(payload, { ownerUserId: ME, workspaceId: 'ws', turns: [turn('t-1', "I'm in Tokyo this week")] as never, now: NOW });
    assert.equal(first.saved.length, 1);
    const stored = first.saved[0]!.memory;
    assert.equal(stored.validUntil, endOfDay('2026-11-08'));
    assert.equal(columns(stored.id).last_confirmed_at, null);
    const again = validateExtractionPayload({ memories: [memory('The user is in Tokyo this week.', "still in Tokyo this week", 't-2')], turn_keys: [] });
    const second = commitExtractionPayload(again, { ownerUserId: ME, workspaceId: 'ws', turns: [turn('t-2', "I'm still in Tokyo this week", NOW + 60_000)] as never, now: NOW + 60_000 });
    assert.deepEqual(second.dropped.map((entry) => entry.reason), ['duplicate']);
    assert.equal(columns(stored.id).last_confirmed_at, NOW + 60_000);
    assert.equal(columns(stored.id).version, 1, 'a confirmation is no new version');
  });
});

describe('confirmation', () => {
  test('saving a note the scope holds confirms it; memory_update with userAsked confirms the new version; neither moves updated_at', () => {
    const record = note('Answer in English.', { origin: 'extracted' });
    const before = columns(record.id);
    runningTurn();
    assert.equal(call('memory_save', { body: 'Answer in English.', kind: 'preference', userAsked: false }).json.status, 'already_saved');
    const after = columns(record.id);
    assert.ok(after.last_confirmed_at !== null);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.version, before.version);
    const theirs = call('memory_update', { ref: refOf(record), userAsked: true }).json;
    assert.ok(columns(byRef(theirs.ref).id).last_confirmed_at !== null);
  });
});

describe('stale notes', () => {
  const pinned = (now: number) => pack({ now }).text?.split('\n').filter((line) => line.startsWith('- [')) ?? [];

  test('Michi\'s own workspace notes unused for 90 days come after the others; use or confirmation brings them back; others never go stale', () => {
    const old = note('The project deploys with Helm.', { origin: 'extracted', kind: 'convention', scope: { kind: 'workspace', workspaceId: 'ws' } });
    const fresh = note('The project uses pnpm.', { origin: 'extracted', kind: 'convention', scope: { kind: 'workspace', workspaceId: 'ws' } });
    const mine = note('The project targets Node 22.', { kind: 'convention', scope: { kind: 'workspace', workspaceId: 'ws' } });
    const everywhere = note('The user prefers short answers.', { origin: 'extracted' });
    // Newest said first: pnpm, Helm, short answers; Helm is stale, so it goes after the user-scope note said before it.
    writtenAt(fresh, NOW - 2 * DAY);
    writtenAt(old, NOW - STALE_AFTER_MS - DAY);
    writtenAt(everywhere, NOW - STALE_AFTER_MS - 30 * DAY);
    writtenAt(mine, NOW - STALE_AFTER_MS - 30 * DAY);
    const order = pinned(NOW);
    const at = (text: string) => order.findIndex((line) => line.includes(text));
    assert.ok(at('Helm') > at('pnpm'), order.join('\n'));
    assert.ok(at('Helm') > at('short answers'), 'a user-scope note is never stale');
    assert.ok(order.some((line) => line.includes('Node 22')), 'the user\'s own note stays pinned');
    getDb().prepare('UPDATE memories SET last_used_at = ? WHERE id = ?').run(NOW - DAY, old.id);
    // A note's ranking is read when the pinned sections are built: a new session sees it.
    const used = pinned(NOW);
    assert.ok(used.findIndex((line) => line.includes('Helm')) < used.findIndex((line) => line.includes('short answers')), used.join('\n'));
    getDb().prepare('UPDATE memories SET last_used_at = NULL, last_confirmed_at = ? WHERE id = ?').run(NOW - DAY, old.id);
    const confirmed = pinned(NOW);
    assert.ok(confirmed.findIndex((line) => line.includes('Helm')) < confirmed.findIndex((line) => line.includes('short answers')), confirmed.join('\n'));
  });

  test('in Related, a stale note comes after a fresh one, even one that matches less well', () => {
    const scope = { kind: 'workspace' as const, workspaceId: 'ws' };
    note('Deploys need the on-call approval before any cluster change.', { origin: 'extracted', kind: 'fact', scope, keywords: ['approval'] });
    const stale = note('Deploy cluster: staging first.', { origin: 'extracted', kind: 'fact', scope, keywords: ['deploy', 'cluster'] });
    // Written long ago (what staleness counts from), said as recently as the other: recall alone would rank it first.
    getDb().prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(NOW - STALE_AFTER_MS - DAY, stale.id);
    const related = pack({ query: 'deploy cluster', now: NOW }).text?.split('Related to this message:\n')[1]?.split('\n') ?? [];
    assert.ok(related.length >= 2, related.join('\n'));
    assert.match(related[0]!, /on-call/u);
    assert.match(related[1]!, /staging first/u);
  });
});
