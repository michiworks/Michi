import os from 'node:os';
import path from 'node:path';
import type { AgentCapabilities } from '../../contract/types';
import type { SkillScanRoot } from '../../core/skills';
import type { AcpAgentRuntime } from '../kiro/AcpAgentRuntime';
import { createAcpPresetRuntime, type AcpPresetRuntimeOptions } from '../kiro/acpPreset';
import { ANTIGRAVITY_DESCRIPTOR_OVERRIDE } from './antigravityDescriptor';
import { ANTIGRAVITY_KIRO_FLAVOR } from './antigravityFlavor';
import { antigravityAvailability, resolveAntigravityLaunch, type AntigravityAdapterOptions } from './antigravityLaunch';

export interface AntigravityRuntimeOptions extends AcpPresetRuntimeOptions {
    /**
     * Where agy is. A function is called at each spawn and availability
     * check, so installing agy after start takes effect without a restart.
     * Default {}: nothing resolves.
     */
    antigravity?: AntigravityAdapterOptions | (() => AntigravityAdapterOptions);
}

/** Merged over Kiro's capabilities. */
const ANTIGRAVITY_CAPABILITIES: Partial<AgentCapabilities> = {
    // No ACP route to agy's planning or accept-edits modes.
    modes: false,
    permissions: true,
    // The session's `model` config option.
    models: true,
    // The session's `thought_level` config option; agy rejects anything above high.
    reasoning: true,
    supportedReasoningLevels: ['low', 'medium', 'high'],
    // A session's system prompt is its chat's own.
    warmSessions: false,
    nativeResume: true,
    // Kept: nativeResumeSettings (agy forgets model and reasoning on
    // session/load, so both are applied again), saveContext and
    // spawnBranches (Michi's MCP tools).
};

/**
 * agy's own skill folders: the workspace's `.agents/skills` wins over the
 * user's. Skills agy declares in skills.json or plugins, or finds in parent
 * folders, are not listed.
 */
function antigravitySkillRoots(cwd: string): SkillScanRoot[] {
    return [
        { dir: path.join(cwd, '.agents', 'skills'), scope: 'workspace' },
        { dir: path.join(os.homedir(), '.gemini', 'config', 'skills'), scope: 'user' },
    ];
}

/**
 * Antigravity's `agy acp` as an AcpAgentRuntime with id `antigravity`. The preset
 * pins engine v2 (one agy process per cwd, sessions multiplexed), the
 * standard-ACP launch, Antigravity's flavor, descriptor and capabilities, no
 * sidecar titles (agy titles sessions itself), agy's skill folders and an
 * offline check that agy resolves: while it fails, the runtime refuses to
 * spawn agy at all. The pinned members win over the same members of
 * `options`, from untyped callers too. A launch override also keeps the Meta
 * agent off Antigravity.
 */
export function createAntigravityRuntime(options: AntigravityRuntimeOptions): AcpAgentRuntime {
    const { antigravity, ...rest } = options;
    const locations = typeof antigravity === 'function' ? antigravity : () => antigravity ?? {};
    return createAcpPresetRuntime({
        id: 'antigravity',
        label: 'Antigravity',
        flavor: ANTIGRAVITY_KIRO_FLAVOR,
        resolveLaunch: () => resolveAntigravityLaunch(locations()),
        missingMessage: 'Antigravity CLI (agy) not found; set MICHI_ANTIGRAVITY_BIN',
        launch: { standardAcp: true, cancelTimeoutMs: 10_000 },
        descriptorOverride: ANTIGRAVITY_DESCRIPTOR_OVERRIDE,
        capabilitiesOverride: ANTIGRAVITY_CAPABILITIES,
        checkAvailability: () => antigravityAvailability(locations()),
        skillRoots: antigravitySkillRoots,
    }, rest);
}
