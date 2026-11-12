/**
 * Agent tools for the workspace's Artifacts: list_artifacts, search_artifacts
 * and delete_artifact. Registered for chat threads on every runtime (MCP for
 * Kiro/Claude/Codex/Crew, built-in tools for Pi); never for Agent Runs, the
 * Michi assistant or background maintenance (which may only list and search,
 * through maintenance_call_tool).
 *
 * Boundaries enforced here, independent of runtime permission modes:
 *  - The workspace and owner come from the session binding, never from tool
 *    arguments. In cloud mode a session without a signed-in user reads
 *    nothing, and another owner's workspace reads as not found.
 *  - search reads document bodies only for embedded `doc` artifacts whose
 *    file lies in a `.contexts/` folder and resolves, symlinks followed,
 *    inside its workspace folder, and only up to fixed file and byte budgets
 *    per call. The workspace folders are the session's working folder and
 *    the workspace's own on the desktop; in cloud mode only the workspace's
 *    sandbox, derived from the owner (the workspace row's cwd is a client
 *    string there), which must be the owner's own directory with a real
 *    `.contexts` (no symlink to another sandbox), and never a file with a
 *    second name (a hardlink) or, on Linux, one the kernel opened outside
 *    the sandbox.
 *  - delete removes the artifact's registration (its `contexts` row), as the
 *    Artifacts drawer's Delete does. It never deletes the file: a registered
 *    file is the user's own, and a document stays in `.contexts/`.
 *  - delete asks the user first, every time, through its own single-use card
 *    (agents/hostApproval.ts), like the scheduled job changes: on every
 *    runtime (Codex approves Michi's MCP tools itself, so a runtime prompt
 *    would not reach the user there) and in every permission mode. Trust,
 *    YOLO, grants and session trust never answer it; a decline, no answer or
 *    no user to ask deletes nothing.
 *
 * list and search run without a prompt (agents/permissionPolicy.ts), and so
 * does delete at the runtime level, since its own card is the approval. The
 * caller reports a deletion to the thread's stream (artifact_deleted) so open
 * windows drop the artifact.
 */

import fs from "fs";
import path from "path";
import { artifactTypeForPath } from "michi-shared";
import { deleteContextAtomically, getWorkspace, listContexts, type ContextRow } from "../services/dbRepository";
import { resolveWorkspaceRegularFile } from "../services/workspaceFiles";
import { NotFoundError, verifySandbox } from "../services/workspaceSandbox";
import { normalizeWorkspaceCwd } from "./tools/pathSandbox";
import type { ArtifactToolName } from "./artifactToolNames";
import type { HostApprovalRequest, HostApprovalResult, HostApprover } from "./hostApproval";
import type { ExtraContext } from "./types";

/** Session-bound identity of the calling thread. Never sourced from tool arguments. */
export interface ArtifactToolCaller {
  /** The session's user; scopes every read and the delete in cloud mode. */
  ownerUserId: string | null;
  workspaceId: string | null;
  /**
   * The session's working directory, where save_artifact writes `.contexts/`.
   * On the desktop searched before the workspace's own folder; cloud mode
   * searches the workspace's sandbox instead (see bodyRoots).
   */
  cwd?: string | null;
}

export interface ArtifactToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

/** What a successful delete_artifact removed: the artifact_deleted event's payload. */
export interface DeletedArtifact {
  contextId: string;
  name: string;
}

/** delete_artifact's card. */
export interface ArtifactApprovalRequest extends HostApprovalRequest {
  toolName: "delete_artifact";
  artifactName: string;
}

export interface ArtifactToolHooks {
  /**
   * Asks the user to approve one deletion (askUserApprover over the session's
   * ask_user channel, or Pi's single-use prompt). Absent: nothing is deleted.
   */
  approve?: HostApprover<ArtifactApprovalRequest>;
  /** Called once the registration is gone, before the result is returned. */
  onDeleted?: (deleted: DeletedArtifact) => void;
}

const ARTIFACT_TYPES = ["doc", "file", "image", "link"] as const;
type ArtifactType = typeof ARTIFACT_TYPES[number];

// The catalog entries (builtinTools.ts) state these limits.
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_QUERY_MAX_CHARS = 200;
/** Keywords past this many are ignored. */
const SEARCH_MAX_TERMS = 8;
/** Document bodies one search reads at most. */
export const SEARCH_MAX_FILES_READ = 100;
/** Bytes read from one document; the rest of a longer one is not searched. */
export const SEARCH_MAX_BYTES_PER_FILE = 256 * 1024;
/** Bytes read from all documents in one search. */
const SEARCH_MAX_BYTES_TOTAL = 2 * 1024 * 1024;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 100;
const CONTEXTS_DIR = ".contexts";

class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function errorResult(code: string, message: string): ArtifactToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

function jsonResult(value: Record<string, unknown>): ArtifactToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// ── Session ──────────────────────────────────────────────────────────────────

interface ArtifactSession {
  workspaceId: string;
  /** Passed to the repository: scopes its queries to this owner in cloud mode. */
  userId: string | undefined;
  /** The session's working directory, as the caller gave it. */
  sessionCwd: string | null;
  /** The workspace row's folder: a client-supplied string, trusted on the desktop only. */
  workspaceCwd: string | null;
}

function session(caller: ArtifactToolCaller): ArtifactSession {
  const cloud = process.env.MICHI_CLOUD === "1";
  if (cloud && !caller.ownerUserId) throw new ToolError("UNAVAILABLE", "this session has no signed-in user");
  if (!caller.workspaceId) throw new ToolError("SOURCE_UNAVAILABLE", "this session is not bound to a workspace");
  const userId = caller.ownerUserId ?? undefined;
  const workspace = getWorkspace(caller.workspaceId, userId);
  if (!workspace) throw new ToolError("NOT_FOUND", "this session's workspace was not found");
  return {
    workspaceId: workspace.id,
    userId,
    sessionCwd: caller.cwd?.trim() || null,
    workspaceCwd: workspace.cwd?.trim() || null,
  };
}

/**
 * Folders whose `.contexts/` may hold the documents, in order. In cloud mode
 * only the workspace's sandbox, derived from the owner as every cloud file
 * route does (workspaceFiles.resolveWorkspaceFileRoot): the workspace row's
 * cwd is whatever a client stored, so it could name another user's sandbox.
 * save_artifact writes there too, since cloud sessions run in that sandbox.
 * The sandbox must be the owner's own directory on disk
 * (verifySandbox), and its `.contexts` a real folder: the agent's
 * shell runs in the sandbox, so it could swap either for a symlink into
 * another user's sandbox, which the real-path checks below would then accept.
 * In cloud mode the boundary is the sandbox's real path as verified here,
 * fixed for the whole search: either could be swapped after this check,
 * and resolving the root again per document would follow the swap.
 * On the desktop, the session's working directory (where save_artifact
 * writes), then the workspace's own folder (a session running elsewhere),
 * normalized as the session routes normalize a cwd; each root's boundary is
 * its own real path, resolved when a document is read.
 */
interface BodyRoot {
  root: string;
  /** The verified real path every opened document must lie inside (cloud mode). */
  boundary?: string;
}

function bodyRoots(s: ArtifactSession): BodyRoot[] {
  if (process.env.MICHI_CLOUD === "1") {
    if (!s.userId) return [];
    try {
      const { dir, realDir } = verifySandbox(s.userId, s.workspaceId);
      return isSymlink(path.join(dir, CONTEXTS_DIR)) ? [] : [{ root: dir, boundary: realDir }];
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
  }
  return [...new Set([s.sessionCwd, s.workspaceCwd]
    .filter((root): root is string => !!root)
    .map((root) => normalizeWorkspaceCwd(root)))]
    .map((root) => ({ root }));
}

/** A missing path is not a symlink; one that cannot be checked counts as one. */
function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function workspaceArtifacts(s: ArtifactSession): ContextRow[] {
  return listContexts(s.workspaceId, s.userId);
}

// ── Views ────────────────────────────────────────────────────────────────────

function typeOf(row: ContextRow): ArtifactType {
  if ((ARTIFACT_TYPES as readonly string[]).includes(row.type ?? "")) return row.type as ArtifactType;
  return row.url ? "link" : artifactTypeForPath(row.file_path);
}

function isPinned(row: ContextRow): boolean {
  return typeof row.pinned_at === "number";
}

/** Pinned first (most recently pinned first), then most recently updated; name breaks ties. */
function compareArtifacts(a: ContextRow, b: ContextRow): number {
  const ap = isPinned(a);
  const bp = isPinned(b);
  if (ap !== bp) return ap ? -1 : 1;
  if (ap && bp && a.pinned_at !== b.pinned_at) return (b.pinned_at as number) - (a.pinned_at as number);
  if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

const MANIFEST_KINDS: ReadonlySet<string> = new Set(["embedded", "reference", "symlink"]);

/**
 * The whole artifact manifest of a first message, for a session that cannot
 * list or search artifacts (canLookUpArtifacts; a primary Agent's
 * allow-list leaves the tools out): the workspace's artifacts as stored,
 * pinned first (most recently pinned first), then the most recently
 * updated, at most `max`, in the shape a client without artifactCount sends.
 * The entries the client sent (its pinned ones, already in that order) lead,
 * so one the database has not received yet is still named; a stored one of
 * the same name is not named twice. `userId` scopes the read in cloud mode.
 */
export function workspaceArtifactManifest(
  workspaceId: string,
  userId: string | undefined,
  sent: readonly ExtraContext[],
  max: number,
): ExtraContext[] {
  const named = new Set(sent.map((entry) => entry.name));
  const stored = listContexts(workspaceId, userId)
    .filter((row) => !named.has(row.name))
    .sort(compareArtifacts)
    .map((row): ExtraContext => ({
      name: row.name,
      filePath: row.file_path,
      ...(row.url ? { url: row.url } : {}),
      ...(row.kind && MANIFEST_KINDS.has(row.kind) ? { kind: row.kind as ExtraContext["kind"] } : {}),
    }));
  return [...sent, ...stored].slice(0, max);
}

function artifactView(row: ContextRow): Record<string, unknown> {
  return {
    name: row.name,
    type: typeOf(row),
    ...(row.url ? { url: row.url } : { filePath: row.file_path }),
    ...(row.kind ? { kind: row.kind } : {}),
    pinned: isPinned(row),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(typeof row.size === "number" ? { size: row.size } : {}),
  };
}

// ── Arguments ────────────────────────────────────────────────────────────────

function integerArg(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolError("INVALID_ARGUMENT", `${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function typeArg(value: unknown): ArtifactType | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(ARTIFACT_TYPES as readonly string[]).includes(value)) {
    throw new ToolError("INVALID_ARGUMENT", "type must be doc, file, image or link");
  }
  return value as ArtifactType;
}

function pinnedArg(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolError("INVALID_ARGUMENT", "pinned must be true or false");
  return value;
}

/** The artifact's @name, with or without its @. */
function nameArg(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/^@/, "").trim() : "";
  if (!name) throw new ToolError("INVALID_ARGUMENT", "name is required: the artifact's @name from list_artifacts or search_artifacts");
  return name;
}

// ── Tool entry point ─────────────────────────────────────────────────────────

/** Runs one artifact tool call for the calling thread. Unexpected failures (the database) throw. */
export async function artifactTool(
  name: ArtifactToolName,
  caller: ArtifactToolCaller,
  rawArgs: unknown,
  hooks: ArtifactToolHooks = {},
): Promise<ArtifactToolResult> {
  const args = asRecord(rawArgs);
  try {
    const s = session(caller);
    switch (name) {
      case "list_artifacts": return listTool(s, args);
      case "search_artifacts": return searchTool(s, args);
      case "delete_artifact": return await deleteTool(s, caller, args, hooks);
    }
  } catch (error) {
    if (error instanceof ToolError) return errorResult(error.code, error.message);
    throw error;
  }
}

function listTool(s: ArtifactSession, args: Record<string, unknown>): ArtifactToolResult {
  const type = typeArg(args.type);
  const pinned = pinnedArg(args.pinned);
  const limit = integerArg(args.limit, "limit", 1, LIST_MAX_LIMIT, LIST_DEFAULT_LIMIT);
  const offset = integerArg(args.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
  const all = workspaceArtifacts(s);
  const matching = all
    .filter((row) => (type === undefined || typeOf(row) === type) && (pinned === undefined || isPinned(row) === pinned))
    .sort(compareArtifacts);
  const page = matching.slice(offset, offset + limit);
  const next = offset + page.length;
  const filtered = type !== undefined || pinned !== undefined;
  return jsonResult({
    total: matching.length,
    ...(filtered ? { workspaceTotal: all.length } : {}),
    offset,
    count: page.length,
    nextOffset: next < matching.length ? next : null,
    artifacts: page.map(artifactView),
    ...(matching.length === 0
      ? { note: filtered ? "No artifact matches these filters." : "This workspace has no artifacts." }
      : { note: "Reference an artifact as @name. Read a file artifact with your filesystem tools; a link artifact is its url." }),
  });
}

// ── search_artifacts ─────────────────────────────────────────────────────────

type MatchField = "name" | "path" | "url" | "body";

interface SearchMatch {
  row: ContextRow;
  matchedIn: MatchField[];
  snippet?: string;
}

interface BodyBudget {
  filesRead: number;
  bytesRead: number;
  /** Documents whose body was not searched because a budget was spent. */
  skipped: number;
  /** Documents searched only in part (longer than SEARCH_MAX_BYTES_PER_FILE). */
  partial: number;
}

function queryTerms(value: unknown): string[] {
  const query = typeof value === "string" ? value.trim() : "";
  if (!query) throw new ToolError("INVALID_ARGUMENT", "query must be one or more keywords");
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new ToolError("INVALID_ARGUMENT", `query must be at most ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, SEARCH_MAX_TERMS);
}

/**
 * An embedded document's workspace-relative path, `.contexts/<file>`: the
 * only files search opens. Every segment after `.contexts/` must be a plain
 * name, so the path stays inside that folder before symlinks are resolved.
 */
function searchableBodyPath(row: ContextRow): string | null {
  if (typeOf(row) !== "doc" || row.url) return null;
  if (row.kind === "reference" || row.kind === "symlink") return null;
  const prefix = `${CONTEXTS_DIR}/`;
  const filePath = row.file_path.replace(/^\.\//, "");
  if (!filePath.startsWith(prefix)) return null;
  const segments = filePath.slice(prefix.length).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return filePath;
}

/**
 * The document file in the first root that holds it; null when none does.
 * The path is resolved against the root itself, so the root's real path is
 * the boundary: a `.contexts` that is a symlink out of the workspace, or a
 * document that is one, is refused rather than becoming the boundary.
 * `realRoot` is that boundary, for the check after opening: in cloud mode the
 * one verified before the search (bodyRoots), which the resolved document
 * must already lie inside.
 */
function documentFile(roots: readonly BodyRoot[], relative: string): { realPath: string; stat: fs.Stats; realRoot: string } | null {
  for (const { root, boundary } of roots) {
    try {
      const file = resolveWorkspaceRegularFile(relative, root);
      if (boundary !== undefined) {
        if (!isInside(file.realPath, boundary)) continue;
        return { ...file, realRoot: boundary };
      }
      return { ...file, realRoot: fs.realpathSync(root) };
    } catch {
      // Not there, not a regular file, or it leads out of that workspace folder.
    }
  }
  return null;
}

/** O_NOFOLLOW where the platform has it: a final component swapped for a symlink fails to open. */
const OPEN_NO_FOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * The path the kernel opened `fd` at, from /proc (Linux); null where there
 * is no /proc (macOS). Any other failure throws, so nothing is read.
 */
function openedPath(fd: number): string | null {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * In cloud mode, whether the opened document is one this owner may read.
 * The inode check before it compares the file the path names at check time
 * with the one opened, but both lookups follow a directory on the way that
 * was swapped for a symlink in between (O_NOFOLLOW covers only the last
 * name), and a hardlink is the very inode: a second name for another user's
 * file passes it. So a file with more than one name is refused, and on
 * Linux the path the kernel opened must lie inside the sandbox as verified
 * before the search; on Linux a /proc that cannot be read refuses the file.
 * Elsewhere (macOS has no /proc) the checks before stand alone; cloud mode
 * runs on Linux.
 */
function cloudOpenAllowed(fd: number, opened: fs.Stats, realRoot: string): boolean {
  if (opened.nlink > 1) return false;
  const kernelPath = openedPath(fd);
  if (kernelPath === null) return process.platform !== "linux";
  return isInside(kernelPath, realRoot);
}

/** The document's text, within the budgets; null when it cannot be read or the budget is spent. */
function readBody(roots: readonly BodyRoot[], relative: string, budget: BodyBudget): string | null {
  if (roots.length === 0) return null;
  if (budget.filesRead >= SEARCH_MAX_FILES_READ || budget.bytesRead >= SEARCH_MAX_BYTES_TOTAL) {
    budget.skipped++;
    return null;
  }
  const file = documentFile(roots, relative);
  if (!file) return null;
  let fd: number | undefined;
  try {
    const { realPath, stat, realRoot } = file;
    fd = fs.openSync(realPath, OPEN_NO_FOLLOW);
    // The file opened must be the one checked: a path swapped after the
    // check (a directory on it replaced by a symlink) opens another inode.
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return null;
    if (process.env.MICHI_CLOUD === "1" && !cloudOpenAllowed(fd, opened, realRoot)) return null;
    const length = Math.min(opened.size, SEARCH_MAX_BYTES_PER_FILE, SEARCH_MAX_BYTES_TOTAL - budget.bytesRead);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    budget.filesRead++;
    budget.bytesRead += read;
    if (read < opened.size) budget.partial++;
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function snippetAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_BEFORE);
  const end = Math.min(text.length, index + length + SNIPPET_AFTER);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function matchArtifact(roots: () => readonly BodyRoot[], row: ContextRow, terms: string[], budget: BodyBudget): SearchMatch | null {
  const fields: Array<[MatchField, string]> = [
    ["name", row.name.toLowerCase()],
    ...(row.url ? [["url", row.url.toLowerCase()] as [MatchField, string]] : []),
    ...(row.file_path ? [["path", row.file_path.toLowerCase()] as [MatchField, string]] : []),
  ];
  const fieldsWith = (term: string) => fields.filter(([, value]) => value.includes(term)).map(([field]) => field);
  const missing = terms.filter((term) => fieldsWith(term).length === 0);
  const matchedIn = new Set<MatchField>(terms.flatMap(fieldsWith));
  if (missing.length === 0) return { row, matchedIn: [...matchedIn] };
  const relative = searchableBodyPath(row);
  if (!relative) return null;
  const body = readBody(roots(), relative, budget);
  if (body === null) return null;
  const lower = body.toLowerCase();
  if (!missing.every((term) => lower.includes(term))) return null;
  const first = missing.map((term) => ({ term, at: lower.indexOf(term) })).sort((a, b) => a.at - b.at)[0];
  matchedIn.add("body");
  return { row, matchedIn: [...matchedIn], snippet: snippetAt(body, first.at, first.term.length) };
}

/** Name matches first, then path or url, then document text; pinned and recent first within each. */
function matchRank(match: SearchMatch): number {
  if (match.matchedIn.includes("name")) return 0;
  return match.matchedIn.includes("body") ? 2 : 1;
}

function searchTool(s: ArtifactSession, args: Record<string, unknown>): ArtifactToolResult {
  const terms = queryTerms(args.query);
  const limit = integerArg(args.limit, "limit", 1, SEARCH_MAX_LIMIT, SEARCH_DEFAULT_LIMIT);
  const budget: BodyBudget = { filesRead: 0, bytesRead: 0, skipped: 0, partial: 0 };
  // Resolved once, and only when a document's text is needed.
  let roots: BodyRoot[] | undefined;
  const rootsOnce = () => (roots ??= bodyRoots(s));
  // Pinned and recent documents are read first, so a spent budget skips the least likely ones.
  const rows = workspaceArtifacts(s).sort(compareArtifacts);
  const matches = rows
    .map((row) => matchArtifact(rootsOnce, row, terms, budget))
    .filter((match): match is SearchMatch => match !== null)
    .sort((a, b) => matchRank(a) - matchRank(b) || compareArtifacts(a.row, b.row));
  const shown = matches.slice(0, limit);
  const bodySearch = budget.skipped > 0 || budget.partial > 0
    ? { bodySearch: {
        documentsRead: budget.filesRead,
        documentsSkipped: budget.skipped,
        documentsReadInPart: budget.partial,
        note: "Michi reads a bounded amount of document text per search: some documents were not searched, or only in part. Add more specific keywords, or use list_artifacts and read the files.",
      } }
    : {};
  return jsonResult({
    query: terms.join(" "),
    total: matches.length,
    count: shown.length,
    artifacts: shown.map((match) => ({
      ...artifactView(match.row),
      matchedIn: match.matchedIn,
      ...(match.snippet ? { snippet: match.snippet } : {}),
    })),
    ...bodySearch,
    ...(matches.length === 0
      ? { next: "Nothing matched: every keyword must appear in an artifact's name, path or link, or in a document's text. Try fewer or different keywords, or browse with list_artifacts." }
      : {}),
  });
}

// ── delete_artifact ──────────────────────────────────────────────────────────

/** The one artifact this name names: exactly, else ignoring case. */
function namedArtifact(s: ArtifactSession, name: string): ContextRow {
  const rows = workspaceArtifacts(s);
  const exact = rows.filter((row) => row.name === name);
  const candidates = exact.length > 0 ? exact : rows.filter((row) => row.name.toLowerCase() === name.toLowerCase());
  if (candidates.length === 0) {
    throw new ToolError("NOT_FOUND", `this workspace has no artifact named @${name}. Find its exact name with list_artifacts or search_artifacts.`);
  }
  if (candidates.length > 1) {
    throw new ToolError("AMBIGUOUS", `@${name} matches ${candidates.length} artifacts (${candidates.map((row) => `@${row.name}`).join(", ")}); pass the exact name.`);
  }
  return candidates[0];
}

const TYPE_LABELS: Record<ArtifactType, string> = { doc: "Document", file: "File", image: "Image", link: "Link" };

/** What the card shows: which artifact, where it points, and what deleting it does. */
function deleteLines(row: ContextRow): string[] {
  return [
    `Type: ${TYPE_LABELS[typeOf(row)]}${isPinned(row) ? " (pinned)" : ""}`,
    row.url ? `Link: ${row.url}` : `File: ${row.file_path}`,
    row.url
      ? "Removes it from this workspace's Artifacts; it can no longer be @-mentioned."
      : "Removes it from this workspace's Artifacts; it can no longer be @-mentioned. The file itself is not deleted.",
  ];
}

function notDeleted(approval: Exclude<HostApprovalResult, { approved: true }>, name: string): ArtifactToolResult {
  if (approval.reason === "unavailable") {
    return errorResult("APPROVAL_UNAVAILABLE", `this session cannot ask the user to confirm a deletion; @${name} was not deleted`);
  }
  return jsonResult({
    status: "not_deleted",
    reason: approval.reason,
    artifact: name,
    ...(approval.note ? { userNote: approval.note } : {}),
    next: approval.reason === "no_answer"
      ? `The user did not answer; @${name} was not deleted. Do not retry unless the user asks.`
      : `The user declined; @${name} was not deleted. Do not retry unless the user asks.`,
  });
}

/** Whether the artifact differs from the card's: its name, type, file or link (deleteLines), or any later save. */
function changedSinceCard(shown: ContextRow, current: ContextRow): boolean {
  return current.name !== shown.name
    || typeOf(current) !== typeOf(shown)
    || current.file_path !== shown.file_path
    || (current.url ?? null) !== (shown.url ?? null)
    || current.updated_at !== shown.updated_at;
}

async function deleteTool(
  s: ArtifactSession, caller: ArtifactToolCaller, args: Record<string, unknown>, hooks: ArtifactToolHooks,
): Promise<ArtifactToolResult> {
  const row = namedArtifact(s, nameArg(args.name));
  // Every deletion is the user's own decision, whatever the permission mode.
  const approval = hooks.approve
    ? await hooks.approve({
        toolName: "delete_artifact",
        artifactName: row.name,
        title: `Delete artifact “@${row.name}”?`,
        lines: deleteLines(row),
        approveLabel: "Delete",
      })
    : { approved: false as const, reason: "unavailable" as const };
  if (!approval.approved) return notDeleted(approval, row.name);
  // The approval may have waited minutes: the session must still reach the
  // workspace, and the approved artifact (by id, not by name) must still be there.
  const current = workspaceArtifacts(session(caller)).find((candidate) => candidate.id === row.id);
  if (!current) {
    throw new ToolError("NOT_FOUND", `@${row.name} left this workspace's Artifacts while the user decided; nothing was deleted.`);
  }
  // A save or update of the same name keeps the id (upsertAgentContextMetadata):
  // the user approved what the card showed, not what the artifact became.
  if (changedSinceCard(row, current)) {
    return jsonResult({
      status: "not_deleted",
      reason: "changed",
      artifact: current.name,
      next: `@${current.name} was saved or changed while the user decided, so it is no longer what the card showed; nothing was deleted. `
        + "If it should still go, call delete_artifact again so the user can confirm it as it is now.",
    });
  }
  // The registration only: the file (a registered user file, or a .contexts/ document) stays.
  // Its id is tombstoned with it, so no window's stale copy can save it back.
  deleteContextAtomically(current.id, s.userId);
  hooks.onDeleted?.({ contextId: current.id, name: current.name });
  return jsonResult({
    status: "deleted",
    artifact: artifactView(current),
    note: `Removed @${current.name} from this workspace's Artifacts; it can no longer be @-mentioned. ${restoreHint(current)}`,
  });
}

/** How the deleted artifact can be registered again, as the tools and the Artifacts drawer actually allow. */
function restoreHint(row: ContextRow): string {
  if (row.url) {
    return "save_artifact cannot register a link: the user can add its url again with the Artifacts drawer's + button.";
  }
  const document = searchableBodyPath(row) !== null
    ? " For this document, update_artifact with the same name also registers it again, replacing its text with the body you pass."
    : "";
  return "Its file was not deleted. To register it again, call save_artifact with the same name and its filePath as path "
    + "(a file inside this workspace; the user can add a file from elsewhere again in the Artifacts tab)." + document;
}
