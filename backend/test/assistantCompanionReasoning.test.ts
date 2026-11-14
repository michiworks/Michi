/**
 * The agent's reasoning level (DESIGN-v2 §6) and what a check-in runs on
 * (unification §D8): V, without a composer pick, runs at the lower of the
 * global level and high (a user turn at the global xhigh took 69 s;
 * check-ins stop after 3 minutes); a level the user picks in V's composer
 * wins for V only, and a new conversation follows the global settings again.
 * A check-in runs on Background work (the Meta agent record), never on V's
 * pick: its own reasoning when Custom has one, else the agent's level. The
 * binding every session path uses and the info the composer chips show
 * agree. Temp MICHI_DATA_DIR per test; the runtimes are fakes.
 */

// Must stay first: agentConfig would otherwise persist test settings to ~/.michi/config.json.
import './isolatedConfigDir';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeReasoning } from 'michi-shared';
import type { AgentRuntime } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { resolveAssistantBinding } from '../src/assistant/binding';
import { COMPANION_DEFAULT_REASONING_MAX, ensureAssistant, resetAssistant, updateAssistantSettings } from '../src/assistant/store';
import { updateAgentConfig } from '../src/services/agentConfig';
import { updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { closeDb, getDb, initDb } from '../src/services/db';
import { makeCheckinNode } from './helpers/checkinNodes';

function fakeRuntime(id: string): AgentRuntime {
  return {
    id, label: id,
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    capabilities: {
      modes: false, permissions: true, models: false, providerModels: false,
      reasoning: true, supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {},
    async newSession() { throw new Error('not used'); },
    async releaseSession() {},
    async shutdown() {},
  } as AgentRuntime;
}

for (const id of ['claude', 'codex']) registerRuntime(fakeRuntime(id));

const RUNTIMES = ['claude', 'codex', 'kiro', 'crew', 'pi'];

/** The global runtime, with `reasoning` as the user's level for it (none: the runtime's built-in default). */
function setGlobal(runtime: string, reasoning?: RuntimeReasoning): void {
  const none = Object.fromEntries(RUNTIMES.map((id) => [id, undefined])) as Record<string, never>;
  updateAgentConfig({
    runtime,
    providerByRuntime: { ...none },
    modelByRuntime: { ...none },
    reasoningByRuntime: { ...none, ...(reasoning ? { [runtime]: reasoning } : {}) },
  });
}

/** What a session of the conversation would run at (binding.ts, as every session path applies it). */
const boundReasoning = (nodeId: string) => resolveAssistantBinding(nodeId)!.effectiveDefinition.runtimeProfile.reasoning;

const boundProfile = (nodeId: string) => resolveAssistantBinding(nodeId)!.effectiveDefinition.runtimeProfile;

describe('the agent\'s reasoning level (DESIGN-v2 §6)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-companion-reasoning-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('without a pick, V and its check-ins run at the lower of the global level and high; the global settings stay as they are', () => {
    assert.equal(COMPANION_DEFAULT_REASONING_MAX, 'high');
    const v = ensureAssistant();
    const s = makeCheckinNode(v.workspaceId);
    for (const [global, expected] of [['xhigh', 'high'], ['max', 'high'], ['high', 'high'], ['medium', 'medium'], ['low', 'low'], ['minimal', 'minimal']] as const) {
      setGlobal('claude', global);
      const info = ensureAssistant();
      assert.equal(info.conversation.reasoning, expected, `global ${global}: what the composer shows`);
      assert.equal(info.conversationFollowsGlobal, true);
      assert.equal(info.settings.reasoning, global, 'the global settings themselves stay as they are');
      assert.equal(boundReasoning(v.nodeId), expected, `global ${global}: what V's sessions run at`);
      assert.equal(boundReasoning(s), expected, `global ${global}: what a check-in runs at`);
    }
    // A runtime's built-in default counts as the user's default: Codex would run at xhigh.
    setGlobal('codex');
    assert.equal(boundReasoning(v.nodeId), 'high');
    assert.equal(boundReasoning(s), 'high');
  });

  test('Background work, set to Custom, is what a check-in runs on, its reasoning included; V stays on the global settings', () => {
    setGlobal('claude', 'xhigh');
    const v = ensureAssistant();
    const s = makeCheckinNode(v.workspaceId);
    updateMetaAgentSettings({ runtimeId: 'codex', modelId: 'gpt-bg', reasoning: 'max' });
    assert.deepEqual([boundProfile(s).runtimeId, boundProfile(s).modelId, boundProfile(s).reasoning], ['codex', 'gpt-bg', 'max'],
      'the user may choose more than high for background work');
    assert.deepEqual([boundProfile(v.nodeId).runtimeId, boundProfile(v.nodeId).reasoning], ['claude', 'high'], 'V is not background work');
    updateMetaAgentSettings({ reasoning: null });
    assert.equal(boundReasoning(s), 'high', 'Custom without a level: the agent\'s level on that runtime');
    updateMetaAgentSettings({ runtimeId: null });
    assert.deepEqual([boundProfile(s).runtimeId, boundProfile(s).reasoning], ['claude', 'high'], 'Same as your chats');
  });

  test('V\'s composer pick wins for V alone: a check-in stays on Background work, and a new conversation follows the global settings', () => {
    setGlobal('claude', 'xhigh');
    const v = ensureAssistant();
    const s = makeCheckinNode(v.workspaceId);

    const runtime = updateAssistantSettings({ nodeId: v.nodeId, runtimeId: 'codex', providerId: null, modelId: null, reasoning: null });
    assert.equal(runtime.conversationFollowsGlobal, false);
    assert.equal(runtime.conversation.reasoning, 'high', 'a runtime pick is no reasoning pick: the agent\'s level holds');
    const model = updateAssistantSettings({ nodeId: v.nodeId, modelId: 'gpt-x' });
    assert.equal(model.conversation.reasoning, 'high');

    const picked = updateAssistantSettings({ nodeId: v.nodeId, reasoning: 'max' });
    assert.equal(picked.conversation.reasoning, 'max', 'the user\'s own pick');
    assert.deepEqual([boundProfile(v.nodeId).runtimeId, boundProfile(v.nodeId).modelId, boundProfile(v.nodeId).reasoning], ['codex', 'gpt-x', 'max']);
    assert.deepEqual([boundProfile(s).runtimeId, boundProfile(s).reasoning], ['claude', 'high'], 'a check-in never follows V\'s pick');
    // A pick stored under a check-in node's own key is never read (E-review #14): the check-in still runs on Background work.
    const stray = makeCheckinNode(v.workspaceId, 'run-stray');
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(`assistant_conversation_runtime:${stray}`, JSON.stringify({ runtimeId: 'codex', providerId: null, modelId: 'opus', reasoning: 'max' }));
    assert.deepEqual([boundProfile(stray).runtimeId, boundProfile(stray).reasoning], ['claude', 'high']);
    setGlobal('codex', 'low');
    assert.equal(boundReasoning(v.nodeId), 'max', 'a pick is not affected by global');

    const fresh = resetAssistant().info;
    assert.equal(fresh.conversationFollowsGlobal, true, 'New conversation follows the settings again');
    assert.equal(fresh.conversation.reasoning, 'low');
  });
});
