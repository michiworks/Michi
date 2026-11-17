/**
 * Idle release of Claude chat sessions (ClaudeRuntime.idleRelease): what
 * keeps a chat's CLI, and the host's sweep releasing one that the next
 * message resumes natively.
 */
import { untilSpawned } from './helpers/claudeSdkFixture';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { IdleReleaseVerdict } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, getSession, peekLiveSession } from '../src/agents/sessionRegistry';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace, updateNodeResumeBinding } from '../src/services/dbRepository';
import { ChatManager } from '../src/services/chatManager';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { runOwner } from './helpers/owners';

// No title CLI beside the fixture processes.
process.env.MICHI_TITLE_MODEL_CLAUDE = 'off';

const TTL = 60_000;

class MockClaudeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(signal?: string): boolean {
    this.killed = true;
    process.nextTick(() => this.emit('exit', signal === 'SIGKILL' ? 137 : 0, null));
    return true;
  }

  send(envelope: object): void {
    this.stdout.push(JSON.stringify(envelope) + '\n');
  }
}

let tmpDir: string;
let children: MockClaudeChild[];
let spawnArgs: Array<{ resumeSessionId?: string }>;

function useDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-claude-idle-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  closeDb();
  initDb();
}

function dropDb(): void {
  clearAllSessions();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('ClaudeRuntime idle release', () => {
  let ClaudeRuntime: typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
  let restore: () => void;

  beforeEach(() => {
    useDb();
    children = [];
    spawnArgs = [];
    const binary = require('michi-runtime/internal/adapters/claude/claudeBinary');
    const { spawnClaude, preflightClaudeAuth } = binary;
    binary.preflightClaudeAuth = () => {};
    binary.spawnClaude = (args: { resumeSessionId?: string }) => {
      spawnArgs.push(args);
      const child = new MockClaudeChild();
      children.push(child);
      return child;
    };
    restore = () => { binary.spawnClaude = spawnClaude; binary.preflightClaudeAuth = preflightClaudeAuth; };
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSessionManager')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    ClaudeRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
    // A chat's native identity is recorded on its node at the first turn.
    saveWorkspace({ id: 'ws-1', name: 'One', cwd: tmpDir, created_at: 1, updated_at: 1 });
    for (const id of ['n-1', 'n-fork']) {
      saveNode({ id, workspace_id: 'ws-1', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1, runtime_id: 'claude' });
    }
  });

  afterEach(() => {
    restore();
    mock.restoreAll();
    require('../src/services/agentConfig').agentConfigEvents.removeAllListeners('model_changed');
    dropDb();
  });

  function runtime(sessionIdleTtlMs = TTL) {
    const options = claudeTestOptions();
    return new ClaudeRuntime({
      ...options,
      limits: { ...options.limits, sessionIdleTtlMs, pool: { ...options.limits.pool, disabled: true } },
      bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any,
      mcpSlots: {
        create: (_parent: string, _cwd: string, _owner: string | null) => ({ slotId: `slot-${Math.random()}` }),
        dispose: async () => {},
        endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }),
        rebind: () => {},
      } as any,
    });
  }

  /** One turn: init with the session's native id (or a new one), then a result. */
  async function turn(session: any, child: MockClaudeChild, sessionId = session.nativeSessionId ?? 'ext-fresh'): Promise<void> {
    const sent = (async () => { for await (const _event of session.send('hello')) void _event; })();
    await tick();
    child.send({ type: 'system', subtype: 'init', session_id: sessionId });
    child.send({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    await sent;
  }

  const verdict = (rt: InstanceType<typeof ClaudeRuntime>, session: any, afterIdleMs: number): IdleReleaseVerdict =>
    rt.idleRelease(session.id, session.getIdleSince() + afterIdleMs);

  test('releases an idle chat once nothing has used it for the TTL; a lookup or a turn restarts the clock', async () => {
    const rt = runtime();
    try {
      const session: any = await rt.newSession({ sessionId: 'n-1', cwd: tmpDir });
      assert.deepEqual(verdict(rt, session, TTL - 1), { action: 'keep', reason: 'recent' });
      assert.deepEqual(verdict(rt, session, TTL), { action: 'release' });

      const before = session.getIdleSince();
      await tick();
      assert.equal(getSession('n-1'), session);
      assert.ok(session.getIdleSince() > before, 'a session directory lookup touches it');
      assert.deepEqual(rt.idleRelease('n-1', before + TTL), { action: 'keep', reason: 'recent' });

      const turnStarted = (async () => { for await (const _event of session.send('hello')) void _event; })();
      await tick();
      assert.deepEqual(verdict(rt, session, TTL * 100), { action: 'keep', reason: 'in_turn' });
      children[0].send({ type: 'system', subtype: 'init', session_id: 'ext-n-1' });
      children[0].send({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
      await turnStarted;
      assert.deepEqual(verdict(rt, session, TTL), { action: 'release' });
    } finally {
      await rt.shutdown();
    }
  });

  test('keeps a chat while a question or approval waits or a steer is queued, between turns too', async () => {
    const rt = runtime();
    try {
      const session: any = await rt.newSession({ sessionId: 'n-1', cwd: tmpDir });
      const timer = setTimeout(() => {}, 0);
      session.pendingUserInputs.set(1, { resolve() {}, timer });
      assert.deepEqual(verdict(rt, session, TTL * 100), { action: 'keep', reason: 'pending_interaction' });
      session.pendingUserInputs.clear();
      session.pendingPermissions.set(2, { resolve() {}, timer });
      assert.deepEqual(verdict(rt, session, TTL * 100), { action: 'keep', reason: 'pending_interaction' });
      session.pendingPermissions.clear();
      session.pendingSteers.add('steer-1');
      assert.deepEqual(verdict(rt, session, TTL * 100), { action: 'keep', reason: 'steer' });
      session.pendingSteers.clear();
      // Background work that asks between turns claims a turn controller first.
      session.turnAbort = new AbortController();
      assert.deepEqual(verdict(rt, session, TTL * 100), { action: 'keep', reason: 'busy' });
      session.turnAbort = null;
      assert.deepEqual(verdict(rt, session, TTL), { action: 'release' });
    } finally {
      await rt.shutdown();
    }
  });

  test('keeps a chat while its CLI runs a background shell or a workflow; the CLI\'s ambient tasks do not count', async () => {
    const rt = runtime();
    try {
      const session: any = await rt.newSession({ sessionId: 'n-1', cwd: tmpDir });
      const child = children[0];
      child.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [
        { task_id: 'b1', task_type: 'local_bash', description: 'npm test' },
        { task_id: 'd1', task_type: 'dream', description: 'dream', ambient: true },
      ] });
      await tick();
      assert.equal(session.hasBackgroundWork(), true, 'a background shell is background work (cap reclaim too)');
      assert.deepEqual(verdict(rt, session, TTL * 100), { action: 'keep', reason: 'background_work' });

      child.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [
        { task_id: 'd1', task_type: 'dream', description: 'dream', ambient: true },
      ] });
      await tick();
      assert.equal(session.hasBackgroundWork(), false);
      const ended = session.getIdleSince();
      assert.ok(ended >= session.getLastUsedAt(), 'the shell ending restarts the clock, for the turn that reports it');
      assert.deepEqual(rt.idleRelease('n-1', ended + TTL - 1), { action: 'keep', reason: 'recent' });
      assert.deepEqual(rt.idleRelease('n-1', ended + TTL), { action: 'release' });
      await tick();
      child.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [
        { task_id: 'd2', task_type: 'dream', description: 'dream', ambient: true },
      ] });
      await tick();
      assert.equal(session.getIdleSince(), ended, 'ambient tasks coming and going leave the clock alone');

      child.send({ type: 'system', subtype: 'task_started', task_id: 'wf-1', tool_use_id: 'toolu_wf', task_type: 'local_workflow', workflow_name: 'probe' });
      await tick();
      assert.deepEqual(verdict(rt, session, TTL * 100), { action: 'keep', reason: 'background_work' });
    } finally {
      await rt.shutdown();
    }
  });

  test('leaves Agent Runs, check-in sessions, a native fork before its first turn and a disabled TTL alone', async () => {
    const rt = runtime();
    try {
      const run: any = await rt.newSession({ sessionId: 'attempt-1', owner: runOwner('run-1', 'attempt-1'), cwd: tmpDir });
      assert.deepEqual(verdict(rt, run, TTL * 100), { action: 'keep', reason: 'not_chat' });
      const checkin: any = await rt.newSession({ sessionId: 'n-checkin', cwd: tmpDir, ephemeral: true });
      assert.deepEqual(verdict(rt, checkin, TTL * 100), { action: 'keep', reason: 'ephemeral' });

      // The child's transcript is written with its first turn: until then it resumes nothing.
      const fork: any = await (rt as any).manager.createSession({ id: 'n-fork', cwd: tmpDir, forkFromNativeSessionId: 'native-parent' });
      assert.deepEqual(verdict(rt, fork, TTL * 100), { action: 'keep', reason: 'fork_unstarted' });
      await turn(fork, children.at(-1)!);
      assert.deepEqual(verdict(rt, fork, TTL), { action: 'release' });
    } finally {
      await rt.shutdown();
    }
    const off = runtime(0);
    try {
      const session: any = await off.newSession({ sessionId: 'n-off', cwd: tmpDir });
      assert.deepEqual(verdict(off, session, TTL * 100), { action: 'keep', reason: 'disabled' });
    } finally {
      await off.shutdown();
    }
  });

  test('the host sweep releases an idle chat\'s CLI, never one running a background shell, and the next message resumes it natively', async () => {
    updateNodeResumeBinding('n-1', { acp_session_id: 'ext-1', runtime_id: 'claude', runtime_engine: null });
    mock.method(require('michi-runtime/internal/adapters/claude/claudeProjectsPath'), 'claudeTranscriptFindable', async () => true);
    const rt = runtime();
    registerRuntime(rt);
    const manager = new ChatManager(undefined, tmpDir);
    try {
      const restored: any = await rt.loadSession({ sessionId: 'n-1', nodeId: 'n-1', cwd: tmpDir, workspaceId: 'ws-1' } as any);
      assert.equal(spawnArgs[0].resumeSessionId, 'ext-1');
      const child = children[0];
      child.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'build' }] });
      await tick();
      assert.equal(await manager.releaseIdleSessions(() => restored.getIdleSince() + TTL * 100), 0);
      assert.equal(child.killed, false);

      child.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
      await tick();
      assert.equal(await manager.releaseIdleSessions(() => restored.getIdleSince() + TTL), 1);
      assert.equal(child.killed, true, 'the CLI is gone');
      assert.equal(peekLiveSession('n-1'), undefined);

      const resumed = await manager.ensureParentSession({ ownerUserId: 'local', workspaceId: 'ws-1', nodeId: 'n-1' });
      await untilSpawned(() => spawnArgs.length === 2);
      assert.ok(resumed && resumed !== restored);
      assert.equal(spawnArgs[1].resumeSessionId, 'ext-1', 'the next message resumes the same native session');
      assert.equal(resumed!.nativeSessionId, 'ext-1');
    } finally {
      await rt.shutdown();
    }
  });
});
