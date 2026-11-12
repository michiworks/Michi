// Must stay first: agentConfig would otherwise persist settings to ~/.michi/config.json.
import './isolatedConfigDir';
// Removal through consolidation's merge links (memoryService.removeMemory,
// spec round 10 §C9): a forget takes what was merged into the forgotten
// memory too, and leaves the conversations as they are; a removal without
// forget brings it back while its source still learns; the read side names
// the current note. A seeded random sequence
// checks the invariants: protected rows never change, every link leads to a
// row, and nothing active rests only on what was forgotten.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryChangedEvent, MemoryRecord } from 'michi-shared';
import { memoryTool } from '../src/agents/memoryTools';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { installMemoryExtractionHooks } from '../src/services/memory/extractionService';
import { consolidationRows, currentCorrection, storedMemories } from '../src/services/memory/memoryRepository';
import { memoryRef } from '../src/services/memory/memoryRefs';
import {
  createMemory, deleteMemory, forgetMemory, memoryEvents, mergeMemoryInto, setConversationMemoryMode, supersedeMemory,
  type CreateMemoryInput,
} from '../src/services/memory/memoryService';
import { forgetConversationTurn, indexTurn, recallSearch } from '../src/services/memory/recallIndex';

const ME = LOCAL_AGENT_OWNER_ID;
const DAY = 24 * 60 * 60 * 1000;
const START = new Date(2026, 10, 9, 10).getTime();
let now = START;
let dataDir: string;
let uninstall: (() => void) | null = null;
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };
let turns = 0;

function chat(nodeId: string, workspaceId = 'ws'): void {
  getDb().prepare("INSERT OR IGNORE INTO nodes (id, workspace_id, kind, status, created_at) VALUES (?, ?, 'chat', 'idle', ?)").run(nodeId, workspaceId, now);
}

/** A finished turn of the conversation, indexed for recall; returns its id. */
function pastTurn(nodeId: string, userText: string, reply = 'Noted.'): string {
  chat(nodeId);
  const turnId = `t-${++turns}`;
  assert.equal(indexTurn({ ownerUserId: null, nodeId, turnId, humanOrigin: true, userText, assistantText: reply, completedAt: now, userMessageAt: now }), true);
  return turnId;
}

/** A note Michi saved on its own from that turn. */
function noted(body: string, nodeId: string, turnId: string, extra: Partial<CreateMemoryInput> = {}): MemoryRecord {
  now += 1_000;
  return createMemory({ ownerUserId: ME }, {
    scope: { kind: 'user' }, kind: 'fact', body, status: 'active', origin: 'extracted', source: { nodeId, turnId }, observedAt: now, ...extra,
  });
}

function merge(record: MemoryRecord, into: MemoryRecord): MemoryRecord {
  const current = consolidationRows(ME, [record.id])[0]!.record;
  const merged = mergeMemoryInto(ME, current, into.id, now);
  assert.ok(merged, 'merged');
  return merged;
}

function state(id: string) {
  const row = consolidationRows(ME, [id])[0];
  return row ? { status: row.record.status, mergedIntoId: row.mergedIntoId, version: row.record.version } : null;
}

function hidden(turnId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM memory_recall_docs WHERE doc_kind = 'turn' AND ref_id = ? AND hidden = 1").get(turnId);
}

function tombstonedTurn(turnId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM memory_extraction_tombstones WHERE source_turn_id = ?').get(turnId);
}

function refOf(record: { id: string }): string {
  const row = getDb().prepare('SELECT row_id, version FROM memories WHERE id = ?').get(record.id) as { row_id: number; version: number };
  return memoryRef(row.row_id, row.version);
}

function events(): MemoryChangedEvent[] {
  const seen: MemoryChangedEvent[] = [];
  memoryEvents.on('changed', (event) => seen.push(event));
  return seen;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-consolidation-removal-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  now = START;
  turns = 0;
  mock.method(Date, 'now', () => now);
  getDb().prepare(`INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Michi', 1, 1)`).run();
  uninstall = installMemoryExtractionHooks();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  memoryEvents.removeAllListeners('changed');
  mock.restoreAll();
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.data;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('forget', () => {
  test('forgetting a note forgets what was merged into it, with their versions and a tombstone each; the conversations stay as they are', () => {
    const tT = pastTurn('n-a', 'I moved to Nakano last week');
    const tP = pastTurn('n-b', '我住在中野');
    const tQ = pastTurn('n-c', 'I live in Nakano now');
    const target = noted('The user lives in Nakano, Tokyo.', 'n-a', tT);
    const p0 = noted('用户住在中野区', 'n-b', tP, { keywords: ['Nakano'] });
    const p = supersedeMemory({ ownerUserId: ME }, p0.id, { body: '用户住在东京中野', status: 'active', origin: 'extracted', source: { nodeId: 'n-b', turnId: tP } });
    const q = noted('User lives in Nakano.', 'n-c', tQ);
    merge(q, p); // an earlier run: q into p
    merge(p, target); // a later one: p into the target
    const seen = events();
    const result = forgetMemory({ ownerUserId: ME }, target.id);
    assert.deepEqual(new Set(result.removed.map((record) => record.id)), new Set([target.id, p.id, p0.id, q.id]));
    assert.deepEqual(storedMemories(ME, [target.id, p.id, p0.id, q.id]), []);
    for (const turnId of [tT, tP, tQ]) {
      assert.ok(tombstonedTurn(turnId), `${turnId} is barred from extraction`);
      assert.equal(hidden(turnId), false, `${turnId} is chat history: recall still reads it`);
    }
    assert.deepEqual(seen.filter((event) => event.action !== 'deleted'), [], 'only deletions are announced');
    const memories = recallSearch({ ownerUserId: ME, workspaceIds: ['ws'], includeUserScope: true, query: '中野 Nakano', gate: false, includeInactive: true })
      .filter((hit) => hit.kind === 'memory');
    assert.deepEqual(memories, [], 'no version of any of them is found, history included');
  });
});

describe('removal without forget', () => {
  test('an imported note removed from its file brings back what was merged into it', () => {
    const tP = pastTurn('n-b', 'we use pnpm');
    const imported = createMemory({ ownerUserId: ME }, { scope: { kind: 'user' }, kind: 'convention', body: 'Use pnpm, never npm.', status: 'active', origin: 'extracted' });
    getDb().prepare("UPDATE memories SET import_source = 'claude', import_ref = 'proj/MEMORY.md' WHERE id = ?").run(imported.id);
    const p = noted('用户用 pnpm', 'n-b', tP, { kind: 'convention' });
    const merged = merge(p, imported);
    const seen = events();
    deleteMemory({ ownerUserId: ME }, imported.id); // what the import does when the item left its file
    assert.deepEqual(state(p.id), { status: 'active', mergedIntoId: null, version: merged.version + 1 });
    assert.ok(seen.some((event) => event.memoryId === p.id && event.action === 'updated'));
    assert.equal(tombstonedTurn(tP), false, 'restoring never writes a tombstone');
    assert.equal(hidden(tP), false);
  });

  test('a conversation leaving learn: a predecessor from another conversation comes back, one from the same goes', () => {
    const tX = pastTurn('n-x', 'I work at Acme');
    const tX2 = pastTurn('n-x', 'Acme is where I work');
    const tY = pastTurn('n-y', '我在 Acme 工作');
    const target = noted('The user works at Acme.', 'n-x', tX);
    const fromX = noted('The user\'s employer is Acme.', 'n-x', tX2);
    const fromY = noted('用户在 Acme 工作', 'n-y', tY);
    merge(fromX, target);
    merge(fromY, target);
    const change = setConversationMemoryMode({ ownerUserId: ME }, 'n-x', 'use_only');
    assert.equal(change.removedMemories, 1, 'the put-away note is not counted');
    assert.equal(state(target.id), null);
    assert.equal(state(fromX.id), null);
    assert.equal(state(fromY.id)?.status, 'active');
    assert.equal(state(fromY.id)?.mergedIntoId, null);
  });

  test('Don\'t recall on a put-away note\'s own excerpt hides that excerpt only: when the note it went into leaves, the note comes back', () => {
    const tY = pastTurn('n-y', 'I play the cello on Tuesdays');
    const tX = pastTurn('n-x', '我每周二拉大提琴');
    const x = noted('用户每周二拉大提琴', 'n-x', tX);
    const y = noted('The user plays the cello on Tuesdays.', 'n-y', tY);
    merge(y, x);
    const docId = (getDb().prepare("SELECT id FROM memory_recall_docs WHERE doc_kind = 'turn' AND ref_id = ?").get(tY) as { id: number }).id;
    assert.equal(forgetConversationTurn({ ownerUserId: ME, docId, workspaceIds: 'all', includeUserScope: true, currentWorkspaceId: 'ws' }), true);
    assert.ok(hidden(tY));
    setConversationMemoryMode({ ownerUserId: ME }, 'n-x', 'use_only');
    assert.equal(state(x.id), null, 'Michi\'s note of a conversation that left Learn goes');
    assert.equal(state(y.id)?.status, 'active', 'the note put away into it comes back, not deleted');
    assert.equal(state(y.id)?.mergedIntoId, null);
  });

  test('a predecessor whose own source no longer learns is removed, and the rule recurses into what was merged into it', () => {
    const tA = pastTurn('n-a', 'A');
    const tB = pastTurn('n-b', 'B');
    const tC = pastTurn('n-c', 'C');
    const imported = createMemory({ ownerUserId: ME }, { scope: { kind: 'user' }, kind: 'fact', body: 'The user has two cats.', status: 'active', origin: 'extracted' });
    getDb().prepare("UPDATE memories SET import_source = 'codex', import_ref = 'memories/cats.md' WHERE id = ?").run(imported.id);
    const b = noted('The user owns two cats.', 'n-b', tB);
    const c = noted('用户养了两只猫', 'n-c', tC);
    const a = noted('Two cats live with the user.', 'n-a', tA);
    merge(c, b);
    merge(b, imported);
    merge(a, imported);
    getDb().prepare("UPDATE nodes SET memory_mode = 'off' WHERE id = 'n-b'").run();
    deleteMemory({ ownerUserId: ME }, imported.id);
    assert.equal(state(b.id), null, 'its conversation is off: removed');
    assert.equal(state(c.id)?.status, 'active', 'what was merged into it comes back');
    assert.equal(state(a.id)?.status, 'active');
  });
});

describe('the read side', () => {
  test('currentCorrection follows merges and corrections; memory_search names the current note; memory_update and memory_delete say where to go', () => {
    const t1 = pastTurn('n-a', 'I moved to Nakano');
    const t2 = pastTurn('n-b', 'I live in Meguro');
    const nakano = noted('The user lives in Nakano, Tokyo.', 'n-a', t1, { keywords: ['Tokyo'] });
    const meguro = noted('The user lives in Meguro, Tokyo.', 'n-b', t2, { keywords: ['Tokyo'], observedAt: now - 60 * DAY });
    merge(meguro, nakano);
    assert.equal(currentCorrection(ME, meguro.id)?.record.id, nakano.id);
    const corrected = supersedeMemory({ ownerUserId: ME }, nakano.id, { body: 'The user lives in Nakano 3-chome, Tokyo.', status: 'active', origin: 'extracted' });
    assert.equal(currentCorrection(ME, meguro.id)?.record.id, corrected.id, 'through the merge, then the correction');

    chat('n-chat');
    const caller = { ownerUserId: null, workspaceId: 'ws', nodeId: 'n-chat', isAgentRun: false };
    getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, last_seq, started_at, updated_at)
      VALUES ('t-live', 'n-chat', NULL, 'a-t-live', 'active', 0, ?, ?)`).run(now, now);
    // A note put away is history: memory_search returns it only when the agent asks for history.
    const current = JSON.parse(memoryTool('memory_search', caller, { query: 'Meguro' }).content[0]!.text);
    assert.equal(current.results.some((result: { type: string }) => result.type === 'memory'), false, JSON.stringify(current.results));
    const search = JSON.parse(memoryTool('memory_search', caller, { query: 'Meguro', history: true }).content[0]!.text);
    const old = search.results.find((result: { type: string; text: string }) => result.type === 'memory' && result.text.includes('Meguro'));
    assert.equal(old.status, 'superseded');
    assert.equal(old.current, refOf(corrected));
    assert.match(search.note, /status superseded: an earlier version, which a later note replaced \(current names that note\)/u);
    // An earlier note a later one replaced is history: it is not corrected (that would change the current value) ...
    const update = memoryTool('memory_update', caller, { ref: refOf(meguro), body: 'The user lives in Meguro.' });
    assert.equal(update.isError, true);
    assert.match(update.content[0]!.text, new RegExp(`^INVALID_STATE: that memory is an earlier note that a later one, ${refOf(corrected)}, replaced; `
      + `it is kept as history and cannot be corrected\\. If what the user corrects is the current value, correct that note \\(pass ref ${refOf(corrected)}\\); `
      + 'to forget the earlier note, call memory_delete with its ref\\.$', 'u'));
    // ... and it can be forgotten alone: the current note stays, and so do the conversations.
    const remove = JSON.parse(memoryTool('memory_delete', caller, { ref: refOf(meguro) }).content[0]!.text);
    assert.equal(remove.status, 'deleted');
    assert.equal(state(meguro.id), null);
    assert.equal(state(corrected.id)?.status, 'active');
    assert.equal(hidden(t2), false);
    assert.ok(tombstonedTurn(t2), 'extraction never saves it again from its turn');
    // A correction's earlier version is not a memory of its own: deleting it still points at the current one.
    const versionRemove = memoryTool('memory_delete', caller, { ref: refOf(nakano) });
    assert.match(versionRemove.content[0]!.text, new RegExp(`^INVALID_STATE: that memory was replaced by a later note, ${refOf(corrected)}; delete that one instead`, 'u'));
  });
});

describe('a seeded random sequence', () => {
  /** A small deterministic generator (mulberry32). */
  function random(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}: protected rows stay byte-identical, every link leads to a row, nothing active rests only on what was forgotten`, () => {
      const next = random(seed);
      const pick = <T>(list: readonly T[]): T | undefined => (list.length ? list[Math.floor(next() * list.length)] : undefined);
      const nodes = ['n-1', 'n-2', 'n-3', 'n-4'];
      for (const nodeId of nodes) chat(nodeId);
      const protectedRows = new Map<string, unknown>();
      const snapshot = (id: string) => ({ ...(getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>) });
      const forgotten = new Set<string>();
      const active = () => (getDb().prepare("SELECT id, origin, import_source, user_edited_at FROM memories WHERE status = 'active'").all() as
        Array<{ id: string; origin: string; import_source: string | null; user_edited_at: number | null }>);
      for (let step = 0; step < 160; step += 1) {
        now += 60_000;
        const roll = next();
        const notes = active();
        const michi = notes.filter((row) => row.origin === 'extracted' && !row.import_source && !row.user_edited_at);
        if (roll < 0.35 || notes.length < 3) {
          const nodeId = pick(nodes)!;
          const turnId = pastTurn(nodeId, `fact ${step}`);
          const kind = next() < 0.2 ? 'explicit' : next() < 0.3 ? 'import' : 'michi';
          const record = createMemory({ ownerUserId: ME }, {
            scope: { kind: 'user' }, kind: 'fact', body: `Fact number ${step} about the user.`, status: 'active',
            origin: kind === 'explicit' ? 'explicit' : 'extracted', source: kind === 'import' ? null : { nodeId, turnId }, observedAt: now,
          });
          if (kind === 'import') getDb().prepare("UPDATE memories SET import_source = 'claude', import_ref = ? WHERE id = ?").run(`p/${step}`, record.id);
          if (kind !== 'michi') protectedRows.set(record.id, snapshot(record.id));
        } else if (roll < 0.6) {
          // A merge as consolidation applies it: a Michi note into another active note.
          const from = pick(michi);
          const into = pick(notes.filter((row) => row.id !== from?.id));
          if (from && into) {
            const current = consolidationRows(ME, [from.id])[0]!;
            mergeMemoryInto(ME, current.record, into.id, now);
          }
        } else if (roll < 0.7) {
          const target = pick(michi);
          if (target) supersedeMemory({ ownerUserId: ME }, target.id, { body: `Corrected at ${step}.`, status: 'active', origin: 'extracted' });
        } else if (roll < 0.82) {
          const target = pick(notes);
          if (target) {
            for (const record of forgetMemory({ ownerUserId: ME }, target.id).removed) {
              forgotten.add(record.id);
              protectedRows.delete(record.id);
            }
          }
        } else if (roll < 0.9) {
          const nodeId = pick(nodes)!;
          setConversationMemoryMode({ ownerUserId: ME }, nodeId, 'use_only');
          setConversationMemoryMode({ ownerUserId: ME }, nodeId, 'learn');
        } else {
          const imported = pick(notes.filter((row) => row.import_source));
          if (imported) {
            deleteMemory({ ownerUserId: ME }, imported.id);
            protectedRows.delete(imported.id);
          }
        }
        // Invariants after every step.
        for (const [id, before] of protectedRows) {
          if (!consolidationRows(ME, [id])[0]) { protectedRows.delete(id); continue; }
          const row = snapshot(id);
          // A protected row may become an into; it is never changed itself.
          assert.deepEqual(row, before, `protected ${id} changed at step ${step}`);
        }
        const links = getDb().prepare(`SELECT m.id, m.merged_into_id FROM memories m WHERE m.merged_into_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM memories o WHERE o.id = m.merged_into_id)`).all();
        assert.deepEqual(links, [], `a merge link leads nowhere at step ${step}`);
        const linkedActive = getDb().prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'active' AND merged_into_id IS NOT NULL").get() as { n: number };
        assert.equal(linkedActive.n, 0, 'an active note never keeps a merge link');
        for (const id of forgotten) assert.equal(consolidationRows(ME, [id])[0], undefined, `forgotten ${id} came back at step ${step}`);
      }
    });
  }
});
