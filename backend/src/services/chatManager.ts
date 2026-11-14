import type { NormalizedEvent } from "./chatEvents";
import type { AcpAgentRuntime } from "michi-runtime/internal/adapters/kiro/AcpAgentRuntime";
import type {
    AgentReasoning, AgentRuntime, AgentSession, ChatMessage, ExtraContext, NativeSessionDiscardResult, NewAgentSessionOptions, RuntimeSessionOwner,
} from "../agents/types";
import { log } from "./logger";
import * as sessionRegistry from "../agents/sessionRegistry";
import { normalizeWorkspaceCwd } from "../agents/tools/pathSandbox";
import { getRuntime } from "../agents/registry";
import { descriptorOf } from "michi-runtime/internal/core/descriptors";
import { getAgentConfig, isNativeResumeEnabled } from "./agentConfig";
import {
    getNode,
    getWorkspace,
    listMessages,
    updateNodeResumeBinding,
} from "./dbRepository";
import { AgentDefinitionService } from "./agentDefinitionService";
import { getDb } from "./db";
import { acquireSessionRestoreLock, loadNativeSession, NativeResumeFailedError, nativeResumeIdFor } from './nativeResume';
import { buildCompatibleResumeContext, chooseResumeStrategy, normalizeResumeSignature } from './resumeStrategy';
import { rebuildInheritance } from './sessionRestore';
import { chatHub } from '../agents/chatHub';
import { AssistantBindingError, resolveAssistantBindingForSession, type AssistantSessionBinding } from '../assistant/binding';
import { getCompanionSettings } from './companion/settings';
import { sessionReplayHistory } from '../agents/sessionReplayView';
import { chatOwner } from '../agents/ownerMapping';
import { workspaceSessionCwd } from './workspaceSandbox';
import { workConversationCwd } from './workConversationWorktree';
import { createHash } from "node:crypto";
import {
    MAINTENANCE_BOOTSTRAP_INSTRUCTIONS,
    maintenanceProfileHash,
    maintenanceRuntimeAvailability,
    maintenanceToolProfile,
    MaintenanceRuntimeUnsupportedError,
} from '../agents/maintenancePolicy';
import { isMemoryExtractionJob } from './memory/extractionRepository';
import { CONSOLIDATION_RUN_ID_PREFIX } from './memory/consolidation';
import { CONSOLIDATION_INSTRUCTIONS } from './memory/consolidationPolicy';
import {
    MEMORY_CONSOLIDATE_TOOL_NAME, memoryExtractionBootstrapInstructions, memoryExtractionProfileHash, memoryExtractionToolProfile, type MemoryRunKind,
} from './memory/extractionProfile';
import { PROFILE_RUN_ID_PREFIX } from './memory/extractionRun';
import { memoryProfileBootstrapInstructions } from './memory/userProfile';
import {
    isCheckinNodeId,
    parseEffectiveAgentDefinitionV1,
    type EffectiveAgentDefinitionV1,
} from "michi-shared";
import { DEFAULT_PLATFORM_POLICY } from "../agents/runs/effectivePermissionPolicy";

export type { ChatMessage, ExtraContext };

export interface PrimaryAgentBinding {
    definitionId: string | null;
    definitionRevision: number;
    effectiveDefinition: EffectiveAgentDefinitionV1;
    profileHash: string;
    /** Set for the Michi assistant: its session options come from assistant/binding.ts, not a definition. */
    sessionOptions?: PrimaryAgentSessionOptions;
}

/**
 * Session options a primary binding contributes. Every call site spreads them
 * after its own fields, so a `cwd` here (the assistant's) replaces the client's.
 */
export type PrimaryAgentSessionOptions = Pick<NewAgentSessionOptions, "bootstrapInstructions" | "toolProfile" | "profileHash"> & { cwd?: string };

type PrimaryAgentNodeRow = ReturnType<typeof getNode> & {
    agent_definition_id?: string | null;
    agent_definition_revision?: number | null;
    agent_effective_definition?: string | null;
};

export class PrimaryAgentBindingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PrimaryAgentBindingError";
    }
}

/**
 * Why a session for a Companion check-in node (`n-cmph-*`, DESIGN-v2 §2.5,
 * §3.2) was refused; no session was opened or bound. A check-in node binds
 * only through openEphemeralSession, as a fresh restricted ephemeral session,
 * whatever its workspace or meta rows say, so it can never fall through to
 * an open binding (Spaces, an Agent Definition, a plain chat):
 * - `checkin_node`: an ordinary binding path (ensure-session, a Parent
 *   restore, resolvePrimaryAgentBinding) was asked for one, or an ephemeral
 *   call for a node that is not one;
 * - `refused_binding`: it is not (or no longer) in its assistant workspace;
 * - `not_restricted`: its binding would not be the closed profile;
 * - `runtime_unsupported`: the runtime is missing or declares no
 *   ephemeral sessions (RuntimeTopology.ephemeralSessions);
 * - `already_open`: it has a session or a native binding already (one per run).
 * A PrimaryAgentBindingError, so a route without its own answer refuses it.
 */
export type CheckinSessionRefusal = 'checkin_node' | 'refused_binding' | 'not_restricted' | 'runtime_unsupported' | 'already_open';

export class CheckinSessionError extends PrimaryAgentBindingError {
    readonly code = 'checkin_node';
    constructor(readonly reason: CheckinSessionRefusal, message: string) {
        super(message);
        this.name = "CheckinSessionError";
    }
}

/** What discardEphemeralSession did: the runtime's answer, or `busy` while a turn still holds the node (nothing released). */
export type EphemeralDiscardResult = NativeSessionDiscardResult | 'busy';

/**
 * What a check-in's run recorded about its session (W2-G1a companion_runs),
 * for discarding the native record of a node whose row is already gone.
 */
export interface EphemeralSessionRecord {
    runtimeId: string;
    nativeSessionId: string | null;
    cwd: string;
    profileHash?: string | null;
}

// ── Session replay: posted check-ins as facts (DESIGN-v2 §2.8 T2) ──────────

/** The agent's name in replay facts; agents/sessionReplayView flattens it and falls back to the default. */
const companionReplayName = () => getCompanionSettings().displayName;

// A history stub of an ancestor replays the same view a restored session does,
// so no rebuilt context carries a post's text (agents/sessionRegistry).
sessionRegistry.configureHistoryStubView((rows) => sessionReplayHistory(rows, { name: companionReplayName }));

/** Every binding path but openEphemeralSession starts here: a check-in node never reaches an open binding. */
function refuseCheckinNode(nodeId: string): void {
    if (isCheckinNodeId(nodeId)) {
        throw new CheckinSessionError('checkin_node', `check-in node ${nodeId} opens only a fresh check-in session`);
    }
}

function primaryProfileHash(effectiveDefinition: EffectiveAgentDefinitionV1): string {
    return createHash("sha256").update(JSON.stringify(effectiveDefinition)).digest("hex");
}

export function primaryAgentSessionOptions(binding: PrimaryAgentBinding | null): PrimaryAgentSessionOptions {
    if (!binding) return {};
    if (binding.sessionOptions) return binding.sessionOptions;
    const definition = binding.effectiveDefinition;
    return {
        bootstrapInstructions: `You are the primary Agent for this conversation.\n\n${definition.instructions}`,
        toolProfile: {
            allowedToolNames: definition.capabilitySnapshot.entries
                .filter((entry) => entry.kind === "tool")
                .map((entry) => entry.id),
            capabilitySnapshot: JSON.parse(JSON.stringify(definition.capabilitySnapshot)),
        },
        profileHash: binding.profileHash,
    };
}

/**
 * Thin facade that brokers chat-creation requests to AcpAgentRuntime and
 * registers the resulting AgentSession with sessionRegistry. Used by
 * digestGenerator, which still takes a ChatManager handle —
 * routes/michi.ts now goes through sessionRegistry directly.
 *
 * AcpAgentRuntime is constructed by RUNTIME_FACTORIES in server.ts; ChatManager
 * holds a reference to the registered instance instead of owning its
 * lifecycle. The runtime is optional so Pi-only / Claude-only deployments
 * (where Kiro isn't registered) can still construct a ChatManager — the
 * Kiro-specific getModeCatalog then returns an empty catalog.
 */
export class ChatManager {
    /** The check-in sessions this process opened: what their discard needs, as they were opened. */
    private readonly ephemeralOpened = new Map<string, { cwd: string; profileHash: string | null }>();

    constructor(
        private readonly runtime: AcpAgentRuntime | undefined,
        private readonly defaultCwd: string = process.cwd(),
        private readonly deps: {
            /** A check-in node's binding (assistant/binding); injectable so tests can hand it any profile. */
            resolveCheckinBinding?: (nodeId: string) => Promise<AssistantSessionBinding | null>;
        } = {},
    ) {}

    getRuntime(): AcpAgentRuntime | undefined {
        return this.runtime;
    }

    /** Resolve once, persist once, and thereafter use only the node's immutable snapshot. */
    async resolvePrimaryAgentBinding(input: {
        ownerUserId: string;
        workspaceId: string | null;
        nodeId: string;
        definitionId?: string | null;
    }): Promise<PrimaryAgentBinding | null> {
        // A check-in node binds only through openEphemeralSession, before any
        // other rule here can answer for it (an open fallback included).
        refuseCheckinNode(input.nodeId);
        // Every chat in the assistant's workspace runs as the assistant; no
        // Agent Definition can replace that.
        let assistant: Awaited<ReturnType<typeof resolveAssistantBindingForSession>>;
        try {
            assistant = await resolveAssistantBindingForSession(input.nodeId);
        } catch (error) {
            if (error instanceof AssistantBindingError) throw new PrimaryAgentBindingError(error.message);
            throw error;
        }
        if (assistant) return { definitionId: null, definitionRevision: 1, ...assistant };
        const readStored = (): PrimaryAgentBinding | null => {
            const row = getNode(input.nodeId) as PrimaryAgentNodeRow;
            if (!row?.agent_definition_revision || !row.agent_effective_definition) return null;
            if (input.definitionId && input.definitionId !== row.agent_definition_id) {
                throw new PrimaryAgentBindingError("node is already bound to a different primary Agent Definition");
            }
            const effectiveDefinition = parseEffectiveAgentDefinitionV1(JSON.parse(row.agent_effective_definition));
            return {
                definitionId: row.agent_definition_id ?? null,
                definitionRevision: row.agent_definition_revision,
                effectiveDefinition,
                profileHash: primaryProfileHash(effectiveDefinition),
            };
        };

        const stored = readStored();
        if (stored) return stored;
        if (!input.definitionId) return null;
        if (!input.workspaceId) throw new PrimaryAgentBindingError("workspaceId is required for a primary Agent Definition");
        const row = getNode(input.nodeId) as PrimaryAgentNodeRow;
        if (!row || row.workspace_id !== input.workspaceId) {
            throw new PrimaryAgentBindingError("primary Agent Definition must belong to the node's Workspace");
        }
        if (row.agent_effective_definition || row.acp_session_id || row.external_session_id || listMessages(input.nodeId).length > 0) {
            throw new PrimaryAgentBindingError("an existing conversation cannot switch its primary Agent in place");
        }

        const service = new AgentDefinitionService();
        const definition = await service.getSpawnable(input.ownerUserId, input.definitionId, input.workspaceId);
        if (!definition) throw new PrimaryAgentBindingError("enabled Agent Definition not found for this owner and Workspace");
        const capabilitySnapshot = service.capabilityCatalog.resolve({
            ownerUserId: input.ownerUserId,
            workspaceId: input.workspaceId,
            definitionScope: definition.scope,
            toolRefs: definition.toolRefs,
            skillRefs: definition.skillRefs,
            mcpServerRefs: definition.mcpServerRefs,
        });
        const effectiveDefinition = parseEffectiveAgentDefinitionV1({
            version: 1,
            name: definition.name,
            description: definition.description,
            instructions: definition.instructions,
            runtimeProfile: definition.runtimeProfile,
            fallbackChain: definition.fallbackChain,
            capabilitySnapshot,
            permissionPolicy: definition.permissionPolicy ?? DEFAULT_PLATFORM_POLICY,
            contextPolicy: definition.contextPolicy,
        });
        getDb().prepare(`UPDATE nodes SET
            agent_definition_id = ?, agent_definition_revision = ?, agent_effective_definition = ?
            WHERE id = ? AND agent_effective_definition IS NULL`).run(
            definition.id,
            definition.revision,
            JSON.stringify(effectiveDefinition),
            input.nodeId,
        );
        return readStored() ?? {
            definitionId: definition.id,
            definitionRevision: definition.revision,
            effectiveDefinition,
            profileHash: primaryProfileHash(effectiveDefinition),
        };
    }

    async newChat(
        parentChatId?: string,
        cwd?: string,
        mergeContexts?: string[],
        model?: string,
        extraContexts?: ExtraContext[],
        enableFollowUps: boolean = true,
        contextManifest?: ExtraContext[],
    ): Promise<string> {
        if (!this.runtime) {
            throw new Error("ChatManager.newChat: Kiro runtime not registered");
        }
        const session = await this.runtime.newSession({
            cwd: normalizeWorkspaceCwd(cwd ?? this.defaultCwd),
            parentChatId,
            mergeContexts,
            extraContexts,
            contextManifest,
            enableFollowUps,
            model,
        });
        sessionRegistry.registerSession(session);
        return session.id;
    }

    async *sendMessage(chatId: string, userText: string): AsyncIterableIterator<NormalizedEvent> {
        const session = sessionRegistry.getSession(chatId);
        if (!session) throw new Error(`unknown chat: ${chatId}`);
        yield* session.send(userText);
    }

    /**
     * Resolve the mode catalog and the fresh-session default for one cwd.
     * Warming supplies both values from the same session/new response.
     */
    async getModeCatalog(cwd: string = this.defaultCwd): Promise<{ availableModes: any[]; defaultModeId: string | null }> {
        if (!this.runtime) return { availableModes: [], defaultModeId: null };
        // Reading an already-discovered catalog must not create another warm
        // session or wait for a refill. The fresh default is cached per cwd.
        if (this.runtime.getDefaultModeId(cwd) === null) await this.runtime.warm(cwd);
        return {
            availableModes: await this.runtime.getAvailableModes(),
            defaultModeId: this.runtime.getDefaultModeId(cwd),
        };
    }

    /**
     * Resolve or rebuild the runtime session that owns a durable Parent node.
     * This is the backend-only counterpart of the HTTP ensure-session route:
     * Watch delivery can wake a Parent even when every UI window is closed.
     */
    async ensureParentSession(input: {
        ownerUserId: string;
        workspaceId: string;
        nodeId: string;
        /** Server-owned scheduled maintenance profile; never inferred from user requests. */
        maintenance?: boolean;
        /** The maintenance run the session is opened for (its planId): an automatic memory run that rebuilds the user's profile gets that run's instructions. */
        maintenancePlanId?: string | null;
    }): Promise<AgentSession | null> {
        refuseCheckinNode(input.nodeId);
        const release = await acquireSessionRestoreLock(input.nodeId);
        try {
            return await this.restoreParentSession(input);
        } finally {
            release();
        }
    }

    /**
     * Release the live session of a fresh scheduled maintenance node once its
     * run has ended. Only its managed job opens such a node and every run
     * gets a new one, so the session is never used again; keeping it would
     * hold a Meta agent session (on Kiro, a kiro-cli) for the backend's life.
     * Returns false, leaving the session alone, while any turn still owns it.
     */
    async releaseMaintenanceSession(input: { ownerUserId: string; workspaceId: string; nodeId: string }): Promise<boolean> {
        const release = await acquireSessionRestoreLock(input.nodeId);
        try {
            const node = getNode(input.nodeId);
            if (!node || node.workspace_id !== input.workspaceId || !node.maintenance_job_id) return false;
            const live = sessionRegistry.getSessionForOwner(input.nodeId, chatOwner(input.nodeId), input.ownerUserId);
            if (!live) return true;
            if (chatHub.holdsSession(input.nodeId)) return false;
            await getRuntime(live.runtimeId)?.releaseSession(live.id, live.owner ?? chatOwner(input.nodeId));
            sessionRegistry.dropSession(live.id);
            return true;
        } finally {
            release();
        }
    }

    /**
     * Release the live chat sessions their runtime lets go when idle
     * (AgentRuntime.idleRelease; Kiro). The next message, Watch delivery,
     * thread message or scheduled run resumes each natively, so a chat
     * keeps its session when its user turned Native Resume off, or when its
     * stored binding does not name that native session. Each release holds
     * the node's restore lock and asks again inside it, after any lookup
     * that ran meanwhile has refreshed the session.
     */
    async releaseIdleSessions(now: () => number = Date.now): Promise<number> {
        let released = 0;
        for (const { session, ownerUserId, owner } of sessionRegistry.listLiveSessions()) {
            const runtime = getRuntime(session.runtimeId);
            if (!runtime?.idleRelease || !this.idleReleasable(session, owner, ownerUserId, runtime)) continue;
            if (runtime.idleRelease(session.id, now()).action === 'keep') continue;
            const unlock = await acquireSessionRestoreLock(session.id);
            try {
                if (sessionRegistry.peekLiveSession(session.id) !== session) continue;
                if (!this.idleReleasable(session, owner, ownerUserId, runtime)) continue;
                const verdict = runtime.idleRelease(session.id, now());
                if (verdict.action === 'stop_background') {
                    log.info('chat', 'stopping background work of an idle chat', { nodeId: session.id, runtimeId: runtime.id, reason: verdict.reason });
                    await runtime.stopIdleBackgroundWork?.(session.id);
                    continue;
                }
                if (verdict.action !== 'release') continue;
                await runtime.releaseSession(session.id, owner);
                if (sessionRegistry.peekLiveSession(session.id) === session) sessionRegistry.dropSession(session.id);
                released += 1;
                log.info('chat', 'idle chat session released', { nodeId: session.id, runtimeId: runtime.id, nativeSessionId: session.nativeSessionId ?? null });
            } catch (error) {
                log.warn('chat', 'idle chat session release failed', { nodeId: session.id, runtimeId: runtime.id, error: error instanceof Error ? error.message : String(error) });
            } finally {
                unlock();
            }
        }
        return released;
    }

    /** The host's half of idle release; the runtime's is AgentRuntime.idleRelease. */
    private idleReleasable(session: AgentSession, owner: RuntimeSessionOwner, ownerUserId: string | null, runtime: AgentRuntime): boolean {
        if (owner.mode !== 'interactive' || owner.key !== session.id) return false;
        if (chatHub.isBusy(session.id)) return false;
        const node = getNode(session.id);
        // Fresh maintenance nodes have their own release (releaseMaintenanceSession).
        if (!node || node.maintenance_job_id) return false;
        if (!runtime.capabilities.nativeResume || !runtime.loadSession || !isNativeResumeEnabled(runtime.id, ownerUserId)) return false;
        if ((node.runtime_id ?? null) !== runtime.id) return false;
        const nativeId = nativeResumeIdFor(runtime, node);
        return !!nativeId && nativeId === (session.nativeSessionId ?? session.id)
            && (!session.nativeEngine || (node.runtime_engine ?? 'v2') === session.nativeEngine);
    }

    /**
     * Opens the one session a Companion check-in runs in (DESIGN-v2 §3.1
     * step 3, §3.2): a fresh `ephemeral` native session for check-in node S,
     * on the runtime, model and closed profile its binding names, with no
     * replay, no native load and no live session reused. The only binding
     * path a check-in node has (every other one refuses it, §2.5). Refused
     * with CheckinSessionError, nothing opened, unless S is a check-in node in
     * `workspaceId`, inside an assistant workspace, with no session or native
     * binding yet, whose binding is the restricted profile, on a runtime that
     * declares ephemeral sessions. Registers the session and writes the
     * node's binding (the 0032 ledger records its native id); a failed write
     * releases and discards the session again.
     */
    async openEphemeralSession(input: { ownerUserId: string; workspaceId: string; nodeId: string }): Promise<AgentSession> {
        if (!isCheckinNodeId(input.nodeId)) {
            throw new CheckinSessionError('checkin_node', `node ${input.nodeId} is not a check-in node`);
        }
        const release = await acquireSessionRestoreLock(input.nodeId);
        try {
            const owner = chatOwner(input.nodeId);
            const node = getNode(input.nodeId);
            if (!node || node.workspace_id !== input.workspaceId) {
                throw new CheckinSessionError('refused_binding', `check-in node ${input.nodeId} is not in workspace ${input.workspaceId}`);
            }
            if (sessionRegistry.getSession(input.nodeId) || node.acp_session_id || node.external_session_id) {
                throw new CheckinSessionError('already_open', `check-in node ${input.nodeId} already had its session`);
            }
            let binding: AssistantSessionBinding | null;
            try {
                binding = await (this.deps.resolveCheckinBinding ?? resolveAssistantBindingForSession)(input.nodeId);
            } catch (error) {
                if (error instanceof AssistantBindingError) throw new CheckinSessionError('refused_binding', error.message);
                throw error;
            }
            if (!binding) {
                throw new CheckinSessionError('refused_binding', `check-in node ${input.nodeId} is outside the assistant's workspace`);
            }
            const options = binding.sessionOptions;
            if (options.toolProfile?.restricted !== true || !options.cwd) {
                throw new CheckinSessionError('not_restricted', `check-in node ${input.nodeId} would not bind to the closed profile`);
            }
            const profile = binding.effectiveDefinition.runtimeProfile;
            const runtime = getRuntime(profile.runtimeId);
            if (!runtime || !descriptorOf(runtime).topology.ephemeralSessions) {
                throw new CheckinSessionError('runtime_unsupported', `runtime ${profile.runtimeId} cannot run a check-in: it opens no ephemeral sessions`);
            }
            const session = await runtime.newSession({
                sessionId: input.nodeId,
                workspaceId: input.workspaceId,
                ownerUserId: input.ownerUserId,
                model: profile.modelId ?? null,
                provider: profile.providerId ?? null,
                reasoning: (profile.reasoning ?? null) as AgentReasoning | null,
                ...options,
                cwd: options.cwd,
                ephemeral: true,
            });
            sessionRegistry.registerSession(session, input.ownerUserId, owner);
            this.ephemeralOpened.set(input.nodeId, { cwd: options.cwd, profileHash: binding.profileHash });
            try {
                updateNodeResumeBinding(input.nodeId, {
                    acp_session_id: session.nativeSessionId ?? session.id,
                    runtime_id: session.runtimeId,
                    runtime_engine: session.nativeEngine ?? null,
                    provider_id: profile.providerId ?? null,
                    model_id: session.currentModelId ?? profile.modelId ?? null,
                    reasoning: (profile.reasoning ?? null) as AgentReasoning | null,
                    current_mode_id: session.currentModeId ?? null,
                });
            } catch (error) {
                await this.dropEphemeral(input.nodeId, session, input.ownerUserId).catch(() => {});
                throw error;
            }
            return session;
        } finally {
            release();
        }
    }

    /**
     * Ends check-in node S's session for good (DESIGN-v2 §3.1 step 9, §3.7):
     * under S's restore lock, `busy` (nothing touched) while chatHub still
     * has a turn for S running or queued; otherwise releases and drops the
     * live session, then asks its runtime to discard the native record
     * (discardNativeSession) and returns its answer. `deferred`: the runtime
     * still holds the record (Kiro's lock), so the caller must not record it
     * as discarded and retries at the next cleanup. With S's row gone (boot
     * cleanup after a purge), `recorded` names the runtime, native id and
     * cwd its run kept. No runtime id is compared: the runtime decides.
     */
    async discardEphemeralSession(input: { ownerUserId: string; nodeId: string; recorded?: EphemeralSessionRecord }): Promise<EphemeralDiscardResult> {
        if (!isCheckinNodeId(input.nodeId)) {
            throw new CheckinSessionError('checkin_node', `node ${input.nodeId} is not a check-in node`);
        }
        const release = await acquireSessionRestoreLock(input.nodeId);
        try {
            const held = () => chatHub.isBusy(input.nodeId);
            // A turn's `done` resolves a few microtasks before chatHub lets go
            // of its queue: one macrotask later a caller that awaited it is
            // never told `busy`.
            if (held()) await new Promise<void>((resolve) => setImmediate(resolve));
            if (held()) return 'busy';
            const live = sessionRegistry.getSession(input.nodeId) ?? null;
            return await this.dropEphemeral(input.nodeId, live, input.ownerUserId, input.recorded);
        } finally {
            release();
        }
    }

    /** Release, drop and discard a check-in node's session; the caller holds its restore lock. */
    private async dropEphemeral(
        nodeId: string,
        live: AgentSession | null,
        ownerUserId: string,
        recorded?: EphemeralSessionRecord,
    ): Promise<NativeSessionDiscardResult> {
        const owner = chatOwner(nodeId);
        if (live) {
            try {
                await getRuntime(live.runtimeId)?.releaseSession(live.id, live.owner ?? owner);
            } finally {
                if (sessionRegistry.getSession(live.id) === live) sessionRegistry.dropSession(live.id);
            }
        }
        const node = getNode(nodeId);
        const opened = this.ephemeralOpened.get(nodeId);
        const runtimeId = live?.runtimeId ?? node?.runtime_id ?? recorded?.runtimeId ?? null;
        // Never bound to a runtime: no native record exists.
        if (!runtimeId) {
            this.ephemeralOpened.delete(nodeId);
            return 'absent';
        }
        const runtime = getRuntime(runtimeId);
        if (!runtime) return 'unsupported';
        if (!runtime.discardNativeSession) {
            this.ephemeralOpened.delete(nodeId);
            return descriptorOf(runtime).topology.ephemeralSessions === 'native' ? 'absent' : 'unsupported';
        }
        const cwd = opened?.cwd ?? recorded?.cwd ?? (node ? (await this.checkinBindingOrNull(nodeId))?.sessionOptions.cwd : undefined);
        if (!cwd) return 'unsupported';
        const result = await runtime.discardNativeSession({
            sessionId: nodeId,
            owner,
            // The node's binding, else what the run recorded, else the live session (a binding write that failed).
            nativeSessionId: (node ? nativeResumeIdFor(runtime, node) : null) ?? recorded?.nativeSessionId ?? live?.nativeSessionId ?? null,
            cwd,
            profileHash: live?.runtimeProfileHash ?? opened?.profileHash ?? recorded?.profileHash ?? null,
            ownerUserId,
        });
        if (result !== 'deferred') this.ephemeralOpened.delete(nodeId);
        return result;
    }

    private async checkinBindingOrNull(nodeId: string): Promise<AssistantSessionBinding | null> {
        try {
            return await (this.deps.resolveCheckinBinding ?? resolveAssistantBindingForSession)(nodeId);
        } catch {
            return null;
        }
    }

    private async restoreParentSession(input: { ownerUserId: string; workspaceId: string; nodeId: string; maintenance?: boolean; maintenancePlanId?: string | null }): Promise<AgentSession | null> {
        // No native resume and no replay for a check-in node, ever.
        refuseCheckinNode(input.nodeId);
        const owner = chatOwner(input.nodeId);
        const node = getNode(input.nodeId);
        if (!node || node.workspace_id !== input.workspaceId) return null;
        const markedMaintenance = typeof node.maintenance_job_id === 'string' && node.maintenance_job_id.length > 0;
        if (markedMaintenance !== (input.maintenance === true)) {
            throw new Error(markedMaintenance
                ? 'Scheduled maintenance nodes can only be opened by their managed job'
                : 'Maintenance profile requires a scheduled maintenance node');
        }
        // A workspace's automatic memory extraction opens its own closed toolset (memory/extractionProfile.ts).
        const memoryExtraction = input.maintenance === true && isMemoryExtractionJob(node.maintenance_job_id!);
        if (input.maintenance && !getDb().prepare(memoryExtraction ? `
            SELECT 1 FROM scheduled_jobs j
            JOIN memory_extraction_cursors c ON c.job_id = j.id AND c.workspace_id = j.workspace_id
            WHERE j.id = ? AND j.workspace_id = ? AND j.session_mode = 'fresh' AND c.owner_user_id = ?
        ` : `
            SELECT 1 FROM scheduled_jobs j
            JOIN page_maintenance_configs c ON c.job_id = j.id AND c.workspace_id = j.workspace_id
            WHERE j.id = ? AND j.workspace_id = ? AND j.session_mode = 'fresh' AND c.owner_user_id = ?
        `).get(node.maintenance_job_id!, input.workspaceId, input.ownerUserId)) {
            throw new Error('Scheduled maintenance job is no longer available');
        }
        const workspace = getWorkspace(input.workspaceId, input.ownerUserId);
        if (!workspace) return null;
        // A work conversation with its own worktree opens there (D18, Q26), on a resume too.
        const cwd = workConversationCwd(input.nodeId) ?? workspaceSessionCwd(workspace, input.ownerUserId, this.defaultCwd);
        const configured = getAgentConfig(process.env.MICHI_CLOUD === "1" ? input.ownerUserId : undefined);
        const primaryAgent = input.maintenance ? null : await this.resolvePrimaryAgentBinding({
            ownerUserId: input.ownerUserId,
            workspaceId: input.workspaceId,
            nodeId: input.nodeId,
        });
        const primaryProfile = primaryAgent?.effectiveDefinition.runtimeProfile;
        const runtimeId = input.maintenance ? node.runtime_id ?? configured.runtime : primaryProfile?.runtimeId ?? node.runtime_id ?? configured.runtime;
        if (input.maintenance && !maintenanceRuntimeAvailability(runtimeId).available) {
            throw new MaintenanceRuntimeUnsupportedError(runtimeId);
        }
        const runtime = getRuntime(runtimeId);
        if (!runtime) return null;
        const model = input.maintenance ? node.model_id ?? null : primaryProfile?.modelId ?? node.model_id ?? null;
        const provider = input.maintenance ? node.provider_id ?? null : primaryProfile?.providerId ?? node.provider_id ?? null;
        const reasoning = (input.maintenance ? node.reasoning ?? null : primaryProfile?.reasoning ?? node.reasoning ?? null) as AgentReasoning | null;
        // An automatic memory run reads conversation turns, rebuilds the user's profile (memory/userProfile.ts) or tidies
        // Michi's own notes (memory/consolidation.ts): same tools, its own instructions, chosen by the plan's id.
        const planId = typeof input.maintenancePlanId === 'string' ? input.maintenancePlanId : '';
        const memoryRunKind: MemoryRunKind = planId.startsWith(PROFILE_RUN_ID_PREFIX) ? 'profile'
            : planId.startsWith(CONSOLIDATION_RUN_ID_PREFIX) ? 'consolidate' : 'extract';
        const runtimeConfig = { runtimeId, providerId: provider, modelId: model, reasoning };
        const maintenanceHash = !input.maintenance ? null
            : memoryExtraction ? memoryExtractionProfileHash(runtimeConfig, memoryRunKind) : maintenanceProfileHash(runtimeConfig);
        const bootstrap = !input.maintenance ? primaryAgentSessionOptions(primaryAgent)
            : memoryExtraction
                ? {
                    bootstrapInstructions: memoryRunKind === 'profile' ? memoryProfileBootstrapInstructions()
                        : memoryRunKind === 'consolidate' ? CONSOLIDATION_INSTRUCTIONS(MEMORY_CONSOLIDATE_TOOL_NAME) : memoryExtractionBootstrapInstructions(),
                    toolProfile: memoryExtractionToolProfile(), profileHash: maintenanceHash,
                }
                : { bootstrapInstructions: MAINTENANCE_BOOTSTRAP_INSTRUCTIONS, toolProfile: maintenanceToolProfile(), profileHash: maintenanceHash };
        const live = sessionRegistry.getSessionForOwner(input.nodeId, owner, input.ownerUserId);
        const nativeId = nativeResumeIdFor(runtime, node);
        const targetSignature = { runtimeId, runtimeEngine: runtime.nativeEngine, modelId: model, providerId: provider, reasoning };
        const existingSignature = normalizeResumeSignature({
            runtimeId: node.runtime_id ?? (node.acp_session_id && node.acp_session_id !== node.id ? 'kiro' : null),
            runtimeEngine: node.runtime_engine,
            modelId: node.model_id, providerId: node.provider_id, reasoning: node.reasoning,
        });
        const decision = chooseResumeStrategy({
            existingChatId: nativeId ? input.nodeId : null,
            existingSignature,
            targetSignature,
            nativeResumeAvailable: !!runtime.loadSession && runtime.capabilities.nativeResume && !!nativeId,
            nativeResumeEnabled: isNativeResumeEnabled(runtimeId, input.ownerUserId),
            nativeResumeSettings: runtime.capabilities.nativeResumeSettings,
            liveSessionMatches: !!live && live.runtimeId === runtimeId
                && (live.nativeSessionId ?? live.id) === nativeId
                && (live.runtimeProfileHash ?? null) === (maintenanceHash ?? primaryAgent?.profileHash ?? null)
                && (!existingSignature || (existingSignature.reasoning === reasoning && existingSignature.modelId === model)),
        });
        if (decision.strategy === 'live' && live) return live;
        if (input.maintenance && live && (live.runtimeProfileHash ?? null) !== maintenanceHash) {
            throw new Error('A different runtime profile is already bound to this scheduled maintenance node');
        }
        if (chatHub.holdsSession(input.nodeId)) {
            throw new NativeResumeFailedError(new Error('Cannot reload an active parent turn'));
        }
        if (live) {
            await getRuntime(live.runtimeId)?.releaseSession(live.id);
            sessionRegistry.dropSession(live.id);
        }

        let session: AgentSession | null = null;
        if (decision.strategy === 'exact') {
            session = await loadNativeSession(runtime, {
                sessionId: input.nodeId,
                nodeId: input.nodeId,
                cwd,
                workspaceId: input.workspaceId,
                ownerUserId: input.ownerUserId,
                model,
                provider,
                reasoning,
                ...bootstrap,
            }, nativeId);
        }
        if (!session) {
            const userId = process.env.MICHI_CLOUD === "1" ? input.ownerUserId : undefined;
            // Posted check-ins replay as one-line facts, never their text (§2.8 T2).
            const replayHistory = sessionReplayHistory(listMessages(input.nodeId, userId), { name: companionReplayName });
            const replaysMessages = descriptorOf(runtime).topology.historyReplay === 'messages';
            // What ensure-session's rebuild inherits; here it precedes the node's own transcript.
            const inherited = rebuildInheritance({
                nodeId: input.nodeId, row: node, parentChatId: node.parent_node_id ?? undefined, hasBranchContext: false, userId,
            });
            const contexts = [inherited.context, replaysMessages ? null : buildCompatibleResumeContext(replayHistory, { nodeId: input.nodeId, title: node.title })]
                .filter((value): value is string => !!value);
            session = await runtime.newSession({
                sessionId: input.nodeId,
                cwd,
                workspaceId: input.workspaceId,
                ownerUserId: input.ownerUserId,
                model,
                provider,
                reasoning,
                parentChatId: inherited.parentChatId,
                ...(replaysMessages ? { replayHistory } : {}),
                mergeContexts: contexts.length > 0 ? contexts : undefined,
                ...bootstrap,
            });
        }
        sessionRegistry.registerSession(session, input.ownerUserId, owner);
        try {
            updateNodeResumeBinding(input.nodeId, {
                acp_session_id: session.nativeSessionId ?? session.id,
                runtime_id: session.runtimeId,
                runtime_engine: session.nativeEngine ?? null,
                provider_id: provider,
                model_id: session.currentModelId ?? model,
                reasoning,
                current_mode_id: session.currentModeId ?? null,
            });
        } catch (error) {
            await runtime.releaseSession(session.id);
            sessionRegistry.dropSession(session.id);
            throw error;
        }
        return session;
    }
}
