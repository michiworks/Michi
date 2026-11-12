import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MULTI_MODEL_LIMITS,
  MULTI_MODEL_SYNTHESIS_LEAF_ID,
  multiModelLatestRunIndex,
  multiModelLeafId,
  multiModelStepsInFlight,
  multiModelStepsReplaceable,
  multiModelStepsRetryable,
  parseMultiModelLeafId,
  parseMultiModelPlanEdit,
  parseMultiModelProposalResult,
  parseMultiModelRunView,
  parseReadyModelsDto,
  trimMultiModelRunView,
  type MultiModelRunView,
  type MultiModelStepStatus,
} from '../src/index';

function fullView(): MultiModelRunView {
  return {
    version: 1,
    phase: 'running',
    title: 'Which cache to use',
    askPreview: 'Also ask Codex and Pi',
    callerNodeId: 'n-caller',
    callerMessageId: 'm-assistant',
    callerRuntimeId: 'claude',
    callerRuntimeLabel: 'Claude Code',
    callerModelLabel: 'Opus',
    permissionMode: 'trust',
    approveForMe: true,
    reviewRounds: 1,
    threads: [
      {
        key: 't1', runtimeId: 'codex', providerId: null, modelId: 'gpt', reasoning: 'high',
        runtimeLabel: 'Codex', modelLabel: 'GPT', context: 'fork', promptPreview: 'Compare the caches.',
        childNodeId: 'n-child', previousChildNodeIds: ['n-old'], late: true, branchGone: true,
        steps: [
          { kind: 'answer', round: 0, status: 'completed', attempt: 1, turnId: 'mm-1-t1-g0-s0-a1', startedAt: 1, endedAt: 2,
            summary: 'Use Redis.', excerpt: 'Use Redis because…' },
          { kind: 'review', round: 1, status: 'running', attempt: 1, turnId: 'mm-1-t1-g0-s1-a1', now: 'Writing the answer', error: 'x' },
        ],
      },
      {
        key: 'a1', runtimeId: 'pi', providerId: 'openai', modelId: null, reasoning: null,
        runtimeLabel: 'Pi', modelLabel: 'Default model', context: 'fresh', promptPreview: 'Compare.',
        removed: true, addedByUser: true, childNodeId: null, steps: [],
      },
    ],
    synthesis: { status: 'completed', turnId: 'mm-1-syn-a1', messageId: 'self-n-caller-mm-1-syn-a1', startedAt: 3, endedAt: 4,
      summary: 'Redis wins.', error: 'none', addenda: 1, lastAddendumStatus: 'failed' },
    totalTokens: 1234,
    startedAt: 1,
    lastMessageId: 'self-n-caller-mm-1-add1-a1',
    settling: true,
  };
}

describe('multi-model leaf ids', () => {
  test('name a row\'s step and read back its thread key and step', () => {
    assert.equal(multiModelLeafId('t1', 0), 't1@0');
    assert.deepEqual(parseMultiModelLeafId(multiModelLeafId('a2', 2)), { key: 'a2', step: 2 });
  });

  test('read nothing from the synthesis leaf or another node id', () => {
    for (const id of [MULTI_MODEL_SYNTHESIS_LEAF_ID, 'answer', 't1@', '@0', 'review-1']) {
      assert.equal(parseMultiModelLeafId(id), null, id);
    }
  });
});

describe('parseMultiModelRunView', () => {
  test('round-trips a full view', () => {
    const view = fullView();
    assert.deepEqual(parseMultiModelRunView(JSON.parse(JSON.stringify(view))), view);
  });

  test('clamps every text field to its limit', () => {
    const long = 'x'.repeat(10_000);
    const raw = fullView() as unknown as Record<string, any>;
    Object.assign(raw, { title: long, askPreview: long, callerRuntimeLabel: long, callerModelLabel: long });
    Object.assign(raw.threads[0], { runtimeLabel: long, modelLabel: long, promptPreview: long });
    Object.assign(raw.threads[0].steps[0], { summary: long, error: long, now: long, excerpt: long, notice: long });
    Object.assign(raw.synthesis, { summary: long, error: long });
    const view = parseMultiModelRunView(raw)!;
    const lengths = {
      title: view.title.length, askPreview: view.askPreview.length,
      callerRuntimeLabel: view.callerRuntimeLabel.length, callerModelLabel: view.callerModelLabel.length,
      runtimeLabel: view.threads[0].runtimeLabel.length, modelLabel: view.threads[0].modelLabel.length,
      promptPreview: view.threads[0].promptPreview.length,
      summary: view.threads[0].steps[0].summary!.length, error: view.threads[0].steps[0].error!.length,
      now: view.threads[0].steps[0].now!.length, excerpt: view.threads[0].steps[0].excerpt!.length,
      notice: view.threads[0].steps[0].notice!.length,
      synthesisSummary: view.synthesis.summary!.length, synthesisError: view.synthesis.error!.length,
    };
    assert.deepEqual(lengths, {
      title: MULTI_MODEL_LIMITS.title, askPreview: MULTI_MODEL_LIMITS.ask,
      callerRuntimeLabel: MULTI_MODEL_LIMITS.label, callerModelLabel: MULTI_MODEL_LIMITS.label,
      runtimeLabel: MULTI_MODEL_LIMITS.label, modelLabel: MULTI_MODEL_LIMITS.label,
      promptPreview: MULTI_MODEL_LIMITS.promptPreview,
      summary: MULTI_MODEL_LIMITS.summary, error: MULTI_MODEL_LIMITS.error,
      now: MULTI_MODEL_LIMITS.now, excerpt: MULTI_MODEL_LIMITS.excerpt,
      notice: MULTI_MODEL_LIMITS.notice,
      synthesisSummary: MULTI_MODEL_LIMITS.summary, synthesisError: MULTI_MODEL_LIMITS.error,
    });
    assert.ok(view.title.endsWith('…'));
  });

  test('drops unknown enums to their defaults and keeps only whitelisted fields', () => {
    const raw = fullView() as unknown as Record<string, any>;
    raw.permissionMode = 'root';
    raw.extra = 'dropped';
    raw.threads[0].context = 'both';
    raw.threads[0].steps[0].status = 'exploded';
    raw.threads[0].steps[0].kind = 'other';
    raw.threads[0].previousChildNodeIds = Array.from({ length: 12 }, (_, i) => `n-${i}`).concat([3 as never]);
    raw.synthesis.status = 'weird';
    raw.synthesis.lastAddendumStatus = 'weird';
    const view = parseMultiModelRunView(raw)!;
    assert.equal(view.permissionMode, 'ask');
    assert.equal('extra' in view, false);
    assert.equal(view.threads[0].context, 'fresh');
    assert.equal(view.threads[0].steps[0].status, 'pending');
    assert.equal(view.threads[0].steps[0].kind, 'answer');
    assert.equal(view.threads[0].previousChildNodeIds!.length, 8);
    assert.equal(view.synthesis.status, 'pending');
    assert.equal(view.synthesis.lastAddendumStatus, undefined);
  });

  test('caps threads at 8 and steps at 1 + reviewRounds; drops threads without a key or runtime', () => {
    const raw = fullView() as unknown as Record<string, any>;
    const thread = raw.threads[0];
    raw.threads = [{ ...thread, key: '' }, { ...thread, runtimeId: undefined },
      ...Array.from({ length: 10 }, (_, i) => ({ ...thread, key: `t${i}` }))];
    raw.reviewRounds = 0;
    const view = parseMultiModelRunView(raw)!;
    assert.deepEqual(view.threads.map((t) => t.key), ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
    assert.ok(view.threads.every((t) => t.steps.length === 1));
    assert.equal(parseMultiModelRunView({ ...raw, reviewRounds: 7 })!.reviewRounds, 2);
    assert.equal(parseMultiModelRunView({ ...raw, reviewRounds: -1 })!.reviewRounds, 0);
    assert.equal(parseMultiModelRunView({ ...raw, reviewRounds: 'two' })!.reviewRounds, 0);
  });

  test('rejects version 2, an unknown phase, a missing callerNodeId or non-array threads', () => {
    const raw = fullView() as unknown as Record<string, unknown>;
    assert.equal(parseMultiModelRunView({ ...raw, version: 2 }), null);
    assert.equal(parseMultiModelRunView({ ...raw, phase: 'paused' }), null);
    assert.equal(parseMultiModelRunView({ ...raw, callerNodeId: undefined }), null);
    assert.equal(parseMultiModelRunView({ ...raw, threads: {} }), null);
    assert.equal(parseMultiModelRunView(null), null);
  });

  test('fills defaults for missing optional values and drops non-finite numbers', () => {
    const view = parseMultiModelRunView({
      version: 1, phase: 'proposed', callerNodeId: 'n', threads: [{ key: 't1', runtimeId: 'codex', steps: [{ status: 'queued', startedAt: Infinity }] }],
    })!;
    assert.equal(view.title, 'Multi-model plan');
    assert.equal(view.callerMessageId, null);
    assert.equal(view.reviewRounds, 0);
    assert.deepEqual(view.synthesis, { status: 'pending' });
    assert.deepEqual(view.threads[0], {
      key: 't1', runtimeId: 'codex', providerId: null, modelId: null, reasoning: null, runtimeLabel: 'codex',
      modelLabel: 'Default model', context: 'fresh', promptPreview: '', childNodeId: null,
      steps: [{ kind: 'answer', round: 0, status: 'queued' }],
    });
  });
});

describe('trimMultiModelRunView', () => {
  const long = 'y'.repeat(2_000);
  const longView = (): MultiModelRunView => {
    const view = fullView();
    view.threads[0].promptPreview = long;
    Object.assign(view.threads[0].steps[0], { summary: long, excerpt: long, error: long, now: long });
    view.synthesis.summary = long;
    return view;
  };

  for (const max of [1_000, 200, 60]) {
    test(`clamps text fields to ${max}, never labels or ids`, () => {
      const view = trimMultiModelRunView(longView(), max);
      const step = view.threads[0].steps[0];
      assert.equal(view.threads[0].promptPreview.length, max);
      for (const key of ['summary', 'excerpt', 'error', 'now'] as const) assert.equal(step[key]!.length, max, key);
      assert.equal(view.synthesis.summary!.length, max);
      assert.equal(view.threads[0].runtimeLabel, 'Codex');
      assert.equal(step.turnId, 'mm-1-t1-g0-s0-a1');
      assert.equal(view.synthesis.messageId, 'self-n-caller-mm-1-syn-a1');
    });
  }

  test('at 0, prompt previews become empty and the optional text is dropped', () => {
    const source = longView();
    const view = trimMultiModelRunView(source, 0);
    const step = view.threads[0].steps[0];
    assert.equal(view.threads[0].promptPreview, '');
    for (const key of ['summary', 'excerpt', 'error', 'now'] as const) assert.equal(key in step, false, key);
    assert.equal('summary' in view.synthesis, false);
    assert.equal(view.synthesis.error, 'none', 'the synthesis error is not trimmed');
    assert.equal(step.status, 'completed');
    assert.equal(source.threads[0].promptPreview, long, 'the input is not mutated');
  });
});

describe('parseMultiModelPlanEdit', () => {
  test('accepts all four ops', () => {
    assert.deepEqual(parseMultiModelPlanEdit({ op: 'remove', key: 't1' }), { op: 'remove', key: 't1' });
    assert.deepEqual(parseMultiModelPlanEdit({ op: 'restore', key: 't1', extra: 1 }), { op: 'restore', key: 't1' });
    assert.deepEqual(parseMultiModelPlanEdit({ op: 'replace', key: 't2', pick: { runtimeId: 'pi', providerId: 'openai', modelId: null } }),
      { op: 'replace', key: 't2', pick: { runtimeId: 'pi', providerId: 'openai', modelId: null } });
    assert.deepEqual(parseMultiModelPlanEdit({ op: 'add', pick: { runtimeId: 'codex', reasoning: 'high' } }),
      { op: 'add', pick: { runtimeId: 'codex', reasoning: 'high' } });
  });

  test('rejects a missing key, an unknown op, a bad pick or strings over 200 chars', () => {
    assert.equal(parseMultiModelPlanEdit({ op: 'remove' }), null);
    assert.equal(parseMultiModelPlanEdit({ op: 'replace', pick: { runtimeId: 'pi' } }), null);
    assert.equal(parseMultiModelPlanEdit({ op: 'rename', key: 't1' }), null);
    assert.equal(parseMultiModelPlanEdit({ op: 'add' }), null);
    assert.equal(parseMultiModelPlanEdit({ op: 'add', pick: { runtimeId: 'pi', modelId: 7 } }), null);
    assert.equal(parseMultiModelPlanEdit({ op: 'remove', key: 'k'.repeat(201) }), null);
    assert.equal(parseMultiModelPlanEdit({ op: 'add', pick: { runtimeId: 'r'.repeat(201) } }), null);
    assert.equal(parseMultiModelPlanEdit({ op: 'add', pick: { runtimeId: 'pi', modelId: 'm'.repeat(201) } }), null);
    assert.ok(parseMultiModelPlanEdit({ op: 'remove', key: 'k'.repeat(200) }));
    assert.equal(parseMultiModelPlanEdit('remove'), null);
  });
});

describe('parseReadyModelsDto', () => {
  test('keeps a valid list and applies the caps', () => {
    const models = Array.from({ length: 50 }, (_, i) => ({ modelId: `m${i}`, label: i === 0 ? 'L'.repeat(200) : undefined }));
    const dto = parseReadyModelsDto({
      version: 1,
      runtimes: Array.from({ length: 15 }, (_, i) => ({
        runtimeId: `r${i}`, label: 'Pi', defaultModelId: 'm0', defaultProviderId: null, models,
        providers: Array.from({ length: 10 }, (_, j) => ({ providerId: `p${j}`, label: 'P', models: [{ modelId: 'x', isDefault: true, reasoningLevels: ['low', 2], defaultReasoning: 'low' }] })),
      })),
      current: { runtimeId: 'r0', providerId: null, modelId: 'm0' },
    })!;
    assert.equal(dto.runtimes.length, 12);
    assert.equal(dto.runtimes[0].models.length, 40);
    assert.equal(dto.runtimes[0].models[0].label.length, MULTI_MODEL_LIMITS.label);
    assert.equal(dto.runtimes[0].models[1].label, 'm1');
    assert.equal(dto.runtimes[0].providers!.length, 8);
    assert.deepEqual(dto.runtimes[0].providers![0].models, [{ modelId: 'x', label: 'x', isDefault: true, reasoningLevels: ['low'], defaultReasoning: 'low' }]);
    assert.deepEqual(dto.current, { runtimeId: 'r0', providerId: null, modelId: 'm0' });
  });

  test('rejects an unusable list and drops entries without ids', () => {
    assert.equal(parseReadyModelsDto({ version: 2, runtimes: [] }), null);
    assert.equal(parseReadyModelsDto({ version: 1 }), null);
    assert.deepEqual(parseReadyModelsDto({ version: 1, runtimes: [{ label: 'x' }, { runtimeId: 'pi', models: [{ label: 'no id' }] }] }),
      { version: 1, runtimes: [{ runtimeId: 'pi', label: 'pi', defaultModelId: null, defaultProviderId: null, models: [] }] });
  });
});

describe('parseMultiModelProposalResult', () => {
  const result = {
    status: 'proposed', runId: 'wfr_abc', nativeId: 'mm_123',
    threads: [{ key: 't1', label: 'Codex · GPT', context: 'fork' }, { label: 'no key' }],
    reviewRounds: 1, next: 'End your turn now.',
  };

  test('accepts a proposal result', () => {
    assert.deepEqual(parseMultiModelProposalResult(result), { ...result, threads: [{ key: 't1', label: 'Codex · GPT', context: 'fork' }] });
  });

  test('rejects other statuses and ids without their prefixes', () => {
    assert.equal(parseMultiModelProposalResult({ ...result, status: 'error' }), null);
    assert.equal(parseMultiModelProposalResult({ ...result, runId: 'abc' }), null);
    assert.equal(parseMultiModelProposalResult({ ...result, nativeId: '123' }), null);
    assert.equal(parseMultiModelProposalResult('{"status":"proposed"}'), null);
  });
});

describe('multi-model row commands by step status', () => {
  const steps = (statuses: MultiModelStepStatus[]) => statuses.map((status) => ({ status }));
  // [statuses, latest run, in flight (Stop), Retry, Replace model]
  const cases: Array<[MultiModelStepStatus[], number, boolean, boolean, boolean]> = [
    [[], -1, false, false, false],
    [['queued'], 0, true, false, false],
    [['running'], 0, true, false, false],
    [['completed', 'waiting'], 1, true, false, false],
    [['completed', 'pending'], 0, false, false, false],
    [['completed', 'failed'], 1, false, true, true],
    [['completed', 'stopped'], 1, false, true, true],
    [['completed', 'cancelled'], 1, false, true, true],
    [['completed', 'interrupted'], 1, false, true, true],
    [['failed', 'pending'], 0, false, true, true],
    [['completed', 'skipped'], 0, false, false, false],
    [['completed', 'skipped', 'skipped'], 0, false, false, false],
    [['failed', 'skipped'], 0, false, true, true],
    [['failed', 'skipped', 'skipped'], 0, false, true, true],
    [['completed', 'completed'], 1, false, false, false],
  ];
  test('the latest run step, and which of Stop, Retry and Replace apply', () => {
    for (const [statuses, ran, inFlight, retry, replace] of cases) {
      const label = statuses.join(',') || '[]';
      assert.equal(multiModelLatestRunIndex(steps(statuses)), ran, label);
      assert.equal(multiModelStepsInFlight(steps(statuses)), inFlight, label);
      assert.equal(multiModelStepsRetryable(steps(statuses)), retry, label);
      assert.equal(multiModelStepsReplaceable(steps(statuses)), replace, label);
    }
  });
});
