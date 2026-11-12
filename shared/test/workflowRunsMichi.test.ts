import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  boundWorkflowRun,
  isWorkflowRunActive,
  isWorkflowRunAwaitingStart,
  parseWorkflowRunDto,
  type MultiModelRunView,
  type WorkflowRunDtoV1,
} from '../src/index';

function view(phase: MultiModelRunView['phase'], promptPreview = 'Compare the caches.'): MultiModelRunView {
  return {
    version: 1, phase, title: 'Caches', askPreview: 'Ask Codex too', callerNodeId: 'n-caller', callerMessageId: 'm-1',
    callerRuntimeId: 'claude', callerRuntimeLabel: 'Claude Code', callerModelLabel: 'Opus', permissionMode: 'ask', reviewRounds: 1,
    threads: [{
      key: 't1', runtimeId: 'codex', providerId: null, modelId: 'gpt', reasoning: null, runtimeLabel: 'Codex', modelLabel: 'GPT',
      context: 'fork', promptPreview, childNodeId: null, steps: [],
    }],
    synthesis: { status: 'pending' },
  };
}

function run(overrides: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_1', runtime: 'michi', nativeId: 'mm_1', workspaceId: 'ws-1', nodeId: 'n-caller', parentToolCallId: null,
    name: 'Caches', status: 'paused', nodes: [], log: [], actions: [], startedAt: 1, updatedAt: 1, revision: 1,
    multiModel: view('proposed'), ...overrides,
  };
}

describe('michi workflow runs', () => {
  test('parseWorkflowRunDto accepts runtime michi with its view', () => {
    const parsed = parseWorkflowRunDto(JSON.parse(JSON.stringify(run())));
    assert.equal(parsed?.runtime, 'michi');
    assert.deepEqual(parsed?.multiModel, view('proposed'));
  });

  test('a michi run without a valid view still parses, without multiModel', () => {
    const missing = parseWorkflowRunDto({ ...run(), multiModel: undefined });
    assert.equal(missing?.runtime, 'michi');
    assert.equal(missing && 'multiModel' in missing, false);
    const invalid = parseWorkflowRunDto({ ...run(), multiModel: { version: 2 } });
    assert.equal(invalid && 'multiModel' in invalid, false);
  });

  test('a view on another runtime is dropped', () => {
    const parsed = parseWorkflowRunDto({ ...run(), runtime: 'claude' });
    assert.equal(parsed?.runtime, 'claude');
    assert.equal(parsed && 'multiModel' in parsed, false);
  });

  test('boundWorkflowRun trims the view under budget and keeps its skeleton', () => {
    const big = run({ multiModel: view('running', 'p'.repeat(200_000)) });
    const bounded = boundWorkflowRun(big, 20_000);
    assert.ok(JSON.stringify(bounded).length <= 20_000);
    assert.equal(bounded.multiModel?.threads[0].key, 't1');
    assert.equal(bounded.multiModel?.threads[0].modelLabel, 'GPT');
    assert.ok(bounded.multiModel!.threads[0].promptPreview.length < 4_000);
    const small = run();
    assert.equal(boundWorkflowRun(small), small, 'a small run is returned as is');
  });

  test('a proposed plan is open but awaiting Start, so it is not active', () => {
    const proposed = run();
    assert.equal(isWorkflowRunAwaitingStart(proposed), true);
    assert.equal(isWorkflowRunActive(proposed), false);
    const running = run({ status: 'running', multiModel: view('running') });
    assert.equal(isWorkflowRunAwaitingStart(running), false);
    assert.equal(isWorkflowRunActive(running), true);
    assert.equal(isWorkflowRunActive(run({ status: 'completed', multiModel: view('completed') })), false);
    const claude = run({ runtime: 'claude', status: 'paused', multiModel: undefined });
    assert.equal(isWorkflowRunAwaitingStart(claude), false);
    assert.equal(isWorkflowRunActive(claude), true, 'a paused Claude workflow is still active work');
  });
});
