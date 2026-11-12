/**
 * One ACP models payload, read two ways: the runtime's model catalog
 * (listModels) and a session's live state (getSessionState). The composer
 * prefers the live list for an open chat and the catalog for a new one, and
 * the send path checks the catalog, so both must offer the same reasoning.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultHost } from '../src/core/defaultHost';
import { AcpAgentRuntime } from '../src/adapters/kiro/AcpAgentRuntime';
import { AcpClient, type AcpLaunch } from '../src/adapters/kiro/acpClient';
import type { KiroEngine } from '../src/adapters/kiro/kiroProtocol';

const STANDARD_LAUNCH: AcpLaunch = { bin: '/bin/false', args: () => ['acp'], standardAcp: true };
const select = (id: string, category: string | undefined, currentValue: string, values: string[]) => ({
    id, name: id, type: 'select', currentValue, ...(category ? { category } : {}),
    options: values.map((value) => ({ value, name: value })),
});

const CASES: Array<{ name: string; engine: KiroEngine; launch?: AcpLaunch; models: any[]; configOptions: any[] }> = [
    {
        name: 'Kiro v2: the auto router has no effort',
        engine: 'v2',
        models: [{ modelId: 'auto', name: 'auto' }, { modelId: 'claude-opus-5.5', name: 'Claude Opus 5.5' }],
        configOptions: [],
    },
    {
        name: 'Kiro v3: only a model marked hasEffort has effort',
        engine: 'v3',
        models: [
            { modelId: 'm1', name: 'M1' },
            { modelId: 'm2', name: 'M2', _meta: { kiro: { hasEffort: true, effortLevels: ['low', 'high'], defaultEffortLevel: 'high' } } },
        ],
        configOptions: [select('effortLevel', 'thought_level', 'high', ['low', 'high'])],
    },
    {
        name: "standard ACP: every model has the session's thought levels",
        engine: 'v2',
        launch: STANDARD_LAUNCH,
        models: [{ modelId: 'gemini-4-argon', name: 'Gemini 4 Argon' }, { modelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
        configOptions: [select('model', 'model', 'gemini-4-argon', ['gemini-4-argon']), select('thought_level', 'thought_level', 'low', ['low', 'high'])],
    },
];

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('Kiro model reasoning in the catalog and the live session state', () => {
    for (const { name, engine, launch, models, configOptions } of CASES) it(name, async () => {
        const payload = { currentModelId: models[0].modelId, availableModels: models };
        const rt = new AcpAgentRuntime({ host: createDefaultHost({ logLevel: 'silent' }), bridge: {}, engine, defaultCwd: '/tmp', ...(launch ? { launch } : {}) });
        (rt as any).absorbModels('sid', payload, configOptions);
        const client = new AcpClient('/bin/false', '/tmp', undefined, engine, launch, 'kiro');
        (client as any).sessionInfo.set('sid', { models: payload, configOptions });
        assert.deepEqual(client.getSessionState('sid').availableModels, plain(await rt.listModels()));
    });

    it('reads the same reasoning option the runtime sets', () => {
        const client = new AcpClient('/bin/false', '/tmp', undefined, 'v2', STANDARD_LAUNCH, 'antigravity');
        (client as any).sessionInfo.set('sid', { configOptions: [select('thought_level', undefined, 'high', ['low', 'high'])] });
        assert.equal(client.getSessionState('sid').reasoning, 'high');
    });
});
