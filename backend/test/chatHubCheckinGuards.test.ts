/**
 * DESIGN-v2 §2.5, chatHub's turn guards (W0b recheck B-1, fail closed):
 * - a requested self turn whose id starts with `cmp-` (a check-in's own
 *   turn, and so a post's `cmp-post-` too) runs only on a check-in node, and
 *   a check-in node runs only its own run's check-in turn;
 * - a `cms-` turn (a follow-up the agent sends) runs only outside the
 *   assistant's workspace;
 * - a user turn never runs on a check-in node nor carries those ids, and a
 *   turn the runtime starts on its own in a check-in's session is stopped
 *   and drained.
 * A refused turn writes nothing and leaves the chat free. Harness hubs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHub, TurnGuardError } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { chatOwner } from './helpers/owners';

const V = 'n-v';          // the assistant's conversation
const S = 'n-cmph-run1';  // a check-in node
const WORKER = 'n-worker';

function iterate(events: NormalizedEvent[]): AsyncIterableIterator<NormalizedEvent> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() { return index < events.length ? { done: false, value: events[index++] } : { done: true, value: undefined }; },
  };
}

function session(id: string, sent: string[]): AgentSession {
  return {
    id, runtimeId: 'kiro', owner: chatOwner(id), getHistory: () => [], getPendingAssistant: () => undefined,
    send: (text: string) => { sent.push(text); return iterate([{ kind: 'turn_end', stopReason: 'end_turn' }]); },
    cancel: () => {},
  } as unknown as AgentSession;
}

function harness() {
  const begun: string[] = [];
  const hub = new ChatHub({
    retentionMs: 100,
    workspaceIdForNode: () => 'ws',
    lookupDurableTurn: () => null,
    memoryInjector: null,
    isAssistantNode: (nodeId) => nodeId === V || nodeId.startsWith('n-cmph-'),
    persistence: { begin: (snapshot) => { begun.push(snapshot.turnId); }, checkpoint: () => {}, finalize: () => {} },
  });
  return { hub, begun };
}

async function refused(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof TurnGuardError && error.code === code);
}

describe('ChatHub turn guards for the Companion (§2.5)', () => {
  it('a cmp- turn, a post id included, runs only on its own check-in node', async () => {
    const { hub, begun } = harness();
    const sent: string[] = [];
    for (const turnId of ['cmp-run1', 'cmp-post-run1']) {
      await refused(hub.startRequestedSelfTurn({ chatId: V, nodeId: V, turnId, text: 'hidden note', session: session(V, sent) }), 'reserved_turn_id');
      await refused(hub.startRequestedSelfTurn({ chatId: WORKER, nodeId: WORKER, turnId, text: 'hidden note', session: session(WORKER, sent) }), 'reserved_turn_id');
    }
    for (const turnId of ['cmp-run2', 'cmp-post-run1', 'self-run1', 'req-1']) {
      await refused(hub.startRequestedSelfTurn({ chatId: S, nodeId: S, turnId, text: 'note', session: session(S, sent) }), 'checkin_node');
    }
    assert.deepEqual(begun, [], 'nothing began');
    assert.deepEqual(sent, [], 'no runtime saw a note');
    assert.equal(hub.hasPendingSelfTurn(V), false);
    assert.equal(hub.hasPendingSelfTurn(S), false);

    const started = await hub.startRequestedSelfTurn({ chatId: S, nodeId: S, turnId: 'cmp-run1', text: 'note', session: session(S, sent), memoryContext: null });
    await started.done;
    assert.deepEqual(begun, ['cmp-run1'], 'the check-in turn itself runs');
  });

  it('a cms- follow-up runs only outside the assistant workspace', async () => {
    const { hub, begun } = harness();
    const sent: string[] = [];
    await refused(hub.startRequestedSelfTurn({ chatId: V, nodeId: V, turnId: 'cms-send1', text: 'go on', displayText: 'go on', session: session(V, sent) }), 'reserved_turn_id');
    // A check-in node refuses it first: it runs only its own check-in turn.
    await refused(hub.startRequestedSelfTurn({ chatId: S, nodeId: S, turnId: 'cms-send1', text: 'go on', displayText: 'go on', session: session(S, sent) }), 'checkin_node');
    assert.deepEqual(begun, []);
    const started = await hub.startRequestedSelfTurn({ chatId: WORKER, nodeId: WORKER, turnId: 'cms-send1', text: 'go on', displayText: 'go on', session: session(WORKER, sent) });
    await started.done;
    assert.deepEqual(begun, ['cms-send1']);
    assert.deepEqual(sent, ['go on']);
  });

  it('a user turn never runs on a check-in node nor takes a Companion turn id', async () => {
    const { hub, begun } = harness();
    const sent: string[] = [];
    await refused(hub.startTurn({ chatId: S, nodeId: S, text: 'hi', session: session(S, sent) }), 'checkin_node');
    for (const turnId of ['cmp-run1', 'cmp-post-run1', 'cms-send1']) {
      await refused(hub.startTurn({ chatId: V, nodeId: V, text: 'hi', turnId, session: session(V, sent) }), 'reserved_turn_id');
    }
    assert.deepEqual(begun, []);
    assert.equal(hub.isActive(V), false);
    const ok = await hub.startTurn({ chatId: V, nodeId: V, text: 'hi', turnId: 'turn-user-1', session: session(V, sent) });
    await ok.done;
    assert.deepEqual(begun, ['turn-user-1']);
  });

  it('a turn the runtime starts on its own in a check-in session is stopped and drained, never begun', async () => {
    const { hub, begun } = harness();
    let cancelled = 0;
    let drained = 0;
    const events = (async function* (): AsyncIterableIterator<NormalizedEvent> {
      drained += 1;
      yield { kind: 'chunk', text: 'unrequested work' };
      drained += 1;
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    })();
    hub.startSelfTurn({ chatId: S, nodeId: S, events, cancel: () => { cancelled += 1; } });
    for (let i = 0; i < 5 && hub.hasPendingSelfTurn(S); i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hub.hasPendingSelfTurn(S), false);
    assert.equal(cancelled, 1);
    assert.equal(drained, 2, 'the claimed runtime turn was consumed to its end');
    assert.deepEqual(begun, []);
  });
});
