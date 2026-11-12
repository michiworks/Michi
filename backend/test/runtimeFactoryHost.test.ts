/**
 * The runtime host server.ts creates reaches every runtime the factories
 * build: Kiro and Crew keep it in their options (and a Kiro v3 session worker
 * inherits it), Claude and Codex in a field. None of them reads it yet; Pi
 * does not take one.
 */

import './isolatedConfigDir';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_SHORT_LABELS, shortRuntimeLabel } from 'michi-shared';
import { RUNTIME_FACTORIES } from '../src/agents/runtimeFactories';
import { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { McpSlotRegistry } from '../src/services/mcpServer';
import type { AgentRuntime, AgentSession } from '../src/agents/types';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { michiTestHost } from './helpers/michiTestHost';

const bridge: AgentToolBridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const created: AgentRuntime[] = [];
after(async () => { await Promise.all(created.map((runtime) => runtime.shutdown())); });

/** Where each adapter keeps its host (white box: private until the adapter switch reads it). */
function storedHost(runtime: AgentRuntime): unknown {
  const fields = runtime as unknown as { host?: unknown; runtimeOptions?: { host?: unknown } };
  return runtime instanceof AcpAgentRuntime ? fields.runtimeOptions?.host : fields.host;
}

test('extracted runtime factories receive deps.host; app-owned adapters retain their existing construction', () => {
  const host = michiTestHost();
  const mcpRegistry = new McpSlotRegistry();
  const seen: string[] = [];
  for (const factory of RUNTIME_FACTORIES) {
    const runtime = factory.create({ bridge, mcpRegistry, mcpPort: 0, defaultCwd: '/tmp/michi-factory-host', host });
    created.push(runtime);
    seen.push(factory.id);
    assert.equal(storedHost(runtime), ['kiro', 'crew', 'claude', 'codex'].includes(factory.id) ? host : undefined, factory.id);
  }
  assert.deepEqual(seen.sort(), ['antigravity', 'claude', 'codex', 'crew', 'cursor', 'grok', 'kiro', 'pi']);
});

test('the shared short runtime names are the ones the runtimes register', () => {
  const host = michiTestHost();
  for (const factory of RUNTIME_FACTORIES) {
    const runtime = factory.create({ bridge, mcpRegistry: new McpSlotRegistry(), mcpPort: 0, defaultCwd: '/tmp/michi-factory-host', host });
    created.push(runtime);
    assert.equal(shortRuntimeLabel(runtime.label), RUNTIME_SHORT_LABELS[factory.id], factory.id);
  }
  assert.deepEqual(Object.keys(RUNTIME_SHORT_LABELS).sort(), RUNTIME_FACTORIES.map(({ id }) => id).sort());
});

test('a Kiro v3 session worker gets its parent runtime\'s host', async () => {
  const host = michiTestHost();
  const runtime = new AcpAgentRuntime({ bridge, defaultCwd: '/tmp/michi-factory-host', engine: 'v3', host });
  created.push(runtime);
  const session = {} as AgentSession;
  let worker: AcpAgentRuntime | undefined;
  const opener = runtime as unknown as {
    openIsolatedSession(id: string, cwd: string, open: (worker: AcpAgentRuntime) => Promise<AgentSession>): Promise<AgentSession>;
  };
  const opened = await opener.openIsolatedSession('chat-1', '/tmp/michi-factory-host', async (w) => { worker = w; return session; });
  assert.equal(opened, session);
  assert.ok(worker instanceof AcpAgentRuntime && worker !== runtime);
  assert.equal(storedHost(worker), host);
});
