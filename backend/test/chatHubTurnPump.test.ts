// The three ways a turn starts (a user turn, a runtime's own turn, a turn the
// backend requests) read the runtime's events the same way.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import type { ChatStreamEvent, DurableTurnSnapshot } from 'michi-shared';

type Script = (stop: () => void) => AsyncIterableIterator<NormalizedEvent>;

interface Outcome {
  status: DurableTurnSnapshot['status'];
  events: ChatStreamEvent[];
}

const STARTS = {
  user: async (hub: ChatHub, chatId: string, script: Script, stop: () => void) => {
    const { done } = await hub.startTurn({ chatId, nodeId: chatId, text: 'go', session: session(chatId, script, stop) });
    await done;
  },
  self: async (hub: ChatHub, chatId: string, script: Script, stop: () => void) => {
    hub.startSelfTurn({ chatId, nodeId: chatId, events: script(stop), cancel: () => {} });
  },
  requested: async (hub: ChatHub, chatId: string, script: Script, stop: () => void) => {
    const { done } = await hub.startRequestedSelfTurn({ chatId, nodeId: chatId, turnId: `turn-${chatId}`, text: 'go', session: session(chatId, script, stop) });
    await done;
  },
} as const;

function session(chatId: string, script: Script, stop: () => void): AgentSession {
  return {
    id: chatId, runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
    send: () => script(stop),
    cancel: () => {},
  };
}

async function run(start: keyof typeof STARTS, chatId: string, script: Script): Promise<Outcome> {
  let finalized!: (snapshot: DurableTurnSnapshot) => void;
  const terminal = new Promise<DurableTurnSnapshot>((resolve) => { finalized = resolve; });
  const hub = new ChatHub({
    retentionMs: 100,
    workspaceIdForNode: () => 'ws-test',
    lookupDurableTurn: () => null,
    persistence: { begin: () => {}, checkpoint: () => {}, finalize: (snapshot) => finalized(snapshot) },
  });
  const events: ChatStreamEvent[] = [];
  hub.subscribeBackground({ send: (_chatId, ev) => events.push(ev), close: () => {}, includeForeground: true });
  await STARTS[start](hub, chatId, script, () => hub.cancel(chatId));
  const snapshot = await terminal;
  await new Promise((resolve) => setImmediate(resolve));
  return { status: snapshot.status, events };
}

const named = (events: ChatStreamEvent[], name: string) => events.filter((ev) => ev.event === name);
const dataOf = (event: ChatStreamEvent | undefined) => event?.data as { stopReason?: string; message?: string } | undefined;

for (const start of Object.keys(STARTS) as Array<keyof typeof STARTS>) {
  describe(`a ${start} turn`, () => {
    it('that ends without turn_end completes with end_turn and one sentinel overview', async () => {
      const outcome = await run(start, `${start}-no-end`, async function* () {
        yield { kind: 'chunk', text: 'Answer.\n\n[BRANCH-OVERVIEW: Summary.]' };
      });
      assert.equal(outcome.status, 'completed');
      assert.equal(dataOf(named(outcome.events, 'done')[0])?.stopReason, 'end_turn');
      assert.deepEqual(named(outcome.events, 'branch_overview').map((ev) => (ev.data as { overview: string }).overview), ['Summary.']);
    });

    it('that ends with turn_end after Stop is cancelled', async () => {
      const outcome = await run(start, `${start}-stopped`, async function* (stop) {
        yield { kind: 'chunk', text: 'partial' };
        stop();
        yield { kind: 'turn_end', stopReason: 'end_turn' };
      });
      assert.equal(outcome.status, 'cancelled');
      assert.equal(dataOf(named(outcome.events, 'done')[0])?.stopReason, 'cancelled');
    });

    it('that fails with a runtime_error during a Stop is cancelled, not an error', async () => {
      const outcome = await run(start, `${start}-error-stopped`, async function* (stop) {
        yield { kind: 'chunk', text: 'partial' };
        stop();
        yield { kind: 'runtime_error', error: 'prompt cancelled' };
      });
      assert.equal(outcome.status, 'cancelled');
      assert.deepEqual(named(outcome.events, 'error'), []);
    });

    it('that needs recovery during a Stop still ends in an error', async () => {
      const outcome = await run(start, `${start}-recovery`, async function* (stop) {
        yield { kind: 'chunk', text: 'partial' };
        stop();
        yield { kind: 'runtime_error', error: 'session lost', recoveryRequired: true };
      });
      assert.equal(outcome.status, 'error');
      assert.equal(dataOf(named(outcome.events, 'error')[0])?.message, 'session lost');
    });

    it('that fails with a runtime_error ends in an error with the message', async () => {
      const outcome = await run(start, `${start}-error`, async function* () {
        yield { kind: 'chunk', text: 'partial' };
        yield { kind: 'runtime_error', error: 'model unavailable' };
      });
      assert.equal(outcome.status, 'error');
      assert.equal(dataOf(named(outcome.events, 'error')[0])?.message, 'model unavailable');
    });
  });
}
