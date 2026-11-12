import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCrewAcpConfig } from '../src/adapters/crew/acp/main';
import { crewAppName, crewHomeDir } from '../src/adapters/crew/crewLaunch';

test('kiro-cli style --model becomes the default model', () => {
    assert.equal(parseCrewAcpConfig(['acp', '--agent-engine', 'v2', '--model', 'claude-x'], {}).defaultModel, 'claude-x');
    assert.equal(parseCrewAcpConfig(['acp', '--model=claude-y'], {}).defaultModel, 'claude-y');
    assert.equal(parseCrewAcpConfig(['acp', '--model'], {}).defaultModel, undefined);
});

test('memory mode is explicit, validated, and never silently falls back on a typo', () => {
    for (const mode of ['persistent', 'incognito', 'temporary']) {
        assert.equal(parseCrewAcpConfig([], { MICHI_CREW_MEMORY_MODE: ` ${mode} ` }).memoryMode, mode);
    }
    assert.throws(() => parseCrewAcpConfig([], { MICHI_CREW_MEMORY_MODE: 'private' }), /must be persistent, incognito, or temporary/);
});

test('the App and Kiro Crew home default as Michi resolves them, blank values included', () => {
    for (const env of [{}, { MICHI_CREW_APP: '  ', KIROCREW_HOME: ' ' }]) {
        const { gateway } = parseCrewAcpConfig([], env);
        assert.equal(gateway.appName, crewAppName({}));
        assert.equal(gateway.kirocrewHome, crewHomeDir({}));
    }
    const { gateway } = parseCrewAcpConfig([], { MICHI_CREW_APP: ' my-app ', KIROCREW_HOME: ' /crew ' });
    assert.deepEqual([gateway.appName, gateway.kirocrewHome], ['my-app', '/crew']);
});
