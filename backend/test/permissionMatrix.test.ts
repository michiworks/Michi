/**
 * Characterization of chat and Agent Run permission decisions per runtime.
 *
 * Each cell drives a real session (Kiro, Crew, Codex, Claude, Pi) through its
 * own native permission entry point, with only the transport stubbed:
 *
 *   {chat, run} x {ask, trust, yolo} x tool x runtime
 *
 * Chat cells record whether the first request was decided without a prompt,
 * the options offered, the grant keys an "allow always" answer writes and
 * whether the same request then passes without a prompt. Run cells record the
 * name the Run permission broker received, the category and decision of the
 * default broker (RuntimeRunExecutor's), what the session did, and, when the
 * broker asked, the result of answering allow_always and allow_once.
 *
 * The sessions run under RUN_CATEGORIES, a policy chosen so every category
 * shows a distinct decision. `broker.production` is the decision the same
 * broker gives under the policy production Runs start from: the default
 * platform policy intersected with itself as the workspace policy.
 *
 * The reviewed snapshot is fixtures/permissionMatrix.json. Regenerate it with
 * MICHI_UPDATE_PERMISSION_MATRIX=1 and review every changed cell.
 */
import './isolatedConfigDir';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import {
  AgentPolicyCategory, AgentPolicyDecision, type ChatPermissionMode, type PermissionOption,
} from 'michi-shared';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import { DEFAULT_PLATFORM_POLICY, intersectPermissionPolicies } from '../src/agents/runs/effectivePermissionPolicy';
import type { AgentRunSpec } from '../src/agents/runs/ports';
import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import type { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import type { AcpAgentFlavor } from 'michi-runtime/internal/adapters/kiro/acpAgentFlavor';
import { CREW_KIRO_FLAVOR } from 'michi-runtime/internal/adapters/crew/crewFlavor';
import { CodexRuntime } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import type { CodexSession } from 'michi-runtime/internal/adapters/codex/CodexSession';
import { CODEX_SERVER_REQUESTS } from 'michi-runtime/internal/adapters/codex/codexProtocol';
import type { CodexAppServerClient } from 'michi-runtime/internal/adapters/codex/CodexAppServerClient';
import type { McpSlot } from '../src/services/mcpServer';
import { ClaudeSession } from 'michi-runtime/internal/adapters/claude/ClaudeSession';
import type { ClaudeSdkTransport, ClaudeSdkTransportOptions } from 'michi-runtime/internal/adapters/claude/claudeSdkTransport';
import { BackgroundSubagentRegistry } from '../src/services/backgroundSubagentRegistry';
import { subagentSink } from './helpers/hostSinks';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import type {
  AgentSession, RuntimePermissionBroker, RuntimePermissionDecision, RuntimeSessionOwner,
} from '../src/agents/types';
import { michiTestHost } from './helpers/michiTestHost';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { chatOwner, isRunOwner, runOwner } from './helpers/owners';
import { codexTestOptions } from './helpers/codexTestOptions';

const FIXTURE = path.join(__dirname, 'fixtures', 'permissionMatrix.json');
const MODES: ChatPermissionMode[] = ['ask', 'trust', 'yolo'];
const CONTEXTS = ['chat', 'run'] as const;
type Context = typeof CONTEXTS[number];

// ---- Host state ---------------------------------------------------------------

let mode: ChatPermissionMode = 'ask';
const grants = new Set<string>();
/** Grant writes of the current cell: `<tool key>@<owner user or ->`. */
const granted: string[] = [];

function configureHost() {
  configureRuntimeDeps({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'michi-permission-matrix-')),
    historyStore: {
      getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null,
    },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'pi', provider: 'deepseek', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => 'test-model', resolveReasoning: () => undefined,
    },
    providerKeys: { getProviderApiKey: () => 'test-key' },
    chatPermissions: {
      getMode: () => mode,
      hasGrant: (nodeId, tool, userId) => grants.has(`${nodeId}\u0000${tool}\u0000${userId ?? ''}`),
      grant: (nodeId, tool, userId) => {
        grants.add(`${nodeId}\u0000${tool}\u0000${userId ?? ''}`);
        granted.push(`${tool}@${userId ?? '-'}`);
      },
      resetToken: () => '0',
    },
  });
}

// ---- Run broker -----------------------------------------------------------------

const RUN_CATEGORIES: Partial<Record<AgentPolicyCategory, AgentPolicyDecision>> = {
  [AgentPolicyCategory.Read]: AgentPolicyDecision.Allow,
  [AgentPolicyCategory.Search]: AgentPolicyDecision.Allow,
  [AgentPolicyCategory.Browse]: AgentPolicyDecision.Allow,
  [AgentPolicyCategory.ArtifactWrite]: AgentPolicyDecision.Allow,
  [AgentPolicyCategory.FilesystemWrite]: AgentPolicyDecision.Ask,
  [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Ask,
  [AgentPolicyCategory.SpawnAgent]: AgentPolicyDecision.Deny,
  // ExternalAction is absent: the default broker denies it.
};

function specWith(categories: Partial<Record<AgentPolicyCategory, AgentPolicyDecision>>): AgentRunSpec {
  return { effectiveDefinition: { permissionPolicy: { categories } } } as unknown as AgentRunSpec;
}

/** RuntimeRunExecutor's default broker, the one production Runs use. */
function defaultBroker(categories: Partial<Record<AgentPolicyCategory, AgentPolicyDecision>>): RuntimePermissionBroker {
  const executor = new RuntimeRunExecutor() as unknown as {
    createPermissionBroker(input: { spec: AgentRunSpec }): RuntimePermissionBroker;
  };
  return executor.createPermissionBroker({ spec: specWith(categories) });
}

const runBroker = defaultBroker(RUN_CATEGORIES);
const productionBroker = defaultBroker(
  intersectPermissionPolicies({ platform: DEFAULT_PLATFORM_POLICY, workspace: DEFAULT_PLATFORM_POLICY }).categories);
const categoryProbes = Object.values(AgentPolicyCategory).map((category) =>
  [category, defaultBroker({ [category]: AgentPolicyDecision.Allow })] as const);

interface BrokerCall { toolName: string; category: string; decision: RuntimePermissionDecision; production: RuntimePermissionDecision }
const brokerCalls: BrokerCall[] = [];

const recordingBroker: RuntimePermissionBroker = {
  async requestPermission(request) {
    const decision = await runBroker.requestPermission(request);
    const matches: string[] = [];
    for (const [category, probe] of categoryProbes) {
      if (await probe.requestPermission(request) === 'allow_once') matches.push(category);
    }
    // Every category allows it: the broker short-circuits before classifying.
    const category = matches.length === categoryProbes.length ? '(always allowed)' : matches.join('+') || '(none)';
    brokerCalls.push({ toolName: request.toolName, category, decision, production: await productionBroker.requestPermission(request) });
    return decision;
  },
};

// ---- Drivers ----------------------------------------------------------------------

interface Prompt { requestId: number; options: PermissionOption[] }
interface Attempt { settled?: string; prompt?: Prompt; done: Promise<string> }
interface Driver {
  request(tool: string): Promise<Attempt>;
  answer(requestId: number, optionId: string): void;
  close(): Promise<void>;
}
interface DriverInput { owner: RuntimeSessionOwner; context: Context; id: string }

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Settles with whichever comes first: the native answer or a prompt. */
async function attempt(answer: Promise<string>, prompted: () => Prompt | undefined, what: string): Promise<Attempt> {
  let settled: string | undefined;
  void answer.then((value) => { settled = value; });
  await until(() => settled !== undefined || prompted() !== undefined, what);
  return settled !== undefined ? { settled, done: answer } : { prompt: prompted(), done: answer };
}

class Channel<T> {
  private items: T[] = [];
  private waiters: Array<(value: T | undefined) => void> = [];
  private ended = false;
  push(item: T) { const waiter = this.waiters.shift(); if (waiter) waiter(item); else this.items.push(item); }
  end() { this.ended = true; for (const waiter of this.waiters.splice(0)) waiter(undefined); }
  take(): Promise<T | undefined> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift());
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function drainPrompts(session: AgentSession, text: string, prompts: Map<number, Prompt>): Promise<void> {
  return (async () => {
    for await (const event of session.send(text)) {
      if (event.kind === 'permission_request') prompts.set(event.requestId, { requestId: event.requestId, options: event.options });
    }
  })();
}

// Kiro: AcpAgentSession over a stub ACP client. A tool is given as an ACP
// request_permission: `title:<t>`, `meta:<name>` (params._meta.toolName),
// `toolCallMeta:<name>` (toolCall._meta.toolName). Prose titles carry no name.
// `v2wire:` and `v3wire:` rows are the request shapes kiro-cli 2.34.0 sends
// (recorded with kiroPermissionRequest.live.test.ts), ids and paths replaced;
// a v2 request follows the tool_call update that names its tool. The
// `wire:@michi/` rows are kiro-cli 3.1.0's requests for a tool of Michi's MCP
// server (recorded 2026-11-07 against a stub server). `v2:` and `v3:` rows
// follow those shapes for calls the recordings did not make.
const KIRO_TOOLS = [
  'meta:read', 'meta:edit', 'meta:write', 'meta:bash',
  'title:Read', 'title:Edit', 'title:Write', 'title:Bash',
  'title:fs_read', 'title:fs_write', 'title:execute_bash', 'title:use_aws',
  'meta:execute_bash', 'toolCallMeta:fs_write',
  'meta:@github/create_issue', 'title:@michi/send_to_thread',
  'title:@michi/list_ready_models', 'title:@michi/propose_multi_model_plan',
  'title:@michi/set_branch_overview', 'title:@michi/set_follow_ups',
  // Michi's own tools: turn metadata and reads run without a prompt, a page edit asks.
  'v3wire:@michi/set_branch_overview', 'v2wire:@michi/set_branch_overview',
  'title:@michi/search_messages', 'title:@michi/edit_page', 'v3:@github/create_issue',
  // Michi's delete_artifact asks through its own card; another server's tool of that name asks as any tool.
  'title:@michi/delete_artifact', 'meta:@github/delete_artifact', 'meta:delete_artifact',
  'meta:frobnicate', 'title:Running: rm -rf build',
  'v2wire:shell', 'v2wire:write', 'v3wire:run_command', 'v3wire:fs_write',
  // v3 shell requests are titled with the command itself, which can be a built-in name.
  'v3wire:run_command=write', 'v3wire:run_command=fs_write', 'v3wire:run_command=Read',
  // ...or a Michi tool's: kiro-cli names the call a shell call, so it is one.
  'v3wire:run_command=@michi/memory_save', 'v2:shell=@michi/memory_save',
];
const KIRO_NATIVE_OPTIONS = [
  { optionId: 'native-once', kind: 'allow_once', name: 'Yes' },
  { optionId: 'native-always', kind: 'allow_always', name: 'Always' },
  { optionId: 'native-reject', kind: 'reject_once', name: 'No' },
];
const KIRO_V2_OPTIONS = [
  { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
];
const KIRO_V3_OPTIONS = [
  { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always-accept', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  { optionId: 'always-reject', name: 'Always deny', kind: 'reject_always' },
];
function v3ShellRequest(command: string): Record<string, unknown> {
  return {
    toolCall: { toolCallId: 'run_command_toolu', status: 'pending', title: command },
    options: KIRO_V3_OPTIONS,
    _meta: { kiro: { toolId: 'run_command', command, consentRound: 1, consent: {
      capability: 'shell', resource: command, askType: 'implicit', triggeringResource: command, workspaceRoot: '/tmp' } } },
  };
}
/** The tool_call update kiro-cli 2.34.0 v2 sends before a request (KIRO_WIRE row), as recorded. */
const KIRO_V2_TOOL_CALLS: Record<string, Record<string, unknown>> = {
  'v2wire:shell': { sessionUpdate: 'tool_call', toolCallId: 'toolu_shell', title: 'Running: echo hi', kind: 'execute',
    rawInput: { command: 'echo hi', __tool_use_purpose: 'Print' }, _meta: { kiro: { toolName: 'shell' } } },
  'v2wire:write': { sessionUpdate: 'tool_call', toolCallId: 'toolu_write', title: 'Creating probe.txt', kind: 'edit',
    content: [{ type: 'diff', path: '/tmp/probe.txt', oldText: null, newText: 'hi' }], locations: [{ path: 'probe.txt', line: 1 }],
    rawInput: { __tool_use_purpose: 'Create', command: 'create', path: 'probe.txt', content: 'hi' }, _meta: { kiro: { toolName: 'write' } } },
  'v2:shell=@michi/memory_save': { sessionUpdate: 'tool_call', toolCallId: 'toolu_shell_titled', title: '@michi/memory_save', kind: 'execute',
    rawInput: { command: 'echo hi' }, _meta: { kiro: { toolName: 'shell' } } },
  'v2wire:@michi/set_branch_overview': { sessionUpdate: 'tool_call', toolCallId: 'toolu_michi_v2', title: 'Running: @michi/set_branch_overview',
    rawInput: { overview: 'probe' }, _meta: { kiro: { toolName: 'set_branch_overview', mcpServerName: 'michi' } } },
};
const MCP_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
function v3McpRequest(server: string, tool: string): Record<string, unknown> {
  return {
    toolCall: { toolCallId: `toolu_${server}_v3`, status: 'pending', title: `@${server}/${tool}` },
    options: KIRO_V3_OPTIONS,
    _meta: { kiro: { toolId: `mcp_${server}_${tool}`, agentManagesTrust: true,
      consent: { capability: 'mcp', resource: `${server}/${tool}`, askType: 'implicit', workspaceRoot: '/tmp' }, consentRound: 1,
      mcpTool: { version: 1, identity: { serverName: server, toolName: tool }, annotations: MCP_ANNOTATIONS } } },
  };
}
const KIRO_WIRE: Record<string, Record<string, unknown>> = {
  'v2wire:shell': {
    toolCall: { toolCallId: 'toolu_shell', title: 'Running: echo hi', rawInput: { command: 'echo hi', __tool_use_purpose: 'Print' } },
    options: KIRO_V2_OPTIONS,
    _meta: { trustOptions: [{ label: 'Full command', display: 'echo hi', setting_key: 'allowedCommands', patterns: ['echo hi'] }] },
  },
  'v2wire:write': {
    toolCall: { toolCallId: 'toolu_write', title: 'Creating probe.txt',
      rawInput: { __tool_use_purpose: 'Create', command: 'create', path: 'probe.txt', content: 'hi' } },
    options: KIRO_V2_OPTIONS,
    _meta: { trustOptions: [{ label: 'Specific paths', display: 'probe.txt', setting_key: 'runtime_write_paths', patterns: ['/tmp/probe.txt'] }] },
  },
  'v3wire:run_command': v3ShellRequest('echo hi'),
  'v3wire:run_command=write': v3ShellRequest('write'),
  'v3wire:run_command=fs_write': v3ShellRequest('fs_write'),
  'v3wire:run_command=Read': v3ShellRequest('Read'),
  'v3wire:run_command=@michi/memory_save': v3ShellRequest('@michi/memory_save'),
  'v3wire:fs_write': {
    toolCall: { toolCallId: 'toolu_fs_write', status: 'pending', title: 'Write File' },
    options: KIRO_V3_OPTIONS,
    _meta: { kiro: { toolId: 'fs_write', consentRound: 1, consent: {
      capability: 'fs_write', resource: 'probe.txt', askType: 'implicit', workspaceRoot: '/tmp' } } },
  },
  'v3wire:@michi/set_branch_overview': v3McpRequest('michi', 'set_branch_overview'),
  'v2wire:@michi/set_branch_overview': {
    toolCall: { toolCallId: 'toolu_michi_v2', title: 'Running: @michi/set_branch_overview', rawInput: { overview: 'probe' } },
    options: KIRO_V2_OPTIONS,
    _meta: { mcpToolIdentity: { serverName: 'michi', toolName: 'set_branch_overview' }, mcpAnnotations: MCP_ANNOTATIONS },
  },
  'v3:@github/create_issue': v3McpRequest('github', 'create_issue'),
  'v2:shell=@michi/memory_save': {
    toolCall: { toolCallId: 'toolu_shell_titled', title: '@michi/memory_save', rawInput: { command: 'echo hi' } },
    options: KIRO_V2_OPTIONS,
    _meta: { trustOptions: [{ label: 'Full command', display: 'echo hi', setting_key: 'allowedCommands', patterns: ['echo hi'] }] },
  },
};

function kiroRequest(tool: string): Record<string, unknown> {
  if (KIRO_WIRE[tool]) return KIRO_WIRE[tool];
  const [kind, ...rest] = tool.split(':');
  const name = rest.join(':');
  if (kind === 'title') return { toolCall: { toolCallId: `tc-${name}`, title: name } };
  if (kind === 'meta') return { toolCall: { toolCallId: `tc-${name}`, title: 'Using a tool' }, _meta: { toolName: name } };
  return { toolCall: { toolCallId: `tc-${name}`, title: 'Using a tool', _meta: { toolName: name } } };
}

// Crew: the same AcpAgentSession under Crew's flavor, given requests the way
// its ACP adapter forwards a Gateway approval (acp/acpServer.ts): the stable
// tool name in _meta, the Gateway's title, and its tool input as the raw input.
// `relay:<tool>` calls a Michi tool through Michi's relay (michi_call_tool).
const CREW_TOOLS = [
  'relay:read_node', 'relay:set_branch_overview', 'relay:edit_page', 'relay-list',
  'relay-cut-off:read_node', 'relay-other-server:read_node', 'shell',
];
const CREW_OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
];
function crewApproval(toolName: string, title: string, input: string): Record<string, unknown> {
  return {
    toolCall: { toolCallId: `crew-${toolName}`, title, rawInput: input, content: [{ type: 'content', content: { type: 'text', text: input } }] },
    options: CREW_OPTIONS, _meta: { toolName },
  };
}
function crewRequest(tool: string): Record<string, unknown> {
  const [kind, name] = tool.split(':');
  const call = JSON.stringify({ tool: name, arguments: {} });
  if (kind === 'relay') return crewApproval('michi_call_tool', '@michi-crew-runtime:michi/michi_call_tool', call);
  if (kind === 'relay-list') return crewApproval('michi_list_tools', '@michi-crew-runtime:michi/michi_list_tools', '{}');
  if (kind === 'relay-cut-off') return crewApproval('michi_call_tool', '@michi-crew-runtime:michi/michi_call_tool', call.slice(0, -4));
  if (kind === 'relay-other-server') return crewApproval('michi_call_tool', '@michi-crew-runtime:github/michi_call_tool', call);
  return crewApproval(tool, 'Running: echo hi', 'echo hi');
}

const kiroDriver = (input: DriverInput) => acpDriver(input, kiroRequest);
const crewDriver = (input: DriverInput) => acpDriver(input, crewRequest, CREW_KIRO_FLAVOR);

async function acpDriver({ owner, id }: DriverInput, requestFor: (tool: string) => Record<string, unknown>, flavor?: AcpAgentFlavor): Promise<Driver> {
  const updates = new Channel<Record<string, unknown>>();
  const answers = new Map<number, string>();
  const client = {
    prompt: async function* () { for (;;) { const update = await updates.take(); if (!update) return; yield update; } },
    respondToPermissionKind: (requestId: number, kind: string) => { answers.set(requestId, `kind:${kind}`); },
  };
  const runtime = {
    host: michiTestHost(),
    ensureClient: async () => client, getClient: () => client,
    getCurrentMode: () => undefined, getCurrentModel: () => undefined,
    respondToPermission: (_sid: string, requestId: number, optionId: string) => { answers.set(requestId, `select:${optionId}`); },
    cancelPermission: (_sid: string, requestId: number) => { answers.set(requestId, 'cancel'); },
  } as unknown as AcpAgentRuntime;
  const session = new AcpAgentSession(id, `native-${id}`, runtime, '/tmp', {
    owner, ownerUserId: 'alice', workspaceId: 'ws', ...(isRunOwner(owner) ? { permissionBroker: recordingBroker } : {}),
    ...(flavor ? { flavor } : {}),
  });
  const prompts = new Map<number, Prompt>();
  const turn = drainPrompts(session, 'go', prompts);
  let nextId = 0;
  return {
    async request(tool) {
      const requestId = ++nextId;
      if (KIRO_V2_TOOL_CALLS[tool]) updates.push(KIRO_V2_TOOL_CALLS[tool]);
      updates.push({ sessionUpdate: 'permission_request', requestId, options: KIRO_NATIVE_OPTIONS, ...requestFor(tool) });
      const answered = (async () => { await until(() => answers.has(requestId), `Kiro answer ${requestId}`); return answers.get(requestId)!; })();
      return attempt(answered, () => prompts.get(requestId), `Kiro request ${tool}`);
    },
    answer: (requestId, optionId) => session.respondToPermission(requestId, optionId),
    async close() {
      updates.push({ sessionUpdate: 'turn_end', stopReason: 'end_turn' });
      updates.end();
      await turn;
    },
  };
}

// Codex: CodexRuntime and CodexSession over a stub app-server client. A tool
// is the approval method; the dispatcher routes only command and file approvals.
const CODEX_TOOLS = [
  CODEX_SERVER_REQUESTS.commandApproval,
  CODEX_SERVER_REQUESTS.fileChangeApproval,
  CODEX_SERVER_REQUESTS.permissionsApproval,
  'item/unknownTool/requestApproval',
];

type ServerRequestHandler = (method: string, params: Record<string, unknown>, respond: (result: unknown) => void,
  context: { signal?: AbortSignal; reject(code: number, message: string): void }) => void;

function codexClient(threadId: string) {
  let handler: ServerRequestHandler | null = null;
  const listeners = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  const client = {
    ensureStarted: async () => {},
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/start') return { threadId: params.ephemeral ? `${threadId}-title` : threadId };
      if (method === 'model/list') return { data: [] };
      if (method === 'turn/start' && params.threadId !== threadId) {
        // The pre-turn title thread completes at once.
        const titleThread = String(params.threadId);
        queueMicrotask(() => client.emit(titleThread, 'turn/completed', { threadId: titleThread, turn: { id: 'title-turn', status: 'completed' } }));
        return { turn: { id: 'title-turn' } };
      }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      return {};
    },
    onNotification: (id: string, listener: (method: string, params: Record<string, unknown>) => void) => {
      const set = listeners.get(id) ?? new Set();
      listeners.set(id, set);
      set.add(listener);
      return () => { set.delete(listener); };
    },
    onGlobalNotification: () => () => {},
    onServerRequest: (next: ServerRequestHandler) => { handler = next; },
    onExit: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    emit(id: string, method: string, params: Record<string, unknown>) {
      for (const listener of listeners.get(id) ?? []) listener(method, params);
    },
    fire(method: string, params: Record<string, unknown>): Promise<unknown> {
      return new Promise((resolve) => handler!(method, params, resolve, {
        reject: (code, message) => resolve({ error: { code, message } }),
      }));
    },
  };
  return client;
}

function codexOutcome(result: unknown): string {
  const value = result as { decision?: string; error?: { code: number }; permissions?: unknown };
  if (value.decision) return value.decision;
  if (value.error) return `error:${value.error.code}`;
  return `permissions:${JSON.stringify(value.permissions)}`;
}

async function codexDriver({ owner, id }: DriverInput): Promise<Driver> {
  const threadId = `thread-${id}`;
  const client = codexClient(threadId);
  const registry = fakeMcpRegistry({ create: () => ({ slotId: `slot-${id}` }) as McpSlot, get: () => undefined }, { mcpPort: 3001 });
  const runtime = new CodexRuntime({ ...codexTestOptions(), bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null }, mcpSlots: registry }, { client: client as unknown as CodexAppServerClient });
  const session = await runtime.newSession({
    sessionId: id, cwd: '/tmp', model: 'test-model', ownerUserId: 'alice', workspaceId: 'ws',
    ...(isRunOwner(owner) ? { owner, permissionBroker: recordingBroker } : {}),
  }) as CodexSession;
  const prompts = new Map<number, Prompt>();
  const turn = drainPrompts(session, 'go', prompts);
  await tick();
  assert.ok(session.acceptsControl({ threadId, turnId: 'turn-1' }), 'Codex approvals need a live native turn');
  return {
    async request(method) {
      const before = new Set(prompts.keys());
      const answered = client.fire(method, { threadId, turnId: 'turn-1', command: 'echo matrix' }).then(codexOutcome);
      return attempt(answered, () => [...prompts.values()].find((prompt) => !before.has(prompt.requestId)), `Codex request ${method}`);
    },
    answer: (requestId, optionId) => session.respondToPermission(requestId, optionId),
    async close() {
      client.emit(threadId, 'turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } });
      await turn;
      await runtime.shutdown();
    },
  };
}

// Claude: ClaudeSession over a stub SDK transport. A tool is the SDK tool
// name. Chats answer through canUseTool (authorize); Runs through the
// PreToolUse hook, which consults the Run broker.
const CLAUDE_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write',
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'TaskOutput', 'TaskStop', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'ToolSearch',
  'mcp____michi_internal____read_node', 'mcp____michi_internal____search_messages', 'mcp____michi_internal____web_search',
  'mcp____michi_internal____save_artifact', 'mcp____michi_internal____spawn_agent', 'mcp____michi_internal____send_to_thread',
  'mcp____michi_internal____set_follow_ups', 'mcp____michi_internal____submit_agent_result',
  'mcp____michi_internal____set_branch_overview', 'mcp____michi_internal____list_panes', 'mcp____michi_internal____ask_user',
  'mcp____michi_internal____open_url',
  'mcp____michi_internal____list_ready_models', 'mcp____michi_internal____propose_multi_model_plan',
  'mcp____michi_internal____delete_artifact', 'mcp__github__delete_artifact',
  'mcp__github__create_issue', 'fs_read', 'execute_bash', 'frobnicate',
];

class FixtureChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill() { queueMicrotask(() => this.emit('exit', 0, null)); return true; }
}

function claudeOutcome(result: { behavior: string; message?: string } | undefined): string {
  if (!result) return 'native';
  return result.behavior === 'allow' ? 'allow' : `deny:${result.message}`;
}

async function claudeDriver({ owner, id }: DriverInput): Promise<Driver> {
  let transportOptions: ClaudeSdkTransportOptions | undefined;
  const transport = mock.method(require('michi-runtime/internal/adapters/claude/claudeSdkTransport'), 'createClaudeSdkTransport',
    async (options: ClaudeSdkTransportOptions): Promise<ClaudeSdkTransport> => {
      transportOptions = options;
      queueMicrotask(() => options.onMessage({ type: 'system', subtype: 'init', session_id: options.sessionId } as never));
      return {
        child: new FixtureChild() as never,
        query: { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {} } as unknown as Query,
        initialized: Promise.resolve({} as never), send: () => {}, close: () => {},
      };
    });
  const slots = new Map<string, unknown>();
  const session = new ClaudeSession(id, {
    options: claudeTestOptions(),
    nodeId: id, owner, cwd: '/tmp', workspaceId: 'ws', ownerUserId: 'alice', model: 'claude-sonnet-4-5',
    persistNativeIdentity: false,
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    mcpRegistry: {
      create: (_id: string, _cwd: string, _user: string, callbacks: object) => {
        const slot = { slotId: `slot-${id}`, ...callbacks };
        slots.set(slot.slotId, slot);
        return slot;
      },
      get: (slotId: string) => slots.get(slotId), dispose: async (slotId: string) => { slots.delete(slotId); },
      endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }),
    } as never,
    backgroundSubagents: subagentSink(new BackgroundSubagentRegistry({ resolveWorkspace: () => 'ws' })),
    ...(isRunOwner(owner) ? { permissionBroker: recordingBroker } : {}),
  });
  await session.spawnFresh();
  const prompts = new Map<number, Prompt>();
  const turn = drainPrompts(session, 'go', prompts);
  await tick();
  let toolUse = 0;
  return {
    async request(tool) {
      const before = new Set(prompts.keys());
      const signal = new AbortController().signal;
      const toolUseId = `tool-${++toolUse}`;
      const verdict = isRunOwner(owner)
        ? transportOptions!.preToolUse(tool, { command: 'echo matrix' }, toolUseId, signal)
        : transportOptions!.authorize(tool, { command: 'echo matrix' }, toolUseId, signal);
      const answered = Promise.resolve(verdict).then((result) => claudeOutcome(result as never));
      return attempt(answered, () => [...prompts.values()].find((prompt) => !before.has(prompt.requestId)), `Claude request ${tool}`);
    },
    answer: (requestId, optionId) => session.respondToPermission(requestId, optionId),
    async close() {
      transportOptions!.onMessage({ type: 'result', subtype: 'success' } as never);
      await turn;
      await session.dispose();
      transport.mock.restore();
    },
  };
}

// Pi: PiSession with a stub pi-agent-core Agent. A tool is the Pi tool name,
// checked by the Agent's beforeToolCall hook.
const PI_TOOLS = [
  'read', 'ls', 'grep', 'find', 'bash', 'edit', 'write', 'web_search', 'read_node', 'list_panes', 'save_artifact',
  'spawn_agent', 'send_to_thread', 'open_url', 'delete_artifact', 'mcp__github__delete_artifact',
  'mcp__github__create_issue', 'fs_read', 'frobnicate',
];

type BeforeToolCall = (context: { toolCall: { name: string }; args: unknown }) => Promise<{ block: boolean; reason?: string } | undefined>;

function patchModule(modulePath: string, key: string, value: unknown): () => void {
  const mod = require(modulePath) as Record<string, unknown>;
  const original = mod[key];
  mod[key] = value;
  return () => { mod[key] = original; };
}

async function piDriver({ owner, id }: DriverInput): Promise<Driver> {
  let beforeToolCall: BeforeToolCall | undefined;
  const restores = [
    patchModule(require.resolve('../src/agents/pi/piTools'), 'buildPiTools', () => []),
    patchModule(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => []),
    patchModule(require.resolve('../src/agents/pi/piAi'), 'loadPiAi', async () => ({
      Type: {}, clampThinkingLevel: (_model: unknown, level: string) => level,
      getModel: () => ({ contextWindow: 1000 }), streamSimple: () => { throw new Error('not used'); },
    })),
    patchModule(require.resolve('../src/agents/pi/piAi'), 'loadPiAgentCore', async () => ({
      Agent: class {
        state = { messages: [] };
        private subscriber: ((event: unknown) => void) | undefined;
        constructor(options: { beforeToolCall: BeforeToolCall }) { beforeToolCall = options.beforeToolCall; }
        subscribe(fn: (event: unknown) => void) { this.subscriber = fn; return () => { this.subscriber = undefined; }; }
        async prompt() { this.subscriber?.({ type: 'agent_end' }); }
      },
    })),
  ];
  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  const session = new PiSession(id, {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'ws', ownerUserId: 'alice',
    ...(isRunOwner(owner) ? { owner, permissionBroker: recordingBroker } : {}),
  });
  for await (const event of session.send('go')) { if (event.kind === 'turn_end') break; }
  assert.ok(beforeToolCall, 'Pi Agent was created');
  const hook = beforeToolCall;
  const prompts = new Map<number, Prompt>();
  (session as unknown as { activePush: (event: { kind: string; requestId: number; options: PermissionOption[] }) => void })
    .activePush = (event) => { if (event.kind === 'permission_request') prompts.set(event.requestId, event); };
  return {
    async request(tool) {
      const before = new Set(prompts.keys());
      const answered = hook({ toolCall: { name: tool }, args: {} })
        .then((result) => result ? `deny:${result.reason}` : 'allow');
      return attempt(answered, () => [...prompts.values()].find((prompt) => !before.has(prompt.requestId)), `Pi request ${tool}`);
    },
    answer: (requestId, optionId) => session.respondToPermission(requestId, optionId),
    async close() {
      await session.dispose?.();
      for (const restore of restores.reverse()) restore();
    },
  };
}

const RUNTIMES: Array<{ id: string; tools: string[]; driver: (input: DriverInput) => Promise<Driver> }> = [
  { id: 'kiro', tools: KIRO_TOOLS, driver: kiroDriver },
  { id: 'crew', tools: CREW_TOOLS, driver: crewDriver },
  { id: 'codex', tools: CODEX_TOOLS, driver: codexDriver },
  { id: 'claude', tools: CLAUDE_TOOLS, driver: claudeDriver },
  { id: 'pi', tools: PI_TOOLS, driver: piDriver },
];

// ---- Cells ------------------------------------------------------------------------

function optionKinds(options: PermissionOption[]): string {
  return options.map((option) => `${option.kind}${option.disabled ? '(disabled)' : ''}`).join(',');
}

async function decline(driver: Driver, attemptResult: Attempt): Promise<void> {
  if (!attemptResult.prompt) return;
  const reject = attemptResult.prompt.options.find((option) => option.kind === 'reject_once');
  driver.answer(attemptResult.prompt.requestId, reject?.optionId ?? 'reject_once');
  await attemptResult.done;
}

async function chatCell(driver: Driver, tool: string): Promise<Record<string, unknown>> {
  granted.length = 0;
  brokerCalls.length = 0;
  const first = await driver.request(tool);
  if (first.settled !== undefined) return { first: first.settled, grants: [...granted], broker: brokerCalls.length };
  const options = first.prompt!.options;
  const always = options.find((option) => option.kind === 'allow_always' && !option.disabled);
  const once = options.find((option) => option.kind === 'allow_once');
  const chosen = always ?? once!;
  driver.answer(first.prompt!.requestId, chosen.optionId);
  const answered = await first.done;
  const grantKeys = [...granted];
  const second = await driver.request(tool);
  const secondOutcome = second.settled ?? 'prompt';
  await decline(driver, second);
  grants.clear();
  return {
    first: 'prompt', options: optionKinds(options), answeredWith: chosen.kind, answered,
    grants: grantKeys, second: secondOutcome, broker: brokerCalls.length,
  };
}

async function runCell(driver: Driver, tool: string): Promise<Record<string, unknown>> {
  granted.length = 0;
  brokerCalls.length = 0;
  const first = await driver.request(tool);
  const broker = brokerCalls[0] ?? null;
  if (first.settled !== undefined) return { broker, outcome: first.settled, grants: [...granted] };
  const options = optionKinds(first.prompt!.options);
  // RuntimeRunExecutor maps the answer "allow_always" to this option id.
  driver.answer(first.prompt!.requestId, 'allow_always');
  const allowAlways = await first.done;
  const second = await driver.request(tool);
  let allowOnce = second.settled ?? 'prompt';
  if (second.prompt) {
    driver.answer(second.prompt.requestId, 'allow_once');
    allowOnce = await second.done;
  }
  return { broker, outcome: 'prompt', options, allowAlways, allowOnce, grants: [...granted] };
}

function serialize(cells: Record<string, unknown>): string {
  const lines = Object.entries(cells).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

test('chat and Run permission decisions per runtime match the reviewed matrix', { timeout: 120_000 }, async () => {
  configureHost();
  const cells: Record<string, unknown> = {};
  try {
    for (const runtime of RUNTIMES) {
      for (const context of CONTEXTS) {
        for (const nextMode of MODES) {
          mode = nextMode;
          const id = `${runtime.id}-${context}-${nextMode}`;
          const owner: RuntimeSessionOwner = context === 'chat'
            ? chatOwner(id)
            : runOwner(`run-${id}`, id);
          const driver = await runtime.driver({ owner, context, id });
          try {
            for (const tool of runtime.tools) {
              cells[`${runtime.id}|${context}|${nextMode}|${tool}`] = context === 'chat'
                ? await chatCell(driver, tool)
                : await runCell(driver, tool);
            }
          } finally {
            await driver.close();
          }
        }
      }
    }
  } finally {
    clearAllSessions();
    __resetRuntimeDeps();
  }

  if (process.env.MICHI_UPDATE_PERMISSION_MATRIX === '1') {
    fs.writeFileSync(FIXTURE, serialize(cells));
    return;
  }
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(cells), Object.keys(expected), 'the matrix has the same cells');
  for (const [key, value] of Object.entries(cells)) assert.deepEqual(value, expected[key], key);
});
