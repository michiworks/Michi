import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { META_AGENT_MAINTENANCE_TOOL_NAMES } from '../src/agents/maintenancePolicy';
import { assertMetaAgentToolCatalog, isMetaAgentGuardError, metaAgentToolsetOf } from '../src/agents/metaAgentGuard';
import { ensureKiroMetaAgent, kiroMetaAgentConfig, kiroMetaAgentDir } from '../src/agents/kiro/kiroMetaAgent';
import type { MaintenanceExecutionContext } from '../src/agents/types';
import { buildMcpServerForSlot, McpSlotRegistry } from '../src/services/mcpServer';
import { CONSOLIDATION_INSTRUCTIONS } from '../src/services/memory/consolidationPolicy';
import {
  MEMORY_CONSOLIDATE_TOOL_NAME, memoryExtractionBootstrapInstructions, memoryExtractionProfileHash, memoryExtractionToolProfile,
  MEMORY_EXTRACTION_TOOL_NAMES,
} from '../src/services/memory/extractionProfile';
import { createMemoryExtractionTools } from '../src/services/memory/extractionTools';
import { memoryProfileBootstrapInstructions } from '../src/services/memory/userProfile';

function slot(names: readonly string[], context: MaintenanceExecutionContext | null = null) {
  return new McpSlotRegistry().create('node-1', '/tmp', 'local-user', {
    owner: { mode: 'interactive', key: 'node-1' },
    maintenance: true,
    exposedToolNames: new Set(names),
    getActiveMaintenanceExecutionContext: () => context,
    isServing: () => true,
    onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
    onShowImage: () => ({ error: 'unused' }),
  }, { workspaceId: 'ws-1' });
}

async function listed(names: readonly string[]): Promise<Array<{ name: string; inputSchema: any }>> {
  const server = buildMcpServerForSlot(slot(names)) as any;
  return (await server.server._requestHandlers.get('tools/list')({ method: 'tools/list', params: {} }, { signal: new AbortController().signal })).tools;
}

test('the extraction profile is a restricted Meta agent profile of exactly three host tools, memory_extract, memory_profile and memory_consolidate', () => {
  const profile = memoryExtractionToolProfile();
  // Every automatic memory session lists all three, whichever kind of run opens it (one Kiro agent file per toolset).
  assert.deepEqual(profile.allowedToolNames, ['memory_extract', 'memory_profile', 'memory_consolidate']);
  assert.equal(profile.restricted, true);
  assert.equal(profile.maintenance, true);
  assert.equal(metaAgentToolsetOf(profile), 'memory');
  const config = { runtimeId: 'pi', providerId: null, modelId: null, reasoning: null };
  assert.notEqual(memoryExtractionProfileHash(config), memoryExtractionProfileHash({ ...config, modelId: 'other' }));
  assert.notEqual(memoryExtractionProfileHash(config), memoryExtractionProfileHash(config, 'profile'), 'a profile rebuild is its own session profile');
  assert.notEqual(memoryExtractionProfileHash(config, 'consolidate'), memoryExtractionProfileHash(config, 'profile'), 'so is a consolidation run');
  assert.notEqual(memoryExtractionProfileHash(config, 'consolidate'), memoryExtractionProfileHash(config));
  // The adapters' launch-time catalog check: the three tools pass; anything else, including a chat memory tool or a shell, fails.
  assert.doesNotThrow(() => assertMetaAgentToolCatalog({ runtimeId: 'pi', profile, observed: [...MEMORY_EXTRACTION_TOOL_NAMES] }));
  for (const extra of ['memory_save', 'memory_search', 'memory_propose', 'maintenance_write_page', 'bash', 'web_search']) {
    assert.throws(() => assertMetaAgentToolCatalog({ runtimeId: 'pi', profile, observed: [...MEMORY_EXTRACTION_TOOL_NAMES, extra] }),
      (error: unknown) => isMetaAgentGuardError(error) && error.message.includes(extra), extra);
  }
  // Each kind of run's session instructions answer with its own tool.
  const instructions = memoryExtractionBootstrapInstructions();
  assert.match(instructions, /Call `memory_extract` exactly once/);
  const profileInstructions = memoryProfileBootstrapInstructions();
  assert.match(profileInstructions, /calling `memory_profile` exactly once/);
  assert.doesNotMatch(profileInstructions, /memory_extract/);
  const consolidation = CONSOLIDATION_INSTRUCTIONS(MEMORY_CONSOLIDATE_TOOL_NAME);
  assert.match(consolidation, /Call memory_consolidate exactly once with \{ decisions \}/);
  assert.doesNotMatch(consolidation, /memory_extract|memory_profile/);
});

test('an extraction slot serves only the extraction tools; a Pages maintenance slot serves none of them', async () => {
  const tools = await listed(MEMORY_EXTRACTION_TOOL_NAMES);
  assert.deepEqual(tools.map((tool) => tool.name), ['memory_extract', 'memory_profile', 'memory_consolidate']);
  const extract = tools[0]!.inputSchema;
  assert.deepEqual(Object.keys(extract.properties).sort(), ['exclude_turns', 'forget', 'memories', 'turn_keys']);
  assert.match(extract.properties.exclude_turns.description, /asked not to remember or took back: nothing is saved from them/);
  assert.match(extract.properties.forget.description, /^The refs \(m:…\) of listed memories not marked savedByUser whose content these turns decline or take back, said before them: they are deleted; \[\] when none\.$/);
  const memory = extract.properties.memories.items;
  assert.deepEqual(Object.keys(memory.properties).sort(),
    ['about', 'body', 'event_date', 'explicit', 'keywords', 'kind', 'op', 'quote', 'source_turn', 'target', 'topic']);
  assert.match(memory.properties.explicit.description, /asked in their own words to remember it/);
  assert.match(memory.properties.kind.description, /preference, fact, decision or convention/);
  assert.match(memory.properties.quote.description, /copied exactly/);
  assert.equal(memory.properties.keywords.type, 'array');
  assert.deepEqual(memory.properties.target.anyOf?.map((branch: { type: string }) => branch.type) ?? memory.properties.target.type, ['string', 'null'],
    'an optional field may be null');
  assert.deepEqual(Object.keys(extract.properties.turn_keys.items.properties).sort(), ['keys', 'source_turn']);
  // Required fields, enums and lengths are enforced by the host, so a malformed call is a counted, repairable error.
  assert.deepEqual(extract.required ?? [], []);
  assert.deepEqual(memory.required ?? [], []);
  assert.equal(memory.properties.kind.enum, undefined);
  assert.equal(memory.properties.body.maxLength, undefined);
  // memory_profile lists sections of topic and lines of { text, refs }, with descriptions, enforcing nothing itself.
  const profile = tools[1]!.inputSchema;
  assert.deepEqual(Object.keys(profile.properties), ['sections']);
  const section = profile.properties.sections.items;
  assert.deepEqual(Object.keys(section.properties).sort(), ['lines', 'topic']);
  assert.deepEqual(Object.keys(section.properties.lines.items.properties).sort(), ['refs', 'text']);
  assert.match(section.properties.lines.items.properties.refs.description, /refs \(m:…\) of the listed notes/);
  assert.deepEqual(profile.required ?? [], []);
  assert.equal(section.properties.topic.maxLength, undefined);
  // memory_consolidate lists decisions of { ref, op, into, why }, with descriptions, enforcing nothing itself.
  const consolidate = tools[2]!.inputSchema;
  assert.deepEqual(Object.keys(consolidate.properties), ['decisions']);
  const decision = consolidate.properties.decisions.items;
  assert.deepEqual(Object.keys(decision.properties).sort(), ['into', 'op', 'ref', 'why']);
  assert.match(decision.properties.op.description, /keep \(the default\), duplicate .* or outdated/);
  assert.equal(decision.properties.op.enum, undefined);
  assert.deepEqual(consolidate.required ?? [], []);

  const maintenance = await listed(META_AGENT_MAINTENANCE_TOOL_NAMES);
  assert.equal(maintenance.some((tool) => tool.name.startsWith('memory_')), false);
  assert.deepEqual(maintenance.map((tool) => tool.name).sort(), [...META_AGENT_MAINTENANCE_TOOL_NAMES].sort());
});

test('extraction tools refuse a call without a bound extraction run', async () => {
  const registered = (buildMcpServerForSlot(slot(MEMORY_EXTRACTION_TOOL_NAMES)) as any)._registeredTools as Record<string, { handler(args: unknown): Promise<any> }>;
  const result = await registered.memory_extract!.handler({ memories: [], turn_keys: [] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No automatic memory run owns this tool call/);
  const pagesRun = { workspaceId: 'ws-1', ownerUserId: 'local-user', jobId: 'job', runId: 'run', claimedBy: 'x', configRevision: 1,
    planId: 'mpl-1', sources: [], execution: { nodeId: 'n', turnId: 't', assistantId: 'a', runId: 'run' } } as MaintenanceExecutionContext;
  const [extract, , consolidate] = createMemoryExtractionTools(pagesRun);
  assert.match(extract!.execute({ memories: [], turn_keys: [] }).content[0]!.text, /not bound to an automatic memory run/);
  assert.match(consolidate!.execute({ decisions: [] }).content[0]!.text, /not bound to an automatic memory run/);
});

test('Kiro runs extraction as its own Meta agent with only the extraction tools', () => {
  const config = kiroMetaAgentConfig('memory', MEMORY_EXTRACTION_TOOL_NAMES) as any;
  assert.equal(config.name, 'michi-meta-agent-memory');
  assert.deepEqual(config.allowedTools, MEMORY_EXTRACTION_TOOL_NAMES.map((name) => `@michi/${name}`));
  assert.deepEqual(config.mcpServers, {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-memory-'));
  try {
    const memory = ensureKiroMetaAgent(dataDir, 'memory', MEMORY_EXTRACTION_TOOL_NAMES);
    const maintenance = ensureKiroMetaAgent(dataDir, 'maintenance', META_AGENT_MAINTENANCE_TOOL_NAMES);
    assert.equal(memory.dir, kiroMetaAgentDir(dataDir, 'memory'));
    assert.notEqual(memory.dir, maintenance.dir, 'its agent file never overwrites the Pages maintenance agent');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
