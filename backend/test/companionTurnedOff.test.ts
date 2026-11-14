import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PermissionAnswer } from '../src/services/chatPermissionAnswers';
import { stopConversationTurn, type StopConversationDeps } from '../src/services/companion/turnedOff';

type Pending = ReturnType<StopConversationDeps['hub']['getPendingPermission']>;

function fakes({ pending = null, active = true, ownerTurn = true }: { pending?: Pending; active?: boolean; ownerTurn?: boolean } = {}) {
  const calls = { answers: [] as PermissionAnswer[], cancels: [] as string[], sessionCancels: 0 };
  const deps: StopConversationDeps = {
    hub: {
      getPendingPermission: () => pending,
      cancel: (nodeId: string) => { calls.cancels.push(nodeId); return active; },
      isOwnerTurnActive: () => ownerTurn,
    },
    answer: (_nodeId, _user, answer) => { calls.answers.push(answer); return { ok: true, nodeId: 'v' }; },
    session: () => ({ cancel: () => { calls.sessionCancels += 1; } }),
  };
  return { deps, calls };
}

const request = (options: Array<{ optionId: string; name: string; kind: string; disabled?: boolean }>) => ({
  requestId: 7, turnId: 't1', title: 'Run npm test', options,
} as unknown as NonNullable<Pending>);

describe('turning Michi off stops its conversation (Q29 item 4)', () => {
  test('denies the approval it waits for with the card\'s Deny, then stops the turn', async () => {
    const { deps, calls } = fakes({ pending: request([
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ]) });
    assert.deepEqual(await stopConversationTurn('v', null, deps), { denied: true, cancelled: true });
    assert.deepEqual(calls.answers, [{ requestId: 7, optionId: 'reject_once' }]);
    assert.deepEqual(calls.cancels, ['v']);
    assert.equal(calls.sessionCancels, 0, 'the hub stops a turn the user started');
  });

  test('dismisses a request without a Deny, and stops a runtime self-turn through its session', async () => {
    const { deps, calls } = fakes({ pending: request([{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }]), ownerTurn: false });
    await stopConversationTurn('v', null, deps);
    assert.deepEqual(calls.answers, [{ requestId: 7, cancel: true }]);
    assert.equal(calls.sessionCancels, 1);
  });

  test('with nothing running, answers nothing', async () => {
    const { deps, calls } = fakes({ active: false });
    assert.deepEqual(await stopConversationTurn('v', null, deps), { denied: false, cancelled: false });
    assert.deepEqual([calls.answers, calls.sessionCancels], [[], 0]);
  });
});
