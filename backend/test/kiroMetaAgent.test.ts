import { restrictedChatProfile } from './helpers/restrictedChatProfile';
import { michiTestHost } from './helpers/michiTestHost';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { michiKiroRestrictedAgent } from '../src/agents/kiro/kiroMetaAgent';
/**
 * The Meta agent on Kiro: the generated agent config, catalog normalization
 * and checks for both engines, and AcpAgentRuntime opening a per-toolset worker,
 * shared by that toolset's sessions, whose sessions are each selected,
 * checked and locked. kiro-cli is replaced by an
 * AcpClient whose RPCs are scripted; no real process runs.
 */

import { afterEach, beforeEach, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import {
    KIRO_CHECKIN_SETTINGS, KIRO_META_AGENT_EXTRA_ALLOWED, KIRO_META_AGENT_NAMES, ensureKiroCheckinHome, ensureKiroMetaAgent, isKiroMetaAgentDir,
    kiroCheckinHome, kiroMetaAgentClientOptions, kiroMetaAgentConfig, kiroMetaAgentDir, kiroMetaAgentRunOptions, kiroV2MetaAgentCatalog,
    kiroV3MetaAgentCatalog, verifyKiroMetaAgentCatalog,
} from '../src/agents/kiro/kiroMetaAgent';
import { KiroProcessCapError, AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { MetaAgentGuardError, assertMetaAgentToolCatalog, isMetaAgentGuardError } from '../src/agents/metaAgentGuard';
import { META_AGENT_MAINTENANCE_TOOL_NAMES, MaintenanceRuntimeUnsupportedError, maintenanceToolProfile } from '../src/agents/maintenancePolicy';
import { AssistantRuntimeUnsupportedError, META_AGENT_CHAT_TOOL_NAMES, assistantInstructionsFor, assistantToolProfile } from '../src/assistant/policy';
import { MICHI_ASSISTANT_MARKER } from 'michi-shared';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import { closeDb, initDb } from '../src/services/db';
import { chatOwner } from './helpers/owners';

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;
const michi = (names: readonly string[]) => names.map((name) => ({ source: 'mcp', tag: `@michi/${name}` }));

describe('the generated Kiro agent', () => {
    let dataDir: string;
    beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-meta-')); });
    afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    test('only Michi\'s toolset tools: no built-ins, no user MCP config, no resources, hooks or fs_read', () => {
        const config = kiroMetaAgentConfig('chat', ['read_node', 'list_threads']) as any;
        assert.equal(config.name, KIRO_META_AGENT_NAMES.chat);
        assert.match(config.prompt, /^You are Michi\./);
        assert.deepEqual(config.tools, ['@michi']);
        assert.deepEqual(config.allowedTools, ['@michi/read_node', '@michi/list_threads']);
        assert.deepEqual(config.mcpServers, {});
        assert.equal(config.includeMcpJson, false);
        assert.deepEqual(config.resources, []);
        assert.deepEqual(config.hooks, []);
        assert.deepEqual(config.permissions, { rules: [{ capability: 'mcp', match: ['michi/read_node', 'michi/list_threads'], effect: 'allow' }] });
        assert.doesNotMatch(JSON.stringify(config), /fs_read|fs_write|shell|@builtin|"\*"/);
    });

    test('one directory per toolset inside a .michi folder, rewritten only when the tools change', () => {
        const chat = ensureKiroMetaAgent(dataDir, 'chat', ['read_node']);
        const maintenance = ensureKiroMetaAgent(dataDir, 'maintenance', ['maintenance_no_change']);
        assert.notEqual(chat.dir, maintenance.dir);
        assert.equal(chat.dir, kiroMetaAgentDir(dataDir, 'chat'));
        assert.ok(chat.dir.startsWith(path.resolve(dataDir)) && chat.dir.split(path.sep).includes('.michi'));
        assert.equal(kiroMetaAgentDir(path.join(dataDir, '.michi'), 'chat'), path.join(dataDir, '.michi', 'meta-agent', 'kiro', 'chat'));
        const file = path.join(chat.dir, '.kiro', 'agents', `${chat.agentName}.json`);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).allowedTools, ['@michi/read_node']);
        const stamp = new Date(2000, 0, 1);
        fs.utimesSync(file, stamp, stamp);
        ensureKiroMetaAgent(dataDir, 'chat', ['read_node']);
        assert.equal(fs.statSync(file).mtimeMs, stamp.getTime(), 'an unchanged config is not rewritten');
        ensureKiroMetaAgent(dataDir, 'chat', ['read_node', 'read_page']);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).allowedTools, ['@michi/read_node', '@michi/read_page']);
        assert.deepEqual(fs.readdirSync(path.dirname(file)), [`${chat.agentName}.json`], 'no temp file is left');
    });

    test('v3 preserves caller settings while refusing unexpected builtin tools', () => {
        const env = { HOME: '/h', CALLER_SETTING: 'true' };
        // What the runtime starts kiro-cli with, this process's environment included; the check-in worker's too.
        assert.deepEqual(michiKiroRestrictedAgent.clientOptions('v3', 'michi-meta-agent-memory'), kiroMetaAgentRunOptions('v3', 'michi-meta-agent-memory'));
        const checkinWorker = michiKiroRestrictedAgent.clientOptions('v3', 'michi-meta-agent-chat', { kiroHome: '/k' });
        assert.deepEqual(checkinWorker, kiroMetaAgentRunOptions('v3', 'michi-meta-agent-chat', process.env, { kiroHome: '/k' }));
        assert.equal(checkinWorker.childEnv?.CALLER_SETTING, undefined);
        assert.equal(checkinWorker.childEnv?.KIRO_HOME, '/k');
        const v3 = kiroMetaAgentRunOptions('v3', 'michi-meta-agent-memory', env);
        assert.equal(v3.childEnv?.CALLER_SETTING, 'true', 'caller environment is preserved');
        assert.equal(v3.childEnv?.HOME, '/h');
        // Nothing else: kiroMetaAgentClientOptions' own environment (HOME, Michi mandatory), whatever that keeps.
        const { childEnv: base, ...rest } = kiroMetaAgentClientOptions('v3', 'michi-meta-agent-memory', env);
        assert.deepEqual(v3, { ...rest, childEnv: base });
        assert.deepEqual(kiroMetaAgentRunOptions('v2', 'michi-meta-agent-memory', { HOME: '/h' }), kiroMetaAgentClientOptions('v2', 'michi-meta-agent-memory', { HOME: '/h' }),
            'v2 has no such experiment');
        // The restriction check still refuses the tag should Kiro publish it anyway.
        assert.throws(() => assertMetaAgentToolCatalog({
            runtimeId: 'kiro', profile: maintenanceToolProfile(), extraAllowed: KIRO_META_AGENT_EXTRA_ALLOWED,
            observed: kiroV3MetaAgentCatalog([{ source: 'mcp', tag: '@michi/maintenance_list_tools' }, { source: 'builtin', tag: 'read' }]),
        }), (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'builtin:read');
    });

    test('kiro-cli selects it on v2, preserves the public environment on v3 and rejects permission requests', () => {
        const v2 = kiroMetaAgentClientOptions('v2', 'michi-meta-agent-chat', { HOME: '/h' });
        assert.deepEqual(v2, { extraArgs: ['--agent', 'michi-meta-agent-chat'], childEnv: { HOME: '/h' }, rejectPermissions: true });
        const v3 = kiroMetaAgentClientOptions('v3', 'michi-meta-agent-chat', { HOME: '/h', MICHI_KIRO_PRELOAD_TOOLS: 'false' });
        assert.deepEqual(v3.extraArgs, [], 'v3 rejects --agent');
        assert.deepEqual(v3.childEnv, { HOME: '/h' });
        assert.equal(v3.rejectPermissions, true);
    });

    test("kiro-cli starts without the backend's own environment, by default from this process's", (t) => {
        const env = { HOME: '/h', KIRO_API_KEY: 'fixture-key', MICHI_REMOTE_TOKEN: 'fixture-token', MICHI_DATA_DIR: '/fixture/data', NODE_ENV: 'production' };
        for (const engine of ['v2', 'v3'] as const) {
            assert.deepEqual(Object.keys(kiroMetaAgentClientOptions(engine, 'michi-meta-agent-chat', env).childEnv ?? {}).sort(),
                ['HOME', 'KIRO_API_KEY'], engine);
        }
        const saved = process.env.MICHI_REMOTE_TOKEN;
        t.after(() => { if (saved === undefined) delete process.env.MICHI_REMOTE_TOKEN; else process.env.MICHI_REMOTE_TOKEN = saved; });
        process.env.MICHI_REMOTE_TOKEN = 'fixture-token';
        assert.ok(!('MICHI_REMOTE_TOKEN' in (kiroMetaAgentClientOptions('v2', 'michi-meta-agent-chat').childEnv ?? {})));
    });
});

describe('Kiro catalogs', () => {
    test('v2: Michi tools by name, anything else by source; no list fails closed', () => {
        assert.deepEqual(kiroV2MetaAgentCatalog({ data: { tools: [
            { name: 'read_node', source: 'mcp:michi' }, { name: 'shell', source: 'built-in' }, { name: 'post', source: 'mcp:slack' },
        ] } }), ['read_node', 'built-in:shell', 'mcp:slack:post']);
        assert.deepEqual(kiroV2MetaAgentCatalog({ success: true }), ['(no tool list)']);
    });

    test('v3: @michi/<tool> tags by tool name; builtin and other MCP tags stay visible', () => {
        assert.deepEqual(kiroV3MetaAgentCatalog([
            { source: 'mcp', tag: '@michi/read_node' }, { source: 'builtin', tag: 'read' },
            { source: 'mcp', tag: '@example-tools/get' }, { source: 'mcp', tag: '@michi' },
        ]), ['read_node', 'builtin:read', 'mcp:@example-tools/get', 'mcp:@michi']);
    });
});

interface Script {
    engine: 'v2' | 'v3';
    /** v3: tags Kiro publishes after session/set_mode. */
    tagsAfterMode?: unknown[][];
    /** v3: tags of the default agent, published right after session/new. */
    tagsAfterNew?: unknown[];
    /** v2: the tools command answer. */
    v2Tools?: unknown[];
    /** v2: whether Michi's MCP server reports initialized. */
    v2MichiReady?: boolean;
    currentModeId?: string;
    setModeError?: string;
    /** session/delete fails with this message. */
    deleteError?: string;
    /** Advertise session/close, which reopening a session with other policy presets needs. */
    sessionClose?: boolean;
    /** Native sessions session/list reports; default sid-old. */
    listed?: string[];
}

/** The bucket a scripted kiro-cli files its check-in sessions under (`sessions/<hash>/`). */
const STORE_HASH = '0123456789abcdef';

/**
 * A v3 session as kiro-cli 3.0 stores it (probes P1, P1b): the session
 * directory, the bucket's `.index/.lock` (empty, kept after exit) and
 * `.index/index.json` cache (title included), and the add op in the bucket's
 * index log. Returns the session directory.
 */
function writeKiroStoreSession(home: string, sid: string, workspace: string, hash = STORE_HASH): string {
    const bucket = path.join(home, 'sessions', hash);
    const dir = path.join(bucket, sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(bucket, '.index'), { recursive: true });
    fs.writeFileSync(path.join(bucket, '.index', '.lock'), '');
    const session = { id: sid, title: 'Collected title', agentMode: KIRO_META_AGENT_NAMES.chat, workspacePaths: [workspace], rootPaths: [workspace] };
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session));
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), '{"note":"collected text"}\n');
    const cacheFile = path.join(bucket, '.index', 'index.json');
    const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : { schemaVersion: 2, walkedAtMs: 1, dirMtimeMs: 1, dirNamesHash: 'x', entries: [] };
    cache.entries.push({ ...session, status: 'idle' });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    fs.mkdirSync(path.join(home, 'session-index'), { recursive: true });
    fs.appendFileSync(path.join(home, 'session-index', `${hash}.jsonl`), `${JSON.stringify({ op: 'add', sessionPath: `${hash}/${sid}`, at: 1 })}\n`);
    return dir;
}

/** What kiro-cli 3.0's session/delete does to its store (P1b): the directory and cache entry go, the log records the removal. */
function deleteKiroStoreSession(home: string, sid: string, hash = STORE_HASH): void {
    fs.rmSync(path.join(home, 'sessions', hash, sid), { recursive: true, force: true });
    const cacheFile = path.join(home, 'sessions', hash, '.index', 'index.json');
    if (fs.existsSync(cacheFile)) {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        cache.entries = cache.entries.filter((entry: any) => entry.id !== sid);
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
    }
    fs.appendFileSync(path.join(home, 'session-index', `${hash}.jsonl`), `${JSON.stringify({ op: 'remove', sessionPath: `${hash}/${sid}`, at: 2 })}\n`);
}

function scriptedClient(script: Script) {
    const client = new AcpClient('/bin/false', '/tmp/meta', undefined, script.engine) as any;
    const calls: Array<{ method: string; params: any }> = [];
    let sid = 0;
    client.initialization = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: true, ...(script.sessionClose ? { close: {} } : {}) } } };
    client.isAlive = () => true;
    // No real process: it "runs" until shut down; a test may hold it running.
    let running = true;
    client.processRunning = () => running;
    client.holdProcess = (value: boolean) => { running = value; };
    client.shutdown = async () => { running = false; };
    // Where session/new stores a session (the worker's KIRO_HOME, or wherever a test says
    // kiro-cli put it); unset: no store, ids are `sid-<n>`.
    client.storeHome = undefined as string | undefined;
    client.cancel = async (id: string) => { calls.push({ method: 'session/cancel', params: { sessionId: id } }); return true; };
    const publish = (sessionId: string, tags: unknown[]) => client.dispatch({ method: '_kiro/tools/didChange', params: { sessionId, tags } });
    client.send = async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'session/delete') {
            if (script.deleteError) throw new Error(script.deleteError);
            if (client.storeHome) deleteKiroStoreSession(client.storeHome, params.sessionId);
            return {};
        }
        if (method === 'session/new' || method === 'session/load') {
            const n = sid++;
            const sessionId = method === 'session/load' ? params.sessionId
                : client.storeHome ? `sess_00000000-0000-4000-8000-${String(n).padStart(12, '0')}` : `sid-${n}`;
            if (method === 'session/new' && client.storeHome) writeKiroStoreSession(client.storeHome, sessionId, client.storeWorkspace ?? params.cwd);
            // Real v3 publishes the default agent's catalog before answering session/new.
            if (script.engine === 'v3' && script.tagsAfterNew) publish(sessionId, script.tagsAfterNew);
            setImmediate(() => {
                if (script.engine === 'v2' && script.v2MichiReady !== false) {
                    client.dispatch({ method: '_kiro.dev/mcp/server_initialized', params: { sessionId, serverName: 'michi' } });
                }
            });
            return { ...(method === 'session/new' ? { sessionId } : {}), modes: { currentModeId: script.currentModeId ?? 'kiro_default' } };
        }
        if (method === 'session/set_mode') {
            if (script.setModeError) throw new Error(script.setModeError);
            let delay = 5;
            for (const tags of script.tagsAfterMode ?? []) { setTimeout(() => publish(params.sessionId, tags), delay); delay += 5; }
            return {};
        }
        if (method === 'session/list') return { sessions: (script.listed ?? ['sid-old']).map((sessionId) => ({ sessionId, cwd: params.cwd })) };
        if (method === '_kiro.dev/commands/execute') return { success: true, data: { tools: script.v2Tools ?? [] } };
        return {};
    };
    return { client: client as AcpClient, calls, publish };
}

function makeRegistry() {
    const slots = new Map<string, any>();
    let next = 0;
    return {
        slots,
        get: (id: string) => slots.get(id),
        dispose: async (id: string) => { slots.delete(id); },
        create: (parentChatId: string, cwd: string, ownerUserId: string | null, cbs: any, opts?: any) => {
            const slot = { slotId: `slot-${next++}`, parentChatId, cwd, ownerUserId, ...cbs, ...opts };
            slots.set(slot.slotId, slot);
            return slot;
        },
    };
}

describe('verifyKiroMetaAgentCatalog', () => {
    const run = async (script: Script, profile = restrictedChatProfile(), timeoutMs = 2_000) => {
        const { client } = scriptedClient(script);
        const { sessionId } = await client.newSession([]);
        const since = client.toolCatalog(sessionId)?.seq ?? 0;
        if (script.engine === 'v3') await client.setMode(sessionId, KIRO_META_AGENT_NAMES.chat);
        return verifyKiroMetaAgentCatalog({ client, sessionId, engine: script.engine, runtimeId: 'kiro', profile, sinceSeq: since, timeoutMs, settleMs: 50 });
    };

    test('v3: the settled catalog after the switch, with only Michi tools, passes', async () => {
        const observed = await run({ engine: 'v3', tagsAfterNew: [{ source: 'builtin', tag: 'shell' }], tagsAfterMode: [[], michi(['read_node', 'list_threads'])] });
        assert.deepEqual(observed, ['read_node', 'list_threads']);
    });

    test('v3: one extra tag, builtin or not in the toolset, throws MetaAgentGuardError', async () => {
        await assert.rejects(run({ engine: 'v3', tagsAfterMode: [[...michi(['read_node']), { source: 'builtin', tag: 'read' }]] }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'builtin:read');
        await assert.rejects(run({ engine: 'v3', tagsAfterMode: [michi(['read_node', 'send_to_thread'])] }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'send_to_thread');
        await assert.rejects(run({ engine: 'v3', tagsAfterMode: [michi(['read_node']), [...michi(['read_node']), { source: 'mcp', tag: '@example-tools/x' }]] }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'mcp:@example-tools/x',
            'a later catalog before it settles counts');
    });

    test('v3: no catalog after the switch fails closed within the timeout', async () => {
        await assert.rejects(run({ engine: 'v3', tagsAfterNew: michi(['read_node']), tagsAfterMode: [] }, restrictedChatProfile(), 100),
            (error: unknown) => isMetaAgentGuardError(error) && /no tool catalog/.test((error as Error).message),
            'the default agent\'s catalog from before the switch is not accepted');
        await assert.rejects(run({ engine: 'v3', tagsAfterMode: [[]] }, restrictedChatProfile(), 150),
            (error: unknown) => isMetaAgentGuardError(error) && /none of the Michi tools/.test((error as Error).message));
    });

    test('v2: the tools command lists only Michi tools, or the run fails', async () => {
        assert.deepEqual(await run({ engine: 'v2', v2Tools: [{ name: 'read_node', source: 'mcp:michi' }] }), ['read_node']);
        await assert.rejects(run({ engine: 'v2', v2Tools: [{ name: 'read_node', source: 'mcp:michi' }, { name: 'fs_read', source: 'built-in' }] }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'built-in:fs_read');
        await assert.rejects(run({ engine: 'v2', v2Tools: [], v2MichiReady: false }, restrictedChatProfile(), 100),
            (error: unknown) => isMetaAgentGuardError(error) && /none of the Michi tools/.test((error as Error).message));
    });

});

describe('AcpAgentRuntime Meta agent sessions', () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-meta-rt-'));
        process.env.MICHI_DATA_DIR = tmpDir;
        closeDb();
        initDb();
    });
    afterEach(() => {
        closeDb();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * `storeAt`: where the scripted kiro-cli stores a check-in worker's
     * sessions, given that worker's KIRO_HOME. Default: that KIRO_HOME, as
     * kiro-cli 3.0 does through the toolbox shim (P1b).
     */
    function setup(t: TestContext, script: Script, ordinary = false, storeAt: (kiroHome: string) => string = (kiroHome) => kiroHome) {
        const scripted = scriptedClient(script);
        const opened: Array<{ cwd: string; options: unknown; runtime: any }> = [];
        t.mock.method(AcpAgentRuntime.prototype, 'ensureClient', async function (this: any, cwd: string) {
            if (!ordinary && !this.runtimeOptions.metaAgent) throw new Error('an ordinary client was asked for');
            const options = this.clientOptions();
            opened.push({ cwd, options, runtime: this });
            const kiroHome = options?.childEnv?.KIRO_HOME;
            (scripted.client as any).storeHome = kiroHome ? storeAt(kiroHome) : undefined;
            (scripted.client as any).storeWorkspace = cwd;
            this.pool.set(cwd, scripted.client);
            return scripted.client;
        });
        const registry = makeRegistry();
        const runtime = new AcpAgentRuntime({ host: michiTestHost(), bridge: bridge, mcpSlots: fakeMcpRegistry(registry as any, { mcpPort: 9999 }), defaultCwd: '/tmp/default', modelCache: undefined, restrictedAgent: michiKiroRestrictedAgent, ...({ engine: script.engine, sidecarTitles: false }) });
        t.after(() => runtime.shutdown());
        /** The text of each session/prompt sent, in order. */
        const prompts = () => scripted.calls.filter((call) => call.method === 'session/prompt').map((call) =>
            call.params.prompt.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('\n'));
        return { ...scripted, registry, runtime, opened, prompts };
    }

    test('interactive Assistant accepts the ordinary Kiro catalog', async (t) => {
        const env = setup(t, { engine: 'v3', tagsAfterNew: [
            { source: 'builtin', tag: 'shell' },
        ] }, true);
        const session = await env.runtime.newSession({ sessionId: 'n-chat-open', cwd: tmpDir, toolProfile: assistantToolProfile() });
        assert.equal((session as any).cwd, tmpDir);
        assert.ok(!env.calls.some((call) => call.method === 'session/set_mode'));
        assert.equal(env.opened[0].options, undefined);
        assert.equal([...env.registry.slots.values()][0].restricted, undefined);
    });

    test('a new Assistant chat opens with the assistant\'s instructions, not the chat preamble, and no follow-ups', async (t) => {
        const env = setup(t, { engine: 'v3' }, true);
        const session = await env.runtime.newSession({ sessionId: 'n-assistant-new', cwd: tmpDir, toolProfile: assistantToolProfile(), bootstrapInstructions: assistantInstructionsFor('main') });
        assert.equal((session as any).getEnableFollowUps(), false);
        for await (const _event of session.send('What changed today?')) { /* drain */ }
        const [first] = env.prompts();
        assert.ok(first.startsWith(MICHI_ASSISTANT_MARKER), first.slice(0, 200));
        assert.doesNotMatch(first, /\[FOLLOW-UP 1\/3|spawn_branches|save_artifact/);
    });

    test('resuming an old restricted Assistant reconstructs history instead of retaining the closed agent', async (t) => {
        const env = setup(t, { engine: 'v3', currentModeId: KIRO_META_AGENT_NAMES.chat }, true);
        await assert.rejects(env.runtime.loadSession({ sessionId: 'sid-old', nodeId: 'n-old-open', nativeEngine: 'v3', cwd: tmpDir, toolProfile: assistantToolProfile() }), /retired restricted profile/);
        assert.equal(env.registry.slots.size, 0);
    });

    test('a restored Assistant or primary Agent chat keeps its tool profile: no chat reminders, no Approve for me', async (t) => {
        const env = setup(t, { engine: 'v3', sessionClose: true, listed: ['sid-assistant', 'sid-agent'] }, true);
        env.runtime.host.permissions.mode = () => 'ask';
        env.runtime.host.permissions.approveForMe = () => true;
        const loads = () => env.calls.filter((call) => call.method === 'session/load');
        const assistant = await env.runtime.loadSession({ sessionId: 'sid-assistant', nodeId: 'n-assistant', nativeEngine: 'v3', cwd: tmpDir, toolProfile: assistantToolProfile() });
        for await (const _event of assistant.send('Continue.')) { /* drain */ }
        assert.doesNotMatch(env.prompts()[0], /set_branch_overview|\[FOLLOW-UP/);
        const agent = await env.runtime.loadSession({ sessionId: 'sid-agent', nodeId: 'n-agent', nativeEngine: 'v3', cwd: tmpDir, toolProfile: { allowedToolNames: ['read_node'] } });
        for await (const _event of agent.send('Continue.')) { /* drain */ }
        assert.equal(env.prompts().length, 2);
        assert.ok(!env.calls.some((call) => call.method === 'session/close'), 'tool-profile sessions keep Kiro defaults');
        assert.deepEqual(loads().map((call) => call.params._meta?.kiro?.policyPreset), [undefined, undefined]);
        assert.deepEqual(env.runtime.policyPresetsFor(chatOwner('n-chat'), null), ['approve-for-me'], 'an ordinary chat still gets it');
    });

    test('a chat session runs in its own kiro-cli and agent directory, selected and checked before it is returned', async (t) => {
        const env = setup(t, { engine: 'v3', tagsAfterNew: [{ source: 'builtin', tag: 'shell' }], tagsAfterMode: [[], michi(['read_node', 'list_threads'])] });
        const session = await env.runtime.newSession({ sessionId: 'n-chat', cwd: '/home/u/assistant', toolProfile: restrictedChatProfile() }) as any;
        const dir = kiroMetaAgentDir(tmpDir, 'chat');
        assert.equal(env.opened.length, 1);
        assert.equal(env.opened[0].cwd, dir, 'never the chat\'s own cwd or the shared pool');
        assert.deepEqual(env.opened[0].options, kiroMetaAgentRunOptions('v3', KIRO_META_AGENT_NAMES.chat));
        assert.ok(fs.existsSync(path.join(dir, '.kiro', 'agents', `${KIRO_META_AGENT_NAMES.chat}.json`)));
        const methods = env.calls.map((call) => call.method);
        assert.ok(methods.indexOf('session/new') < methods.indexOf('session/set_mode'));
        assert.equal(env.calls.find((call) => call.method === 'session/set_mode')!.params.modeId, KIRO_META_AGENT_NAMES.chat);
        const server = env.calls.find((call) => call.method === 'session/new')!.params.mcpServers[0];
        assert.deepEqual(server.headers, [], 'Kiro HTTP MCP entries need headers: []');
        const slot = [...env.registry.slots.values()][0];
        assert.equal(slot.restricted, true);
        assert.equal(slot.maintenance, undefined);
        assert.deepEqual([...slot.exposedToolNames].sort(), [...META_AGENT_CHAT_TOOL_NAMES].sort());
        assert.equal(slot.isServing(), true);
        assert.equal(slot.parentChatId, session.nativeSessionId);
        assert.equal(session.cwd, dir);
        assert.ok(env.runtime.getBinding('n-chat'));
        assert.equal(session.getEnableFollowUps(), false);

        await assert.rejects(async () => { for await (const _ of session.send('/agent swap kiro_default')) { /* none */ } }, /commands are off/);
        assert.deepEqual(await session.executeCommand('agent', { value: 'kiro_default' }), { success: false, message: 'Kiro commands are off in the check-in session.' });
        await assert.rejects(session.setMode('kiro_default'), /cannot switch/);
        await assert.rejects(env.runtime.forkSession({ sessionId: 'n-fork', cwd: '/x', sourceNativeSessionId: 's', toolProfile: restrictedChatProfile() }),
            NativeResumeUnavailableError);

        // A later catalog with a built-in stops its tools, cancels the turn and fails the next send.
        env.publish(session.nativeSessionId, [...michi(['read_node']), { source: 'builtin', tag: 'write' }]);
        assert.equal(slot.isServing(), false);
        assert.ok(env.calls.some((call) => call.method === 'session/cancel'));
        await assert.rejects(async () => { for await (const _ of session.send('hello')) { /* none */ } }, MetaAgentGuardError);
    });


    test('a catalog with one extra tool refuses the session, releases its slot and stops its kiro-cli', async (t) => {
        const env = setup(t, { engine: 'v3', tagsAfterMode: [[...michi(['read_node']), { source: 'builtin', tag: 'read' }]] });
        await assert.rejects(env.runtime.newSession({ sessionId: 'n-bad', cwd: '/x', toolProfile: restrictedChatProfile() }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.runtimeId === 'kiro'
                && error.violation.toolset === 'chat' && error.violation.unexpectedTools.join() === 'builtin:read');
        assert.equal(env.registry.slots.size, 0);
        assert.equal((env.runtime as any).sessionWorkers.size, 0);
        assert.equal(env.opened[0].runtime.closing, true, 'its worker, and so its kiro-cli, is shut down');
        assert.equal(env.runtime.getBinding('n-bad'), undefined);
    });

    test('fresh, repeated and restored chat turns contain no title, follow-up or overview instructions', async (t) => {
        const env = setup(t, { engine: 'v3', tagsAfterMode: [michi(['read_node'])] });
        const fresh = await env.runtime.newSession({ sessionId: 'n-plain-replies', cwd: '/x', toolProfile: restrictedChatProfile(), enableFollowUps: true });
        for (const message of ['Summarize this page.', 'What changed?']) {
            for await (const _event of fresh.send(message)) { /* drain */ }
        }
        const restored = await env.runtime.loadSession({ sessionId: 'sid-old', nodeId: 'n-restored-replies', nativeEngine: 'v3', cwd: '/x', toolProfile: restrictedChatProfile(), enableFollowUps: true });
        for await (const _event of restored.send('Continue.')) { /* drain */ }
        const prompts = env.calls.filter((call) => call.method === 'session/prompt').map((call) =>
            call.params.prompt.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('\n'));
        assert.equal(prompts.length, 3);
        assert.match(prompts[0], /^You are Michi,/);
        for (const prompt of prompts) {
            assert.doesNotMatch(prompt, /\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:|set_branch_overview|set_follow_ups|MICHI_METADATA_DONE/);
        }
    });

    test('a Kiro agent that cannot be selected fails the check', async (t) => {
        const env = setup(t, { engine: 'v3', setModeError: 'unknown mode' });
        await assert.rejects(env.runtime.newSession({ sessionId: 'n-mode', cwd: '/x', toolProfile: restrictedChatProfile() }),
            (error: unknown) => isMetaAgentGuardError(error) && /did not select the check-in agent/.test((error as Error).message));
    });

    test('v2 maintenance: --agent picks the agent, the tools command is checked, its slot is the maintenance catalog', async (t) => {
        const env = setup(t, {
            engine: 'v2', currentModeId: KIRO_META_AGENT_NAMES.maintenance,
            v2Tools: [{ name: 'maintenance_read_source', source: 'mcp:michi' }, { name: 'maintenance_no_change', source: 'mcp:michi' }],
        });
        const session = await env.runtime.newSession({
            sessionId: 'n-maint', cwd: '/x', workspaceId: 'ws-1', ownerUserId: null, toolProfile: maintenanceToolProfile(),
        }) as any;
        assert.deepEqual((env.opened[0].options as any).extraArgs, ['--agent', KIRO_META_AGENT_NAMES.maintenance]);
        assert.equal(env.opened[0].cwd, kiroMetaAgentDir(tmpDir, 'maintenance'));
        assert.ok(!env.calls.some((call) => call.method === 'session/set_mode'), 'already selected by --agent');
        assert.ok(env.calls.some((call) => call.method === '_kiro.dev/commands/execute' && call.params.command.command === 'tools'));
        const slot = [...env.registry.slots.values()][0];
        assert.equal(slot.maintenance, true);
        assert.equal(slot.assistant, undefined);
        assert.deepEqual([...slot.exposedToolNames], [...META_AGENT_MAINTENANCE_TOOL_NAMES]);
        assert.equal(slot.getActiveMaintenanceExecutionContext(), null);
        assert.equal(session.getEnableFollowUps(), false);
        await assert.rejects(async () => { for await (const _ of session.send('maintain')) { /* none */ } }, /missing a valid owner/,
            'a maintenance send needs its trusted context');
        // Named as the person knows it, never "the Meta agent".
        assert.deepEqual(await session.executeCommand('agent', { value: 'kiro_default' }), { success: false, message: 'Kiro commands are off in the Pages upkeep session.' });
        await assert.rejects(session.setMode('kiro_default'), /The Pages upkeep session cannot switch to another Kiro agent/);
    });

    const v2Maintenance: Script = {
        engine: 'v2', currentModeId: KIRO_META_AGENT_NAMES.maintenance,
        v2Tools: [{ name: 'maintenance_read_source', source: 'mcp:michi' }, { name: 'maintenance_no_change', source: 'mcp:michi' }],
    };
    const maintain = (runtime: AcpAgentRuntime, sessionId: string, toolProfile = maintenanceToolProfile()) =>
        runtime.newSession({ sessionId, cwd: '/x', workspaceId: 'ws-1', ownerUserId: null, toolProfile }) as Promise<any>;

    test('maintenance sessions share one kiro-cli with a slot each; the last release stops it after the idle TTL', async (t) => {
        const env = setup(t, v2Maintenance);
        const rt = env.runtime as any;
        rt.idleTtlMs = 20;
        rt.processCap = 1;
        const [a, b] = await Promise.all([maintain(env.runtime, 'n-a'), maintain(env.runtime, 'n-b')]);
        const worker = env.opened[0].runtime;
        assert.equal(env.opened.length, 2);
        assert.ok(env.opened.every((open) => open.runtime === worker), 'one worker, even for sessions opened at once');
        assert.equal(env.runtime.activeProcessCount, 1, 'the second session does not hit a cap of one');
        assert.notEqual(a.nativeSessionId, b.nativeSessionId);
        assert.equal(env.registry.slots.size, 2);

        await env.runtime.releaseSession('n-a');
        assert.equal(worker.closing, false, 'its neighbour keeps the process');
        assert.equal(env.runtime.getBinding('n-a'), undefined);
        assert.ok(env.runtime.getBinding('n-b'));
        await env.runtime.releaseSession('n-b');
        assert.equal(env.registry.slots.size, 0);
        assert.equal(worker.closing, false, 'kept for the idle TTL');
        assert.equal(env.runtime.activeProcessCount, 1);
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(worker.closing, true);
        assert.equal(env.runtime.activeProcessCount, 0);
        await maintain(env.runtime, 'n-c');
        assert.notEqual(env.opened.at(-1)!.runtime, worker, 'a later session starts a new one');
    });

    test('a session whose turn did not stop retires the shared kiro-cli: neighbours finish there, new sessions get a fresh one', async (t) => {
        const env = setup(t, v2Maintenance);
        const a = await maintain(env.runtime, 'n-a');
        await maintain(env.runtime, 'n-b');
        const worker = env.opened[0].runtime;
        t.mock.method(env.client as any, 'needsSessionRecovery', (sid: string) => sid === a.nativeSessionId);
        await env.runtime.releaseSession('n-a');
        assert.equal(worker.closing, false, 'n-b still runs there');
        await maintain(env.runtime, 'n-c');
        const fresh = env.opened.at(-1)!.runtime;
        assert.notEqual(fresh, worker);
        assert.equal(env.runtime.activeProcessCount, 2);
        await env.runtime.releaseSession('n-b');
        assert.equal(worker.closing, true, 'stopped with its last session');
        assert.equal(fresh.closing, false);
        assert.equal(env.runtime.activeProcessCount, 1);
    });

    test('a changed agent config starts a new shared worker and the old one drains', async (t) => {
        const env = setup(t, v2Maintenance);
        await maintain(env.runtime, 'n-a');
        const old = env.opened[0].runtime;
        await maintain(env.runtime, 'n-b', { ...maintenanceToolProfile(), allowedToolNames: [...META_AGENT_MAINTENANCE_TOOL_NAMES, 'maintenance_future_tool'] });
        const next = env.opened.at(-1)!.runtime;
        assert.notEqual(next, old);
        assert.equal(old.closing, false, 'n-a finishes on the old config');
        await env.runtime.releaseSession('n-a');
        assert.equal(old.closing, true);
        assert.equal(next.closing, false);
    });

    test('at the process cap an idle shared worker gives way; one with sessions reports the cap', async (t) => {
        const env = setup(t, v2Maintenance);
        const rt = env.runtime as any;
        rt.processCap = 1;
        await maintain(env.runtime, 'n-a');
        await assert.rejects(rt.ensureProcessSlot(),
            (error: unknown) => error instanceof KiroProcessCapError && /^Kiro process cap \(1\) reached/.test((error as Error).message));
        await env.runtime.releaseSession('n-a');
        const worker = env.opened[0].runtime;
        assert.equal(worker.closing, false);
        await rt.ensureProcessSlot();
        assert.equal(worker.closing, true, 'the idle worker was stopped to make room');
        assert.equal(env.runtime.activeProcessCount, 0);
    });

    test('v2: a built-in in the tools answer refuses the session', async (t) => {
        const env = setup(t, {
            engine: 'v2', currentModeId: KIRO_META_AGENT_NAMES.maintenance,
            v2Tools: [{ name: 'maintenance_no_change', source: 'mcp:michi' }, { name: 'execute_bash', source: 'built-in' }],
        });
        await assert.rejects(env.runtime.newSession({ sessionId: 'n-v2bad', cwd: '/x', workspaceId: 'ws-1', toolProfile: maintenanceToolProfile() }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.toolset === 'maintenance'
                && error.violation.unexpectedTools.join() === 'built-in:execute_bash');
    });

    test('a restored session is selected and checked again', async (t) => {
        const env = setup(t, { engine: 'v3', currentModeId: KIRO_META_AGENT_NAMES.chat, tagsAfterMode: [michi(['read_node'])] });
        const session = await env.runtime.loadSession({ sessionId: 'sid-old', nodeId: 'n-old', nativeEngine: 'v3', cwd: '/x', toolProfile: restrictedChatProfile() }) as any;
        assert.equal(session.nativeSessionId, 'sid-old');
        assert.ok(env.calls.some((call) => call.method === 'session/load'));
        assert.ok(env.calls.some((call) => call.method === 'session/set_mode'), 'v3 always switches, even when the loaded mode matches');
        assert.equal([...env.registry.slots.values()][0].isServing(), true);
    });

    // ---- Companion check-ins: ephemeral sessions (DESIGN-v2 §3.2; probes P1, P1b) ----

    const checkin = (runtime: AcpAgentRuntime, sessionId: string) =>
        runtime.newSession({ sessionId, cwd: '/x', workspaceId: 'ws-assistant', ownerUserId: null, toolProfile: restrictedChatProfile(), ephemeral: true }) as Promise<any>;
    // tagsAfterMode serves only the ordinary sessions: a check-in opened in the agent gets no set_mode.
    const inAgent = { engine: 'v3' as const, currentModeId: KIRO_META_AGENT_NAMES.chat, tagsAfterNew: michi(['read_node']), tagsAfterMode: [michi(['read_node'])] };
    const owner = (key: string) => ({ mode: 'interactive' as const, key });

    test('a check-in opens straight in the restricted agent, on a worker of its own under Michi\'s KIRO_HOME', async (t) => {
        const env = setup(t, inAgent);
        const session = await checkin(env.runtime, 'n-cmph-1');
        const created = env.calls.find((call) => call.method === 'session/new')!;
        assert.equal(created.params._meta?.kiro?.modeId, KIRO_META_AGENT_NAMES.chat, 'Kiro\'s default agent never runs first (P1)');
        assert.ok(!env.calls.some((call) => call.method === 'session/set_mode'), 'opened in the agent: no switch, and its catalog is the one checked');
        assert.equal([...env.registry.slots.values()][0].isServing(), true);
        const home = kiroCheckinHome(tmpDir);
        assert.equal((env.opened[0].options as any).childEnv.KIRO_HOME, home);
        assert.equal((env.opened[0].options as any).rejectPermissions, true);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings', 'cli.json'), 'utf8')), KIRO_CHECKIN_SETTINGS);
        assert.equal(session.cwd, kiroMetaAgentDir(tmpDir, 'chat'));
        assert.equal(env.runtime.descriptor.topology.ephemeralSessions, 'discard-after-release');
        assert.ok(fs.existsSync(path.join(home, 'sessions', STORE_HASH, session.nativeSessionId, 'session.json')), 'stored under Michi\'s KIRO_HOME');
        // P1b: kiro-cli 3.0 exports its agent telemetry unless initialize asks it not to.
        assert.equal((env.opened[0].options as any).telemetryOff, true);
        const checkinClient = new AcpClient('/bin/false', '/tmp/meta', undefined, 'v3', undefined, 'kiro', env.opened[0].options as any) as any;
        assert.deepEqual(checkinClient.profile.clientCapabilities, { _meta: { kiro: { telemetryEnabled: false } } });

        // An ordinary restricted chat keeps its own worker, without KIRO_HOME, switched as before.
        await env.runtime.newSession({ sessionId: 'n-chat-1', cwd: '/x', toolProfile: restrictedChatProfile() });
        assert.notEqual(env.opened[1].runtime, env.opened[0].runtime, 'neither kind retires or shares the other\'s worker');
        assert.equal((env.opened[1].options as any).childEnv.KIRO_HOME, undefined);
        assert.equal((env.opened[1].options as any).telemetryOff, undefined);
        const chatClient = new AcpClient('/bin/false', '/tmp/meta', undefined, 'v3', undefined, 'kiro', env.opened[1].options as any) as any;
        assert.deepEqual(chatClient.profile.clientCapabilities, {});
        assert.equal(env.opened[0].runtime.closing, false);
    });

    test('a check-in Kiro did not store under Michi\'s KIRO_HOME fails closed: guard error, session deleted, nothing bound', async (t) => {
        // As if the launcher had ignored KIRO_HOME and kept the session in the user's ~/.kiro.
        const userKiro = path.join(tmpDir, 'user-home', '.kiro');
        const env = setup(t, inAgent, false, () => userKiro);
        (env.client as any).initialization.agentCapabilities.sessionCapabilities = { list: {}, close: {}, delete: {} };
        await assert.rejects(checkin(env.runtime, 'n-cmph-elsewhere'),
            (error: unknown) => isMetaAgentGuardError(error) && /not store check-in session .* under Michi's KIRO_HOME/.test((error as Error).message));
        const created = env.calls.find((call) => call.method === 'session/new')!;
        assert.ok(created, 'Kiro was asked for the session');
        const deleted = env.calls.filter((call) => call.method === 'session/delete').map((call) => call.params.sessionId);
        assert.equal(deleted.length, 1, 'the session Kiro recorded is deleted from its store');
        assert.deepEqual(fs.readdirSync(path.join(userKiro, 'sessions', STORE_HASH)).filter((name) => name.startsWith('sess_')), []);
        assert.ok(!env.calls.some((call) => call.method === 'session/prompt'));
        assert.equal(env.registry.slots.size, 0, 'no MCP slot is left serving');
        assert.equal((env.runtime as any).sessionWorkers.has('n-cmph-elsewhere'), false);
        assert.equal((env.opened[0].runtime as any).getBindingByNativeSid(deleted[0]), undefined);
    });

    test('a check-in whose session/new Kiro did not open in the agent is switched and checked as before', async (t) => {
        const env = setup(t, { engine: 'v3', tagsAfterNew: [{ source: 'builtin', tag: 'shell' }], tagsAfterMode: [[], michi(['read_node'])] });
        await checkin(env.runtime, 'n-cmph-2');
        assert.equal(env.calls.find((call) => call.method === 'session/set_mode')!.params.modeId, KIRO_META_AGENT_NAMES.chat);
    });

    test('no check-ins on v2 or without the host\'s ephemeral support, and no declaration either', async (t) => {
        const v2 = setup(t, { engine: 'v2', v2Tools: [{ name: 'read_node', source: 'mcp:michi' }] });
        await assert.rejects(checkin(v2.runtime, 'n-cmph-v2'), /no ephemeral sessions/);
        assert.equal(v2.runtime.descriptor.topology.ephemeralSessions, undefined);
        const noPort = new AcpAgentRuntime({ host: michiTestHost(), bridge, mcpSlots: fakeMcpRegistry(makeRegistry() as any, { mcpPort: 9999 }), defaultCwd: '/tmp/default',
            restrictedAgent: { ...michiKiroRestrictedAgent, ephemeral: undefined }, engine: 'v3', sidecarTitles: false });
        t.after(() => noPort.shutdown());
        await assert.rejects(checkin(noPort, 'n-cmph-np'), /no ephemeral sessions/);
        assert.equal(noPort.descriptor.topology.ephemeralSessions, undefined);
        const v3 = setup(t, inAgent, true);
        await assert.rejects(v3.runtime.newSession({ sessionId: 'n-open-eph', cwd: tmpDir, toolProfile: assistantToolProfile(), ephemeral: true }),
            /only for restricted profiles/);
        assert.ok(!v3.calls.some((call) => call.method === 'session/new'), 'refused before any kiro-cli session opens');
    });

    test('discard: deferred while bound, then session/delete through the live check-in worker, then absent', async (t) => {
        const env = setup(t, inAgent);
        (env.client as any).initialization.agentCapabilities.sessionCapabilities = { list: {}, close: {}, delete: {} };
        const session = await checkin(env.runtime, 'n-cmph-3');
        const sid: string = session.nativeSessionId;
        const home = kiroCheckinHome(tmpDir);
        const discard = (nativeSessionId: string | null) =>
            env.runtime.discardNativeSession({ sessionId: 'n-cmph-3', owner: owner('n-cmph-3'), nativeSessionId, cwd: '/x' });
        assert.equal(await discard('sid-x'), 'unsupported', 'a native id that is not sess_<uuid> is never looked up');
        assert.equal(await discard(sid), 'deferred');
        assert.ok(!env.calls.some((call) => call.method === 'session/delete'));
        await env.runtime.releaseSession('n-cmph-3');
        assert.equal(await discard(sid), 'discarded');
        assert.deepEqual(env.calls.filter((call) => call.method === 'session/delete').map((call) => call.params), [{ sessionId: sid }]);
        assert.equal(fs.existsSync(path.join(home, 'sessions', STORE_HASH, sid)), false);
        assert.equal(await discard(sid), 'absent', 'idempotent: Kiro\'s log records the removal, and Kiro is not asked again');
        assert.equal(env.calls.filter((call) => call.method === 'session/delete').length, 1);
        assert.equal(await discard(null), 'absent');
    });

    test('a sid the check-in KIRO_HOME has no trace of is unsupported, never absent, and Kiro is not asked to delete it', async (t) => {
        const env = setup(t, inAgent);
        (env.client as any).initialization.agentCapabilities.sessionCapabilities = { list: {}, close: {}, delete: {} };
        await checkin(env.runtime, 'n-cmph-7');
        await env.runtime.releaseSession('n-cmph-7');
        // An MVP Companion session: it ran in Michi's agent directory but lives in the user's ~/.kiro.
        const mvp = 'sess_00000000-0000-4000-8000-0000000000f1';
        const mvpDir = writeKiroStoreSession(path.join(tmpDir, 'user-home', '.kiro'), mvp, kiroMetaAgentDir(tmpDir, 'chat'));
        assert.equal(await env.runtime.discardNativeSession({ sessionId: 'n-cmph-mvp', owner: owner('n-cmph-mvp'), nativeSessionId: mvp, cwd: '/x' }), 'unsupported');
        assert.ok(!env.calls.some((call) => call.method === 'session/delete'), 'a live worker\'s "deleted" would say nothing about ~/.kiro');
        assert.ok(fs.existsSync(mvpDir), 'never ~/.kiro');
    });

    test('discard never touches a sid a check-in worker still has bound to another node', async (t) => {
        const env = setup(t, inAgent);
        (env.client as any).initialization.agentCapabilities.sessionCapabilities = { delete: {} };
        const session = await checkin(env.runtime, 'n-cmph-4');
        const worker = env.opened[0].runtime as any;
        const sid = 'sess_00000000-0000-4000-8000-000000000004';
        worker.storeBinding({ ...worker.getBindingByNativeSid(session.nativeSessionId), nativeSessionId: sid, publicSessionId: 'n-cmph-other' });
        assert.equal(await env.runtime.discardNativeSession({ sessionId: 'n-cmph-gone', owner: owner('n-cmph-gone'), nativeSessionId: sid, cwd: '/x' }), 'deferred');
        assert.ok(!env.calls.some((call) => call.method === 'session/delete'));
    });

    test('discard with no check-in kiro-cli running removes Michi\'s own session from the real 3.0 store, as session/delete would', async (t) => {
        const env = setup(t, inAgent);
        const home = ensureKiroCheckinHome(tmpDir);
        const ours = 'sess_00000000-0000-4000-8000-00000000000a';
        const neighbour = 'sess_00000000-0000-4000-8000-00000000000b';
        const foreign = 'sess_00000000-0000-4000-8000-00000000000c';
        const oursDir = writeKiroStoreSession(home, ours, kiroMetaAgentDir(tmpDir, 'chat'));
        const neighbourDir = writeKiroStoreSession(home, neighbour, kiroMetaAgentDir(tmpDir, 'chat'));
        const foreignDir = writeKiroStoreSession(home, foreign, '/Users/someone/project', 'fedcba9876543210');
        const discard = (sid: string | null) => env.runtime.discardNativeSession({ sessionId: 'n-cmph-5', owner: owner('n-cmph-5'), nativeSessionId: sid, cwd: '/x' });
        // The bucket's `.index/.lock` is there whether kiro-cli runs or not: it holds nothing back.
        assert.ok(fs.existsSync(path.join(home, 'sessions', STORE_HASH, '.index', '.lock')));
        assert.equal(await discard(ours), 'discarded');
        assert.equal(fs.existsSync(oursDir), false);
        assert.ok(fs.existsSync(neighbourDir));
        const cache = JSON.parse(fs.readFileSync(path.join(home, 'sessions', STORE_HASH, '.index', 'index.json'), 'utf8'));
        assert.deepEqual(cache.entries.map((entry: any) => entry.id), [neighbour], 'the cached entry, title and all, goes too');
        const log = fs.readFileSync(path.join(home, 'session-index', `${STORE_HASH}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(log.filter((op) => op.sessionPath === `${STORE_HASH}/${ours}`).map((op) => op.op), ['add', 'remove'], 'the removal is logged, as Kiro logs its own');
        assert.deepEqual(log.filter((op) => op.sessionPath === `${STORE_HASH}/${neighbour}`).map((op) => op.op), ['add']);
        assert.equal(await discard(foreign), 'unsupported', 'a session that ran outside Michi\'s directories is not Michi\'s to remove');
        assert.ok(fs.existsSync(foreignDir));
        assert.equal(await discard(ours), 'absent');
        assert.equal(await discard('sess_00000000-0000-4000-8000-0000000000ff'), 'unsupported', 'no trace here: not absent');
        assert.equal(await discard('../../sessions'), 'unsupported');
        assert.ok(isKiroMetaAgentDir(tmpDir, kiroMetaAgentDir(tmpDir, 'maintenance')));
        assert.equal(isKiroMetaAgentDir(tmpDir, tmpDir), false);
        // Never ~/.kiro: the runtime looks only under the check-in KIRO_HOME.
        assert.equal(kiroCheckinHome(tmpDir).startsWith(path.resolve(tmpDir)), true);
    });

    test('while a check-in kiro-cli runs, even one being stopped, discard removes no files; once it is gone they go', async (t) => {
        const env = setup(t, { ...inAgent, deleteError: 'Session not found' });
        const session = await checkin(env.runtime, 'n-cmph-6');
        await env.runtime.releaseSession('n-cmph-6');
        const sid: string = session.nativeSessionId;
        const dir = path.join(kiroCheckinHome(tmpDir), 'sessions', STORE_HASH, sid);
        const discard = () => env.runtime.discardNativeSession({ sessionId: 'n-cmph-6', owner: owner('n-cmph-6'), nativeSessionId: sid, cwd: '/x' });
        assert.equal(await discard(), 'deferred', 'no session/delete advertised');
        assert.ok(fs.existsSync(dir));
        (env.client as any).initialization.agentCapabilities.sessionCapabilities = { delete: {} };
        assert.equal(await discard(), 'deferred', 'session/delete failed');
        assert.ok(fs.existsSync(dir));
        // The worker is stopped, but its kiro-cli does not exit yet.
        const runtime = env.runtime as any;
        (env.client as any).shutdown = async () => {};
        await runtime.stopMetaAgentWorker([...runtime.metaAgentWorkers.values()][0]);
        assert.equal(runtime.metaAgentWorkers.size, 0);
        assert.equal(await discard(), 'deferred', 'a stopping kiro-cli still counts');
        assert.ok(fs.existsSync(dir));
        (env.client as any).holdProcess(false);
        assert.equal(await discard(), 'discarded');
        assert.equal(fs.existsSync(dir), false);
    });

    test('any kiro-cli process started on the check-in KIRO_HOME holds the files back, whichever worker it was in', { skip: process.platform === 'win32' }, async (t) => {
        const env = setup(t, inAgent);
        const home = ensureKiroCheckinHome(tmpDir);
        const sid = 'sess_00000000-0000-4000-8000-0000000000a1';
        const dir = writeKiroStoreSession(home, sid, kiroMetaAgentDir(tmpDir, 'chat'));
        // A real process, as kiro-cli would be, in no worker's pool (e.g. one a respawn just took out).
        const fake = path.join(tmpDir, 'fake-kiro-cli');
        fs.writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
        const child = new AcpClient(fake, tmpDir, undefined, 'v3', undefined, 'kiro', { childEnv: { ...process.env, KIRO_HOME: home } });
        child.start();
        t.after(() => child.shutdown().catch(() => {}));
        assert.equal(child.processRunning(), true);
        const discard = () => env.runtime.discardNativeSession({ sessionId: 'n-cmph-8', owner: owner('n-cmph-8'), nativeSessionId: sid, cwd: '/x' });
        assert.equal(await discard(), 'deferred');
        assert.ok(fs.existsSync(dir));
        await child.shutdown();
        assert.equal(child.processRunning(), false);
        assert.equal(await discard(), 'discarded');
        assert.equal(fs.existsSync(dir), false);
    });

    test('a check-in worker rejects the external provider permission requests like any other', () => {
        const options = kiroMetaAgentClientOptions('v3', KIRO_META_AGENT_NAMES.chat, { HOME: '/h' }, { kiroHome: kiroCheckinHome(tmpDir) });
        assert.equal(options.rejectPermissions, true);
        const client = new AcpClient('/bin/false', '/tmp/meta', undefined, 'v3', undefined, 'kiro', options) as any;
        const written: string[] = [];
        client.proc = { stdin: { destroyed: false, write: (text: string) => { written.push(text); return true; } } };
        for (const [id, title] of [[41, 'mcp:example-credentials:get_aws_creds'], [42, '@example-credentials/configure_aws_access']] as const) {
            client.dispatch({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
                sessionId: 'sess_x', toolCall: { toolCallId: `t-${id}`, title },
                options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }],
            } });
        }
        const replies = written.map((line) => JSON.parse(line));
        assert.deepEqual(replies.map((reply) => [reply.id, reply.result?.outcome]), [
            [41, { outcome: 'selected', optionId: 'reject' }], [42, { outcome: 'selected', optionId: 'reject' }],
        ]);
    });

    test('Crew still refuses both toolsets with its own reason', async () => {
        const crew = new AcpAgentRuntime({ host: michiTestHost(), bridge: bridge, mcpSlots: fakeMcpRegistry(makeRegistry() as any, { mcpPort: 9999 }), defaultCwd: '/tmp/default', modelCache: undefined, restrictedAgent: michiKiroRestrictedAgent, ...({
            id: 'crew', engine: 'v2', launch: { bin: '/bin/false', args: () => [] }, sidecarTitles: false,
        }) });
        try {
            await assert.rejects(crew.newSession({ sessionId: 'n', cwd: '/x', toolProfile: maintenanceToolProfile() }),
                (error: unknown) => error instanceof MaintenanceRuntimeUnsupportedError && /Kiro Crew/.test(error.message));
            await assert.rejects(crew.loadSession({ sessionId: 'n', cwd: '/x', toolProfile: restrictedChatProfile() }),
                (error: unknown) => error instanceof AssistantRuntimeUnsupportedError && /Kiro Crew/.test(error.message));
            await assert.rejects(crew.forkSession({ sessionId: 'n', cwd: '/x', sourceNativeSessionId: 's', toolProfile: restrictedChatProfile() }),
                AssistantRuntimeUnsupportedError);
        } finally {
            await crew.shutdown();
        }
    });
});
