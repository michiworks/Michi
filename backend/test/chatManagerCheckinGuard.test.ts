/**
 * DESIGN-v2 §2.5: chatManager refuses a check-in node (`n-cmph-*`) on every
 * binding path but openEphemeralSession, before any open fallback can bind
 * it: ensureParentSession (a Parent restore), resolvePrimaryAgentBinding
 * (ensure-session, session load) refuse it whether or not it sits in the
 * assistant's workspace, and whatever its meta rows say. Fake runtime on a
 * real temp database.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, getSession } from '../src/agents/sessionRegistry';
import { assistantPurposeKey } from '../src/assistant/identity';
import { ensureAssistant } from '../src/assistant/store';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { ChatManager, CheckinSessionError, PrimaryAgentBindingError } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

let opened: NewAgentSessionOptions[] = [];

const runtime: AgentRuntime = {
  descriptor: { ...UNKNOWN_RUNTIME_DESCRIPTOR, topology: { ...UNKNOWN_RUNTIME_DESCRIPTOR.topology, ephemeralSessions: 'native' } },
  id: 'checkin-guard-test', label: 'Checkin guard test',
  capabilities: {
    modes: false, permissions: true, models: false, providerModels: false,
    reasoning: false, supportedReasoningLevels: [], apiKeys: false,
    warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
  },
  async warm() {},
  async newSession(options) {
    opened.push(options);
    return {
      id: options.sessionId!, runtimeId: runtime.id, runtimeProfileHash: options.profileHash ?? null,
      getHistory: () => [], getPendingAssistant: () => undefined, async *send() {}, async cancel() {},
    } as AgentSession;
  },
  async releaseSession() {},
  async shutdown() {},
};
registerRuntime(runtime);

let tmpDir: string;

function insertNode(id: string, workspaceId: string, runtimeId: string | null = runtime.id): void {
  getDb().prepare(`INSERT INTO nodes (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at,runtime_id)
    VALUES (?,?,'chat','idle',0,0,1,?)`).run(id, workspaceId, runtimeId);
}

function chooseRuntime(nodeId: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run(`assistant_conversation_runtime:${nodeId}`, JSON.stringify({ runtimeId: runtime.id, providerId: null, modelId: null, reasoning: null }));
}

const isCheckinRefusal = (error: unknown) => error instanceof CheckinSessionError && error instanceof PrimaryAgentBindingError
  && error.code === 'checkin_node' && error.reason === 'checkin_node';

describe('chatManager refuses check-in nodes before any open binding', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-checkin-guard-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb(); initDb(); clearAllSessions(); opened = [];
    getDb().prepare("INSERT INTO workspaces (id,name,owner_user_id,cwd,created_at,updated_at) VALUES ('ws-plain','Plain',NULL,?,1,1)").run(tmpDir);
  });

  afterEach(() => {
    clearAllSessions();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('outside the assistant workspace, where the open binding would apply', async () => {
    insertNode('n-cmph-run1', 'ws-plain');
    insertNode('n-plain', 'ws-plain');
    const manager = new ChatManager(undefined, tmpDir);
    await assert.rejects(manager.ensureParentSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-plain', nodeId: 'n-cmph-run1' }), isCheckinRefusal);
    await assert.rejects(manager.resolvePrimaryAgentBinding({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-plain', nodeId: 'n-cmph-run1' }), isCheckinRefusal);
    await assert.rejects(manager.openEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-plain', nodeId: 'n-cmph-run1' }),
      (error: unknown) => error instanceof CheckinSessionError && error.reason === 'refused_binding', 'no assistant binding: no ephemeral session either');
    assert.equal(opened.length, 0, 'no session opened');
    assert.equal(getSession('n-cmph-run1'), undefined);

    // Control: an ordinary chat in the same workspace binds as before.
    assert.equal(await manager.resolvePrimaryAgentBinding({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-plain', nodeId: 'n-plain' }), null);
    const plain = await manager.ensureParentSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-plain', nodeId: 'n-plain' });
    assert.ok(plain);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].ephemeral, undefined);
  });

  test('inside the assistant workspace, with or without its meta row', async () => {
    const workspaceId = ensureAssistant().workspaceId;
    insertNode('n-cmph-run1', workspaceId);
    insertNode('n-cmph-run2', workspaceId);
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey('n-cmph-run1'), 'companion');
    chooseRuntime('n-cmph-run1');
    chooseRuntime('n-cmph-run2');
    const manager = new ChatManager(undefined, tmpDir);
    for (const nodeId of ['n-cmph-run1', 'n-cmph-run2']) {
      await assert.rejects(manager.ensureParentSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId, nodeId }), isCheckinRefusal, nodeId);
      await assert.rejects(manager.resolvePrimaryAgentBinding({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId, nodeId }), isCheckinRefusal, nodeId);
    }
    assert.equal(opened.length, 0);
  });

  test('openEphemeralSession and discardEphemeralSession take check-in nodes only', async () => {
    insertNode('n-plain', 'ws-plain');
    const manager = new ChatManager(undefined, tmpDir);
    await assert.rejects(manager.openEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-plain', nodeId: 'n-plain' }), isCheckinRefusal);
    await assert.rejects(manager.discardEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: 'n-plain' }), isCheckinRefusal);
    assert.equal(opened.length, 0);
  });
});
