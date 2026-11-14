/**
 * Workspace-global "AI navigation" tools shared by Kiro (via MCP server) and
 * Pi (via in-process AgentTool). Each function returns a structured result —
 * callers wrap it into their runtime's native tool-result shape.
 *
 * The disabled / not-bound / not-found cases are returned as `kind` discriminants
 * rather than thrown errors so callers can render appropriate fallback text
 * without parsing exception messages.
 */

import { buildTopology } from "./topologyBuilder";
import { keywordSearch } from "../routes/search";
import { getDb } from "./db";
import { getAiGlobalContext, getWorkspace } from "./dbRepository";
import { hiddenTemporaryChat, isTemporaryChat } from "./memory/temporaryChat";
import { decodePaneId, isSystemWorkspaceSettings, parseBranchOverviewEntries } from "michi-shared";

export const DISABLED_MESSAGE =
    'AI workspace tools are disabled for this workspace. Ask the user to enable "Let AI navigate this workspace" in Settings if you need to inspect the broader workspace.';

export const NO_WORKSPACE_MESSAGE =
    "No active workspace bound to this session yet.";

/** What a thread or pane tool answers instead, in a temporary chat. */
export const TEMPORARY_CHAT_MESSAGE =
    "This is a temporary chat: it reads neither memory nor other conversations, so nothing was read.";

/**
 * A temporary chat (memory/temporaryChat.ts) reads no memory and no other
 * conversation. Its thread tools (list_threads, search_messages, read_node,
 * read_node_overview, read_conversation_updates) and pane tools on chat panes
 * read only the conversation itself (services/mcpServer.ts,
 * agents/pi/piTools.ts, and the assistant's conversation's in
 * assistant/tools.ts). True when a read by `callerNodeId` is refused:
 * `targetNodeIds` are the conversations it names, none for a tool that lists
 * or searches across them. The other way round, every other reader is kept
 * from a temporary chat: the functions below and pane inspection leave it out
 * of lists and read it as not found (hiddenTemporaryChat).
 */
export function temporaryChatRefuses(callerNodeId: string | null | undefined, targetNodeIds?: readonly string[]): boolean {
    if (!callerNodeId) return false;
    if (targetNodeIds && targetNodeIds.every((nodeId) => nodeId === callerNodeId)) return false;
    return isTemporaryChat(callerNodeId);
}

/** The conversations a pane tool's arguments name: nodeId, a chat pane's paneId, an executionRef's nodeId. */
export function paneArgumentNodeIds(args: unknown): string[] {
    const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const ids: string[] = [];
    if (typeof input.nodeId === "string") ids.push(input.nodeId);
    if (typeof input.paneId === "string") {
        try {
            const target = decodePaneId(input.paneId);
            if (target.kind === "node") ids.push(target.nodeId);
        } catch { /* an invalid paneId is the tool's own error */ }
    }
    const ref = input.executionRef && typeof input.executionRef === "object" ? input.executionRef as Record<string, unknown> : null;
    if (typeof ref?.nodeId === "string") ids.push(ref.nodeId);
    return ids;
}

/**
 * A system workspace (the Michi assistant's) is navigation material only for
 * sessions inside it: other agents can neither list nor read its threads, and
 * search_messages across workspaces leaves it out (routes/search.ts).
 */
function hiddenFrom(sessionWorkspaceId: string, targetWorkspaceId: string): boolean {
    return targetWorkspaceId !== sessionWorkspaceId && isSystemWorkspaceSettings(getWorkspace(targetWorkspaceId)?.settings);
}

export interface ListThreadsResult {
    status: "ok" | "disabled" | "no_workspace";
    text: string;
}

export interface SearchMessagesResult {
    status: "ok" | "disabled" | "no_workspace";
    /** Pre-formatted summary suitable for tool output. */
    text: string;
    matchCount?: number;
}

export interface ReadNodeResult {
    status: "ok" | "disabled" | "no_workspace" | "not_found";
    text: string;
    /** The messages `text` shows whole; a part of a long message is not one of them. */
    shownMessageIds?: string[];
}

/**
 * List trees/nodes in a workspace. Returns the buildTopology output.
 *
 * @param sessionWorkspaceId workspace the calling session is bound to (null if not yet bound).
 * @param ownerUserId        Better-Auth user id of the chat owner. When set (cloud mode) all
 *                           DB reads are scoped to this user's workspaces so an attacker who
 *                           gains chat access cannot read another user's data via this tool.
 * @param targetWorkspaceId  optional override (model passes workspaceId arg). Defaults to session.
 * @param currentNodeId      node currently in focus, marked with > YOU in the output. Other
 *                           conversations' temporary chats are left out (buildTopology).
 * @param options            includeScheduledRuns: also list Scheduled-only jobs' run threads.
 */
export function listThreads(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    targetWorkspaceId?: string,
    currentNodeId?: string,
    options: { includeScheduledRuns?: boolean } = {},
): ListThreadsResult {
    if (!sessionWorkspaceId) {
        return { status: "no_workspace", text: NO_WORKSPACE_MESSAGE };
    }
    if (!getAiGlobalContext(sessionWorkspaceId, ownerUserId ?? undefined)) {
        return { status: "disabled", text: DISABLED_MESSAGE };
    }
    const rawWsId = targetWorkspaceId && targetWorkspaceId.length > 0
        ? targetWorkspaceId
        : sessionWorkspaceId;
    // In cloud mode verify the resolved workspace is owned by ownerUserId.
    // If an attacker passes a foreign workspaceId as targetWorkspaceId, the
    // ownership check here returns [] / no_workspace rather than leaking data.
    // A session without an owner owns nothing.
    let wsId = rawWsId;
    if (process.env.MICHI_CLOUD === "1") {
        const db = getDb();
        const owned = ownerUserId && db
            .prepare("SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?")
            .get(rawWsId, ownerUserId);
        if (!owned) {
            return { status: "no_workspace", text: NO_WORKSPACE_MESSAGE };
        }
    }
    if (hiddenFrom(sessionWorkspaceId, wsId)) {
        return { status: "no_workspace", text: NO_WORKSPACE_MESSAGE };
    }
    const out = buildTopology(getDb(), wsId, currentNodeId, { includeScheduledRuns: options.includeScheduledRuns === true });
    return { status: "ok", text: out.topology };
}

/**
 * Keyword search across workspace messages.
 *
 * @param sessionWorkspaceId workspace the calling session is bound to.
 * @param ownerUserId        Better-Auth user id of the chat owner. When set (cloud mode)
 *                           all FTS results are scoped to this user's workspaces.
 * @param query              non-empty case-insensitive substring.
 * @param scope              "current" (default) restricts to session ws; "all" searches every workspace
 *                           that is not in Trash and lets AI navigate it.
 * @param limit              clamped to 1..50, default 10.
 * @param options            includeScheduledRuns: also search Scheduled-only jobs' run threads.
 *
 * Temporary chats are never searched: a temporary chat's own tools refuse to
 * search (temporaryChatRefuses), and no other reader may find one.
 */
export function searchMessages(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    query: string,
    scope: "current" | "all" = "current",
    limit = 10,
    options: { includeScheduledRuns?: boolean } = {},
): SearchMessagesResult {
    if (!sessionWorkspaceId) {
        return { status: "no_workspace", text: NO_WORKSPACE_MESSAGE };
    }
    if (!getAiGlobalContext(sessionWorkspaceId, ownerUserId ?? undefined)) {
        return { status: "disabled", text: DISABLED_MESSAGE };
    }
    // keywordSearch filters by owner only when it has one.
    if (process.env.MICHI_CLOUD === "1" && !ownerUserId) {
        return { status: "no_workspace", text: NO_WORKSPACE_MESSAGE };
    }
    const trimmed = query.trim();
    if (!trimmed) {
        return { status: "ok", text: "Empty query." };
    }
    const clampedLimit = Math.max(1, Math.min(50, Math.floor(limit) || 10));
    const wsArg = scope === "all" ? undefined : sessionWorkspaceId;
    // Pass ownerUserId so keywordSearch's cloud-mode owner filter applies.
    // Across workspaces, leave out those in Trash and those AI navigation may not read.
    const results = keywordSearch(trimmed, wsArg, clampedLimit, ownerUserId ?? undefined, {
        excludeTemporaryChats: true,
        ...(options.includeScheduledRuns === true ? { includeScheduledRuns: true } : {}),
        ...(wsArg === undefined ? { excludeDeletedWorkspaces: true, excludeNavigationDisabled: true } : {}),
    });
    if (results.length === 0) {
        return {
            status: "ok",
            text: `No matches for "${trimmed}" in ${wsArg ? "current workspace" : "all workspaces"}.`,
            matchCount: 0,
        };
    }
    const formatted = results
        .map((r) => `- [${r.workspace_name} · ${r.node_title ?? "(untitled)"}] (node: ${r.node_id}) ${r.role}: ${r.snippet}`)
        .join("\n");
    return {
        status: "ok",
        text: `Found ${results.length} match${results.length === 1 ? "" : "es"}:\n${formatted}\n\nUse read_node(nodeId) to read a specific node's transcript.`,
        matchCount: results.length,
    };
}

/**
 * What one read_node answer shows of message text, in characters (UTF-16
 * units, as String.length counts them). Every runtime's tool shares it: large
 * enough for most threads, small enough for typical tool-result limits.
 */
const READ_NODE_SIZE_CAP = 12 * 1024;

export interface ReadNodeOpts {
    role?: "user" | "assistant";
    from?: "head" | "tail";
    offset?: number;
    limit?: number;
    /** Label each message with its id ("assistant [message a-1]: …"), so a reader can cite that message. */
    messageIds?: boolean;
    /** Read on in this one message (a part ends with where to continue); the other options do not apply. */
    messageId?: string;
    /** Where in `messageId` to start, in characters. Default 0. */
    charOffset?: number;
}

type NodeInfoRow = { id: string; workspace_id: string; title: string | null; kind: string; branch_overview?: string | null };

/** Shared node lookup with cloud-mode ownership enforcement. */
function lookupNode(
    db: ReturnType<typeof getDb>,
    trimmedId: string,
    ownerUserId: string | null | undefined,
): NodeInfoRow | undefined {
    if (process.env.MICHI_CLOUD === "1") {
        if (!ownerUserId) return undefined;
        return db
            .prepare(
                "SELECT n.id, n.workspace_id, n.title, n.kind, n.branch_overview FROM nodes n " +
                "JOIN workspaces w ON n.workspace_id = w.id " +
                "WHERE n.id = ? AND n.deleted_at IS NULL AND w.owner_user_id = ?",
            )
            .get(trimmedId, ownerUserId) as unknown as NodeInfoRow | undefined;
    }
    return db
        .prepare("SELECT id, workspace_id, title, kind, branch_overview FROM nodes WHERE id = ? AND deleted_at IS NULL")
        .get(trimmedId) as unknown as NodeInfoRow | undefined;
}

/**
 * Shared access-control preamble for node-reading tools. `readerNodeId` is the
 * calling conversation (null: none): another conversation's temporary chat
 * reads as not found.
 */
function validateNodeAccess(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    nodeId: string,
    readerNodeId: string | null | undefined,
): { error: ReadNodeResult } | { trimmedId: string; db: ReturnType<typeof getDb>; nodeRow: NodeInfoRow } {
    if (!sessionWorkspaceId) {
        return { error: { status: "no_workspace", text: NO_WORKSPACE_MESSAGE } };
    }
    if (!getAiGlobalContext(sessionWorkspaceId, ownerUserId ?? undefined)) {
        return { error: { status: "disabled", text: DISABLED_MESSAGE } };
    }
    const trimmedId = nodeId.trim();
    if (!trimmedId) {
        return { error: { status: "not_found", text: "nodeId is required." } };
    }
    const db = getDb();
    const nodeRow = lookupNode(db, trimmedId, ownerUserId);
    if (!nodeRow || hiddenFrom(sessionWorkspaceId, nodeRow.workspace_id) || hiddenTemporaryChat(readerNodeId, nodeRow.id)) {
        return { error: { status: "not_found", text: `node not found: ${trimmedId}` } };
    }
    return { trimmedId, db, nodeRow };
}

/**
 * The whole messages of `window` that fit in `cap` characters, kept from its
 * newest or its oldest end. When the first one to keep alone exceeds the cap,
 * it is the `part` to show the beginning of.
 */
function fitTranscript<T extends { content: string }>(window: T[], cap: number, keep: "newest" | "oldest"): { kept: T[]; part?: T } {
    const ordered = keep === "newest" ? [...window].reverse() : window;
    const kept: T[] = [];
    let total = 0;
    for (const message of ordered) {
        if (total + message.content.length > cap) break;
        total += message.content.length;
        kept.push(message);
    }
    if (keep === "newest") kept.reverse();
    return kept.length === 0 && ordered.length > 0 ? { kept, part: ordered[0] } : { kept };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** At most `maxChars` of `text` from `start`, never splitting a surrogate pair. */
function sliceChars(text: string, start: number, maxChars: number): { text: string; start: number; end: number } {
    let from = Math.max(0, Math.min(Math.floor(start), text.length));
    if (from > 0 && isHighSurrogate(text.charCodeAt(from - 1)) && isLowSurrogate(text.charCodeAt(from))) from -= 1;
    let end = Math.min(text.length, from + maxChars);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    return { text: text.slice(from, end), start: from, end };
}

const continueInMessage = (messageId: string, end: number) =>
    `Continue with messageId "${messageId}" and charOffset ${end}`;

/**
 * Read a node's branch overview journal — lightweight chronological summary.
 * `readerNodeId`: the calling conversation, as for readNode.
 */
export function readNodeOverview(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    nodeId: string,
    readerNodeId?: string | null,
): ReadNodeResult {
    const access = validateNodeAccess(sessionWorkspaceId, ownerUserId, nodeId, readerNodeId);
    if ("error" in access) return access.error;
    const { trimmedId, db, nodeRow } = access;

    const entries = parseBranchOverviewEntries(nodeRow.branch_overview ?? null);
    const msgRow = db
        .prepare("SELECT COUNT(*) as cnt FROM messages WHERE node_id = ? AND role IN ('user','assistant')")
        .get(trimmedId) as unknown as { cnt: number };
    const msgCount = msgRow.cnt;

    if (entries.length === 0) {
        return {
            status: "ok",
            text: `# ${nodeRow.title ?? "(untitled)"} (${trimmedId}) — ${msgCount} messages\n\nNo overview entries recorded.`,
        };
    }

    const lines = entries.map((e) => {
        const date = e.at > 0
            ? new Date(e.at).toISOString().replace("T", " ").slice(0, 19)
            : "(legacy)";
        return `[${date}] ${e.text}`;
    });

    return {
        status: "ok",
        text: `# ${nodeRow.title ?? "(untitled)"} (${trimmedId}) — ${msgCount} messages\n\n${lines.join("\n")}`,
    };
}

/**
 * Read a node's transcript. `readerNodeId` is the calling conversation (none:
 * an Agent Run, a Home run): a temporary chat is found only by itself.
 */
export function readNode(
    sessionWorkspaceId: string | null,
    ownerUserId: string | null | undefined,
    nodeId: string,
    opts?: ReadNodeOpts,
    readerNodeId?: string | null,
): ReadNodeResult {
    const access = validateNodeAccess(sessionWorkspaceId, ownerUserId, nodeId, readerNodeId);
    if ("error" in access) return access.error;
    const { trimmedId, db, nodeRow } = access;

    const role = opts?.role;
    const from = opts?.from ?? "tail";
    const offset = Math.max(1, opts?.offset ?? 1);
    const requestedLimit = opts?.limit;
    const line = (m: { id: string; role: string; content: string }, cited?: ReadonlySet<string>) =>
        opts?.messageIds || cited?.has(m.id) ? `${m.role} [message ${m.id}]: ${m.content}` : `${m.role}: ${m.content}`;
    // Only messages actually included below can be cited. The node has already passed ownership and visibility checks.
    const withPageSources = (visible: Array<{ id: string; role: string }>, render: (cited?: ReadonlySet<string>) => string): string => {
        const text = render();
        const ids = visible.filter(message => message.role === 'assistant').slice(-20).map(message => message.id);
        if (!ids.length) return text;
        const sources = db.prepare(`SELECT t.node_id AS nodeId,t.turn_id AS turnId,t.assistant_message_id AS assistantId
          FROM turns t JOIN messages m ON m.id=t.assistant_message_id AND m.node_id=t.node_id
          JOIN nodes n ON n.id=t.node_id
          WHERE n.id=? AND n.workspace_id=? AND n.deleted_at IS NULL AND n.purged_at IS NULL
          AND m.role='assistant' AND t.assistant_message_id IN (${ids.map(() => '?').join(',')})
          ORDER BY t.started_at DESC LIMIT 20`).all(trimmedId, nodeRow.workspace_id, ...ids) as unknown as Array<{ nodeId: string; turnId: string; assistantId: string }>;
        const budget = Math.min(2_048, READ_NODE_SIZE_CAP - text.length);
        if (budget <= 0) return text;
        const shown: typeof sources = [];
        for (const source of sources) {
            const candidate = [...shown, source];
            const labels = new Set(candidate.map(entry => entry.assistantId));
            if (JSON.stringify(candidate).length + 100 > budget || render(labels).length + JSON.stringify(candidate).length + 100 > READ_NODE_SIZE_CAP) break;
            shown.push(source);
        }
        return shown.length ? `${render(new Set(shown.map(source => source.assistantId)))}\n\nPage source references (exact assistant messages shown above): ${JSON.stringify(shown)}` : text;
    };

    const header = `# ${nodeRow.title ?? "(untitled)"} (${trimmedId})`;
    if (opts?.messageId) {
        const message = db
            .prepare("SELECT id, role, content FROM messages WHERE node_id = ? AND id = ? AND role IN ('user', 'assistant')")
            .get(trimmedId, opts.messageId) as unknown as { id: string; role: string; content: string } | undefined;
        if (!message) return { status: "not_found", text: `message not found in ${trimmedId}: ${opts.messageId}` };
        const page = sliceChars(message.content, opts.charOffset ?? 0, READ_NODE_SIZE_CAP);
        const whole = page.start === 0 && page.end === message.content.length;
        const lines = [`${message.role} [message ${message.id}]: ${page.text}`];
        if (page.end < message.content.length) lines.push(`[${continueInMessage(message.id, page.end)}]`);
        return {
            status: "ok",
            shownMessageIds: whole ? [message.id] : [],
            text: `${header} — message ${message.id}, characters ${page.start}-${page.end} of ${message.content.length}\n\n${lines.join("\n\n")}`,
        };
    }

    // SQL query with optional role filter.
    const roleFilter = role ? " AND role = ?" : "";
    const params: Array<string> = [trimmedId];
    if (role) params.push(role);
    const messages = db
        .prepare(
            `SELECT id, role, content FROM messages WHERE node_id = ?` +
            ` AND role IN ('user', 'assistant')${roleFilter}` +
            ` ORDER BY seq ASC`,
        )
        .all(...params) as unknown as Array<{ id: string; role: string; content: string }>;

    const totalCount = messages.length;
    // The window: offset 1 is the newest message from the tail, the oldest
    // from the head. The cap then keeps the end the reader starts from.
    const tail = from === "tail";
    const end = tail ? Math.max(0, totalCount - (offset - 1)) : (requestedLimit ? offset - 1 + requestedLimit : totalCount);
    const start = tail ? (requestedLimit ? Math.max(0, end - requestedLimit) : 0) : offset - 1;
    const window = messages.slice(start, end);
    const { kept, part } = fitTranscript(window, READ_NODE_SIZE_CAP, tail ? "newest" : "oldest");
    const shown = kept.length + (part ? 1 : 0);
    const omitted = window.length - shown;
    const nextOffset = offset - 1 + shown < totalCount ? offset + shown : null;
    const firstShown = tail ? end - shown + 1 : start + 1;
    const partLines: string[] = [];
    if (part) {
        const page = sliceChars(part.content, 0, READ_NODE_SIZE_CAP);
        partLines.push(`${part.role} [message ${part.id}]: ${page.text}`,
            `[message ${part.id} has ${part.content.length} characters; this shows the first ${page.end}. ${continueInMessage(part.id, page.end)}]`);
    }
    const omittedLine = omitted > 0
        ? `[${omitted} ${tail ? "earlier" : "later"} message${omitted === 1 ? "" : "s"} omitted by the size cap; continue with offset ${nextOffset}]`
        : null;
    const roleDesc = role ? ` (${role} only)` : "";
    const positions = shown > 0
        ? ` (messages ${firstShown}-${firstShown + shown - 1} of ${totalCount}${nextOffset ? `; continue with offset ${nextOffset}` : ""})`
        : "";
    const title = `${header} — ${totalCount} messages${roleDesc}, from ${from}, offset ${offset}, showing ${shown}/${totalCount}${positions}`;
    return { status: "ok", shownMessageIds: kept.map(message => message.id), text: withPageSources(kept, cited => {
        const lines = [...kept.map(message => line(message, cited)), ...partLines];
        if (omittedLine) {
            if (tail) lines.unshift(omittedLine);
            else lines.push(omittedLine);
        }
        return `${title}\n\n${lines.join("\n\n")}`;
    }) };
}
