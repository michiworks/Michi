// Must stay first: agentConfig would otherwise persist settings to ~/.michi/config.json.
import './isolatedConfigDir';
// Guesses (services/memory/guesses.ts, migration 0092): what a consolidation
// answer may propose, the mechanical checks at commit, confirm and reject,
// a rejected guess never coming back, removals taking pending guesses, the
// routes, and that no pack or search ever shows one.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import type { MemoryRecord } from 'michi-shared';
import { setupMemoryRoutes } from '../src/routes/memories';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { commitConsolidation, nextConsolidationBatch, validateConsolidationPayload, type ConsolidationBatch } from '../src/services/memory/consolidation';
import { CONSOLIDATION_INSTRUCTIONS } from '../src/services/memory/consolidationPolicy';
import { buildMemoryPack } from '../src/services/memory/contextBuilder';
import { installMemoryExtractionHooks } from '../src/services/memory/extractionService';
import { commitGuesses, confirmGuess, GUESS_LIMITS, listGuesses, rejectGuess, type GuessProposal } from '../src/services/memory/guesses';
import { activeMichiNoteCount } from '../src/services/memory/memoryRepository';
import { memoryRef } from '../src/services/memory/memoryRefs';
import { createMemory, forgetMemory, getMemory, resetMemories, type CreateMemoryInput } from '../src/services/memory/memoryService';
import { recallSearch } from '../src/services/memory/recallIndex';

const ME = LOCAL_AGENT_OWNER_ID;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 9, 10).getTime();
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
let dataDir: string;
let uninstall: (() => void) | null = null;
let serial = 0;

function note(body: string, extra: Partial<CreateMemoryInput> = {}, ownerUserId = ME): MemoryRecord {
  serial += 1;
  return createMemory({ ownerUserId }, {
    scope: { kind: 'user' }, kind: 'preference', body, status: 'active', origin: 'extracted', observedAt: NOW - 30 * DAY + serial * 60_000, ...extra,
  });
}

function refOf(record: { id: string }): string {
  const row = getDb().prepare('SELECT row_id, version FROM memories WHERE id = ?').get(record.id) as { row_id: number; version: number };
  return memoryRef(row.row_id, row.version);
}

function cite(...records: MemoryRecord[]): GuessProposal['cites'] {
  return records.map((record) => ({ memoryId: record.id, version: getMemory({ ownerUserId: ME }, record.id).version }));
}

function guessRows(): Array<{ id: string; body: string; status: string; memory_id: string | null }> {
  return getDb().prepare('SELECT id, body, status, memory_id FROM memory_guesses ORDER BY created_at, rowid').all() as never;
}

/** Three food notes that together suggest a pattern none of them says. */
function foodNotes() {
  return [
    note('The user loves Sichuan hot pot.', { keywords: ['spicy', 'hot pot', '火锅'] }),
    note('The user orders the hottest curry at Thai restaurants.', { keywords: ['spicy', 'curry'] }),
    note('The user keeps a bottle of chili oil at work.', { keywords: ['spicy', 'chili oil'] }),
  ];
}

const SPICY = 'The user likes spicy food.';

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-guesses-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  serial = 0;
  getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Project', 1, 1)").run();
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

describe('migration 0092', () => {
  test('creates memory_guesses with a status check', () => {
    const columns = (getDb().prepare('PRAGMA table_info(memory_guesses)').all() as Array<{ name: string }>).map((column) => column.name);
    assert.deepEqual(columns, ['id', 'owner_user_id', 'body', 'refs', 'status', 'fingerprint', 'body_hash', 'memory_id', 'run_id', 'created_at', 'updated_at']);
    assert.throws(() => getDb().prepare(`INSERT INTO memory_guesses (id, owner_user_id, body, refs, status, fingerprint, body_hash, created_at, updated_at)
      VALUES ('g', 'o', 'b', '[]', 'maybe', 'f', 'h', 1, 1)`).run(), /CHECK constraint/u);
  });
});

describe('the checks at commit', () => {
  test('a guess on two or more active user-scope notes of the owner is saved; at most two a run', () => {
    const [a, b, c] = foodNotes();
    const result = commitGuesses(ME, [
      { text: SPICY, cites: cite(a!, b!) },
      { text: 'The user eats spicy food at work too.', cites: cite(b!, c!) },
      { text: 'The user seeks out chili everywhere.', cites: cite(a!, c!) },
    ], { runId: 'mcr-1', now: NOW });
    assert.equal(result.saved.length, GUESS_LIMITS.perRun);
    assert.deepEqual(result.dropped, [{ index: 2, reason: 'run_cap' }]);
    assert.deepEqual(listGuesses({ ownerUserId: ME }, NOW).map((guess) => guess.body).sort(), [SPICY, 'The user eats spicy food at work too.'].sort());
  });

  test('refs: fewer than two, missing, another owner\'s, a workspace note, inactive, untrusted, past its end or changed since are left out', () => {
    const [a, b] = foodNotes();
    const other = note('Bob likes spicy noodles.', {}, 'bob');
    const project = note('The project mascot is a chili.', { scope: { kind: 'workspace', workspaceId: 'ws' } });
    const untrusted = note('A web page said the user likes jalapeños.', { sourceRisk: 'untrusted' });
    const ended = note('The user is on a spicy-food trip this week.', { validUntil: NOW - DAY });
    const cases: Array<[string, GuessProposal['cites']]> = [
      ['one note', cite(a!)],
      ['the same note twice', [...cite(a!), ...cite(a!)]],
      ['a missing note', [...cite(a!), { memoryId: 'mem-missing', version: 1 }]],
      ['another owner', [...cite(a!), { memoryId: other.id, version: 1 }]],
      ['a workspace note', cite(a!, project)],
      ['an untrusted note', cite(a!, untrusted)],
      ['a note past its end', cite(a!, ended)],
      ['an older version', [...cite(a!), { memoryId: b!.id, version: 7 }]],
    ];
    for (const [label, cites] of cases) {
      const result = commitGuesses(ME, [{ text: `${SPICY} (${label})`, cites }], { runId: null, now: NOW });
      assert.equal(result.saved.length, 0, label);
      assert.ok(['refs', 'note'].includes(result.dropped[0]!.reason), `${label}: ${result.dropped[0]!.reason}`);
    }
    forgetMemory({ ownerUserId: ME }, b!.id);
    assert.equal(commitGuesses(ME, [{ text: SPICY, cites: [...cite(a!), { memoryId: b!.id, version: 1 }] }], { runId: null, now: NOW }).dropped[0]!.reason, 'note');
  });

  test('no number the notes do not hold; nothing sensitive in the guess or its notes', () => {
    const [a, b] = foodNotes();
    assert.equal(commitGuesses(ME, [{ text: 'The user eats spicy food 3 times a week.', cites: cite(a!, b!) }], { runId: null, now: NOW }).dropped[0]!.reason, 'number');
    assert.equal(commitGuesses(ME, [{ text: 'The user may be diabetic and still eats spicy food.', cites: cite(a!, b!) }], { runId: null, now: NOW }).dropped[0]!.reason, 'sensitive');
    const health = note('The user has asthma.', { kind: 'fact' });
    assert.equal(commitGuesses(ME, [{ text: 'The user avoids smoky restaurants.', cites: cite(a!, health) }], { runId: null, now: NOW }).dropped[0]!.reason, 'sensitive');
    const dated = note('The user went to 2 hot pot dinners in March.', { keywords: ['hot pot'] });
    assert.equal(commitGuesses(ME, [{ text: 'The user had 2 hot pot dinners and likes spicy food.', cites: cite(a!, dated) }], { runId: null, now: NOW }).saved.length, 1);
  });

  test('no duplicate of a note or a guess; never again on the same notes, whatever happened to that guess', () => {
    const [a, b, c] = foodNotes();
    note(SPICY);
    assert.equal(commitGuesses(ME, [{ text: 'the user likes spicy food', cites: cite(a!, b!) }], { runId: null, now: NOW }).dropped[0]!.reason, 'duplicate');
    const first = commitGuesses(ME, [{ text: 'The user enjoys fiery dishes.', cites: cite(a!, b!) }], { runId: null, now: NOW });
    assert.equal(first.saved.length, 1);
    assert.equal(commitGuesses(ME, [{ text: 'The user enjoys fiery dishes.', cites: cite(b!, c!) }], { runId: null, now: NOW }).dropped[0]!.reason, 'duplicate');
    rejectGuess({ ownerUserId: ME }, first.saved[0]!, NOW);
    // Another wording on the same notes, in another order: the fingerprint is the notes'.
    assert.equal(commitGuesses(ME, [{ text: 'The user seeks out heat in food.', cites: cite(b!, a!) }], { runId: null, now: NOW }).dropped[0]!.reason, 'seen');
    assert.equal(commitGuesses(ME, [{ text: 'The user seeks out heat in food.', cites: cite(a!, b!, c!) }], { runId: null, now: NOW }).saved.length, 1);
  });

  test('past the pending cap, a run saves none', () => {
    const notes = Array.from({ length: 8 }, (_, index) => note(`The user tried cuisine number ${index}.`, { keywords: ['cuisine'] }));
    let made = 0;
    for (let i = 0; i < notes.length && made < GUESS_LIMITS.maxPending; i += 1) {
      for (let j = i + 1; j < notes.length && made < GUESS_LIMITS.maxPending; j += 1) {
        made += commitGuesses(ME, [{ text: `The user explores cuisines ${i} and ${j}.`, cites: cite(notes[i]!, notes[j]!) }], { runId: null, now: NOW }).saved.length;
      }
    }
    assert.equal(made, GUESS_LIMITS.maxPending);
    assert.equal(commitGuesses(ME, [{ text: 'The user explores cuisines 0 and 7 again.', cites: cite(notes[0]!, notes[7]!, notes[1]!) }], { runId: null, now: NOW }).dropped[0]!.reason, 'pending_cap');
  });
});

describe('a consolidation answer', () => {
  test('the instructions ask for at most two; refs resolve to listed notes; a bad guess never fails the answer', () => {
    assert.match(CONSOLIDATION_INSTRUCTIONS(null), /guesses: at most 2 things about the user/u);
    const [a, b] = foodNotes();
    getDb().prepare('DELETE FROM memory_consolidation_state').run();
    const batch = nextConsolidationBatch(ME, NOW, () => true) as ConsolidationBatch;
    assert.ok(batch && batch.groups.length > 0);
    const decisions = batch.groups.map((group) => ({ ref: batch.notes.get(group.members[0]!)!.ref, op: 'keep', into: null, why: 'test' }));
    const payload = validateConsolidationPayload({
      decisions,
      guesses: [{ text: `  ${SPICY}  `, refs: [refOf(a!), refOf(b!), 'm:zzzv1'] }, { text: 'Nothing listed.', refs: ['m:zzzv1', 'm:zzyv1'] }],
    }, batch, { activeMichiNotes: activeMichiNoteCount(ME) });
    assert.equal(payload.guesses?.[0]?.text, SPICY);
    assert.deepEqual(payload.guesses?.[0]?.cites.map((entry) => entry.memoryId), [a!.id, b!.id]);
    assert.deepEqual(payload.guesses?.[1]?.cites, []);
    const committed = commitConsolidation(payload, { ownerUserId: ME, runId: 'mcr-g', batch, liveWorkspace: () => true, now: NOW });
    assert.equal(committed.guesses.saved.length, 1);
    assert.deepEqual(committed.guesses.dropped.map((entry) => entry.reason), ['refs']);
    // An answer without guesses (an older model, or none to give) is read as none.
    assert.deepEqual(validateConsolidationPayload({ decisions }, batch).guesses, []);
  });

  test('a guess is in no memory pack and no search', () => {
    const [a, b] = foodNotes();
    commitGuesses(ME, [{ text: 'The user plans trips around food markets.', cites: cite(a!, b!) }], { runId: null, now: NOW });
    const pack = buildMemoryPack({ consumer: 'chat', ownerUserId: ME, workspaceId: 'ws', nodeId: null, query: 'trips food markets', now: NOW });
    assert.doesNotMatch(pack.text ?? '', /food markets/u);
    const hits = recallSearch({ ownerUserId: ME, workspaceIds: 'all', includeUserScope: true, query: 'food markets', gate: false, includeInactive: true, now: NOW });
    assert.equal(hits.some((hit) => hit.snippet.includes('food markets')), false);
  });
});

describe('confirm and reject', () => {
  test('That\'s right saves it as the user\'s own note in the user scope; the guess is confirmed and leaves the list', () => {
    const [a, b] = foodNotes();
    const [id] = commitGuesses(ME, [{ text: SPICY, cites: cite(a!, b!) }], { runId: null, now: NOW }).saved;
    const record = confirmGuess({ ownerUserId: ME }, id!, NOW);
    assert.equal(record.origin, 'explicit');
    assert.equal(record.body, SPICY);
    assert.deepEqual(record.scope, { kind: 'user' });
    assert.equal(record.kind, 'preference');
    assert.ok(record.keywords?.includes('spicy'));
    assert.deepEqual(guessRows().map((row) => [row.status, row.memory_id]), [['confirmed', record.id]]);
    assert.deepEqual(listGuesses({ ownerUserId: ME }, NOW), []);
    assert.throws(() => confirmGuess({ ownerUserId: ME }, id!, NOW), /already confirmed/u);
  });

  test('Not true rejects it and drops its text; another owner, a missing id or a changed note cannot be answered', () => {
    const [a, b, c] = foodNotes();
    const [first, second] = commitGuesses(ME, [{ text: SPICY, cites: cite(a!, b!) }, { text: 'The user likes heat at work.', cites: cite(b!, c!) }], { runId: null, now: NOW }).saved;
    assert.throws(() => rejectGuess({ ownerUserId: 'bob' }, first!, NOW), /Guess not found/u);
    rejectGuess({ ownerUserId: ME }, first!, NOW);
    assert.deepEqual(guessRows().find((row) => row.id === first)?.body, '');
    assert.equal(guessRows().find((row) => row.id === first)?.status, 'rejected');
    assert.throws(() => confirmGuess({ ownerUserId: ME }, 'mg-missing', NOW), /Guess not found/u);
    getDb().prepare("UPDATE memories SET status = 'superseded' WHERE id = ?").run(c!.id);
    assert.throws(() => confirmGuess({ ownerUserId: ME }, second!, NOW), /no longer applies/u);
    assert.deepEqual(listGuesses({ ownerUserId: ME }, NOW), []);
  });

  test('forgetting a note takes the pending guesses citing it; a reset takes every guess', () => {
    const [a, b, c] = foodNotes();
    commitGuesses(ME, [{ text: SPICY, cites: cite(a!, b!) }, { text: 'The user likes heat at work.', cites: cite(b!, c!) }], { runId: null, now: NOW });
    forgetMemory({ ownerUserId: ME }, c!.id);
    assert.deepEqual(guessRows().map((row) => row.body), [SPICY]);
    resetMemories({ ownerUserId: ME });
    assert.deepEqual(guessRows(), []);
  });
});

describe('routes', () => {
  let server: ReturnType<typeof express.application.listen>;
  let base: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', setupMemoryRoutes());
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
    const response = await fetch(`${base}${route}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  test('list, confirm and reject; errors as the other memory routes give them', async () => {
    const [a, b, c] = foodNotes();
    const [first, second] = commitGuesses(ME, [{ text: SPICY, cites: cite(a!, b!) }, { text: 'The user likes heat at work.', cites: cite(b!, c!) }], { runId: null, now: Date.now() }).saved;
    const listed = await call('GET', '/memory-guesses');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.guesses.map((guess: { id: string }) => guess.id).sort(), [first, second].sort());
    assert.deepEqual(listed.json.guesses.find((guess: { id: string }) => guess.id === first).cites.map((entry: { id: string }) => entry.id), [a!.id, b!.id]);
    const confirmed = await call('POST', `/memory-guesses/${first}/confirm`, {});
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.memory.origin, 'explicit');
    assert.equal((await call('POST', `/memory-guesses/${first}/confirm`, {})).status, 409);
    assert.equal((await call('POST', `/memory-guesses/${second}/reject`, { extra: true })).status, 400);
    assert.equal((await call('POST', `/memory-guesses/${second}/reject`, {})).status, 204);
    assert.equal((await call('POST', '/memory-guesses/mg-missing/reject', {})).status, 404);
    assert.deepEqual((await call('GET', '/memory-guesses')).json.guesses, []);
  });

  test('cloud mode needs an authenticated owner', async () => {
    process.env.MICHI_CLOUD = '1';
    try {
      for (const [method, route] of [['GET', '/memory-guesses'], ['POST', '/memory-guesses/mg-1/confirm'], ['POST', '/memory-guesses/mg-1/reject']] as const) {
        assert.equal((await call(method, route, method === 'POST' ? {} : undefined)).status, 401, route);
      }
    } finally {
      delete process.env.MICHI_CLOUD;
    }
  });
});
