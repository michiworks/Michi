import { beginSse } from "../services/httpSse";
export { writeSseFrame, type SseWritableResponse } from "../services/httpSse";
import { createToolOutputStreamProjector, projectMessageRowsForTransport } from "./toolOutputTransport";
import { resetKiroContext } from '../services/resetKiroContext';
import { subscribeSessionStates } from '../agents/sessionStateFeed';
import express from "express";
import path from "path";
import fs from "fs";
import { normalizeWorkspaceCwd } from "../agents/tools/pathSandbox";
import {
    getUserSandboxRoot,
    deriveSandboxCwd,
    NotFoundError,
    workspaceSessionCwd,
    ownedSandboxCwd,
} from "../services/workspaceSandbox";
import { workConversationCwd } from "../services/workConversationWorktree";
import { randomUUID } from "node:crypto";
import { CheckinSessionError, ChatManager, ExtraContext, PrimaryAgentBindingError, primaryAgentSessionOptions } from "../services/chatManager";
import { assistantPurposeOf, assistantTargetWorkspace, isAssistantNode } from "../assistant/identity";
import { companionStartTaint } from "../assistant/startTaint";
import { sessionReplayHistory } from "../agents/sessionReplayView";
import { getCompanionSettings } from "../services/companion/settings";
import { forgetCompanionContext } from "../services/companion/turnContext";
import { activeTurnTrust, carriedCompanionTaintOf, clearCarriedCompanionTaint, recordCompanionTaint } from "../services/turnTrust";
import { finalTerminalEvent } from "./chatStreamEvents";
import { chatReplayUnavailable } from './chatReplay';
import { getRuntime } from "../agents/registry";
import { descriptorOf } from "michi-runtime/internal/core/descriptors";
import { getModelReasoningOptions } from '../agents/modelReasoning';
import { getAgentConfig, resolveModel, resolveReasoning, resolveProvider, recordLastUsedProviderModel } from "../services/agentConfig";
import { startupMark } from "../services/startupTrace";
import { workspaceCwdError } from "../services/workspaceCwd";
import { importSubdir, placeWorkspaceFile } from "../services/workspaceFiles";
import { log } from "../services/logger";
import * as sessionRegistry from "../agents/sessionRegistry";
import { chatOwner } from "../agents/ownerMapping";
import { chatHub, TurnGuardError, type BackgroundCursor, type HubSubscriber } from "../agents/chatHub";
import { encodeScheduledJobEvent, encodeScheduledJobsChangedEvent, scheduledJobEvents } from "../services/scheduledJobs/events";
import { attentionFeed } from "../services/attention/attentionFeed";
import { answerChatPermission, getSessionByIdentifier, resolvePublicNodeId } from "../services/chatPermissionAnswers";
import { encodeWorkspaceStructureChangedEvent, structureEvents } from "../services/structureEvents";
import { HEARTBEAT_INTERVAL_MS } from "../config/constants";
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent, isNoAppliedTurnCursor, TURN_ERROR_CODES } from "michi-shared";
import {
    MetaAgentChatContextError,
    hasSpacesTurnContext,
    isCheckinNodeId,
    parseMetaAgentChatTurnContext,
    type CompanionTurnMetadata,
    type MetaAgentChatTurnContext,
} from 'michi-shared';
import {
    withAssistantTurnContext,
    type AssistantTurnArea,
    type CompanionTurnContext,
} from "../services/metaAgent/chatTurnContext";
import { isChatPermissionMode } from 'michi-shared';
import { writeNodePermissionMode } from '../services/chatPermissions';
import { isCrewMemoryMode } from 'michi-shared';
// getSessionForUser enforces ownership in cloud mode; getSession is for internal callers.
const { getSessionForUser } = sessionRegistry;
import type { AgentSession } from "../agents/types";
import { LOCAL_AGENT_OWNER_ID, requestAgentOwnerOrNull } from "../services/agentOwner";
import { startTemporaryConversation } from "../services/memory/memoryService";
import { crewMemoryModeFor } from "../services/crewMemory";
import {
    getAiGlobalContext,
    getNode,
    getNodeSessionBinding,
    getNodeWorkspaceId,
    getSavedTurn,
    getWorkspace,
    listGrants,
    listMessages,
    revokePermission,
    saveWorkspace,
    updateNodeResumeBinding,
    setEdgeForkProvenance,
} from "../services/dbRepository";
import type { WorkspaceRow } from "../services/dbRepository";
import {
    BranchBoundaryError,
    resolveBranchBoundary,
    toBranchContext,
    type BranchBoundary,
} from "../services/branchBoundary";
import { multiModelForkBoundary, rebuildInheritance } from "../services/sessionRestore";
import { ensureRequestedGraphNode } from "./graphPrerequisite";
import { dbWorker, isDbWorkerReady } from "../services/dbWorkerClient";
import { acquireSessionRestoreLock, loadNativeSession, NativeResumeFailedError, nativeResumeIdFor } from '../services/nativeResume';
import { tryForkChatSession } from '../services/nativeFork';
import { isNativeResumeEnabled } from '../services/agentConfig';
import { requireWorkspaceOwner, requireChatOwner, requireNodeOwner } from "./middleware/ownership";
import {
    parseSkillInvocationRequest,
    resolveSkillInvocation,
    SkillInvocationError,
    skillMessageMetadata,
} from "../services/skills/invocation";
import { workspaceSkillCwd } from "../services/skills/workspaceCwd";
import type { SkillTurnInvocation } from "michi-runtime";
import { META_AGENT_GUARD_ERROR_CODE, isMetaAgentGuardError } from '../agents/metaAgentGuard';
import { artifactToolsForProfile, canLookUpArtifacts } from '../agents/artifactToolNames';
import { workspaceArtifactManifest } from '../agents/artifactTools';
import {
    buildCompatibleResumeContext,
    buildTargetResumeSignature,
    chooseResumeStrategy,
    normalizeResumeSignature,
    normalizeReasoning,
    normalizeSignaturePart,
    signaturesEqual,
    type ResumeSignature,
    type ResumeStrategy,
    type TranscriptMessage,
} from "../services/resumeStrategy";

function inferRuntimeId(row: ReturnType<typeof getNode> | null, nodeId: string): string | null {
    const explicit = normalizeSignaturePart(row?.runtime_id);
    if (explicit) return explicit;
    const sid = normalizeSignaturePart(row?.acp_session_id);
    if (!sid) return null;
    return sid === nodeId ? "pi" : "kiro";
}

/**
 * The Scheduled window's default workspace as its agent may use it: the
 * user's own, not deleted, archived or a system workspace, with AI navigation
 * on (assistant/tools.ts applies the same rules to every job). Null otherwise.
 */
function scheduleDefaultWorkspace(workspaceId: string | null, userId: string | null): { id: string; name: string } | null {
    if (!workspaceId) return null;
    const workspace = assistantTargetWorkspace(userId, workspaceId);
    if (!workspace || workspace.archived_at != null) return null;
    if (!getAiGlobalContext(workspace.id, userId ?? undefined)) return null;
    return { id: workspace.id, name: workspace.name };
}

export function canAccessRuntimeChat(chatId: string, userId?: string): boolean {
    if (process.env.MICHI_CLOUD !== '1') return true;
    if (!userId) return false;
    return Boolean(getNodeSessionBinding(chatId, userId) || getSessionForUser(chatId, userId));
}

/**
 * A message's UI node must be the persisted owner of its runtime chat id.
 * This closes the gap where a caller who owns two nodes could send a turn to
 * one runtime while attributing its durable events to the other node.
 */
export function isRuntimeChatBoundToNode(chatId: string, nodeId: string, userId?: string): boolean {
    if (process.env.MICHI_CLOUD !== '1' || !userId) return false;
    return getNodeSessionBinding(chatId, userId)?.nodeId === nodeId;
}

/** Artifacts a first turn's manifest names at most. */
const CONTEXT_MANIFEST_MAX = 50;

/**
 * A contextManifest's first CONTEXT_MANIFEST_MAX entries. A client that sends
 * no artifactCount sends every artifact, so a longer manifest used to be
 * refused, and with it every message of a workspace with more artifacts. The
 * agent finds the rest with list_artifacts and search_artifacts.
 */
function clampContextManifest(manifest: unknown[], route: string): unknown[] {
    if (manifest.length <= CONTEXT_MANIFEST_MAX) return manifest;
    log.warn('chat', 'contextManifest clamped', { route, received: manifest.length, kept: CONTEXT_MANIFEST_MAX });
    return manifest.slice(0, CONTEXT_MANIFEST_MAX);
}

/** The body's artifactCount: how many artifacts the workspace has in all. Undefined when absent. */
function readArtifactCount(raw: unknown): number | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
        throw new Error('artifactCount must be a non-negative integer');
    }
    return raw;
}

const MAX_BACKGROUND_CURSORS = 5_000;
function readBackgroundCursors(raw: unknown): Record<string, BackgroundCursor> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, BackgroundCursor> = {};
    for (const [chatId, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_BACKGROUND_CURSORS)) {
        if (!chatId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        const turnId = (value as { turnId?: unknown }).turnId;
        const seq = (value as { seq?: unknown }).seq;
        if (typeof turnId !== 'string' || typeof seq !== 'number' || !Number.isFinite(seq)) continue;
        // A chat the window knows without an applied turn names no turn: no
        // replay log matches it, so a durable turn answers it with a gap.
        if (!turnId && !isNoAppliedTurnCursor({ turnId, seq })) continue;
        out[chatId] = { turnId, seq: Math.max(-1, Math.trunc(seq)) };
    }
    return out;
}

/** The chat's node and the latest turn SQLite applied for it (owner-scoped in cloud mode). */
function durableBackgroundCursor(chatId: string, ownerUserId: string | null): { nodeId: string; cursor?: BackgroundCursor } | null {
    const binding = getNodeSessionBinding(chatId, ownerUserId);
    if (!binding) return null;
    const row = getNode(binding.nodeId);
    return row?.last_applied_turn_id && typeof row.last_applied_seq === 'number'
        ? { nodeId: binding.nodeId, cursor: { turnId: row.last_applied_turn_id, seq: row.last_applied_seq } }
        : { nodeId: binding.nodeId };
}

function ensureCloudWorkspaceRow(userId: string | undefined, workspaceId: string | null | undefined): void {
    if (process.env.MICHI_CLOUD !== "1" || !userId || !workspaceId) return;
    try {
        deriveSandboxCwd(userId, workspaceId);
        return;
    } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
    }

    const now = Date.now();
    const row: WorkspaceRow = {
        id: workspaceId,
        name: "Untitled",
        cwd: null,
        active_tree_id: null,
        created_at: now,
        updated_at: now,
        settings: null,
        deleted_at: null,
        archived_at: null,
        owner_user_id: userId,
    };
    saveWorkspace(row);
}

/** The agent's name in a replayed post's one-line fact (agents/sessionReplayView flattens it and falls back to the default). */
const companionReplayName = () => getCompanionSettings().displayName;

/**
 * A node's stored conversation as a rebuilt session replays it (DESIGN-v2
 * §2.8 T2): posted check-ins as Michi's one-line facts, never their text.
 */
function replayTranscript(nodeId: string, userId?: string): TranscriptMessage[] {
    return sessionReplayHistory(listMessages(nodeId, userId), { name: companionReplayName });
}

/**
 * The history a fresh session for this node starts from: the client's
 * priorMessages for an ordinary chat that sends them, else the stored rows
 * through the replay view. An assistant conversation always replays its own
 * stored rows: a client's copy could carry a post's text (§2.8 T2).
 */
function readTranscriptMessages(input: unknown, nodeId: string, userId?: string): TranscriptMessage[] {
    if (Array.isArray(input) && !isAssistantNode(nodeId)) {
        return input.flatMap((item): TranscriptMessage[] => {
            if (!item || typeof item !== "object") return [];
            const row = item as Record<string, unknown>;
            const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
            const content =
                typeof row.content === "string"
                    ? row.content
                    : typeof row.text === "string"
                        ? row.text
                        : null;
            if (!role || content === null) return [];
            return [{ role, content }];
        });
    }
    return replayTranscript(nodeId, userId);
}

/**
 * A conversation whose purpose is a check-in's (identity.ts assistantPurposeOf,
 * w2-fix D13): an `n-cmph-` id, made or not, or a node recorded 'checkin' or
 * 'companion' (the MVP's closed conversation). The prefix is checked before
 * any lookup; a purpose that cannot be read leaves the id to the route's own
 * lookups.
 */
function checkinPurposeId(id: unknown): boolean {
    if (typeof id !== 'string' || !id) return false;
    if (isCheckinNodeId(id)) return true;
    try { return assistantPurposeOf(id) === 'checkin'; } catch { return false; }
}

/**
 * A check-in's conversation (DESIGN-v2 §2.5) takes nothing from a client: no
 * message, steer, compaction, session, reload, mode, model, command, stream,
 * saved turn, cancel or answer to a prompt. Checked before the node is looked
 * up, so a purged or never-made `n-cmph-` id is refused too. Writes the 409
 * and returns true when one of `ids` is one.
 */
function refuseCheckinNode(res: express.Response, ...ids: unknown[]): boolean {
    if (!ids.some(checkinPurposeId)) return false;
    res.status(409).json({ code: 'checkin_node', error: "A check-in's conversation takes no requests" });
    return true;
}

/**
 * The chat's live session was compacted outside a turn (the compact route):
 * the agent's standing [COMPANION CONTEXT] blocks go again on its next turn
 * (a compaction inside a turn is seen by services/companion/turnContext.ts
 * itself), and the check-in material earlier turns took in is no longer
 * carried (w2-fix D1). execute-command does the same for /clear and /compact.
 */
function compactedOrCleared(nodeId: string, session: AgentSession | undefined): void {
    if (session) forgetCompanionContext(session);
    clearCarriedCompanionTaint(nodeId);
}

/**
 * The fields of a user message's metadata only the backend writes (DESIGN-v2
 * §8.1(e); `skill`, which skill a message ran); a client's copy is dropped.
 */
const SERVER_OWNED_USER_METADATA = ['companionTurn', 'companionSend', 'companionPost', 'skill'] as const;

function clientUserMetadata(raw: unknown): Record<string, unknown> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const kept = { ...(raw as Record<string, unknown>) };
    for (const key of SERVER_OWNED_USER_METADATA) delete kept[key];
    return kept;
}

function readExistingSignature(
    row: ReturnType<typeof getNode> | null,
    body: Record<string, unknown>,
    nodeId: string,
): ResumeSignature | null {
    return normalizeResumeSignature({
        runtimeId: row?.runtime_id ?? body.runtimeId ?? inferRuntimeId(row, nodeId),
        runtimeEngine: row?.runtime_engine,
        providerId: row?.provider_id ?? body.providerId,
        modelId: row?.model_id ?? body.modelId,
        reasoning: row?.reasoning ?? body.reasoning,
    });
}

function isConcurrencyError(err: unknown): boolean {
    // Every runtime's cap throws a `*ConcurrencyError` (ClaudeConcurrencyError,
    // CodexConcurrencyError, KiroConcurrencyError) — treat them uniformly.
    return /ConcurrencyError$/.test((err as Error | undefined)?.name ?? "");
}

function sendAgentRouteError(res: express.Response, err: unknown): void {
    if (isMetaAgentGuardError(err)) {
        res.status(503).json({ code: META_AGENT_GUARD_ERROR_CODE, error: (err as Error).message });
        return;
    }
    if (err instanceof BranchBoundaryError) {
        res.status(409).json({ code: err.code, error: err.message });
        return;
    }
    if (err instanceof TurnBusyError) {
        res.status(409).json({ code: TURN_ERROR_CODES.active, error: err.message });
        return;
    }
    if (err instanceof NativeResumeFailedError) {
        res.status(503).json({ code: 'NATIVE_RESUME_FAILED', error: err.message });
        return;
    }
    // DESIGN-v2 §2.5: a check-in node is refused before an open binding could answer for it.
    if (err instanceof CheckinSessionError || (err instanceof TurnGuardError && err.code === 'checkin_node')) {
        res.status(409).json({ code: 'checkin_node', error: err.message });
        return;
    }
    if (err instanceof TurnGuardError) {
        res.status(400).json({ code: err.code, error: err.message });
        return;
    }
    if (err instanceof PrimaryAgentBindingError) {
        res.status(400).json({ code: "PRIMARY_AGENT_INVALID", error: err.message });
        return;
    }
    if (isConcurrencyError(err)) {
        const runtimeId = ({ ClaudeConcurrencyError: 'claude', CodexConcurrencyError: 'codex', KiroConcurrencyError: 'kiro' } as Record<string, string>)[(err as Error).name];
        res.status(503).json({
            code: "RUNTIME_SESSIONS_BUSY",
            runtimeId,
            error: (err as Error).message,
        });
        return;
    }
    res.status(500).json({ error: (err as Error).message });
}

/** A turn holds its session until runtime cleanup ends, after the visible reply. */
function turnBusy(nodeId: string): boolean {
    return chatHub.holdsSession(nodeId);
}

/** The session is still held by a turn: a 409 `turn_active` the client may
 * silently retry with the same request, not a restore failure. */
class TurnBusyError extends Error {}

/**
 * A resent turn ID whose turn already began (it has a durable receipt, in any
 * state) is never run again: a second run would repeat its tool calls and
 * replace its saved answer. Turn begin itself is idempotent for that ID.
 */
function turnAlreadyBegan(turnId: string | undefined): boolean {
    return !!turnId && chatHub.requestedTurnStatus(turnId) !== null;
}
const TURN_ALREADY_BEGAN = {
    error: 'This message was already sent, so it was not sent again.',
    code: TURN_ERROR_CODES.alreadyBegan,
} as const;

async function retireLiveSession(session: AgentSession | undefined): Promise<void> {
    if (!session) return;
    const runtime = getRuntime(session.runtimeId);
    try {
        await Promise.resolve(runtime ? runtime.releaseSession(session.id) : session.cancel());
    } catch (error) {
        throw new NativeResumeFailedError(error);
    }
    sessionRegistry.dropSession(session.id);
}

async function persistResumeBinding(
    nodeId: string,
    session: AgentSession,
    signature: ResumeSignature,
    fingerprint: string | null,
    skipUnchanged = false,
): Promise<void> {
    const fields = {
        nodeId,
        acp_session_id: session.nativeSessionId ?? session.id,
        runtime_id: signature.runtimeId,
        runtime_engine: session.nativeEngine ?? null,
        provider_id: signature.providerId ?? null,
        model_id: signature.modelId ?? null,
        reasoning: signature.reasoning ?? null,
        resume_fingerprint: fingerprint ?? null,
        current_mode_id: session.currentModeId ?? null,
    };
    const row = skipUnchanged ? getNode(nodeId) : null;
    const externalSessionId = (fields.runtime_id === 'codex' || fields.runtime_id === 'claude')
        && fields.acp_session_id !== nodeId ? fields.acp_session_id : null;
    const runtimeEngine = fields.runtime_id === 'kiro' ? fields.runtime_engine ?? 'v2' : null;
    // A committed live binding needs no new write. Avoid waiting behind unrelated
    // worker writes on every follow-up; new/changed bindings still await commit.
    if (row
        && row.acp_session_id === fields.acp_session_id
        && (row.external_session_id ?? null) === externalSessionId
        && row.runtime_id === fields.runtime_id
        && (row.runtime_engine ?? null) === runtimeEngine
        && (row.provider_id ?? null) === fields.provider_id
        && (row.model_id ?? null) === fields.model_id
        && (row.reasoning ?? null) === fields.reasoning
        && (row.resume_fingerprint ?? null) === fields.resume_fingerprint
        && (fields.current_mode_id === null || row.current_mode_id === fields.current_mode_id)) return;
    if (isDbWorkerReady()) {
        // The next ensure-session may arrive immediately after cancel. It must
        // observe this binding rather than manufacture another fresh session.
        await dbWorker.persistResumeBinding(fields);
        return;
    }
    // Fallback: synchronous on main thread
    try {
        updateNodeResumeBinding(nodeId, {
            acp_session_id: fields.acp_session_id,
            runtime_id: fields.runtime_id,
            runtime_engine: fields.runtime_engine,
            provider_id: fields.provider_id,
            model_id: fields.model_id,
            reasoning: fields.reasoning,
            resume_fingerprint: fields.resume_fingerprint,
            current_mode_id: fields.current_mode_id,
        });
    } catch (err) {
        console.warn(`Failed to persist resume binding for ${nodeId}:`, err);
        throw err;
    }
}

/** The desktop cwd and absolute source file that link-file and copy-file take. */
function desktopSourceFile(body: { cwd?: unknown; sourcePath?: unknown } | undefined, cloudError: string):
    { cwd: string; sourcePath: string; size: number } | { status: number; body: object } {
    if (process.env.MICHI_CLOUD === "1") return { status: 400, body: { error: cloudError } };
    const cwd = body?.cwd;
    const invalid = workspaceCwdError(cwd);
    if (invalid) return { status: 400, body: invalid };
    const sourcePath: unknown = body?.sourcePath;
    if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) {
        return { status: 400, body: { error: "sourcePath must be an absolute path" } };
    }
    // statSync follows symlinks, so a link-to-a-file source is accepted and
    // its real size reported. Directories are rejected (symlink-to-dir would
    // let the agent tree-walk outside cwd).
    try {
        const s = fs.statSync(sourcePath);
        if (!s.isFile()) return { status: 400, body: { error: "sourcePath is not a file" } };
        return { cwd: cwd as string, sourcePath, size: s.size };
    } catch {
        return { status: 400, body: { error: "sourcePath does not exist" } };
    }
}

/** `max` refuses a longer list; without it (contextManifest) a longer one is clamped. */
function readExtraContexts(raw: unknown, label: string, max?: number): ExtraContext[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || (max !== undefined && raw.length > max)) {
        throw new Error(max === undefined ? `${label} must be an array` : `${label} must be an array of at most ${max} items`);
    }
    const items = max === undefined ? clampContextManifest(raw, "ensure-session") : raw;
    for (const item of items) {
        // Link artifacts carry `url` and an empty filePath; file/doc
        // artifacts carry a real filePath. Require exactly one.
        if (
            typeof item !== "object" || item === null ||
            typeof (item as ExtraContext).name !== "string" || (item as ExtraContext).name.length > 64 ||
            typeof (item as ExtraContext).filePath !== "string" ||
            (!(item as ExtraContext).filePath && typeof (item as ExtraContext).url !== "string")
        ) {
            throw new Error(`each ${label} item must have name (<=64 chars) and either filePath or url`);
        }
        const ctx = item as ExtraContext;
        if (ctx.filePath.includes("..")) {
            throw new Error(`${label} filePath must not contain ..`);
        }
        if ("url" in ctx && ctx.url !== undefined && typeof ctx.url !== "string") {
            throw new Error(`${label}.url must be a string when provided`);
        }
        if ("size" in ctx && ctx.size !== undefined && (typeof ctx.size !== "number" || !Number.isFinite(ctx.size) || ctx.size < 0)) {
            throw new Error(`${label}.size must be a non-negative number when provided`);
        }
        if ("kind" in ctx && ctx.kind !== undefined && ctx.kind !== "embedded" && ctx.kind !== "reference" && ctx.kind !== "symlink") {
            throw new Error(`${label}.kind must be 'embedded', 'reference', or 'symlink' if present`);
        }
    }
    return items as ExtraContext[];
}

/**
 * The checks of an ensure-session body that need no node or session, so a
 * malformed request is refused before the route writes the graph node or
 * the permission mode. A cloud request's cwd is derived later, not read.
 */
function parseEnsureSessionBody(body: Record<string, unknown>): {
    cwd?: string;
    model?: string;
    agentDefinitionId?: string;
    modeId?: string;
    mergeContexts: string[];
    extraContexts?: ExtraContext[];
    contextManifest?: ExtraContext[];
    artifactCount?: number;
    enableFollowUps: boolean;
    /** A temporary chat, chosen before the first turn (startTemporaryConversation). */
    temporary: boolean;
} | { invalid: Record<string, unknown> } {
    const invalid = (error: string) => ({ invalid: { error } });
    if (process.env.MICHI_CLOUD !== "1" && body.cwd !== undefined) {
        const cwdError = workspaceCwdError(body.cwd);
        if (cwdError) return { invalid: cwdError };
    }
    for (const field of ['runtimeId', 'providerId', 'modelId']) {
        if (body[field] !== undefined && (typeof body[field] !== 'string' || !(body[field] as string).trim())) {
            return invalid(`${field} must be a non-empty string`);
        }
    }
    if (body.reasoning !== undefined && body.reasoning !== null && !normalizeReasoning(body.reasoning)) {
        return invalid('Invalid reasoning level');
    }
    if (body.model !== undefined && typeof body.model !== "string") return invalid("model must be a string");
    if (body.agentDefinitionId !== undefined && (typeof body.agentDefinitionId !== "string" || !body.agentDefinitionId.trim())) {
        return invalid("agentDefinitionId must be a non-empty string");
    }
    // Desired agent/mode for a brand-new thread (e.g. Home composer pre-pick).
    // Applied after a fresh session is created so the first prompt runs under it.
    if (body.modeId !== undefined && typeof body.modeId !== "string") return invalid("modeId must be a string");
    if (body.mergeContexts !== undefined
        && (!Array.isArray(body.mergeContexts) || !body.mergeContexts.every((x) => typeof x === "string"))) {
        return invalid("mergeContexts must be an array of strings");
    }
    let extraContexts: ExtraContext[] | undefined;
    let contextManifest: ExtraContext[] | undefined;
    let artifactCount: number | undefined;
    try {
        extraContexts = readExtraContexts(body.extraContexts, "extraContexts", 20);
        contextManifest = readExtraContexts(body.contextManifest, "contextManifest");
        artifactCount = readArtifactCount(body.artifactCount);
    } catch (err) {
        return invalid((err as Error).message);
    }
    if (body.enableFollowUps !== undefined && typeof body.enableFollowUps !== "boolean") {
        return invalid("enableFollowUps must be a boolean");
    }
    if (body.temporary !== undefined && typeof body.temporary !== "boolean") return invalid("temporary must be a boolean");
    return {
        cwd: body.cwd as string | undefined,
        model: body.model as string | undefined,
        agentDefinitionId: body.agentDefinitionId as string | undefined,
        modeId: body.modeId as string | undefined,
        mergeContexts: (body.mergeContexts as string[] | undefined) ?? [],
        extraContexts,
        contextManifest,
        ...(artifactCount !== undefined ? { artifactCount } : {}),
        enableFollowUps: body.enableFollowUps !== false,
        temporary: body.temporary === true,
    };
}

export function setupMichiRoutes(chatManager: ChatManager) {
    const router = express.Router();

    // Copies an externally-picked file into <cwd>/.contexts/. The frontend
    // reads the bytes via <input type="file"> (which uses the OS native
    // dialog under Electron) and posts either utf-8 text (`content`) for
    // text files or base64-encoded bytes (`contentBase64`) for binary
    // attachments like pasted images. Context injection in chatManager.ts
    // is char-based and confined to cwd, so writing here keeps both
    // untitled and real workspaces on a single code path.
    router.post("/workspaces/import-file", requireWorkspaceOwner, (req, res) => {
        // In cloud mode cwd is derived server-side from the workspace's owned
        // sandbox directory; the client-supplied cwd is ignored.
        let cwd: string;
        const originalName: unknown = req.body?.originalName;
        const content: unknown = req.body?.content;
        const contentBase64: unknown = req.body?.contentBase64;
        if (process.env.MICHI_CLOUD === "1") {
            const userId = req.user!.id;
            const workspaceId: unknown = req.body?.workspaceId;
            if (typeof workspaceId !== "string" || !workspaceId) {
                return res.status(400).json({ error: "workspaceId is required" });
            }
            const owned = ownedSandboxCwd(userId, workspaceId);
            if ("error" in owned) return res.status(owned.status).json({ error: owned.error });
            cwd = owned.cwd;
        } else {
            const cwdRaw: unknown = req.body?.cwd;
            const invalid = workspaceCwdError(cwdRaw);
            if (invalid) return res.status(400).json(invalid);
            cwd = cwdRaw as string;
        }
        if (typeof originalName !== "string" || originalName.length === 0) {
            return res.status(400).json({ error: "originalName required" });
        }
        const hasText = typeof content === "string";
        const hasBinary = typeof contentBase64 === "string";
        if (hasText === hasBinary) {
            return res.status(400).json({ error: "exactly one of content or contentBase64 required" });
        }

        let bytes: Buffer;
        if (hasText) {
            const text = content as string;
            if (text.length > 1_000_000) {
                return res.status(413).json({ error: `file too large (${text.length} chars; max 1,000,000)` });
            }
            bytes = Buffer.from(text, "utf-8");
        } else {
            const b64 = contentBase64 as string;
            try {
                bytes = Buffer.from(b64, "base64");
            } catch (err) {
                return res.status(400).json({ error: `invalid base64: ${(err as Error).message}` });
            }
            if (bytes.length === 0) {
                return res.status(400).json({ error: "decoded payload is empty" });
            }
            if (bytes.length > 20_000_000) {
                return res.status(413).json({ error: `file too large (${bytes.length} bytes; max 20,000,000)` });
            }
        }

        const subdir = importSubdir(req.body?.subdir);
        const placed = placeWorkspaceFile(cwd, subdir, originalName);
        if ("error" in placed) return res.status(placed.status).json({ error: placed.error });
        try {
            fs.writeFileSync(placed.target, bytes);
        } catch (err) {
            return res.status(500).json({ error: `write failed: ${(err as Error).message}` });
        }
        res.json({ ...placed.file, size: bytes.length });
    });

    // Creates a symlink inside <cwd>/.artifacts/ pointing at an externally-picked
    // file, WITHOUT copying bytes. Because the link lives under cwd, the linked
    // file resolves as a cwd-relative path, so the agent's filesystem tools
    // (read/write/edit) follow the symlink and read/write the external original
    // live — bidirectional sync. The in-app viewers (ArtifactPane → /artifacts/read,
    // Lightbox → /api/files) intentionally 404 symlinks that escape cwd (realpath
    // guard), so the Artifacts drawer opens symlink artifacts via the OS default app.
    //
    // Desktop-only: in cloud mode the per-user sandbox must never point at arbitrary
    // host paths, so linking is refused there (upload/copy is the only import path).
    router.post("/workspaces/link-file", requireWorkspaceOwner, (req, res) => {
        const source = desktopSourceFile(req.body, "linking external files is not supported in cloud mode");
        if ("status" in source) return res.status(source.status).json(source.body);
        const placed = placeWorkspaceFile(source.cwd, ".artifacts", source.sourcePath);
        if ("error" in placed) return res.status(placed.status).json({ error: placed.error });
        try {
            fs.symlinkSync(source.sourcePath, placed.target);
        } catch {
            try {
                fs.copyFileSync(source.sourcePath, placed.target);
            } catch (err) {
                return res.status(500).json({ error: `link/copy failed: ${(err as Error).message}` });
            }
        }
        res.json({ ...placed.file, size: source.size });
    });

    // ── Copy-file: zero-encode local file import (Electron fast path) ──────
    //
    // Like link-file but copies instead of symlinking. Used by the Electron
    // renderer when it can resolve a File's absolute disk path via
    // webUtils.getPathForFile — the frontend sends just the path, we do
    // fs.copyFile, and skip all base64 encoding / JSON serialization overhead.
    // Desktop-only (same restriction as link-file).
    router.post("/workspaces/copy-file", requireWorkspaceOwner, (req, res) => {
        const source = desktopSourceFile(req.body, "copy-file is not supported in cloud mode");
        if ("status" in source) return res.status(source.status).json(source.body);
        // 20MB cap consistent with import-file's base64 path
        if (source.size > 20_000_000) {
            return res.status(413).json({ error: `file too large (${source.size} bytes; max 20,000,000)` });
        }
        const placed = placeWorkspaceFile(source.cwd, importSubdir(req.body?.subdir), source.sourcePath);
        if ("error" in placed) return res.status(placed.status).json({ error: placed.error });
        try {
            fs.copyFileSync(source.sourcePath, placed.target);
        } catch (err) {
            return res.status(500).json({ error: `copy failed: ${(err as Error).message}` });
        }
        res.json({ ...placed.file, size: source.size });
    });

    /**
     * Pre-warm a cwd's ACP client + warmed session pool.
     *
     * Dispatches through the active runtime. Kiro warms its cwd ACP client
     * and next session; Claude registers the workspace in its warm pool and
     * resolves when the first warm slot is available.
     *
     * Frontend calls this on:
     *   - hydrate complete (for the active workspace's cwd)
     *   - workspace creation (for the new cwd)
     *   - workspace switch (for the target cwd)
     *
     * Idempotent: repeat calls for a cwd that already has a warmed session
     * are no-ops.
     */
    router.post("/warm", async (req, res) => {
        const routeStart = Date.now();
        // In cloud mode cwd is derived server-side from workspaceId.
        let cwd: string;
        if (process.env.MICHI_CLOUD === "1") {
            const userId = req.user!.id;
            const workspaceId: unknown = req.body?.workspaceId;
            if (typeof workspaceId !== "string" || !workspaceId) {
                return res.status(400).json({ error: "workspaceId is required in cloud mode" });
            }
            const owned = ownedSandboxCwd(userId, workspaceId);
            if ("error" in owned) return res.status(owned.status).json({ error: owned.error });
            cwd = owned.cwd;
        } else {
            const cwdRaw: unknown = req.body?.cwd;
            const invalid = workspaceCwdError(cwdRaw);
            if (invalid) return res.status(400).json(invalid);
            cwd = cwdRaw as string;
        }

        const userIdForConfig: string | undefined = process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined;
        const cfg = getAgentConfig(userIdForConfig);
        const runtime = getRuntime(cfg.runtime);
        startupMark("warm_route_start", { cwd, runtime: cfg.runtime });
        if (!runtime?.capabilities.warmSessions) {
            startupMark("warm_route_skipped", { cwd, runtime: cfg.runtime, durMs: Date.now() - routeStart });
            return res.json({ ok: true, skipped: true });
        }

        try {
            await runtime.warm(cwd, { model: resolveModel(cfg.runtime, userIdForConfig) });
            startupMark("warm_route_done", { cwd, runtime: cfg.runtime, durMs: Date.now() - routeStart });
            return res.json({ ok: true });
        } catch (err) {
            console.warn(`runtime.warm(${cwd}) failed:`, err);
            startupMark("warm_route_failed", {
                cwd,
                runtime: cfg.runtime,
                durMs: Date.now() - routeStart,
                error: (err as Error).message,
            });
            return res.json({ ok: true, warning: (err as Error).message });
        }
    });

    // "Test Connection": force-respawn the runtime for a cwd and probe backend
    // reachability. Powers the affordance the UI shows after a connection-class
    // turn failure so the user can tell "Kiro is back" from "still broken".
    router.post("/runtime/health", async (req, res) => {
        let cwd: string;
        if (process.env.MICHI_CLOUD === "1") {
            const userId = req.user!.id;
            const workspaceId: unknown = req.body?.workspaceId;
            if (typeof workspaceId !== "string" || !workspaceId) {
                return res.status(400).json({ error: "workspaceId is required in cloud mode" });
            }
            const owned = ownedSandboxCwd(userId, workspaceId);
            if ("error" in owned) return res.status(owned.status).json({ error: owned.error });
            cwd = owned.cwd;
        } else {
            const cwdRaw: unknown = req.body?.cwd;
            const invalid = workspaceCwdError(cwdRaw);
            if (invalid) return res.status(400).json(invalid);
            cwd = cwdRaw as string;
        }

        const userIdForConfig: string | undefined = process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined;
        const cfg = getAgentConfig(userIdForConfig);
        const runtime = getRuntime(cfg.runtime);
        if (!runtime) {
            return res.status(503).json({ ok: false, detail: "no runtime configured" });
        }
        try {
            if (runtime.checkHealth) {
                const result = await runtime.checkHealth(cwd, { model: resolveModel(cfg.runtime, userIdForConfig) });
                return res.json(result);
            }
            // Runtimes without a dedicated probe: warm() spawns/reaches the
            // backend, so a clean return is a positive liveness signal.
            if (runtime.capabilities.warmSessions) {
                await runtime.warm(cwd, { model: resolveModel(cfg.runtime, userIdForConfig) });
            }
            return res.json({ ok: true });
        } catch (err) {
            return res.json({ ok: false, detail: (err as Error).message });
        }
    });

    router.post("/chats", requireWorkspaceOwner, async (req, res) => {
        try {
            const parentChatId: string | undefined = req.body?.parentChatId;
            // A durable public node must own every runtime session.
            const nodeId: unknown = req.body?.nodeId;
            let validatedSessionId: string | undefined;
            if (nodeId !== undefined) {
                if (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 128) {
                    return res.status(400).json({ error: "nodeId must be a non-empty string ≤128 chars" });
                }
                validatedSessionId = nodeId;
            }

            if (!validatedSessionId) {
                return res.status(409).json({ code: 'NODE_NOT_PERSISTED', error: 'nodeId and durable node prerequisite required before session creation' });
            }
            if (process.env.MICHI_CLOUD === '1' && getNode(validatedSessionId)
                && !getNodeSessionBinding(validatedSessionId, req.user?.id)) {
                return res.status(404).json({ error: 'not_found' });
            }

            // Resolve workspaceId for the new session. Priority:
            //   1. Client-supplied workspaceId — the frontend always knows the owning
            //      project at createChat time, and the graph sync runs every 2s, so
            //      a fresh node + parent often haven't been flushed to SQLite yet.
            //      Trusting the client here avoids a cold-start race that left
            //      slot.workspaceId = null and broke list_threads/search_messages/
            //      read_node for the entire session.
            //   2. Parent node's workspace — covers older clients that don't send it.
            //   3. Supplied nodeId's workspace — last-resort fallback for replays.
            let workspaceId: string | null = null;
            const bodyWorkspaceId: unknown = req.body?.workspaceId;
            if (typeof bodyWorkspaceId === "string" && bodyWorkspaceId.length > 0) {
                if (bodyWorkspaceId.length > 128) {
                    return res.status(400).json({ error: "workspaceId must be ≤128 chars" });
                }
                workspaceId = bodyWorkspaceId;
            }
            if (!workspaceId && parentChatId) {
                workspaceId = getNode(parentChatId)?.workspace_id ?? null;
            }
            if (!workspaceId && validatedSessionId) {
                workspaceId = getNode(validatedSessionId)?.workspace_id ?? null;
            }

            // Keep legacy callers on the same locked, durable resume path as
            // the composer, which checks the rest of the body. A repeated
            // create must not replace native history.
            req.body = { ...req.body, workspaceId };
            (req.params as Record<string, string>).nodeId = validatedSessionId;
            return ensureNodeSession(req as express.Request<{ nodeId: string }>, res);
        } catch (err) {
            console.error("Failed to create chat:", err);
            sendAgentRouteError(res, err);
        }
    });

    router.post("/chats/:chatId/load", requireChatOwner, async (req, res) => {
        const { chatId } = req.params;
        if (refuseCheckinNode(res, chatId, req.body?.nodeId)) return;
        const isCloud = process.env.MICHI_CLOUD === "1";
        // Cloud derives cwd from the node's own workspace below; body.cwd is ignored.
        const bodyCwd: unknown = req.body?.cwd;
        const model: unknown = req.body?.model;
        const nodeId: unknown = req.body?.nodeId;
        const bodyRuntimeId: unknown = req.body?.runtimeId;
        if (!isCloud) {
            const invalid = workspaceCwdError(bodyCwd);
            if (invalid) return res.status(400).json(invalid);
        }
        if (model !== undefined && typeof model !== "string") {
            return res.status(400).json({ error: "model must be a string" });
        }
        if (nodeId !== undefined && (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 128)) {
            return res.status(400).json({ error: "nodeId must be a non-empty string <=128 chars" });
        }
        if (bodyRuntimeId !== undefined && (typeof bodyRuntimeId !== "string" || bodyRuntimeId.length === 0)) {
            return res.status(400).json({ error: "runtimeId must be a non-empty string" });
        }
        const resolvedNodeId = typeof nodeId === "string"
            ? nodeId
            : resolvePublicNodeId(chatId, req.user?.id ?? null) ?? chatId;
        if (refuseCheckinNode(res, resolvedNodeId)) return;
        if (process.env.MICHI_CLOUD === '1'
            && getNodeSessionBinding(chatId, req.user?.id)?.nodeId !== resolvedNodeId) {
            return res.status(404).json({ error: 'not_found' });
        }
        const releaseRestore = await acquireSessionRestoreLock(resolvedNodeId);
        try {
            const nodeRow = getNode(resolvedNodeId);
            const chatRow = getNode(chatId);
            const row = nodeRow ?? chatRow;
            if (row?.maintenance_job_id) {
                return res.status(409).json({ error: 'Scheduled maintenance nodes cannot be loaded through ordinary session recovery', code: 'MAINTENANCE_PROFILE_LOCKED' });
            }
            // Cloud: the sandbox cwd and workspace come from the owned node
            // (resolvedNodeId passed the binding check above), never the body.
            let cwd: string;
            let cloudWorkspaceId: string | null = null;
            if (isCloud) {
                const cloudUserId = req.user!.id;
                cloudWorkspaceId = nodeRow?.workspace_id ?? null;
                if (!cloudWorkspaceId) {
                    return res.status(404).json({ error: "workspace not found" });
                }
                const owned = ownedSandboxCwd(cloudUserId, cloudWorkspaceId);
                if ("error" in owned) return res.status(owned.status).json({ error: owned.error });
                cwd = owned.cwd;
            } else {
                // A work conversation with its own worktree reopens there (D18, Q26).
                cwd = workConversationCwd(resolvedNodeId) ?? bodyCwd as string;
            }
            const primaryAgent = row?.workspace_id ? await chatManager.resolvePrimaryAgentBinding({
                ownerUserId: req.user?.id ?? LOCAL_AGENT_OWNER_ID,
                workspaceId: row.workspace_id,
                nodeId: resolvedNodeId,
            }) : null;
            // The assistant runs only on its own settings, as ensure-session
            // pins them: a reload cannot move it to another runtime or model.
            const pinned = isAssistantNode(resolvedNodeId) ? primaryAgent?.effectiveDefinition.runtimeProfile : undefined;
            const runtimeId =
                pinned?.runtimeId ??
                (bodyRuntimeId as string | undefined) ??
                row?.runtime_id ??
                inferRuntimeId(row, resolvedNodeId) ??
                getAgentConfig(process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined).runtime;
            const runtime = getRuntime(runtimeId);
            if (!runtime?.loadSession) {
                return res.status(404).json({ error: `Runtime ${runtimeId} cannot load sessions` });
            }
            const userId = process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined;
            // The node's native session belongs to another runtime (or Kiro engine), which
            // cannot load it: like a send, continue on a new session that carries the history.
            const boundRuntimeId = row && (row.acp_session_id || row.external_session_id)
                ? row.runtime_id ?? inferRuntimeId(row, resolvedNodeId) ?? null
                : null;
            const runtimeChanged = !!boundRuntimeId && (boundRuntimeId !== runtimeId
                || (runtimeId === 'kiro' && (row?.runtime_engine ?? 'v2') !== (runtime.nativeEngine ?? 'v2')));
            // The old runtime's model, provider and reasoning do not carry over; the new one's defaults apply.
            const switchedTo = runtimeChanged && !pinned
                ? buildTargetResumeSignature({ ...getAgentConfig(userId), runtime: runtimeId }, runtime, typeof model === 'string' ? model : undefined, userId)
                : null;

            // Resolve workspaceId for the reloaded session.
            //   Cloud: always the owned node's workspace (resolvedNodeId is
            //      the node id even when chatId is an ACP sid); body ignored.
            //   Desktop:
            //   1. Client-supplied — required for Kiro because chatId is an
            //      ACP-minted sid, not a node id, so the getNode() fallback
            //      below cannot find it. Without this, list_threads /
            //      search_messages / read_node return NO_WORKSPACE every time
            //      a Kiro session is reloaded after the backend (or its
            //      in-memory session map) has been recycled.
            //   2. getNode(chatId) — works for Pi where chatId === nodeId.
            //      Kept as fallback for clients that don't send workspaceId.
            let workspaceId: string | null = cloudWorkspaceId;
            if (!isCloud) {
                const bodyWorkspaceId: unknown = req.body?.workspaceId;
                if (typeof bodyWorkspaceId === "string" && bodyWorkspaceId.length > 0 && bodyWorkspaceId.length <= 128) {
                    workspaceId = bodyWorkspaceId;
                }
                if (!workspaceId) {
                    workspaceId = row?.workspace_id ?? null;
                }
            }
            const live = sessionRegistry.getSessionForOwner(resolvedNodeId, chatOwner(resolvedNodeId), req.user?.id ?? null);
            const requestedModel = pinned ? pinned.modelId ?? undefined
                : typeof model === 'string' ? model : switchedTo ? switchedTo.modelId ?? undefined : row?.model_id;
            const canReuse = live?.runtimeId === runtimeId
                && live.nativeEngine === runtime.nativeEngine
                && (!requestedModel || live.currentModelId === requestedModel)
                && (live.nativeSessionId ?? live.id) === nativeResumeIdFor(runtime, row)
                && (live.runtimeProfileHash ?? null) === (primaryAgent?.profileHash ?? null);
            if (!canReuse && turnBusy(resolvedNodeId)) {
                throw new TurnBusyError('Cannot reload an active turn');
            }
            if (live && !canReuse) await retireLiveSession(live);
            const loadOptions = {
                sessionId: resolvedNodeId,
                nodeId: resolvedNodeId,
                cwd: normalizeWorkspaceCwd(cwd),
                model: requestedModel,
                provider: pinned ? pinned.providerId : switchedTo ? switchedTo.providerId : row?.provider_id,
                reasoning: normalizeReasoning(pinned ? pinned.reasoning : switchedTo ? switchedTo.reasoning : row?.reasoning),
                workspaceId,
                ownerUserId: req.user?.id ?? null,
                ...primaryAgentSessionOptions(primaryAgent),
            };
            const nativeResumeEnabled = isNativeResumeEnabled(runtimeId, req.user?.id);
            const compatible = runtimeChanged || (runtime.capabilities.nativeResume && !nativeResumeEnabled);
            // Posted check-ins replay as one-line facts (DESIGN-v2 §2.8 T2).
            const transcript = compatible ? replayTranscript(resolvedNodeId, req.user?.id) : [];
            // Pi replays the history as its own turns; other runtimes read it as one prior-context block.
            // Multi-model branches: a fresh one inherits nothing, a fork its cut of the caller.
            const forkBoundary = compatible && row?.multi_model_run_id && row.fresh_context !== 1
                ? multiModelForkBoundary(resolvedNodeId, row.parent_node_id ?? undefined, isCloud ? req.user?.id : undefined)
                : null;
            const session = canReuse ? live : compatible
                ? await runtime.newSession({
                    ...loadOptions,
                    ...(row?.fresh_context === 1 ? {}
                        : row?.multi_model_run_id ? (forkBoundary ? { branchContext: toBranchContext(forkBoundary) } : {})
                        : { parentChatId: row?.parent_node_id ?? undefined }),
                    ...(runtime.id === 'pi' ? { replayHistory: transcript } : {
                        mergeContexts: [buildCompatibleResumeContext(transcript, { nodeId: resolvedNodeId, title: row?.title ?? null })]
                            .filter((value): value is string => !!value),
                    }),
                })
                : runtime.capabilities.nativeResume
                ? await loadNativeSession(runtime, loadOptions, nativeResumeIdFor(runtime, row))
                : await runtime.loadSession(loadOptions);
            if (!session) return res.status(404).json({ error: 'Native session is unavailable' });
            sessionRegistry.registerSession(session, req.user?.id ?? null);
            try {
                await persistResumeBinding(resolvedNodeId, session, {
                    runtimeId, modelId: session.currentModelId ?? requestedModel ?? null,
                    providerId: loadOptions.provider ?? null, reasoning: loadOptions.reasoning,
                }, null);
            } catch (error) {
                if (session !== live) await retireLiveSession(session);
                throw error;
            }
            res.json({
                ok: true,
                currentModeId: session.currentModeId ?? null,
                sessionState: session.getSessionState?.(),
                runtimeId: session.runtimeId,
            });
        } catch (err) {
            console.warn(`session/load failed for ${chatId}:`, err);
            sendAgentRouteError(res, err);
        } finally {
            releaseRestore();
        }
    });

    async function ensureNodeSession(req: express.Request<{ nodeId: string }>, res: express.Response) {
        const { nodeId } = req.params;
        // Before the node lookup and the graph prerequisite: no client makes, binds or reopens a check-in node.
        if (refuseCheckinNode(res, nodeId, req.body?.chatId, req.body?.parentChatId)) return;
        const routeStart = Date.now();
        startupMark("ensure_session_route_start", { nodeId });
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (body.crewMemoryMode !== undefined && !isCrewMemoryMode(body.crewMemoryMode)) {
            return res.status(400).json({ error: "Invalid Crew memory mode" });
        }
        if (body.permissionMode !== undefined && !isChatPermissionMode(body.permissionMode)) {
            return res.status(400).json({ error: 'permissionMode must be ask, trust, or yolo' });
        }
        if (!nodeId || nodeId.length > 128) {
            return res.status(400).json({ error: "nodeId must be a non-empty string <=128 chars" });
        }
        const parsed = parseEnsureSessionBody(body);
        if ("invalid" in parsed) return res.status(400).json(parsed.invalid);
        const { model: modelRaw, mergeContexts, extraContexts, contextManifest, artifactCount, enableFollowUps } = parsed;
        const missing = await ensureRequestedGraphNode(req, nodeId, body.graphPrerequisite, { workspaceId: body.workspaceId });
        if (missing) return res.status(missing.status).json(missing.body);

        const durableNode = getNode(nodeId);
        if (!durableNode) return res.status(409).json({ code: 'NODE_NOT_PERSISTED', error: 'durable node prerequisite required' });
        if (durableNode.maintenance_job_id) {
            return res.status(409).json({ error: 'Scheduled maintenance nodes can only be opened by their managed job', code: 'MAINTENANCE_PROFILE_LOCKED' });
        }
        if (body.workspaceId && body.workspaceId !== durableNode.workspace_id) {
            return res.status(409).json({ code: 'IDENTITY_MISMATCH', error: 'node and workspace do not match' });
        }
        // A temporary chat is chosen before its first turn (a synced first
        // message does not count); every later send carries the flag again
        // and changes nothing (startTemporaryConversation).
        const memoryOwner = parsed.temporary ? requestAgentOwnerOrNull(req.user?.id) : null;
        if (memoryOwner) startTemporaryConversation({ ownerUserId: memoryOwner }, nodeId);
        // A temporary chat's Crew sessions keep nothing either, whatever the client asked for.
        const crewMemoryMode = crewMemoryModeFor(nodeId, isCrewMemoryMode(body.crewMemoryMode) ? body.crewMemoryMode : undefined);
        writeNodePermissionMode(nodeId, isChatPermissionMode(body.permissionMode) ? body.permissionMode : 'ask', req.user?.id, true, body.approveForMe === true);

        // In cloud mode, derive cwd server-side from the node's workspace ownership.
        // Desktop trusts client-supplied cwd.
        let cwd = process.cwd();
        if (process.env.MICHI_CLOUD === "1") {
            const userId = req.user!.id;
            // Prefer client-supplied workspaceId; fall back to the node's workspace.
            const wsIdForCwd: string | null =
                (typeof body.workspaceId === "string" && body.workspaceId.length > 0
                    ? body.workspaceId
                    : null) ??
                getNodeWorkspaceId(nodeId);
            if (wsIdForCwd) {
                try {
                    ensureCloudWorkspaceRow(userId, wsIdForCwd);
                } catch (err) {
                    return res.status(400).json({ error: (err as Error).message });
                }
                const owned = ownedSandboxCwd(userId, wsIdForCwd);
                if ("error" in owned) return res.status(owned.status).json({ error: owned.error });
                cwd = owned.cwd;
            }
        } else if (parsed.cwd !== undefined) {
            cwd = parsed.cwd;
        }
        // A work conversation with its own worktree opens there, whatever folder the client sends (D18, Q26).
        if (process.env.MICHI_CLOUD !== "1") cwd = workConversationCwd(nodeId) ?? cwd;
        cwd = normalizeWorkspaceCwd(cwd);

        const existingChatId = normalizeSignaturePart(body.chatId);
        const parentChatId = normalizeSignaturePart(body.parentChatId) ?? undefined;
        const workspaceId = normalizeSignaturePart(body.workspaceId) ?? getNodeWorkspaceId(nodeId);
        const requestedDefinitionId = normalizeSignaturePart(parsed.agentDefinitionId);
        const desiredModeId = normalizeSignaturePart(parsed.modeId);

        const releaseRestore = await acquireSessionRestoreLock(nodeId);
        try {
            const michiUserId: string | undefined = process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined;
            const cfg = getAgentConfig(michiUserId);
            // Resolved only when this call actually creates a session: a live
            // or exact resume must not fail because the original anchor message
            // was trimmed after the branch was created.
            let branchBoundary: BranchBoundary | undefined;
            let branchContext: ReturnType<typeof toBranchContext> | undefined;
            const row = getNode(nodeId);
            // Multi-model branches (nodes.multi_model_run_id): a fresh one
            // inherits nothing from its caller, and a fork keeps its cut of the
            // caller rather than the caller's current tail (rebuildInheritance).
            // Both ignore the client's parentChatId.
            const freshContext = row?.fresh_context === 1;
            let effectiveParentChatId = freshContext ? undefined : parentChatId;
            const boundSignature = row?.acp_session_id || row?.external_session_id
                ? normalizeResumeSignature({
                    runtimeId: row.runtime_id ?? inferRuntimeId(row, nodeId),
                    runtimeEngine: row.runtime_engine,
                    providerId: row.provider_id,
                    modelId: row.model_id,
                    reasoning: row.reasoning,
                })
                : null;
            const primaryAgent = await chatManager.resolvePrimaryAgentBinding({
                ownerUserId: req.user?.id ?? LOCAL_AGENT_OWNER_ID,
                workspaceId,
                nodeId,
                definitionId: requestedDefinitionId,
            });
            // The first message's artifact manifest, for a session this call
            // creates. artifactCount goes only where it was sent, so a legacy
            // client's list renders as before. A session that cannot list or
            // search artifacts (a primary Agent: its allow-list leaves them
            // out) is not told to: it gets the workspace's list itself,
            // pinned first, as a client without artifactCount sends it.
            let firstTurnArtifacts: { contextManifest?: ExtraContext[]; artifactCount?: number } | undefined;
            const artifactManifestOptions = () => firstTurnArtifacts ??= artifactCount === undefined
                ? { contextManifest }
                : canLookUpArtifacts(artifactToolsForProfile(primaryAgentSessionOptions(primaryAgent).toolProfile))
                    ? { contextManifest, artifactCount }
                    : { contextManifest: workspaceId
                        ? workspaceArtifactManifest(workspaceId, michiUserId, contextManifest ?? [], CONTEXT_MANIFEST_MAX)
                        : contextManifest };
            const primaryProfile = primaryAgent?.effectiveDefinition.runtimeProfile;
            const requestedModeId = normalizeSignaturePart(primaryProfile?.modeId) ?? desiredModeId;
            const runtimeId = primaryProfile?.runtimeId ?? normalizeSignaturePart(body.runtimeId)
                ?? boundSignature?.runtimeId ?? cfg.runtime;
            const runtime = getRuntime(runtimeId);
            if (!runtime) {
                return res.status(500).json({ error: `Unknown agent runtime: ${runtimeId}` });
            }
            const persistedBinding = nativeResumeIdFor(runtime, row);
            const liveSession = sessionRegistry.getSessionForOwner(nodeId, chatOwner(nodeId), req.user?.id ?? null)
                ?? (existingChatId ? sessionRegistry.getSessionForOwner(existingChatId, chatOwner(nodeId), req.user?.id ?? null) : undefined);
            const targetSignature: ResumeSignature = primaryProfile
                ? {
                    runtimeId,
                    providerId: normalizeSignaturePart(primaryProfile.providerId),
                    modelId: normalizeSignaturePart(primaryProfile.modelId),
                    reasoning: normalizeReasoning(primaryProfile.reasoning),
                }
                : boundSignature?.runtimeId === runtimeId
                ? { ...boundSignature }
                : buildTargetResumeSignature(
                    { ...cfg, runtime: runtimeId },
                    runtime,
                    normalizeSignaturePart(body.modelId) ?? (typeof modelRaw === "string" ? modelRaw : undefined),
                    michiUserId,
                );
            if (runtime.nativeEngine) targetSignature.runtimeEngine = runtime.nativeEngine;
            if (!primaryProfile) {
                // An omitted selection means "continue this conversation", not
                // "replace it with whichever global defaults were last saved".
                const modelOverride = normalizeSignaturePart(body.modelId)
                    ?? normalizeSignaturePart(modelRaw);
                if (modelOverride) targetSignature.modelId = modelOverride;
                const previousProvider = targetSignature.providerId;
                targetSignature.providerId = runtime.capabilities.providerModels
                    ? normalizeSignaturePart(body.providerId) ?? targetSignature.providerId ?? resolveProvider(runtimeId, michiUserId)
                    : null;
                if (runtime.capabilities.providerModels && body.providerId !== undefined
                    && body.providerId !== previousProvider
                    && body.modelId === undefined && modelRaw === undefined) {
                    targetSignature.modelId = null;
                }
                const requestedReasoning = body.reasoning !== undefined
                    ? normalizeReasoning(body.reasoning) : targetSignature.reasoning;
                targetSignature.reasoning = requestedReasoning;
                // The live session already validated these settings when it was
                // bound. Ordinary follow-ups must not wait on catalog discovery
                // (which can start another CLI session) before sending a prompt.
                const settingsAlreadyValidated = !!boundSignature && !!liveSession && !!persistedBinding
                    && liveSession.runtimeId === runtimeId
                    && (liveSession.nativeSessionId ?? liveSession.id) === persistedBinding
                    && (liveSession.runtimeProfileHash ?? null) === (primaryAgent?.profileHash ?? null)
                    && (liveSession.currentModelId ?? null) === targetSignature.modelId
                    && signaturesEqual(boundSignature, targetSignature);
                if (!settingsAlreadyValidated) {
                    const effort = await getModelReasoningOptions(runtime, targetSignature.modelId, targetSignature.providerId, requestedReasoning);
                    targetSignature.modelId = effort.modelId ?? targetSignature.modelId;
                    targetSignature.reasoning = effort.value ?? null;
                }
            }
            const legacyBinding = existingChatId
                ? getNodeSessionBinding(existingChatId, michiUserId)
                : null;
            const hasResumeBinding = !!persistedBinding || legacyBinding?.nodeId === nodeId;
            const existingSignature = boundSignature ?? readExistingSignature(row, body, nodeId);
            const nativeResumeAvailable =
                runtime.capabilities.nativeResume &&
                typeof runtime.loadSession === "function" &&
                hasResumeBinding;
            const decision = chooseResumeStrategy({
                existingChatId: hasResumeBinding ? nodeId : null,
                liveSessionMatches: !!liveSession && liveSession.runtimeId === targetSignature.runtimeId
                    && (!persistedBinding || (liveSession.nativeSessionId ?? liveSession.id) === persistedBinding)
                    && (liveSession.runtimeProfileHash ?? null) === (primaryAgent?.profileHash ?? null)
                    && (!existingSignature || existingSignature.reasoning === targetSignature.reasoning)
                    && (!targetSignature.modelId || liveSession.currentModelId === targetSignature.modelId || !!liveSession.setModel),
                nativeResumeAvailable,
                nativeResumeEnabled: isNativeResumeEnabled(runtimeId, michiUserId),
                nativeResumeSettings: runtime.capabilities.nativeResumeSettings,
                existingSignature,
                targetSignature,
            });

            let session: AgentSession | undefined;
            let liveSessionRetired = false;
            let resumeStrategy: ResumeStrategy = decision.strategy;
            let resumeReason = decision.reason;

            if (decision.strategy === "live" && liveSession) {
                session = liveSession;
                if (targetSignature.modelId && session.currentModelId !== targetSignature.modelId && session.setModel) {
                    if (turnBusy(nodeId)) throw new TurnBusyError('Cannot change settings during an active turn');
                    await session.setModel(targetSignature.modelId);
                }
            } else if (decision.strategy === "exact" && runtime.loadSession) {
                if (turnBusy(nodeId)) throw new TurnBusyError('Cannot reload an active turn');
                if (liveSession) await retireLiveSession(liveSession);
                liveSessionRetired = true;
                session = await loadNativeSession(runtime, {
                    sessionId: nodeId,
                    nodeId,
                    cwd,
                    model: targetSignature.modelId,
                    provider: targetSignature.providerId,
                    reasoning: targetSignature.reasoning,
                    workspaceId,
                    ownerUserId: req.user?.id ?? null,
                    ...primaryAgentSessionOptions(primaryAgent),
                }, persistedBinding) ?? undefined;
                if (session) sessionRegistry.registerSession(session, req.user?.id ?? null);
                else {
                    resumeStrategy = "compatible";
                    resumeReason = "native_session_unavailable";
                }
            }

            // History is only needed for a fresh/fallback reconstruction. Live
            // and exact continuations already retain the runtime's conversation.
            const transcript = session ? [] : readTranscriptMessages(body.priorMessages, nodeId, michiUserId);
            // A host command can bind a blank child before its first prompt.
            // If that native session later disappears, rebuild from the saved
            // branch cut rather than inheriting the parent's current tail.
            if (!session && transcript.length === 0) {
                try {
                    branchBoundary = resolveBranchBoundary({
                        childNodeId: nodeId,
                        parentNodeId: parentChatId,
                        userId: michiUserId,
                    });
                } catch (error) {
                    if (error instanceof BranchBoundaryError) {
                        return res.status(409).json({ code: error.code, error: error.message });
                    }
                    throw error;
                }
                branchContext = branchBoundary ? toBranchContext(branchBoundary) : undefined;
                effectiveParentChatId = freshContext ? undefined : parentChatId ?? branchBoundary?.parentNodeId;
                // A fork replaces the node's session like the fallback below:
                // wait for the turn to release it, and never orphan a live one.
                // A branch-boundary conflict above is reported first: it does
                // not clear when the turn ends, so retrying it cannot help.
                if (turnBusy(nodeId)) throw new TurnBusyError('Cannot replace an active turn');
                if (liveSession && !liveSessionRetired) {
                    await retireLiveSession(liveSession);
                    liveSessionRetired = true;
                }
                session = await tryForkChatSession(runtime, {
                    cwd, parentChatId: effectiveParentChatId, branchContext,
                    mergeContexts, extraContexts, ...artifactManifestOptions(), enableFollowUps,
                    model: targetSignature.modelId, provider: targetSignature.providerId,
                    reasoning: targetSignature.reasoning, sessionId: nodeId, workspaceId,
                    ownerUserId: req.user?.id ?? null, ...primaryAgentSessionOptions(primaryAgent),
                }) ?? undefined;
                if (session) {
                    sessionRegistry.registerSession(session, req.user?.id ?? null);
                    resumeReason = 'native_fork';
                }
            }

            if (!session) {
                if (turnBusy(nodeId)) throw new TurnBusyError('Cannot replace an active turn');
                if (liveSession && !liveSessionRetired) {
                    await retireLiveSession(liveSession);
                }
                const resumeContext = buildCompatibleResumeContext(transcript, {
                    nodeId,
                    title: row?.title ?? null,
                });

                // When the parent session is dead in memory (or parentChatId
                // was nulled during hydration), the parent's stored transcript
                // is a merge context so the child still gets ancestor history.
                const inherited = rebuildInheritance({
                    nodeId, row, parentChatId: effectiveParentChatId, hasBranchContext: !!branchContext, userId: michiUserId,
                });
                effectiveParentChatId = inherited.parentChatId;

                const replaysMessages = descriptorOf(runtime).topology.historyReplay === 'messages';
                const seededMergeContexts = [
                    ...(resumeContext && !replaysMessages ? [resumeContext] : []),
                    ...(inherited.context ? [inherited.context] : []),
                    ...mergeContexts,
                ];
                session = await runtime.newSession({
                    ...(crewMemoryMode ? { crewMemoryMode } : {}),
                    cwd,
                    parentChatId: effectiveParentChatId,
                    ...(branchContext === undefined ? {} : { branchContext }),
                    ...(replaysMessages ? { replayHistory: transcript } : {}),
                    mergeContexts: seededMergeContexts.length > 0 ? seededMergeContexts : undefined,
                    extraContexts,
                    ...artifactManifestOptions(),
                    enableFollowUps,
                    model: targetSignature.modelId,
                    provider: targetSignature.providerId,
                    reasoning: targetSignature.reasoning,
                    sessionId: nodeId,
                    workspaceId,
                    ownerUserId: req.user?.id ?? null,
                    ...primaryAgentSessionOptions(primaryAgent),
                });
                sessionRegistry.registerSession(session, req.user?.id ?? null);
                if (branchContext) resumeReason = 'text_fallback';

                // Apply the caller's explicit agent pick before the first
                // prompt. This block only runs for a newly constructed runtime
                // session; live/exact resumes returned above are untouched.
                // A bad/unsupported mode must not fail session creation.
                if (
                    requestedModeId &&
                    session.setMode &&
                    session.currentModeId !== requestedModeId
                ) {
                    try {
                        await session.setMode(requestedModeId);
                    } catch (err) {
                        console.warn(
                            `Failed to apply desired mode ${requestedModeId} on ${session.id}:`,
                            err,
                        );
                    }
                }
            }

            try {
                await persistResumeBinding(nodeId, session, targetSignature, null, session === liveSession);
            } catch (error) {
                // Do not let a subsequent ensure reuse an uncommitted replacement.
                if (session !== liveSession) await retireLiveSession(session);
                throw error;
            }
            const forkKind = branchBoundary
                && (resumeReason === 'native_fork' || resumeReason === 'text_fallback')
                ? resumeReason === 'native_fork' ? 'native' as const : 'text' as const
                : undefined;
            if (branchBoundary && forkKind) {
                try {
                    setEdgeForkProvenance(branchBoundary.edgeId, {
                        forkKind,
                        ...(branchBoundary.boundaryMessageId === undefined
                            ? {}
                            : { forkBoundaryMessageId: branchBoundary.boundaryMessageId }),
                    });
                } catch (error) {
                    // Provenance is diagnostic; never fail a session that is already live.
                    log.warn('chat', 'failed to persist branch provenance', {
                        nodeId,
                        edgeId: branchBoundary.edgeId,
                        error: (error as Error).message,
                    });
                }
            }
            // Pane-level provider/model picks never touch /agent/options, so
            // remember what this conversation actually ran with. A new pane
            // switched to this runtime then lands on the same model instead
            // of the built-in fallback. Provider runtimes record the provider
            // too; the others record only the model. Primary-agent profiles
            // are fixed by their definition and must not rewrite the user's
            // own memory.
            const lastUsedProvider = runtime.capabilities.providerModels ? targetSignature.providerId : null;
            const lastUsedUpdated = !primaryProfile
                && runtime.capabilities.models
                && (!runtime.capabilities.providerModels || !!lastUsedProvider)
                && recordLastUsedProviderModel(runtimeId, lastUsedProvider, targetSignature.modelId, michiUserId);
            log.info('chat', 'runtime session resolved', {
                nodeId,
                runtimeId: session.runtimeId,
                nativeSessionId: session.nativeSessionId ?? session.id,
                previousNativeSessionId: persistedBinding,
                resumeStrategy,
                resumeReason,
                providerId: targetSignature.providerId,
                modelId: targetSignature.modelId,
            });
            startupMark("ensure_session_route_done", {
                nodeId,
                chatId: session.id,
                resumeStrategy,
                durMs: Date.now() - routeStart,
            });
            return res.json({
                chatId: session.id,
                currentModeId: session.currentModeId ?? null,
                sessionState: session.getSessionState?.(),
                runtimeId: targetSignature.runtimeId,
                providerId: targetSignature.providerId,
                modelId: targetSignature.modelId,
                reasoning: targetSignature.reasoning,
                lastUsedUpdated,
                resumeFingerprint: null,
                resumeStrategy,
                resumeReason,
                ...(forkKind === undefined ? {} : { forkKind }),
            });
        } catch (err) {
            console.error("Failed to ensure session:", err);
            startupMark("ensure_session_route_failed", {
                nodeId,
                durMs: Date.now() - routeStart,
                error: (err as Error).message,
            });
            return sendAgentRouteError(res, err);
        } finally {
            releaseRestore();
        }
    }

    router.post("/nodes/:nodeId/ensure-session", requireNodeOwner, ensureNodeSession);

    router.post("/chats/:chatId/message", requireChatOwner, async (req, res) => {
        const requestedIdentifier = req.params.chatId;
        if (refuseCheckinNode(res, requestedIdentifier, req.body?.nodeId)) return;
        const text: string = req.body?.text || "";
        const displayText: string = typeof req.body?.displayText === 'string'
            ? req.body.displayText
            : text;
        const enableKiroSidecarTitleRaw: unknown = req.body?.enableKiroSidecarTitle;
        if (enableKiroSidecarTitleRaw !== undefined && typeof enableKiroSidecarTitleRaw !== 'boolean') {
            return res.status(400).json({ error: 'enableKiroSidecarTitle must be a boolean' });
        }
        const enableKiroSidecarTitle = enableKiroSidecarTitleRaw === true;
        // What the route decides about the message (companionTurn, the skill it ran) is the backend's to write.
        let userMetadata: Record<string, unknown> | undefined = clientUserMetadata(req.body?.userMetadata);
        const skillRequested = req.body?.skill !== undefined;
        const legacyNodeId: string | undefined = req.body?.nodeId;
        let turnId: string | undefined = typeof req.body?.turnId === 'string' && req.body.turnId.length > 0
            ? req.body.turnId
            : undefined;
        const routeStart = Date.now();
        const session = getSessionByIdentifier(requestedIdentifier, req.user?.id ?? null);
        const nodeId = session?.id ?? null;
        startupMark("stream_route_start", { chatId: requestedIdentifier, nodeId, textLen: text.length });
        // A skill may run with no text after its name.
        if (!text && !skillRequested) {
            return res.status(400).json({ error: "text is required" });
        }
        if (!session || !nodeId) {
            return res.status(404).json({ error: `unknown chat: ${requestedIdentifier}` });
        }
        if (refuseCheckinNode(res, nodeId)) return;
        let skill: SkillTurnInvocation | undefined;
        if (skillRequested) {
            try {
                const request = parseSkillInvocationRequest(req.body.skill);
                if (isAssistantNode(nodeId) || req.body?.metaAgentContext !== undefined) {
                    throw new SkillInvocationError('skill_not_found', `Couldn’t run /${request.name}: the Michi assistant runs no skills.`);
                }
                const runtime = getRuntime(session.runtimeId);
                if (!runtime) throw new SkillInvocationError('skill_not_found', `Couldn’t run /${request.name}: this chat’s runtime isn’t registered.`);
                const workspaceId = getNode(nodeId)?.workspace_id;
                const cwd = workspaceId ? workspaceSkillCwd(workspaceId, req.user?.id ?? null) : null;
                skill = await resolveSkillInvocation({ request, runtime, cwd, ownerUserId: req.user?.id ?? null });
            } catch (err) {
                if (!(err instanceof SkillInvocationError)) throw err;
                const status = err.code === 'invalid_skill' ? 400 : err.code === 'runtime_unavailable' ? 503 : 404;
                return res.status(status).json({ error: err.message, code: err.code });
            }
            userMetadata = { ...(userMetadata ?? {}), skill: skillMessageMetadata(skill, session.runtimeId) };
        }
        // A message to the agent (V, DESIGN-v2 §1.3) carries the area it was written in: the
        // Spaces fields (any area's block target goes as them) or the Scheduled one, never both.
        const assistantMain = isAssistantNode(nodeId) && assistantPurposeOf(nodeId) === 'main';
        let wireText = text;
        let turnContext: MetaAgentChatTurnContext | undefined;
        let area: AssistantTurnArea = null;
        if (req.body?.metaAgentContext !== undefined) {
            if (!assistantMain) {
                return res.status(400).json({ error: 'metaAgentContext is only accepted by the Michi assistant', code: 'invalid_meta_agent_context' });
            }
            try {
                turnContext = parseMetaAgentChatTurnContext(req.body.metaAgentContext);
            } catch (err) {
                if (!(err instanceof MetaAgentChatContextError)) throw err;
                return res.status(400).json({ error: err.message, code: 'invalid_meta_agent_context' });
            }
            if (hasSpacesTurnContext(turnContext) && turnContext.schedule !== undefined) {
                return res.status(400).json({ error: 'Send the Spaces context or the Scheduled context, not both', code: 'invalid_meta_agent_context' });
            }
            area = turnContext.schedule !== undefined
                ? { kind: 'schedule', workspace: scheduleDefaultWorkspace(turnContext.schedule.workspaceId ?? null, req.user?.id ?? null) }
                : hasSpacesTurnContext(turnContext) ? { kind: 'spaces', context: turnContext } : null;
        }
        if (getNode(nodeId)?.maintenance_job_id) {
            return res.status(409).json({ error: 'Scheduled maintenance nodes cannot accept ordinary messages', code: 'MAINTENANCE_PROFILE_LOCKED' });
        }
        if (legacyNodeId && legacyNodeId !== nodeId) {
            return res.status(409).json({
                error: "chat identifier and nodeId resolve to different nodes",
                code: "IDENTITY_MISMATCH",
            });
        }
        // A turn ID with a receipt already began. Checked before the busy
        // answers below: 409 turn_active must mean this turn never began.
        if (turnAlreadyBegan(turnId)) return res.status(409).json(TURN_ALREADY_BEGAN);
        if (chatHub.holdsSession(nodeId)) {
            // Only an explicit Stop may wait for cancellation cleanup. A new
            // message from another window must never interrupt the active turn.
            if (chatHub.getSnapshot(nodeId)?.cancelRequestedAt != null) {
                try { await chatHub.cancelAndWait(nodeId); } catch { /* best-effort */ }
            }
            if (chatHub.holdsSession(nodeId)) {
                return res.status(409).json({
                    error: "Waiting for the previous response to finish.",
                    code: TURN_ERROR_CODES.active,
                });
            }
        }
        // A queued self-turn (e.g. a cross-thread message waiting to start)
        // means this turn provably never began; let the client wait silently.
        if (chatHub.hasPendingSelfTurn(nodeId)) {
            return res.status(409).json({
                error: "Waiting for the previous response to finish.",
                code: TURN_ERROR_CODES.active,
            });
        }
        // Every message to the agent carries [COMPANION CONTEXT] (§3.5). Its rules unreadable, the
        // message still goes, without it, and the agent's action tools refuse this turn (§1.3).
        // A message that starts with check-in or collector material runs its turn in Ask (§2.8 T4):
        // the untrusted source is recorded before the turn starts, where the runtime reads its mode.
        // So does every later message on the same live session (w2-fix D1): what an earlier turn
        // took in is still in it, so the turn records it too, and its line says why it asks.
        let companionContext: CompanionTurnContext | null = null;
        if (assistantMain) {
            turnId ??= randomUUID();
            const composed = withAssistantTurnContext(text, { area, nodeId, session, now: Date.now() });
            companionContext = composed.companion;
            wireText = composed.text;
            const startTaint = companionStartTaint({ context: turnContext, ownerUserId: req.user?.id ?? LOCAL_AGENT_OWNER_ID });
            const carriedTaint = startTaint === 'checkin' ? null : carriedCompanionTaintOf(nodeId);
            if (startTaint) recordCompanionTaint({ nodeId, turnId }, 'companion_context', startTaint);
            if (carriedTaint) recordCompanionTaint({ nodeId, turnId }, 'companion_earlier_turn', carriedTaint);
            const companionTurn: CompanionTurnMetadata = {
                ...(companionContext.rulesUnavailable ? { rulesUnavailable: true as const } : {}),
                ...(startTaint ? { startTaint } : {}),
                // "Anything that would leave this machine asks first: this conversation read check-in material earlier."
                ...(carriedTaint && !startTaint ? { carriedTaint } : {}),
            };
            if (Object.keys(companionTurn).length > 0) userMetadata = { ...(userMetadata ?? {}), companionTurn };
        } else {
            // Any other chat whose live session took in check-in material earlier (w3-fix D17) asks for the
            // same reason, and its message says so too (TR cross-owner #3); the turn records it as it reads its mode.
            const carriedTaint = carriedCompanionTaintOf(nodeId);
            if (carriedTaint) userMetadata = { ...(userMetadata ?? {}), companionTurn: { carriedTaint } satisfies CompanionTurnMetadata };
        }

        const releaseRestore = await acquireSessionRestoreLock(nodeId);
        let started;
        try {
            const currentSession = getSessionByIdentifier(requestedIdentifier, req.user?.id ?? null);
            if (!currentSession || currentSession.id !== nodeId) throw new Error('Session changed before turn start; retry the message');
            // A duplicate of this request may have started it while this one waited.
            if (turnAlreadyBegan(turnId)) return res.status(409).json(TURN_ALREADY_BEGAN);
            // Another request may have started while this one waited for the
            // restore lock, or its iterator may still be releasing the runtime.
            if (chatHub.isBusy(nodeId)) {
                return res.status(409).json({
                    error: "Waiting for the previous response to finish.",
                    code: TURN_ERROR_CODES.active,
                });
            }
            started = await chatHub.startTurn({
                chatId: nodeId, nodeId, text: wireText, displayText, enableKiroSidecarTitle, userMetadata, session: currentSession,
                turnId,
                ownerUserId: req.user?.id ?? null,
                humanOrigin: true,
                ...(skill ? { skill } : {}),
            });
        } catch (err) {
            if (err instanceof TurnGuardError) {
                return res.status(err.code === 'checkin_node' ? 409 : 400).json({ error: err.message, code: err.code });
            }
            return res.status(409).json({
                error: (err as Error).message,
                code: TURN_ERROR_CODES.beginFailed,
            });
        } finally {
            releaseRestore();
        }
        // The turn began: the card results and posts its context named count as told, and its
        // standing blocks count as held once the turn completes (§3.5; delivered watches the turn).
        if (companionContext) {
            try {
                companionContext.reportCards();
                companionContext.markPostsTold();
            } catch (err) {
                log.warn('chat', 'companion context not marked told', { nodeId, error: (err as Error).message });
            }
            void companionContext.delivered(started.turnId);
        }
        const observer = beginSse(res);
        let wroteTerminal = false;
        let wroteFirstEvent = false;
        // The wire copy only: the hub and its in-process subscribers keep whole tool outputs.
        const forWire = createToolOutputStreamProjector();
        const sub: HubSubscriber = {
            send: (ev) => {
                if (observer.closed) return;
                if (!wroteFirstEvent) {
                    wroteFirstEvent = true;
                    startupMark("stream_route_first_event", { chatId: nodeId, nodeId, kind: ev.event, durMs: Date.now() - routeStart });
                }
                if (ev.event === CHAT_STREAM_EVENTS.done || ev.event === CHAT_STREAM_EVENTS.error) {
                    wroteTerminal = true;
                }
                observer.write(encodeChatStreamEvent(forWire(ev)));
            },
            close: () => {
                const terminal = finalTerminalEvent({ wroteTerminal, aborted: false });
                if (terminal) observer.write(encodeChatStreamEvent(terminal));
                if (!res.writableEnded && !res.destroyed) res.end();
            },
        };
        const subscription = chatHub.subscribeTurn(nodeId, started.turnId, sub, 0);
        if (!subscription) {
            return res.status(410).json({ error: 'turn replay unavailable', code: TURN_ERROR_CODES.replayUnavailable });
        }
        observer.addCleanup(subscription);
        try {
            await started.done;
        } finally {
            startupMark("stream_route_done", { chatId: nodeId, nodeId, durMs: Date.now() - routeStart, aborted: false });
            if (!res.writableEnded && !res.destroyed) res.end();
        }
    });

    router.post("/chats/:chatId/cancel", requireChatOwner, async (req, res) => {
        const requestedIdentifier = req.params.chatId;
        // A check-in's hidden turn is the engine's to stop (DESIGN-v2 §2.5).
        if (refuseCheckinNode(res, requestedIdentifier)) return;
        const session = getSessionByIdentifier(requestedIdentifier, req.user?.id ?? null);
        const nodeId = session?.id ?? resolvePublicNodeId(requestedIdentifier, req.user?.id ?? null) ?? requestedIdentifier;
        if (refuseCheckinNode(res, nodeId)) return;
        const turnId: string | undefined = typeof req.body?.turnId === 'string'
            ? req.body.turnId
            : undefined;
        if (!turnId?.trim()) {
            return res.status(400).json({ error: "turnId is required to stop a specific turn" });
        }
        try {
            const activeTurnMatched = chatHub.cancel(nodeId, turnId);
            // Foreground turns are cancelled through ChatHub.activeSessions.
            // Runtime self-turns are owned by ClaudeSession's idle-pump lock,
            // so cancel that live session directly.
            if (session && activeTurnMatched && !chatHub.isOwnerTurnActive(nodeId)) {
                await Promise.resolve(session.cancel());
            }
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.post("/chats/:chatId/steer", requireChatOwner, async (req, res) => {
        const requestedIdentifier = req.params.chatId;
        if (refuseCheckinNode(res, requestedIdentifier)) return;
        const session = getSessionByIdentifier(requestedIdentifier, req.user?.id ?? null);
        const nodeId = session?.id ?? resolvePublicNodeId(requestedIdentifier, req.user?.id ?? null) ?? requestedIdentifier;
        if (refuseCheckinNode(res, nodeId)) return;
        const text = typeof req.body?.text === "string" ? req.body.text : "";
        if (!text.trim()) {
            return res.status(400).json({ error: "text is required", accepted: false });
        }
        let userMetadata = clientUserMetadata(req.body?.userMetadata);
        // A steer into V's running turn that refers to check-in or collector material (the same refs
        // a message sends, §2.8 T4) taints that turn before the runtime reads the steered text.
        if (req.body?.metaAgentContext !== undefined) {
            if (!isAssistantNode(nodeId) || assistantPurposeOf(nodeId) !== 'main') {
                return res.status(400).json({ error: 'metaAgentContext is only accepted by the Michi assistant', code: 'invalid_meta_agent_context', accepted: false });
            }
            let steerContext: MetaAgentChatTurnContext;
            try {
                steerContext = parseMetaAgentChatTurnContext(req.body.metaAgentContext);
            } catch (err) {
                if (!(err instanceof MetaAgentChatContextError)) throw err;
                return res.status(400).json({ error: err.message, code: 'invalid_meta_agent_context', accepted: false });
            }
            try {
                const startTaint = companionStartTaint({ context: steerContext, ownerUserId: req.user?.id ?? LOCAL_AGENT_OWNER_ID });
                if (startTaint) {
                    // Without a running turn to taint, the steer could not reach one anyway.
                    const running = activeTurnTrust(nodeId);
                    if (!running) return res.status(409).json({ accepted: false, reason: 'invisible' });
                    recordCompanionTaint({ nodeId, turnId: running.turnId }, 'companion_context', startTaint);
                    userMetadata = { ...(userMetadata ?? {}), companionTurn: { startTaint } satisfies CompanionTurnMetadata };
                }
            } catch (err) {
                return res.status(500).json({ error: (err as Error).message, accepted: false });
            }
        }
        try {
            const result = await chatHub.steer(nodeId, text, {
                displayText: typeof req.body?.displayText === 'string' ? req.body.displayText : undefined,
                queueId: typeof req.body?.queueId === 'string' ? req.body.queueId : undefined,
                userMetadata,
            });
            res.status(result.accepted ? 200 : 409).json(result);
        } catch (err) {
            res.status(500).json({ error: (err as Error).message, accepted: false });
        }
    });

    // Compaction had no HTTP surface at all, so `chatHub.compact()` — and with
    // it Codex's native `thread/compact/start` and Kiro's ACP compact command —
    // was unreachable from the client. Uses the same account authorization as steer;
    // 409 means the active session's runtime cannot compact.
    router.post("/chats/:chatId/compact", requireChatOwner, async (req, res) => {
        const requestedIdentifier = req.params.chatId;
        if (refuseCheckinNode(res, requestedIdentifier)) return;
        const session = getSessionByIdentifier(requestedIdentifier, req.user?.id ?? null);
        const nodeId = session?.id ?? resolvePublicNodeId(requestedIdentifier, req.user?.id ?? null) ?? requestedIdentifier;
        if (refuseCheckinNode(res, nodeId)) return;
        const instructions = typeof req.body?.instructions === "string" ? req.body.instructions : undefined;
        try {
            // Compaction is normally requested while idle, when chatHub holds
            // no active session — pass the registry-resolved one.
            const idle = !chatHub.isActive(nodeId);
            const result = await chatHub.compact(nodeId, instructions, session ?? undefined);
            // Inside a turn, that turn's own reads still count, and its events tell the context.
            if (result.started && idle) compactedOrCleared(nodeId, session ?? undefined);
            res.status(result.started ? 200 : 409).json(result);
        } catch (err) {
            res.status(500).json({ error: (err as Error).message, started: false });
        }
    });

    // What SQLite applied for each chat, to check a window against without the
    // feed (a window coming back to the foreground or opening a pane): the
    // chats it is behind on reconcile through the same path as a replay gap.
    router.post("/chats/background/cursors", (req, res) => {
        const backgroundUserId = process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined;
        if (process.env.MICHI_CLOUD === "1" && !backgroundUserId) {
            return res.status(401).json({ error: "unauthorized" });
        }
        const raw: unknown = req.body?.chatIds;
        if (!Array.isArray(raw)) return res.status(400).json({ error: "chatIds must be an array" });
        const cursors: Record<string, BackgroundCursor & { nodeId: string }> = {};
        for (const chatId of raw.slice(0, MAX_BACKGROUND_CURSORS)) {
            if (typeof chatId !== "string" || !chatId) continue;
            // As in the feed below (w2-fix D13): no cursor names a check-in's node or turns.
            if (checkinPurposeId(chatId)) continue;
            const durable = durableBackgroundCursor(chatId, backgroundUserId ?? null);
            if (durable?.cursor && !checkinPurposeId(durable.nodeId)) cursors[chatId] = { ...durable.cursor, nodeId: durable.nodeId };
        }
        res.json({ cursors });
    });

    router.post("/chats/background/subscribe", (req, res) => {
        const backgroundUserId = process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined;
        if (process.env.MICHI_CLOUD === "1" && !backgroundUserId) {
            return res.status(401).json({ error: "unauthorized" });
        }
        const requestedCursors = readBackgroundCursors(req.body?.cursors);
        const cursors: Record<string, BackgroundCursor> = {};
        const durableCursors: Record<string, BackgroundCursor> = {};
        const nodeIds = new Map<string, string>();
        for (const [chatId, cursor] of Object.entries(requestedCursors)) {
            // One feed for every chat, so a check-in's cursor is refused alone (w2-fix D13): its
            // private turns are never replayed, and no gap frame names its node or turns.
            if (checkinPurposeId(chatId)) continue;
            const durable = durableBackgroundCursor(chatId, backgroundUserId ?? null);
            if (process.env.MICHI_CLOUD === "1" && !durable) continue;
            if (durable && checkinPurposeId(durable.nodeId)) continue;
            cursors[chatId] = cursor;
            if (!durable) continue;
            nodeIds.set(chatId, durable.nodeId);
            if (durable.cursor) durableCursors[chatId] = durable.cursor;
        }
        const observer = beginSse(res);
        // The wire copy only: the hub and its in-process subscribers keep whole tool outputs.
        const forWire = createToolOutputStreamProjector();
        try {
            observer.addCleanup(chatHub.subscribeBackground({
            includeForeground: req.body?.includeForeground === true,
            send: (chatId, event, selfInitiated) => {
                if (observer.closed) return;
                const wireEvent = forWire(event);
                observer.write(selfInitiated === false
                    ? `event: foreground_event\ndata: ${JSON.stringify(wireEvent)}\n\n`
                    : encodeChatStreamEvent(wireEvent));
            },
            gap: (chatId, durableCursor) => {
                const nodeId = nodeIds.get(chatId)
                    ?? getNodeSessionBinding(chatId, backgroundUserId ?? null)?.nodeId;
                observer.write(`event: background_sync_required\ndata: ${JSON.stringify({ chatId, nodeId, ...durableCursor })}\n\n`);
            },
            close: () => {},
            ownerUserId: backgroundUserId,
            }, { cursors, durableCursors }));
            observer.addCleanup(subscribeSessionStates((nodeId, state) => {
                observer.write(encodeChatStreamEvent({ event: 'session_state', data: { ...state, nodeId, chatId: nodeId } }));
            }, backgroundUserId));
            // Scheduled runs create threads without a renderer. This control
            // frame lets every open window install the new thread and refresh
            // it when the run ends. Scheduling is desktop-only (no owners).
            if (process.env.MICHI_CLOUD !== "1") {
                observer.addCleanup(scheduledJobEvents.subscribe({
                    send: (event) => { observer.write(encodeScheduledJobEvent(event)); },
                    // Jobs created/edited elsewhere (another window, an agent tool).
                    sendChange: (event) => { observer.write(encodeScheduledJobsChangedEvent(event)); },
                }));
            }
            // Workspace/tree/thread structure changes (any window, tool or
            // scheduled run), owner-scoped. Opens with the current cursor.
            observer.addCleanup(structureEvents.subscribe({
                ownerUserId: backgroundUserId,
                send: (event) => { observer.write(encodeWorkspaceStructureChangedEvent(event)); },
            }));
            // Server-decided notifications (services/attention): the owner's
            // active records first, then every new and resolved record.
            if (!observer.closed) {
                observer.addCleanup(attentionFeed.subscribe(
                    backgroundUserId ?? LOCAL_AGENT_OWNER_ID,
                    { send: (frame) => { observer.write(frame); } },
                ));
            }
        } catch {
            observer.close();
            if (!res.writableEnded) res.end();
            return;
        }
        observer.heartbeat(': keepalive\n\n', HEARTBEAT_INTERVAL_MS);
    });

    router.get("/chats/:chatId/stream", requireChatOwner, (req, res) => {
        const requestedIdentifier = req.params.chatId;
        // A check-in's turn is private (DESIGN-v2 §2.5): no client replays it.
        if (refuseCheckinNode(res, requestedIdentifier)) return;
        const nodeId = resolvePublicNodeId(requestedIdentifier, req.user?.id ?? null) ?? requestedIdentifier;
        if (refuseCheckinNode(res, nodeId)) return;
        const fromSeqRaw = req.query.fromSeq;
        const fromTurnIdRaw = req.query.fromTurnId;
        const fromSeq = typeof fromSeqRaw === "string" ? parseInt(fromSeqRaw, 10) : 0;
        const fromTurnId = typeof fromTurnIdRaw === "string" ? fromTurnIdRaw : undefined;

        if (!fromTurnId) return res.status(400).json({ error: 'fromTurnId is required' });
        if (!canAccessRuntimeChat(requestedIdentifier, req.user?.id)) {
            return res.status(404).json({ error: 'not_found' });
        }
        // Validate the replay cursor before committing HTTP/SSE headers so a
        // gap remains an actionable 410 response rather than a hung stream.
        const probe = chatHub.subscribeTurn(nodeId, fromTurnId, { send: () => {}, close: () => {} }, Number.isFinite(fromSeq) ? fromSeq : 0);
        if (!probe) return res.status(410).json(chatReplayUnavailable(nodeId, fromTurnId, chatHub.isSelfTurn(nodeId, fromTurnId)));
        probe();

        const observer = beginSse(res);
        // The wire copy only: the hub and its in-process subscribers keep whole tool outputs.
        const forWire = createToolOutputStreamProjector();
        const sub: HubSubscriber = {
            send: (ev) => {
                if (observer.closed || !observer.write(encodeChatStreamEvent(forWire(ev)))) return;
                if (ev.event === CHAT_STREAM_EVENTS.done || ev.event === CHAT_STREAM_EVENTS.error) {
                    // A replay/direct recovery stream is per-turn. It must
                    // release its HTTP/1.1 slot once that turn is terminal.
                    queueMicrotask(() => {
                        if (!res.writableEnded) res.end();
                    });
                }
            },
            close: () => {
                if (!res.writableEnded && !res.destroyed) res.end();
            },
        };
        const subscription = chatHub.subscribeTurn(nodeId, fromTurnId, sub, Number.isFinite(fromSeq) ? fromSeq : 0);
        if (!subscription) return res.status(410).json({ error: 'turn replay unavailable', code: TURN_ERROR_CODES.replayUnavailable });
        observer.addCleanup(subscription);
        observer.heartbeat(': keepalive\n\n', HEARTBEAT_INTERVAL_MS);
    });

    // The saved outcome of one turn once its live replay (above) is gone. The
    // message is the stored row, so the renderer maps it as hydration does.
    router.get("/chats/:chatId/turns/:turnId", requireChatOwner, (req, res) => {
        const requestedIdentifier = req.params.chatId;
        if (refuseCheckinNode(res, requestedIdentifier)) return;
        if (!canAccessRuntimeChat(requestedIdentifier, req.user?.id)) {
            return res.status(404).json({ error: 'not_found' });
        }
        const nodeId = resolvePublicNodeId(requestedIdentifier, req.user?.id ?? null) ?? requestedIdentifier;
        if (refuseCheckinNode(res, nodeId)) return;
        const saved = getSavedTurn(nodeId, req.params.turnId, req.user?.id);
        if (!saved) return res.status(404).json({ error: 'not_found' });
        const { turn, message } = saved;
        res.json({
            turnId: turn.turn_id,
            assistantId: turn.assistant_message_id,
            status: turn.status,
            stopReason: turn.stop_reason,
            completedAt: turn.completed_at,
            lastSeq: turn.last_seq,
            // As the tree-messages routes send it, so a recovered turn matches a reloaded one.
            message: message ? projectMessageRowsForTransport([message])[0] : message,
        });
    });

    // Compatibility for older renderers: these endpoints no longer acquire
    // exclusive editing leases. Account/workspace authorization still applies.
    router.post("/chats/:chatId/claim", requireChatOwner, (_req, res) => res.json({ owner: true }));
    router.post("/chats/:chatId/heartbeat", requireChatOwner, (_req, res) => res.json({ ok: true }));
    router.post("/chats/:chatId/release", requireChatOwner, (_req, res) => res.json({ ok: true }));

    // Accept or deny a pending permission request from kiro-cli.
    // The frontend sends { requestId, optionId } to approve, or
    // { requestId, cancel: true } to deny.
    router.post("/chats/:chatId/permission-response", requireChatOwner, (req, res) => {
        // A check-in asks nobody (DESIGN-v2 §2.5): no client answers for it.
        if (refuseCheckinNode(res, req.params.chatId)) return;
        if (refuseCheckinNode(res, resolvePublicNodeId(req.params.chatId, req.user?.id ?? null))) return;
        const { requestId, optionId, cancel } = req.body ?? {};
        if (typeof requestId !== "number") {
            return res.status(400).json({ error: "requestId (number) is required" });
        }
        if (cancel !== true && typeof optionId !== "string") {
            return res.status(400).json({ error: "optionId (string) required when not cancelling" });
        }
        const r = answerChatPermission(req.params.chatId, req.user?.id ?? null,
            cancel === true ? { requestId, cancel: true } : { requestId, optionId });
        return r.ok ? res.json({ ok: true }) : res.status(r.status).json({ error: r.error });
    });

    // Respond to a pending AskUserQuestion from the agent.
    router.post("/chats/:chatId/user-input-response", requireChatOwner, (req, res) => {
        if (refuseCheckinNode(res, req.params.chatId)) return;
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (!session) return res.status(404).json({ error: "unknown chat" });
        const nodeId = session.id;
        if (refuseCheckinNode(res, nodeId)) return;
        const { requestId, interactionId, answers, skip } = req.body ?? {};
        if (typeof requestId !== "number") {
            return res.status(400).json({ error: "requestId (number) is required" });
        }
        if (interactionId !== undefined && typeof interactionId !== 'string') {
            return res.status(400).json({ error: 'interactionId must be a string when provided' });
        }
        const pending = chatHub.getPendingUserInput(nodeId);
        // Numeric-only clients remain supported; current clients bind their
        // response to the exact durable interaction across session recreation.
        if (!pending || pending.requestId !== requestId || (interactionId !== undefined && pending.interactionId !== interactionId)) {
            return res.status(409).json({ error: 'User input request is no longer pending' });
        }
        if (skip === true) {
            if (!session.skipUserInput) return res.status(400).json({ error: 'Session does not support skipping user input requests' });
            session.skipUserInput(requestId);
            chatHub.resolveUserInput(nodeId, requestId, [], true);
            return res.json({ ok: true });
        }
        if (!Array.isArray(answers)) {
            return res.status(400).json({ error: "answers (array) required when not skipping" });
        }
        if (!session.respondToUserInput) {
            return res.status(400).json({ error: "Session does not support user input requests" });
        }
        if (!answers.every((answer: unknown) => answer && typeof answer === 'object'
            && typeof (answer as { question?: unknown }).question === 'string'
            && typeof (answer as { answer?: unknown }).answer === 'string'
            && ((answer as { id?: unknown }).id === undefined || typeof (answer as { id?: unknown }).id === 'string'))) {
            return res.status(400).json({ error: 'Each answer requires question and answer strings' });
        }
        session.respondToUserInput(requestId, answers);
        chatHub.resolveUserInput(nodeId, requestId, answers, false);
        res.json({ ok: true });
    });

    // List always-allow permission grants for a workspace.
    router.get("/workspaces/:workspaceId/permission-grants", requireWorkspaceOwner, (req, res) => {
        const { workspaceId } = req.params;
        try {
            res.json({ grants: listGrants(workspaceId) });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    // Revoke a single grant.
    router.delete("/workspaces/:workspaceId/permission-grants/:toolName", requireWorkspaceOwner, (req, res) => {
        const { workspaceId, toolName } = req.params;
        try {
            revokePermission(workspaceId, toolName);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    const sendModeCatalog = async (req: express.Request, res: express.Response, cwd?: string) => {
        const cfg = getAgentConfig(process.env.MICHI_CLOUD === "1" ? req.user?.id : undefined);
        const runtime = getRuntime(cfg.runtime);
        if (!runtime?.capabilities.modes) {
            return res.json({ availableModes: [], defaultModeId: null });
        }
        if (cwd !== undefined) {
            const invalid = workspaceCwdError(cwd);
            if (invalid) return res.status(400).json(invalid);
        }
        try {
            // Kiro discovers the default Agent from the same fresh ACP session
            // used to warm this cwd. Other runtimes expose their catalog only.
            if (runtime === chatManager.getRuntime()) {
                return res.json(await chatManager.getModeCatalog(cwd));
            }
            const modes = await (runtime.listModes?.("") ?? Promise.resolve([]));
            return res.json({
                availableModes: modes.map((m) => ({
                    id: m.id,
                    name: m.label ?? m.id,
                    description: m.description,
                })),
                defaultModeId: null,
            });
        } catch (err) {
            return res.status(500).json({ error: (err as Error).message });
        }
    };

    // Compatibility path for callers that do not yet have a workspace.
    router.get("/modes", (req, res) => sendModeCatalog(req, res));

    router.get("/workspaces/:workspaceId/modes", requireWorkspaceOwner, async (req, res) => {
        const workspace = getWorkspace(req.params.workspaceId);
        if (!workspace) return res.status(404).json({ error: "workspace not found" });
        return sendModeCatalog(req, res, workspaceSessionCwd(workspace, req.user?.id, process.cwd()));
    });

    router.get("/chats/:chatId/modes", requireChatOwner, (req, res) => {
        // A check-in's session state is the engine's alone (DESIGN-v2 §2.5, w2-fix D13), reads included.
        if (refuseCheckinNode(res, req.params.chatId)) return;
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (!session) return res.status(404).json({ error: "unknown chat" });
        if (refuseCheckinNode(res, session.id)) return;
        res.json({ currentModeId: session.currentModeId ?? null, ...session.getSessionState?.() });
    });

    router.post("/chats/:chatId/set-mode", requireChatOwner, async (req, res) => {
        if (refuseCheckinNode(res, req.params.chatId)) return;
        const modeId = req.body?.modeId;
        if (typeof modeId !== "string" || !modeId) {
            return res.status(400).json({ error: "modeId is required" });
        }
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (!session?.setMode) {
            return res.status(400).json({ error: "Active session does not support modes" });
        }
        try {
            await session.setMode(modeId);
            res.json({ ok: true, currentModeId: modeId });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.get("/chats/:chatId/model", requireChatOwner, (req, res) => {
        if (refuseCheckinNode(res, req.params.chatId)) return;
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (!session) return res.status(404).json({ error: "unknown chat" });
        if (refuseCheckinNode(res, session.id)) return;
        res.json({ currentModelId: session.currentModelId ?? null });
    });

    router.post("/chats/:chatId/set-model", requireChatOwner, async (req, res) => {
        if (refuseCheckinNode(res, req.params.chatId)) return;
        const modelId = req.body?.modelId;
        if (typeof modelId !== "string" || !modelId) {
            return res.status(400).json({ error: "modelId is required" });
        }
        const nodeId = resolvePublicNodeId(req.params.chatId, req.user?.id ?? null) ?? req.params.chatId;
        const releaseRestore = await acquireSessionRestoreLock(nodeId);
        try {
            const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
            if (!session?.setModel) {
                return res.status(400).json({ error: "Active session does not support runtime model switching" });
            }
            if (turnBusy(nodeId)) {
                return res.status(409).json({ code: TURN_ERROR_CODES.active, error: 'Cannot change model during an active turn' });
            }
            await session.setModel(modelId);
            const row = getNode(nodeId);
            await persistResumeBinding(nodeId, session, {
                runtimeId: session.runtimeId, modelId, providerId: row?.provider_id ?? null,
                reasoning: normalizeReasoning(row?.reasoning),
            }, null);
            res.json({ ok: true, currentModelId: modelId });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        } finally {
            releaseRestore();
        }
    });

    /**
     * Execute a runtime-native command (e.g. Kiro slash command) without
     * consuming a prompt turn. V2 uses its command RPC; V3 uses negotiated
     * extensions or session configuration. Unsupported V3 commands return
     * an explicit failure rather than becoming a model prompt.
     *
     * Side effects (e.g. compaction/clear notifications) arrive on the
     * session queue and are delivered as SSE events during the next turn
     * or via the background observer.
     */
    router.post("/chats/:chatId/execute-command", requireChatOwner, async (req, res) => {
        if (refuseCheckinNode(res, req.params.chatId)) return;
        const { command, args } = req.body ?? {};
        if (typeof command !== "string" || !command) {
            return res.status(400).json({ error: "command is required" });
        }
        const session = getSessionByIdentifier(req.params.chatId, req.user?.id ?? null);
        if (session && refuseCheckinNode(res, session.id)) return;
        if (!session?.executeCommand) {
            return res.status(400).json({ error: "Active session does not support command execution" });
        }
        if (chatHub.holdsSession(session.id)) return res.status(409).json({ error: 'Wait for the active turn to finish before executing a command.' });
        try {
            // Where /clear replaces the native session (Kiro v3), Michi resets the chat's context.
            const clearRuntime = command === 'clear' ? getRuntime(session.runtimeId) : undefined;
            if (clearRuntime && descriptorOf(clearRuntime).topology.clearCreatesNewNativeSession === true) {
                const primaryAgent = await chatManager.resolvePrimaryAgentBinding({
                    ownerUserId: req.user?.id ?? LOCAL_AGENT_OWNER_ID,
                    workspaceId: getNode(session.id)?.workspace_id ?? null, nodeId: session.id,
                });
                const replacement = await resetKiroContext(session, req.user?.id ?? null, primaryAgentSessionOptions(primaryAgent));
                // The new native session holds nothing earlier turns read (w2-fix D1).
                clearCarriedCompanionTaint(session.id);
                return res.json({ success: true, message: 'Started a new Kiro context. Previous messages remain in Michi.', sessionState: replacement.getSessionState?.() });
            }
            // The host command changes the same durable binding as the model
            // picker, so restoring the session cannot undo a successful switch.
            if (session.runtimeId === 'claude' && command === 'model' && typeof args?.value === 'string' && args.value.trim()) {
                const nodeId = resolvePublicNodeId(req.params.chatId, req.user?.id ?? null) ?? req.params.chatId;
                const releaseRestore = await acquireSessionRestoreLock(nodeId);
                try {
                    if (getSessionByIdentifier(req.params.chatId, req.user?.id ?? null) !== session
                        || chatHub.holdsSession(nodeId)) {
                        return res.status(409).json({ error: 'Cannot change model during an active turn' });
                    }
                    const result = await session.executeCommand(command, args);
                    if (result.success) {
                        const row = getNode(nodeId);
                        await persistResumeBinding(nodeId, session, { runtimeId: session.runtimeId,
                            modelId: session.currentModelId ?? null, providerId: row?.provider_id ?? null,
                            reasoning: normalizeReasoning(row?.reasoning) }, null);
                    }
                    return res.json({ ...result, sessionState: session.getSessionState?.() });
                } finally { releaseRestore(); }
            }
            // A native command (an in-place /clear, /compact) may drop the Michi Memory block and the
            // agent's standing [COMPANION CONTEXT] blocks from the context: the next turn sends them again.
            chatHub.forgetInjectedMemory(session);
            forgetCompanionContext(session);
            const result = await session.executeCommand(command, args ?? undefined);
            // What earlier turns read of check-in material is gone from it too (w2-fix D1).
            if (result.success && (command === 'clear' || command === 'compact')) clearCarriedCompanionTaint(session.id);
            res.json({ ...result, sessionState: session.getSessionState?.() });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.get("/models", async (_req, res) => {
        try {
            const { execFile } = await import("child_process");
            const { promisify } = await import("util");
            const { findKiroCli } = await import("michi-runtime/internal/adapters/kiro/acpClient");
            const pexec = promisify(execFile);
            const bin = process.env.KIRO_CLI_BIN || findKiroCli({ kiroCliBin: process.env.KIRO_CLI_BIN, localAppData: process.env.LOCALAPPDATA });
            const { stdout } = await pexec(bin, ["chat", "--list-models", "--format", "json"], {
                timeout: 5000,
            });
            const parsed = JSON.parse(stdout);
            res.json({ models: parsed.models || [], default_model: parsed.default_model || null });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    return router;
}
