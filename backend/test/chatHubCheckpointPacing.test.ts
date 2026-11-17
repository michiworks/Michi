import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import type { DurableTurnSnapshot } from 'michi-shared';
import { ChatHub, type TurnPersistence } from '../src/agents/chatHub';
import type { AgentSession, MaintenanceTurnContext } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';

/** A runtime turn whose events the test hands over one batch at a time. */
function channel() {
  const queue: NormalizedEvent[] = [];
  let wake: (() => void) | null = null;
  const events: AsyncIterableIterator<NormalizedEvent> = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      while (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
      return { done: false, value: queue.shift()! };
    },
  };
  return {
    events,
    push(...batch: NormalizedEvent[]) {
      queue.push(...batch);
      wake?.();
      wake = null;
    },
  };
}

function sessionOf(events: AsyncIterableIterator<NormalizedEvent>): AgentSession {
  return {
    id: 'chat-1', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
    send: () => events, cancel: () => {},
  };
}

/** Lets the hub fold the pushed events and run what it put on the next tick (setImmediate stays real). */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function pacedHub(t: TestContext, checkpoint?: TurnPersistence['checkpoint']) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const checkpoints: DurableTurnSnapshot[] = [];
  const finalized: DurableTurnSnapshot[] = [];
  const hub = new ChatHub({
    retentionMs: 100,
    workspaceIdForNode: () => 'ws-test',
    lookupDurableTurn: () => null,
    persistence: {
      begin: () => {},
      checkpoint: (snapshot) => {
        checkpoints.push(snapshot);
        return checkpoint?.(snapshot);
      },
      finalize: (snapshot) => { finalized.push(snapshot); },
    },
  });
  return { hub, checkpoints, finalized, tick: (ms: number) => t.mock.timers.tick(ms) };
}

const toolStatuses = (snapshot: DurableTurnSnapshot | undefined) => snapshot?.assistantMessage.toolCalls.map((call) => call.status);
const answerText = (snapshot: DurableTurnSnapshot | undefined) => snapshot?.assistantMessage.blocks
  .map((block) => block.kind === 'answer' ? block.rawText : '').join('');

describe('ChatHub checkpoint pacing', () => {
  test('a tool start waits for the interval; its result is written on the next tick', async (t) => {
    const { hub, checkpoints, tick } = pacedHub(t);
    const runtime = channel();
    const { done } = await hub.startTurn({ chatId: 'chat-1', nodeId: 'node-1', text: 'run it', session: sessionOf(runtime.events) });

    runtime.push({ kind: 'tool_call', toolCallId: 'tool-1', title: 'Bash', status: 'running' });
    await settle();
    assert.equal(checkpoints.length, 0, 'no checkpoint at the tool start');

    tick(1_500);
    assert.equal(checkpoints.length, 1, 'the trailing timer writes the started tool');
    assert.deepEqual(toolStatuses(checkpoints[0]), ['running']);

    runtime.push(...Array.from({ length: 50 }, (_, index): NormalizedEvent => ({
      kind: 'tool_call_update', toolCallId: 'tool-1', title: '', status: 'in_progress', output: `line ${index}`,
    })));
    await settle();
    assert.equal(checkpoints.length, 1, 'running output waits for the interval');

    runtime.push({ kind: 'tool_call_update', toolCallId: 'tool-1', title: '', status: 'completed', output: 'final output' });
    await settle();
    assert.equal(checkpoints.length, 2, 'the result is written on the next tick');
    assert.deepEqual(toolStatuses(checkpoints[1]), ['completed']);
    assert.equal(checkpoints[1].assistantMessage.toolCalls[0]?.output, 'final output');

    runtime.push({ kind: 'turn_end', stopReason: 'end_turn' });
    await done;
  });

  test('text that stops streaming is written by the trailing timer', async (t) => {
    const { hub, checkpoints, finalized, tick } = pacedHub(t);
    const runtime = channel();
    const { done } = await hub.startTurn({ chatId: 'chat-1', nodeId: 'node-1', text: 'hi', session: sessionOf(runtime.events) });

    tick(1_000);
    runtime.push({ kind: 'chunk', text: 'partial answer' });
    await settle();
    assert.equal(checkpoints.length, 0);
    tick(499);
    assert.equal(checkpoints.length, 0);
    tick(1);
    assert.equal(checkpoints.length, 1);
    assert.equal(answerText(checkpoints[0]), 'partial answer');
    tick(60_000);
    assert.equal(checkpoints.length, 1, 'an idle turn writes nothing more');

    runtime.push({ kind: 'turn_end', stopReason: 'end_turn' });
    await done;
    assert.equal(finalized.length, 1);
  });

  test('a prompt, a title and a tool result in one tick share one checkpoint', async (t) => {
    const { hub, checkpoints, tick } = pacedHub(t);
    const runtime = channel();
    const { done } = await hub.startTurn({ chatId: 'chat-1', nodeId: 'node-1', text: 'hi', session: sessionOf(runtime.events) });

    runtime.push(
      { kind: 'tool_call', toolCallId: 'tool-1', title: 'Read', status: 'completed', output: 'ok' },
      { kind: 'title', title: 'Reading' },
      { kind: 'permission_request', requestId: 7, title: 'Write file?', options: [] },
    );
    await settle();
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].nodeMetadata.title, 'Reading');
    assert.deepEqual(toolStatuses(checkpoints[0]), ['completed']);

    runtime.push({ kind: 'permission_resolved', requestId: 7 });
    await settle();
    assert.equal(checkpoints.length, 2, 'the answer to the prompt is written on the next tick too');

    tick(60_000);
    runtime.push({ kind: 'turn_end', stopReason: 'end_turn' });
    await done;
    assert.equal(checkpoints.length, 2);
  });

  test('a turn that ends in the tick of its last events is written by finalize alone', async (t) => {
    const { hub, checkpoints, finalized } = pacedHub(t);
    const runtime = channel();
    const { done } = await hub.startTurn({ chatId: 'chat-1', nodeId: 'node-1', text: 'hi', session: sessionOf(runtime.events) });

    runtime.push(
      { kind: 'tool_call', toolCallId: 'tool-1', title: 'Read', status: 'running' },
      { kind: 'tool_call_update', toolCallId: 'tool-1', title: '', status: 'completed', output: 'ok' },
      { kind: 'chunk', text: 'answer' },
      { kind: 'usage_summary', contextUsagePercentage: 12, turnDurationMs: 5 },
      { kind: 'turn_end', stopReason: 'end_turn' },
    );
    await done;
    await settle();
    assert.equal(checkpoints.length, 0, 'finalize drops the checkpoint the tool result asked for');
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].assistantMessage.content, 'answer');
    assert.deepEqual(toolStatuses(finalized[0]), ['completed']);
  });

  test('the bytes a checkpoint reports pace the next one', async (t) => {
    const { hub, checkpoints, tick } = pacedHub(t, async () => ({ payloadBytes: 1024 * 1024 }));
    const runtime = channel();
    const { done } = await hub.startTurn({ chatId: 'chat-1', nodeId: 'node-1', text: 'hi', session: sessionOf(runtime.events) });

    runtime.push({ kind: 'chunk', text: 'a' });
    await settle();
    tick(1_500);
    await settle();
    assert.equal(checkpoints.length, 1);

    runtime.push({ kind: 'chunk', text: 'b' });
    await settle();
    tick(3_999);
    assert.equal(checkpoints.length, 1, 'a 1 MiB row waits 4 s');
    tick(1);
    assert.equal(checkpoints.length, 2);

    runtime.push({ kind: 'turn_end', stopReason: 'end_turn' });
    await done;
  });

  test('a maintenance turn is first checkpointed after 5 s', async (t) => {
    const { hub, checkpoints, tick } = pacedHub(t);
    const runtime = channel();
    const maintenanceContext: MaintenanceTurnContext = {
      workspaceId: 'ws-test', ownerUserId: 'local', jobId: 'job-1', runId: 'run-1', claimedBy: 'test',
      configRevision: 1, planId: 'plan-1', sources: [],
    };
    const started = await hub.startRequestedSelfTurn({
      chatId: 'chat-1', nodeId: 'node-1', turnId: 'maintenance-turn', text: 'upkeep',
      session: sessionOf(runtime.events), maintenanceContext,
    });

    runtime.push({ kind: 'chunk', text: 'reading pages' });
    await settle();
    tick(4_999);
    assert.equal(checkpoints.length, 0);
    tick(1);
    assert.equal(checkpoints.length, 1);

    runtime.push({ kind: 'turn_end', stopReason: 'end_turn' });
    await started.done;
  });
});
