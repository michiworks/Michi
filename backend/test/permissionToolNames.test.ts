/**
 * The permission tool names each adapter sends: to the Agent Run permission
 * broker, and as the key of a chat always-allow grant. Each table lists every
 * name a runtime can send today, with the broker name, the default broker's
 * category and the grant key. The `before` functions are the code these
 * names came from before the adapters canonicalized them, so every row also
 * proves the move kept the name and the decision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentPolicyCategory, AgentPolicyDecision } from 'michi-shared';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import type { AgentRunSpec } from '../src/agents/runs/ports';
import type { RuntimePermissionBroker } from '../src/agents/types';
import { michiGrantKey } from '../src/agents/permissionPolicy';
import { michiPermissionPolicy } from '../src/agents/chatApprovalState';
import { canonicalClaudeToolName, MICHI_MCP_TOOL_PREFIX } from 'michi-runtime/internal/adapters/claude/claudeToolNames';
import { MICHI_MCP_TOOL_PREFIX as CLAUDE_MCP_CONFIG_PREFIX } from 'michi-runtime/internal/adapters/claude/claudeMcpConfig';
import { canonicalToolNameFromMethod } from 'michi-runtime/internal/adapters/codex/CodexSession';
import { acpPermissionToolName, canonicalKiroToolName, kiroBrokerToolName, KiroToolCallNames } from 'michi-runtime/internal/adapters/kiro/kiroToolNames';
import { CODEX_SERVER_REQUESTS } from 'michi-runtime/internal/adapters/codex/codexProtocol';
import { runOwner } from './helpers/owners';

/** The category RuntimeRunExecutor's default broker files a tool name under. */
async function brokerCategory(toolName: string): Promise<string> {
  const executor = new RuntimeRunExecutor() as unknown as {
    createPermissionBroker(input: { spec: AgentRunSpec }): RuntimePermissionBroker;
  };
  const matches: string[] = [];
  for (const category of Object.values(AgentPolicyCategory)) {
    const spec = { effectiveDefinition: { permissionPolicy: { categories: { [category]: AgentPolicyDecision.Allow } } } } as unknown as AgentRunSpec;
    const decision = await executor.createPermissionBroker({ spec }).requestPermission({
      owner: runOwner('r', 'a'), ownerUserId: null, workspaceId: null, toolName, input: {},
    });
    if (decision === 'allow_once') matches.push(category);
  }
  return matches.length === Object.values(AgentPolicyCategory).length ? '(always allowed)' : matches.join('+');
}

// ---- before: the sources of these names before the move ----------------------

const BEFORE_CLAUDE_ALIASES: Record<string, string> = { Bash: 'bash', Edit: 'edit', Write: 'write', MultiEdit: 'edit', NotebookEdit: 'edit' };
/** permissionPolicy.canonicalPermissionToolName (now michiGrantKey). */
const beforeGrantKey = (name: string) => BEFORE_CLAUDE_ALIASES[name] ?? name;
/** ClaudeSession's broker name, then RuntimeRunExecutor's own aliases. */
const beforeClaudeBrokerName = (name: string) => {
  const sent = ({ Read: 'read', Glob: 'find', Grep: 'grep' } as Record<string, string>)[name] ?? name.replace(/^mcp____michi_internal____/, '');
  return sent === 'Bash' ? 'bash' : ['Edit', 'MultiEdit', 'NotebookEdit'].includes(sent) ? 'edit' : sent === 'Write' ? 'write' : sent;
};
/** AcpAgentSession's broker name, then RuntimeRunExecutor's own aliases. */
const beforeKiroBrokerName = (toolCall: unknown, meta: unknown) => {
  const sent = acpPermissionToolName(toolCall, meta) ?? 'unknown';
  return sent === 'Bash' ? 'bash' : ['Edit', 'MultiEdit', 'NotebookEdit'].includes(sent) ? 'edit' : sent === 'Write' ? 'write' : sent;
};
/** CodexSession's broker name. */
const beforeCodexBrokerName = (method: string) => beforeGrantKey(canonicalToolNameFromMethod(method));

/** ClaudeSession strips Michi's MCP prefix from an SDK name before any permission check. */
const sessionName = (sdkName: string) => sdkName.replace(/^mcp____michi_internal____/, '');

// [SDK tool name, broker name, broker category, chat grant key]
const CLAUDE_NAMES: Array<[string, string, string, string]> = [
  ['Read', 'read', 'read', 'Read'],
  ['Glob', 'find', 'search', 'Glob'],
  ['Grep', 'grep', 'search', 'Grep'],
  ['Bash', 'bash', 'shell_exec', 'bash'],
  ['Edit', 'edit', 'filesystem_write', 'edit'],
  ['MultiEdit', 'edit', 'filesystem_write', 'edit'],
  ['NotebookEdit', 'edit', 'filesystem_write', 'edit'],
  ['Write', 'write', 'filesystem_write', 'write'],
  ['WebFetch', 'WebFetch', 'external_action', 'WebFetch'],
  ['WebSearch', 'WebSearch', 'external_action', 'WebSearch'],
  ['Agent', 'Agent', 'external_action', 'Agent'],
  ['Task', 'Task', 'external_action', 'Task'],
  ['TaskOutput', 'TaskOutput', 'external_action', 'TaskOutput'],
  ['TaskStop', 'TaskStop', 'external_action', 'TaskStop'],
  ['TodoWrite', 'TodoWrite', 'external_action', 'TodoWrite'],
  ['AskUserQuestion', 'AskUserQuestion', 'external_action', 'AskUserQuestion'],
  ['EnterPlanMode', 'EnterPlanMode', 'external_action', 'EnterPlanMode'],
  ['ExitPlanMode', 'ExitPlanMode', 'external_action', 'ExitPlanMode'],
  ['ToolSearch', 'ToolSearch', 'external_action', 'ToolSearch'],
  ['mcp____michi_internal____read_node', 'read_node', 'read', 'read_node'],
  ['mcp____michi_internal____read_node_overview', 'read_node_overview', 'read', 'read_node_overview'],
  ['mcp____michi_internal____read_conversation_updates', 'read_conversation_updates', 'read', 'read_conversation_updates'],
  ['mcp____michi_internal____list_threads', 'list_threads', 'read', 'list_threads'],
  ['mcp____michi_internal____show_image', 'show_image', 'read', 'show_image'],
  ['mcp____michi_internal____list_agents', 'list_agents', 'read', 'list_agents'],
  ['mcp____michi_internal____check_agent', 'check_agent', 'read', 'check_agent'],
  ['mcp____michi_internal____wait_agent', 'wait_agent', 'read', 'wait_agent'],
  ['mcp____michi_internal____search_messages', 'search_messages', 'search', 'search_messages'],
  ['mcp____michi_internal____web_search', 'web_search', 'browse', 'web_search'],
  ['mcp____michi_internal____save_artifact', 'save_artifact', 'artifact_write', 'save_artifact'],
  ['mcp____michi_internal____update_artifact', 'update_artifact', 'artifact_write', 'update_artifact'],
  ['mcp____michi_internal____spawn_branches', 'spawn_branches', 'artifact_write', 'spawn_branches'],
  ['mcp____michi_internal____spawn_agent', 'spawn_agent', 'spawn_agent', 'spawn_agent'],
  ['mcp____michi_internal____send_to_thread', 'send_to_thread', 'external_action', 'send_to_thread'],
  ['mcp____michi_internal____set_follow_ups', 'set_follow_ups', 'external_action', 'set_follow_ups'],
  ['mcp____michi_internal____set_branch_overview', 'set_branch_overview', 'external_action', 'set_branch_overview'],
  ['mcp____michi_internal____michi_docs', 'michi_docs', 'read', 'michi_docs'],
  ['mcp____michi_internal____michi_skills', 'michi_skills', 'read', 'michi_skills'],
  ['mcp____michi_internal____inspect_pane', 'inspect_pane', 'read', 'inspect_pane'],
  ['mcp____michi_internal____read_pane_output', 'read_pane_output', 'read', 'read_pane_output'],
  ['mcp____michi_internal____list_panes', 'list_panes', 'read', 'list_panes'],
  ['mcp____michi_internal____wait_pane', 'wait_pane', 'read', 'wait_pane'],
  ['mcp____michi_internal____open_url', 'open_url', 'external_action', 'open_url'],
  ['mcp____michi_internal____report_conversation_no_change', 'report_conversation_no_change', 'external_action', 'report_conversation_no_change'],
  ['mcp____michi_internal____submit_agent_result', 'submit_agent_result', '(always allowed)', 'submit_agent_result'],
  ['mcp____michi_internal____mcp____michi_internal____read_node', 'read_node', 'read', 'mcp____michi_internal____read_node'],
  ['mcp__github__create_issue', 'mcp__github__create_issue', 'external_action', 'mcp__github__create_issue'],
  ['mcp__michi_internal__read_node', 'mcp__michi_internal__read_node', 'external_action', 'mcp__michi_internal__read_node'],
  ['read', 'read', 'read', 'read'],
  ['bash', 'bash', 'shell_exec', 'bash'],
  ['fs_read', 'fs_read', 'external_action', 'fs_read'],
  ['execute_bash', 'execute_bash', 'external_action', 'execute_bash'],
  ['frobnicate', 'frobnicate', 'external_action', 'frobnicate'],
];

test('Claude sends the broker the names and categories it sent before, and keeps every grant key', async () => {
  for (const [sdkName, brokerName, category, grantKey] of CLAUDE_NAMES) {
    const name = sessionName(sdkName);
    assert.equal(canonicalClaudeToolName(name), brokerName, `${sdkName}: broker name`);
    assert.equal(beforeClaudeBrokerName(name), brokerName, `${sdkName}: the broker classified the same name before`);
    assert.equal(await brokerCategory(brokerName), category, `${sdkName}: category`);
    assert.equal(michiGrantKey(name), grantKey, `${sdkName}: grant key`);
    assert.equal(michiPermissionPolicy.grantKey!(name), grantKey, `${sdkName}: grant key Claude reads from the host`);
    assert.equal(beforeGrantKey(name), grantKey, `${sdkName}: grant key before`);
  }
});

test('claudeToolNames strips the same Michi MCP prefix claudeMcpConfig names tools with', () => {
  assert.equal(MICHI_MCP_TOOL_PREFIX, CLAUDE_MCP_CONFIG_PREFIX);
  assert.equal(canonicalClaudeToolName(`${CLAUDE_MCP_CONFIG_PREFIX}read_node`), 'read_node');
});

test('Claude tool names that are Object.prototype keys stay plain names', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(canonicalClaudeToolName(name), name);
    assert.equal(michiGrantKey(name), name);
  }
});

// [approval method, broker and grant name, broker category]
const CODEX_METHODS: Array<[string, string, string]> = [
  [CODEX_SERVER_REQUESTS.commandApproval, 'bash', 'shell_exec'],
  [CODEX_SERVER_REQUESTS.fileChangeApproval, 'edit', 'filesystem_write'],
  // Not routed to an approval prompt today; listed so the mapping stays total.
  [CODEX_SERVER_REQUESTS.permissionsApproval, 'requestApproval', 'external_action'],
  [CODEX_SERVER_REQUESTS.requestUserInput, 'requestUserInput', 'external_action'],
  [CODEX_SERVER_REQUESTS.mcpElicitation, 'request', 'external_action'],
  [CODEX_SERVER_REQUESTS.currentTime, 'read', 'read'],
  ['item/unknownTool/requestApproval', 'requestApproval', 'external_action'],
];

test('Codex sends the broker the names and categories it sent before', async () => {
  assert.deepEqual(new Set(CODEX_METHODS.map(([method]) => method)),
    new Set([...Object.values(CODEX_SERVER_REQUESTS), 'item/unknownTool/requestApproval']), 'every server request is listed');
  for (const [method, name, category] of CODEX_METHODS) {
    assert.equal(canonicalToolNameFromMethod(method), name, `${method}: broker name`);
    assert.equal(beforeCodexBrokerName(method), name, `${method}: the broker received the same name before`);
    assert.equal(michiGrantKey(name), name, `${method}: grant key`);
    assert.equal(await brokerCategory(name), category, `${method}: category`);
  }
});

// [request, broker name, category, category before, chat grant key (null: no grant offered)]
const title = (text: string) => ({ toolCall: { title: text } });
const v3Shell = (command: string) => ({ toolCall: { toolCallId: 't', status: 'pending', title: command },
  meta: { kiro: { toolId: 'run_command', command, consent: { capability: 'shell', resource: command } } } });
const meta = (name: string) => ({ toolCall: { title: 'Using a tool' }, meta: { toolName: name } });
/** kiro-cli 3.1.0's request for an MCP tool, as recorded: v3 and v2 (`--agent-engine v2`). */
const v3Mcp = (server: string, tool: string) => ({ toolCall: { toolCallId: 't', status: 'pending', title: `@${server}/${tool}` },
  meta: { kiro: { toolId: `mcp_${server}_${tool}`, agentManagesTrust: true, consentRound: 1,
    consent: { capability: 'mcp', resource: `${server}/${tool}`, askType: 'implicit', workspaceRoot: '/tmp' },
    mcpTool: { version: 1, identity: { serverName: server, toolName: tool }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } } } } });
const v2Mcp = (server: string, tool: string) => ({ toolCall: { toolCallId: 't', title: `Running: @${server}/${tool}`, rawInput: {} },
  meta: { mcpToolIdentity: { serverName: server, toolName: tool }, mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } } });
const KIRO_REQUESTS: Array<[string, { toolCall: unknown; meta?: unknown }, string, string, string, string | null]> = [
  ['title fs_read', title('fs_read'), 'read', 'read', 'external_action', 'fs_read'],
  ['title fs_write', title('fs_write'), 'write', 'filesystem_write', 'external_action', 'fs_write'],
  ['title execute_bash', title('execute_bash'), 'bash', 'shell_exec', 'external_action', 'execute_bash'],
  ['meta execute_bash', meta('execute_bash'), 'bash', 'shell_exec', 'external_action', 'execute_bash'],
  ['toolCall meta fs_write', { toolCall: { title: 'x', _meta: { toolName: 'fs_write' } } }, 'write', 'filesystem_write', 'external_action', 'fs_write'],
  ['title use_aws', title('use_aws'), 'use_aws', 'external_action', 'external_action', 'use_aws'],
  ['title Bash', title('Bash'), 'bash', 'shell_exec', 'shell_exec', 'bash'],
  ['title Edit', title('Edit'), 'edit', 'filesystem_write', 'filesystem_write', 'edit'],
  ['title Write', title('Write'), 'write', 'filesystem_write', 'filesystem_write', 'write'],
  ['meta MultiEdit', meta('MultiEdit'), 'edit', 'filesystem_write', 'filesystem_write', 'edit'],
  ['meta NotebookEdit', meta('NotebookEdit'), 'edit', 'filesystem_write', 'filesystem_write', 'edit'],
  ['title Read', title('Read'), 'read', 'read', 'external_action', 'Read'],
  ['title read', title('read'), 'read', 'read', 'read', 'read'],
  ['title write', title('write'), 'write', 'filesystem_write', 'filesystem_write', 'write'],
  ['title edit', title('edit'), 'edit', 'filesystem_write', 'filesystem_write', 'edit'],
  ['title bash', title('bash'), 'bash', 'shell_exec', 'shell_exec', 'bash'],
  // Michi's own tools reach the broker by their own names, as on Claude; grant keys keep Kiro's spelling.
  ['title @michi/send_to_thread', title('@michi/send_to_thread'), 'send_to_thread', 'external_action', 'external_action', '@michi/send_to_thread'],
  ['title @michi/list_ready_models', title('@michi/list_ready_models'), 'list_ready_models', 'external_action', 'external_action', '@michi/list_ready_models'],
  ['title @michi/propose_multi_model_plan', title('@michi/propose_multi_model_plan'), 'propose_multi_model_plan', 'external_action', 'external_action', '@michi/propose_multi_model_plan'],
  ['meta @michi/read_node', meta('@michi/read_node'), 'read_node', 'read', 'external_action', '@michi/read_node'],
  ['meta @michi/inspect_pane', meta('@michi/inspect_pane'), 'inspect_pane', 'read', 'external_action', '@michi/inspect_pane'],
  ['meta @michi/submit_agent_result', meta('@michi/submit_agent_result'), 'submit_agent_result', '(always allowed)', 'external_action', '@michi/submit_agent_result'],
  ['v3 Michi tool id', { toolCall: { title: 'x' }, meta: { kiro: { toolId: 'michi::read_node' } } }, 'read_node', 'read', 'external_action', '@michi/read_node'],
  ['meta MCP tool', meta('@github/create_issue'), '@github/create_issue', 'external_action', 'external_action', '@github/create_issue'],
  ['prose title', title('Running: rm -rf build'), 'unknown', 'external_action', 'external_action', null],
  // kiro-cli 2.34.0 v2: no name in the request; the tool_call update before it has _meta.kiro.toolName.
  ['v2 shell request', { toolCall: { toolCallId: 't', title: 'Running: echo hi', rawInput: { command: 'echo hi' } },
    meta: { trustOptions: [{ setting_key: 'allowedCommands', patterns: ['echo hi'] }] } }, 'unknown', 'external_action', 'external_action', null],
  // kiro-cli 2.34.0 v3: the name is _meta.kiro.toolId.
  ['v3 run_command request', { toolCall: { toolCallId: 't', status: 'pending', title: 'echo hi' },
    meta: { kiro: { toolId: 'run_command', consent: { capability: 'shell', resource: 'echo hi' } } } }, 'bash', 'shell_exec', 'external_action', null],
  ['v3 fs_write request', { toolCall: { toolCallId: 't', status: 'pending', title: 'Write File' },
    meta: { kiro: { toolId: 'fs_write', consent: { capability: 'fs_write', resource: 'probe.txt' } } } }, 'write', 'filesystem_write', 'external_action', null],
  ['v3 unknown toolId', { toolCall: { title: 'x' }, meta: { kiro: { toolId: 'frobnicate' } } }, 'frobnicate', 'external_action', 'external_action', null],
  // A v3 shell request is titled with its command; the tool id outranks a built-in title.
  ['v3 run_command titled write', v3Shell('write'), 'bash', 'shell_exec', 'filesystem_write', 'write'],
  ['v3 run_command titled fs_write', v3Shell('fs_write'), 'bash', 'shell_exec', 'external_action', 'fs_write'],
  ['v3 run_command titled Read', v3Shell('Read'), 'bash', 'shell_exec', 'external_action', 'Read'],
  ['v3 run_command titled read', v3Shell('read'), 'bash', 'shell_exec', 'read', 'read'],
  ['v3 run_command titled fs_read', v3Shell('fs_read'), 'bash', 'shell_exec', 'external_action', 'fs_read'],
  ['v3 run_command titled edit', v3Shell('edit'), 'bash', 'shell_exec', 'filesystem_write', 'edit'],
  ['v3 run_command titled Write', v3Shell('Write'), 'bash', 'shell_exec', 'filesystem_write', 'write'],
  ['v3 fs_write titled execute_bash', { toolCall: { title: 'execute_bash' }, meta: { kiro: { toolId: 'fs_write' } } },
    'write', 'filesystem_write', 'external_action', 'execute_bash'],
  ['v3 blank toolId', { toolCall: { title: 'x' }, meta: { kiro: { toolId: '  ' } } }, 'unknown', 'external_action', 'external_action', null],
  ['provider name before toolId', { toolCall: { title: 'x' }, meta: { toolName: 'fs_read', kiro: { toolId: 'run_command' } } }, 'read', 'read', 'external_action', 'fs_read'],
  // A tool of Michi's MCP server, as kiro-cli 3.1.0 asks for it (v2wire/v3wire, recorded 2026-11-07):
  // its identity names server and tool. The chat name is Kiro's for a Michi tool.
  ['v3 Michi tool request', v3Mcp('michi', 'set_branch_overview'),
    'set_branch_overview', 'external_action', 'external_action', '@michi/set_branch_overview'],
  ['v2 Michi tool request', v2Mcp('michi', 'set_branch_overview'), 'set_branch_overview', 'external_action', 'external_action', '@michi/set_branch_overview'],
  ['v3 Michi tool request, prose title', { toolCall: { title: 'Saving a note' }, meta: v3Mcp('michi', 'memory_save').meta },
    'memory_save', 'external_action', 'external_action', '@michi/memory_save'],
  // Another server's tool is no Michi tool, whatever its title; it still gets no chat name.
  ['v3 other server\'s tool', v3Mcp('github', 'create_issue'), 'mcp_github_create_issue', 'external_action', 'external_action', null],
  ['v3 other server titled @michi/read_node', { toolCall: { title: '@michi/read_node' }, meta: v3Mcp('slack', 'read_node').meta },
    'mcp_slack_read_node', 'external_action', 'external_action', null],
  ['v2 other server titled @michi/read_node', { toolCall: { title: '@michi/read_node' }, meta: v2Mcp('slack', 'read_node').meta },
    'unknown', 'external_action', 'external_action', null],
  // Without that identity: an exact @michi/<tool> title, unless kiro-cli names the call something else.
  ['title @michi/set_branch_overview', title('@michi/set_branch_overview'), 'set_branch_overview', 'external_action', 'external_action', '@michi/set_branch_overview'],
  ['v3 tool id of the titled Michi tool', { toolCall: { title: '@michi/search_messages' }, meta: { kiro: { toolId: 'mcp_michi_search_messages' } } },
    'search_messages', 'search', 'external_action', '@michi/search_messages'],
  ['title @michi/ with prose', title('@michi/set branch overview'), 'unknown', 'external_action', 'external_action', null],
  ['v2 title Running: @michi/<tool>', title('Running: @michi/memory_save'), 'unknown', 'external_action', 'external_action', null],
  // v3 titles a shell request with its command, which can be a Michi tool's name.
  ['v3 run_command titled @michi/memory_save', v3Shell('@michi/memory_save'), 'bash', 'shell_exec', 'external_action', null],
  ['v3 fs_write titled @michi/send_to_thread', { toolCall: { title: '@michi/send_to_thread' }, meta: { kiro: { toolId: 'fs_write' } } },
    'write', 'filesystem_write', 'external_action', null],
  ['v3 other tool id titled @michi/read_node', { toolCall: { title: '@michi/read_node' }, meta: { kiro: { toolId: 'mcp_michi_x_read_node' } } },
    'mcp_michi_x_read_node', 'external_action', 'external_action', null],
];

test('Kiro sends the broker canonical built-in names; chat grant keys are unchanged', async () => {
  for (const [label, request, brokerName, category, categoryBefore, grantKey] of KIRO_REQUESTS) {
    assert.equal(kiroBrokerToolName(request.toolCall, request.meta), brokerName, `${label}: broker name`);
    assert.equal(await brokerCategory(brokerName), category, `${label}: category`);
    assert.equal(await brokerCategory(beforeKiroBrokerName(request.toolCall, request.meta)), categoryBefore, `${label}: category before`);
    const chatName = acpPermissionToolName(request.toolCall, request.meta);
    assert.equal(chatName === undefined ? null : michiGrantKey(chatName), grantKey, `${label}: grant key`);
  }
});

test('Kiro names every tool of Michi\'s own MCP server for the chat policy; the broker names an exact Michi title the same way, as an external action (W4 failure 2)', async () => {
  // [label, request, calledAs, chat name]
  const rows: Array<[string, { toolCall: unknown; meta?: unknown }, string | undefined, string | undefined]> = [
    ['title @michi/companion_item', title('@michi/companion_item'), undefined, '@michi/companion_item'],
    ['title @michi/companion_session_send', title('@michi/companion_session_send'), undefined, '@michi/companion_session_send'],
    ['title @michi/companion_set_name', title('@michi/companion_set_name'), undefined, '@michi/companion_set_name'],
    ['title @michi/start_conversation', title('@michi/start_conversation'), undefined, '@michi/start_conversation'],
    ['v3 tool id michi::companion_item', { toolCall: { title: 'Reading an item' }, meta: { kiro: { toolId: 'michi::companion_item' } } }, undefined, '@michi/companion_item'],
    ['v3 tool id @michi/companion_read', { toolCall: { title: 'x' }, meta: { kiro: { toolId: '@michi/companion_read' } } }, undefined, '@michi/companion_read'],
    ['toolCall v3 tool id', { toolCall: { title: 'x', _meta: { kiro: { toolId: 'michi::read_page' } } } }, undefined, '@michi/read_page'],
    ['v2 update name', { toolCall: { toolCallId: 't', title: 'Using a tool' } }, '@michi/companion_items', '@michi/companion_items'],
    // Not Michi's: another server, a prose title, a built-in update name, a name with spaces.
    ['title @github/create_issue', title('@github/create_issue'), undefined, undefined],
    ['v3 tool id jira::get_issue', { toolCall: { title: 'x' }, meta: { kiro: { toolId: 'jira::get_issue' } } }, undefined, undefined],
    ['prose title', title('Calling @michi/companion_item now'), undefined, undefined],
    ['v2 shell update', { toolCall: { toolCallId: 't', title: 'Running: echo hi' } }, 'shell', undefined],
    ['spaced name', title('@michi/companion item'), undefined, undefined],
  ];
  for (const [label, request, calledAs, chatName] of rows) {
    assert.equal(acpPermissionToolName(request.toolCall, request.meta, undefined, calledAs), chatName, label);
  }
  // The Agent Run broker names an exact @michi/<tool> title by the tool's own name, as Claude's adapter does
  // (KIRO_REQUESTS above); these two have no broker category of their own, so they stay external actions.
  for (const [name, bare] of [['@michi/companion_item', 'companion_item'], ['@michi/send_to_thread', 'send_to_thread']]) {
    assert.equal(kiroBrokerToolName(title(name).toolCall), bare, name);
    assert.equal(await brokerCategory(bare), 'external_action', name);
  }
});

test('canonicalKiroToolName maps only Kiro built-ins and PascalCase built-in names', () => {
  const mapped: Record<string, string> = { fs_read: 'read', fs_write: 'write', execute_bash: 'bash', run_command: 'bash',
    shell: 'bash', Read: 'read', Bash: 'bash', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write' };
  for (const [name, canonical] of Object.entries(mapped)) assert.equal(canonicalKiroToolName(name), canonical, name);
  for (const name of ['use_aws', 'read', 'write', 'aws', 'unknown', 'constructor', '@github/create_issue']) {
    assert.equal(canonicalKiroToolName(name), name, name);
  }
});

// kiro-cli 2.34.0 v2 names a tool only in the tool_call update before its
// request (_meta.kiro.toolName). [label, request, name from that update, broker name, category]
const v2Request = (text: string) => ({ toolCall: { toolCallId: 't', title: text, rawInput: { command: 'echo hi' } } });
const KIRO_CALLED_AS: Array<[string, { toolCall: unknown; meta?: unknown }, string | undefined, string, string]> = [
  ['v2 shell', v2Request('Running: echo hi'), 'shell', 'bash', 'shell_exec'],
  ['v2 write', v2Request('Creating probe.txt'), 'write', 'write', 'filesystem_write'],
  ['v2 read', v2Request('Reading probe.txt'), 'read', 'read', 'read'],
  // The update's name outranks a built-in title.
  ['v2 shell titled write', v2Request('write'), 'shell', 'bash', 'shell_exec'],
  ['v2 shell titled Read', v2Request('Read'), 'shell', 'bash', 'shell_exec'],
  // Any other name falls back as before: a built-in title, else unknown.
  ['v2 aws', v2Request('Calling AWS'), 'aws', 'unknown', 'external_action'],
  ['v2 web_fetch titled Read', v2Request('Read'), 'web_fetch', 'read', 'read'],
  ['no tool_call update', v2Request('Running: echo hi'), undefined, 'unknown', 'external_action'],
  // Provider metadata and v3's tool id still come first.
  ['v3 tool id', { toolCall: { title: 'x' }, meta: { kiro: { toolId: 'fs_write' } } }, 'shell', 'write', 'filesystem_write'],
  ['provider name', { toolCall: { title: 'x' }, meta: { toolName: 'fs_read' } }, 'shell', 'read', 'read'],
  // A shell call titled like a Michi tool is the shell.
  ['v2 shell titled @michi/memory_save', v2Request('@michi/memory_save'), 'shell', 'bash', 'shell_exec'],
];

test('Kiro gives the broker the built-in name of a request\'s tool_call update; chat names read it only for Michi\'s tools', async () => {
  for (const [label, request, calledAs, brokerName, category] of KIRO_CALLED_AS) {
    assert.equal(kiroBrokerToolName(request.toolCall, request.meta, calledAs), brokerName, `${label}: broker name`);
    assert.equal(await brokerCategory(brokerName), category, `${label}: category`);
  }
  // v2 built-in chat requests still offer no grant, with or without the update's name.
  assert.equal(acpPermissionToolName(v2Request('Running: echo hi').toolCall), undefined);
  assert.equal(acpPermissionToolName(v2Request('Running: echo hi').toolCall, undefined, undefined, 'shell'), undefined);
  // The update's name tells a Michi tool's title from a shell call titled like one, and can name the tool itself.
  assert.equal(acpPermissionToolName(v2Request('@michi/memory_save').toolCall), '@michi/memory_save');
  assert.equal(acpPermissionToolName(v2Request('@michi/memory_save').toolCall, undefined, undefined, 'shell'), undefined);
  assert.equal(acpPermissionToolName(v2Request('@michi/memory_save').toolCall, undefined, undefined, '@michi/memory_save'), '@michi/memory_save');
  assert.equal(acpPermissionToolName(v2Request('@michi/memory_save').toolCall, undefined, undefined, 'memory_save'), '@michi/memory_save');
  assert.equal(acpPermissionToolName(v2Request('Saving a memory').toolCall, undefined, undefined, '@michi/memory_save'), '@michi/memory_save');
});

test('KiroToolCallNames keeps a turn\'s named calls and drops the least recently named when full', () => {
  const names = new KiroToolCallNames(2);
  const update = (toolCallId: unknown, toolName?: unknown) => ({ toolCallId, _meta: { kiro: { toolName } } });
  names.remember(update('a', 'shell'));
  names.remember({ toolCallId: 'a', status: 'completed' });
  names.remember(update('a', '  '));
  assert.equal(names.get('a'), 'shell', 'an update without a name keeps the earlier one');
  names.remember(update('b', ' write '));
  assert.equal(names.get('b'), 'write');
  names.remember(update('a', 'read'));
  names.remember(update('c', 'shell'));
  assert.deepEqual([names.get('a'), names.get('b'), names.get('c')], ['read', undefined, 'shell'], 'the least recently named call goes');
  for (const bad of [update('', 'shell'), update(7, 'shell'), update('d', 7), null, undefined]) names.remember(bad);
  assert.deepEqual([names.get(''), names.get(7), names.get('d'), names.get(undefined)], [undefined, undefined, undefined, undefined]);
});
