import path from 'node:path';
import { isReasoningLevel, parseSessionState, type AgentSessionState } from 'michi-shared';
import type { AcpSessionInfo } from './kiroProtocol';
import { kiroModelInfos, reasoningConfigOption, withThoughtLevels, type KiroModelSource } from './kiroModels';

let stateVersion = Date.now();

/** `skillNames`: see AcpClientOptions.skillCommandNames. */
type Snapshot = { version?: number; commands?: unknown[]; skillNames?: ReadonlySet<string>; servers?: any[]; tools?: unknown[] };

/** What Kiro V3 says about an advertised command in its `_meta.kiro`. */
type KiroCommandMeta = { type?: unknown; resource?: { source?: { origin?: unknown; root?: unknown } } };

function kiroCommandMeta(command: unknown): KiroCommandMeta | undefined {
    const meta = command && typeof command === 'object' ? (command as { _meta?: { kiro?: unknown } })._meta?.kiro : undefined;
    return meta && typeof meta === 'object' ? meta as KiroCommandMeta : undefined;
}

/**
 * An advertised command as AgentCommand input. Kiro V3 marks its skills and
 * prompts in `_meta.kiro`, which parseSessionState drops with the rest of
 * `_meta`. An agent that marks nothing has its skills named in `skillNames`.
 */
function agentCommand(command: unknown, skillNames: ReadonlySet<string> | undefined): unknown {
    const meta = kiroCommandMeta(command);
    if (meta?.type === 'skill' || meta?.type === 'prompt') return { ...(command as object), kind: meta.type };
    const name = (command as { name?: unknown } | null)?.name;
    return typeof name === 'string' && skillNames?.has(name) ? { ...(command as object), kind: 'skill' } : command;
}

/** Compared as Kiro compares workspace roots: resolved, and without case on Windows. */
function samePath(a: string, b: string): boolean {
    const normal = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    return normal(a) === normal(b);
}

/** Only bounded, replaceable state survives queue draining. Never keep text,
 * tool execution deltas, permissions or turn completion here. */
export class KiroSessionSnapshots {
    private readonly sessions = new Map<string, Snapshot>();
    private readonly listeners = new Map<string, Set<() => void>>();

    constructor(
        /** The id of the runtime instance that owns this client (Crew is a second
         * AcpAgentRuntime); state carrying another id is discarded downstream. */
        private readonly runtimeId: string,
        /** How the agent reports its models, as for the runtime's catalog. */
        private readonly models: KiroModelSource,
        /** AcpClientOptions.skillLibraryWorkspace and advertiseSkills. */
        private readonly skills: { libraryWorkspace?: string; advertise?: () => boolean } = {},
    ) {}

    /** A command Kiro loaded from the host's skill library, which the host lists itself. */
    private fromSkillLibrary(command: unknown): boolean {
        const root = kiroCommandMeta(command)?.resource?.source?.root;
        const library = this.skills.libraryWorkspace;
        return !!library && typeof root === 'string' && samePath(root, library);
    }

    set(sessionId: string, patch: Snapshot): void {
        const value = { ...this.sessions.get(sessionId), ...patch };
        this.sessions.delete(sessionId);
        this.sessions.set(sessionId, value);
        // Pre-response notifications can contain an as-yet unknown session ID.
        // V3 workers own one chat, but still bound unsolicited identities.
        while (this.sessions.size > 128) this.sessions.delete(this.sessions.keys().next().value!);
    }
    get(sessionId: string): Snapshot | undefined { return this.sessions.get(sessionId); }
    delete(sessionId: string): void { this.sessions.delete(sessionId); this.listeners.delete(sessionId); }
    changed(sessionId: string): void {
        stateVersion = Math.max(Date.now(), stateVersion + 1);
        this.set(sessionId, { version: stateVersion });
        for (const notify of this.listeners.get(sessionId) ?? []) notify();
    }
    subscribe(sessionId: string, notify: () => void): () => void {
        const listeners = this.listeners.get(sessionId) ?? new Set();
        listeners.add(notify); this.listeners.set(sessionId, listeners);
        return () => { listeners.delete(notify); if (!listeners.size) this.listeners.delete(sessionId); };
    }
    private commands(snapshot: Snapshot): unknown[] {
        const advertiseSkills = this.skills.advertise?.() !== false;
        return snapshot.commands!.filter((command) => !this.fromSkillLibrary(command))
            .map((command) => agentCommand(command, snapshot.skillNames))
            .filter((command) => {
                const kind = (command as { kind?: unknown } | null)?.kind;
                return advertiseSkills || (kind !== 'skill' && kind !== 'prompt');
            });
    }

    state(sessionId: string, info?: AcpSessionInfo): AgentSessionState {
        const snapshot = this.get(sessionId);
        const effort = reasoningConfigOption(info?.configOptions);
        const models = info?.models?.availableModels;
        return parseSessionState({ runtimeId: this.runtimeId, version: snapshot?.version,
            ...(info?.modes ? { currentModeId: info.modes.currentModeId, availableModes: info.modes.availableModes } : {}),
            ...(info?.models ? { modelId: info.models.currentModelId,
                availableModels: Array.isArray(models)
                    ? kiroModelInfos(withThoughtLevels(models, this.models, info.configOptions), this.models) : undefined,
            } : {}),
            ...(info?.configOptions ? { reasoning: isReasoningLevel(effort?.currentValue) ? effort.currentValue : null } : {}),
            ...(snapshot?.commands ? { commands: this.commands(snapshot) } : {}),
            ...(snapshot?.servers ? { mcpErrors: snapshot.servers.filter((server) => server.status === 'failed' || server.status === 'error')
                .map((server) => ({ serverName: String(server.name ?? ''),
                    error: typeof server.errorMessage === 'string' ? server.errorMessage
                        : typeof server.error === 'string' ? server.error : 'MCP server connection failed',
                })) } : {}),
        });
    }
}
