import { restrictedChatProfile } from './helpers/restrictedChatProfile';
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { chatOwner, runOwner } from './helpers/owners';
import { askUserThreadMessageApprover } from '../src/agents/threadMessageTool';
import { piAskUserChannel } from '../src/agents/pi/piAskUser';

type Restore = () => void;

const restores: Restore[] = [];
const originalMichiCloud = process.env.MICHI_CLOUD;

function patchModule<T extends Record<string, any>, K extends keyof T>(
  modulePath: string,
  key: K,
  value: T[K],
): void {
  const mod = require(modulePath) as T;
  const original = mod[key];
  mod[key] = value;
  restores.push(() => {
    mod[key] = original;
  });
}

afterEach(() => {
  while (restores.length > 0) {
    restores.pop()?.();
  }
  __resetRuntimeDeps();
  delete require.cache[require.resolve('../src/agents/pi/PiSession')];
  if (originalMichiCloud === undefined) delete process.env.MICHI_CLOUD;
  else process.env.MICHI_CLOUD = originalMichiCloud;
});

test('PiSession resolves model and reasoning against pi runtime, not the active runtime', async () => {
  delete process.env.MICHI_CLOUD;
  const piAiPath = require.resolve('../src/agents/pi/piAi');
  const piToolsPath = require.resolve('../src/agents/pi/piTools');

  let modelRuntime: string | undefined;
  let reasoningRuntime: string | undefined;
  let configOwnerUserId: string | undefined;
  let modelOwnerUserId: string | undefined;
  let reasoningOwnerUserId: string | undefined;
  let keyOwnerUserId: string | undefined;
  let brokerOwnerUserId: string | null | undefined;
  let modelId: string | undefined;
  let thinkingLevel: string | undefined;
  let afterToolCall: ((context: { result: unknown; isError: boolean }) => unknown) | undefined;
  let beforeToolCall: ((context: { toolCall: { name: string }; args: unknown }) => Promise<{ block: boolean; reason?: string } | undefined>) | undefined;
  let brokerDecision: 'ask' | 'deny' = 'ask';

  // Replaces the former agentConfig/secrets monkey-patches. Mirrors the exact
  // stub values the patches used to return, including the recording closures
  // that the assertions below depend on.
  configureRuntimeDeps({
    historyStore: {
      getNode: () => null,
      listMessages: () => [],
      getWorkspace: () => null,
      getWorkspaceInstructions: () => null,
    },
    providerKeys: {
      getProviderApiKey: (_provider: string, ownerUserId?: string) => {
        keyOwnerUserId = ownerUserId;
        return 'test-key';
      },
    },
    agentConfig: {
      getAgentConfig: (ownerUserId?: string) => {
        configOwnerUserId = ownerUserId;
        return {
          runtime: 'kiro',
          provider: 'deepseek',
          modelByRuntime: { kiro: 'kiro-only-model', pi: 'pi-good-model' },
          reasoningByRuntime: { kiro: 'xhigh', pi: 'low' },
        };
      },
      resolveModel: (runtimeId: string, ownerUserId?: string) => {
        modelRuntime = runtimeId;
        modelOwnerUserId = ownerUserId;
        return `${runtimeId}-model`;
      },
      resolveReasoning: (runtimeId: string, ownerUserId?: string) => {
        reasoningRuntime = runtimeId;
        reasoningOwnerUserId = ownerUserId;
        return runtimeId === 'pi' ? 'low' : 'xhigh';
      },
    },
    dataDir: '/tmp/agent-runtime-test',
  });
  patchModule(piToolsPath, 'buildPiTools', () => []);
  patchModule(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
  patchModule(piAiPath, 'loadPiAi', async () => ({
    Type: {},
    clampThinkingLevel: (_model: unknown, level: string) => level,
    getModel: (_provider: string, requestedModelId: string) => {
      modelId = requestedModelId;
      return { contextWindow: 1000 };
    },
    streamSimple: () => {
      throw new Error('streamSimple should not be called by this Agent stub');
    },
  }));
  patchModule(piAiPath, 'loadPiAgentCore', async () => ({
    Agent: class {
      state = { messages: [] };
      private subscriber: ((event: any) => void) | undefined;

      constructor(opts: any) {
        thinkingLevel = opts.initialState.thinkingLevel;
        afterToolCall = opts.afterToolCall;
        beforeToolCall = opts.beforeToolCall;
      }

      subscribe(fn: (event: any) => void) {
        this.subscriber = fn;
        return () => {
          this.subscriber = undefined;
        };
      }

      async prompt() {
        this.subscriber?.({ type: 'agent_end' });
      }
    },
  }));

  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  const session = new PiSession('pi-session', {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '',
    cwd: process.cwd(),
    enableFollowUps: true,
    workspaceId: 'workspace-1',
    ownerUserId: 'local-user',
    owner: runOwner('run-1', 'pi-session'),
    toolProfile: { allowedToolNames: ['write'] },
    permissionBroker: {
      requestPermission: async ({ ownerUserId }) => {
        brokerOwnerUserId = ownerUserId;
        return brokerDecision;
      },
    },
  });

  for await (const ev of session.send('continue old chat')) {
    if (ev.kind === 'turn_end') break;
  }

  assert.equal(modelRuntime, 'pi');
  assert.equal(reasoningRuntime, 'pi');
  assert.equal(configOwnerUserId, undefined);
  assert.equal(modelOwnerUserId, undefined);
  assert.equal(reasoningOwnerUserId, undefined);
  assert.equal(keyOwnerUserId, undefined);
  assert.equal(modelId, 'pi-model');
  assert.equal(thinkingLevel, 'low');
  assert.equal(typeof afterToolCall, 'function');
  assert.deepEqual(afterToolCall?.({ result: { isError: true }, isError: false }), { isError: true });
  assert.equal(typeof beforeToolCall, 'function');

  let permissionEvent: any;
  (session as any).activePush = (event: unknown) => { permissionEvent = event; };
  const pending = beforeToolCall!({ toolCall: { name: 'write' }, args: { path: 'notes.md' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(permissionEvent.kind, 'permission_request');
  assert.equal(permissionEvent.detail, 'File: notes.md');
  session.respondToPermission(permissionEvent.requestId, 'allow_once');
  assert.equal(await pending, undefined);

  brokerDecision = 'deny';
  assert.deepEqual(await beforeToolCall!({ toolCall: { name: 'write' }, args: {} }), {
    block: true,
    reason: 'denied by Run permission policy',
  });
  assert.equal(brokerOwnerUserId, 'local-user');
  assert.equal(permissionEvent.options.some((option: any) => option.kind === 'allow_session'), false, 'Run decisions remain separate');

  const chat = new PiSession('pi-chat', {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'workspace-1', ownerUserId: null,
  });
  for await (const event of chat.send('permission test')) { if (event.kind === 'turn_end') break; }
  (chat as any).activePush = (event: unknown) => { permissionEvent = event; };
  const command = `npm test -- ${'x'.repeat(288)}`;
  const bashPending = beforeToolCall!({ toolCall: { name: 'bash' }, args: { command } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(permissionEvent.detail, `Command: ${command}`, 'the card shows the whole command the title cuts');
  chat.respondToPermission(permissionEvent.requestId, 'allow_once');
  assert.equal(await bashPending, undefined);
  const chatPending = beforeToolCall!({ toolCall: { name: 'write' }, args: { path: 'test' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(permissionEvent.options.length, 4);
  chat.respondToPermission(permissionEvent.requestId, 'allow_session');
  assert.equal(await chatPending, undefined);
  assert.equal(await beforeToolCall!({ toolCall: { name: 'bash' }, args: {} }), undefined, 'later Pi tools inherit session trust');
  assert.equal((chat as any).pendingPermissions.size, 0);
});

test('PiSession sends thread messages directly and asks a requested approval through ask_user, single-use', async () => {
  delete process.env.MICHI_CLOUD;
  const piAiPath = require.resolve('../src/agents/pi/piAi');
  const piToolsPath = require.resolve('../src/agents/pi/piTools');
  let toolOpts: any;
  let beforeToolCall: ((context: { toolCall: { name: string }; args: unknown }) => Promise<{ block: boolean; reason?: string } | undefined>) | undefined;
  configureRuntimeDeps({
    historyStore: {
      getNode: () => null, listMessages: () => [], getWorkspace: () => null,
      getWorkspaceInstructions: () => null,
    },
    providerKeys: { getProviderApiKey: () => 'test-key' },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'pi', provider: 'deepseek', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => 'pi-model',
      resolveReasoning: () => undefined,
    },
    dataDir: '/tmp/agent-runtime-test',
  });
  patchModule(piToolsPath, 'buildPiTools', (opts: any) => { toolOpts = opts; return []; });
  patchModule(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
  patchModule(piAiPath, 'loadPiAi', async () => ({
    Type: {},
    clampThinkingLevel: (_model: unknown, level: string) => level,
    getModel: () => ({ contextWindow: 1000 }),
    streamSimple: () => { throw new Error('not used'); },
  }));
  patchModule(piAiPath, 'loadPiAgentCore', async () => ({
    Agent: class {
      state = { messages: [] };
      private subscriber: ((event: any) => void) | undefined;
      constructor(opts: any) { beforeToolCall = opts.beforeToolCall; }
      subscribe(fn: (event: any) => void) { this.subscriber = fn; return () => { this.subscriber = undefined; }; }
      async prompt() { this.subscriber?.({ type: 'agent_end' }); }
    },
  }));

  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  const chat = new PiSession('pi-thread-chat', {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'workspace-1', ownerUserId: null,
    owner: chatOwner('n-a'),
  });
  for await (const event of chat.send('build tools')) { if (event.kind === 'turn_end') break; }
  assert.equal(typeof toolOpts?.requestUserInput, 'function');

  const events: any[] = [];
  (chat as any).activePush = (event: unknown) => { events.push(event); };
  (chat as any).turnAbort = new AbortController();
  assert.equal(await beforeToolCall!({ toolCall: { name: 'send_to_thread' }, args: { nodeId: 'n-b', text: 'progress' } }), undefined);
  assert.equal(events.length, 0, 'routine messages do not open a runtime permission card');
  const request = { targetNodeId: 'n-b', targetTitle: 'Implementation', text: 'Please review' };
  const mcpQuestions = await new Promise((resolve) => {
    void askUserThreadMessageApprover(async (questions) => { resolve(questions); return null; })(request);
  });
  const approve = askUserThreadMessageApprover(piAskUserChannel(toolOpts.requestUserInput));
  const lastQuestion = () => events.filter((event) => event.kind === 'user_input_request').at(-1);

  const approval = approve(request);
  await new Promise((resolve) => setImmediate(resolve));
  const asked = lastQuestion();
  assert.deepEqual(asked.questions, mcpQuestions, 'the same question card as on the other runtimes');
  assert.equal(events.some((event) => event.kind === 'permission_request'), false);

  // Granting session trust to a tool must not approve the pending message.
  const other = beforeToolCall!({ toolCall: { name: 'write' }, args: { path: 'x' } });
  await new Promise((resolve) => setImmediate(resolve));
  chat.respondToPermission(events.at(-1).requestId, 'allow_session');
  assert.equal(await other, undefined);
  assert.equal((chat as any).pendingUserInputs.has(asked.requestId), true, 'the approval must still be pending');

  chat.respondToUserInput(asked.requestId, [{ question: asked.questions[0].question, answer: 'Send' }]);
  assert.deepEqual(await approval, { approved: true });

  // A typed answer declines and goes back to the agent as the user's note.
  const next = approve(request);
  await new Promise((resolve) => setImmediate(resolve));
  const second = lastQuestion();
  assert.notEqual(second.requestId, asked.requestId);
  chat.respondToUserInput(second.requestId, [{ question: second.questions[0].question, answer: 'not yet' }]);
  assert.deepEqual(await next, { approved: false, reason: 'declined', note: 'not yet' });

  // Unanswered for five minutes: no answer, and the card is withdrawn.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const unanswered = approve(request);
    await new Promise((resolve) => setImmediate(resolve));
    const third = lastQuestion();
    mock.timers.tick(5 * 60 * 1000);
    assert.deepEqual(await unanswered, { approved: false, reason: 'no_answer' });
    assert.deepEqual(events.at(-1), { kind: 'user_input_resolved', requestId: third.requestId, answers: [], outcome: 'skipped' });
  } finally {
    mock.timers.reset();
  }

  // A follow-up of the agent's (companion_session_send, DESIGN-v2 §4) offers "Send, and stop asking" as a third answer (G2-review #3).
  const followUp = approve({ ...request, exact: true, offerStopAsking: true, permissionNote: 'It runs in Trust: its tools run without asking.' });
  await new Promise((resolve) => setImmediate(resolve));
  const fourth = lastQuestion();
  assert.deepEqual(fourth.questions[0].options.map((option: any) => option.label), ['Send', 'Send, and stop asking for this conversation', "Don't send"]);
  assert.ok(fourth.questions[0].question.includes('It runs in Trust: its tools run without asking.'), fourth.questions[0].question);
  chat.respondToUserInput(fourth.requestId, [{ question: fourth.questions[0].question, answer: 'Send, and stop asking for this conversation' }]);
  assert.deepEqual(await followUp, { approved: true, stopAsking: true });
  const once = approve({ ...request, offerStopAsking: true });
  await new Promise((resolve) => setImmediate(resolve));
  const fifth = lastQuestion();
  chat.respondToUserInput(fifth.requestId, [{ question: fifth.questions[0].question, answer: 'Send' }]);
  assert.deepEqual(await once, { approved: true }, 'Send alone does not stop asking');
});

function stubPiForMetaAgent(builtTools: string[]): { agentTools: () => string[] | undefined; buildCalls: () => number; prompts: string[] } {
  delete process.env.MICHI_CLOUD;
  let tools: string[] | undefined;
  let buildCalls = 0;
  const prompts: string[] = [];
  configureRuntimeDeps({
    historyStore: {
      getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null,
    },
    providerKeys: { getProviderApiKey: () => 'test-key' },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'pi', provider: 'deepseek', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => 'pi-model',
      resolveReasoning: () => 'low',
    },
    dataDir: '/tmp/agent-runtime-test',
  });
  patchModule(require.resolve('../src/agents/pi/piTools'), 'buildPiTools', () => {
    buildCalls += 1;
    return builtTools.map((name) => ({ name, label: name, description: name, parameters: {}, execute: async () => ({}) }));
  });
  patchModule(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => { throw new Error('a Meta agent reads no user MCP config'); });
  const piAiPath = require.resolve('../src/agents/pi/piAi');
  patchModule(piAiPath, 'loadPiAi', async () => ({
    Type: new Proxy({}, { get: () => (..._a: any[]) => ({}) }),
    clampThinkingLevel: (_model: unknown, level: string) => level,
    getModel: () => ({ contextWindow: 1000 }),
    streamSimple: () => { throw new Error('unused'); },
  }));
  patchModule(piAiPath, 'loadPiAgentCore', async () => ({
    Agent: class {
      state: any;
      private subscriber: ((event: any) => void) | undefined;
      constructor(opts: any) {
        this.state = { messages: [], tools: opts.initialState.tools };
        tools = opts.initialState.tools.map((tool: { name: string }) => tool.name);
      }
      subscribe(fn: (event: any) => void) { this.subscriber = fn; return () => { this.subscriber = undefined; }; }
      async prompt(text: string) { prompts.push(text); this.subscriber?.({ type: 'agent_end' }); }
    },
  }));
  return { agentTools: () => tools, buildCalls: () => buildCalls, prompts };
}

function newPiMetaSession(id: string, toolProfile: unknown): any {
  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  return new PiSession(id, {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'workspace-1', ownerUserId: null,
    owner: { mode: 'interactive', key: id },
    toolProfile: toolProfile as any,
  });
}

async function drainPi(session: any, text: string, input?: unknown): Promise<void> {
  for await (const event of session.send(text, input)) { if (event.kind === 'turn_end') break; }
}

test('Pi Meta agent chat: only the chat toolset reaches the model', async () => {
  const { assistantToolProfile, META_AGENT_CHAT_TOOL_NAMES } = require('../src/assistant/policy') as typeof import('../src/assistant/policy');
  const stub = stubPiForMetaAgent(['list_threads', 'send_to_thread', 'bash', 'read_page', 'save_artifact']);
  const session = newPiMetaSession('n-chat', restrictedChatProfile());
  await drainPi(session, 'what is waiting?');
  assert.deepEqual(stub.agentTools(), ['list_threads', 'read_page']);
  assert.ok(stub.agentTools()!.every((name) => META_AGENT_CHAT_TOOL_NAMES.includes(name)));
});

test('Pi Michi chat omits metadata glue and reminders on fresh and restored turns', async () => {
  const { assistantToolProfile } = require('../src/assistant/policy') as typeof import('../src/assistant/policy');
  const { buildFormatReminder } = require('../src/agents/preamble') as typeof import('../src/agents/preamble');
  const { rowsToAgentMessages } = require('../src/agents/pi/historyAdapter') as typeof import('../src/agents/pi/historyAdapter');
  const stub = stubPiForMetaAgent(['list_threads', 'read_page']);
  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  for (const restored of [false, true]) {
    const session = new PiSession(`michi-${restored}`, {
      bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
      preamble: '', cwd: process.cwd(), enableFollowUps: true,
      firstUserGlue: buildFormatReminder(true), workspaceId: 'workspace-1', ownerUserId: null,
      toolProfile: restrictedChatProfile(),
      ...(restored ? { initialMessages: rowsToAgentMessages([
        { role: 'user', content: 'Earlier question', created_at: 1 },
        { role: 'assistant', content: 'Earlier answer', created_at: 2 },
      ]) } : {}),
    });
    for (const question of ['What is waiting?', 'What changed?', 'What should I read?']) {
      await drainPi(session, question);
      assert.equal(stub.prompts.at(-1), question, 'the provider receives the question without chat metadata directives');
    }
    session.destroy();
  }
});

test('Pi sends the Michi Memory block ahead of the Pages context for the model only', async () => {
  const stub = stubPiForMetaAgent([]);
  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  const session = new PiSession('pi-memory', {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: '', cwd: process.cwd(), enableFollowUps: false, workspaceId: 'workspace-1', ownerUserId: null,
    owner: chatOwner('pi-memory'),
  });
  await drainPi(session, 'first question', {
    memoryContext: '<michi-memory>\n- Reply in Chinese. (preference)\n</michi-memory>',
    pageContext: 'Michi Pages manifest (JSON): {}',
  });
  await drainPi(session, 'second question');
  assert.equal(stub.prompts[0], '<michi-memory>\n- Reply in Chinese. (preference)\n</michi-memory>\n\n---\n\nMichi Pages manifest (JSON): {}\n\n---\n\nfirst question');
  assert.equal(stub.prompts[1], 'second question', 'a turn without a block sends none');
  assert.deepEqual(session.getHistory().filter((m) => m.role === 'user').map((m) => m.content), ['first question', 'second question']);
  session.destroy();
});

test('Pi Meta agent chat: a tool that slips past the allow-list stops the run with MetaAgentGuardError', async () => {
  const { assistantToolProfile } = require('../src/assistant/policy') as typeof import('../src/assistant/policy');
  const { MetaAgentGuardError } = require('../src/agents/metaAgentGuard') as typeof import('../src/agents/metaAgentGuard');
  const stub = stubPiForMetaAgent(['list_threads', 'bash']);
  const session = newPiMetaSession('n-chat-leak', restrictedChatProfile());
  session.isToolAllowed = () => true;
  await assert.rejects(drainPi(session, 'hi'), (error: unknown) => error instanceof MetaAgentGuardError
    && error.violation.runtimeId === 'pi' && error.violation.toolset === 'chat' && error.violation.unexpectedTools.join() === 'bash');
  assert.equal(stub.agentTools(), undefined, 'no agent was built');
});

test('Pi Meta agent maintenance: only the dedicated maintenance tools, never the chat builtins', async () => {
  const { maintenanceToolProfile, META_AGENT_MAINTENANCE_TOOL_NAMES } = require('../src/agents/maintenancePolicy') as typeof import('../src/agents/maintenancePolicy');
  const stub = stubPiForMetaAgent(['list_threads', 'read_node', 'bash']);
  const session = newPiMetaSession('n-maint', maintenanceToolProfile());
  await drainPi(session, 'maintain', {
    turnId: 't-1', assistantMessageId: 'a-1',
    maintenanceContext: {
      workspaceId: 'workspace-1', ownerUserId: 'local-user', jobId: 'job-1', runId: 'run-1', claimedBy: 'w', configRevision: 1, planId: 'plan-1', sources: [],
    },
  });
  assert.equal(stub.buildCalls(), 0);
  assert.deepEqual(stub.agentTools(), [...META_AGENT_MAINTENANCE_TOOL_NAMES]);
});

test('Pi automatic memory: only the extraction tool, never maintenance or chat tools', async () => {
  const { memoryExtractionToolProfile, MEMORY_EXTRACTION_TOOL_NAMES } = require('../src/services/memory/extractionProfile') as typeof import('../src/services/memory/extractionProfile');
  const stub = stubPiForMetaAgent(['list_threads', 'memory_search', 'bash']);
  const session = newPiMetaSession('n-memory', memoryExtractionToolProfile());
  await drainPi(session, 'extract', {
    turnId: 't-1', assistantMessageId: 'a-1',
    maintenanceContext: {
      workspaceId: 'workspace-1', ownerUserId: 'local-user', jobId: 'job-1', runId: 'run-1', claimedBy: 'w', configRevision: 1, planId: 'mxr-1', sources: [],
    },
  });
  assert.equal(stub.buildCalls(), 0, 'no chat builtins, including a chat memory tool of the same name');
  assert.deepEqual(stub.agentTools(), [...MEMORY_EXTRACTION_TOOL_NAMES]);
});
