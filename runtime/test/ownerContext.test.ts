import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrincipalResolver } from '../src/contract/host';
import { sessionOwnerContext } from '../src/core/ownerContext';
import { interactive } from './owners';

const principal = (enforce: boolean): PrincipalResolver => ({
  resolve: (ownerUserId) => ownerUserId ?? 'local',
  workspaceOwnerMatches: () => true,
  enforceUserOwnership: () => enforce,
});

for (const [enforce, ownerUserId, expected] of [
  [false, null, 'local'],
  [false, 'u1', 'u1'],
  [true, null, null],
  [true, 'u1', 'u1'],
] as const) {
  test(`a session's background work goes to ${expected ?? 'nobody'} (enforced ${enforce}, owner ${ownerUserId})`, () => {
    const owner = interactive('chat-1');
    const context = sessionOwnerContext(principal(enforce), ownerUserId, 'ws-1', owner);
    assert.deepEqual(context, expected === null ? null : { ownerUserId: expected, workspaceId: 'ws-1', owner });
  });
}
