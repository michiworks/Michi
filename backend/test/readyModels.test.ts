import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentProviderInfo, AgentRuntime, ModelInfo } from '../src/agents/types';
import type { RuntimeCatalogCache } from '../src/agents/runtimeModelCache';
import { MultiModelError } from '../src/agents/multiModelTool';
import { shortRuntimeLabel } from 'michi-shared';
import { ReadyModelsService } from '../src/services/multiModel/readyModels';

function runtime(id: string, opts: {
  label?: string;
  available?: boolean;
  models?: () => Promise<ModelInfo[]>;
  providers?: AgentProviderInfo[];
}): AgentRuntime {
  return {
    id,
    label: opts.label ?? id,
    capabilities: { providerModels: !!opts.providers, apiKeys: !!opts.providers },
    checkAvailability: () => ({ available: opts.available ?? true }),
    ...(opts.models ? { listModels: opts.models } : {}),
    ...(opts.providers ? { listProviders: async () => opts.providers, verifyProviderKey: async () => ({ ok: true }) } : {}),
  } as unknown as AgentRuntime;
}

function provider(id: string, defaultModel: string): AgentProviderInfo {
  return { id, label: id.toUpperCase(), keyLabel: '', envVars: [], defaultModel, supportsReasoning: false };
}

function cache(seed: Record<string, ModelInfo[]> = {}): RuntimeCatalogCache & { saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    load: () => null,
    save: () => {},
    loadCatalog: (runtimeId, providerId) => {
      const models = seed[`${runtimeId}/${providerId ?? ''}`];
      return models ? { version: 2, runtimeId, updatedAt: 1, contentHash: 'h', models, providers: [] } : null;
    },
    saveCatalog: (runtimeId, data, providerId) => {
      saved.push(`${runtimeId}/${providerId ?? ''}`);
      return { written: true, snapshot: { version: 2, runtimeId, updatedAt: 1, contentHash: 'h', models: data.models, providers: data.providers } };
    },
  };
}

describe('ReadyModelsService', () => {
  test('lists available runtimes only, and only the ready providers of a provider runtime', async () => {
    const service = new ReadyModelsService({
      catalogCache: cache({ 'codex/': [{ id: 'gpt-a', label: 'GPT A', supportedReasoningLevels: ['low', 'high'] }] }),
      runtimes: () => [
        runtime('codex', { label: 'Codex (app-server)', models: async () => { throw new Error('not from cache'); } }),
        runtime('missing', { available: false }),
        runtime('multi', { label: 'Multi (multi-provider)', providers: [provider('one', 'm1'), provider('two', 'm2')], models: async () => [{ id: 'm1' }, { id: 'm2' }] }),
        runtime('keyless', { providers: [provider('none', 'x')] }),
      ],
      readyProviders: (providers) => providers.filter((entry) => entry.id !== 'two' && entry.id !== 'none'),
    });
    const dto = await service.list(null, { runtimeId: 'codex', providerId: null, modelId: 'gpt-a' });
    assert.deepEqual(dto.runtimes.map((entry) => entry.runtimeId), ['codex', 'multi']);
    const [codex, multi] = dto.runtimes;
    assert.equal(codex.label, 'Codex');
    assert.deepEqual(codex.models, [{ modelId: 'gpt-a', label: 'GPT A', reasoningLevels: ['low', 'high'] }]);
    assert.equal(multi.label, 'Multi');
    assert.deepEqual(multi.providers?.map((entry) => entry.providerId), ['one']);
    assert.equal(multi.defaultProviderId, 'one');
    assert.deepEqual(dto.current, { runtimeId: 'codex', providerId: null, modelId: 'gpt-a' });
  });

  test('lists models cache-first, then from the runtime under a timeout', async () => {
    const catalog = cache();
    const service = new ReadyModelsService({
      catalogCache: catalog,
      listTimeoutMs: 50,
      runtimes: () => [
        runtime('fresh', { models: async () => [{ id: 'f1' }] }),
        runtime('slow', { models: () => new Promise(() => {}) }),
      ],
    });
    const dto = await service.list(null);
    assert.deepEqual(dto.runtimes.find((entry) => entry.runtimeId === 'fresh')?.models.map((model) => model.modelId), ['f1']);
    assert.deepEqual(dto.runtimes.find((entry) => entry.runtimeId === 'slow')?.models, [], 'a slow list leaves only the default');
    assert.deepEqual(catalog.saved, ['fresh/']);
  });

  test('resolvePick validates runtime, provider and model', async () => {
    const service = new ReadyModelsService({
      catalogCache: null,
      runtimes: () => [
        runtime('codex', { label: 'Codex', models: async () => [{ id: 'gpt-a', label: 'GPT A' }, { id: 'gpt-b' }] }),
        runtime('empty', { label: 'Empty', models: async () => [] }),
        runtime('multi', { label: 'Multi', providers: [provider('one', 'm1')], models: async () => [{ id: 'm1', label: 'Model one' }] }),
      ],
      readyProviders: (providers) => [...providers],
    });
    assert.deepEqual(await service.resolvePick(null, { runtimeId: 'codex', modelId: 'gpt-a', reasoning: 'high' }), {
      runtimeId: 'codex', providerId: null, modelId: 'gpt-a', reasoning: 'high', runtimeLabel: 'Codex', modelLabel: 'GPT A',
    });
    const anyModel = await service.resolvePick(null, { runtimeId: 'empty', modelId: 'whatever' });
    assert.equal(anyModel.modelId, 'whatever', 'an empty list accepts the pick');
    const multi = await service.resolvePick(null, { runtimeId: 'multi' });
    assert.deepEqual([multi.providerId, multi.modelId, multi.modelLabel], ['one', 'm1', 'Model one']);

    const rejects = async (pick: Parameters<ReadyModelsService['resolvePick']>[1], pattern: RegExp) => {
      await assert.rejects(service.resolvePick(null, pick), (error: unknown) => {
        assert.ok(error instanceof MultiModelError);
        assert.equal(error.code, 'model_unavailable');
        assert.equal(error.status, 409);
        assert.match(error.message, pattern);
        return true;
      });
    };
    await rejects({ runtimeId: 'nope' }, /Ready runtimes: codex, empty, multi/);
    await rejects({ runtimeId: 'codex', modelId: 'gpt-z' }, /gpt-a, gpt-b/);
    await rejects({ runtimeId: 'multi', providerId: 'two' }, /Ready providers: one/);
  });

  test('a long catalog is capped in the list only; picks and the default are checked against all of it', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, label: `Model ${index}` }));
    const service = new ReadyModelsService({
      catalogCache: cache({ 'big/': many, 'multi/far': many, 'multi/odd': many }),
      runtimes: () => [
        runtime('big', { models: async () => many }),
        runtime('multi', { providers: [provider('far', 'm58'), provider('odd', 'custom-default')] }),
      ],
      readyProviders: (providers) => [...providers],
    });
    const dto = await service.list(null);
    assert.equal(dto.runtimes[0].models.length, 40);
    assert.equal(dto.runtimes[1].providers?.find((entry) => entry.providerId === 'far')?.models.length, 40);
    assert.equal((await service.resolvePick(null, { runtimeId: 'big', modelId: 'm55' })).modelLabel, 'Model 55');
    const far = await service.resolvePick(null, { runtimeId: 'multi', providerId: 'far' });
    assert.deepEqual([far.modelId, far.modelLabel], ['m58', 'Model 58']);
    const odd = await service.resolvePick(null, { runtimeId: 'multi', providerId: 'odd' });
    assert.equal(odd.modelId, 'custom-default', 'the default is accepted although the list does not name it');
    await assert.rejects(service.resolvePick(null, { runtimeId: 'multi', providerId: 'odd', modelId: 'other' }), /not available/);
  });

  test('one snapshot serves several picks and the list; caller labels come from the cached catalog', async () => {
    let probes = 0;
    const codex = runtime('codex', { label: 'Codex (app-server)' });
    codex.checkAvailability = () => { probes += 1; return { available: true }; };
    const service = new ReadyModelsService({
      catalogCache: cache({ 'codex/': [{ id: 'gpt-a', label: 'GPT A' }] }),
      runtimes: () => [codex],
    });
    const snapshot = await service.snapshot(null);
    await service.resolvePick(null, { runtimeId: 'codex', modelId: 'gpt-a' }, snapshot);
    await service.resolvePick(null, { runtimeId: 'codex' }, snapshot);
    await service.list(null, undefined, snapshot);
    assert.equal(probes, 1);
    assert.deepEqual(service.labelsFor('codex', null, 'gpt-a'), { runtimeLabel: 'Codex', modelLabel: 'GPT A' });
    assert.deepEqual(service.labelsFor('codex', null, 'gpt-z'), { runtimeLabel: 'Codex', modelLabel: 'gpt-z' });
    assert.deepEqual(service.labelsFor(null, null, null), { runtimeLabel: 'Michi', modelLabel: 'Default model' });
  });

  test('only chat models are ready, one per label: the default wins its label, else the first listed', async () => {
    // Google's catalog as the live check saw it (pi-ai's static list plus the live generateContent list).
    const google: ModelInfo[] = [
      ['gemini-4-argon', 'Gemini 4 Argon'], ['deep-research-preview-04-2026', 'Deep Research Preview (Apr-21-2026)'],
      ['gemini-2.5-computer-use-preview-10-2025', 'Gemini 2.5 Computer Use Preview 10-2025'], ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
      ['gemini-robotics-er-2-preview', 'Gemini Robotics-ER 2 Preview'], ['gemma-4-31b-it', 'Gemma 4 31B IT'],
      ['gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash Preview TTS'], ['gemini-2.5-flash-image', 'Nano Banana'],
      ['gemini-3-pro-image-preview', 'Nano Banana Pro'], ['gemini-3-pro-image', 'Nano Banana Pro'],
      ['gemini-3.5-transcribe', 'Gemini 3.5 Transcribe'], ['lyria-3.5', 'Lyria 3.5'],
      ['antigravity-preview-05-2026', 'Antigravity Agent Preview'], ['antigravity-preview-09-2026', 'Antigravity Agent Preview'],
      ['gemini-3.8-flash', 'Gemini 3.8 Flash'], ['gemini-3.8-flash-preview', 'Gemini 3.8 Flash'],
    ].map(([id, label]) => ({ id, label }));
    const service = new ReadyModelsService({
      catalogCache: cache({ 'pi/google': google, 'solo/': [{ id: 'text-embedding-3', label: 'Embeddings' }, { id: 'chat-1', label: 'Chat' }] }),
      runtimes: () => [
        runtime('pi', { providers: [provider('google', 'gemini-3.8-flash-preview')], models: async () => [] }),
        runtime('solo', { models: async () => [] }),
      ],
      readyProviders: (providers) => [...providers],
    });
    const dto = await service.list(null);
    const pi = dto.runtimes.find((entry) => entry.runtimeId === 'pi')!;
    assert.deepEqual(pi.providers![0].models.map((model) => [model.modelId, model.label]), [
      ['gemini-4-argon', 'Gemini 4 Argon'], ['gemini-2.5-pro', 'Gemini 2.5 Pro'], ['gemma-4-31b-it', 'Gemma 4 31B IT'],
      ['antigravity-preview-05-2026', 'Antigravity Agent Preview'], ['gemini-3.8-flash-preview', 'Gemini 3.8 Flash'],
    ]);
    assert.deepEqual(dto.runtimes.find((entry) => entry.runtimeId === 'solo')!.models.map((model) => model.modelId), ['chat-1']);
    await assert.rejects(service.resolvePick(null, { runtimeId: 'pi', providerId: 'google', modelId: 'lyria-3.5', reasoning: null }),
      (error: unknown) => error instanceof MultiModelError && error.code === 'model_unavailable');
  });

  test('shortRuntimeLabel drops a trailing parenthetical', () => {
    assert.equal(shortRuntimeLabel('Pi (multi-provider)'), 'Pi');
    assert.equal(shortRuntimeLabel('Kiro Crew'), 'Kiro Crew');
    assert.equal(shortRuntimeLabel('(x)'), '(x)');
  });
});
