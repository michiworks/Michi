import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTurnInput, MaintenanceTurnContext } from '../src/contract/types';
import { bindMaintenanceTurn, pageAttributionFor, type MaintenanceBinding } from '../src/core/maintenanceTurn';
import { headless, interactive } from './owners';

const context: MaintenanceTurnContext = {
  workspaceId: 'ws-1', ownerUserId: 'alice', jobId: 'job-1', runId: 'run-1', claimedBy: 'worker-1',
  configRevision: 1, planId: 'plan-1', sources: [],
};
const input: AgentTurnInput = { turnId: 'turn-1', assistantMessageId: 'a-1', maintenanceContext: context };
const binding: MaintenanceBinding = {
  maintenance: true, owner: interactive('chat-1'), workspaceId: 'ws-1', expectedOwnerUserId: 'alice', runtimeLabel: 'Codex',
};
const INVALID = /^Error: Maintenance Codex send is missing a valid owner, workspace, or canonical turn binding$/;

test('a maintenance send is stamped with the turn that executes it, for any host principal', () => {
  assert.deepEqual(bindMaintenanceTurn(input, binding), {
    ...context,
    execution: { nodeId: 'chat-1', turnId: 'turn-1', assistantId: 'a-1', runId: 'run-1' },
  });
});

test('a session that is not a maintenance one sends without a context and refuses one', () => {
  assert.equal(bindMaintenanceTurn({ turnId: 'turn-1' }, { ...binding, maintenance: false }), null);
  assert.equal(bindMaintenanceTurn(undefined, { ...binding, maintenance: false }), null);
  assert.throws(() => bindMaintenanceTurn(input, { ...binding, maintenance: false }),
    /^Error: Maintenance context supplied to a non-maintenance Codex session$/);
});

for (const [label, turn, bound] of [
  ['no context', { ...input, maintenanceContext: undefined }, binding],
  ['no input', undefined, binding],
  ['a headless owner', input, { ...binding, owner: headless('attempt-1') }],
  ['no owner', input, { ...binding, owner: undefined }],
  ['no turn id', { ...input, turnId: undefined }, binding],
  ['no assistant id', { ...input, assistantMessageId: undefined }, binding],
  ['another workspace', input, { ...binding, workspaceId: 'ws-2' }],
  ['another owner user', input, { ...binding, expectedOwnerUserId: 'local-user' }],
  ['no job', { ...input, maintenanceContext: { ...context, jobId: '' } }, binding],
  ['no run', { ...input, maintenanceContext: { ...context, runId: '' } }, binding],
  ['no claim', { ...input, maintenanceContext: { ...context, claimedBy: '' } }, binding],
  ['no plan', { ...input, maintenanceContext: { ...context, planId: '' } }, binding],
  ['a fractional revision', { ...input, maintenanceContext: { ...context, configRevision: 1.5 } }, binding],
  ['revision 0', { ...input, maintenanceContext: { ...context, configRevision: 0 } }, binding],
  ['no sources', { ...input, maintenanceContext: { ...context, sources: undefined as never } }, binding],
] as const) {
  test(`a maintenance send with ${label} is refused`, () => {
    assert.throws(() => bindMaintenanceTurn(turn as AgentTurnInput | undefined, bound as MaintenanceBinding), INVALID);
  });
}

test('only an interactive turn with both ids attributes page edits', () => {
  assert.deepEqual(pageAttributionFor(input, interactive('chat-1')), { turnId: 'turn-1', assistantId: 'a-1' });
  assert.equal(pageAttributionFor(input, headless('attempt-1')), null);
  assert.equal(pageAttributionFor(input, undefined), null);
  assert.equal(pageAttributionFor({ turnId: 'turn-1' }, interactive('chat-1')), null);
  assert.equal(pageAttributionFor(undefined, interactive('chat-1')), null);
});
