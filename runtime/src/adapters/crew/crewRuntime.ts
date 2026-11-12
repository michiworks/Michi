import os from 'node:os';
import path from 'node:path';
import type { AgentCapabilities } from '../../contract/types';
import type { SkillScanRoot } from '../../core/skills';
import type { AcpAgentRuntime } from '../kiro/AcpAgentRuntime';
import { createAcpPresetRuntime, type AcpPresetRuntimeOptions } from '../kiro/acpPreset';
import { CREW_DESCRIPTOR_OVERRIDE } from './crewDescriptor';
import { CREW_KIRO_FLAVOR } from './crewFlavor';
import { crewAvailability, crewHomeDir, resolveCrewAcpLaunch, type CrewAdapterOptions } from './crewLaunch';

export interface CrewRuntimeOptions extends AcpPresetRuntimeOptions {
    /**
     * Where the Crew adapter and App are. A function is called at each spawn
     * and availability check, so an adapter built or an App installed after
     * start takes effect without a restart. Default {}: the adapter bundled
     * next to this module, Kiro Crew's home ~/.kiro/crew and its App
     * michi-crew-runtime.
     */
    crew?: CrewAdapterOptions | (() => CrewAdapterOptions);
}

/** Merged over Kiro's capabilities. */
const CREW_CAPABILITIES: Partial<AgentCapabilities> = {
    // ACP modes select Crew templates; member identities and
    // approval policy are deliberately not agent modes.
    modes: true,
    // Official sessionApproval consent gates the adapter at each turn.
    permissions: true,
    // Only drives boot warm, /warm and the per-cwd warm pool. Off keeps the
    // adapter from spawning at boot; it creates Crew slots lazily anyway.
    warmSessions: false,
    // Available through the optional official App stdio relay.
    saveContext: true,
    spawnBranches: true,
    // Kept: nativeResume (session/load), models (adapter's models block),
    // reasoning (v2 sends `effort`; errors remain visible).
};

/**
 * The skill folders Crew's own loader reads that Michi can list: Crew's, then
 * the user's Kiro skills, which Crew loads too. Its project skills need a
 * trust grant and `skills.extra_paths` is Crew's configuration; neither is
 * listed.
 */
function crewSkillRoots(locations: CrewAdapterOptions): SkillScanRoot[] {
    return [
        { dir: path.join(crewHomeDir(locations), 'skills'), scope: 'crew', managedBy: 'Crew' },
        { dir: path.join(os.homedir(), '.kiro', 'skills'), scope: 'user' },
    ];
}

/**
 * Kiro Crew through its ACP adapter, as an AcpAgentRuntime with id `crew`. The
 * preset pins engine v2 (one adapter process per cwd, sessions multiplexed;
 * a v3 setting elsewhere must not flip Crew to per-session workers), Crew's
 * flavor, descriptor and capabilities, no sidecar titles (the sidecar would
 * open an extra Crew session per chat title), the adapter as the agent
 * process, Crew's skill folders, and Crew's offline availability check:
 * while it fails, the runtime refuses to spawn the adapter at all. The
 * pinned members win over the same members of `options`, from untyped
 * callers too.
 *
 * mcpSlots' endpoints must have the one shape the Crew App's relay accepts,
 * http://127.0.0.1:<port>/api/mcp/<slot> (or [::1]) with no headers. That
 * is not checked here: the adapter refuses any other endpoint when it binds
 * a session's slot.
 */
export function createCrewRuntime(options: CrewRuntimeOptions): AcpAgentRuntime {
    const { crew, ...rest } = options;
    const locations = typeof crew === 'function' ? crew : () => crew ?? {};
    return createAcpPresetRuntime({
        id: 'crew',
        label: 'Kiro Crew',
        flavor: CREW_KIRO_FLAVOR,
        resolveLaunch: () => resolveCrewAcpLaunch(locations()),
        missingMessage: 'Kiro Crew ACP adapter not found; set MICHI_CREW_ACP_BIN',
        // Gateway can keep a stopped slot draining for several seconds (6.8s in
        // the live probe); give the adapter's 10s idle wait room to finish.
        launch: { standardFork: true, cancelTimeoutMs: 15_000 },
        descriptorOverride: CREW_DESCRIPTOR_OVERRIDE,
        capabilitiesOverride: CREW_CAPABILITIES,
        checkAvailability: () => crewAvailability(locations()),
        skillRoots: () => crewSkillRoots(locations()),
    }, rest);
}
