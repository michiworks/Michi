import { AcpAgentRuntime, type KiroRuntimeOptions } from './AcpAgentRuntime';
import type { AcpLaunch } from './kiroAcpProfile';

/**
 * AcpAgentRuntime's options less those an ACP preset pins, and less
 * isolatedSession, which only a v3 runtime reads and a preset pins v2.
 * kiroCli and preloadTools do not apply: the preset's agent is a custom
 * launch. It starts with spawnEnv as it is, read at each spawn; without
 * spawnEnv it inherits this process's environment unchanged.
 */
export type AcpPresetRuntimeOptions = Omit<KiroRuntimeOptions,
    'engine' | 'isolatedSession' | 'id' | 'label' | 'flavor' | 'launch' | 'sidecarTitles'
    | 'descriptorOverride' | 'capabilitiesOverride' | 'checkAvailability' | 'skillRoots'>;

/** What one ACP agent's preset pins over AcpAgentRuntime's options. */
export interface AcpPreset extends Required<Pick<KiroRuntimeOptions,
    'id' | 'label' | 'flavor' | 'descriptorOverride' | 'capabilitiesOverride' | 'checkAvailability' | 'skillRoots'>> {
    /** The agent's launch, resolved at each spawn; null when it does not resolve. */
    resolveLaunch: () => AcpLaunch | null;
    /** What a spawn reports on stderr when the launch no longer resolves. */
    missingMessage: string;
    /** The launch's protocol flags and cancel watchdog. */
    launch: Pick<AcpLaunch, 'standardFork' | 'standardAcp' | 'cancelTimeoutMs'>;
}

/**
 * Resolved at each spawn, not at construction, so installing the agent or
 * changing its location after start takes effect without a restart.
 * AcpClient reads `bin` once in its constructor and calls `args` and `env`
 * once per start. AcpAgentRuntime never spawns the placeholder while the
 * preset's availability check fails; if the agent vanishes later, the child
 * exits at once with a readable stderr line instead of a spawn ENOENT.
 */
function lazyAcpLaunch(preset: AcpPreset, env: (() => NodeJS.ProcessEnv) | undefined): AcpLaunch {
    const missing: AcpLaunch = {
        bin: process.execPath,
        args: () => ['-e', `process.stderr.write('${preset.missingMessage}\\n'); process.exit(1)`],
    };
    const resolve = () => preset.resolveLaunch() ?? missing;
    return {
        // Without env the agent would inherit the backend's whole environment.
        ...(env ? { env } : {}),
        ...preset.launch,
        get bin() {
            return resolve().bin;
        },
        args: (model) => resolve().args(model),
    };
}

/**
 * An AcpAgentRuntime for an ACP agent other than kiro-cli. Engine v2 (one
 * agent process per cwd, sessions multiplexed; a v3 setting elsewhere must
 * not flip it to per-session workers) and no sidecar titles are pinned with
 * the preset's members, all over the same members of `options`, from untyped
 * callers too.
 */
export function createAcpPresetRuntime(preset: AcpPreset, options: AcpPresetRuntimeOptions): AcpAgentRuntime {
    return new AcpAgentRuntime({
        ...options,
        engine: 'v2',
        id: preset.id,
        label: preset.label,
        flavor: preset.flavor,
        launch: lazyAcpLaunch(preset, options.spawnEnv),
        sidecarTitles: false,
        descriptorOverride: preset.descriptorOverride,
        capabilitiesOverride: preset.capabilitiesOverride,
        checkAvailability: preset.checkAvailability,
        skillRoots: preset.skillRoots,
    });
}
