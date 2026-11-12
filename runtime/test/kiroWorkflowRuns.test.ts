/**
 * Real Kiro CLI 3.1.0 workflow runs (recorded 2026-11-08, sanitized in
 * fixtures/kiroWorkflowRuns/) replayed through the Kiro AcpClient and the
 * workflow bridge, against an in-memory hub. Each fixture holds the frames
 * kiro-cli sent ("in") and the client's initialize/session/new/prompt
 * requests ("out"); the fake process answers those from the recording.
 *
 *   plan                 workflowPrompt run: creator step, plan approval,
 *                        steps_queued, a repeat that takes two iterations
 *   watch                repeat + command watch (3 polls, each asking the
 *                        parent session), then parallel allSettled with a
 *                        failing branch
 *   plan-write-declined  a declined write: the step asks via send_message,
 *                        the run pauses with a question attention
 *   investigate          bundled://investigate with a report artifact
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { omittedLeafCounts, parseWorkflowRunDto, WORKFLOW_LIMITS, workflowProgress, type WorkflowApprovalDto, type WorkflowRunDtoV1 } from 'michi-shared';
import * as processTree from '../src/core/processTree';
import { AcpClient } from '../src/adapters/kiro/acpClient';
import { createKiroWorkflowBridge, kiroApprovalDetail } from '../src/core/workflows/kiroWorkflowBridge';
import { applyKiroWorkflowNotification } from '../src/core/workflows/kiroWorkflowFold';

type Frame = Record<string, any>;
type Entry = { dir: 'in' | 'out'; at: number; msg: Frame };

const FIXTURES = path.join(__dirname, 'fixtures', 'kiroWorkflowRuns');
const noop = () => undefined;
const observability: any = { log: noop, perf: { now: () => 0, mark: noop, measure: noop }, startupMark: noop, childStderr: noop };

function baseRun(nativeId: string): WorkflowRunDtoV1 {
  return { version: 1, id: `kiro:${nativeId}`, runtime: 'kiro', nativeId, workspaceId: 'w', nodeId: null, parentToolCallId: null,
    name: nativeId, status: 'running', nodes: [], log: [], actions: [], startedAt: 0, updatedAt: 0, revision: 0 };
}

interface Replay {
  run: WorkflowRunDtoV1;
  /** Card approvals in order, with how the hub answered them. */
  approvals: Array<Omit<WorkflowApprovalDto, 'requestedAt'> & { workflowId: string }>;
  /** Per recorded permission request: the client's reply to kiro-cli, if any. */
  replies: Array<{ title: string; session: 'parent' | 'step'; reply: Frame | undefined }>;
  /** Permission requests that reached the parent chat's turn stream. */
  chatPermissions: number;
}

async function replay(t: any, name: string, answer: (approval: Omit<WorkflowApprovalDto, 'requestedAt'>) => string | null = (a) => a.options.find((o) => o.kind === 'allow_once')?.optionId ?? null): Promise<Replay> {
  const wire: Entry[] = fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const out = wire.filter((e) => e.dir === 'out');
  const resultOf = (method: string) => {
    const req = out.find((e) => e.msg.method === method)?.msg;
    return wire.find((e) => e.dir === 'in' && !e.msg.method && e.msg.id === req?.id)?.msg.result;
  };
  const promptId = out.find((e) => e.msg.method === 'session/prompt')?.msg.id;
  const parent: string = resultOf('session/new').sessionId;

  const replies = new Map<number | string, Frame>();
  const held: { prompt?: Frame } = {};
  let proc: any;
  let inflight = 0;
  const emit = (frame: Frame) => { inflight++; setImmediate(() => { inflight--; proc.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`)); }); };
  const settle = async () => { let quiet = 0; while (quiet < 3) { await new Promise<void>((r) => setImmediate(r)); quiet = inflight === 0 ? quiet + 1 : 0; } };
  t.mock.method(processTree, 'spawnAgentProcess', () => {
    proc = Object.assign(new EventEmitter(), {
      pid: 4242, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: { destroyed: false, write: (line: string, cb?: (e?: Error | null) => void) => {
        const msg = JSON.parse(line); cb?.(null);
        if (msg.method === 'initialize') emit({ jsonrpc: '2.0', id: msg.id, result: resultOf('initialize') });
        else if (msg.method === 'session/new') emit({ jsonrpc: '2.0', id: msg.id, result: resultOf('session/new') });
        else if (msg.method === 'session/prompt') held.prompt = msg;
        else if (!msg.method) replies.set(msg.id, msg);
        return true;
      } },
    });
    queueMicrotask(() => proc.emit('spawn'));
    return proc;
  });
  t.mock.method(processTree, 'killProcessTree', noop);

  const runs = new Map<string, WorkflowRunDtoV1>();
  const approvals: Replay['approvals'] = [];
  const hub: any = {
    update: (_c: unknown, _r: unknown, id: string, mutate: (run: WorkflowRunDtoV1) => WorkflowRunDtoV1) => { const next = mutate(runs.get(id) ?? baseRun(id)); runs.set(id, next); return next; },
    updateKnown: (_r: unknown, id: string, mutate: (run: WorkflowRunDtoV1) => WorkflowRunDtoV1) => { const cur = runs.get(id); if (!cur) return null; const next = mutate(cur); runs.set(id, next); return next; },
    registerControls: noop, withdrawApproval: noop, releaseControls: noop,
    requestApproval: (_o: unknown, _r: unknown, id: string, approval: Omit<WorkflowApprovalDto, 'requestedAt'>, resolve: (optionId: string | null) => void) => {
      approvals.push({ workflowId: id, ...approval });
      resolve(answer(approval));
      return true;
    },
  };
  const client = new AcpClient('/fake/kiro-cli', '/work', undefined, 'v3', undefined, 'kiro', { observability });
  const bridge = createKiroWorkflowBridge({
    hub,
    resolve: () => ({ ownerUserId: 'u', workspaceId: 'w', owner: { kind: 'chat', id: 'c' } as any }),
    control: async () => undefined,
    answerPermission: (requestId, optionId) => { if (optionId) client.respondToPermission(requestId, optionId); else client.cancelPermission(requestId); },
    approves: () => false, // a chat in Ask
    now: () => 1_000,
  });
  client.setWorkflowRouter({
    onEvent: (method, params) => bridge.handle(method, params),
    isStepSession: (sessionId) => bridge.isStepSession(sessionId),
    hasOpenRuns: () => bridge.hasOpenRuns(),
    requestPermission: (request) => bridge.requestPermission(request),
  });
  client.start();
  await client.initialize(10_000);
  await client.newSession([], { workflowsEnabled: true });
  let chatPermissions = 0;
  void (async () => {
    for await (const update of client.prompt(parent, 'replayed')) if (update.sessionUpdate === 'permission_request') chatPermissions++;
  })().catch(noop);
  await settle();

  const permissionRequests: Frame[] = [];
  for (const entry of wire) {
    if (entry.dir !== 'in') continue;
    const msg = entry.msg;
    if (!msg.method) {
      if (msg.id === promptId && held.prompt) emit({ jsonrpc: '2.0', id: held.prompt.id, result: msg.result });
      else continue;
    } else {
      if (msg.method === 'session/request_permission') permissionRequests.push(msg);
      emit(msg);
    }
    await settle();
  }
  assert.equal(runs.size, 1, 'one run per fixture');
  return {
    run: [...runs.values()][0],
    approvals,
    replies: permissionRequests.map((msg) => ({ title: msg.params.toolCall?.title, session: msg.params.sessionId === parent ? 'parent' : 'step', reply: replies.get(msg.id) })),
    chatPermissions,
  };
}

const byId = (run: WorkflowRunDtoV1, id: string) => {
  const node = run.nodes.find((n) => n.id === id);
  assert.ok(node, `node ${id}`);
  return node;
};

test('workflowPrompt run: the plan, its loop and both iterations land in the run', async (t) => {
  const { run, approvals } = await replay(t, 'plan');
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.nodes.map((n) => [n.id, n.kind, n.parentId ?? null]), [
    ['create-workflow', 'step', null],
    ['poem-loop', 'loop', null],
    ['draft', 'step', 'poem-loop'],
    ['review', 'step', 'poem-loop'],
    ['summarize', 'step', null],
  ]);
  assert.ok(run.nodes.every((n) => !n.planned), 'nothing stays proposed once Kiro applies the plan');
  assert.deepEqual(byId(run, 'poem-loop').loop, { maxIterations: 3, onMaxIterations: 'pause', until: 'review.json verdict = "APPROVED"' });
  for (const id of ['draft', 'review']) {
    const node = byId(run, id);
    assert.equal(node.iteration, 1);
    assert.equal(node.rounds?.length, 1, `${id} keeps its first iteration`);
    assert.equal(node.rounds?.[0].iteration, 0);
    assert.equal(node.rounds?.[0].status, 'completed');
    assert.ok(node.rounds?.[0].result, `${id} round 0 has its output`);
    assert.ok(node.rounds?.[0].credits && node.rounds[0].credits > 0);
  }
  assert.match(byId(run, 'review').rounds![0].result!, /first review round|CHANGES_REQUESTED|round\.txt/i);
  assert.deepEqual(workflowProgress(run), { total: 4, done: 4, running: 0, failed: 0 });
  assert.ok((run.usage?.credits ?? 0) > 0, 'run credits');
  assert.ok((byId(run, 'summarize').usage?.credits ?? 0) > 0, 'step credits');

  // The plan approval shows the plan; each write names its file.
  assert.equal(approvals[0].title, 'Approve Add 2 workflow steps?');
  assert.equal(approvals[0].nodeId, 'create-workflow');
  assert.match(approvals[0].detail ?? '', /poem-loop: repeat, max 3 iterations/);
  const writes = approvals.slice(1);
  assert.ok(writes.length >= 2);
  for (const write of writes) {
    assert.equal(write.title, 'Approve Write File?');
    assert.match(write.detail ?? '', /^Write \/work\/plan\/(note\.md|review\.json|round\.txt)$/);
  }
});

test('plan updates: proposed steps show as planned; a rejected plan takes them back', () => {
  const start = applyKiroWorkflowNotification(baseRun('wf'), '_kiro/workflow/run_start', {
    workflowId: 'wf', nodeTree: [{ nodeId: 'plan', type: 'step', agentName: 'wf-planner' }, { nodeId: 'old', type: 'step', agentName: 'wf-coder' }],
  }, 1);
  const running = applyKiroWorkflowNotification(start, '_kiro/workflow/node_start', { workflowId: 'wf', nodeId: 'plan', nodePath: ['wf', 'plan'], type: 'step' }, 2);
  const queued = applyKiroWorkflowNotification(running, '_kiro/workflow/steps_queued', {
    workflowId: 'wf', pendingSteps: [{ nodeId: 'fix', type: 'repeat', maxIterations: 2, onMaxIterations: 'abort', stopWhen: '{{check.output}} contains OK', steps: [{ nodeId: 'check', type: 'step', agentName: 'wf-coder' }] }],
  }, 3);
  // replace_remaining: the unstarted `old` step goes, the proposal follows the running step.
  assert.deepEqual(queued.nodes.map((n) => [n.id, n.status, n.planned ?? false]), [['plan', 'running', false], ['fix', 'queued', true], ['check', 'queued', true]]);
  assert.deepEqual(queued.nodes[1].loop, { maxIterations: 2, onMaxIterations: 'abort', until: '{{check.output}} contains OK' });
  const rejected = applyKiroWorkflowNotification(queued, '_kiro/workflow/steps_queued', { workflowId: 'wf', pendingSteps: [], resolution: { outcome: 'rejected' } }, 4);
  assert.deepEqual(rejected.nodes.map((n) => n.id), ['plan']);
  const applied = applyKiroWorkflowNotification(queued, '_kiro/workflow/steps_queued', { workflowId: 'wf', pendingSteps: [], resolution: { outcome: 'applied' } }, 4);
  assert.ok(applied.nodes.every((n) => !n.planned));
});

test('past the node limit new steps still show: the oldest completed ones outside loops go and stay counted', () => {
  const steps = Array.from({ length: 250 }, (_, index) => ({ nodeId: `s${index + 1}`, type: 'step', agentName: 'wf-coder' }));
  const tree = [{ nodeId: 'lp', type: 'repeat', maxIterations: 2, steps: [{ nodeId: 'ls', type: 'step' }] }, { nodeId: 'fan', type: 'parallel', branches: steps }];
  const notify = (run: WorkflowRunDtoV1, event: string, params: Record<string, unknown>, now: number) =>
    applyKiroWorkflowNotification(run, `_kiro/workflow/${event}`, { workflowId: 'wf', ...params }, now);
  let run = notify(baseRun('wf'), 'run_start', { nodeTree: tree }, 0);
  run = notify(run, 'node_start', { nodeId: 'ls', nodePath: ['wf', 'lp', 'iter-0', 'ls'], type: 'step' }, 1);
  run = notify(run, 'node_complete', { nodeId: 'ls', status: 'completed' }, 1);
  for (let index = 1; index <= 250; index += 1) {
    run = notify(run, 'node_start', { nodeId: `s${index}`, nodePath: ['wf', 'fan', `s${index}`], type: 'step' }, 1 + index);
    if (index < 250) run = notify(run, 'node_complete', { nodeId: `s${index}`, status: 'completed' }, 1 + index);
  }
  assert.ok(run.nodes.length <= WORKFLOW_LIMITS.nodes);
  assert.equal(run.nodes.find((node) => node.id === 's250')?.status, 'running', 'the newest step shows');
  assert.equal(run.nodes.find((node) => node.id === 's250')?.parentId, 'fan');
  assert.ok(run.nodes.some((node) => node.id === 'ls'), 'a loop step may run again, so it stays');
  assert.ok(!run.nodes.some((node) => node.id === 's1'), 'the oldest completed step goes first');
  assert.deepEqual(workflowProgress(run), { total: 251, done: 250, running: 1, failed: 0 });
  assert.deepEqual(omittedLeafCounts(run, 'fan'), { completed: 53 });
  assert.deepEqual(parseWorkflowRunDto(JSON.parse(JSON.stringify(run)))?.omittedLeafIds, run.omittedLeafIds, 'stored runs keep the ids');

  // A resend of the plan (resume) does not bring omitted steps back as queued.
  const resumed = notify(run, 'run_start', { nodeTree: tree }, 300);
  assert.deepEqual(workflowProgress(resumed), { total: 251, done: 250, running: 1, failed: 0 });
  // A step Kiro starts again leaves the counts and shows.
  const retried = notify(resumed, 'node_start', { nodeId: 's1', nodePath: ['wf', 'fan', 's1'], type: 'step' }, 301);
  assert.equal(retried.nodes.find((node) => node.id === 's1')?.status, 'running');
  assert.deepEqual(workflowProgress(retried), { total: 251, done: 249, running: 2, failed: 0 });
  assert.equal(retried.omittedLeafIds?.s1, undefined);
});

test('a run Michi marked interrupted reopens when Kiro starts a node; one Kiro ended itself does not', () => {
  const nodeStart = (id: string) => ({ workflowId: id, nodeId: 'a', nodePath: [id, 'a'], type: 'step' });
  // Marked by the flag, whatever its message says.
  const interrupted: WorkflowRunDtoV1 = { ...baseRun('wf'), status: 'cancelled', interrupted: true, statusDetail: 'Michi restarted while this ran', endedAt: 5 };
  const resumed = applyKiroWorkflowNotification(interrupted, '_kiro/workflow/node_start', nodeStart('wf'), 6);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.interrupted, undefined);
  assert.equal(resumed.endedAt, undefined);

  // Kiro's own cancel, whose reason happens to begin with "Interrupted".
  const ended = applyKiroWorkflowNotification(baseRun('wf2'), '_kiro/workflow/run_complete',
    { workflowId: 'wf2', status: 'aborted', finalState: { failureReason: 'Interrupted by the user' } }, 7);
  assert.equal(ended.status, 'cancelled');
  assert.equal(applyKiroWorkflowNotification(ended, '_kiro/workflow/node_start', nodeStart('wf2'), 8).status, 'cancelled');

  // Stored before the flag existed, with Michi's own message.
  const legacy: WorkflowRunDtoV1 = { ...baseRun('wf3'), status: 'cancelled',
    statusDetail: 'Interrupted: Michi restarted while this workflow was running. Kiro may resume it in a new session.' };
  assert.equal(applyKiroWorkflowNotification(legacy, '_kiro/workflow/node_start', nodeStart('wf3'), 9).status, 'running');
});

test('command watch: the parent-session approval goes to the run once, later polls reuse it', async (t) => {
  const { run, approvals, replies, chatPermissions } = await replay(t, 'watch');
  const watchReplies = replies.filter((r) => r.session === 'parent');
  assert.equal(watchReplies.length, 3, 'the watch asked before each of its 3 polls');
  for (const reply of watchReplies) assert.deepEqual(reply.reply?.result, { outcome: { outcome: 'selected', optionId: 'accept' } });
  assert.equal(chatPermissions, 0, 'no watch approval lands in the chat turn');
  const watchCards = approvals.filter((a) => a.nodeId === 'ticker');
  assert.equal(watchCards.length, 1, 'asked once; the same command is allowed for the rest of the run');
  assert.match(watchCards[0].detail ?? '', /^\$ node \/work\/watch\/ticker\.cjs\n\nWatch "ticker" runs this command on every poll/);

  assert.equal(run.status, 'failed');
  const loop = byId(run, 'wait-loop');
  assert.equal(loop.kind, 'loop');
  assert.deepEqual(loop.loop, { maxIterations: 5, onMaxIterations: 'pause', until: 'ticker finishes' });
  const ticker = byId(run, 'ticker');
  assert.equal(ticker.kind, 'watch');
  assert.equal(ticker.parentId, 'wait-loop');
  assert.equal(ticker.rounds?.length, 1);
  assert.equal(ticker.watch?.lastOutcome, 'terminal-state');
  assert.equal(ticker.watch?.polls, 2, 'the second iteration polled twice (idle, then terminal)');
  assert.equal(byId(run, 'survey').status, 'failed');
  assert.equal(byId(run, 'missing-file').status, 'failed');
  assert.equal(byId(run, 'count-lines').status, 'completed');
  // A watch is not an agent: progress counts the steps.
  assert.equal(workflowProgress(run).total, 3);
});

test('a step that asks the user marks the node as waiting for an answer', async (t) => {
  const { run } = await replay(t, 'plan-write-declined', (approval) => /Write/.test(approval.title)
    ? approval.options.find((o) => o.kind === 'reject_once')?.optionId ?? null
    : approval.options.find((o) => o.kind === 'allow_once')?.optionId ?? null);
  assert.equal(run.status, 'paused');
  assert.equal(run.statusDetail, 'Step requested user input via send_message.');
  const draft = byId(run, 'draft');
  assert.equal(draft.status, 'paused');
  assert.equal(draft.needsInput, true);
  assert.equal(draft.parentId, 'poem-loop');
  assert.ok(run.nodes.filter((n) => n.id !== 'draft').every((n) => !n.needsInput));
});

test('bundled recipe: the step keeps its declared report file', async (t) => {
  const { run } = await replay(t, 'investigate');
  assert.equal(run.status, 'completed');
  assert.deepEqual(byId(run, 'investigate').artifacts, { report: '/work/investigate/report.md' });
});

test('approval detail reads Kiro consent when a request has no rawInput', () => {
  assert.equal(kiroApprovalDetail({ meta: { kiro: { toolId: 'fs_write', consent: { capability: 'fs_write', resource: 'a/b.md', workspaceRoot: '/repo/' } } } }), 'Write /repo/a/b.md');
  assert.equal(kiroApprovalDetail({ meta: { kiro: { toolId: 'fs_read', consent: { capability: 'fs_read', resource: '/abs/x.txt', workspaceRoot: '/repo' } } } }), 'Read /abs/x.txt');
  assert.equal(kiroApprovalDetail({ meta: { kiro: { toolId: 'run_command', command: 'ls -la', consent: { capability: 'shell', resource: 'ls -la' } } } }), '$ ls -la');
  assert.equal(kiroApprovalDetail({ toolCall: { rawInput: { path: '/x' } } }), '{"path":"/x"}');
  assert.equal(kiroApprovalDetail({}), undefined);
});
