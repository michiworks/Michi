import { hostOwner } from '../ownerMapping';
import { openUrlTool } from '../openUrlTool';
import { readConversationUpdatesTool } from '../conversationUpdatesTool';
import { chatNodeOf, isRunOwner, runIdOfOwner } from '../ownerMapping';
import { reportConversationNoChange } from '../../services/scheduledJobs/conversationBatch';
import { michiDocsTool } from '../../services/michiDocs';
import { michiSkillsTool } from '../../services/skills/michiSkillsTool';
import type { AgentToolBridge } from "../toolBridge";
import {
    AGENT_RUN_TOOL_NAMES,
    type AgentRunToolName,
    type AgentRunToolInvoker,
} from "../runToolBridge";
import {
    listEnabledBuiltinTools,
    AGENT_RUN_TOOL_DEFINITIONS,
    SUBMIT_AGENT_RESULT_DEFINITION,
    type ParamField,
    type ParamObjectShape,
    type ParamSpec,
} from "../builtinTools";
import { getRuntimeDeps } from "../runtimeDeps";
import { listReadyModelsTool, proposeMultiModelPlanTool, type MultiModelToolCaller } from "../multiModelTool";
import {
    inspectPaneTool,
    readPaneOutputTool,
    listPanesTool,
    waitPaneTool,
    type PaneInspectionToolBinding,
} from "../paneInspectionTools";
import { assertWithinCwd, PathSandboxError, resolveToCwd } from "../tools/pathSandbox";
import { executeRead, type TurnImageQuota } from "../tools/read";
import { executeLs } from "../tools/ls";
import { executeGrep } from "../tools/grep";
import { executeFind } from "../tools/find";
import { executeWrite } from "../tools/write";
import { executeEdit } from "../tools/edit";
import { executeBash } from "../tools/bash";
import { resolveShowImage } from "michi-runtime/internal/core/showImage";
import { askUserThreadMessageApprover, sendToThreadTool } from "../threadMessageTool";
import { askUserScheduledJobApprover, scheduledJobTool, type ScheduledJobToolName } from "../scheduledJobTools";
import { memoryTool } from "../memoryTools";
import { MEMORY_TOOL_LABELS } from "../memoryToolNames";
import { TEMPORARY_CHAT_MESSAGE, paneArgumentNodeIds, temporaryChatRefuses } from "../../services/globalContext";
import { type ArtifactToolName } from "../artifactToolNames";
import { artifactTool, type ArtifactApprovalRequest, type DeletedArtifact } from "../artifactTools";
import { askUserApprover } from "../hostApproval";
import { formatWebSearchForAgent, isWebSearchEnabled, searchWeb } from "../../services/webSearch";
import { fetchContent, formatFetchContentForAgent } from "../../services/webFetch";

const SCHEDULED_JOB_TOOL_LABELS: Record<ScheduledJobToolName, string> = {
    list_scheduled_jobs: "List scheduled jobs",
    create_scheduled_job: "Create scheduled job",
    update_scheduled_job: "Change scheduled job",
    run_scheduled_job: "Run scheduled job",
    delete_scheduled_job: "Delete scheduled job",
};

const ARTIFACT_TOOL_LABELS: Record<ArtifactToolName, string> = {
    list_artifacts: "List artifacts",
    search_artifacts: "Search artifacts",
    delete_artifact: "Delete artifact",
};
import type { NormalizedEvent } from "../../services/chatEvents";
import type { RuntimeSessionOwner, RuntimeToolProfile } from "../types";
import {
    SUBMIT_AGENT_RESULT_TOOL,
    type RunWorkerToolProfile,
} from "../runs/runWorkerTools";
import { assistantToolsFor, runAssistantTool } from "../../assistant/tools";
import { assistantPurposeOf, isAssistantWorkspace } from "../../assistant/identity";
import { PI_MAIN_EXTRA, PI_NATIVE_TOOL_NAMES } from "../../assistant/policy";
import { PAGE_WRITE_TOOL_NAMES } from 'michi-shared';
import { PAGE_TOOL_NAMES, type ActivePageTurnAttributionGetter, type PageToolName } from '../pageToolNames';
import { runPageTool } from '../pageTools';
import { isMaintenanceProfile } from '../maintenancePolicy';
import { buildPiTodoTool, type PiTodoList } from './piTodoTool';
import { buildPiAskUserTool, piAskUserChannel, type PiUserInputRequester } from './piAskUser';

/**
 * Build the AgentTool[] array fed to pi-agent-core.
 *
 * Title and follow-ups are emitted as inline `[TITLE:]` / `[FOLLOW-UP n/3:]`
 * sentinels in the LLM's text stream — not as tools — so this factory
 * handles the side-effect tools (spawn_branches, save_artifact, update_artifact) and the
 * read-only globalContext tools (list_threads, search_messages, read_node).
 *
 * spawn_branches forces sequential execution because it mutates the chat
 * graph; if a single assistant response ever included another tool call
 * alongside it, parallel execution could race the parent's child registry.
 */

export interface BuildPiToolsOpts {
    bridge: AgentToolBridge;
    cwd: string;
    parentChatId: string;
    /** Workspace this session is bound to. null when the session predates workspaceId threading or the lookup failed. */
    workspaceId: string | null;
    enableFollowUps: boolean;
    /** Per-turn cumulative image-byte budget shared by all read calls. */
    imageQuota: TurnImageQuota;
    /**
     * Session-scoped set of absolute paths the agent has successfully read.
     * read writes; write/edit consult so the agent can't blindly overwrite
     * or edit a file it hasn't actually seen.
     */
    seenPaths: Set<string>;
    /** typebox `Type` namespace, fetched at call time from pi-ai. */
    Type: any;
    /**
     * Better-Auth user id of the chat owner. Forwarded to executeBash so cloud
     * mode can apply an explicit env allowlist (hiding MICHI_ENCRYPTION_KEY etc.).
     * Required in cloud mode: without it bash refuses to run. Null / undefined
     * on desktop, where bash keeps the full process.env.
     */
    ownerUserId?: string | null;
    /**
     * Push a side-effect NormalizedEvent (e.g. an inline `image`) into the
     * active turn's event queue. show_image uses this to render an image in the
     * UI without feeding it into the LLM's context. No-op if no turn is active.
     */
    emitImage?: (ev: NormalizedEvent) => void;
    /**
     * The session's user question channel. Present → the catalog offers
     * ask_user, and a send_to_thread, scheduled job or delete_artifact
     * approval asks through it; absent (maintenance access, internal
     * catalogs) → neither, and such an approval fails closed.
     */
    requestUserInput?: PiUserInputRequester;
    /** Session-bound generic Agent tools resolved by PiSession. */
    agentRunTools?: AgentRunToolInvoker | null;
    owner?: RuntimeSessionOwner;
    toolProfile?: RuntimeToolProfile;
    /** Canonical attribution for this session's currently owning send. */
    getActivePageTurnAttribution?: ActivePageTurnAttributionGetter;
    /** The session's todo list. Absent: no todo tool (assistant and restricted catalogs never get one). */
    todoList?: PiTodoList;
    /**
     * Skill folders outside the workspace that read, ls, grep and find may
     * open, read-only. Asked on every call, so a skill run later counts.
     */
    skillReadRoots?: () => readonly string[];
}

/**
 * pi-agent-core treats a resolved execute() promise as success unless its
 * afterToolCall hook explicitly overrides the error flag. Michi's built-in
 * tools return `{ isError: true }` for expected failures (sandbox rejection,
 * missing file, non-zero bash exit), so bridge that contract here.
 */
export function piToolResultErrorOverride(context: {
    result: unknown;
    isError: boolean;
}): { isError: true } | undefined {
    if (context.isError) return undefined;
    if (
        context.result
        && typeof context.result === "object"
        && (context.result as { isError?: unknown }).isError === true
    ) {
        return { isError: true };
    }
    return undefined;
}

function paramToTypebox(spec: ParamSpec, Type: any): any {
    if (spec === "string") return Type.String();
    if (spec === "number") return Type.Number();
    if (spec === "integer") return Type.Integer();
    if (spec === "boolean") return Type.Boolean();
    if ("array" in spec) return Type.Array(spec.array === "string" && spec.itemMinLength !== undefined ? Type.String({ minLength: spec.itemMinLength }) : paramToTypebox(spec.array, Type));
    const shape: Record<string, any> = {};
    for (const [k, v] of Object.entries(spec.object)) shape[k] = fieldToTypebox(v, Type);
    return Type.Object(shape, spec.additionalProperties === undefined ? {} : { additionalProperties: spec.additionalProperties });
}

/**
 * Wrap a tool's top-level parameter object with a required __tool_use_purpose
 * field so pi-agent-core's tool_execution_start event carries a one-line
 * description the UI can show next to the tool chip — same field Kiro path
 * extracts from kiro-cli's rawInput.
 */
function withPurposeField(parameters: ParamObjectShape, Type: any): any {
    const shape: Record<string, any> = {
        __tool_use_purpose: {
            ...Type.String(),
            description:
                "One short sentence stating why you're calling this tool — shown to the user as context. Always include this.",
        },
    };
    for (const [k, v] of Object.entries(parameters.object)) shape[k] = fieldToTypebox(v, Type);
    return Type.Object(shape);
}

function fieldToTypebox(field: ParamField, Type: any): any {
    let schema: any;
    if (field.enum && field.type === "string") {
        schema = field.enum.length > 0
            ? Type.Union(field.enum.map((v) => Type.Literal(v)))
            : Type.String();
    } else {
        schema = paramToTypebox(field.type, Type);
    }
    if (field.const !== undefined) schema = Type.Literal(field.const);
    for (const key of ['minimum', 'maximum', 'minLength', 'minItems'] as const) {
        if (field[key] !== undefined) schema = { ...schema, [key]: field[key] };
    }
    if (field.description) schema = { ...schema, description: field.description };
    return field.optional ? Type.Optional(schema) : schema;
}

/**
 * The Michi assistant's own Pi tools (assistant/tools.ts): V's catalog or a
 * check-in's, as the conversation's purpose picks; the agent's tools read who
 * started the turn from the session's turn attribution.
 */
function buildPiAssistantTools(opts: BuildPiToolsOpts): any[] {
    const owner = opts.owner;
    const nodeId = chatNodeOf(owner) ?? null;
    // No Desk tools while Agent Desk is off.
    return assistantToolsFor(assistantPurposeOf(nodeId)).map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: withPurposeField(tool.parameters, opts.Type),
        ...(tool.sequential ? { executionMode: "sequential" as const } : {}),
        execute: async (_id: string, args: any, signal?: AbortSignal) => {
            const { __tool_use_purpose: _purpose, ...input } = (args ?? {}) as Record<string, unknown>;
            const result = await runAssistantTool(tool, {
                ownerUserId: opts.ownerUserId ?? null,
                workspaceId: opts.workspaceId,
                nodeId,
                approveThreadMessage: askUserThreadMessageApprover(piAskUserChannel(opts.requestUserInput, signal)),
                approveScheduledJob: askUserScheduledJobApprover(piAskUserChannel(opts.requestUserInput, signal)),
                getActivePageTurnAttribution: opts.getActivePageTurnAttribution,
                showImage: (inputPath, caption) => showPiImage(opts.cwd, opts.emitImage, inputPath, caption),
            }, input);
            return { ...result, details: result };
        },
    }));
}

/** Finds an image in the session's folder and shows it in the reply; the model never reads it. */
function showPiImage(cwd: string, emitImage: BuildPiToolsOpts["emitImage"], inputPath: string, caption: string | undefined):
    { relPath: string; mimeType: string; size: number } | { error: string } {
    const r = resolveShowImage(cwd, inputPath);
    if (!r.ok) return { error: r.error };
    emitImage?.({ kind: "host_event", type: "image", payload: { path: r.relPath, caption, mimeType: r.mimeType, size: r.size } });
    return { relPath: r.relPath, mimeType: r.mimeType, size: r.size };
}

/**
 * What V keeps on Pi beside its Michi catalog (DESIGN-v2 §2.3): Pi's native
 * file and command tools, and the builtins ⌘J had there (PI_MAIN_EXTRA).
 */
const PI_MAIN_KEPT: ReadonlySet<string> = new Set([...PI_NATIVE_TOOL_NAMES, ...PI_MAIN_EXTRA]);

function isWithin(absolutePath: string, root: string): boolean {
    try {
        assertWithinCwd(absolutePath, root);
        return true;
    } catch (error) {
        if (error instanceof PathSandboxError) return false;
        throw error;
    }
}

/**
 * Where a read-only file tool runs: the workspace, or the skill folder that
 * holds the path. That folder is then the call's sandbox root, so its files
 * can be read; write, edit and bash keep the workspace.
 */
function readSandbox<A extends { path?: string }>(args: A, cwd: string, skillRoots: readonly string[]): { root: string; args: A } {
    if (args.path === undefined || skillRoots.length === 0) return { root: cwd, args };
    const absolute = resolveToCwd(args.path, cwd);
    if (isWithin(absolute, cwd)) return { root: cwd, args };
    const root = skillRoots.find((dir) => isWithin(absolute, dir));
    return root ? { root, args: { ...args, path: absolute } } : { root: cwd, args };
}

export function buildPiTools(opts: BuildPiToolsOpts): any[] {
    const purpose = assistantPurposeOf(chatNodeOf(opts.owner));
    // The assistant's catalog needs the profile and a chat in the assistant's
    // workspace; a profile session anywhere else gets no tools at all. A
    // closed profile is a check-in's and keeps only its allow-list: no native
    // tool, and no ask_user. On a node that is not a check-in it gets nothing
    // (§2.5: main with a closed profile has no tools).
    if (opts.toolProfile?.restricted) {
        const home = chatNodeOf(opts.owner) !== undefined && isAssistantWorkspace(opts.workspaceId);
        if (!home || purpose !== "checkin") return [];
        const allowed = opts.toolProfile.allowedToolNames ?? [];
        return withAskUser(buildPiAssistantTools(opts), opts).filter((tool) => allowed.includes(tool.name));
    }
    // A check-in runs only with its closed profile (assistant/policy.ts
    // assistantToolProfile): bound any other way, with the open profile or
    // none, it gets no tools at all.
    if (purpose === "checkin") return [];
    const { bridge, cwd, parentChatId, workspaceId, enableFollowUps, imageQuota, seenPaths, Type, ownerUserId, emitImage } = opts;
    // A conversation whose memory setting is off reads no other conversation (globalContext.temporaryChatRefuses).
    const callerNodeId = chatNodeOf(opts.owner) ?? null;
    const temporaryChat = () => ({ content: [{ type: "text", text: TEMPORARY_CHAT_MESSAGE }], details: { status: "temporary_chat" } });
    const skillRoots = () => opts.skillReadRoots?.() ?? [];
    const paneBinding: PaneInspectionToolBinding = {
        ownerUserId: ownerUserId ?? null,
        workspaceId,
        runOwnerRunId: runIdOfOwner(opts.owner),
        backendConnectionId: 'local',
    };

    const builtinTools = listEnabledBuiltinTools().map((t): any => {
        if (PAGE_TOOL_NAMES.includes(t.name as PageToolName) && ((!opts.owner || hostOwner(opts.owner).kind !== 'chat_node') || isMaintenanceProfile(opts.toolProfile))) return null;
        // Search is opt-in. Omitting the tool entirely keeps an unconfigured
        // provider from causing the model to attempt a network request.
        // fetch_content needs no key, but it opens the same door to the web, so it follows the same setting.
        if ((t.name === "web_search" || t.name === "fetch_content") && !isWebSearchEnabled(ownerUserId ?? undefined)) return null;
        const parameters = withPurposeField(t.parameters, Type);

        switch (t.name) {
            case "michi_docs":
                return { name: t.name, label: "Michi docs", description: t.description, parameters,
                    execute: async (_id: string, args: any) => michiDocsTool(args) };
            case "michi_skills":
                return { name: t.name, label: "Michi skills", description: t.description, parameters,
                    execute: async (_id: string, args: any) => michiSkillsTool(args) };
            case 'read_home':
            case 'edit_home':
            case 'list_pages':
            case 'read_page':
            case 'preview_page':
            case 'edit_page':
            case 'create_page':
            case 'create_database':
            case 'configure_database':
            case 'read_database':
            case 'edit_database':
            case 'list_page_components':
            case 'read_page_component':
            case 'save_page_component':
            case 'configure_database_view':
            case 'open_task_database':
            case 'list_tasks': {
                if (!PAGE_TOOL_NAMES.includes(t.name as PageToolName)) throw new Error(`unknown page tool: ${t.name}`);
                const name = t.name as PageToolName;
                return {
                    name,
                    label: name.replaceAll('_', ' '),
                    description: t.description,
                    parameters,
                    ...((PAGE_WRITE_TOOL_NAMES as readonly string[]).includes(name) ? { executionMode: 'sequential' as const } : {}),
                    execute: async (_id: string, args: any) => {
                        const { __tool_use_purpose: _purpose, ...input } = (args ?? {}) as Record<string, unknown>;
                        const result = runPageTool(name, {
                            ownerUserId: ownerUserId ?? null,
                            workspaceId: opts.workspaceId,
                            nodeId: (opts.owner && hostOwner(opts.owner).kind === 'chat_node') ? opts.owner.key : null,
                            ownerKind: opts.owner ? hostOwner(opts.owner).kind : null,
                            getActivePageTurnAttribution: opts.getActivePageTurnAttribution,
                        }, input);
                        return { ...result, details: result.details };
                    },
                };
            }
            case "open_url":
                return { name: t.name, label: "Open URL", description: t.description, parameters,
                    execute: async (_id: string, args: any) => openUrlTool({ workspaceId, ownerUserId,
                        nodeId: chatNodeOf(opts.owner) ?? null }, args.url) };
            // A business effect the bridge lacks offers no tool.
            case "spawn_branches":
                if (!bridge.spawnBranches) return null;
                return {
                    name: t.name,
                    label: "Spawn branches",
                    description: t.description,
                    parameters,
                    executionMode: "sequential" as const,
                    execute: async (_id: string, args: any) => {
                        const topics = Array.isArray(args?.topics) ? args.topics : [];
                        const created = await bridge.spawnBranches!({
                            parentChatId,
                            cwd,
                            enableFollowUps,
                            ownerUserId,
                            topics,
                        });
                        const summary = created.map((r) => `- ${r.title} (chatId: ${r.chatId})`).join("\n");
                        return {
                            content: [{
                                type: "text",
                                text: `Spawned ${created.length} branch${created.length === 1 ? "" : "es"}:\n${summary}`,
                            }],
                            details: { created },
                        };
                    },
                };

            case "save_artifact":
                if (!bridge.saveContext) return null;
                return {
                    name: t.name,
                    label: "Save artifact",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const name = typeof args?.name === "string" ? args.name.trim() : "";
                        if (!name || (typeof args?.body === "string") === (typeof args?.path === "string")) {
                            throw new Error("save_artifact requires name and exactly one of body or path");
                        }
                        const result = bridge.saveContext!({
                            cwd,
                            chatId: parentChatId,
                            ownerUserId: opts.ownerUserId,
                            name,
                            body: args.body,
                            path: args.path,
                        });
                        if (!result) {
                            throw new Error(`Could not save artifact: @${name}`);
                        }
                        return {
                            content: [
                                { type: "text", text: `Saved artifact: @${result.name}` },
                            ],
                            details: result,
                        };
                    },
                };

            case "update_artifact":
                if (!bridge.updateContext) return null;
                return {
                    name: t.name,
                    label: "Update artifact",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const name = typeof args?.name === "string" ? args.name.trim() : "";
                        if (!name || typeof args?.body !== "string") {
                            throw new Error("update_artifact requires name and body");
                        }
                        const result = bridge.updateContext!({
                            cwd,
                            chatId: parentChatId,
                            ownerUserId: opts.ownerUserId,
                            name,
                            body: args.body,
                        });
                        if (!result) {
                            throw new Error(`Artifact does not exist or could not be updated: @${name}`);
                        }
                        return {
                            content: [
                                { type: "text", text: `Updated artifact: @${result.name}` },
                            ],
                            details: result,
                        };
                    },
                };

            case "show_image":
                return {
                    name: t.name,
                    label: "Show image",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const caption = typeof args?.caption === "string" ? args.caption : undefined;
                        const shown = showPiImage(cwd, emitImage, String(args?.path ?? ""), caption);
                        if ("error" in shown) {
                            return {
                                content: [{ type: "text", text: `show_image failed: ${shown.error}` }],
                                details: { error: shown.error },
                                isError: true,
                            };
                        }
                        return {
                            content: [{ type: "text", text: `Displayed ${shown.relPath} to the user.` }],
                            details: { ...shown, caption },
                        };
                    },
                };

            case "list_threads": {
                const gc = getRuntimeDeps().globalContext;
                if (!gc) return null;
                return {
                    name: t.name,
                    label: "List threads",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        if (temporaryChatRefuses(callerNodeId)) return temporaryChat();
                        const result = gc.listThreads(
                            workspaceId,
                            ownerUserId ?? null,
                            typeof args?.workspaceId === "string" ? args.workspaceId : undefined,
                            parentChatId,
                            { includeScheduledRuns: args?.includeScheduledRuns === true },
                        );
                        return { content: [{ type: "text", text: result.text }], details: result };
                    },
                };
            }

            case "search_messages": {
                const gc = getRuntimeDeps().globalContext;
                if (!gc) return null;
                return {
                    name: t.name,
                    label: "Search messages",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        if (temporaryChatRefuses(callerNodeId)) return temporaryChat();
                        const result = gc.searchMessages(
                            workspaceId,
                            ownerUserId ?? null,
                            String(args?.query ?? ""),
                            args?.scope === "all" ? "all" : "current",
                            typeof args?.limit === "number" ? args.limit : 10,
                            { includeScheduledRuns: args?.includeScheduledRuns === true },
                        );
                        return { content: [{ type: "text", text: result.text }], details: result };
                    },
                };
            }

            case "web_search":
                return {
                    name: t.name,
                    label: "Search the web",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        try {
                            const result = await searchWeb(String(args?.query ?? ""), {
                                maxResults: typeof args?.maxResults === "number" ? args.maxResults : undefined,
                                userId: ownerUserId ?? undefined,
                            });
                            return {
                                content: [{ type: "text", text: formatWebSearchForAgent(result) }],
                                details: result,
                            };
                        } catch (error) {
                            const message = error instanceof Error ? error.message : "Web search failed.";
                            return {
                                content: [{ type: "text", text: `Web search unavailable: ${message}` }],
                                details: { error: message },
                                isError: true,
                            };
                        }
                    },
                };

            case "fetch_content":
                return {
                    name: t.name,
                    label: "Fetch web content",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any, signal?: AbortSignal) => {
                        try {
                            const result = await fetchContent({
                                url: String(args?.url ?? ""),
                                offset: typeof args?.offset === "number" ? args.offset : undefined,
                                maxChars: typeof args?.maxChars === "number" ? args.maxChars : undefined,
                                cacheScope: ownerUserId ?? null,
                                signal,
                            });
                            // The text goes to the model once; details keep only provenance and paging.
                            const { content: _content, ...details } = result;
                            return {
                                content: [{ type: "text", text: formatFetchContentForAgent(result) }],
                                details,
                            };
                        } catch (error) {
                            if (signal?.aborted) throw error;
                            const message = error instanceof Error ? error.message : "Fetching the URL failed.";
                            return {
                                content: [{ type: "text", text: `fetch_content failed: ${message}` }],
                                details: { error: message },
                                isError: true,
                            };
                        }
                    },
                };

            case "read_node": {
                const gc = getRuntimeDeps().globalContext;
                if (!gc) return null;
                return {
                    name: t.name,
                    label: "Read node",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        if (temporaryChatRefuses(callerNodeId, [String(args?.nodeId ?? "")])) return temporaryChat();
                        const opts: { role?: "user" | "assistant"; from?: "head" | "tail"; offset?: number; limit?: number; messageId?: string; charOffset?: number } = {};
                        if (args?.role === "user" || args?.role === "assistant") opts.role = args.role;
                        if (args?.from === "head" || args?.from === "tail") opts.from = args.from;
                        if (typeof args?.offset === "number") opts.offset = args.offset;
                        if (typeof args?.limit === "number") opts.limit = args.limit;
                        if (typeof args?.messageId === "string") opts.messageId = args.messageId;
                        if (typeof args?.charOffset === "number") opts.charOffset = args.charOffset;
                        const hasOpts = Object.keys(opts).length > 0;
                        const result = gc.readNode(workspaceId, ownerUserId ?? null, String(args?.nodeId ?? ""), hasOpts ? opts : undefined);
                        return { content: [{ type: "text", text: result.text }], details: result };
                    },
                };
            }

            case "report_conversation_no_change": {
                const nodeId = chatNodeOf(opts.owner) ?? null;
                if (!nodeId) return null;
                return { name: t.name, label: "Report no conversation change", description: t.description, parameters,
                    execute: async (_id: string, args: unknown) => reportConversationNoChange({ nodeId, workspaceId }, args) };
            }

            case "read_conversation_updates": {
                return {
                    name: t.name, label: "Read conversation updates", description: t.description, parameters,
                    execute: async (_id: string, args: unknown) => temporaryChatRefuses(callerNodeId) ? temporaryChat() : readConversationUpdatesTool(paneBinding, args),
                };
            }

            case "read_node_overview": {
                const gc = getRuntimeDeps().globalContext;
                if (!gc) return null;
                return {
                    name: t.name,
                    label: "Read node overview",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        if (temporaryChatRefuses(callerNodeId, [String(args?.nodeId ?? "")])) return temporaryChat();
                        const result = gc.readNodeOverview(workspaceId, ownerUserId ?? null, String(args?.nodeId ?? ""));
                        return { content: [{ type: "text", text: result.text }], details: result };
                    },
                };
            }

            case "inspect_pane": {
                return {
                    name: t.name,
                    label: "Inspect pane",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        if (temporaryChatRefuses(callerNodeId, paneArgumentNodeIds(args))) return temporaryChat();
                        const result = inspectPaneTool(paneBinding, {
                            paneId: typeof args?.paneId === "string" ? args.paneId : undefined,
                            nodeId: typeof args?.nodeId === "string" ? args.nodeId : undefined,
                            runId: typeof args?.runId === "string" ? args.runId : undefined,
                            executionRef: args?.executionRef,
                        });
                        return { ...result, details: result };
                    },
                };
            }

            case "read_pane_output": {
                return {
                    name: t.name,
                    label: "Read pane output",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        if (temporaryChatRefuses(callerNodeId, paneArgumentNodeIds(args))) return temporaryChat();
                        const result = readPaneOutputTool(paneBinding, {
                            paneId: typeof args?.paneId === "string" ? args.paneId : undefined,
                            nodeId: typeof args?.nodeId === "string" ? args.nodeId : undefined,
                            runId: typeof args?.runId === "string" ? args.runId : undefined,
                            selection: args?.selection,
                            executionRef: args?.executionRef,
                            outputId: typeof args?.outputId === "string" ? args.outputId : undefined,
                            pageCursor: typeof args?.pageCursor === "string" ? args.pageCursor : undefined,
                            limitBytes: typeof args?.limitBytes === "number" ? args.limitBytes : undefined,
                        });
                        return { ...result, details: result };
                    },
                };
            }

            case "list_panes": {
                return {
                    name: t.name,
                    label: "List panes",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const result = listPanesTool(paneBinding, {
                            treeId: typeof args?.treeId === "string" ? args.treeId : undefined,
                            kind: args?.kind,
                            parentNodeId: typeof args?.parentNodeId === "string" ? args.parentNodeId : undefined,
                            scope: args?.scope,
                            includeArchived: typeof args?.includeArchived === "boolean" ? args.includeArchived : undefined,
                            limit: typeof args?.limit === "number" ? args.limit : undefined,
                            cursor: typeof args?.cursor === "string" ? args.cursor : undefined,
                        });
                        return { ...result, details: result };
                    },
                };
            }

            case "wait_pane": {
                return {
                    name: t.name,
                    label: "Wait for pane",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        if (temporaryChatRefuses(callerNodeId, paneArgumentNodeIds(args))) return temporaryChat();
                        const result = await waitPaneTool(paneBinding, {
                            paneId: typeof args?.paneId === "string" ? args.paneId : undefined,
                            nodeId: typeof args?.nodeId === "string" ? args.nodeId : undefined,
                            runId: typeof args?.runId === "string" ? args.runId : undefined,
                            until: args?.until,
                            cursor: typeof args?.cursor === "string" ? args.cursor : undefined,
                            executionRef: args?.executionRef,
                            timeoutMs: typeof args?.timeoutMs === "number" ? args.timeoutMs : undefined,
                        });
                        return { ...result, details: result };
                    },
                };
            }

            case "send_to_thread": {
                // Chat-only: an Agent Run (or an unowned session) has no
                // calling thread to attribute the message to.
                const nodeId = chatNodeOf(opts.owner);
                if (nodeId === undefined) return null;
                return {
                    name: t.name,
                    label: "Send to thread",
                    description: t.description,
                    parameters,
                    executionMode: "sequential" as const,
                    execute: async (_id: string, args: any, signal?: AbortSignal) => {
                        const result = await sendToThreadTool(
                            { ownerUserId: ownerUserId ?? null, workspaceId, nodeId, isAgentRun: false },
                            {
                                nodeId: args?.nodeId, text: args?.text, requestApproval: args?.requestApproval,
                                wait: args?.wait, wake: args?.wake, timeoutMs: args?.timeoutMs,
                            },
                            askUserThreadMessageApprover(piAskUserChannel(opts.requestUserInput, signal)),
                            undefined,
                            { signal },
                        );
                        return { ...result, details: result };
                    },
                };
            }

            case "list_ready_models":
            case "propose_multi_model_plan": {
                // Chat-only, like send_to_thread: a plan's card and its
                // branches belong to the calling thread. Maintenance batches never propose.
                const nodeId = chatNodeOf(opts.owner);
                if (nodeId === undefined || isMaintenanceProfile(opts.toolProfile)) return null;
                return {
                    name: t.name,
                    label: t.name === "list_ready_models" ? "List ready models" : "Propose multi-model plan",
                    description: t.description,
                    parameters,
                    executionMode: "sequential" as const,
                    execute: async (_id: string, args: any, signal?: AbortSignal) => {
                        const caller: MultiModelToolCaller = {
                            ownerUserId: ownerUserId ?? null, workspaceId, nodeId, runtimeSessionId: parentChatId ?? null,
                            turn: opts.getActivePageTurnAttribution?.() ?? null, isAgentRun: false,
                            assistant: !!opts.toolProfile?.assistant, maintenance: false,
                        };
                        const { __tool_use_purpose: _purpose, ...rest } = (args ?? {}) as Record<string, unknown>;
                        const result = t.name === "list_ready_models"
                            ? await listReadyModelsTool(caller)
                            : await proposeMultiModelPlanTool(caller, rest, { signal });
                        return { ...result, details: result };
                    },
                };
            }

            case "list_scheduled_jobs":
            case "create_scheduled_job":
            case "update_scheduled_job":
            case "run_scheduled_job":
            case "delete_scheduled_job": {
                // Chat-only, like send_to_thread: approvals need a watching user.
                const nodeId = chatNodeOf(opts.owner);
                if (nodeId === undefined) return null;
                const toolName = t.name;
                return {
                    name: toolName,
                    label: SCHEDULED_JOB_TOOL_LABELS[toolName],
                    description: t.description,
                    parameters,
                    executionMode: "sequential" as const,
                    execute: async (_id: string, args: any, signal?: AbortSignal) => {
                        const result = await scheduledJobTool(
                            toolName,
                            { ownerUserId: ownerUserId ?? null, workspaceId, nodeId, isAgentRun: false },
                            args,
                            askUserScheduledJobApprover(piAskUserChannel(opts.requestUserInput, signal)),
                        );
                        return { ...result, details: result };
                    },
                };
            }

            case "memory_search":
            case "memory_save":
            case "memory_update":
            case "memory_delete": {
                // Chat-only: the owner, workspace and turn trust come from the calling thread.
                const nodeId = chatNodeOf(opts.owner);
                if (nodeId === undefined) return null;
                const toolName = t.name;
                return {
                    name: toolName,
                    label: MEMORY_TOOL_LABELS[toolName],
                    description: t.description,
                    parameters,
                    ...(toolName === "memory_search" ? {} : { executionMode: "sequential" as const }),
                    execute: async (_id: string, args: any) => {
                        const { __tool_use_purpose: _purpose, ...input } = (args ?? {}) as Record<string, unknown>;
                        const result = memoryTool(toolName, { ownerUserId: ownerUserId ?? null, workspaceId, nodeId, isAgentRun: false }, input);
                        return { ...result, details: result };
                    },
                };
            }

            case "list_artifacts":
            case "search_artifacts":
            case "delete_artifact": {
                // Chat-only, like Memory: the workspace and owner come from the calling thread.
                if (chatNodeOf(opts.owner) === undefined) return null;
                const toolName = t.name;
                return {
                    name: toolName,
                    label: ARTIFACT_TOOL_LABELS[toolName],
                    description: t.description,
                    parameters,
                    ...(toolName === "delete_artifact" ? { executionMode: "sequential" as const } : {}),
                    execute: async (_id: string, args: any, signal?: AbortSignal) => {
                        const { __tool_use_purpose: _purpose, ...input } = (args ?? {}) as Record<string, unknown>;
                        let deleted: DeletedArtifact | undefined;
                        // A delete's own single-use card on the question channel (like a
                        // scheduled job change); without the channel nothing is deleted.
                        const result = await artifactTool(toolName, { ownerUserId: ownerUserId ?? null, workspaceId, cwd }, input, {
                            approve: askUserApprover<ArtifactApprovalRequest>(piAskUserChannel(opts.requestUserInput, signal), "Artifacts"),
                            onDeleted: (value) => { deleted = value; },
                        });
                        // eventMapper reports details.deleted to the thread's stream (artifact_deleted).
                        return { ...result, details: { ...result, ...(deleted ? { deleted } : {}) } };
                    },
                };
            }

            case "read":
                return {
                    name: t.name,
                    label: "Read file",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const call = readSandbox({
                            path: String(args?.path ?? ""),
                            offset: typeof args?.offset === "number" ? args.offset : undefined,
                            limit: typeof args?.limit === "number" ? args.limit : undefined,
                        }, cwd, skillRoots());
                        // Only workspace reads unlock write and edit.
                        return executeRead(call.args, call.root, imageQuota, call.root === cwd ? seenPaths : undefined);
                    },
                };

            case "ls":
                return {
                    name: t.name,
                    label: "List directory",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const call = readSandbox({
                            path: typeof args?.path === "string" ? args.path : undefined,
                            limit: typeof args?.limit === "number" ? args.limit : undefined,
                        }, cwd, skillRoots());
                        return executeLs(call.args, call.root);
                    },
                };

            case "grep":
                return {
                    name: t.name,
                    label: "Search files",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const call = readSandbox({
                            pattern: String(args?.pattern ?? ""),
                            path: typeof args?.path === "string" ? args.path : undefined,
                            glob: typeof args?.glob === "string" ? args.glob : undefined,
                            ignoreCase: typeof args?.ignoreCase === "boolean" ? args.ignoreCase : undefined,
                            literal: typeof args?.literal === "boolean" ? args.literal : undefined,
                            context: typeof args?.context === "number" ? args.context : undefined,
                            limit: typeof args?.limit === "number" ? args.limit : undefined,
                        }, cwd, skillRoots());
                        return executeGrep(call.args, call.root);
                    },
                };

            case "find":
                return {
                    name: t.name,
                    label: "Find files",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) => {
                        const call = readSandbox({
                            pattern: String(args?.pattern ?? ""),
                            path: typeof args?.path === "string" ? args.path : undefined,
                            limit: typeof args?.limit === "number" ? args.limit : undefined,
                        }, cwd, skillRoots());
                        return executeFind(call.args, call.root);
                    },
                };

            case "write":
                return {
                    name: t.name,
                    label: "Write file",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) =>
                        executeWrite(
                            {
                                path: String(args?.path ?? ""),
                                content: typeof args?.content === "string" ? args.content : "",
                            },
                            cwd,
                            seenPaths,
                        ),
                };

            case "edit":
                return {
                    name: t.name,
                    label: "Edit file",
                    description: t.description,
                    parameters,
                    execute: async (_id: string, args: any) =>
                        executeEdit(
                            {
                                path: String(args?.path ?? ""),
                                old_string: typeof args?.old_string === "string" ? args.old_string : "",
                                new_string: typeof args?.new_string === "string" ? args.new_string : "",
                            },
                            cwd,
                            seenPaths,
                        ),
                };

            case "bash":
                return {
                    name: t.name,
                    label: "Run bash",
                    description: t.description,
                    parameters,
                    executionMode: "sequential" as const,
                    execute: async (_id: string, args: any, signal?: AbortSignal) =>
                        executeBash(
                            {
                                command: String(args?.command ?? ""),
                                cwd: typeof args?.cwd === "string" ? args.cwd : undefined,
                                timeoutMs: typeof args?.timeoutMs === "number" ? args.timeoutMs : undefined,
                            },
                            cwd,
                            { ownerUserId, signal },
                        ),
                };
        }
        throw new Error(`unknown builtin tool: ${(t as any).name}`);
    }).filter(Boolean);
    const tools = opts.agentRunTools
        ? [...builtinTools, ...buildPiAgentRunTools(opts.agentRunTools, Type)]
        : builtinTools;
    if (opts.toolProfile?.assistant) {
        if (chatNodeOf(opts.owner) === undefined || !isAssistantWorkspace(opts.workspaceId)) return [];
        const assistantTools = buildPiAssistantTools(opts);
        const names = new Set(assistantTools.map((tool) => tool.name));
        // V keeps Pi's native tools and PI_MAIN_EXTRA beside its catalog
        // (whose Memory tools have the user scope, not this workspace), and
        // nothing else ordinary chats have: no send_to_thread or multi-model
        // plans (they belong to the user's own conversations), no worker job
        // tools.
        const kept = tools.filter((tool) => !names.has(tool.name) && PI_MAIN_KEPT.has(tool.name));
        return withAskUser([...kept, ...assistantTools], opts);
    }
    const worker = runWorkerProfile(opts.owner, opts.toolProfile);
    const withTodo = opts.todoList ? [...tools, buildPiTodoTool(opts.todoList, Type)] : tools;
    return withAskUser(worker ? [...withTodo, buildSubmitAgentResultTool(opts.owner!, worker, Type)] : withTodo, opts);
}

/** Michi's user channel: every catalog offered with one gets ask_user, as on the MCP runtimes. */
function withAskUser(tools: any[], opts: BuildPiToolsOpts): any[] {
    return opts.requestUserInput ? [...tools, buildPiAskUserTool(opts.Type, opts.requestUserInput)] : tools;
}

function runWorkerProfile(owner: RuntimeSessionOwner | undefined,
    profile: RuntimeToolProfile | undefined): RunWorkerToolProfile | null {
    if (!isRunOwner(owner) || !profile || !('runWorkerTools' in profile)) return null;
    if (!profile.allowedToolNames?.includes(SUBMIT_AGENT_RESULT_TOOL)) return null;
    const candidate = profile as RunWorkerToolProfile;
    return typeof candidate.runWorkerTools?.submitAgentResult === 'function' ? candidate : null;
}

function buildSubmitAgentResultTool(owner: RuntimeSessionOwner, profile: RunWorkerToolProfile, Type: any): any {
    return {
        name: SUBMIT_AGENT_RESULT_TOOL,
        label: 'Submit Agent result',
        description: SUBMIT_AGENT_RESULT_DEFINITION.description,
        parameters: paramToTypebox(SUBMIT_AGENT_RESULT_DEFINITION.parameters, Type),
        executionMode: 'sequential' as const,
        execute: async (_id: string, payload: unknown) => {
            profile.runWorkerTools.submitAgentResult(owner, payload);
            return { content: [{ type: 'text', text: 'Agent result submitted.' }], details: { submitted: true } };
        },
    };
}

function buildPiAgentRunTools(invoker: AgentRunToolInvoker, Type: any): any[] {
    return AGENT_RUN_TOOL_NAMES.map((name) => ({
        name,
        label: name.replace(/_/g, ' '),
        description: AGENT_RUN_TOOL_DEFINITIONS[name].description,
        parameters: paramToTypebox(AGENT_RUN_TOOL_DEFINITIONS[name].parameters, Type),
        executionMode: 'sequential' as const,
        execute: async (id: string, args: Record<string, unknown>) => {
            const result = await invoker.invoke(name, args ?? {}, { runtimeToolCallId: id || null });
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        },
    }));
}
