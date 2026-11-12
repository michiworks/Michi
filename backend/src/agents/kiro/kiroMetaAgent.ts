/**
 * The Meta agent on Kiro, both engines. kiro-cli trusts the tools of the agent
 * it runs, so Michi writes a dedicated agent config into its own data
 * directory and runs a separate kiro-cli there, where Kiro finds the config as
 * a workspace agent. Michi selects that agent (v2 `--agent`, v3
 * `session/set_mode`), checks the tool catalog Kiro publishes before the first
 * prompt, and rejects every permission request.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MetaAgentToolset } from 'michi-shared';
import type { AcpClient, AcpClientOptions, AcpToolCatalogState } from 'michi-runtime/internal/adapters/kiro/acpClient';
import type { RuntimeToolProfile } from '../types';
import { assertMetaAgentToolCatalog, metaAgentCatalogUnavailable, metaAgentToolsetOf } from '../metaAgentGuard';
import { agentSpawnEnv } from '../agentSpawnEnv';
import type { KiroEngine } from 'michi-runtime/internal/adapters/kiro/kiroProtocol';
import { writeFileAtomicSync } from 'michi-runtime/internal/core/atomicFile';

export const KIRO_META_AGENT_NAMES: Readonly<Record<MetaAgentToolset, string>> = Object.freeze({
    maintenance: 'michi-meta-agent-maintenance',
    chat: 'michi-meta-agent-chat',
    memory: 'michi-meta-agent-memory',
});

const DESCRIPTIONS: Readonly<Record<MetaAgentToolset, string>> = {
    maintenance: 'Michi: Pages upkeep, the background maintenance of Space pages',
    chat: 'Michi: private check-in turns',
    memory: 'Michi: automatic memory extraction',
};

const PROMPT = 'You are Michi. Only the michi tools exist: you cannot read or write files, run commands or reach the network.';


/** The agent config Kiro runs a Meta agent session with: Michi's tools in `toolNames` and nothing else. */
export function kiroMetaAgentConfig(toolset: MetaAgentToolset, toolNames: readonly string[]): Record<string, unknown> {
    const names = [...new Set(toolNames)];
    return {
        name: KIRO_META_AGENT_NAMES[toolset],
        description: DESCRIPTIONS[toolset],
        prompt: PROMPT,
        mcpServers: {},
        tools: ['@michi'],
        allowedTools: names.map((name) => `@michi/${name}`),
        toolsSettings: {},
        resources: [],
        hooks: [],
        includeMcpJson: false,
        // No fs_read rule: one puts a builtin read tag in the v3 catalog.
        permissions: { rules: [{ capability: 'mcp', match: names.map((name) => `michi/${name}`), effect: 'allow' }] },
    };
}

/**
 * The working directory of a toolset's kiro-cli: `<data>/meta-agent/kiro/<toolset>`,
 * inside a `.michi` folder to keep its runtime state separate from projects.
 */
export function kiroMetaAgentDir(dataDir: string, toolset: MetaAgentToolset): string {
    const dir = path.join(path.resolve(dataDir), 'meta-agent', 'kiro', toolset);
    return dir.split(path.sep).includes('.michi') ? dir : path.join(dir, '.michi');
}

/** Write (or keep) the toolset's agent config; returns the directory to run kiro-cli in. */
export function ensureKiroMetaAgent(dataDir: string, toolset: MetaAgentToolset, toolNames: readonly string[]): { dir: string; agentName: string } {
    const dir = kiroMetaAgentDir(dataDir, toolset);
    const agentName = KIRO_META_AGENT_NAMES[toolset];
    const agentsDir = path.join(dir, '.kiro', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
    const file = path.join(agentsDir, `${agentName}.json`);
    const text = `${JSON.stringify(kiroMetaAgentConfig(toolset, toolNames), null, 2)}\n`;
    let current: string | null = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* first write */ }
    if (current !== text) writeFileAtomicSync(file, text);
    return { dir, agentName };
}

/** Public CLI catalog checks accept only the configured Michi tools. */
/** @testonly */
export const KIRO_META_AGENT_EXTRA_ALLOWED: readonly string[] = Object.freeze([]);
export const KIRO_META_AGENT_V3_ENV: Readonly<Record<string, string>> = Object.freeze({});

/**
 * How a restricted agent's kiro-cli starts. The child gets
 * `env` less the backend's own (agentSpawnEnv). `kiroHome` (v3, the check-in
 * worker): kiro-cli's config directory instead of `~/.kiro` (kiroCheckinHome).
 */
export function kiroMetaAgentClientOptions(
    engine: KiroEngine, agentName: string, env: NodeJS.ProcessEnv = process.env, opts: { kiroHome?: string } = {},
): AcpClientOptions {
    const childEnv = agentSpawnEnv(env);
    return {
        extraArgs: engine === 'v2' ? ['--agent', agentName] : [],
        childEnv: engine === 'v3'
            ? { ...childEnv, ...(opts.kiroHome ? { KIRO_HOME: opts.kiroHome } : {}) }
            : childEnv,
        rejectPermissions: true,
    };
}

/**
 * The options Michi's runtime starts a Meta agent's kiro-cli with
 * (michiKiroRestrictedAgent): kiroMetaAgentClientOptions, and on v3, the
 * check-in worker included, with the experiments that add built-in tools off
 * (KIRO_META_AGENT_V3_ENV).
 */
export function kiroMetaAgentRunOptions(
    engine: KiroEngine, agentName: string, env: NodeJS.ProcessEnv = process.env, opts: { kiroHome?: string } = {},
): AcpClientOptions {
    const options = kiroMetaAgentClientOptions(engine, agentName, env, opts);
    return engine === 'v3' ? { ...options, childEnv: { ...options.childEnv, ...KIRO_META_AGENT_V3_ENV } } : options;
}

/**
 * The KIRO_HOME of the kiro-cli that runs Companion check-ins (ephemeral
 * sessions, DESIGN-v2 §2.4/§3.2): `<data>/companion/checkin/kiro-home`.
 * Probe P1: with KIRO_HOME set, kiro-cli 3.0 reads none of `~/.kiro` (the
 * user's global mcp.json, standalone hook files `~/.kiro/hooks/*.json`, which
 * apply to custom agents too, agents, steering, memories) and stores its
 * sessions here; its sign-in stays in `~/Library/Application Support/kiro-cli`.
 * P1b ran a signed-in check-in through the binary findKiroCli() picks (the
 * a CLI wrapper): sessions, index and logs
 * landed here, nothing in `~/.kiro`, and no auth material had to be linked.
 * KIRO_HOME must be absolute and not contain HOME, which this path, inside
 * the data directory, never does unless the data directory is HOME's parent.
 */
export function kiroCheckinHome(dataDir: string): string {
    return path.join(path.resolve(dataDir), 'companion', 'checkin', 'kiro-home');
}

/**
 * kiro-cli settings in the check-in KIRO_HOME. Telemetry cannot be turned
 * off per workspace, and the worker env's KIRO_CONTENT_COLLECTION_ENABLED is
 * overwritten by the launcher; the launcher reads these from
 * `<KIRO_HOME>/settings/cli.json` (P1b, signed in: Kiro logs
 * `acp.content_collection.resolved {"enabled":false}`). `telemetry.enabled`
 * does not stop KAS's OpenTelemetry export: the runtime turns that off at
 * initialize (AcpProcessOptions.telemetryOff).
 */
export const KIRO_CHECKIN_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({
    'telemetry.enabled': false,
    'codeWhisperer.shareCodeWhispererContentWithAWS': false,
});

/** Creates the check-in KIRO_HOME (0700) and sets KIRO_CHECKIN_SETTINGS in its settings, keeping Kiro's own keys; returns it. */
export function ensureKiroCheckinHome(dataDir: string): string {
    const home = kiroCheckinHome(dataDir);
    const settingsDir = path.join(home, 'settings');
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    const file = path.join(settingsDir, 'cli.json');
    let current: Record<string, unknown> = {};
    let text: string | null = null;
    try {
        text = fs.readFileSync(file, 'utf8');
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch { /* first write, or a file Kiro left unreadable: rewritten */ }
    const next = `${JSON.stringify({ ...current, ...KIRO_CHECKIN_SETTINGS }, null, 2)}\n`;
    if (next !== text) writeFileAtomicSync(file, next);
    return home;
}

/** Whether `dir` is one of the Meta agent directories under `dataDir` (a check-in session's workspace). */
export function isKiroMetaAgentDir(dataDir: string, dir: string): boolean {
    const resolved = path.resolve(dir);
    return (Object.keys(KIRO_META_AGENT_NAMES) as MetaAgentToolset[]).some((toolset) => kiroMetaAgentDir(dataDir, toolset) === resolved);
}

/** v2's `tools` command answer in catalog terms: Michi's tools by name, anything else as `<source>:<name>`. */
export function kiroV2MetaAgentCatalog(response: unknown): string[] {
    const tools = (response as { data?: { tools?: unknown } } | null)?.data?.tools;
    if (!Array.isArray(tools)) return ['(no tool list)'];
    return tools.map((tool) => {
        const name = String((tool as { name?: unknown })?.name ?? '(unnamed)');
        const source = String((tool as { source?: unknown })?.source ?? 'unknown');
        return source === 'mcp:michi' ? name : `${source}:${name}`;
    });
}

/** v3's `_kiro/tools/didChange` tags in catalog terms: `@michi/<tool>` by tool name, anything else as `<source>:<tag>`. */
export function kiroV3MetaAgentCatalog(tags: readonly unknown[]): string[] {
    return tags.map((entry) => {
        const source = String((entry as { source?: unknown })?.source ?? 'unknown');
        const tag = String((entry as { tag?: unknown })?.tag ?? '(untagged)');
        return source === 'mcp' && tag.startsWith('@michi/') && tag.length > '@michi/'.length
            ? tag.slice('@michi/'.length) : `${source}:${tag}`;
    });
}

const hasMichiTag = (state: AcpToolCatalogState | undefined) =>
    !!state?.tags && kiroV3MetaAgentCatalog(state.tags).some((name) => !name.includes(':'));

export interface KiroMetaAgentCatalogCheck {
    client: Pick<AcpClient, 'executeCommand' | 'toolCatalog' | 'waitForToolCatalog'>;
    sessionId: string;
    engine: KiroEngine;
    runtimeId: string;
    profile: RuntimeToolProfile;
    /** v3: the catalog seq before the agent switch; only later catalogs count. */
    sinceSeq?: number;
    timeoutMs?: number;
    /** v3: how long the catalog must stay unchanged before it is checked. */
    settleMs?: number;
}

/**
 * Wait for the catalog Kiro publishes for the selected agent and check it
 * against the profile. Throws MetaAgentGuardError on any extra tool, and when
 * no catalog (or none with a Michi tool) arrives within the timeout.
 */
export async function verifyKiroMetaAgentCatalog(input: KiroMetaAgentCatalogCheck): Promise<string[]> {
    const toolset = metaAgentToolsetOf(input.profile);
    if (!toolset) throw new Error('verifyKiroMetaAgentCatalog needs a restricted Michi profile');
    const timeoutMs = input.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    let observed: string[];
    if (input.engine === 'v2') {
        await input.client.waitForToolCatalog(input.sessionId, (state) => !!state?.initializedServers.includes('michi'), left());
        let response: unknown;
        try {
            response = await input.client.executeCommand(input.sessionId, 'tools', {}, Math.max(5_000, left()));
        } catch (error) {
            throw metaAgentCatalogUnavailable(input.runtimeId, toolset,
                `Kiro did not list its tools: ${error instanceof Error ? error.message : String(error)}`);
        }
        observed = kiroV2MetaAgentCatalog(response);
    } else {
        const since = input.sinceSeq ?? 0;
        const settleMs = input.settleMs ?? 1_000;
        let state = await input.client.waitForToolCatalog(input.sessionId, (s) => (s?.seq ?? 0) > since && hasMichiTag(s), left());
        while (state && state.seq > since && Date.now() < deadline) {
            const seq = state.seq;
            const next = await input.client.waitForToolCatalog(input.sessionId, (s) => (s?.seq ?? 0) > seq, Math.min(settleMs, left()));
            if (!next || next.seq === seq) break;
            state = next;
        }
        if (!state?.tags || state.seq <= since) {
            throw metaAgentCatalogUnavailable(input.runtimeId, toolset, `Kiro published no tool catalog within ${Math.round(timeoutMs / 1000)}s of selecting the agent`);
        }
        observed = kiroV3MetaAgentCatalog(state.tags);
    }
    assertMetaAgentToolCatalog({ runtimeId: input.runtimeId, profile: input.profile, observed });
    const michiTools = new Set(input.profile.allowedToolNames ?? []);
    if (!observed.some((name) => michiTools.has(name))) throw metaAgentCatalogUnavailable(input.runtimeId, toolset, 'Kiro listed none of the Michi tools');
    return observed;
}

export const michiKiroRestrictedAgent = {
    isRestrictedMode: (modeId: string) => Object.values(KIRO_META_AGENT_NAMES).includes(modeId),
    ensure: (dataDir: string, toolset: string, names: readonly string[]) => ensureKiroMetaAgent(dataDir, toolset as MetaAgentToolset, names),
    clientOptions: (engine: KiroEngine, agentName: string, opts?: { kiroHome?: string }) =>
        kiroMetaAgentRunOptions(engine, agentName, process.env, opts),
    ephemeral: {
        homeDir: kiroCheckinHome,
        prepareHome: ensureKiroCheckinHome,
        ownsWorkspace: isKiroMetaAgentDir,
    },
    catalog: kiroV3MetaAgentCatalog,

    verify: verifyKiroMetaAgentCatalog,
};
