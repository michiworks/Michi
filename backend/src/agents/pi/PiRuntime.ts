import { assertReleaseOwnership } from '../runs/runtimeRunAdapter';
import type { RuntimeDescriptor } from "michi-runtime/internal/contract/descriptor";
import { PI_RUNTIME_DESCRIPTOR, PI_CORE_RUNTIME_DESCRIPTOR } from "./piDescriptor";
import type {
    AgentCapabilities,
    AgentProviderInfo,
    AgentRuntimeWithProviders,
    AgentSession,
    ListRuntimeSkillsOptions,
    LoadAgentSessionOptions,
    ModelInfo,
    NativeSessionDiscardInput,
    NativeSessionDiscardResult,
    NewAgentSessionOptions,
    RuntimeSessionOwner,
    RuntimeSkill,
    RuntimeSkillListing,
    StructuredCompletion,
    StructuredCompletionOptions,
    VerifyProviderKeyOptions,
    VerifyProviderKeyResult,
} from "../types";
import type { AgentToolBridge } from "../toolBridge";
import { chatNodeOf, chatOwner, isRunOwner } from "../ownerMapping";
import type { PlanEntry } from "michi-shared";
import { PendingSessionAcquisitions, assertSessionReusable, sessionIdentity } from "../sessionAcquisition";
import { PiSession, type PiSessionDeps } from "./PiSession";
import { isMetaAgentProfile } from "../metaAgentGuard";
import { createPiSession, piHostHistory, selectPiSessionKind, shouldNavigatePiTreeOnMichiBranch } from "./PiSdkSession";
import { discardPiSdkSessionDirectory, type PiEphemeralSessionDeps } from "./piSdkHarness";
import * as sessionRegistry from "../sessionRegistry";
import { buildPreamble, buildFormatReminder } from "../preamble";
import { artifactToolsForProfile } from "../artifactToolNames";
import { isAssistantProfile, isCompanionProfile } from "../../assistant/policy";
import { isMaintenanceProfile } from '../maintenancePolicy';
import { renderBranchContext } from "../../services/branchBoundary";
import {
    listPiModels,
    listProviderInfos,
    selectDefaultModelId,
    verifyPiProviderKey,
} from "./piProviders";
import { getRuntimeDeps } from "../runtimeDeps";
import { rowsToAgentMessages } from "./historyAdapter";
import { completePiStructured } from "./piStructured";
import { skillsAvailable } from "../../services/skills/paths";

/** An assistant session's head: the Companion's for its closed profile, else the Michi assistant's. */
function assistantHead(profile: NewAgentSessionOptions['toolProfile']): "companion" | "assistant" {
    return isCompanionProfile(profile) ? "companion" : "assistant";
}

/**
 * AgentRuntime adapter for the @earendil-works/pi-ai package.
 *
 * Capabilities:
 *   - providerModels=true (a single binary catalog of providers/models is
 *     advertised; the active one is read from agentConfig)
 *   - reasoning=true / apiKeys=true / saveContext=true / spawnBranches=true
 *     (saveContext covers both save_artifact and update_artifact tools)
 *   - modes=false / permissions=true / warmSessions=false
 *
 * Pi uses a scoped SDK transcript per Michi session. SQLite remains the
 * authoritative host history; a native checkpoint must match before recovery.
 * MICHI_PI_SESSION_SDK=0 selects the agent-core rollback engine.
 *
 * Provider env bindings are registered with secrets.ts by runtimeFactories,
 * not by this class — keeps registration symmetric across runtimes.
 */
export interface PiRuntimeSdkOptions {
    /** Trusted host factories only; resolved separately for every owner scope. */
    extensionFactories?: (scope: {
        sessionId: string; owner: RuntimeSessionOwner; ownerUserId: string | null;
        workspaceId: string | null;
    }) => PiSessionDeps['sdkExtensionFactories'];
}

/**
 * Which skills the preamble names: a chat whose session loads the library's
 * folders (PiSession's skillPaths, given wherever it is not host-prompt
 * only) has them listed by Pi itself, so only the built-in ones.
 */
function piHostSkills(owner: RuntimeSessionOwner, toolProfile: NewAgentSessionOptions["toolProfile"]): { hostSkills?: { librarySkillsLoaded: boolean } } {
    if (isRunOwner(owner) || toolProfile?.restricted === true || isMetaAgentProfile(toolProfile)
        || isMaintenanceProfile(toolProfile) || isAssistantProfile(toolProfile)) return {};
    return { hostSkills: { librarySkillsLoaded: true } };
}

export class PiRuntime implements AgentRuntimeWithProviders {
    public readonly id = "pi" as const;
    public readonly label = "Pi (multi-provider)";
    public readonly capabilities: AgentCapabilities = {
        modes: false,
        permissions: true,
        models: true,
        providerModels: true,
        reasoning: true,
        supportedReasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        apiKeys: true,
        warmSessions: false,
        saveContext: true,
        spawnBranches: true,
        // Public bindings use Michi ids and loadSession. Native restoration is
        // an internal checkpointed optimization, not a separate resume-token API.
        nativeResume: false,
    };
    public get descriptor(): RuntimeDescriptor {
        return selectPiSessionKind() === 'sdk' ? PI_RUNTIME_DESCRIPTOR : PI_CORE_RUNTIME_DESCRIPTOR;
    }

    private readonly acquisitions = new PendingSessionAcquisitions<AgentSession>();
    private sessions = new Map<string, AgentSession & { destroy(): void; dispose?(): Promise<void> }>();
    /** The workspace each ephemeral session was opened in, by public id, until its discard: its scope directory depends on it. */
    private readonly sessionWorkspaces = new Map<string, string | null>();

    constructor(private readonly bridge: AgentToolBridge, private readonly sdkOptions: PiRuntimeSdkOptions = {}) {}

    private extensionsFor(id: string, owner: RuntimeSessionOwner, opts: NewAgentSessionOptions | LoadAgentSessionOptions): PiSessionDeps['sdkExtensionFactories'] {
        if (isMetaAgentProfile(opts.toolProfile)) return [];
        return this.sdkOptions.extensionFactories?.({ sessionId: id, owner,
            ownerUserId: opts.ownerUserId ?? null, workspaceId: opts.workspaceId ?? null });
    }

    async warm(_cwd: string): Promise<void> {
        // No-op — Pi has no expensive process to spawn.
    }

    async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
        const { owner, id } = sessionIdentity(opts.owner, opts.sessionId);
        return this.acquisitions.acquire(id, () => this.createSession({ ...opts, owner, sessionId: id }),
            (session) => assertReusable(session, owner, opts));
    }

    private async createSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
        // Adopt the caller-supplied id when present so chatId === nodeId
        // (Pi runtime convention; Kiro must server-mint per ACP). When
        // absent (legacy callers), fall back to a UUID.
        const { owner, id } = sessionIdentity(opts.owner, opts.sessionId);
        const existing = this.sessions.get(id);
        if (existing) return existing;
        const enableFollowUps = opts.enableFollowUps !== false
            && !isAssistantProfile(opts.toolProfile)
            && !isMaintenanceProfile(opts.toolProfile);

        // Walk the parent's chain (parent's own ancestors + parent itself).
        // Lazy-load any session whose getHistory() is empty — this covers the
        // cold path where the user branches from a parent that hasn't been
        // re-opened since backend restart.
        const ancestorChain: AgentSession[] = [];
        if (!opts.branchContext && !isRunOwner(owner) && opts.parentChatId) {
            sessionRegistry.ensureAncestorChainLoaded(opts.parentChatId);
            const parent = sessionRegistry.getSession(opts.parentChatId);
            if (parent) {
                ancestorChain.push(...sessionRegistry.getAncestors(opts.parentChatId), parent);
            }
        }

        const branchContextText = opts.branchContext
            ? renderBranchContext(opts.branchContext)
            : null;
        const preamble = buildPreamble({
            enableFollowUps,
            // The assistant gets its own short tool note, not the ordinary chat tools; the Companion its own.
            ...(isAssistantProfile(opts.toolProfile) ? { toolCapabilities: assistantHead(opts.toolProfile) } : {}),
            ...(isMaintenanceProfile(opts.toolProfile) ? { toolCapabilities: "maintenance" as const } : {}),
            // Pi gives the artifact tools beyond save/update to chat threads only (piTools.ts).
            artifactTools: isRunOwner(owner) ? [] : artifactToolsForProfile(opts.toolProfile),
            cwd: opts.cwd,
            contextManifest: opts.contextManifest,
            artifactCount: opts.artifactCount,
            extraContexts: opts.extraContexts,
            ancestors: ancestorChain,
            mergeContexts: [
                ...(branchContextText ? [branchContextText] : []),
                ...(opts.mergeContexts ?? []),
            ],
            ...piHostSkills(owner, opts.toolProfile),
        });
        const effectivePreamble = [preamble, opts.bootstrapInstructions].filter(Boolean).join("\n\n");
        const initialMessages = opts.replayHistory
            ? rowsToAgentMessages(opts.replayHistory.map((message) => ({
                role: message.role,
                content: message.content,
                created_at: Date.now(),
            })))
            : undefined;

        void shouldNavigatePiTreeOnMichiBranch();
        const sessionDeps: PiEphemeralSessionDeps = {
            bridge: this.bridge,
            sdkExtensionFactories: this.extensionsFor(id, owner, opts),
            cwd: opts.cwd,
            enableFollowUps,
            preamble: effectivePreamble,
            firstUserGlue: isAssistantProfile(opts.toolProfile) ? "" : buildFormatReminder(enableFollowUps),
            parentChatId: isRunOwner(owner) ? undefined : opts.parentChatId,
            workspaceId: opts.workspaceId ?? null,
            ownerUserId: opts.ownerUserId ?? null,
            owner,
            profileHash: opts.profileHash ?? null,
            toolProfile: opts.toolProfile,
            permissionBroker: opts.permissionBroker,
            requestedProvider: opts.provider ?? null,
            requestedModel: opts.model ?? null,
            requestedReasoning: opts.reasoning ?? null,
            initialMessages,
            // An ephemeral session lives in memory only and is never restored (piSdkHarness).
            restoreNative: opts.replayHistory !== undefined && !opts.ephemeral,
            initialPlan: initialPlanFor(owner, opts, opts.branchContext),
            ...(opts.ephemeral ? { ephemeral: true as const } : {}),
        };
        const session = await createPiSession(id, sessionDeps);
        if (opts.ephemeral) this.sessionWorkspaces.set(id, opts.workspaceId ?? null);
        this.sessions.set(id, session as AgentSession & { destroy(): void; dispose?(): Promise<void> });
        sessionRegistry.registerSession(session, opts.ownerUserId ?? null, owner);
        return session;
    }

    /**
     * Rehydrate a Pi session by reading the node's prior messages from SQLite
     * and seeding them into a fresh PiSession. Tool calls / thinking blocks
     * are not persisted, so the rehydrated transcript is text-only — the
     * model can still continue the conversation, but won't see prior
     * spawn_branches / save_artifact calls in its context.
     *
     * chatId === nodeId for Pi, so opts.sessionId is the row id for both
     * the nodes lookup (parent chain) and the messages lookup (history).
     *
     * The systemPrompt is rebuilt here too — the preamble (role identity,
     * TITLE/FOLLOW-UP sentinel rules, ancestor chain) lives in pi-agent-core's
     * systemPrompt slot, so a reloaded session needs it reconstructed or every
     * resumed turn loses that guidance. ContextManifest / extraContexts /
     * mergeContexts aren't persisted; rehydrated user messages still carry
     * whatever the original turn had glued in.
     */
    async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
        const { owner } = sessionIdentity(opts.owner, opts.sessionId);
        return this.acquisitions.acquire(opts.sessionId, () => this.restoreSession(opts),
            (session) => assertReusable(session, owner, opts));
    }

    private async restoreSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
        const { owner } = sessionIdentity(opts.owner, opts.sessionId);
        const existing = this.sessions.get(opts.sessionId);
        if (existing) return existing;
        let initialMessages: ReturnType<typeof rowsToAgentMessages> = [];
        let parentChatId: string | undefined;
        // Caller-supplied workspaceId wins — covers the cold-start window where the
        // node row hasn't been synced from the frontend yet.
        let workspaceId: string | null = opts.workspaceId ?? null;
        if (isRunOwner(owner)) {
            initialMessages = rowsToAgentMessages((opts.replayHistory ?? []).map((message) => ({
                role: message.role,
                content: message.content,
                created_at: Date.now(),
            })));
        } else try {
            const row = getRuntimeDeps().historyStore.getNode(opts.sessionId);
            parentChatId = row?.parent_node_id ?? undefined;
            if (!workspaceId) workspaceId = row?.workspace_id ?? null;
            // The same view the settled-turn checkpoint hashes (PiSdkSession.piHostHistory):
            // posted check-ins replay as facts, never their text (DESIGN-v2 §2.8 T2).
            const rows = getRuntimeDeps().historyStore.listMessages(opts.sessionId);
            initialMessages = rowsToAgentMessages(piHostHistory(rows));
        } catch (err) {
            throw Object.assign(new Error('Pi history could not be restored; original history was retained. Please retry.'), { cause: err });
        }

        const ancestorChain: AgentSession[] = [];
        if (parentChatId) {
            sessionRegistry.ensureAncestorChainLoaded(parentChatId);
            const parent = sessionRegistry.getSession(parentChatId);
            if (parent) {
                ancestorChain.push(...sessionRegistry.getAncestors(parentChatId), parent);
            }
        }

        const enableFollowUps = opts.enableFollowUps !== false
            && !isAssistantProfile(opts.toolProfile)
            && !isMaintenanceProfile(opts.toolProfile);
        const preamble = buildPreamble({
            enableFollowUps,
            ...(isAssistantProfile(opts.toolProfile) ? { toolCapabilities: assistantHead(opts.toolProfile) } : {}),
            ...(isMaintenanceProfile(opts.toolProfile) ? { toolCapabilities: "maintenance" as const } : {}),
            artifactTools: isRunOwner(owner) ? [] : artifactToolsForProfile(opts.toolProfile),
            cwd: opts.cwd,
            ancestors: ancestorChain,
            ...piHostSkills(owner, opts.toolProfile),
        });
        const effectivePreamble = [preamble, opts.bootstrapInstructions].filter(Boolean).join("\n\n");

        const sessionDeps = {
            bridge: this.bridge,
            sdkExtensionFactories: this.extensionsFor(opts.sessionId, owner, { ...opts, workspaceId }),
            cwd: opts.cwd,
            enableFollowUps,
            preamble: effectivePreamble,
            initialMessages,
            parentChatId,
            workspaceId,
            ownerUserId: opts.ownerUserId ?? null,
            owner,
            profileHash: opts.profileHash ?? null,
            toolProfile: opts.toolProfile,
            permissionBroker: opts.permissionBroker,
            requestedProvider: opts.provider ?? null,
            requestedModel: opts.model ?? null,
            requestedReasoning: opts.reasoning ?? null,
            initialPlan: initialPlanFor(owner, opts),
        };
        const session = await createPiSession(opts.sessionId, { ...sessionDeps, restoreNative: true });
        this.sessions.set(opts.sessionId, session as AgentSession & { destroy(): void; dispose?(): Promise<void> });
        sessionRegistry.registerSession(session, opts.ownerUserId ?? null, owner);
        return session;
    }

    /** Pi's shared library is supplied by Michi; no runtime-owned skills are discovered. */
    async listSkills(_opts: ListRuntimeSkillsOptions): Promise<RuntimeSkillListing> { return { skills: [] }; }

    async listModels(opts?: { provider?: string }): Promise<ModelInfo[]> {
        const cfg = getRuntimeDeps().agentConfig.getAgentConfig();
        const provider = opts?.provider ?? cfg.provider;
        try {
            const models = await listPiModels(provider);
            return models.map((m) => ({
                id: m.model_id,
                label: m.model_name,
                description: m.description,
                supportsReasoning: m.supportsReasoning,
                supportedReasoningLevels: m.supportedReasoningLevels,
                defaultReasoning: m.defaultReasoning,
            }));
        } catch (err) {
            console.warn(`[piRuntime] listPiModels(${provider}) failed:`, err);
            return [];
        }
    }

    /** Used by /api/agent/status to surface the multi-provider catalog. */
    async listProviders(): Promise<AgentProviderInfo[]> {
        return listProviderInfos().map((p) => ({
            id: p.id,
            label: p.name,
            keyLabel: p.apiKeyLabel,
            envVars: p.envVars,
            // The UI selects this entry in the model picker, so it has to name
            // the model users actually get (the floating alias when there is one).
            defaultModel: selectDefaultModelId(p),
            keyUrl: p.keyUrl,
            supportsReasoning: p.supportsReasoning,
            requiresUserKey: p.requiresUserKey,
            modelLocked: p.modelLocked,
        }));
    }

    /**
     * Used by /api/agent/provider-key/verify. Falls back to the disk-stored
     * key when the body omits one (e.g. a "verify the key I just saved" flow).
     */
    async verifyProviderKey(body: VerifyProviderKeyOptions): Promise<VerifyProviderKeyResult> {
        const cfg = getRuntimeDeps().agentConfig.getAgentConfig();
        const provider = body.provider ?? cfg.provider;
        const apiKey = body.key ?? getRuntimeDeps().providerKeys.getProviderApiKey(provider) ?? undefined;
        return verifyPiProviderKey({ provider, key: apiKey, model: body.model });
    }

    /** One provider request with no tools and no session (piStructured.ts). */
    completeStructured(opts: StructuredCompletionOptions): Promise<StructuredCompletion> {
        return completePiStructured(opts);
    }

    /** Compatibility alias; release must await provider/MCP retirement. */
    dropSession(id: string): Promise<void> { return this.releaseSession(id); }

    async releaseSession(id: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
        return this.acquisitions.release(id, () => this.disposeSession(id, expectedOwner));
    }

    private async disposeSession(id: string, expectedOwner?: RuntimeSessionOwner): Promise<void> {
        const session = this.sessions.get(id);
        const actualOwner = session?.owner ?? (session ? chatOwner(session.id) : undefined);
        if (expectedOwner && actualOwner) assertReleaseOwnership(actualOwner, expectedOwner);
        if (session?.dispose) await session.dispose();
        else session?.destroy();
        if (this.sessions.get(id) === session) this.sessions.delete(id);
        sessionRegistry.dropSession(id);
    }

    /**
     * Removes a released session's scope directory under
     * `<data>/pi-sessions/` (DESIGN-v2 §3.2). An ephemeral session never
     * wrote one, so this answers `absent` for it; it also clears what an
     * earlier session under that id left. The workspace part of the scope
     * comes from this process's record of the session, else the node row.
     * `deferred` while the session is live or opening.
     */
    async discardNativeSession(input: NativeSessionDiscardInput): Promise<NativeSessionDiscardResult> {
        const id = isRunOwner(input.owner) ? input.owner.key : (input.sessionId ?? input.owner.key);
        if (this.sessions.has(id) || this.acquisitions.has(id)) return 'deferred';
        const workspaces = new Set<string | null>();
        if (this.sessionWorkspaces.has(id)) workspaces.add(this.sessionWorkspaces.get(id) ?? null);
        if (!isRunOwner(input.owner)) {
            const node = getRuntimeDeps().historyStore.getNode(id);
            if (node) workspaces.add(node.workspace_id ?? null);
        }
        let removed = false;
        for (const workspaceId of workspaces) {
            removed = discardPiSdkSessionDirectory(id, {
                ownerUserId: input.ownerUserId ?? null, workspaceId, owner: input.owner, profileHash: input.profileHash ?? null,
            }) || removed;
        }
        this.sessionWorkspaces.delete(id);
        return removed ? 'discarded' : 'absent';
    }

    async shutdown(): Promise<void> {
        await Promise.allSettled([...this.acquisitions.values()]);
        await Promise.allSettled([...this.sessions.keys()].map((id) => this.releaseSession(id)));
    }
}

/**
 * The persisted plan a chat session's todo list starts from. Only ordinary
 * chats get the todo tool; Runs, the assistant and maintenance start empty.
 * A lookup failure starts empty rather than failing the session.
 */
function initialPlanFor(
    owner: RuntimeSessionOwner,
    opts: NewAgentSessionOptions | LoadAgentSessionOptions,
    branch?: NewAgentSessionOptions['branchContext'],
): PlanEntry[] | null {
    const nodeId = chatNodeOf(owner);
    if (nodeId === undefined || opts.toolProfile?.restricted
        || isAssistantProfile(opts.toolProfile) || isMaintenanceProfile(opts.toolProfile)) return null;
    try {
        return getRuntimeDeps().historyStore.getPlanSnapshot?.({
            nodeId,
            userId: opts.ownerUserId ?? null,
            ...(branch ? { branch: {
                parentNodeId: branch.parentNodeId,
                ...(branch.boundaryMessageId === undefined ? {} : { boundaryMessageId: branch.boundaryMessageId }),
            } } : {}),
        }) ?? null;
    } catch (error) {
        console.warn(`[piRuntime] plan snapshot for ${nodeId} unavailable:`, (error as Error).message);
        return null;
    }
}

/** A disposed session is never reused. */
function assertReusable(session: AgentSession, owner: RuntimeSessionOwner, opts: NewAgentSessionOptions | LoadAgentSessionOptions): AgentSession {
    (session as PiSession).assertAvailable();
    return assertSessionReusable(session, { owner, ownerUserId: opts.ownerUserId, profileHash: opts.profileHash },
        (s) => (s as PiSession).getOwnerUserId());
}
