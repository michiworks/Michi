/**
 * Idle release of Kiro chat sessions: what keeps a session (its turns, a
 * workflow Kiro will wake it for), how a release lets kiro-cli drop it, and
 * the host's sweep under the restore lock.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import {
  KIRO_BACKGROUND_IDLE_CAP_MS,
  KIRO_BACKGROUND_IDLE_TTL_MS,
  AcpAgentRuntime,
} from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import { createKiroWorkflowBridge } from 'michi-runtime/internal/core/workflows/kiroWorkflowBridge';
import type { AgentRuntime, AgentSession, IdleReleaseVerdict } from '../src/agents/types';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { registerRuntime } from '../src/agents/registry';
import { clearAllSessions, getSession, peekLiveSession, registerSession } from '../src/agents/sessionRegistry';
import { chatHub } from '../src/agents/chatHub';
import { WorkflowRunHub } from '../src/services/workflowRunHub';
import type { WorkflowRunStore } from '../src/services/workflowRunsRepository';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace, updateNodeResumeBinding } from '../src/services/dbRepository';
import { updateAgentConfig } from '../src/services/agentConfig';
import { acquireSessionRestoreLock } from '../src/services/nativeResume';
import { ChatManager } from '../src/services/chatManager';
import { michiTestHost } from './helpers/michiTestHost';
import { workflowSink } from './helpers/hostSinks';
import { chatOwner, runOwner } from './helpers/owners';

const bridge: AgentToolBridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const CONTEXT = { ownerUserId: 'owner-a', workspaceId: 'ws-a', owner: chatOwner('node-1') };

function memoryStore(): WorkflowRunStore {
  const rows = new Map<string, { ownerUserId: string; run: WorkflowRunDtoV1 }>();
  return {
    upsert(ownerUserId, run) { rows.set(run.id, { ownerUserId, run }); },
    get(ownerUserId, id) { const row = rows.get(id); return row && row.ownerUserId === ownerUserId ? row.run : null; },
    list(ownerUserId, workspaceId) { return [...rows.values()].filter((row) => row.ownerUserId === ownerUserId && row.run.workspaceId === workspaceId).map((row) => row.run); },
    listOpen() { return []; },
    workspaceOwnedBy() { return true; },
    workspaceOfNode() { return 'ws-a'; },
  };
}

describe('Kiro workflow bridge: runs by the session that launched them', () => {
  it('tracks open runs and their last report per parent, and stops only that parent\'s runs', async () => {
    let clock = 1_000;
    const controls: string[] = [];
    const hub = new WorkflowRunHub(memoryStore());
    const wf = createKiroWorkflowBridge({
      hub: workflowSink(hub), now: () => clock,
      resolve: (sid) => sid === 'parent-a' || sid === 'parent-b' ? CONTEXT : null,
      control: async (method, workflowId, parent) => { controls.push(`${method}:${workflowId}:${parent}`); },
    });
    wf.handle('_kiro/workflow/run_start', { workflowId: 'wf-a', workflowName: 'a', nodeTree: [{ nodeId: 'n', type: 'step' }], parentSessionId: 'parent-a' });
    clock = 2_000;
    wf.handle('_kiro/workflow/run_start', { workflowId: 'wf-b', workflowName: 'b', nodeTree: [{ nodeId: 'n', type: 'step' }], parentSessionId: 'parent-b' });
    assert.deepEqual(wf.openRunsFor('parent-a'), ['wf-a']);
    assert.deepEqual(wf.openRunsFor('parent-b'), ['wf-b']);
    assert.deepEqual(wf.openRunsFor('other'), []);
    assert.equal(wf.lastEventAt('parent-a'), 1_000);
    assert.equal(wf.lastEventAt('parent-b'), 2_000);

    // Paused is still open: Kiro wakes the parent when it finishes.
    clock = 3_000;
    wf.handle('_kiro/workflow/paused', { workflowId: 'wf-a', parentSessionId: 'parent-a' });
    assert.deepEqual(wf.openRunsFor('parent-a'), ['wf-a']);
    assert.equal(wf.lastEventAt('parent-a'), 3_000);

    await wf.stopRunsFor('parent-a');
    assert.deepEqual(controls, ['cancel:wf-a:parent-a']);

    clock = 4_000;
    wf.handle('_kiro/workflow/run_complete', { workflowId: 'wf-a', status: 'completed', parentSessionId: 'parent-a' });
    assert.deepEqual(wf.openRunsFor('parent-a'), []);
    assert.equal(wf.lastEventAt('parent-a'), 4_000, 'the end counts as activity, so the wake that follows finds its session');
  });

  it('releasing a parent takes Retry away from its finished runs and leaves open ones alone', () => {
    const hub = new WorkflowRunHub(memoryStore());
    const wf = createKiroWorkflowBridge({ hub: workflowSink(hub), resolve: () => CONTEXT, control: async () => {} });
    wf.handle('_kiro/workflow/run_start', { workflowId: 'wf-failed', workflowName: 'f', nodeTree: [{ nodeId: 'n', type: 'step' }], parentSessionId: 'p' });
    wf.handle('_kiro/workflow/run_complete', { workflowId: 'wf-failed', status: 'failed', parentSessionId: 'p' });
    wf.handle('_kiro/workflow/run_start', { workflowId: 'wf-open', workflowName: 'o', nodeTree: [{ nodeId: 'n', type: 'step' }], parentSessionId: 'p' });
    const byName = () => Object.fromEntries(hub.list('owner-a', 'ws-a').map((run) => [run.name, run]));
    assert.ok(byName().f.actions.includes('retry'), 'a failed run offers Retry while its parent is live');

    wf.releaseParent('p');
    const after = byName();
    assert.deepEqual(after.f.actions, []);
    assert.equal(after.f.status, 'failed', 'a finished run keeps its status');
    assert.ok(after.o.actions.includes('stop'), 'an open run keeps its controls');
    assert.deepEqual(wf.openRunsFor('p'), ['wf-open']);
  });
});

describe('AcpClient idle-release primitives', () => {
  function client(engine: 'v2' | 'v3', close = true) {
    const c = new AcpClient(undefined, os.tmpdir(), undefined, engine);
    const sent: Array<{ method: string; params: unknown }> = [];
    (c as any).proc = {};
    (c as any).initialization = { agentCapabilities: { sessionCapabilities: close ? { close: {} } : {} } };
    (c as any).send = async (method: string, params: unknown) => { sent.push({ method, params }); return {}; };
    return { c, sent };
  }

  it('closes on V3 with session/close and on V2 with terminate, keeping the stored record', async () => {
    const v3 = client('v3');
    assert.equal(await v3.c.closeNativeSession('S1', 1_000), true);
    assert.deepEqual(v3.sent, [{ method: 'session/close', params: { sessionId: 'S1' } }]);
    const v2 = client('v2');
    assert.equal(await v2.c.closeNativeSession('S1', 1_000), true);
    assert.deepEqual(v2.sent, [{ method: '_kiro.dev/session/terminate', params: { sessionId: 'S1' } }]);
    const unadvertised = client('v3', false);
    assert.equal(await unadvertised.c.closeNativeSession('S1', 1_000), false);
    assert.deepEqual(unadvertised.sent, []);
  });

  it('counts announced prompts, agent turns, compaction and unanswered approvals as busy', () => {
    const { c } = client('v3');
    const raw = c as any;
    assert.equal(c.isSessionBusy('S1'), false);
    const release = c.announcePrompt('S1');
    assert.equal(c.isSessionBusy('S1'), true, 'a message the chat accepted is on its way');
    release();
    assert.equal(c.isSessionBusy('S1'), false);
    raw.compactingSessions.add('S1');
    assert.equal(c.isSessionBusy('S1'), true);
    raw.compactingSessions.clear();
    raw.pendingPermissions.set(-1, { sessionId: 'S1' });
    assert.equal(c.isSessionBusy('S1'), true);
    assert.equal(c.isSessionBusy('S2'), false);
    raw.pendingPermissions.clear();
    raw.sessionQueues.set('S1', { push() {} });
    raw.agentTurns.start('S1');
    assert.equal(c.isSessionBusy('S1'), true, 'a wake Kiro started');
  });
});

describe('AcpAgentRuntime (Kiro) idle release', () => {
  const CWD = '/tmp/kiro-idle';
  const TTL = 60_000;

  function setup(opts: { launch?: boolean; owner?: ReturnType<typeof chatOwner> } = {}) {
    const runtime = new AcpAgentRuntime({
      bridge, host: michiTestHost(), defaultCwd: '/tmp/default', idleTtlMs: 0, sessionIdleTtlMs: TTL,
      ...(opts.launch ? { launch: { bin: 'crew-acp', args: [] } as any } : {}),
    });
    const rt = runtime as any;
    const calls: string[] = [];
    const state = { busy: false, healthy: false, closeFails: false, openRuns: [] as string[], lastEventAt: undefined as number | undefined };
    const client = {
      needsSessionRecovery: () => false,
      isSessionBusy: () => state.busy,
      hasHealthyWork: () => state.healthy,
      hasSession: () => true,
      cancel: async () => { calls.push('cancel'); },
      closeNativeSession: async (sid: string) => {
        calls.push(`close:${sid}`);
        if (state.closeFails) throw new Error('timed out');
        return true;
      },
      destroySession: (sid: string) => { calls.push(`destroy:${sid}`); },
      shutdown: async () => { calls.push('shutdown'); },
    };
    const wf = {
      openRunsFor: () => state.openRuns,
      lastEventAt: () => state.lastEventAt,
      releaseParent: (sid: string) => { calls.push(`releaseParent:${sid}`); },
      stopRunsFor: async (sid: string) => { calls.push(`stopRuns:${sid}`); },
    };
    rt.pool.set(CWD, client);
    rt.workflowBridges.set(client, wf);
    const owner = opts.owner ?? chatOwner('node-1');
    rt.storeBinding({ publicSessionId: 'node-1', nativeSessionId: 'sid-1', owner, cwd: CWD, workspaceId: 'ws', ownerUserId: null, runtimeProfileHash: null });
    rt.sessionCwd.set('sid-1', CWD);
    rt.bindNodeSession('node-1', 'sid-1');
    const session = new AcpAgentSession('node-1', 'sid-1', runtime, CWD, { owner });
    rt.acquiredSessions.set('node-1', session);
    return { runtime, rt, session, state, calls, client };
  }

  const at = (session: AcpAgentSession, ms: number) => session.getLastUsedAt() + ms;
  const verdict = (runtime: AcpAgentRuntime, session: AcpAgentSession, ms: number): IdleReleaseVerdict => runtime.idleRelease('node-1', at(session, ms));

  it('releases a chat only after its last use is older than the TTL; a touch restarts the clock', () => {
    const { runtime, session } = setup();
    assert.deepEqual(verdict(runtime, session, TTL - 1), { action: 'keep', reason: 'recent' });
    assert.deepEqual(verdict(runtime, session, TTL), { action: 'release' });
    const before = session.getLastUsedAt();
    while (Date.now() === before) { /* next millisecond */ }
    session.touch();
    assert.ok(session.getLastUsedAt() > before);
  });

  it('keeps a session while a turn of its own or of Kiro is open', () => {
    const { runtime, session, state } = setup();
    state.busy = true;
    assert.deepEqual(verdict(runtime, session, TTL * 10), { action: 'keep', reason: 'busy' });
    state.busy = false;
    (session as any).agentTurn = new AbortController();
    assert.deepEqual(verdict(runtime, session, TTL * 10), { action: 'keep', reason: 'busy' });
  });

  it('keeps the parent of a running or paused workflow, up to the background caps', () => {
    const { runtime, session, state } = setup();
    const now = at(session, TTL * 10);
    state.openRuns = ['wf-1'];
    state.lastEventAt = now - 1_000;
    assert.deepEqual(runtime.idleRelease('node-1', now), { action: 'keep', reason: 'workflow' });
    state.lastEventAt = now - KIRO_BACKGROUND_IDLE_TTL_MS;
    assert.deepEqual(runtime.idleRelease('node-1', now), { action: 'stop_background', reason: 'workflow_quiet' });
    const late = at(session, KIRO_BACKGROUND_IDLE_CAP_MS);
    state.lastEventAt = late - 1_000;
    assert.deepEqual(runtime.idleRelease('node-1', late), { action: 'stop_background', reason: 'workflow_cap' },
      'a run that keeps reporting still cannot hold the session past the cap');
  });

  it('a workflow that just ended keeps its parent for the wake that follows', () => {
    const { runtime, session, state } = setup();
    const now = at(session, TTL * 10);
    state.lastEventAt = now - 1_000;
    assert.deepEqual(runtime.idleRelease('node-1', now), { action: 'keep', reason: 'recent' });
    state.lastEventAt = now - TTL;
    assert.deepEqual(runtime.idleRelease('node-1', now), { action: 'release' });
  });

  it('leaves Agent Runs, launch adapters and a disabled TTL alone', () => {
    const run = setup({ owner: runOwner('run-1', 'attempt-1') });
    assert.deepEqual(verdict(run.runtime, run.session, TTL * 10), { action: 'keep', reason: 'not_chat' });
    const crew = setup({ launch: true });
    assert.deepEqual(verdict(crew.runtime, crew.session, TTL * 10), { action: 'keep', reason: 'launch_adapter' });
    const off = new AcpAgentRuntime({ bridge, host: michiTestHost(), defaultCwd: '/tmp/default', sessionIdleTtlMs: 0 });
    assert.deepEqual(off.idleRelease('node-1', Date.now()), { action: 'keep', reason: 'disabled' });
  });

  it('stopIdleBackgroundWork stops the parent\'s runs through the bridge', async () => {
    const { runtime, calls } = setup();
    await runtime.stopIdleBackgroundWork('node-1');
    assert.deepEqual(calls, ['stopRuns:sid-1']);
  });

  it('release lets kiro-cli drop the session, then forgets it; a failed close still cleans up', async () => {
    const ok = setup();
    await ok.runtime.releaseSession('node-1');
    assert.deepEqual(ok.calls, ['cancel', 'close:sid-1', 'releaseParent:sid-1', 'destroy:sid-1']);
    assert.equal(ok.runtime.getBinding('node-1'), undefined);

    const failing = setup();
    failing.state.closeFails = true;
    await failing.runtime.releaseSession('node-1');
    assert.deepEqual(failing.calls, ['cancel', 'close:sid-1', 'releaseParent:sid-1', 'destroy:sid-1']);
    assert.equal(failing.runtime.getBinding('node-1'), undefined);
  });

  it('never closes natively a session whose workflow is open, nor a launch adapter\'s', async () => {
    const open = setup();
    open.state.openRuns = ['wf-1'];
    await open.runtime.releaseSession('node-1');
    assert.deepEqual(open.calls, ['cancel', 'destroy:sid-1']);
    const crew = setup({ launch: true });
    await crew.runtime.releaseSession('node-1');
    assert.deepEqual(crew.calls, ['cancel', 'destroy:sid-1']);
  });

  it('the process idle timer waits while the process still runs work with no chat bound', async () => {
    const runtime = new AcpAgentRuntime({ bridge, host: michiTestHost(), defaultCwd: '/tmp/default', idleTtlMs: 10 });
    const rt = runtime as any;
    let healthy = true;
    let stopped = 0;
    rt.pool.set(CWD, { hasHealthyWork: () => healthy, shutdown: async () => { stopped += 1; } });
    rt.scheduleIdleCleanup(CWD);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(stopped, 0, 'a workflow in the process would end with it');
    assert.ok(rt.pool.has(CWD));
    healthy = false;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(stopped, 1);
    assert.equal(rt.pool.has(CWD), false);
  });
});

describe('ChatManager.releaseIdleSessions', () => {
  let tmpDir: string;
  let verdicts: IdleReleaseVerdict[];
  let releases: string[];
  let stops: string[];
  let idleCalls: number;
  const RUNTIME = 'kiro-idle-test';

  function fakeRuntime(): AgentRuntime {
    return {
      id: RUNTIME, label: 'Kiro idle test', descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
      capabilities: {
        modes: false, permissions: true, models: false, providerModels: false, reasoning: false,
        supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: true,
      },
      async warm() {},
      async newSession() { throw new Error('unused'); },
      async loadSession() { throw new Error('unused'); },
      idleRelease() { idleCalls += 1; return verdicts.shift() ?? { action: 'keep', reason: 'test' }; },
      async stopIdleBackgroundWork(id) { stops.push(id); },
      async releaseSession(id) { releases.push(id); },
      async shutdown() {},
    };
  }

  function liveSession(id: string, nativeSessionId = `native-${id}`): AgentSession {
    const session: AgentSession = {
      id, runtimeId: RUNTIME, nativeSessionId, owner: chatOwner(id),
      getHistory: () => [], getPendingAssistant: () => undefined,
      async *send() { /* unused */ }, cancel() {},
    };
    registerSession(session, null, chatOwner(id));
    return session;
  }

  function node(id: string, fields: { native?: string; maintenance?: boolean } = {}): void {
    saveNode({ id, workspace_id: 'ws-idle', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
    updateNodeResumeBinding(id, { acp_session_id: fields.native ?? `native-${id}`, runtime_id: RUNTIME, runtime_engine: null });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-idle-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-idle', name: 'Idle', cwd: tmpDir, created_at: 1, updated_at: 1 });
    verdicts = [];
    releases = [];
    stops = [];
    idleCalls = 0;
    registerRuntime(fakeRuntime());
    updateAgentConfig({ nativeResumeByRuntime: { [RUNTIME]: true } });
  });

  afterEach(() => {
    clearAllSessions();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('asks again inside the restore lock and drops the released session from the registry', async () => {
    node('n-1');
    const session = liveSession('n-1');
    verdicts = [{ action: 'release' }, { action: 'release' }];
    assert.equal(await new ChatManager(undefined, tmpDir).releaseIdleSessions(), 1);
    assert.equal(idleCalls, 2, 'once to pick it, once under the lock');
    assert.deepEqual(releases, ['n-1']);
    assert.equal(peekLiveSession('n-1'), undefined);
    assert.equal(getSession('n-1') === session, false);
  });

  it('keeps a session that became busy while the sweep waited for its lock', async () => {
    node('n-1');
    liveSession('n-1');
    verdicts = [{ action: 'release' }, { action: 'keep', reason: 'recent' }];
    const unlock = await acquireSessionRestoreLock('n-1');
    const sweep = new ChatManager(undefined, tmpDir).releaseIdleSessions();
    unlock();
    assert.equal(await sweep, 0);
    assert.deepEqual(releases, []);
    assert.ok(peekLiveSession('n-1'));
  });

  it('stops background work past its cap instead of releasing', async () => {
    node('n-1');
    liveSession('n-1');
    verdicts = [{ action: 'stop_background', reason: 'workflow_cap' }, { action: 'stop_background', reason: 'workflow_cap' }];
    assert.equal(await new ChatManager(undefined, tmpDir).releaseIdleSessions(), 0);
    assert.deepEqual(stops, ['n-1']);
    assert.deepEqual(releases, []);
  });

  it('never releases when the next message could not resume the same native session', async (t) => {
    node('active');
    liveSession('active');
    node('stale-binding', { native: 'some-other-native' });
    liveSession('stale-binding');
    node('maintenance');
    liveSession('maintenance');
    const { getDb } = await import('../src/services/db');
    getDb().prepare("UPDATE nodes SET maintenance_job_id = 'job' WHERE id = 'maintenance'").run();
    t.mock.method(chatHub, 'hasPendingSelfTurn', (id: string) => id === 'active');
    verdicts = Array.from({ length: 10 }, () => ({ action: 'release' as const }));
    assert.equal(await new ChatManager(undefined, tmpDir).releaseIdleSessions(), 0);
    assert.equal(idleCalls, 0, 'the host rules them out before asking the runtime');

    t.mock.restoreAll();
    node('resume-off');
    liveSession('resume-off');
    updateAgentConfig({ nativeResumeByRuntime: { [RUNTIME]: false } });
    assert.equal(await new ChatManager(undefined, tmpDir).releaseIdleSessions(), 0);
    assert.deepEqual(releases, []);
  });
});
