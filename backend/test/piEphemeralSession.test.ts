/**
 * Pi ephemeral sessions (DESIGN-v2 §3.2) and probe P4: an SDK session kept in
 * memory (SessionManager.inMemory) still compacts and still keeps what
 * tool_search loaded across turns, and writes nothing under pi-sessions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiSessionDeps } from '../src/agents/pi/PiSession';
import {
  createPiSdkHarness, discardPiSdkSessionDirectory, isPiEphemeralSession, piSdkSessionDirectory, type PiEphemeralSessionDeps,
} from '../src/agents/pi/piSdkHarness';
import { deferMcpTools } from '../src/agents/pi/mcpToolBridge';
import { loadPiAi, loadPiAgentCore, loadPiTypebox } from '../src/agents/pi/piAi';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import { PI_RUNTIME_DESCRIPTOR, PI_CORE_RUNTIME_DESCRIPTOR } from '../src/agents/pi/piDescriptor';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import { getMichiDataDir } from '../src/services/dataDir';
import { chatOwner } from './helpers/owners';

const base: PiSessionDeps = {
  bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
  preamble: 'Only follow the host prompt.', cwd: os.tmpdir(), enableFollowUps: false,
  workspaceId: 'ws-assistant', ownerUserId: null, owner: chatOwner('n-cmph-pi'), profileHash: 'checkin-profile',
};
const ephemeral: PiEphemeralSessionDeps = { ...base, ephemeral: true };
const usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function tool(Type: any, name: string, description: string, onRun?: () => void) {
  return {
    name, label: name, description, parameters: Type.Object({}),
    async execute() { onRun?.(); return { content: [{ type: 'text', text: `${name} ran` }], details: {} }; },
  };
}

function scriptedStream(ai: any, model: any, turns: Array<() => any[]>, requests: any[], turnUsage = usage) {
  return (_model: any, context: any) => {
    requests.push(context);
    const content = (turns[requests.length - 1] ?? (() => [{ type: 'text', text: 'DONE' }]))();
    const stopReason = content.some((block: any) => block.type === 'toolCall') ? 'toolUse' : 'stop';
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({ type: 'done', reason: stopReason, message: {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, usage: turnUsage, stopReason, timestamp: Date.now(),
    } }));
    return stream;
  };
}

/** Every file under the data directory's pi-sessions, relative to it. */
function piSessionFiles(): string[] {
  const root = path.join(getMichiDataDir(), 'pi-sessions');
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

test('the marker is what PiRuntime sets; plain deps are not ephemeral', () => {
  assert.equal(isPiEphemeralSession(ephemeral), true);
  assert.equal(isPiEphemeralSession(base), false);
  assert.equal(PI_RUNTIME_DESCRIPTOR.topology.ephemeralSessions, 'native');
  assert.equal(PI_CORE_RUNTIME_DESCRIPTOR.topology.ephemeralSessions, 'native');
});

test('P4: tool_search loads a deferred tool in an in-memory session and it stays loaded on the next turn; nothing is written', async () => {
  const ai: any = await loadPiAi();
  const core: any = await loadPiAgentCore();
  const { Type } = await loadPiTypebox();
  const model = ai.getModel('openai', 'gpt-4.1-mini');
  let ran = 0;
  const hostTools = [
    tool(Type, 'read_node', 'A synthetic host tool'),
    ...deferMcpTools([tool(Type, 'mcp__sheets__create_report', 'Create a spreadsheet report', () => { ran++; })]),
  ];
  const requests: any[] = [];
  const before = piSessionFiles();
  const harness = await createPiSdkHarness('n-cmph-pi', ephemeral, core, {
    initialState: { systemPrompt: base.preamble, model, tools: hostTools, thinkingLevel: 'off', messages: [] },
    streamFn: scriptedStream(ai, model, [
      () => [{ type: 'toolCall', id: 'search-1', name: 'tool_search', arguments: { query: 'spreadsheet report' } }],
      () => [{ type: 'toolCall', id: 'call-1', name: 'mcp__sheets__create_report', arguments: {} }],
      () => [{ type: 'text', text: 'Report made.' }],
      () => [{ type: 'text', text: 'Still here.' }],
    ], requests),
  });
  await harness.configureAuth(model.provider, 'synthetic-test-key');
  const declared = (context: any) => ai.getCurrentTools(context.messages).map((t: any) => t.name).sort();
  try {
    await harness.prompt('Make a report');
    assert.equal(ran, 1);
    harness.checkpoint([{ role: 'user', content: 'Make a report' }]);
    await harness.prompt('And again?');
    assert.deepEqual(declared(requests.at(-1)), ['mcp__sheets__create_report', 'read_node', 'tool_search'],
      'the next turn of the same in-memory session still has the loaded tool');
    assert.equal(fs.existsSync(piSdkSessionDirectory('n-cmph-pi', ephemeral)), false, 'no scope directory');
    assert.deepEqual(piSessionFiles(), before, 'no transcript, checkpoint or retired file');
  } finally { await harness.dispose(); }
  assert.deepEqual(piSessionFiles(), before);
});

test('P4: auto-compaction works in an in-memory session', async () => {
  const ai: any = await loadPiAi();
  const core = await loadPiAgentCore();
  const model = { ...ai.getModel('openai', 'gpt-4.1-mini'), contextWindow: 65536 };
  const big = { input: 52000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 52020, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const messages: any[] = [];
  for (let index = 0; index < 20; index++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `Synthetic ${index}: ` + 'harmless context '.repeat(800) }], timestamp: Date.now() });
    messages.push({ role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'Recorded synthetic context.' }], usage: big, stopReason: 'stop', timestamp: Date.now() });
  }
  const before = piSessionFiles();
  const events: any[] = [];
  const harness = await createPiSdkHarness('n-cmph-pi-compact', { ...ephemeral, initialMessages: messages }, core, {
    initialState: { systemPrompt: base.preamble, model, tools: [], messages, thinkingLevel: 'off' },
    streamFn: scriptedStream(ai, model, [() => [{ type: 'text', text: 'Synthetic summary: all harmless records are complete.' }]], [], { ...big, input: 10, totalTokens: 30 }),
  });
  await harness.configureAuth(model.provider, 'synthetic-test-key');
  harness.subscribe((event: any) => events.push(event));
  try {
    await harness.prompt('Continue after compression');
    assert(events.some((event) => event.type === 'compaction_end' && !event.errorMessage));
    assert(harness.state.messages.some((message: any) => message.role === 'compactionSummary'));
  } finally { await harness.dispose(); }
  assert.deepEqual(piSessionFiles(), before);
});

test('an ephemeral session neither restores nor retires a transcript left under its scope', async () => {
  const ai: any = await loadPiAi();
  const core: any = await loadPiAgentCore();
  const model = ai.getModel('openai', 'gpt-4.1-mini');
  const directory = piSdkSessionDirectory('n-cmph-left', ephemeral);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'session.jsonl'), 'not a transcript\n');
  fs.writeFileSync(path.join(directory, 'host-history.sha256'), 'x');
  try {
    const harness = await createPiSdkHarness('n-cmph-left', { ...ephemeral, restoreNative: true }, core, {
      initialState: { systemPrompt: base.preamble, model, tools: [], messages: [], thinkingLevel: 'off' },
      streamFn: scriptedStream(ai, model, [], []),
    });
    await harness.dispose();
    assert.deepEqual(fs.readdirSync(directory).sort(), ['host-history.sha256', 'session.jsonl']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('PiRuntime marks ephemeral sessions and discards their scope directory once released', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pi-ephemeral-'));
  const nodes = new Map([['n-cmph-rt', { id: 'n-cmph-rt', workspace_id: 'ws-assistant' }]]);
  configureRuntimeDeps({
    dataDir,
    historyStore: {
      getNode: (id: string) => nodes.get(id) ?? null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null,
    } as any,
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'pi', provider: 'test', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => '', resolveReasoning: () => undefined,
    } as any,
  });
  const runtime = new PiRuntime(base.bridge);
  t.after(async () => {
    await runtime.shutdown();
    clearAllSessions();
    __resetRuntimeDeps();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const owner = chatOwner('n-cmph-rt');
  const session = await runtime.newSession({ sessionId: 'n-cmph-rt', owner, cwd: dataDir, workspaceId: 'ws-assistant', profileHash: 'h', ephemeral: true });
  assert.equal(isPiEphemeralSession((session as any).sdkDeps ?? (session as any).deps), true);
  const plain = await runtime.newSession({ sessionId: 'n-chat-rt', cwd: dataDir, workspaceId: 'ws-assistant' });
  assert.equal(isPiEphemeralSession((plain as any).sdkDeps ?? (plain as any).deps), false);
  const input = { sessionId: 'n-cmph-rt', owner, nativeSessionId: null, cwd: dataDir, profileHash: 'h' };
  assert.equal(await runtime.discardNativeSession(input), 'deferred', 'not while the session is live');
  await runtime.releaseSession('n-cmph-rt');
  assert.equal(await runtime.discardNativeSession(input), 'absent', 'an ephemeral session wrote nothing');
  // A scope directory an earlier, non-ephemeral session left under the same scope goes.
  const scope = { ownerUserId: null, workspaceId: 'ws-assistant', owner, profileHash: 'h' };
  const leftover = piSdkSessionDirectory('n-cmph-rt', scope);
  fs.mkdirSync(leftover, { recursive: true });
  fs.writeFileSync(path.join(leftover, 'session.jsonl'), '{}\n');
  const neighbour = piSdkSessionDirectory('n-chat-rt', scope);
  fs.mkdirSync(neighbour, { recursive: true });
  assert.equal(await runtime.discardNativeSession(input), 'discarded');
  assert.equal(fs.existsSync(leftover), false);
  assert.ok(fs.existsSync(neighbour), 'another session\'s directory stays');
  assert.equal(discardPiSdkSessionDirectory('n-chat-rt', scope), true);
});
