/**
 * DESIGN-v2 §3.2: a Companion check-in's turn in its throwaway node S is
 * private. No subscriber of any kind (a window's background feed, with or
 * without foreground turns, or a direct chat subscriber) receives a frame of
 * it, live or in a replay, and getSnapshot does not report it; the turn still
 * runs and persists. A memoryContext the caller gives (a check-in's resident
 * pack, or null for none) is sent as it is, without asking the memory
 * injector. whenTurnSettled reports how a turn ended. Harness hubs, no
 * database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHub, type BackgroundSubscriber, type HubSubscriber } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import type { ChatStreamEvent, DurableTurnSnapshot } from 'michi-shared';
import { chatOwner } from './helpers/owners';

const S = 'n-cmph-run1';
const TURN = 'cmp-run1';

function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** A session whose turn yields `events`, waiting for `wait` (when given) before the last one. */
function sessionFor(id: string, events: NormalizedEvent[], wait?: Promise<void>, sent: Array<{ text: string; input: unknown }> = []): AgentSession {
  return {
    id, runtimeId: 'kiro', owner: chatOwner(id),
    getHistory: () => [], getPendingAssistant: () => undefined,
    async *send(text: string, input?: unknown) {
      sent.push({ text, input });
      for (let index = 0; index < events.length; index += 1) {
        if (wait && index === events.length - 1) await wait;
        yield events[index];
      }
    },
    cancel: () => ({ acknowledged: true }),
  } as unknown as AgentSession;
}

function harness(overrides: {
  finalize?: (snapshot: DurableTurnSnapshot) => void;
  lookup?: (turnId: string) => { turnId: string; nodeId: string; assistantId: string; status: 'active' | 'completed' | 'cancelled' | 'error' } | null;
  memory?: { prepare: (...args: unknown[]) => { text: string; delivered(): void } | null; forget(): void };
} = {}) {
  const begun: string[] = [];
  const finalized: DurableTurnSnapshot[] = [];
  const hub = new ChatHub({
    retentionMs: 60_000,
    workspaceIdForNode: () => 'ws-assistant',
    lookupDurableTurn: overrides.lookup ?? (() => null),
    memoryInjector: overrides.memory ?? null,
    isAssistantNode: () => true,
    persistence: {
      begin: (snapshot) => { begun.push(snapshot.turnId); },
      checkpoint: () => {},
      finalize: (snapshot) => { overrides.finalize?.(snapshot); finalized.push(snapshot); },
    },
  });
  return { hub, begun, finalized };
}

function recorders() {
  const background: Array<{ chatId: string; ev: ChatStreamEvent }> = [];
  const foreground: Array<{ chatId: string; ev: ChatStreamEvent }> = [];
  const direct: ChatStreamEvent[] = [];
  const bg: BackgroundSubscriber = { send: (chatId, ev) => background.push({ chatId, ev }), close() {} };
  const fg: BackgroundSubscriber = { includeForeground: true, send: (chatId, ev) => foreground.push({ chatId, ev }), close() {} };
  const sub: HubSubscriber = { send: (ev) => direct.push(ev), close() {} };
  return { background, foreground, direct, bg, fg, sub };
}

describe('ChatHub private requested self turns (a check-in in its node)', () => {
  it('reaches no background, foreground or direct subscriber, live or replayed, yet runs and persists', async () => {
    const { hub, begun, finalized } = harness();
    const live = recorders();
    hub.subscribeBackground(live.bg);
    hub.subscribeBackground(live.fg);
    hub.subscribe(S, live.sub);
    const sent: Array<{ text: string; input: unknown }> = [];
    const started = await hub.startRequestedSelfTurn({
      chatId: S, nodeId: S, turnId: TURN, text: 'the note',
      session: sessionFor(S, [{ kind: 'chunk', text: 'checked the CRs' }, { kind: 'turn_end', stopReason: 'end_turn' }], undefined, sent),
      private: true, memoryContext: null,
    });
    await started.done;

    assert.deepEqual(sent.map((entry) => entry.text), ['the note'], 'the runtime got the note');
    assert.deepEqual(begun, [TURN]);
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].status, 'completed');
    assert.match(finalized[0].assistantMessage.content, /checked the CRs/, 'the reply is durable for the coordinator to read');
    assert.equal(live.background.length, 0, 'no window feed hears of S');
    assert.equal(live.foreground.length, 0, 'not even one that takes foreground turns');
    assert.equal(live.direct.length, 0, 'nor a direct subscriber of S');

    const replay = recorders();
    hub.subscribeBackground(replay.bg)();
    hub.subscribeBackground(replay.fg)();
    hub.subscribeBackground(replay.fg, { cursors: { [S]: { turnId: TURN, seq: 0 } } })();
    hub.subscribe(S, replay.sub)();
    assert.equal(replay.background.length, 0, 'a reconnecting window replays nothing of S');
    assert.equal(replay.foreground.length, 0);
    assert.equal(replay.direct.length, 0);
    assert.equal(hub.getSnapshot(S), null, 'no pane or tool observes it');
  });

  it('every turn of a check-in node is private, flag or not; a private flag hides a turn elsewhere too', async () => {
    const { hub } = harness();
    const live = recorders();
    hub.subscribeBackground(live.fg);
    const unflagged = await hub.startRequestedSelfTurn({
      chatId: S, nodeId: S, turnId: TURN, text: 'note',
      session: sessionFor(S, [{ kind: 'chunk', text: 'x' }, { kind: 'turn_end', stopReason: 'end_turn' }]), memoryContext: null,
    });
    await unflagged.done;
    assert.equal(live.foreground.length, 0, 'S is private without the flag');

    const flagged = await hub.startRequestedSelfTurn({
      chatId: 'n-elsewhere', nodeId: 'n-elsewhere', turnId: 'req-private', text: 'note',
      session: sessionFor('n-elsewhere', [{ kind: 'chunk', text: 'x' }, { kind: 'turn_end', stopReason: 'end_turn' }]), private: true,
    });
    await flagged.done;
    assert.equal(live.foreground.length, 0, 'the flag hides a turn on any node');

    // Control: the same turn without the flag on an ordinary node is broadcast.
    const visible = await hub.startRequestedSelfTurn({
      chatId: 'n-elsewhere', nodeId: 'n-elsewhere', turnId: 'req-visible', text: 'note',
      session: sessionFor('n-elsewhere', [{ kind: 'chunk', text: 'x' }, { kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    await visible.done;
    assert.deepEqual(live.foreground.map(({ ev }) => ev.event), ['turn_start', 'chunk', 'done']);
    assert.ok(live.foreground.every(({ chatId }) => chatId === 'n-elsewhere'));
  });

  it('Stop on a private turn cancels it without a frame reaching anyone', async () => {
    const { hub } = harness();
    const live = recorders();
    hub.subscribeBackground(live.fg);
    const release = gate();
    const started = await hub.startRequestedSelfTurn({
      chatId: S, nodeId: S, turnId: TURN, text: 'note', private: true, memoryContext: null,
      session: sessionFor(S, [{ kind: 'chunk', text: 'working' }, { kind: 'turn_end', stopReason: 'cancelled' }], release.promise),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hub.cancel(S, TURN), true);
    release.open();
    await started.done;
    assert.equal(await hub.whenTurnSettled(TURN), 'cancelled');
    assert.equal(live.foreground.length, 0);
  });

  it('a memoryContext the caller gives is sent as it is and null sends none, the injector not asked; without one it is; maintenance gets none', async () => {
    let prepared = 0;
    const memory = { prepare: () => { prepared += 1; return { text: 'MEMORY BLOCK', delivered() {} }; }, forget() {} };
    const { hub } = harness({ memory });
    const sent: Array<{ text: string; input: unknown }> = [];
    const run = async (args: { chatId: string; turnId: string; memoryContext?: string | null; maintenance?: boolean }) => {
      const started = await hub.startRequestedSelfTurn({
        chatId: args.chatId, nodeId: args.chatId, turnId: args.turnId, text: 'note',
        session: sessionFor(args.chatId, [{ kind: 'turn_end', stopReason: 'end_turn' }], undefined, sent),
        ...(args.memoryContext !== undefined ? { memoryContext: args.memoryContext } : {}),
        ...(args.maintenance ? { maintenanceContext: { planId: 'plan-1' } as never } : {}),
      });
      await started.done;
      return (sent.at(-1)!.input as { memoryContext?: string }).memoryContext;
    };

    assert.equal(await run({ chatId: S, turnId: TURN, memoryContext: 'RESIDENT PACK' }), 'RESIDENT PACK');
    assert.equal(await run({ chatId: 'n-cmph-run2', turnId: 'cmp-run2', memoryContext: null }), undefined);
    assert.equal(prepared, 0, 'the injector is not asked for a turn that brings its own');
    assert.equal(await run({ chatId: 'n-plain', turnId: 'req-memory' }), 'MEMORY BLOCK');
    assert.equal(prepared, 1);
    assert.equal(await run({ chatId: 'n-upkeep', turnId: 'req-upkeep', memoryContext: 'RESIDENT PACK', maintenance: true }), undefined, 'Pages maintenance carries no Michi Memory');
    assert.equal(prepared, 1);
  });
});

describe('ChatHub.whenTurnSettled', () => {
  it('waits for a running turn and reports its committed end', async () => {
    const { hub } = harness();
    const release = gate();
    const started = await hub.startTurn({
      chatId: 'n-v', nodeId: 'n-v', text: 'hi', turnId: 'turn-user',
      session: sessionFor('n-v', [{ kind: 'chunk', text: 'hello' }, { kind: 'turn_end', stopReason: 'end_turn' }], release.promise),
    });
    let settled: string | null | undefined;
    const waiting = hub.whenTurnSettled('turn-user').then((status) => { settled = status; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, undefined, 'still running');
    release.open();
    await started.done;
    await waiting;
    assert.equal(settled, 'completed');
    assert.equal(await hub.whenTurnSettled('turn-user'), 'completed', 'and at once afterwards');
  });

  it('reports an error end, a failed final write as unknown, and unknown or foreign turns as null', async () => {
    const { hub } = harness({
      finalize: (snapshot) => { if (snapshot.turnId === 'turn-unsaved') throw new Error('disk full'); },
      lookup: (turnId) => turnId === 'turn-old' ? { turnId, nodeId: 'n-v', assistantId: 'a-n-v-turn-old', status: 'completed' }
        : turnId === 'turn-elsewhere' ? { turnId, nodeId: 'n-v', assistantId: 'a-n-v-turn-elsewhere', status: 'active' }
          : null,
    });
    const failed = await hub.startTurn({
      chatId: 'n-v', nodeId: 'n-v', text: 'hi', turnId: 'turn-error',
      session: sessionFor('n-v', [{ kind: 'runtime_error', error: 'boom' } as NormalizedEvent]),
    });
    await failed.done;
    assert.equal(await hub.whenTurnSettled('turn-error'), 'error');

    const unsaved = await hub.startTurn({
      chatId: 'n-w', nodeId: 'n-w', text: 'hi', turnId: 'turn-unsaved',
      session: sessionFor('n-w', [{ kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    await unsaved.done;
    assert.equal(await hub.whenTurnSettled('turn-unsaved'), null, 'its end was never committed');

    assert.equal(await hub.whenTurnSettled('turn-old'), 'completed', 'a turn of an earlier process answers from the database');
    assert.equal(await hub.whenTurnSettled('turn-elsewhere'), null, 'active in the database but not here: unknown');
    assert.equal(await hub.whenTurnSettled('turn-never'), null);
  });
});
