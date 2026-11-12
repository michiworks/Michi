import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryRecord } from 'michi-shared';
import { formatThreadMessage } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  createMemory,
  deleteMemory,
  forgetMemory,
  setMemorySettings,
  supersedeMemory,
  type CreateMemoryInput,
} from '../src/services/memory/memoryService';
import { typedTextOfTurn } from '../src/services/memory/typedText';
import { indexTurn } from '../src/services/memory/recallIndex';
import { attributeTurn, resetReplySources } from '../src/services/memory/replySources';
import { MemoryInjector } from '../src/agents/memoryInjection';
import {
  buildMetadataSystemPrompt,
  buildStableSystemPrompt,
  type MetadataOutputMode,
  type ToolCapabilities,
} from '../src/agents/preamble';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession, AgentTurnInput } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { runOwner } from './helpers/owners';

const alice = { ownerUserId: 'alice' };
const bob = { ownerUserId: 'bob' };
/** Friday 2026-11-06, noon local time. */
const NOW = new Date(2026, 10, 6, 12).getTime();

let dataDir: string;
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };

function seedWorkspace(id: string, ownerUserId: string | null, settings: string | null = null): void {
  getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, settings, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
    .run(id, 'Project', ownerUserId, settings);
}

/** An explicit preference unless `extra` says otherwise: what "Saved by the user" shows. */
function remember(caller: { ownerUserId: string }, body: string, extra: Partial<CreateMemoryInput> = {}): MemoryRecord {
  return createMemory(caller, { scope: { kind: 'user' }, kind: 'preference', body, status: 'active', origin: 'explicit', ...extra });
}

function inWorkspace(workspaceId: string) {
  return { scope: { kind: 'workspace' as const, workspaceId } };
}

function fakeSession(id: string, owner: AgentSession['owner'] = { mode: 'interactive', key: id }): AgentSession {
  return {
    id, owner, runtimeId: 'fake', getHistory: () => [], getPendingAssistant: () => undefined, cancel: () => {},
    send: () => { throw new Error('not sent in this test'); },
  };
}

function injector(): MemoryInjector {
  return new MemoryInjector({ now: () => NOW });
}

/** prepare() and, when it returns a block, deliver it: one completed turn. */
function completedTurn(memory: MemoryInjector, session: AgentSession, ownerUserId: string | null, workspaceId: string, query = ''): string | null {
  const prepared = memory.prepare({ session, ownerUserId, workspaceId, query });
  prepared?.delivered();
  return prepared?.text ?? null;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-injection-'));
  process.env.MICHI_DATA_DIR = dataDir;
  process.env.MICHI_CLOUD = '1';
  closeDb();
  initDb();
  seedWorkspace('ws-alice-1', 'alice');
  seedWorkspace('ws-alice-2', 'alice');
  seedWorkspace('ws-bob', 'bob');
  // The owners' profiles have read every note these tests write (stored at the latest time a Date holds): no note is
  // one of Michi's newest notes, which a pack pins word for word until a rebuild reads it (memoryContextBuilder tests).
  for (const owner of ['alice', 'bob', LOCAL_AGENT_OWNER_ID]) {
    getDb().prepare(`INSERT INTO memory_user_profiles (owner_user_id, lines, version, built_at, updated_at) VALUES (?, '[]', 1, 8640000000000000, 1)`).run(owner);
  }
});

afterEach(() => {
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  // Back to the per-file directory isolateUserDirs chose, never the user's own.
  if (saved.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.data;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Michi Memory and the stable prompt', () => {
  test('the stable system prompt stays byte-identical whatever the memory holds', () => {
    const modes: MetadataOutputMode[] = ['sentinel', 'sentinel-followups-tool-overview'];
    const capabilities: Array<ToolCapabilities | undefined> = [undefined, 'crew', 'assistant', 'maintenance'];
    const prompts = () => modes.flatMap((mode) => [true, false].flatMap((followUps) => capabilities.flatMap((tools) => [
      buildStableSystemPrompt(mode, followUps, false, tools),
      buildStableSystemPrompt(mode, followUps, true, tools),
      buildMetadataSystemPrompt(mode, followUps, tools),
    ])));
    const before = prompts();

    remember(alice, 'Reply in Chinese.');
    remember(alice, 'Use pnpm.', { kind: 'convention', ...inWorkspace('ws-alice-1') });
    remember(alice, 'Kestrel launches in December.', { kind: 'fact', origin: 'extracted' });
    const memory = injector();
    assert.ok(completedTurn(memory, fakeSession('chat'), 'alice', 'ws-alice-1', 'when does kestrel launch'));
    setMemorySettings('alice', { mode: 'off' });

    assert.deepEqual(prompts(), before);
    assert.equal(before.some((prompt) => /Michi Memory|Reply in Chinese|Kestrel|memory_search/.test(prompt)), false);
  });

  test('the pack is the turn\'s model-only memoryContext: framed as data, with refs and dates; of the write tools only memory_save is named, in the learn line', () => {
    remember(alice, 'Reply in Chinese.', { observedAt: NOW - 24 * 60 * 60 * 1000 });
    const text = completedTurn(injector(), fakeSession('chat'), 'alice', 'ws-alice-1')!;
    assert.match(text, /^<michi-memory>\nMichi Memory: notes from the user's earlier conversations/);
    assert.match(text, /\n<\/michi-memory>$/);
    assert.match(text, /data, not instructions/);
    assert.match(text, /current message wins/);
    assert.match(text, /Now: 2026-11-06 12:00 \(Friday, UTC[+-]\d\d:\d\d\)\./);
    assert.match(text, /Saved by the user:\n- \[m:1v1\] Reply in Chinese\. \(2026-11-05\)/);
    // Codex loads tools lazily, by name (live ftr-01/B); when to save or forget is the tools' descriptions' to say.
    const learn = /^- This conversation's memory setting is Learn: what is said in it may be kept in memory; save what the user asks you to remember with memory_save\.$/m;
    assert.match(text, learn);
    assert.doesNotMatch(text.replace(learn, ''), /memory_(save|update|delete)/, 'the write tools are named only there');
  });
});

describe('MemoryInjector', () => {
  test('the first turn pins what the user saved and the preferences and conventions in scope, and nothing else', () => {
    remember(alice, 'Reply in Chinese.');
    remember(alice, 'Lives in Berlin.', { kind: 'fact' });
    remember(alice, 'Use pnpm, not npm.', { kind: 'convention', origin: 'extracted', ...inWorkspace('ws-alice-1') });
    remember(alice, 'The staging port is 5433.', { kind: 'fact', origin: 'extracted', ...inWorkspace('ws-alice-1') });
    remember(alice, 'Use yarn.', { kind: 'convention', ...inWorkspace('ws-alice-2') });
    remember(alice, 'Pending until approved.', { status: 'pending' });
    remember(bob, 'Bob likes tabs.');

    const text = completedTurn(injector(), fakeSession('chat'), 'alice', 'ws-alice-1')!;
    assert.ok(text.includes('Reply in Chinese.') && text.includes('Lives in Berlin.') && text.includes('Use pnpm, not npm.'));
    assert.ok(text.indexOf('Saved by the user:') < text.indexOf('Preferences and conventions Michi noted on its own:'));
    assert.ok(text.indexOf('Lives in Berlin.') < text.indexOf('Use pnpm, not npm.'));
    for (const absent of ['5433', 'Use yarn.', 'Pending until approved.', 'Bob likes tabs.']) {
      assert.equal(text.includes(absent), false, absent);
    }
  });

  test('an unchanged memory is not sent again; a change resends the pinned sections whole, marked updated', () => {
    remember(alice, 'Reply in Chinese.');
    const memory = injector();
    const session = fakeSession('chat');
    assert.ok(completedTurn(memory, session, 'alice', 'ws-alice-1'));
    assert.equal(completedTurn(memory, session, 'alice', 'ws-alice-1'), null);
    assert.equal(completedTurn(memory, session, 'alice', 'ws-alice-1'), null);

    remember(alice, 'Use pnpm.', { kind: 'convention', ...inWorkspace('ws-alice-1') });
    const refreshed = completedTurn(memory, session, 'alice', 'ws-alice-1')!;
    assert.ok(refreshed.includes('Use pnpm.'));
    assert.ok(refreshed.includes('Reply in Chinese.'), 'the whole section again');
    assert.match(refreshed, /Michi Memory, updated:/);
    assert.equal(completedTurn(memory, session, 'alice', 'ws-alice-1'), null);

    // Another workspace's change is not this session's.
    remember(alice, 'Use yarn.', { kind: 'convention', ...inWorkspace('ws-alice-2') });
    assert.equal(completedTurn(memory, session, 'alice', 'ws-alice-1'), null);
  });

  test('a conversation whose memory setting is off reads no memory; use only still does', () => {
    remember(alice, 'Reply in Chinese.');
    getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at, memory_mode) VALUES ('n-off', 'ws-alice-1', 'chat', 'idle', 1, 'off')").run();
    getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at, memory_mode) VALUES ('n-use', 'ws-alice-1', 'chat', 'idle', 1, 'use_only')").run();
    const memory = injector();
    assert.equal(memory.prepare({ session: fakeSession('n-off'), ownerUserId: 'alice', workspaceId: 'ws-alice-1', nodeId: 'n-off' }), null);
    assert.match(memory.prepare({ session: fakeSession('n-use'), ownerUserId: 'alice', workspaceId: 'ws-alice-1', nodeId: 'n-use' })!.text, /Reply in Chinese\./);
  });

  test('a conversation set to off mid-session is told once that the notes it holds no longer apply; back to learn it gets them all again', () => {
    remember(alice, 'Reply in Chinese.');
    getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-later-off', 'ws-alice-1', 'chat', 'idle', 1)").run();
    const memory = injector();
    const session = fakeSession('n-later-off');
    const turn = () => {
      const prepared = memory.prepare({ session, ownerUserId: 'alice', workspaceId: 'ws-alice-1', nodeId: 'n-later-off' });
      prepared?.delivered();
      return prepared?.text ?? null;
    };
    assert.match(turn()!, /Reply in Chinese\./);
    getDb().prepare("UPDATE nodes SET memory_mode = 'off' WHERE id = 'n-later-off'").run();
    const off = turn()!;
    // What the setting means: the notes held no longer apply, nothing is read here, nothing said here is kept, what was saved stays.
    for (const meaning of [/Michi Memory is off in this conversation/, /none of the notes shown earlier in it apply any more/,
      /memory and other conversations are not read here/, /nothing said in it goes into memory/, /saved before stay until they delete them in Settings → Memory/]) {
      assert.match(off, meaning);
    }
    assert.equal(off.includes('Reply in Chinese.'), false);
    assert.equal(turn(), null, 'said once');
    getDb().prepare("UPDATE nodes SET memory_mode = NULL WHERE id = 'n-later-off'").run();
    assert.match(turn()!, /Reply in Chinese\./, 'back to learn: everything again');
  });

  test('a turn that never completed sends the block again', () => {
    remember(alice, 'Reply in Chinese.');
    const memory = injector();
    const session = fakeSession('chat');
    assert.ok(memory.prepare({ session, ownerUserId: 'alice', workspaceId: 'ws-alice-1' }), 'not delivered');
    assert.ok(completedTurn(memory, session, 'alice', 'ws-alice-1'));
    assert.equal(completedTurn(memory, session, 'alice', 'ws-alice-1'), null);
  });

  test('a deleted or corrected memory: the pinned sections come again as they are now, with no per-ref withdrawals', () => {
    const chinese = remember(alice, 'Reply in Chinese.');
    const pnpm = remember(alice, 'Use pnpm.', { kind: 'convention', ...inWorkspace('ws-alice-1') });
    const memory = injector();
    const session = fakeSession('chat');
    assert.ok(completedTurn(memory, session, 'alice', 'ws-alice-1')!.includes('[m:2v1] Use pnpm.'));

    deleteMemory(alice, pnpm.id);
    const afterDelete = completedTurn(memory, session, 'alice', 'ws-alice-1')!;
    assert.match(afterDelete, /Michi Memory, updated:/);
    assert.equal(afterDelete.includes('Use pnpm.'), false);
    assert.ok(afterDelete.includes('Reply in Chinese.'));
    assert.equal(afterDelete.includes('withdrawn'), false);

    supersedeMemory(alice, chinese.id, { body: 'Reply in English.', status: 'active', origin: 'explicit' });
    const afterCorrection = completedTurn(memory, session, 'alice', 'ws-alice-1')!;
    assert.match(afterCorrection, /Saved by the user:\n- \[m:3v1\] Reply in English\./);
    assert.equal(afterCorrection.includes('Reply in Chinese.'), false);
    assert.equal(completedTurn(memory, session, 'alice', 'ws-alice-1'), null, 'sent once');
  });

  test('mode off sends nothing to a new session and withdraws what a session holds', () => {
    remember(alice, 'Reply in Chinese.');
    const memory = injector();
    const earlier = fakeSession('earlier');
    assert.ok(completedTurn(memory, earlier, 'alice', 'ws-alice-1'));

    setMemorySettings('alice', { mode: 'off' });
    const fresh = fakeSession('fresh');
    assert.equal(completedTurn(memory, fresh, 'alice', 'ws-alice-1'), null);
    assert.equal(completedTurn(memory, fresh, 'alice', 'ws-alice-1'), null);
    const off = completedTurn(memory, earlier, 'alice', 'ws-alice-1')!;
    assert.match(off, /Michi Memory is turned off/);
    assert.equal(off.includes('Reply in Chinese.'), false);
    assert.equal(completedTurn(memory, earlier, 'alice', 'ws-alice-1'), null);

    setMemorySettings('alice', { mode: 'explicit' });
    assert.ok(completedTurn(memory, earlier, 'alice', 'ws-alice-1')!.includes('Reply in Chinese.'));
    assert.ok(completedTurn(memory, fresh, 'alice', 'ws-alice-1')!.includes('Reply in Chinese.'));
  });

  test('after forget (a compaction) the block is sent again, and a compaction during the turn keeps it from counting', () => {
    remember(alice, 'Reply in Chinese.');
    const memory = injector();
    const session = fakeSession('chat');
    assert.ok(completedTurn(memory, session, 'alice', 'ws-alice-1'));
    memory.forget(session);
    assert.ok(completedTurn(memory, session, 'alice', 'ws-alice-1'));

    const prepared = memory.prepare({ session, ownerUserId: 'alice', workspaceId: 'ws-alice-1' });
    assert.equal(prepared, null);
    memory.forget(session);
    const midTurn = memory.prepare({ session, ownerUserId: 'alice', workspaceId: 'ws-alice-1' })!;
    memory.forget(session);
    midTurn.delivered();
    assert.ok(completedTurn(memory, session, 'alice', 'ws-alice-1'), 'compacted away during its own turn');
  });

  test('related notes follow the query every turn, each only once', () => {
    remember(alice, 'Kestrel launches on 2026-12-01.', { kind: 'fact', origin: 'extracted' });
    const memory = injector();
    const session = fakeSession('chat');
    // A fact is not pinned: the first turn frames the session, and "hello" does not match it.
    const first = completedTurn(memory, session, 'alice', 'ws-alice-1', 'hello')!;
    assert.match(first, /No notes apply yet\./);
    assert.equal(first.includes('Kestrel launches'), false);
    const related = completedTurn(memory, session, 'alice', 'ws-alice-1', 'when does kestrel launch?')!;
    assert.match(related, /Related to this message:\n- \[m:1v1\] Kestrel launches on 2026-12-01\./);
    assert.equal(completedTurn(memory, session, 'alice', 'ws-alice-1', 'kestrel launch'), null);
  });

  test('a thread that moves keeps what it holds of the user scope and gets the new workspace\'s notes', () => {
    remember(alice, 'Reply in Chinese.');
    remember(alice, 'Use pnpm.', { kind: 'convention', ...inWorkspace('ws-alice-1') });
    remember(alice, 'Use yarn.', { kind: 'convention', ...inWorkspace('ws-alice-2') });
    const memory = injector();
    const session = fakeSession('chat');
    assert.ok(completedTurn(memory, session, 'alice', 'ws-alice-1'));
    const moved = completedTurn(memory, session, 'alice', 'ws-alice-2')!;
    assert.match(moved, /Michi Memory, updated:/);
    assert.match(moved, /Use yarn\./);
    assert.equal(moved.includes('Use pnpm.'), false, 'the old workspace\'s note is not in the new section');
    assert.ok(moved.includes('Reply in Chinese.'), 'the user scope comes with the whole section');
  });

  test('every live session object is tracked on its own: a rebuilt or resumed session gets the block', () => {
    remember(alice, 'Reply in Chinese.');
    const memory = injector();
    const original = fakeSession('chat');
    assert.ok(completedTurn(memory, original, 'alice', 'ws-alice-1'));
    assert.equal(completedTurn(memory, original, 'alice', 'ws-alice-1'), null);
    const rebuilt = fakeSession('chat');
    assert.ok(completedTurn(memory, rebuilt, 'alice', 'ws-alice-1'));
  });

  test('owner and workspace are the turn\'s own: no other owner\'s memory, workspace or ownerless turn', () => {
    remember(alice, 'Alice reply style.');
    remember(alice, 'Alice convention.', { kind: 'convention', ...inWorkspace('ws-alice-1') });
    remember(bob, 'Bob reply style.');
    const memory = injector();

    const bobText = completedTurn(memory, fakeSession('bob-chat'), 'bob', 'ws-bob')!;
    assert.ok(bobText.includes('Bob reply style.'));
    assert.equal(bobText.includes('Alice'), false);
    assert.equal(completedTurn(memory, fakeSession('intruder'), 'alice', 'ws-bob'), null, 'not the owner\'s workspace');
    assert.equal(completedTurn(memory, fakeSession('anonymous'), null, 'ws-alice-1'), null, 'no owner in cloud mode');
    assert.equal(completedTurn(memory, fakeSession('missing'), 'alice', 'ws-gone'), null);
    assert.equal(completedTurn(memory, fakeSession('attempt-1', runOwner('run-1', 'attempt-1')), 'alice', 'ws-alice-1'), null,
      'Agent Runs get no memory');
  });

  test('on the desktop the local user owns memory; V, the assistant conversation, reads the user scope only, with its memory tools named', () => {
    delete process.env.MICHI_CLOUD;
    seedWorkspace('ws-assistant', null, JSON.stringify({ system: 'assistant' }));
    seedWorkspace('ws-local', null);
    const local = { ownerUserId: LOCAL_AGENT_OWNER_ID };
    remember(local, 'Reply in Chinese.');
    remember(local, 'Use pnpm.', { kind: 'convention', ...inWorkspace('ws-local') });
    remember(local, 'Assistant workspace note.', { kind: 'convention', ...inWorkspace('ws-assistant') });
    const memory = injector();

    const chat = completedTurn(memory, fakeSession('chat'), null, 'ws-local')!;
    assert.ok(chat.includes('Reply in Chinese.') && chat.includes('Use pnpm.'));
    const assistant = completedTurn(memory, fakeSession('assistant'), null, 'ws-assistant')!;
    assert.ok(assistant.includes('Reply in Chinese.'));
    assert.equal(assistant.includes('Use pnpm.') || assistant.includes('Assistant workspace note.'), false);
    assert.match(assistant, /memory_search searches every note and past conversations/);
  });

  test('no other conversation of the assistant\'s workspace gets a pack here: a check-in passes its own', () => {
    delete process.env.MICHI_CLOUD;
    seedWorkspace('ws-assistant', null, JSON.stringify({ system: 'assistant' }));
    seedWorkspace('ws-local', null);
    for (const id of ['n-v', 'n-cmph-run-1', 'n-mvp']) {
      getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES (?, 'ws-assistant', 'chat', 'idle', 1)").run(id);
    }
    // The MVP Companion's conversation, as identity.ts reads it: closed, as a check-in is.
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('assistant:purpose:n-mvp', 'companion')").run();
    remember({ ownerUserId: LOCAL_AGENT_OWNER_ID }, 'Reply in Chinese.');
    const memory = injector();
    const prepare = (nodeId: string, workspaceId = 'ws-assistant') => memory.prepare({ session: fakeSession(nodeId), ownerUserId: null, workspaceId, nodeId, query: 'chinese' });
    assert.match(prepare('n-v')!.text, /Reply in Chinese\./);
    assert.equal(prepare('n-cmph-run-1'), null);
    assert.equal(prepare('n-mvp'), null);
    assert.equal(prepare('n-cmph-run-2', 'ws-local'), null, 'a check-in node, wherever it is said to run');
  });

  test('V follows its own memory setting: Use only is told nothing said there is kept; Off is a temporary chat, told once that what it held no longer applies', () => {
    delete process.env.MICHI_CLOUD;
    seedWorkspace('ws-assistant', null, JSON.stringify({ system: 'assistant' }));
    getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-v', 'ws-assistant', 'chat', 'idle', 1)").run();
    remember({ ownerUserId: LOCAL_AGENT_OWNER_ID }, 'Reply in Chinese.');
    const memory = injector();
    const session = fakeSession('n-v');
    const turn = (live = session) => {
      const prepared = memory.prepare({ session: live, ownerUserId: null, workspaceId: 'ws-assistant', nodeId: 'n-v' });
      prepared?.delivered();
      return prepared?.text ?? null;
    };
    assert.match(turn()!, /\n- This conversation's memory setting is Learn: what is said in it may be kept in memory/);
    const setting = (mode: string | null) => getDb().prepare('UPDATE nodes SET memory_mode = ? WHERE id = ?').run(mode, 'n-v');
    setting('use_only');
    assert.match(turn()!, /Michi Memory: this conversation's memory setting changed\.\n- This conversation's memory setting is Use only: these notes may be used, but nothing said in it goes into memory/);
    setting('off');
    const off = turn()!;
    assert.match(off, /^<michi-memory>\nMichi Memory is off in this conversation: none of the notes shown earlier in it apply any more/);
    assert.equal(off.includes('Reply in Chinese.'), false);
    assert.equal(turn(), null, 'said once');
    assert.equal(turn(fakeSession('n-v')), null, 'a new session of an Off V reads no memory');
  });
});

// ── ChatHub: which turns carry the block ───────────────────────────────────

function iterator(events: NormalizedEvent[]): AsyncIterableIterator<NormalizedEvent> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() { return index < events.length ? { done: false, value: events[index++]! } : { done: true, value: undefined }; },
  };
}

interface RecordingSession extends AgentSession {
  inputs: Array<AgentTurnInput | undefined>;
  /** Events the next turn yields; one completed turn by default. */
  next: NormalizedEvent[] | null;
  /** Called while a turn runs, before its events. */
  during?: () => void;
}

function recordingSession(id: string): RecordingSession {
  const session: RecordingSession = {
    id, owner: { mode: 'interactive', key: id }, runtimeId: 'fake', inputs: [], next: null,
    getHistory: () => [], getPendingAssistant: () => undefined, cancel: () => {},
    compact: async () => ({ started: true, completed: true }),
    send: (_text, input) => {
      session.inputs.push(input);
      session.during?.();
      const events = session.next ?? [{ kind: 'turn_end', stopReason: 'end_turn' }];
      session.next = null;
      return iterator(events);
    },
  };
  return session;
}

function memoryHub(): ChatHub {
  return new ChatHub({
    retentionMs: 50,
    workspaceIdForNode: () => 'ws-alice-1',
    lookupDurableTurn: () => null,
    pageManifestBuilder: () => '',
    persistence: { begin: () => {}, checkpoint: () => {}, finalize: () => {} },
    memoryInjector: injector(),
  });
}

async function turn(hub: ChatHub, session: RecordingSession, text = 'hello', extra: { displayText?: string; humanOrigin?: boolean; turnId?: string } = {}): Promise<string | undefined> {
  const started = await hub.startTurn({ chatId: session.id, nodeId: session.id, text, session, ownerUserId: 'alice', ...extra });
  await started.done;
  return session.inputs.at(-1)?.memoryContext;
}

describe('a delivered pack and a forgotten memory', () => {
  test('deleting a memory the turn was given leaves the conversations that repeated it as they are: chat history', () => {
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, parent_node_id, kind, title, status, created_at)
      VALUES ('n-chat', 'ws-alice-1', NULL, 'chat', 'PR habits', 'idle', 1)`).run();
    // An imported note: Michi's own, with no conversation turn it came from.
    const imported = createMemory(alice, { scope: { kind: 'user' }, kind: 'preference', body: 'Keep each PR under 250 changed lines.',
      status: 'active', origin: 'extracted', keywords: ['PR size', '250 lines'] });
    const memory = injector();
    const session = fakeSession('chat');
    const prepared = memory.prepare({ session, ownerUserId: 'alice', workspaceId: 'ws-alice-1', nodeId: 'n-chat', turnId: 't-1', query: 'how big should a PR be' });
    assert.ok(prepared?.text?.includes('250 changed lines'), prepared?.text);
    prepared!.delivered();
    const at = Date.now();
    assert.equal(indexTurn({ ownerUserId: 'alice', nodeId: 'n-chat', turnId: 't-1', humanOrigin: true, userText: 'How big should a PR be?',
      assistantText: 'Under 250 changed lines per PR, as you prefer.', completedAt: at, userMessageAt: at }), true);
    forgetMemory(alice, imported.id);
    const hidden = (getDb().prepare("SELECT hidden FROM memory_recall_docs WHERE doc_kind = 'turn' AND ref_id = 't-1'").get() as { hidden: number }).hidden;
    assert.equal(hidden, 0, 'the reply stays recallable, as ChatGPT and Claude keep chat history');
    // The memory itself is gone from every pack.
    const next = injector().prepare({ session: fakeSession('chat'), ownerUserId: 'alice', workspaceId: 'ws-alice-1', nodeId: 'n-other', query: 'how big should a PR be' });
    assert.equal(next?.text?.includes('Keep each PR under 250 changed lines.') ?? false, false, next?.text);
  });
});

describe('what a reply was based on (replySources.ts)', () => {
  test('a delivered pack is what the reply may be based on; the model is never told; an Off conversation drops it', () => {
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, parent_node_id, kind, title, status, created_at)
      VALUES ('n-chat', 'ws-alice-1', NULL, 'chat', 'PR habits', 'idle', 1)`).run();
    const prSize = createMemory(alice, { scope: { kind: 'user' }, kind: 'preference', body: 'Keep each PR under 250 changed lines.',
      status: 'active', origin: 'explicit', keywords: ['PR size', '250 lines'] });
    resetReplySources();
    const memory = injector();
    const session = fakeSession('chat');
    const prepared = memory.prepare({ session, ownerUserId: 'alice', workspaceId: 'ws-alice-1', nodeId: 'n-chat', turnId: 't-1', query: 'how big should a PR be' });
    assert.ok(prepared?.text?.includes('250 changed lines'));
    assert.doesNotMatch(prepared!.text, /based on|reply sources/iu, 'nothing about it reaches the model');
    prepared!.delivered();
    const at = Date.now();
    indexTurn({ ownerUserId: 'alice', nodeId: 'n-chat', turnId: 't-1', humanOrigin: true, userText: 'How big should a PR be?',
      assistantText: 'Keep it under 250 changed lines, as you prefer.', completedAt: at, userMessageAt: at });
    const turn = { ownerUserId: 'alice', nodeId: 'n-chat', turnId: 't-1', humanOrigin: true, userText: 'How big should a PR be?',
      assistantText: 'Keep it under 250 changed lines, as you prefer.' };
    assert.deepEqual(attributeTurn(turn)?.used.map((entry) => [entry.id, entry.section]), [[prSize.id, 'saved']]);
    // Off: the retraction drops what the conversation was given.
    getDb().prepare("UPDATE nodes SET memory_mode = 'off' WHERE id = 'n-chat'").run();
    memory.prepare({ session, ownerUserId: 'alice', workspaceId: 'ws-alice-1', nodeId: 'n-chat', turnId: 't-2', query: '' });
    getDb().prepare("UPDATE nodes SET memory_mode = NULL WHERE id = 'n-chat'").run();
    indexTurn({ ownerUserId: 'alice', nodeId: 'n-chat', turnId: 't-2', humanOrigin: true, userText: 'and the PR size?',
      assistantText: 'Under 250 changed lines.', completedAt: at + 1, userMessageAt: at + 1 });
    assert.deepEqual(attributeTurn({ ...turn, turnId: 't-2', userText: 'and the PR size?', assistantText: 'Under 250 changed lines.' })?.used, []);
  });
});

describe('ChatHub Michi Memory turns', () => {
  test('a foreground turn carries the block on the first turn, then only after a change', async () => {
    remember(alice, 'Reply in Chinese.');
    const hub = memoryHub();
    const session = recordingSession('chat');
    assert.match((await turn(hub, session))!, /Reply in Chinese\./);
    assert.equal(await turn(hub, session), undefined);
    remember(alice, 'Use pnpm.', { kind: 'convention', ...inWorkspace('ws-alice-1') });
    assert.match((await turn(hub, session))!, /Use pnpm\./);
    assert.equal(await turn(hub, session), undefined);
    assert.equal(session.inputs.every((input) => input?.pageContext === undefined), true, 'the Pages context stays its own field');
  });

  test('related notes are selected by what the user typed, never by the wire text', async () => {
    remember(alice, 'Kestrel launches on 2026-12-01.', { kind: 'fact', origin: 'extracted' });
    remember(alice, 'Heron is the billing service.', { kind: 'fact', origin: 'extracted' });
    const hub = memoryHub();
    const session = recordingSession('chat');
    const context = await turn(hub, session, '[Spaces context: heron dashboard]\nwhen does kestrel launch?', {
      displayText: 'when does kestrel launch?', humanOrigin: true,
    });
    assert.match(context!, /Kestrel launches on 2026-12-01\./);
    assert.equal(context!.includes('Heron'), false, 'the wire text selects nothing');
  });

  test('V\'s related notes are selected by what the user typed, never by the [COMPANION CONTEXT] its wire text carries', async () => {
    delete process.env.MICHI_CLOUD;
    seedWorkspace('ws-assistant', null, JSON.stringify({ system: 'assistant' }));
    getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-v', 'ws-assistant', 'chat', 'idle', 1)").run();
    const local = { ownerUserId: LOCAL_AGENT_OWNER_ID };
    remember(local, 'Kestrel launches on 2026-12-01.', { kind: 'fact', origin: 'extracted' });
    remember(local, 'Heron is the billing service.', { kind: 'fact', origin: 'extracted' });
    const hub = new ChatHub({
      retentionMs: 50, workspaceIdForNode: () => 'ws-assistant', lookupDurableTurn: () => null, pageManifestBuilder: () => '',
      persistence: { begin: () => {}, checkpoint: () => {}, finalize: () => {} }, memoryInjector: injector(),
    });
    const session = recordingSession('n-v');
    const started = await hub.startTurn({
      chatId: 'n-v', nodeId: 'n-v', session, ownerUserId: null, humanOrigin: true, displayText: 'when does kestrel launch?',
      text: '[COMPANION CONTEXT]\nYour name is Nova. 1 new post: heron billing alert.\n[/COMPANION CONTEXT]\n\nwhen does kestrel launch?',
    });
    await started.done;
    const context = session.inputs.at(-1)?.memoryContext ?? '';
    assert.match(context, /memory_search searches every note and past conversations/);
    assert.match(context, /Related to this message:\n- \[m:\w+\] Kestrel launches on 2026-12-01\./);
    assert.equal(context.includes('Heron'), false, 'the wire text selects nothing');
  });

  test('a scheduled job\'s prompt selects related notes, under the job header; a thread message by its body', async () => {
    remember(alice, 'Kestrel weekly report goes to Mia.', { kind: 'fact', origin: 'extracted' });
    remember(alice, 'Heron is the billing service.', { kind: 'fact', origin: 'extracted' });
    const hub = memoryHub();
    const job = recordingSession('job-chat');
    const run = await hub.startRequestedSelfTurn({
      chatId: job.id, nodeId: job.id, ownerUserId: 'alice', turnId: 'job-run-1',
      text: 'Write the kestrel weekly report\n\n(carry-over: heron notes)', displayText: 'Write the kestrel weekly report',
      userMetadata: { scheduledJobId: 'job-1' }, session: job,
    });
    await run.done;
    const jobContext = job.inputs[0]?.memoryContext ?? '';
    assert.match(jobContext, /for this scheduled run/);
    assert.match(jobContext, /Kestrel weekly report goes to Mia\./);
    assert.equal(jobContext.includes('Heron'), false);
    assert.equal(/michi-memory-request/.test(jobContext), false, 'a job prompt never asks to remember');

    const chat = recordingSession('thread-chat');
    const message = formatThreadMessage({ fromNodeId: 'n-kestrel-parent', fromTitle: 'Kestrel', text: 'Who owns heron billing?' });
    const delivered = await hub.startRequestedSelfTurn({
      chatId: chat.id, nodeId: chat.id, ownerUserId: 'alice', turnId: 'thread-1', text: message, displayText: message, session: chat,
    });
    await delivered.done;
    const threadContext = chat.inputs[0]?.memoryContext ?? '';
    assert.match(threadContext, /Heron is the billing service\./);
    assert.equal(threadContext.includes('Kestrel weekly'), false, 'the message framing selects nothing');
  });

  test('what a person typed is held for the memory tools while the turn runs, then dropped', async () => {
    const hub = memoryHub();
    const session = recordingSession('chat');
    let during: readonly string[] = [];
    session.during = () => { during = typedTextOfTurn('chat', 'typed-1'); };
    await turn(hub, session, 'wire', { displayText: '忘掉我的旧地址', humanOrigin: true, turnId: 'typed-1' });
    assert.deepEqual(during, ['忘掉我的旧地址']);
    assert.deepEqual(typedTextOfTurn('chat', 'typed-1'), []);

    session.during = () => { during = typedTextOfTurn('chat', 'typed-2'); };
    await turn(hub, session, 'forget my address', { turnId: 'typed-2' });
    assert.deepEqual(during, [], 'nothing is held for a turn no person typed');
  });

  test('a compaction event, chatHub.compact or a native command makes the next turn carry the block again', async () => {
    remember(alice, 'Reply in Chinese.');
    const hub = memoryHub();
    const session = recordingSession('chat');
    assert.ok(await turn(hub, session));
    session.next = [{ kind: 'compaction_start' }, { kind: 'compaction_end' }, { kind: 'turn_end', stopReason: 'end_turn' }];
    assert.equal(await turn(hub, session), undefined);
    assert.ok(await turn(hub, session), 'after an automatic compaction');

    assert.deepEqual(await hub.compact(session.id, undefined, session), { started: true, completed: true });
    assert.ok(await turn(hub, session), 'after a requested compaction');

    hub.forgetInjectedMemory(session);
    assert.ok(await turn(hub, session), 'after a native command');
    assert.equal(await turn(hub, session), undefined);
  });

  test('a failed or cancelled turn does not count as delivered', async () => {
    remember(alice, 'Reply in Chinese.');
    const hub = memoryHub();
    const session = recordingSession('chat');
    session.next = [{ kind: 'turn_end', stopReason: 'error' }];
    assert.ok(await turn(hub, session));
    session.next = [{ kind: 'turn_end', stopReason: 'cancelled' }];
    assert.ok(await turn(hub, session));
    assert.ok(await turn(hub, session));
    assert.equal(await turn(hub, session), undefined);
  });

  test('a slash command carries no block, and the turn after it sends the block again', async () => {
    remember(alice, 'Reply in Chinese.');
    const hub = memoryHub();
    const session = recordingSession('chat');
    assert.ok(await turn(hub, session));
    assert.equal(await turn(hub, session, '  /clear'), undefined);
    assert.ok(await turn(hub, session));
  });

  test('ordinary requested turns carry the block; Pages maintenance turns never do', async () => {
    remember(alice, 'Reply in Chinese.');
    const hub = memoryHub();
    const maintenance = recordingSession('maintenance-chat');
    const started = await hub.startRequestedSelfTurn({
      chatId: maintenance.id, nodeId: maintenance.id, ownerUserId: 'alice', turnId: 'maintenance-1',
      text: 'batch', displayText: 'batch', session: maintenance,
      maintenanceContext: {
        workspaceId: 'ws-alice-1', ownerUserId: 'alice', jobId: 'job', runId: 'run', claimedBy: 'test',
        configRevision: 1, planId: 'plan', sources: [],
      },
    });
    await started.done;
    assert.equal(maintenance.inputs[0]?.memoryContext, undefined);
    assert.ok(maintenance.inputs[0]?.maintenanceContext);

    const chat = recordingSession('chat');
    const delivered = await hub.startRequestedSelfTurn({
      chatId: chat.id, nodeId: chat.id, ownerUserId: 'alice', turnId: 'thread-1',
      text: '[Thread message] progress', displayText: '[Thread message] progress', session: chat,
    });
    await delivered.done;
    assert.match(chat.inputs[0]?.memoryContext ?? '', /Reply in Chinese\./);
    const again = await hub.startRequestedSelfTurn({
      chatId: chat.id, nodeId: chat.id, ownerUserId: 'alice', turnId: 'thread-2', text: 'continue', session: chat,
    });
    await again.done;
    assert.equal(chat.inputs[1]?.memoryContext, undefined, 'the first requested turn delivered it');
  });

  test('a hub built for tests sends no memory unless given an injector', async () => {
    remember(alice, 'Reply in Chinese.');
    const hub = new ChatHub({
      retentionMs: 50, workspaceIdForNode: () => 'ws-alice-1', lookupDurableTurn: () => null, pageManifestBuilder: () => '',
      persistence: { begin: () => {}, checkpoint: () => {}, finalize: () => {} },
    });
    assert.equal(await turn(hub, recordingSession('chat')), undefined);
  });
});
