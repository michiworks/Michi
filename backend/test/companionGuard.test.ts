/**
 * A check-in's closed profile (DESIGN-v2 §2.2-§2.5): its sessions run with
 * the closed 'chat' toolset and the allow-list CHECKIN_TOOL_NAMES on every
 * runtime, so it has no native tools, no user MCP servers and never
 * bypasses permissions; only its own allow-list runs without an approval
 * prompt, in every permission mode (narrowed to the session's profile, so
 * start_conversation and ask_user never pass); and a launch catalog with
 * anything extra fails closed (MetaAgentGuardError). The MCP slot and Pi
 * catalogs themselves are checked in companionPurpose.test.ts. Pure policy
 * functions: no runtime, CLI or network.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatPermissionMode } from 'michi-shared';
import { PAGE_TOOL_NAMES } from '../src/agents/pageToolNames';
import { SCHEDULED_JOB_TOOL_NAMES } from '../src/agents/scheduledJobToolNames';
import { MEMORY_TOOL_NAMES } from '../src/agents/memoryToolNames';
import {
  MetaAgentGuardError,
  assertMetaAgentToolCatalog,
  checkMetaAgentToolCatalog,
  isMetaAgentProfile,
  metaAgentToolsetOf,
} from '../src/agents/metaAgentGuard';
import { KIRO_META_AGENT_NAMES, kiroMetaAgentConfig } from '../src/agents/kiro/kiroMetaAgent';
import {
  ASSISTANT_CHANNEL_TOOL_NAMES,
  CHECKIN_TOOL_NAMES,
  CLAUDE_ASSISTANT_DISALLOWED_TOOLS,
  LAYOUT_RULES_TOOL,
  MAIN_TOOL_NAMES,
  START_CONVERSATION_TOOL,
  TURN_METADATA_TOOL_NAMES,
  assistantProfileHash,
  assistantToolNamesFor,
  assistantToolProfile,
  claudeAssistantApproval,
  claudeSpawnPolicy,
  codexAssistantApproval,
  codexThreadSandbox,
  piAssistantToolDecision,
} from '../src/assistant/policy';

const PROFILE = assistantToolProfile('checkin');
const COMPANION_TOOL_NAMES = CHECKIN_TOOL_NAMES;
const MODES: Array<ChatPermissionMode | undefined> = ['ask', 'trust', 'yolo', undefined];
/** Page tools that only read; every other Page tool writes. */
const PAGE_READS = new Set(['read_home', 'list_pages', 'read_page', 'read_database', 'list_page_components', 'read_page_component', 'list_tasks']);
/** The Page writes a check-in has, behind checkinPageGuard.ts (§2.6); every other Page write is V's only. */
const CHECKIN_PAGE_WRITES = new Set(['edit_page', 'create_page', 'edit_database', 'create_database', 'configure_database', 'open_task_database']);
const PAGE_WRITES = PAGE_TOOL_NAMES.filter((name) => !PAGE_READS.has(name) && !CHECKIN_PAGE_WRITES.has(name));
const NATIVE = ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task', 'read', 'write', 'edit', 'bash', 'ls', 'grep', 'find', 'web_search', 'fetch_content'];

describe('a check-in\'s closed profile (DESIGN-v2 §2.2-§2.5)', () => {
  test('the closed chat toolset with exactly CHECKIN_TOOL_NAMES (30); V stays open', () => {
    assert.deepEqual(PROFILE, { assistant: true, restricted: true, metaAgentToolset: 'chat', allowedToolNames: CHECKIN_TOOL_NAMES });
    assert.equal(metaAgentToolsetOf(PROFILE), 'chat');
    assert.equal(isMetaAgentProfile(PROFILE), true);
    assert.deepEqual(assistantToolNamesFor('checkin'), CHECKIN_TOOL_NAMES);
    assert.equal(CHECKIN_TOOL_NAMES.length, 30, '§2.3: S has 30 tools (with companion_headline, Q45)');
    assert.equal(new Set(COMPANION_TOOL_NAMES).size, COMPANION_TOOL_NAMES.length);
    assert.ok(Object.isFrozen(COMPANION_TOOL_NAMES));
    assert.deepEqual(assistantToolProfile('main'), { assistant: true });
    assert.equal(metaAgentToolsetOf(assistantToolProfile('main')), null, 'V keeps the runtime\'s own tools');
    assert.deepEqual(assistantToolProfile(), { assistant: true });
    assert.deepEqual(assistantToolNamesFor('main'), MAIN_TOOL_NAMES);
    const runtime = { runtimeId: 'claude', modelId: null };
    assert.notEqual(assistantProfileHash(runtime, 'checkin'), assistantProfileHash(runtime, 'main'), 'an open session is never resumed as a closed one');
  });

  test('its catalog holds reads, guarded Page writes and its own hidden-turn tools: no native, conversation, job, memory, ask_user or V-only tool', () => {
    const forbidden = [
      ...NATIVE, ...PAGE_WRITES, ...SCHEDULED_JOB_TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...ASSISTANT_CHANNEL_TOOL_NAMES, ...TURN_METADATA_TOOL_NAMES,
      START_CONVERSATION_TOOL, LAYOUT_RULES_TOOL, 'send_to_thread', 'wait_pane', 'save_artifact', 'update_artifact', 'spawn_branches', 'open_url', 'show_image',
      'read_home', 'list_page_components', 'read_page_component', 'companion_read', 'companion_check_now', 'companion_set_name', 'companion_session_send',
    ];
    for (const name of forbidden) assert.equal(COMPANION_TOOL_NAMES.includes(name), false, name);
    for (const name of ['list_threads', 'read_node', 'read_conversation_updates', 'list_tasks', 'list_panes', 'inspect_pane', 'read_pane_output', 'michi_docs',
      ...CHECKIN_PAGE_WRITES, 'companion_edit_goal', 'companion_update_item', 'companion_propose', 'nothing_to_do']) {
      assert.ok(COMPANION_TOOL_NAMES.includes(name), `${name} (§2.3) is a check-in's`);
    }
    assert.equal(MAIN_TOOL_NAMES.includes('nothing_to_do'), false, 'only a check-in ends quietly');
    assert.equal(MAIN_TOOL_NAMES.includes('companion_read'), true, 'V reads what its check-ins wrote');
  });

  test('Claude: in every permission mode, no built-in tools, no settings, no other MCP server, never bypass', () => {
    for (const permissionMode of MODES) {
      for (const ownerMode of ['interactive', 'headless'] as const) {
        assert.deepEqual(claudeSpawnPolicy({ ownerMode, permissionMode, toolProfile: PROFILE }), {
          permissionMode: 'default',
          tools: [],
          disallowedTools: CLAUDE_ASSISTANT_DISALLOWED_TOOLS,
          strictMcpConfig: true,
          isolateSettings: true,
          restrictedMode: true,
        }, `${ownerMode} ${String(permissionMode)}`);
      }
    }
    for (const name of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'ToolSearch']) {
      assert.ok(CLAUDE_ASSISTANT_DISALLOWED_TOOLS.includes(name), `${name} is denied even where --tools is ignored`);
    }
    // For contrast: V in YOLO bypasses, as any chat does.
    assert.equal(claudeSpawnPolicy({ ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: assistantToolProfile('main') }).permissionMode, 'bypassPermissions');
  });

  test('approvals: exactly the session profile\'s allow-list runs without a prompt on Claude and Pi; nothing else, Codex declines every request', () => {
    for (const name of COMPANION_TOOL_NAMES) {
      assert.equal(claudeAssistantApproval(name, PROFILE), 'allow', name);
      assert.equal(piAssistantToolDecision(name, PROFILE), 'allow', name);
    }
    assert.equal(claudeAssistantApproval(null, PROFILE), 'deny', 'a native tool has no Michi name');
    // Before v2 the gate let through the union of every closed catalog, start_conversation and ask_user included (§2.5).
    for (const name of [...NATIVE, START_CONVERSATION_TOOL, 'ask_user', 'send_to_thread', 'edit_home', 'configure_database_view', 'companion_read',
      ...SCHEDULED_JOB_TOOL_NAMES, ...MEMORY_TOOL_NAMES, 'mcp__user__tool', 'companion_apply_card']) {
      assert.equal(claudeAssistantApproval(name, PROFILE), 'deny', name);
      assert.equal(piAssistantToolDecision(name, PROFILE), 'block', name);
    }
    // Narrowed to the session: a closed profile listing less lets less through; no profile, or an open one, lets nothing through.
    const narrow = { ...PROFILE, allowedToolNames: ['list_threads'] };
    assert.equal(claudeAssistantApproval('list_threads', narrow), 'allow');
    assert.equal(claudeAssistantApproval('companion_items', narrow), 'deny');
    assert.equal(piAssistantToolDecision('companion_items', narrow), 'block');
    assert.equal(claudeAssistantApproval('list_threads'), 'deny');
    assert.equal(piAssistantToolDecision('list_threads', assistantToolProfile('main')), 'block');
    assert.equal(codexAssistantApproval(), 'decline', 'commands, file changes, extra permissions and elicitations');
  });

  test('Codex: read-only sandbox for a check-in\'s threads', () => {
    assert.equal(codexThreadSandbox(PROFILE), 'read-only');
    assert.equal(codexThreadSandbox({ ...PROFILE, metaAgentToolset: undefined }), 'read-only', 'restricted alone is enough');
    assert.equal(codexThreadSandbox(assistantToolProfile('main')), 'workspace-write');
  });

  test('Kiro: the restricted agent has a check-in\'s Michi tools and nothing else', () => {
    const config = kiroMetaAgentConfig('chat', COMPANION_TOOL_NAMES) as {
      name: string; tools: string[]; allowedTools: string[]; mcpServers: object; includeMcpJson: boolean; resources: unknown[]; hooks: unknown[];
      permissions: { rules: Array<{ capability: string; match: string[]; effect: string }> };
    };
    assert.equal(config.name, KIRO_META_AGENT_NAMES.chat);
    assert.deepEqual(config.tools, ['@michi']);
    assert.deepEqual(config.allowedTools, COMPANION_TOOL_NAMES.map((name) => `@michi/${name}`));
    assert.deepEqual(config.mcpServers, {}, 'none of the user\'s MCP servers');
    assert.equal(config.includeMcpJson, false);
    assert.deepEqual([config.resources, config.hooks], [[], []]);
    assert.deepEqual(config.permissions.rules, [{ capability: 'mcp', match: COMPANION_TOOL_NAMES.map((name) => `michi/${name}`), effect: 'allow' }]);
  });

  test('the launch catalog check fails closed on anything beyond the allow-list', () => {
    for (const runtimeId of ['claude', 'codex', 'kiro', 'pi']) {
      assertMetaAgentToolCatalog({ runtimeId, profile: PROFILE, observed: [...COMPANION_TOOL_NAMES] });
      assertMetaAgentToolCatalog({ runtimeId, profile: PROFILE, observed: COMPANION_TOOL_NAMES.slice(0, 2) });
      for (const extra of ['Bash', START_CONVERSATION_TOOL, 'edit_home', 'send_to_thread', 'ask_user', 'mcp:user-server:delete_everything']) {
        assert.throws(() => assertMetaAgentToolCatalog({ runtimeId, profile: PROFILE, observed: [...COMPANION_TOOL_NAMES, extra] }), (error: unknown) => {
          assert.ok(error instanceof MetaAgentGuardError);
          assert.deepEqual(error.violation, { runtimeId, toolset: 'chat', unexpectedTools: [extra] });
          assert.equal(error.code, 'meta_agent_guard_failed');
          return true;
        }, `${runtimeId} ${extra}`);
      }
    }
    assert.deepEqual(checkMetaAgentToolCatalog({ runtimeId: 'kiro', toolset: 'chat', observed: ['list_threads', 'Bash', 'Bash'], allowed: [...COMPANION_TOOL_NAMES] }),
      { runtimeId: 'kiro', toolset: 'chat', unexpectedTools: ['Bash'] });
    assert.throws(() => assertMetaAgentToolCatalog({ runtimeId: 'claude', profile: { ...PROFILE, allowedToolNames: undefined }, observed: ['list_threads'] }),
      MetaAgentGuardError, 'a profile without its allow-list permits nothing');
  });
});
