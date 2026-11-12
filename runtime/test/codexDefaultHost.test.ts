import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { NormalizedEvent } from '../src/contract/events';
import type { RuntimeHost } from '../src/contract/host';
import type { McpSlot, McpSlotCallbacks, McpSlotProvider } from '../src/contract/mcp';
import type { AgentToolBridge } from '../src/contract/tools';
import type { RuntimeToolProfile } from '../src/contract/types';
import { createDefaultHost } from '../src/core/defaultHost';
import type { CodexAppServerClient, ServerRequestHandler } from '../src/adapters/codex/CodexAppServerClient';
import { CodexRuntime, type CodexHostText } from '../src/adapters/codex/CodexRuntime';
import type { CodexSession } from '../src/adapters/codex/CodexSession';
import { CODEX_HOST_MCP_SERVER, CODEX_MEMORIES_OFF, CODEX_SERVER_REQUESTS, CODEX_THREAD_FEATURES_OFF } from '../src/adapters/codex/codexProtocol';
import { CODEX_RESTRICTED_FEATURES_OFF, CODEX_RESTRICTED_TOOLS_OFF } from '../src/adapters/codex/codexRestrictedProfile';

interface Request { method: string; params: Record<string, any> }

/**
 * An app-server that answers what a chat session asks and records every
 * request: chat threads are thread-1, thread-2, …; ephemeral (title)
 * threads finish their turn at once. `userServers` are the MCP servers of
 * the user's Codex config, which a restricted thread reports disabled.
 */
function fakeAppServer(userServers: string[] = []) {
  const requests: Request[] = [];
  const handlers = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  let serverRequest: ServerRequestHandler | null = null;
  let threads = 0;
  const emit = (threadId: string, method: string, params: Record<string, unknown>) => {
    for (const handler of handlers.get(threadId) ?? []) handler(method, params);
  };
  const client = {
    ensureStarted: async () => {},
    request: async (method: string, params: Record<string, any>) => {
      requests.push({ method, params });
      switch (method) {
        case 'thread/start':
          return { threadId: params.ephemeral ? `title-${++threads}` : `thread-${++threads}` };
        case 'model/list':
          return { data: [] };
        case 'config/read':
          return { config: { mcp_servers: Object.fromEntries(userServers.map((name) => [name, { command: name }])) }, origins: {} };
        case 'mcpServerStatus/list':
          return { data: [
            { name: CODEX_HOST_MCP_SERVER, runtimeStatus: 'connected' },
            ...userServers.map((name) => ({ name, runtimeStatus: 'disabled' })),
          ] };
        case 'turn/start':
          if (String(params.threadId).startsWith('title-')) {
            queueMicrotask(() => emit(params.threadId, 'turn/completed', { threadId: params.threadId, turn: { id: 'title-turn', status: 'completed' } }));
            return { turn: { id: 'title-turn' } };
          }
          return { turn: { id: `turn-${params.threadId}` } };
        default:
          return {};
      }
    },
    onNotification: (threadId: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      let set = handlers.get(threadId);
      if (!set) handlers.set(threadId, (set = new Set()));
      set.add(handler);
      return () => { set.delete(handler); };
    },
    onGlobalNotification: () => () => {},
    onServerRequest: (handler: ServerRequestHandler) => { serverRequest = handler; },
    onExit: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
  };
  return {
    client: client as unknown as CodexAppServerClient,
    requests,
    find: (method: string, threadId?: string) =>
      requests.find((r) => r.method === method && (threadId === undefined || r.params.threadId === threadId)),
    endTurn: (threadId: string) => emit(threadId, 'turn/completed', { threadId, turn: { id: `turn-${threadId}`, status: 'completed' } }),
    /** What the runtime answers a server request of the thread's running turn. */
    ask: (method: string, threadId: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve) => {
      serverRequest!(method, { threadId, turnId: `turn-${threadId}`, ...params }, resolve, {
        requestId: 1, signal: new AbortController().signal, reject: (code, message) => resolve({ error: { code, message } }),
      });
    }),
  };
}

/** Slots as the host creates them; the host serves each one the tools its exposedToolNames allow. */
function slotProvider(created: McpSlotCallbacks[]): McpSlotProvider {
  return {
    create: (parentChatId: string, cwd: string, ownerUserId: string | null, cbs: McpSlotCallbacks) => {
      created.push(cbs);
      return { slotId: `slot-${created.length}`, parentChatId, cwd, ownerUserId, nodeId: null, workspaceId: null, ...cbs } as McpSlot;
    },
    dispose: async () => {},
    endpoint: (slotId: string) => ({ type: 'http', url: `http://127.0.0.1:1/api/mcp/${slotId}`, headers: [] }),
  } as unknown as McpSlotProvider;
}

const bridge: AgentToolBridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };

/** A Codex runtime on the fake app-server, without Michi's host or host text unless given. */
function codexRuntime(t: TestContext, options: { host?: RuntimeHost; hostText?: CodexHostText; userServers?: string[] } = {}) {
  const server = fakeAppServer(options.userServers);
  const slots: McpSlotCallbacks[] = [];
  const runtime = new CodexRuntime(
    {
      host: options.host ?? createDefaultHost({ logLevel: 'silent' }),
      ...(options.hostText ? { hostText: options.hostText } : {}),
      bridge,
      mcpSlots: slotProvider(slots),
    },
    { client: server.client },
  );
  const turns: Array<Promise<void>> = [];
  const threadIds: string[] = [];
  t.after(async () => {
    for (const threadId of threadIds) server.endTurn(threadId);
    await runtime.shutdown();
    await Promise.all(turns);
  });
  /** Opens a chat and sends it `text`; resolves once its turn has started. */
  const chat = async (sessionId: string, text: string, toolProfile?: RuntimeToolProfile) => {
    const session = await runtime.newSession({ sessionId, cwd: os.tmpdir(), model: 'test-model', ...(toolProfile ? { toolProfile } : {}) }) as CodexSession;
    const threadStart = server.requests.filter((r) => r.method === 'thread/start' && !r.params.ephemeral).at(-1)!;
    const threadId = `thread-${server.requests.filter((r) => r.method === 'thread/start').indexOf(threadStart) + 1}`;
    threadIds.push(threadId);
    const events: NormalizedEvent[] = [];
    turns.push((async () => { for await (const event of session.send(text)) events.push(event); })());
    for (let i = 0; i < 200 && !server.find('turn/start', threadId); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const turnStart = server.find('turn/start', threadId);
    assert.ok(turnStart, `the turn of ${threadId} started`);
    const turnText = (turnStart.params.input as Array<{ type: string; text?: string }>).find((part) => part.type === 'text')!.text!;
    return { session, threadId, threadStart, turnStart, turnText, events, slot: slots.at(-1)! };
  };
  return { server, chat, runtime };
}

describe('CodexRuntime under createDefaultHost', () => {
  it('runs a restricted session locked down even in YOLO mode, and an ordinary one as before', async (t) => {
    const host = createDefaultHost({ logLevel: 'silent', permissionMode: 'yolo' });
    const { server, chat } = codexRuntime(t, { host, userServers: ['user-mcp'] });
    const allowedToolNames = ['list_threads', 'read_node'];
    const restricted = await chat('chat-restricted', 'hello', { allowedToolNames, restricted: true });

    assert.equal(restricted.session.isAssistant, true);
    // Its slot asks the host to serve only the allow-listed tools.
    assert.equal(restricted.slot.restricted, true);
    assert.deepEqual([...restricted.slot.exposedToolNames!].sort(), allowedToolNames);
    // Read-only thread; the user's MCP servers, shell, plugins and web search off; checked after the start.
    assert.equal(restricted.threadStart.params.sandbox, 'read-only');
    const config = restricted.threadStart.params.config;
    assert.deepEqual(config.mcp_servers['user-mcp'], { enabled: false });
    assert.match(config.mcp_servers[CODEX_HOST_MCP_SERVER].url, /\/api\/mcp\/slot-1$/);
    assert.deepEqual(config.features, CODEX_RESTRICTED_FEATURES_OFF);
    assert.equal(config.features.view_image, false);
    // Codex's question tool (request_user_input) and plan tool off too.
    assert.deepEqual(config.tools, CODEX_RESTRICTED_TOOLS_OFF);
    assert.equal(config.web_search, 'disabled');
    assert.equal(server.find('mcpServerStatus/list')?.params.threadId, restricted.threadId);
    // Read-only, offline turns.
    assert.equal(restricted.turnStart.params.approvalPolicy, 'on-request');
    assert.deepEqual(restricted.turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    // Every approval and elicitation declined.
    for (const method of [CODEX_SERVER_REQUESTS.commandApproval, CODEX_SERVER_REQUESTS.fileChangeApproval]) {
      assert.deepEqual(await server.ask(method, restricted.threadId, { command: 'rm -rf /' }), { decision: 'decline' }, method);
    }
    assert.deepEqual(
      await server.ask(CODEX_SERVER_REQUESTS.mcpElicitation, restricted.threadId, {
        serverName: 'user-mcp', mode: 'form', message: 'Post?', requestedSchema: { type: 'object', properties: {} }, _meta: null,
      }),
      { action: 'decline', content: null, _meta: null },
    );
    // A question Codex asks anyway gets no answers at once, and never reaches the chat (no one may be watching).
    const question = { questions: [{ id: 'q1', header: 'Confirm', question: 'Forward this mail?', options: [{ label: 'Yes' }, { label: 'No' }] }] };
    const waiting = new Promise((resolve) => setTimeout(() => resolve('still waiting for an answer'), 500));
    assert.deepEqual(await Promise.race([server.ask(CODEX_SERVER_REQUESTS.requestUserInput, restricted.threadId, question), waiting]), { answers: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(restricted.events.filter((event) => event.kind === 'user_input_request' || event.kind === 'user_input_resolved'), []);

    const ordinary = await chat('chat-ordinary', 'hello');
    assert.equal(ordinary.session.isAssistant, false);
    assert.equal(ordinary.slot.restricted, undefined);
    assert.equal(ordinary.slot.exposedToolNames, undefined);
    assert.equal(ordinary.threadStart.params.sandbox, 'workspace-write');
    // Ordinary threads turn off only Codex goals (self-started turns Michi does not show).
    assert.deepEqual(ordinary.threadStart.params.config.features, CODEX_THREAD_FEATURES_OFF);
    assert.deepEqual(ordinary.turnStart.params.sandboxPolicy, { type: 'dangerFullAccess' });
    assert.notDeepEqual(await server.ask(CODEX_SERVER_REQUESTS.commandApproval, ordinary.threadId, { command: 'ls' }), { decision: 'decline' },
      'the same request reaches an ordinary session, which YOLO mode does not decline');
    assert.equal(ordinary.threadStart.params.config.tools, undefined, 'an ordinary thread keeps Codex\'s question tool');
    const asked = server.ask(CODEX_SERVER_REQUESTS.requestUserInput, ordinary.threadId, question);
    for (let i = 0; i < 200 && !ordinary.events.some((event) => event.kind === 'user_input_request'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const shown = ordinary.events.find((event) => event.kind === 'user_input_request');
    assert.ok(shown && shown.kind === 'user_input_request', 'the same question reaches an ordinary chat');
    assert.equal(shown.questions[0]?.question, 'Forward this mail?');
    ordinary.session.skipUserInput(shown.requestId);
    assert.deepEqual(await asked, { answers: {} });
  });

  it('adds no turn-metadata instruction without hostText.turnMetadataInstruction', async (t) => {
    const plain = await codexRuntime(t).chat('chat-plain', 'hello');
    assert.equal(plain.threadStart.params.developerInstructions, '');
    assert.equal(plain.turnText, 'hello');
    const given = await codexRuntime(t, { hostText: { turnMetadataInstruction: () => '<metadata>' } }).chat('chat-given', 'hello');
    assert.equal(given.threadStart.params.developerInstructions, '<metadata>');
    assert.equal(given.turnText, 'hello<metadata>');
  });

  it("binds a maintenance send to the host's own principal", async (t) => {
    const host = createDefaultHost({
      logLevel: 'silent', principal: 'alice',
      ports: { profile: { isMaintenance: (profile) => profile?.capabilitySnapshot === 'maintenance' } },
    });
    const { server, runtime } = codexRuntime(t, { host });
    const session = await runtime.newSession({
      sessionId: 'chat-maintenance', cwd: os.tmpdir(), model: 'test-model', workspaceId: 'ws-1',
      toolProfile: { capabilitySnapshot: 'maintenance' },
    }) as CodexSession;
    const maintenanceContext = {
      workspaceId: 'ws-1', ownerUserId: host.principal.resolve(null), jobId: 'job-1', runId: 'run-1',
      claimedBy: 'worker-1', configRevision: 1, planId: 'plan-1', sources: [],
    };
    const events = session.send('maintain', { turnId: 'turn-1', assistantMessageId: 'a-1', maintenanceContext });
    const first = events.next();
    for (let i = 0; i < 200 && !server.find('turn/start'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(session.getActiveMaintenanceExecutionContext()?.execution,
      { nodeId: 'chat-maintenance', turnId: 'turn-1', assistantId: 'a-1', runId: 'run-1' });
    server.endTurn(String(server.find('turn/start')!.params.threadId));
    await first;
    for await (const _event of events) { /* drain */ }
  });

  it('starts the title thread with no developer instructions without hostText.titleInstructions', async (t) => {
    const titled = () => createDefaultHost({ logLevel: 'silent', ports: { title: { enabled: () => true, prompt: () => '' } } });
    const titleStart = async (hostText?: CodexHostText) => {
      const { server, chat } = codexRuntime(t, { host: titled(), hostText });
      await chat(`chat-title-${hostText ? 'given' : 'plain'}`, 'hello');
      for (let i = 0; i < 200 && !server.requests.some((r) => r.method === 'thread/start' && r.params.ephemeral); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return server.requests.find((r) => r.method === 'thread/start' && r.params.ephemeral);
    };
    assert.equal((await titleStart())?.params.developerInstructions, '');
    assert.equal((await titleStart({ titleInstructions: () => '<title>' }))?.params.developerInstructions, '<title>');
  });

  it('keeps Codex memories out of the chat and its title thread when the host keeps memory itself', async (t) => {
    const host = createDefaultHost({
      logLevel: 'silent',
      ports: { title: { enabled: () => true, prompt: () => '' }, config: { features: { workflows: () => false, nativeMemory: () => false } } },
    });
    const { server, chat } = codexRuntime(t, { host });
    const { threadStart } = await chat('chat-memory-off', 'hello');
    for (let i = 0; i < 200 && !server.requests.some((r) => r.method === 'thread/start' && r.params.ephemeral); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const titleStart = server.requests.find((r) => r.method === 'thread/start' && r.params.ephemeral);
    assert.deepEqual(threadStart.params.config.memories, CODEX_MEMORIES_OFF);
    assert.deepEqual(titleStart?.params.config.memories, CODEX_MEMORIES_OFF);
    assert.deepEqual(titleStart?.params.config.features, CODEX_THREAD_FEATURES_OFF);
  });
});
