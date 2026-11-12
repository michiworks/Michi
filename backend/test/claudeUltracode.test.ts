/**
 * Claude Ultracode for a chat: standing multi-agent orchestration, where the
 * model runs a Workflow for every substantive task.
 *
 * Probe-backed (benchmarks/claude-ultracode/2026-11-05, CLI 2.1.318, SDK
 * 0.3.306): `settings: { ultracode }` at spawn and Query.applyFlagSettings
 * set it; get_settings `applied` says whether it took effect; a resumed
 * process starts without it; an explicit false overrides a settings file.
 *
 * Also the approvals a workflow's agents ask while the chat is idle: they go
 * to the running workflow through the SDK's canUseTool callback, and follow
 * the chat's current permission mode.
 */
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { michiTestHost } from './helpers/michiTestHost';
import { runOwner } from './helpers/owners';
import {
  newScriptedSession, restoreClaudeSpawn, runningScriptedTurn, scriptedChildren, startScriptedTurn, stubClaudeSpawn, until,
} from './helpers/claudeScriptedChild';

const transportModule = require('michi-runtime/internal/adapters/claude/claudeSdkTransport');
const fixtureTransport = transportModule.createClaudeSdkTransport;
const policy = require('../src/agents/permissionPolicy');
const originalResolveChatPolicy = policy.resolveChatPolicy;
const originalChatPermissionMode = policy.chatPermissionMode;

/** The chats (owner keys) whose Ultracode choice is on. */
let wanted: Set<string>;
/** The SDK controls of each spawned process: what was applied, what get_settings reports. */
let cli: {
  available: boolean;
  failNextApply: boolean;
  /** The next change waits until the test settles it (cli.pendingApply). */
  holdNextApply?: boolean;
  pendingApply?: { resolve: () => void; reject: (error: Error) => void } | null;
  applyDelayMs?: number;
  /** Runs while the process starts, before the session has its transport. */
  duringSpawn?: () => void;
  applied: Array<{ ultracode: unknown; promptsBefore: number }>;
  report: Record<string, unknown>;
  /** The transport's error callback, as the SDK output ending would call it. */
  onError?: (error: Error) => void;
};

function host() {
  const base = michiTestHost();
  return { ...base, config: { ...base.config, features: { ...base.config.features,
    ultracode: (owner: { key?: string } | undefined) => wanted.has(owner?.key ?? '') } } };
}

async function session(overrides: Record<string, unknown> = {}, beforeSpawn?: (session: any) => Promise<void>) {
  return newScriptedSession({ options: claudeTestOptions({ host: host() as any }), ...overrides }, beforeSpawn);
}

function ultracodeOf(scripted: { session: any }) {
  return scripted.session.getSessionState().ultracode;
}

function prompts(child: { lines: Array<Record<string, any>> }) {
  return child.lines.filter((line) => line.type === 'user').length;
}

describe('Claude Ultracode', () => {
  beforeEach(() => {
    stubClaudeSpawn();
    wanted = new Set();
    cli = { available: true, failNextApply: false, applied: [], report: {} };
    // The fixture's SDK query, plus the flag-settings controls the CLI answers.
    transportModule.createClaudeSdkTransport = async (args: any) => {
      const transport = await fixtureTransport(args);
      const child = scriptedChildren.at(-1)!;
      cli.report = { ultracode: args.ultracode === true && cli.available, ultracodeRequested: args.ultracode === true, ultracodeAvailable: cli.available };
      cli.onError = args.onError;
      cli.duringSpawn?.();
      Object.assign(transport.query, {
        applyFlagSettings: async (settings: { ultracode?: boolean }) => {
          if (cli.failNextApply) { cli.failNextApply = false; throw new Error('simulated control failure'); }
          if (cli.holdNextApply) {
            cli.holdNextApply = false;
            await new Promise<void>((resolve, reject) => { cli.pendingApply = { resolve, reject }; });
          }
          if (cli.applyDelayMs) await new Promise((resolve) => setTimeout(resolve, cli.applyDelayMs));
          cli.applied.push({ ultracode: settings.ultracode, promptsBefore: prompts(child) });
          cli.report = { ...cli.report, ultracode: settings.ultracode === true && cli.available, ultracodeRequested: settings.ultracode === true };
        },
        // Every settings source comes back too; the session must read only `applied`.
        getSettings: async () => ({ applied: { ...cli.report }, sources: { flagSettings: { env: { ANTHROPIC_API_KEY: 'sk-never-logged' } } } }),
      });
      return transport;
    };
  });
  afterEach(() => {
    transportModule.createClaudeSdkTransport = fixtureTransport;
    policy.resolveChatPolicy = originalResolveChatPolicy;
    policy.chatPermissionMode = originalChatPermissionMode;
    restoreClaudeSpawn();
    mock.restoreAll();
  });

  test('a chat spawns with its choice, off sent explicitly, and reports what the CLI says took effect', async () => {
    const off = await session();
    try {
      assert.equal((off.child as any).spawnArgs.ultracode, false, 'off is sent, so a settings file cannot turn it on');
      await until(() => ultracodeOf(off)?.active !== undefined, 'the CLI report');
      assert.deepEqual(ultracodeOf(off), { requested: false, active: false, available: true });
    } finally { await off.session.dispose(); }
    wanted.add('node-steer');
    const on = await session();
    try {
      assert.equal((on.child as any).spawnArgs.ultracode, true);
      await until(() => ultracodeOf(on)?.active !== undefined, 'the CLI report');
      assert.deepEqual(ultracodeOf(on), { requested: true, active: true, available: true });
      assert.deepEqual(cli.applied, [], 'the spawn carried it: no control needed');
    } finally { await on.session.dispose(); }
  });

  test('the session state says when this model or setup cannot run it', async () => {
    wanted.add('node-steer');
    cli.available = false;
    const unavailable = await session();
    try {
      await until(() => ultracodeOf(unavailable)?.available !== undefined, 'the CLI report');
      assert.deepEqual(ultracodeOf(unavailable), { requested: true, active: false, available: false });
    } finally { await unavailable.session.dispose(); }
    // --bare skips the reminders Ultracode works through: the CLI's "available" is not enough.
    cli.available = true;
    const base = claudeTestOptions({ host: host() as any });
    const bare = await newScriptedSession({ options: { ...base, cli: () => ({ ...base.cli(), bare: true }) } });
    try {
      assert.equal((bare.child as any).spawnArgs.bare, true);
      await until(() => ultracodeOf(bare)?.available !== undefined, 'the CLI report');
      assert.deepEqual(ultracodeOf(bare), { requested: true, active: false, available: false });
    } finally { await bare.session.dispose(); }
  });

  test('a model switch re-reads whether the new model can run it', async () => {
    wanted.add('node-steer');
    const scripted = await session();
    try {
      await until(() => ultracodeOf(scripted)?.available === true, 'the CLI report');
      // The CLI gates Ultracode on xhigh effort: an older model cannot run it.
      cli.report = { ...cli.report, ultracode: false, ultracodeAvailable: false };
      await scripted.session.setModel('claude-sonnet-4-6');
      await until(() => ultracodeOf(scripted)?.available === false, 'the report after the switch');
      assert.deepEqual(ultracodeOf(scripted), { requested: true, active: false, available: false });
      assert.deepEqual(cli.applied, [], 'the choice stays; the model decides whether it runs');
    } finally { await scripted.session.dispose(); }
  });

  test("only an ordinary chat runs it: a custom agent's chat and an Agent Run pin it off and report none", async () => {
    wanted.add('node-steer');
    const custom = await session({ toolProfile: { allowedToolNames: ['read', 'bash'] } });
    try {
      assert.equal((custom.child as any).spawnArgs.ultracode, false);
      assert.equal(ultracodeOf(custom), undefined);
      await assert.rejects(custom.session.setUltracode(true), /only in Claude chats/);
      await custom.session.setUltracode(false);
      assert.deepEqual(cli.applied, []);
    } finally { await custom.session.dispose(); }
    const owner = runOwner('run-1', 'attempt-1');
    wanted.add(owner.key);
    const run = await session({ owner });
    try {
      assert.equal((run.child as any).spawnArgs.ultracode, false);
      assert.equal(ultracodeOf(run), undefined);
    } finally { await run.session.dispose(); }
  });

  test('a turn after the choice changed applies it before the prompt is written, once', async () => {
    const scripted = await session();
    const { session: chat, child } = scripted;
    try {
      wanted.add('node-steer');
      const turn = await runningScriptedTurn(chat, child);
      assert.deepEqual(cli.applied, [{ ultracode: true, promptsBefore: 0 }]);
      child.result();
      await turn.done;
      // The report is read after the change, without holding the prompt.
      await until(() => ultracodeOf(scripted)?.active === true, 'the report after the change');
      assert.deepEqual(ultracodeOf(scripted), { requested: true, active: true, available: true });
      const next = (async () => { for await (const _event of chat.send('second')) { /* drain */ } })();
      await until(() => prompts(child) === 2, 'the second prompt');
      child.result();
      await next;
      assert.equal(cli.applied.length, 1, 'no change, no control');
    } finally { await chat.dispose(); }
  });

  test('a change that fails is logged without its settings, the turn runs, and the next turn tries again', async () => {
    const warnings: unknown[][] = [];
    mock.method(require('../src/services/logger').log, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const { session: chat, child } = await session();
    try {
      wanted.add('node-steer');
      cli.failNextApply = true;
      const turn = await runningScriptedTurn(chat, child);
      assert.deepEqual(cli.applied, []);
      child.result();
      await turn.done;
      assert.ok(warnings.some((args) => /ultracode could not be applied/.test(String(args[1]))));
      assert.doesNotMatch(JSON.stringify(warnings), /sk-never-logged/);
      const next = (async () => { for await (const _event of chat.send('second')) { /* drain */ } })();
      await until(() => prompts(child) === 2, 'the second prompt');
      child.result();
      await next;
      assert.deepEqual(cli.applied, [{ ultracode: true, promptsBefore: 1 }]);
    } finally { await chat.dispose(); }
  });

  test('a CLI that dies while a turn applies the change is restored in that turn, not left without a process', async () => {
    const { session: chat, child } = await session();
    try {
      const first = await runningScriptedTurn(chat, child);
      child.result();
      await first.done;
      wanted.add('node-steer');
      cli.holdNextApply = true;
      const turn = startScriptedTurn(chat, 'second');
      await until(() => !!cli.pendingApply, 'the change in flight');
      // The SDK sees the output end: it rejects the pending control, and the transport reports it.
      cli.pendingApply!.reject(new Error('Claude Code process exited'));
      cli.pendingApply = null;
      cli.onError!(new Error('Claude SDK output ended. Original session retained.'));
      setTimeout(() => child.emit('exit', 1, null), 5);
      await until(() => scriptedChildren.length === 2, 'the restored process');
      const restored = scriptedChildren[1];
      assert.equal((restored as any).spawnArgs.resumeSessionId, 'ext-steer-1');
      assert.equal((restored as any).spawnArgs.ultracode, true, 'the restored process takes the choice at spawn');
      await until(() => prompts(restored) === 1, 'the prompt on the restored process');
      restored.init();
      restored.result();
      await turn.done;
      const end = turn.events.filter((event): event is Extract<NormalizedEvent, { kind: 'turn_end' }> => event.kind === 'turn_end').at(-1);
      assert.equal(end?.stopReason, 'end_turn', JSON.stringify(turn.events.map((event) => event.kind)));
      assert.ok(turn.events.some((event) => event.kind === 'retry_start'), 'the turn says it restores the session');
      assert.equal(chat.getState(), 'idle');
      assert.ok((chat as any).transport, 'a live process, not a session that only looks live');
      assert.equal(prompts(child), 1, 'nothing more was written to the dead process');
    } finally { await chat.dispose(); }
  });

  test('a turn waits for a change still in flight, then corrects it before the prompt', async () => {
    const { session: chat, child } = await session();
    try {
      cli.applyDelayMs = 30;
      wanted.add('node-steer');
      const toggling = chat.setUltracode(true);
      // Switched back off before that change landed.
      wanted.delete('node-steer');
      const turn = await runningScriptedTurn(chat, child);
      assert.deepEqual(cli.applied, [{ ultracode: true, promptsBefore: 0 }, { ultracode: false, promptsBefore: 0 }]);
      child.result();
      await turn.done;
      await toggling;
    } finally { await chat.dispose(); }
  });

  test('a choice changed while the process starts is applied once it is up', async () => {
    let starting: any;
    cli.duringSpawn = () => { wanted.add('node-steer'); void starting.setUltracode(true); };
    const scripted = await session({}, async (created) => { starting = created; });
    cli.duringSpawn = undefined;
    try {
      assert.equal((scripted.child as any).spawnArgs.ultracode, false, 'read before the change');
      await until(() => cli.applied.length === 1, 'the change once the process is up');
      assert.deepEqual(cli.applied, [{ ultracode: true, promptsBefore: 0 }]);
      await until(() => ultracodeOf(scripted)?.active === true, 'the report');
    } finally { await scripted.session.dispose(); }
  });

  test('setUltracode applies to the idle live process at once and notifies state listeners', async () => {
    const scripted = await session();
    const { session: chat } = scripted;
    const seen: unknown[] = [];
    chat.onSessionState(() => seen.push(chat.getSessionState().ultracode));
    try {
      wanted.add('node-steer');
      await chat.setUltracode(true);
      assert.deepEqual(cli.applied, [{ ultracode: true, promptsBefore: 0 }]);
      assert.deepEqual(seen.at(-1), { requested: true, active: true, available: true });
      assert.ok(seen.some((state: any) => state.requested === true), 'the choice is published before the CLI confirms it');
      await chat.setUltracode(true);
      assert.equal(cli.applied.length, 1, 'already on');
      wanted.delete('node-steer');
      await chat.setUltracode(false);
      assert.deepEqual(cli.applied.at(-1), { ultracode: false, promptsBefore: 0 });
      assert.deepEqual(ultracodeOf(scripted), { requested: false, active: false, available: true });
    } finally { await chat.dispose(); }
  });

  test("a warm process takes the chat's choice when it is handed to the chat", async () => {
    wanted.add('node-chat');
    const { session: warm, child } = await session({ mcpRegistry: {
      create: () => ({ slotId: 'slot-1', workspaceId: null }), get: () => undefined, dispose: async () => {},
      endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }),
    } });
    try {
      assert.equal((child as any).spawnArgs.ultracode, false, 'spawned before it knew the chat');
      warm.rebindIdentity('node-chat', 'node-chat', { owner: { mode: 'interactive', key: 'node-chat' } as any });
      await until(() => cli.applied.length === 1, 'the handoff applying it');
      assert.deepEqual(cli.applied, [{ ultracode: true, promptsBefore: 0 }]);
    } finally { await warm.dispose(); }
  });

  test("an idle workflow agent's approval goes to the running workflow, not to a chat self-turn", async () => {
    policy.resolveChatPolicy = () => 'ask';
    // A workflow run is tracked for a chat of a workspace.
    const { session: chat, child } = await session({ workspaceId: 'ws-ultracode' });
    const queue = (chat as any).queue;
    const pushed: string[] = [];
    const push = queue.push.bind(queue);
    queue.push = (event: NormalizedEvent) => { pushed.push(event.kind); return push(event); };
    const tap = (chat as any).workflowTap;
    try {
      tap.observe({ type: 'system', subtype: 'task_started', task_id: 'wf-1', tool_use_id: 'toolu_wf', task_type: 'local_workflow', workflow_name: 'audit' });
      // As the CLI asks: the SDK canUseTool callback, not makeOnApprove directly.
      const approval = (child as any).spawnArgs.authorize('Bash', { command: 'ls' }, 'tool-agent', new AbortController().signal);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(pushed, [], 'no self-turn holds the chat');
      assert.equal((chat as any).turnAbort, null);
      tap.answerCovered(() => true, 'allow_once');
      assert.equal((await approval).behavior, 'allow');
    } finally { await chat.dispose(); }
  });

  test('an approval settled by policy between turns leaves no self-turn behind for the next one', async () => {
    let decision = 'allow';
    policy.resolveChatPolicy = () => decision;
    const { session: chat, child } = await session({ workspaceId: 'ws-ultracode' });
    const tap = (chat as any).workflowTap;
    try {
      const allowed = await (child as any).spawnArgs.authorize('Bash', { command: 'ls' }, 'tool-bg', new AbortController().signal);
      assert.equal(allowed.behavior, 'allow');
      assert.equal((chat as any).turnAbort, null, 'no idle controller left over');
      decision = 'ask';
      tap.observe({ type: 'system', subtype: 'task_started', task_id: 'wf-2', tool_use_id: 'toolu_wf2', task_type: 'local_workflow', workflow_name: 'later' });
      const asked = (child as any).spawnArgs.authorize('Bash', { command: 'pwd' }, 'tool-agent', new AbortController().signal);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((chat as any).pendingPermissions.size, 0, 'the workflow carries it');
      tap.answerCovered(() => true, 'reject_once');
      assert.equal((await asked).behavior, 'deny');
    } finally { await chat.dispose(); }
  });

  test("a turn decides under its own mode; between turns a workflow agent follows the chat's current mode", async () => {
    let mode = 'trust';
    policy.chatPermissionMode = () => mode;
    const decided: unknown[] = [];
    policy.resolveChatPolicy = (_owner: unknown, _user: unknown, _tool: unknown, _native: unknown, turnMode: unknown) => {
      decided.push(turnMode);
      return 'allow';
    };
    const { session: chat, child } = await session();
    try {
      const turn = await runningScriptedTurn(chat, child);
      mode = 'ask';
      await (child as any).spawnArgs.authorize('Bash', { command: 'ls' }, 'tool-turn', new AbortController().signal);
      child.result();
      await turn.done;
      await (child as any).spawnArgs.authorize('Bash', { command: 'ls' }, 'tool-idle', new AbortController().signal);
      assert.deepEqual(decided, ['trust', undefined], 'the turn keeps the mode it started with; idle work reads the current one');
    } finally { await chat.dispose(); }
  });
});
