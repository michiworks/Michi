// Isolate configuration before importing runtime modules; only the provider is faked.
import { isolatedIntegrationDataDir, resetIntegrationConfig } from './isolatedIntegrationEnvironment';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { threadMessageBody } from 'michi-shared';
import { ChatHub, chatHub, type StartedRequestedSelfTurn } from '../src/agents/chatHub';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, dropSession } from '../src/agents/sessionRegistry';
import { recoverThreadMessageWakes, sendToThreadTool, type ThreadMessagingDeps } from '../src/agents/threadMessageTool';
import { settleStoppedThreadWakes, threadReplyTurnId } from '../src/agents/threadMessageWakes';
import { getThreadWake } from '../src/services/threadMessageWakeStore';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions } from '../src/agents/types';
import { ChatManager } from '../src/services/chatManager';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, getWorkspace, getWorkspaceInstructions, listMessages, updateNodeResumeBinding } from '../src/services/dbRepository';
import { getAgentConfig, loadAgentConfig, resolveModel, resolveReasoning } from '../src/services/agentConfig';
import { acquireSessionRestoreLock } from '../src/services/nativeResume';
import { buildPiTools } from '../src/agents/pi/piTools';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { chatOwner } from './helpers/owners';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

let directory: string;
let manager: ChatManager;
let hub: ChatHub;
let deps: ThreadMessagingDeps;
let loads: number;
let fresh: number;
let released: number;
let asked: number;
let sends: string[];
let started: Array<Promise<StartedRequestedSelfTurn>>;
let foregroundGate: Promise<void> | undefined;
let releaseForeground: (() => void) | undefined;
/** Holds the target's turn for a thread message open until released. */
let messageGate: Promise<void> | undefined;
let releaseMessage: (() => void) | undefined;
let keepAlive: ReturnType<typeof setInterval> | undefined;
const priorCloud = process.env.MICHI_CLOUD;
const caller = { ownerUserId: null, workspaceId: 'ws', nodeId: 'child', isAgentRun: false };
const approve = async () => { asked++; return { approved: true as const }; };

beforeEach(() => {
  // The tool's start wait uses an unref'd timer, and a turn gated on a promise
  // holds no handle: without this the runner can find the event loop empty
  // mid-test and cancel the rest of the file (the busy-parent test did).
  keepAlive = setInterval(() => {}, 1_000);
  directory = fs.mkdtempSync(path.join(isolatedIntegrationDataDir, 'thread-delivery-'));
  process.env.MICHI_DATA_DIR = directory;
  delete process.env.MICHI_CLOUD;
  resetIntegrationConfig();
  closeDb(); initDb(); clearAllSessions(); loadAgentConfig();
  loads = fresh = released = asked = 0;
  sends = []; started = []; foregroundGate = undefined; releaseForeground = undefined;
  messageGate = undefined; releaseMessage = undefined;
  // A real desktop workspace may retain a Better-Auth/cloud owner from an older login.
  getDb().prepare("INSERT INTO workspaces (id,name,cwd,owner_user_id,created_at,updated_at) VALUES ('ws','Workspace',?,'old-account',1,1)").run(directory);
  getDb().prepare("INSERT INTO nodes (id,workspace_id,kind,status,created_at) VALUES ('parent','ws','chat','idle',1)").run();
  getDb().prepare("INSERT INTO nodes (id,workspace_id,parent_node_id,kind,status,created_at) VALUES ('child','ws','parent','chat','idle',2)").run();
  updateNodeResumeBinding('parent', { runtime_id: 'codex', acp_session_id: 'native-parent', model_id: 'test-model' });
  const session = (opts: NewAgentSessionOptions): AgentSession => ({
    id: opts.sessionId!, nativeSessionId: `native-${opts.sessionId}`, runtimeId: 'codex', currentModelId: 'test-model',
    owner: chatOwner(opts.sessionId!),
    getHistory: () => [], getPendingAssistant: () => undefined, cancel() {},
    async *send(text) {
      sends.push(text);
      if (text === 'foreground' && foregroundGate) await foregroundGate;
      if (text.startsWith('[Thread message]') && messageGate) await messageGate;
      yield { kind: 'chunk', text: 'Received.' };
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    },
  });
  const runtime: AgentRuntime = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id: 'codex', label: 'Test Codex', capabilities: {
      modes: false, permissions: false, models: false, providerModels: false, reasoning: false,
      supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false,
      spawnBranches: true, nativeResume: true,
    },
    async warm() {}, async shutdown() {}, async releaseSession(id) { released++; dropSession(id); },
    async newSession(opts) { fresh++; return session(opts); },
    async loadSession(opts) { loads++; return session(opts); },
  };
  registerRuntime(runtime);
  manager = new ChatManager(undefined, directory);
  hub = new ChatHub({ retentionMs: 10, titleGenerator: null });
  // As server.ts wires the process hub: a Stop ends the wake chain of its turn.
  hub.onCancel(({ turnId }) => settleStoppedThreadWakes(turnId));
  let turn = 0;
  deps = {
    ensureSession: (input) => manager.ensureParentSession(input),
    startTurn: (args) => { const start = hub.startRequestedSelfTurn(args); started.push(start); return start; },
    acquireRestoreLock: acquireSessionRestoreLock,
    newTurnId: () => `message-${++turn}`,
    startWaitMs: 10,
  };
});

afterEach(async () => {
  releaseForeground?.();
  releaseMessage?.();
  for (const start of started) await (await start.catch(() => ({ done: Promise.resolve() }))).done;
  clearAllSessions(); closeDb();
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD;
  else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(directory, { recursive: true, force: true });
  clearInterval(keepAlive);
});

async function send(extra: { wait?: boolean; wake?: boolean; timeoutMs?: number } = {}) {
  const result = await sendToThreadTool(caller, { nodeId: 'parent', text: 'Child finished; please review.', ...extra }, approve, deps);
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

async function until(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The child (the sender) can be woken: its own session restores like the parent's. */
function bindChild(): void {
  updateNodeResumeBinding('child', { runtime_id: 'codex', acp_session_id: 'native-child', model_id: 'test-model' });
}

/** The person's turn in the child that the chain starts from, finished. */
async function childPersonTurn(): Promise<AgentSession> {
  const session = await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'child' });
  assert.ok(session);
  await (await hub.startTurn({ chatId: 'child', nodeId: 'child', turnId: 'child-person', text: 'hello', session })).done;
  return session;
}

test('a child restores its local parent with a legacy account owner and persists an attributed message without asking', async () => {
  assert.equal((await send()).status, 'started');
  await (await started[0]).done;
  assert.equal(asked, 0);
  assert.equal(loads, 1);
  assert.equal(fresh, 0);
  const messages = listMessages('parent');
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /Child finished; please review\./);
  assert.equal(JSON.parse(messages[0].metadata!).threadMessage.fromNodeId, 'child');
  assert.equal(messages[1].content, 'Received.');
  const durable = getDb().prepare('SELECT status FROM turns WHERE turn_id = ?').get('message-1') as { status: string };
  assert.equal(durable.status, 'completed');
});

test('a message to a busy parent queues on the same session and arrives once after the foreground completes', async () => {
  const session = await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'parent' });
  assert.ok(session);
  foregroundGate = new Promise<void>((resolve) => { releaseForeground = resolve; });
  const foreground = await hub.startTurn({ chatId: 'parent', nodeId: 'parent', turnId: 'foreground', text: 'foreground', session });
  try {
    assert.equal((await send()).status, 'queued');
    assert.deepEqual(sends, ['foreground']);
    assert.equal(loads, 1, 'reuse the live session');
    assert.equal(released, 0);
  } finally {
    releaseForeground!();
    await foreground.done;
  }
  await (await started[0]).done;
  assert.equal(sends.length, 2);
  assert.match(sends[1], /Child finished; please review\./);
  assert.equal(asked, 0);
});

test('cloud recovery and messaging still reject a different account and allow the actual owner', async (t) => {
  process.env.MICHI_CLOUD = '1';
  configureRuntimeDeps({ dataDir: directory, historyStore: { getNode, listMessages, getWorkspace, getWorkspaceInstructions },
    agentConfig: { getAgentConfig, resolveModel, resolveReasoning } });
  t.after(() => __resetRuntimeDeps());
  const denied = await manager.ensureParentSession({ ownerUserId: 'other-account', workspaceId: 'ws', nodeId: 'parent' });
  assert.equal(denied, null);
  const result = await sendToThreadTool({ ...caller, ownerUserId: 'other-account' }, { nodeId: 'parent', text: 'hi' }, approve, deps);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^NOT_FOUND/);
  assert.equal(loads, 0);
  assert.equal(fresh, 0);
  const owned = await manager.ensureParentSession({ ownerUserId: 'old-account', workspaceId: 'ws', nodeId: 'parent' });
  assert.ok(owned);
  assert.equal(loads, 1);
});

test('parent recovery cannot replace a session while runtime cleanup still owns its turn', async (t) => {
  t.mock.method(chatHub, 'isActive', () => false);
  t.mock.method(chatHub, 'isOwnerTurnActive', () => true);
  await assert.rejects(manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'parent' }),
    (error: unknown) => error instanceof Error && (error as any).cause?.message === 'Cannot reload an active parent turn');
  assert.equal(loads, 0);
  assert.equal(fresh, 0);
  assert.equal(getNode('parent')!.acp_session_id, 'native-parent');
});

test('Pi forwards optional approval and delivers routine coordination without an approval callback', async () => {
  // Use the production-configured dependency path, as the Pi adapter does.
  const { configureThreadMessaging } = await import('../src/agents/threadMessageTool');
  configureThreadMessaging(deps);
  configureRuntimeDeps({
    dataDir: directory,
    historyStore: {
      getNode: () => null, listMessages: () => [], getWorkspace: () => null,
      getWorkspaceInstructions: () => null,
    },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'pi', provider: 'test', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => 'test-model', resolveReasoning: () => undefined,
    },
  });
  try {
    const Type = new Proxy({}, { get: () => (..._args: unknown[]) => ({}) });
    const tool = buildPiTools({ bridge: {} as never, cwd: directory, parentChatId: 'child', workspaceId: 'ws',
      enableFollowUps: false, imageQuota: { usedBytes: 0, limitBytes: 1 } as never, seenPaths: new Set(), Type,
      owner: chatOwner('child'),
    }).find((candidate: any) => candidate.name === 'send_to_thread');
    assert.ok(tool);
    const sent = await tool.execute('send', { nodeId: 'parent', text: 'Pi report' });
    assert.equal(JSON.parse(sent.content[0].text).status, 'started');
    const blocked = await tool.execute('review', { nodeId: 'parent', text: 'Pi report', requestApproval: true });
    assert.match(blocked.content[0].text, /^APPROVAL_UNAVAILABLE/);
    assert.equal(started.length, 1);
    const both = await tool.execute('both', { nodeId: 'parent', text: 'Pi report', wait: true, wake: true });
    assert.match(both.content[0].text, /^INVALID_ARGUMENT: wait and wake cannot both be set/);
    const waited = await tool.execute('wait', { nodeId: 'parent', text: 'Pi question', wait: true, timeoutMs: 10_000 });
    assert.deepEqual(JSON.parse(waited.content[0].text).reply, { text: 'Received.', truncated: false });
  } finally {
    configureThreadMessaging(null);
    __resetRuntimeDeps();
  }
});

test('wait: the parent\'s reply to this message comes back in the same call', async () => {
  const payload = await send({ wait: true, timeoutMs: 10_000 });
  assert.equal(payload.status, 'replied');
  assert.equal(payload.outcome, 'completed');
  assert.deepEqual(payload.reply, { text: 'Received.', truncated: false });
  assert.equal(payload.executionRef.turnId, 'message-1');
  assert.equal(asked, 0);
});

test('wake: the parent\'s reply becomes a turn in the child, queued behind the child\'s running turn', async () => {
  bindChild();
  const childSession = await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'child' });
  assert.ok(childSession);
  // The child's turn that sends the message is still running when the parent answers.
  foregroundGate = new Promise<void>((resolve) => { releaseForeground = resolve; });
  const childTurn = await hub.startTurn({ chatId: 'child', nodeId: 'child', turnId: 'child-turn', text: 'foreground', session: childSession });
  let payload: Record<string, any>;
  try {
    payload = await send({ wake: true });
    assert.equal(payload.status, 'started');
    assert.equal(payload.wake, 'pending');
    await (await started[0]).done;
    await until(() => getThreadWake(payload.turnId)?.state === 'delivering', 'the reply claimed');
    await until(() => hub.hasPendingSelfTurn('child'), 'the reply queued in the child');
    assert.equal(getThreadWake(payload.turnId)?.callerTurnId, 'child-turn');
    // A user send now gets 409 turn_active, as for any queued self-turn (routes/michi.ts).
    assert.equal(hub.hasPendingSelfTurn('child'), true);
    assert.equal(sends.length, 2, 'the child has not been sent the reply yet');
  } finally {
    releaseForeground!();
    await childTurn.done;
  }
  await until(() => getThreadWake(payload.turnId)?.state === 'delivered', 'the reply turn began');
  await (await started[1]).done;
  assert.equal(sends[0], 'foreground');
  assert.match(sends[1], /Child finished; please review\./);
  assert.match(sends[2], /^\[Thread reply\] From "Untitled thread" \(nodeId parent\)/);
  const replyTurn = getDb().prepare('SELECT node_id, status FROM turns WHERE turn_id = ?').get(threadReplyTurnId(payload.turnId)) as
    { node_id: string; status: string };
  assert.deepEqual({ ...replyTurn }, { node_id: 'child', status: 'completed' });
  const childMessages = listMessages('child');
  assert.deepEqual(childMessages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  const reply = childMessages[2];
  assert.equal(threadMessageBody(reply.content), 'Received.');
  assert.deepEqual(JSON.parse(reply.metadata!).threadMessage, { fromNodeId: 'parent', fromTitle: 'Untitled thread', kind: 'reply', hop: 2 });
  assert.equal(asked, 0);
});

test('a Stop of the parent\'s turn for the message wakes nobody in the child', async () => {
  bindChild();
  await childPersonTurn();
  messageGate = new Promise<void>((resolve) => { releaseMessage = resolve; });
  const payload = await send({ wake: true });
  assert.equal(payload.status, 'started');
  // The user stops the parent while it answers (POST /chats/:id/cancel).
  assert.equal(hub.cancel('parent', payload.turnId), true);
  assert.equal(getThreadWake(payload.turnId)?.detail, 'target_cancelled');
  releaseMessage!();
  await (await started[0]).done;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const target = getDb().prepare('SELECT status FROM turns WHERE turn_id = ?').get(payload.turnId) as { status: string };
  assert.equal(target.status, 'cancelled');
  assert.equal(getThreadWake(payload.turnId)?.state, 'undeliverable');
  assert.equal(getDb().prepare('SELECT 1 FROM turns WHERE turn_id = ?').get(threadReplyTurnId(payload.turnId)), undefined, 'no reply turn');
  assert.equal(sends.some((text) => text.startsWith('[Thread reply]')), false);
});

test('a Stop of the child\'s running turn withdraws the reply queued behind it', async () => {
  bindChild();
  const childSession = await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'child' });
  assert.ok(childSession);
  foregroundGate = new Promise<void>((resolve) => { releaseForeground = resolve; });
  const childTurn = await hub.startTurn({ chatId: 'child', nodeId: 'child', turnId: 'child-turn', text: 'foreground', session: childSession });
  const payload = await send({ wake: true });
  await (await started[0]).done;
  await until(() => getThreadWake(payload.turnId)?.state === 'delivering' && hub.hasPendingSelfTurn('child'), 'the reply queued in the child');
  // The user stops the child's turn, the one that asked for the wake.
  assert.equal(hub.cancel('child', 'child-turn'), true);
  assert.equal(getThreadWake(payload.turnId)?.detail, 'caller_cancelled');
  releaseForeground!();
  await childTurn.done;
  await assert.rejects(started[1], /withdrawn before it started/);
  await until(() => !hub.hasPendingSelfTurn('child'), 'the child free again');
  assert.equal(getThreadWake(payload.turnId)?.state, 'undeliverable');
  assert.equal(getDb().prepare('SELECT 1 FROM turns WHERE turn_id = ?').get(threadReplyTurnId(payload.turnId)), undefined, 'no reply turn');
  assert.deepEqual(listMessages('child').map((message) => message.role), ['user', 'assistant'], 'only the stopped turn');
  assert.equal(sends.some((text) => text.startsWith('[Thread reply]')), false);
});

test('after a restart, a wake whose reply turn already began is settled without sending the reply again', async () => {
  bindChild();
  await childPersonTurn();
  const payload = await send({ wake: true });
  await (await started[0]).done;
  await until(() => getThreadWake(payload.turnId)?.state === 'delivered', 'delivery');
  await (await started[1]).done;
  const sent = sends.length;
  const childMessages = listMessages('child').length;
  // A crash between the reply turn's begin and its record's update.
  getDb().prepare("UPDATE thread_message_wakes SET state = 'delivering', delivered_at = NULL WHERE target_turn_id = ?").run(payload.turnId);

  // The next process: new hub, manager and sessions.
  clearAllSessions();
  hub = new ChatHub({ retentionMs: 10, titleGenerator: null });
  manager = new ChatManager(undefined, directory);
  const restarted: ThreadMessagingDeps = {
    ...deps,
    ensureSession: (input) => manager.ensureParentSession(input),
    startTurn: (args) => { const start = hub.startRequestedSelfTurn(args); started.push(start); return start; },
  };
  assert.deepEqual(await recoverThreadMessageWakes(restarted), { delivered: 1, undeliverable: 0, open: 0, failed: 0 });
  assert.equal(getThreadWake(payload.turnId)?.state, 'delivered');
  // Even a direct retry with the derived turn id returns that turn: ChatHub's own idempotency.
  const session = await manager.ensureParentSession({ ownerUserId: 'local-user', workspaceId: 'ws', nodeId: 'child' });
  const retry = await restarted.startTurn({
    chatId: 'child', nodeId: 'child', turnId: threadReplyTurnId(payload.turnId), text: 'again', displayText: 'again', session: session!,
  });
  assert.equal(retry.existing, true);
  assert.equal(sends.length, sent, 'the reply is not sent again');
  assert.equal(listMessages('child').length, childMessages);
});
