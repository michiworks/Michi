import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRunStatus, isAgentRunTerminal, isValidAgentRunTransition } from '../src/index';

test('an Agent Run is terminal exactly when the state machine leaves it nowhere to go', () => {
  const statuses = Object.values(AgentRunStatus);
  for (const status of statuses) {
    const stuck = statuses.every((next) => !isValidAgentRunTransition(status, next));
    assert.equal(isAgentRunTerminal(status), stuck, status);
  }
});
