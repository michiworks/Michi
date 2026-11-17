import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { INSTRUCTIONS_REMOVED, InstructionsInjector } from '../src/agents/instructionsInjection';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession, AgentTurnInput } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { runOwner } from './helpers/owners';

let dataDir: string;
const saved = { data: process.env.MICHI_DATA_DIR, cloud: process.env.MICHI_CLOUD };

function seedWorkspace(id: string, settings: Record<string, unknown> = {}): void {
  getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, settings, created_at, updated_at) VALUES (?, ?, NULL, ?, 1, 1)')
    .run(id, 'Project', JSON.stringify(settings));
}

/** What the Manage page saves: '' clears the field. */
function setInstructions(workspaceId: string, instructions: string): void {
  getDb().prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify({ instructions }), workspaceId);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-instructions-injection-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  seedWorkspace('ws-1', { instructions: '  Reply in British English.\n' });
});

afterEach(() => {
  closeDb();
  if (saved.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = saved.cloud;
  if (saved.data === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = saved.data;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

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
}

function recordingSession(id: string, owner: AgentSession['owner'] = { mode: 'interactive', key: id }): RecordingSession {
  const session: RecordingSession = {
    id, owner, runtimeId: 'fake', inputs: [], next: null,
    getHistory: () => [], getPendingAssistant: () => undefined, cancel: () => {},
    compact: async () => ({ started: true, completed: true }),
    send: (_text, input) => {
      session.inputs.push(input);
      const events = session.next ?? [{ kind: 'turn_end', stopReason: 'end_turn' }];
      session.next = null;
      return iterator(events);
    },
  };
  return session;
}

/** A hub whose sessions are new unless `resumed` says a node had turns before. */
function instructionsHub(resumed: (nodeId: string) => boolean = () => false, workspaceId = 'ws-1'): ChatHub {
  return new ChatHub({
    retentionMs: 50,
    workspaceIdForNode: () => workspaceId,
    lookupDurableTurn: () => null,
    pageManifestBuilder: () => '',
    persistence: { begin: () => {}, checkpoint: () => {}, finalize: () => {} },
    memoryInjector: null,
    instructionsInjector: new InstructionsInjector({ nodeHasOtherTurn: (nodeId) => resumed(nodeId) }),
  });
}

async function turn(hub: ChatHub, session: RecordingSession, text = 'hello'): Promise<string | undefined> {
  const started = await hub.startTurn({ chatId: session.id, nodeId: session.id, text, session, ownerUserId: null });
  await started.done;
  return session.inputs.at(-1)?.instructionsContext;
}

describe('workspace instructions after the first turn', () => {
  test('a new session has them in its first-turn prefix; changed ones go with the next turn, once, worded as replacing the old', async () => {
    const hub = instructionsHub();
    const session = recordingSession('chat');
    assert.equal(await turn(hub, session), undefined, 'the first-turn prefix carries them');
    assert.equal(await turn(hub, session), undefined);
    setInstructions('ws-1', 'Reply in French.');
    assert.equal(await turn(hub, session), 'Workspace instructions as they are now (these replace any given earlier in this conversation '
      + 'and apply to every reply from here on — treat as if part of the system prompt):\n\nReply in French.');
    assert.equal(await turn(hub, session), undefined, 'sent once');
    setInstructions('ws-1', '  Reply in French.  ');
    assert.equal(await turn(hub, session), undefined, 'what the prefix would send is unchanged');
  });

  test('a compaction event, chatHub.compact, a native command or a slash command turn makes the next turn carry them again', async () => {
    const hub = instructionsHub();
    const session = recordingSession('chat');
    await turn(hub, session);
    session.next = [{ kind: 'compaction_start' }, { kind: 'compaction_end' }, { kind: 'turn_end', stopReason: 'end_turn' }];
    assert.equal(await turn(hub, session), undefined);
    assert.match((await turn(hub, session))!, /British English/, 'after an automatic compaction');
    assert.equal(await turn(hub, session), undefined);

    await hub.compact(session.id, undefined, session);
    assert.match((await turn(hub, session))!, /British English/, 'after a requested compaction');

    hub.forgetInjectedMemory(session);
    assert.match((await turn(hub, session))!, /British English/, 'after a native command');

    assert.equal(await turn(hub, session, '/clear'), undefined, 'a runtime command carries none');
    assert.match((await turn(hub, session))!, /British English/, 'after a slash command');
    assert.equal(await turn(hub, session), undefined);
  });

  test('a failed or cancelled turn does not count as delivered, nor does a new session\'s failed first turn', async () => {
    const hub = instructionsHub();
    const session = recordingSession('chat');
    session.next = [{ kind: 'turn_end', stopReason: 'error' }];
    assert.equal(await turn(hub, session), undefined);
    assert.match((await turn(hub, session))!, /British English/, 'its prefix may never have reached the model');

    setInstructions('ws-1', 'Reply in French.');
    session.next = [{ kind: 'turn_end', stopReason: 'error' }];
    assert.match((await turn(hub, session))!, /French/);
    session.next = [{ kind: 'turn_end', stopReason: 'cancelled' }];
    assert.match((await turn(hub, session))!, /French/);
    assert.match((await turn(hub, session))!, /French/);
    assert.equal(await turn(hub, session), undefined);
  });

  test('a session on a node with earlier turns (resumed, rebuilt or reloaded) gets them once; in a workspace without any it is told nothing', async () => {
    const hub = instructionsHub(() => true);
    const resumed = recordingSession('chat');
    assert.match((await turn(hub, resumed))!, /British English/);
    assert.equal(await turn(hub, resumed), undefined);
    assert.match((await turn(hub, recordingSession('chat')))!, /British English/, 'every live session object on its own');

    setInstructions('ws-1', '');
    assert.equal(await turn(hub, recordingSession('chat')), undefined);
  });

  test('removed instructions are withdrawn once; added again, they are sent whole', async () => {
    const hub = instructionsHub();
    const session = recordingSession('chat');
    await turn(hub, session);
    setInstructions('ws-1', '   ');
    assert.equal(await turn(hub, session), INSTRUCTIONS_REMOVED);
    assert.equal(await turn(hub, session), undefined);
    setInstructions('ws-1', 'Reply in French.');
    assert.match((await turn(hub, session))!, /Reply in French\.$/);

    const empty = recordingSession('empty');
    setInstructions('ws-1', '');
    assert.equal(await turn(hub, empty), undefined, 'a new session given none is told nothing');
    assert.equal(await turn(hub, empty), undefined);
  });

  test('without injected answers the node\'s stored turns decide whether a session is new', async () => {
    getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('n-new', 'ws-1', 'chat', 'idle', 1), ('n-old', 'ws-1', 'chat', 'idle', 1)").run();
    getDb().prepare("INSERT INTO turns (turn_id, node_id, assistant_message_id, status, started_at, updated_at) VALUES ('t-old', 'n-old', 'a-old', 'completed', 1, 1)").run();
    const hub = new ChatHub({
      retentionMs: 50, workspaceIdForNode: () => 'ws-1', lookupDurableTurn: () => null, pageManifestBuilder: () => '',
      persistence: { begin: () => {}, checkpoint: () => {}, finalize: () => {} },
      memoryInjector: null, instructionsInjector: new InstructionsInjector(),
    });
    assert.equal(await turn(hub, recordingSession('n-new')), undefined);
    assert.match((await turn(hub, recordingSession('n-old')))!, /British English/);
  });

  test('cross-thread deliveries carry them; Pages maintenance turns, Agent Runs and the assistant\'s workspace never do', async () => {
    const hub = instructionsHub(() => true);
    const maintenance = recordingSession('maintenance-chat');
    const batch = await hub.startRequestedSelfTurn({
      chatId: maintenance.id, nodeId: maintenance.id, ownerUserId: null, turnId: 'maintenance-1',
      text: 'batch', displayText: 'batch', session: maintenance,
      maintenanceContext: {
        workspaceId: 'ws-1', ownerUserId: 'local', jobId: 'job', runId: 'run', claimedBy: 'test',
        configRevision: 1, planId: 'plan', sources: [],
      },
    });
    await batch.done;
    assert.ok(maintenance.inputs[0]?.maintenanceContext);
    assert.equal(maintenance.inputs[0]?.instructionsContext, undefined);

    const chat = recordingSession('chat');
    const delivered = await hub.startRequestedSelfTurn({
      chatId: chat.id, nodeId: chat.id, ownerUserId: null, turnId: 'thread-1',
      text: '[Thread message] progress', displayText: '[Thread message] progress', session: chat,
    });
    await delivered.done;
    assert.match(chat.inputs[0]?.instructionsContext ?? '', /British English/);

    const injector = new InstructionsInjector({ nodeHasOtherTurn: () => true });
    const run = recordingSession('attempt-1', runOwner('run-1', 'attempt-1'));
    assert.equal(injector.prepare({ session: run, workspaceId: 'ws-1', nodeId: 'attempt-1', turnId: 't-1' }), null);
    seedWorkspace('ws-assistant', { system: 'assistant', instructions: 'Reply in French.' });
    const assistant = recordingSession('n-v');
    assert.equal(injector.prepare({ session: assistant, workspaceId: 'ws-assistant', nodeId: 'n-v', turnId: 't-1' }), null);
  });
});
