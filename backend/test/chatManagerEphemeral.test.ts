/**
 * DESIGN-v2 §3.2: chatManager.openEphemeralSession opens the one session a
 * check-in runs in (a fresh `ephemeral` session for check-in node S on the
 * closed profile, no replay, registered and bound once), and
 * discardEphemeralSession ends it for good (refused as `busy` while a turn
 * holds S; otherwise release, drop, then the runtime's discardNativeSession,
 * whose `deferred` leaves it to be retried). Fake runtimes on a real temp
 * database; the binding is the real one unless a test injects another.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentRuntime, AgentSession, NativeSessionDiscardInput, NativeSessionDiscardResult, NewAgentSessionOptions, RuntimeSessionOwner,
} from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { chatHub } from '../src/agents/chatHub';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, getSession, registerSession } from '../src/agents/sessionRegistry';
import { subscribeSessionStates } from '../src/agents/sessionStateFeed';
import { resolveAssistantBinding, type AssistantSessionBinding } from '../src/assistant/binding';
import { assistantPurposeKey } from '../src/assistant/identity';
import { ensureAssistant, updateAssistantSettings } from '../src/assistant/store';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { ChatManager, CheckinSessionError } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode } from '../src/services/dbRepository';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

const S = 'n-cmph-run1';

interface Recorder {
  opened: NewAgentSessionOptions[];
  released: Array<{ id: string; owner?: RuntimeSessionOwner }>;
  discarded: NativeSessionDiscardInput[];
  discardAnswers: NativeSessionDiscardResult[];
  /** The next session's turn waits for this before it ends. */
  hold: Promise<void> | null;
  /** Runs inside newSession, before the session is returned. */
  onOpen: (() => void) | null;
}
const rec: Recorder = { opened: [], released: [], discarded: [], discardAnswers: [], hold: null, onOpen: null };

/** Sessions that report current state (mode, model), as Claude's and Kiro's do. */
const withState = (session: AgentSession, runtimeId: string): AgentSession => Object.assign(session, {
  getSessionState: () => ({ runtimeId, modelId: 'm1' }),
  onSessionState: () => () => {},
});

function fakeRuntime(id: string, ephemeral: boolean, reportsState = false): AgentRuntime {
  const runtime: AgentRuntime = {
    descriptor: ephemeral
      ? { ...UNKNOWN_RUNTIME_DESCRIPTOR, topology: { ...UNKNOWN_RUNTIME_DESCRIPTOR.topology, ephemeralSessions: 'native' } }
      : UNKNOWN_RUNTIME_DESCRIPTOR,
    id, label: id,
    capabilities: {
      modes: false, permissions: true, models: false, providerModels: false,
      reasoning: false, supportedReasoningLevels: [], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {},
    async newSession(options) {
      rec.opened.push(options);
      rec.onOpen?.();
      const hold = rec.hold;
      const session = {
        id: options.sessionId!, runtimeId: id, nativeSessionId: `native-${options.sessionId}`,
        runtimeProfileHash: options.profileHash ?? null, getHistory: () => [], getPendingAssistant: () => undefined,
        async *send(): AsyncIterableIterator<NormalizedEvent> {
          if (hold) await hold;
          yield { kind: 'turn_end', stopReason: 'end_turn' };
        },
        async cancel() {},
      } as AgentSession;
      return reportsState ? withState(session, id) : session;
    },
    async releaseSession(sessionId, owner) { rec.released.push({ id: sessionId, owner }); },
    async discardNativeSession(input) {
      rec.discarded.push(input);
      return rec.discardAnswers.shift() ?? 'discarded';
    },
    async shutdown() {},
  };
  return runtime;
}
registerRuntime(fakeRuntime('eph-test', true));
registerRuntime(fakeRuntime('eph-none', false));
registerRuntime(fakeRuntime('eph-state', true, true));

let tmpDir: string;
let workspaceId: string;

/**
 * A check-in node as W2-G1a's createCheckinNode makes one: its own tree in the
 * assistant workspace, recorded closed. A check-in runs on V's runtime
 * (assistant/store.ts), so `runtimeId` is V's composer pick, as the user makes one.
 */
function createCheckinNode(nodeId: string, runtimeId = 'eph-test'): void {
  const treeId = `t-${nodeId}`;
  getDb().prepare('INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES (?,?,?,1,1)').run(treeId, workspaceId, nodeId);
  getDb().prepare(`INSERT INTO nodes (id,workspace_id,tree_id,kind,status,minimized,spawned_by_agent,created_at)
    VALUES (?,?,?,'chat','idle',0,0,1)`).run(nodeId, workspaceId, treeId);
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey(nodeId), 'companion');
  updateAssistantSettings({ nodeId: ensureAssistant().nodeId, runtimeId });
}

const open = (manager: ChatManager, nodeId = S) => manager.openEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId, nodeId });
const refusedFor = (reason: string) => (error: unknown) => error instanceof CheckinSessionError && error.reason === reason;

describe('chatManager ephemeral check-in sessions', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-ephemeral-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb(); initDb(); clearAllSessions();
    Object.assign(rec, { opened: [], released: [], discarded: [], discardAnswers: [], hold: null, onOpen: null });
    workspaceId = ensureAssistant().workspaceId;
    createCheckinNode(S);
  });

  afterEach(() => {
    clearAllSessions();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('opens one fresh ephemeral session on the closed profile, registered and bound; never a second', async () => {
    const manager = new ChatManager(undefined, tmpDir);
    const session = await open(manager);
    assert.equal(rec.opened.length, 1);
    const options = rec.opened[0];
    const binding = resolveAssistantBinding(S)!;
    assert.equal(options.ephemeral, true);
    assert.equal(options.sessionId, S);
    assert.equal(options.toolProfile?.restricted, true, 'the closed profile');
    assert.deepEqual(options.toolProfile, binding.sessionOptions.toolProfile);
    assert.equal(options.bootstrapInstructions, binding.sessionOptions.bootstrapInstructions);
    assert.equal(options.profileHash, binding.profileHash);
    assert.equal(options.cwd, binding.sessionOptions.cwd);
    assert.equal(options.replayHistory, undefined, 'no replay');
    assert.equal(options.mergeContexts, undefined);
    assert.equal(getSession(S), session, 'registered');
    const node = getNode(S)!;
    assert.equal(node.runtime_id, 'eph-test');
    assert.equal(node.acp_session_id, `native-${S}`, 'bound, so the 0032 ledger records the native id');

    await assert.rejects(open(manager), refusedFor('already_open'));
    clearAllSessions();
    await assert.rejects(open(new ChatManager(undefined, tmpDir)), refusedFor('already_open'), 'its binding stays: a check-in node opens once');
    assert.equal(rec.opened.length, 1);
  });

  test('S never reaches a window through the session_state feed, live or replayed', async () => {
    // routes/michi.ts sends this feed to every desktop window (ownerUserId undefined), unfiltered.
    const S2 = 'n-cmph-state';
    createCheckinNode(S2, 'eph-state');
    const heard: string[] = [];
    const detach = subscribeSessionStates((nodeId) => { heard.push(nodeId); });
    try {
      const session = await open(new ChatManager(undefined, tmpDir), S2);
      assert.equal(typeof session.getSessionState, 'function', 'S reports state, like a Claude or Kiro session');
      // An ordinary conversation on the same runtime is heard: the feed is live here.
      registerSession(withState({
        id: 'n-ordinary', runtimeId: 'eph-state', getHistory: () => [], getPendingAssistant: () => undefined,
        async *send() {}, async cancel() {},
      } as unknown as AgentSession, 'eph-state'), LOCAL_AGENT_OWNER_ID);
      const late: string[] = [];
      subscribeSessionStates((nodeId) => { late.push(nodeId); })();
      assert.deepEqual(heard, ['n-ordinary'], 'no live frame names S');
      assert.deepEqual(late, ['n-ordinary'], 'a window that subscribes later is not told of S either');
    } finally {
      detach();
    }
  });

  test('discard releases and drops the session, then discards its native record where it ran', async () => {
    const manager = new ChatManager(undefined, tmpDir);
    const session = await open(manager);
    assert.equal(await manager.discardEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: S }), 'discarded');
    assert.deepEqual(rec.released.map(({ id, owner }) => [id, owner?.key]), [[S, S]]);
    assert.equal(getSession(S), undefined, 'dropped');
    assert.equal(rec.discarded.length, 1);
    const input = rec.discarded[0];
    assert.equal(input.sessionId, S);
    assert.equal(input.owner.key, S);
    assert.equal(input.nativeSessionId, `native-${S}`);
    assert.equal(input.cwd, rec.opened[0].cwd, 'the cwd it was opened in');
    assert.equal(input.profileHash, session.runtimeProfileHash);
  });

  test('refuses as busy while a turn holds the node, touching nothing; discards once it settles', async () => {
    const manager = new ChatManager(undefined, tmpDir);
    let release!: () => void;
    rec.hold = new Promise<void>((resolve) => { release = resolve; });
    const session = await open(manager);
    const started = await chatHub.startRequestedSelfTurn({ chatId: S, nodeId: S, turnId: 'cmp-run1', text: 'note', session, private: true, memoryContext: null });
    assert.equal(await manager.discardEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: S }), 'busy');
    assert.equal(rec.released.length, 0);
    assert.equal(rec.discarded.length, 0);
    assert.equal(getSession(S), session, 'still registered');
    release();
    await started.done;
    assert.equal(await manager.discardEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: S }), 'discarded');
    assert.equal(rec.released.length, 1);
    assert.equal(rec.discarded.length, 1);
  });

  test('deferred is passed on and retried with what the session was opened with', async () => {
    const manager = new ChatManager(undefined, tmpDir);
    await open(manager);
    rec.discardAnswers.push('deferred');
    assert.equal(await manager.discardEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: S }), 'deferred');
    assert.equal(await manager.discardEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: S }), 'discarded');
    assert.equal(rec.released.length, 1, 'released once');
    assert.deepEqual(rec.discarded.map((input) => [input.nativeSessionId, input.cwd]), [
      [`native-${S}`, rec.opened[0].cwd], [`native-${S}`, rec.opened[0].cwd],
    ]);
  });

  test('with the node row gone, discards what the run recorded', async () => {
    const manager = new ChatManager(undefined, tmpDir);
    getDb().prepare('DELETE FROM nodes WHERE id = ?').run(S);
    assert.equal(await manager.discardEphemeralSession({
      ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: S,
      recorded: { runtimeId: 'eph-test', nativeSessionId: 'native-old', cwd: '/data/companion/checkin/.michi', profileHash: 'h1' },
    }), 'discarded');
    assert.deepEqual(rec.discarded.map((input) => [input.sessionId, input.nativeSessionId, input.cwd, input.profileHash]),
      [[S, 'native-old', '/data/companion/checkin/.michi', 'h1']]);
    assert.equal(await manager.discardEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: 'n-cmph-never' }), 'absent', 'never bound: nothing native');
  });

  test('a binding that cannot be written releases and discards the session it opened', async () => {
    const manager = new ChatManager(undefined, tmpDir);
    rec.onOpen = () => { getDb().prepare('DELETE FROM nodes WHERE id = ?').run(S); };
    await assert.rejects(open(manager), /Cannot persist resume binding/);
    assert.equal(getSession(S), undefined, 'not left registered');
    assert.deepEqual(rec.released.map(({ id }) => id), [S]);
    assert.deepEqual(rec.discarded.map((input) => [input.nativeSessionId, input.cwd]), [[`native-${S}`, rec.opened[0].cwd]]);
  });

  test('refuses a binding that is not the closed profile, a runtime without ephemeral sessions, and no binding', async () => {
    const real = resolveAssistantBinding(S)!;
    const withProfile = (toolProfile: AssistantSessionBinding['sessionOptions']['toolProfile']): AssistantSessionBinding => ({
      ...real, sessionOptions: { ...real.sessionOptions, toolProfile },
    });
    await assert.rejects(open(new ChatManager(undefined, tmpDir, { resolveCheckinBinding: async () => withProfile({ assistant: true }) })),
      refusedFor('not_restricted'), 'the open profile (an unrecorded purpose before W2-E) never runs a check-in');
    await assert.rejects(open(new ChatManager(undefined, tmpDir, { resolveCheckinBinding: async () => ({ ...real, sessionOptions: { ...real.sessionOptions, cwd: '' } }) })),
      refusedFor('not_restricted'));
    await assert.rejects(open(new ChatManager(undefined, tmpDir, { resolveCheckinBinding: async () => null })), refusedFor('refused_binding'));

    createCheckinNode('n-cmph-run2', 'eph-none');
    await assert.rejects(open(new ChatManager(undefined, tmpDir), 'n-cmph-run2'), refusedFor('runtime_unsupported'));
    assert.equal(rec.opened.length, 0, 'nothing opened');
    assert.equal(getNode(S)!.acp_session_id ?? null, null, 'nothing bound');
  });
});
