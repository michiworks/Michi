/**
 * Agent tools for Michi Memory: memory_search (memories and past
 * conversations: services/memory/recallIndex.ts), memory_save, memory_update
 * (a correction: supersedeMemory) and memory_delete (forgetMemory). Registered
 * for chat threads on every runtime (MCP for Kiro/Claude/Codex/Crew, built-in
 * tools for Pi) and for the user's conversation with the Michi assistant (V,
 * assistant/tools.ts), whose caller has no workspace: the assistant's hidden
 * one is never a memory scope. Never for Agent Runs, check-ins or background
 * maintenance.
 *
 * The model decides what to save, whether the user asked for it, what to
 * forget, its kind and whom it applies to: the tool descriptions
 * (builtinTools.ts) are the instructions, and nothing here reads the user's
 * words for intent. Boundaries enforced here, independent of runtime
 * permission modes:
 *  - The owner and the workspace come from the session binding, never from
 *    tool arguments. The arguments only say what a memory is (kind) and whom
 *    it applies to: `everywhere` (the user scope) or `this_workspace` (the
 *    thread's own workspace). Without one, preferences and facts apply
 *    everywhere and decisions and conventions to this workspace (everywhere
 *    when the thread has none, which then searches every workspace recall
 *    may read by default). Nothing asks the user.
 *  - memory_save's userAsked says whether the user asked to remember it: true
 *    is the user's own memory (origin explicit: pinned in every pack,
 *    announced with Undo, never changed by extraction), false an automatic
 *    one (origin extracted). A body the scope already holds is not saved
 *    twice (an automatic one the user now asks for becomes theirs, as a
 *    correction that keeps its search words); no save, asked or not,
 *    silently brings back a body that was removed (extraction's tombstones,
 *    read as extraction reads them: what the user types again in this turn,
 *    after the removal, is a new statement): the result says when, and the
 *    agent saves it again, with askedAgain, only once the user asks for it
 *    again in this conversation (an earlier request in chat history is no
 *    such request); one turn saves at most so many.
 *  - update reaches only the user-scope memories and the current workspace's
 *    (another workspace's says whose it is); delete, and memory_search with a
 *    ref, every memory memory_search may show: those and the ones of every
 *    workspace recall may read from here (recallIndex.recallableWorkspaces).
 *    Another owner's, or one memory_search may not show, reads as not found.
 *    They take a memory's ref (m:…, services/memory/memoryRefs.ts) or id; a
 *    ref names one version, so a memory changed since the agent saw it is a
 *    conflict. A correction keeps the corrected memory's origin, except that
 *    userAsked true makes an automatic memory the user's own; nothing makes
 *    the user's own automatic again.
 *  - Saves and corrections are active at once. One made while the thread's
 *    running turn has read untrusted content (web pages, shell output,
 *    another MCP server's results: services/turnTrust.ts), or when Michi
 *    cannot find the running turn, carries sourceRisk untrusted as
 *    provenance, unless what the user typed in the turn restates it
 *    (services/memory/typedText.ts): automatic recall leaves such memories
 *    out. In such a turn memory_delete deletes nothing: a page cannot make
 *    Michi forget a memory. A turn that holds check-in or collector material
 *    (turnTrust.activeCompanionTaint: what the Companion's check-ins wrote or
 *    its collectors read, also taken in by its live session earlier) saves and
 *    corrects only what the user typed in it restates; anything else is not
 *    written (not_saved, companion_material): such material never becomes
 *    memory. Since the conversation's later messages hold that material too,
 *    it forgets only what the user typed in it names, asked or not
 *    (typedText.typedTextNames: a memory's body, or what they said in the past
 *    turn a c: ref names), and nothing when the turn also read other outside
 *    content; a refusal names Settings → Memory.
 *  - Credentials in an unmistakable format (services/memory/secrets.ts) are
 *    never saved, even when asked; the descriptions cover the rest.
 *  - memory_delete, as ChatGPT's and Claude's forget, deletes a memory: every
 *    version of it and what consolidation merged into it, each with a
 *    tombstone so automatic extraction never saves it again from where it
 *    came from (memoryService.forgetMemory). Past conversations are chat
 *    history, which it leaves as they are (the reply footer's Don't recall
 *    keeps an excerpt out of recall): a past conversation's ref keeps that
 *    turn out of automatic memory, so what the user said there and asks to
 *    forget is never saved, even when extraction has not read it yet (an
 *    extraction reading it meanwhile drops its answer: extractionRun's
 *    settleMemoryExtractionRun). It deletes no note: notes go by their own
 *    refs, so what else that turn said stays. The turn that asks is read by
 *    automatic memory as any other: it carries the decline that extraction honours
 *    (exclude_turns, forget), and a removal made in it bars the removed body
 *    from it (extractionRepository.tombstoneBlocks: the user sent it before
 *    the removal). A delete's result never repeats what it removed, so the
 *    reply need not.
 *  - memory_search returns current memories and past-conversation excerpts;
 *    earlier versions of memories (what a correction replaced, a note
 *    consolidation put away) only when the agent asks for history. With
 *    nothing found in this workspace it returns what the user's other
 *    workspaces hold, each labelled. What it returns is noted for the line
 *    under the reply (services/memory/replySources.ts).
 *  - A note consolidation put away into a later one is a memory of its own:
 *    memory_delete forgets it alone (memory_update refuses it: it is
 *    history). An earlier version of a corrected memory goes with its memory.
 *  - With memory turned off the tools neither read nor write; in a
 *    conversation whose memory setting is off neither do they (the refusal
 *    says that nothing said there goes into memory and that what the user
 *    saved before stays until they delete it in Settings → Memory), and in
 *    one set to use only they read and forget but save and correct nothing.
 *    Every refusal of these two settings but an Off conversation's delete
 *    also says to keep nothing said there in a file, artifact or page unless
 *    the user explicitly asks for one: the setting keeps the conversation out
 *    of everything Michi keeps. Results say what happened and what a field
 *    means; the model decides what to tell the user.
 *
 * Every change is announced by memoryService (memoryEvents 'changed'); this
 * module sends no notifications of its own.
 */

import {
  MEMORY_BODY_MAX_CHARS,
  MEMORY_KINDS,
  isMemoryKind,
  isSystemWorkspaceSettings,
  type MemoryKind,
  type MemoryOrigin,
  type MemoryRecord,
  type MemoryScope,
  type MemorySource,
} from "michi-shared";
import { getWorkspace } from "../services/dbRepository";
import { log } from "../services/logger";
import { bodyRemovedAt, memoryBodyHash } from "../services/memory/extractionRepository";
import {
  MemoryError,
  createMemory,
  forgetMemory,
  getMemory,
  getMemorySettings,
  supersedeMemory,
  type MemoryCaller,
} from "../services/memory/memoryService";
import {
  activeMemoriesFromTurn, activeMemoryWithBody, consolidationRows, currentCorrection, readConversationMemoryMode, storedMemories,
  storedMemoryByRowId, turnStartedAt, type StoredMemory,
} from "../services/memory/memoryRepository";
import { requestAgentOwnerOrNull } from "../services/agentOwner";
import { conversationRef, memoryDay, memoryRef, parseRef, type ParsedRef } from "../services/memory/memoryRefs";
import {
  keepConversationTurnOutOfMemory,
  nextUserTurn,
  recallDocument,
  recallSearch,
  recallTurn,
  recallableWorkspaces,
  turnExcerpt,
  turnUserWords,
  type RecallDocumentQuery,
  type RecallHit,
  type RecallNeighbour,
} from "../services/memory/recallIndex";
import { noteSearched, type SearchedItem } from "../services/memory/replySources";
import { containsCredential, withoutCredentials } from "../services/memory/secrets";
import { typedTextBacks, typedTextNames, typedTextOfTurn, vouchedForRecall } from "../services/memory/typedText";
import { activeCompanionTaint, activeTurnTrust, isCompanionMaterial } from "../services/turnTrust";
import type { MemoryToolName } from "./memoryToolNames";
import { CodedToolError, codedErrorResult, jsonResult, type McpTextResult } from "./tools/types";

export { MEMORY_TOOL_NAMES, isMemoryToolName, type MemoryToolName } from "./memoryToolNames";

/** Session-bound identity of the calling thread. Never sourced from tool arguments. */
export interface MemoryToolCaller {
  /** The session's user; ignored on the desktop, where every memory is the local user's. */
  ownerUserId: string | null;
  workspaceId: string | null;
  nodeId: string | null;
  isAgentRun: boolean;
}

/** Whom a memory applies to, as the model says it; the scope follows from the session. */
const APPLIES_TO = ["everywhere", "this_workspace"] as const;
type AppliesTo = typeof APPLIES_TO[number];

/** memory_search's kind: a memory kind, or past conversations only. */
const SEARCH_KINDS = [...MEMORY_KINDS, "conversation"] as const;
type SearchKind = typeof SEARCH_KINDS[number];
const SEARCH_SCOPES = ["this_workspace", "all"] as const;

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 20;
/** What a past-conversation result shows of the user's words and of the reply; its ref reads the whole turn, read_node the conversation. */
const RESULT_USER_CHARS = 300;
const RESULT_REPLY_CHARS = 500;
/** Memories one turn saves at most: what the user asked for, and what the agent judged worth keeping unasked. */
const ASKED_SAVES_PER_TURN = 20;
const UNASKED_SAVES_PER_TURN = 5;

function memoryOff(): McpTextResult {
  return codedErrorResult("MEMORY_OFF", "Michi Memory is turned off (Settings → Memory), so nothing was read or saved.");
}

/**
 * Use only and Off keep a conversation out of everything Michi keeps, not only out of memory (as released): an agent
 * that may not save to memory could keep what it was asked to remember another way (live ftr-01/B, prompt diet round 5:
 * in a conversation that learns, asked to make a contact profile, Codex kept it only in an artifact).
 */
const KEEP_NOTHING_ELSEWHERE = "Keep nothing said here in a file, artifact or page either unless the user explicitly asks for one.";
/** What a conversation's setting leaves as it was: the memories the user saved, also those saved in it while it learned. */
const SAVED_STAYS = "Memories the user saved before stay until they delete them in Settings → Memory.";

function conversationOff(name: MemoryToolName): McpTextResult {
  if (name === "memory_delete") {
    return codedErrorResult("MEMORY_OFF_HERE", `Michi Memory is off in this conversation (its memory setting), so nothing was forgotten. ${SAVED_STAYS}`);
  }
  return codedErrorResult("MEMORY_OFF_HERE",
    "Michi Memory is off in this conversation (its memory setting): nothing was read or saved, and nothing said in it goes into memory. "
    + `${KEEP_NOTHING_ELSEWHERE} ${SAVED_STAYS}`);
}

function conversationUseOnly(): McpTextResult {
  return codedErrorResult("NOT_SAVED_HERE",
    "This conversation's memory setting is Use only: it reads Michi Memory but adds nothing to it, so nothing was saved or changed. "
    + KEEP_NOTHING_ELSEWHERE);
}

function toolError(error: unknown): McpTextResult {
  if (error instanceof CodedToolError) return codedErrorResult(error.code, error.message);
  if (error instanceof MemoryError) {
    switch (error.code) {
      case "memory_disabled": return memoryOff();
      case "not_found": return codedErrorResult("NOT_FOUND", error.message);
      case "invalid_argument": return codedErrorResult("INVALID_ARGUMENT", error.message);
      case "invalid_state": return codedErrorResult("INVALID_STATE", error.message);
      case "version_conflict": return codedErrorResult("CONFLICT", `${error.message}. Search again and use the current memory.`);
    }
  }
  throw error;
}

// ── Session ──────────────────────────────────────────────────────────────────

interface MemorySession {
  caller: MemoryCaller;
  workspaceId: string | null;
  nodeId: string;
}

function session(caller: MemoryToolCaller): MemorySession {
  if (caller.isAgentRun) throw new CodedToolError("UNSUPPORTED", "memory tools are available only in chat threads, not Agent Runs");
  if (!caller.nodeId) throw new CodedToolError("SOURCE_UNAVAILABLE", "this session is not yet bound to a chat thread");
  // The owner Settings → Memory and the change feed use.
  const ownerUserId = requestAgentOwnerOrNull(caller.ownerUserId);
  if (!ownerUserId) throw new CodedToolError("UNAVAILABLE", "this session has no signed-in user");
  return { caller: { ownerUserId }, workspaceId: caller.workspaceId, nodeId: caller.nodeId };
}

/** A memory this thread may change: the user's own, or its own workspace's. */
function visible(s: MemorySession, record: MemoryRecord): boolean {
  return record.scope.kind === "user" || record.scope.workspaceId === s.workspaceId;
}

/**
 * A memory memory_search may show this thread (and memory_delete forget): one it may change, or one of a workspace
 * recall may read from here (recallIndex.recallableWorkspaces: the user's other workspaces, never one in Trash or one AI
 * navigation may not read).
 */
function readableHere(s: MemorySession, record: MemoryRecord): boolean {
  if (visible(s, record)) return true;
  return record.scope.kind === "workspace" && recallableWorkspaces(s.caller.ownerUserId, s.workspaceId).includes(record.scope.workspaceId);
}

/** How a memory of another workspace than the thread's is shown: whose it is (hitView labels a search's the same way). */
function elsewhereView(s: MemorySession, record: MemoryRecord): Record<string, unknown> {
  if (record.scope.kind !== "workspace" || record.scope.workspaceId === s.workspaceId) return {};
  return { appliesTo: "another_workspace", workspace: getWorkspace(record.scope.workspaceId)?.name ?? "another workspace" };
}

interface ResolvedMemory {
  stored: StoredMemory;
  /** The version the agent's ref named; null for an id or a bare ref. */
  shownVersion: number | null;
}

/**
 * The memory a ref or an id names, if this thread may reach it: to correct (memory_update), the user's own or its own
 * workspace's, and another workspace's says whose it is; to forget (memory_delete), any memory memory_search may show
 * it (readableHere), as the user may ask to forget what they see. Anything else reads as missing.
 */
function resolveMemory(s: MemorySession, value: unknown, reach: "correct" | "forget"): ResolvedMemory {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new CodedToolError("INVALID_ARGUMENT", "ref is required: a memory's ref (m:…) from the memory notes or memory_search");
  const ref = parseRef(text);
  if (ref?.kind === "conversation") {
    throw new CodedToolError("INVALID_ARGUMENT", `${text} is a past conversation, not a memory; only memories can be corrected`);
  }
  let stored: StoredMemory | null;
  if (ref) {
    stored = storedMemoryByRowId(s.caller.ownerUserId, ref.rowId);
  } else {
    const record = getMemory(s.caller, text);
    stored = storedMemories(s.caller.ownerUserId, [record.id])[0] ?? null;
  }
  if (!stored || !readableHere(s, stored.record)) throw new CodedToolError("NOT_FOUND", "Memory not found");
  if (reach === "correct" && !visible(s, stored.record)) {
    // A correction made from another project could mix the two up; forgetting what the user sees is always theirs to ask.
    throw new CodedToolError("OTHER_WORKSPACE", `that memory belongs to the user's workspace "${elsewhereView(s, stored.record).workspace}": `
      + "correct it from a conversation there, or the user can edit it in Settings → Memory (memory_delete works from here)");
  }
  return { stored, shownVersion: ref?.version ?? null };
}

/** The agent's ref named an older version: it would change text it never saw. */
function assertCurrent({ stored, shownVersion }: ResolvedMemory): void {
  if (shownVersion === null || shownVersion === stored.record.version) return;
  throw new CodedToolError("CONFLICT",
    `that memory changed since you saw it; its current version is ${refOf(stored)}. Search for it, then use that ref.`);
}

function refOf(stored: StoredMemory): string {
  return memoryRef(stored.rowId, stored.record.version);
}

/** The ref of a memory just written. */
function refOfRecord(s: MemorySession, record: MemoryRecord): string | null {
  const stored = storedMemories(s.caller.ownerUserId, [record.id])[0];
  return stored ? refOf(stored) : null;
}

// ── Turn trust ───────────────────────────────────────────────────────────────

interface RunningTurn {
  turnId: string | null;
  /** The turn read untrusted content, or Michi cannot find it. */
  untrusted: boolean;
  /** It read untrusted content other than check-in or collector material (web pages, shell output, another MCP server's results), or Michi cannot find it. */
  outside: boolean;
}

function runningTurn(nodeId: string): RunningTurn {
  try {
    const trust = activeTurnTrust(nodeId);
    return {
      turnId: trust?.turnId ?? null,
      untrusted: !trust || trust.untrusted,
      outside: !trust || trust.sources.some((source) => !isCompanionMaterial(source)),
    };
  } catch (error) {
    log.warn("chat", "memory tool could not read turn trust", { nodeId, error: (error as Error).message });
    return { turnId: null, untrusted: true, outside: true };
  }
}

interface WriteProvenance {
  turn: RunningTurn;
  source: MemorySource;
  sourceRisk: "untrusted" | null;
  /** The turn holds check-in or collector material, and what the user typed in it does not restate the body: nothing is written. */
  companionMaterial: boolean;
}

/**
 * Where a write comes from: the thread and its running turn. Every write is
 * active; sourceRisk is provenance: an untrusted turn's write is clean when
 * what the user typed in it restates the body. Check-in and collector
 * material is no provenance but a bar: only what the user typed backs a write.
 */
function writeProvenance(nodeId: string, body: string): WriteProvenance {
  const turn = runningTurn(nodeId);
  const typed = !!turn.turnId && typedTextBacks(typedTextOfTurn(nodeId, turn.turnId), body);
  return {
    turn,
    source: { nodeId, ...(turn.turnId ? { turnId: turn.turnId } : {}) },
    sourceRisk: !turn.untrusted || typed ? null : "untrusted",
    companionMaterial: !typed && activeCompanionTaint(nodeId) !== null,
  };
}

/** A write the companion-material bar stopped (writeProvenance): what it says, never an error. */
function companionMaterialResult(): McpTextResult {
  return jsonResult({
    status: "not_saved", reason: "companion_material",
    note: "This turn read check-in material: Michi saves from it only what the user typed in it, so nothing was saved.",
  });
}

// ── Arguments ────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireBody(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new CodedToolError("INVALID_ARGUMENT", "body must be a non-empty string");
  const body = value.trim();
  if (body.length > MEMORY_BODY_MAX_CHARS) {
    throw new CodedToolError("INVALID_ARGUMENT", `body must be at most ${MEMORY_BODY_MAX_CHARS} characters; save one short statement`);
  }
  return body;
}

function requireKind(value: unknown): MemoryKind {
  if (!isMemoryKind(value)) throw new CodedToolError("INVALID_ARGUMENT", "kind must be preference, fact, decision or convention");
  return value;
}

function requireUserAsked(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new CodedToolError("INVALID_ARGUMENT",
      "userAsked is required: true when the user asked you to remember this, false when you are saving it on your own");
  }
  return value;
}

/** Keywords as given; memoryService trims, dedupes and checks their number and length. */
function optionalKeywords(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((keyword) => typeof keyword === "string")) {
    throw new CodedToolError("INVALID_ARGUMENT", "keywords must be a list of short search words");
  }
  return value as string[];
}

function optionalTopic(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CodedToolError("INVALID_ARGUMENT", "topic must be a few words");
  return value.trim() || null;
}

/** Michi never stores a credential, even when asked. */
function refuseCredential(body: string, keywords: readonly string[] | null): void {
  if (!containsCredential(body) && !(keywords ?? []).some(containsCredential)) return;
  throw new CodedToolError("SECRET",
    "that holds a credential (an API key or token, a private key, a card or id number). Michi never stores secrets: do not save it anywhere.");
}

/** The model's appliesTo, or null when it left the choice to Michi ("unsure", which older descriptions offered, counts as omitted). */
function optionalAppliesTo(value: unknown): AppliesTo | null {
  if (value === undefined || value === null || value === "unsure") return null;
  if (typeof value !== "string" || !(APPLIES_TO as readonly string[]).includes(value)) {
    throw new CodedToolError("INVALID_ARGUMENT", "appliesTo must be everywhere or this_workspace; omit it to let Michi choose");
  }
  return value as AppliesTo;
}

/**
 * Whom a memory applies to when the model does not say: preferences and
 * facts everywhere (most are about the user), decisions and conventions to
 * this workspace (everywhere when the thread has none). The user can move it
 * in Settings → Memory.
 */
function defaultAppliesTo(kind: MemoryKind, hasWorkspace: boolean): AppliesTo {
  return hasWorkspace && (kind === "decision" || kind === "convention") ? "this_workspace" : "everywhere";
}

function searchLimit(value: unknown): number {
  if (value === undefined || value === null) return SEARCH_DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > SEARCH_MAX_LIMIT) {
    throw new CodedToolError("INVALID_ARGUMENT", `limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}`);
  }
  return value;
}

function optionalEnum<T extends string>(value: unknown, values: readonly T[], name: string): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new CodedToolError("INVALID_ARGUMENT", `${name} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

/** A date (YYYY-MM-DD: the start of that local day) or an ISO date-time, in ms. */
function optionalDate(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "string" ? value.trim() : "";
  const day = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  let time = Date.parse(text);
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
    const local = new Date(year, month, date);
    // new Date() rolls an impossible date (2026-02-30) over into the next month.
    time = local.getFullYear() === year && local.getMonth() === month && local.getDate() === date ? local.getTime() : NaN;
  }
  if (!Number.isFinite(time)) throw new CodedToolError("INVALID_ARGUMENT", `${name} must be a date like 2026-11-05 or an ISO date-time`);
  return time;
}

// ── Views ────────────────────────────────────────────────────────────────────

function appliesToOf(scope: MemoryScope): AppliesTo {
  return scope.kind === "user" ? "everywhere" : "this_workspace";
}

const IMPORT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", kiro: "Kiro" };

/** The tool whose memory an imported note came from (the user's own words there), as a result names it. */
function importedFrom(importSource: string | null | undefined): Record<string, unknown> {
  return importSource ? { importedFrom: `the user's ${IMPORT_NAMES[importSource] ?? "other assistant"} memory` } : {};
}

function memoryView(record: MemoryRecord, ref: string | null): Record<string, unknown> {
  return {
    ...(ref ? { ref } : {}),
    appliesTo: appliesToOf(record.scope),
    kind: record.kind,
    ...(record.topic ? { topic: record.topic } : {}),
    body: record.body,
    status: record.status,
    savedByUser: record.origin === "explicit",
    ...importedFrom(record.importSource),
    date: memoryDay(record.observedAt ?? record.createdAt),
  };
}

/** A past conversation's excerpt: the user's words, then the reply, each around what the search matched; never a credential. */
function conversationText(hit: RecallHit): string {
  const { user, reply } = turnExcerpt(hit, { user: RESULT_USER_CHARS, reply: RESULT_REPLY_CHARS });
  return withoutCredentials(reply ? `${user}\n→ ${reply}` : user);
}

/** The ref of the note that replaced a superseded one (a correction, or the note consolidation put it into), when this thread may see it. */
function currentRefOf(s: MemorySession, memoryId: string): string | null {
  const current = currentCorrection(s.caller.ownerUserId, memoryId);
  return current && readableHere(s, current.record) ? refOf(current) : null;
}

function hitView(s: MemorySession, hit: RecallHit, workspaceLabel: (id: string) => WorkspaceLabel): Record<string, unknown> {
  const label = hit.workspaceId !== null ? workspaceLabel(hit.workspaceId) : null;
  const elsewhere = hit.workspaceId !== null && hit.workspaceId !== s.workspaceId
    ? { workspace: label?.name ?? "another workspace" } : {};
  if (hit.kind === "memory" && hit.memory) {
    const unverified = !vouchedForRecall({ body: hit.snippet, sourceRisk: hit.memory.sourceRisk, nodeId: hit.nodeId, turnId: hit.turnId });
    const current = hit.memory.status === "superseded" ? currentRefOf(s, hit.refId) : null;
    return {
      ref: memoryRef(hit.memory.rowId, hit.memory.version),
      type: "memory",
      kind: hit.memory.kind,
      ...(hit.memory.topic ? { topic: hit.memory.topic } : {}),
      date: memoryDay(hit.at),
      appliesTo: hit.workspaceId === null ? "everywhere" : hit.workspaceId === s.workspaceId ? "this_workspace" : "another_workspace",
      ...elsewhere,
      ...(hit.title ? { from: hit.title } : {}),
      text: hit.snippet,
      // Whether it is the user's own, or one Michi saved itself that their request to remember would make theirs.
      savedByUser: hit.memory.origin === "explicit",
      ...importedFrom(hit.memory.importSource),
      ...(hit.memory.status !== "active" ? { status: hit.memory.status } : {}),
      ...(current ? { current } : {}),
      ...(unverified ? { unverified: true } : {}),
    };
  }
  return {
    ref: conversationRef(hit.docId),
    type: "conversation",
    date: memoryDay(hit.at),
    conversation: hit.title ?? "(untitled)",
    // read_node opens no conversation of a hidden workspace: its c: ref reads it.
    ...(label?.hidden ? {} : { nodeId: hit.nodeId }),
    ...elsewhere,
    text: conversationText(hit),
  };
}

/**
 * How results label a hit's workspace: by its name, except the assistant's hidden one (V's conversations), which is
 * never named, as Recent does not name it, and none of whose conversations read_node opens (globalContext.hiddenFrom).
 */
interface WorkspaceLabel { name: string | null; hidden: boolean }

function workspaceNames(): (id: string) => WorkspaceLabel {
  const labels = new Map<string, WorkspaceLabel>();
  return (id) => {
    let label = labels.get(id);
    if (!label) {
      const workspace = getWorkspace(id);
      const hidden = isSystemWorkspaceSettings(workspace?.settings);
      label = { name: hidden ? null : workspace?.name ?? null, hidden };
      labels.set(id, label);
    }
    return label;
  };
}

// ── Tool entry point ─────────────────────────────────────────────────────────

/** Runs one memory tool call for the calling thread. Unexpected failures (the database) throw. */
export function memoryTool(name: MemoryToolName, caller: MemoryToolCaller, rawArgs: unknown): McpTextResult {
  const args = asRecord(rawArgs);
  try {
    const s = session(caller);
    if (getMemorySettings(s.caller.ownerUserId).mode === "off") return memoryOff();
    const here = readConversationMemoryMode(s.nodeId);
    if (here === "off") return conversationOff(name);
    if (here === "use_only" && (name === "memory_save" || name === "memory_update")) return conversationUseOnly();
    switch (name) {
      case "memory_search": return searchTool(s, args);
      case "memory_save": return saveTool(s, args);
      case "memory_update": return updateTool(s, args);
      case "memory_delete": return deleteTool(s, args);
    }
  } catch (error) {
    return toolError(error);
  }
}

const SEARCH_NOTE = "m: refs are memories; c: refs are excerpts of past conversations (read_node with the nodeId opens one; next: what "
  + "the user said right after it). unverified: saved while reading outside content (web pages, tool output).";
/** What a search with history adds to the note. */
const HISTORY_NOTE = "status superseded: an earlier version, which a later note replaced (current names that note).";

const SEARCH_NOTHING = "Nothing matched.";

function optionalFlag(value: unknown, name: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new CodedToolError("INVALID_ARGUMENT", `${name} must be true or false`);
  return value;
}

function searchTool(s: MemorySession, args: Record<string, unknown>): McpTextResult {
  if (args.query !== undefined && args.query !== null && typeof args.query !== "string") {
    throw new CodedToolError("INVALID_ARGUMENT", "query must be keywords, or a ref such as m:1kv2 or c:3f");
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const kind = optionalEnum<SearchKind>(args.kind, SEARCH_KINDS, "kind");
  // A caller in no workspace (the assistant's conversation) has none to start from: it reads every one recall may.
  const scope = optionalEnum(args.scope, SEARCH_SCOPES, "scope") ?? (s.workspaceId ? "this_workspace" : "all");
  const after = optionalDate(args.after, "after");
  const before = optionalDate(args.before, "before");
  const limit = searchLimit(args.limit);
  // Earlier versions (corrected, or put away by consolidation) only when the agent asks for history.
  const history = optionalFlag(args.history, "history");
  const ref = parseRef(query);
  if (ref) return refTool(s, ref, query);
  const own = s.workspaceId ? [s.workspaceId] : [];
  const memoryKind = kind && kind !== "conversation" ? kind : null;
  const search = (workspaces: readonly string[] | "all") => recallSearch({
    ownerUserId: s.caller.ownerUserId,
    workspaceIds: workspaces,
    includeUserScope: true,
    memoryWorkspaceIds: workspaces,
    currentWorkspaceId: s.workspaceId,
    query,
    kinds: kind === "conversation" ? ["turn"] : memoryKind ? ["memory"] : undefined,
    after,
    before,
    excludeNodeId: s.nodeId,
    includeInactive: history,
    gate: false,
    // Kinds are filtered here: read more so that `limit` of them can remain.
    limit: memoryKind ? 50 : limit,
  }).filter((hit) => !memoryKind || hit.memory?.kind === memoryKind).slice(0, limit);
  let hits = search(scope === "all" ? "all" : own);
  // Nothing here: what the user's other workspaces hold, labelled with their workspace (as scope all shows them).
  const widened = hits.length === 0 && scope !== "all" && !!query;
  if (widened) hits = search("all");
  givenToRunningTurn(s, hits.flatMap((hit): SearchedItem[] => (hit.kind === "memory" && hit.memory ? [{ kind: "memory", id: hit.memory.id }]
    : hit.kind === "turn" ? [{ kind: "conversation", docId: hit.docId, text: conversationText(hit) }] : [])));
  const names = workspaceNames();
  const note = [...(widened ? [SEARCH_ELSEWHERE] : []), SEARCH_NOTE, ...(history ? [HISTORY_NOTE] : [])].join(" ");
  return jsonResult({
    count: hits.length,
    results: hits.map((hit) => {
      const view = hitView(s, hit, names);
      const following = hit.kind === "turn" ? nextUserTurn(s.caller.ownerUserId, hit) : null;
      return following ? { ...view, next: following.text } : view;
    }),
    ...(hits.length === 0 ? { next: SEARCH_NOTHING } : { note }),
  });
}

const SEARCH_ELSEWHERE = "Nothing matched in this workspace; these results are from the user's other workspaces.";

/** The running turn was given these memories and past-conversation excerpts: its reply may be based on any of them (replySources.ts). */
function givenToRunningTurn(s: MemorySession, items: readonly SearchedItem[]): void {
  if (items.length === 0) return;
  noteSearched({ ownerUserId: s.caller.ownerUserId, nodeId: s.nodeId, turnId: runningTurn(s.nodeId).turnId, items });
}

/** memory_search with a ref the agent was shown: that item, in full (an earlier version too: the agent names it). */
function refTool(s: MemorySession, ref: ParsedRef, text: string): McpTextResult {
  if (ref.kind === "memory") {
    const stored = storedMemoryByRowId(s.caller.ownerUserId, ref.rowId);
    if (!stored || !readableHere(s, stored.record)) throw new CodedToolError("NOT_FOUND", `nothing found for ${text}`);
    const { record } = stored;
    givenToRunningTurn(s, [{ kind: "memory", id: record.id }]);
    const unverified = !vouchedForRecall({
      body: record.body, sourceRisk: record.sourceRisk, nodeId: record.source?.nodeId ?? null, turnId: record.source?.turnId ?? null,
    });
    const current = record.status === "superseded" ? currentRefOf(s, record.id) : null;
    return jsonResult({
      count: 1,
      results: [{
        ...memoryView(record, refOf(stored)),
        ...elsewhereView(s, record),
        type: "memory",
        ...(current ? { current } : {}),
        ...(stored.sourceTitle ? { from: stored.sourceTitle } : {}),
        ...(ref.version !== null && ref.version !== record.version ? { note: `${text} was an earlier version of this memory` } : {}),
        ...(unverified ? { unverified: true } : {}),
      }],
      note: record.status === "superseded" ? `${SEARCH_NOTE} ${HISTORY_NOTE}` : SEARCH_NOTE,
    });
  }
  const view = recallTurn(conversationScope(s, ref.docId));
  if (!view) throw new CodedToolError("NOT_FOUND", `nothing found for ${text}`);
  const turnText = withoutCredentials(view.text);
  givenToRunningTurn(s, [{ kind: "conversation", docId: view.hit.docId, text: turnText.slice(0, 4_000) }]);
  const around = (turn: RecallNeighbour | null) => (turn
    ? { ref: conversationRef(turn.docId), date: memoryDay(turn.at), text: withoutCredentials(turn.text) } : null);
  const previous = around(view.previous);
  const next = around(view.next);
  return jsonResult({
    count: 1,
    results: [{
      ...hitView(s, view.hit, workspaceNames()),
      text: turnText,
      ...(previous ? { previous } : {}),
      ...(next ? { next } : {}),
    }],
    note: `${SEARCH_NOTE} previous and next are the turns around it in that conversation; pass one's ref to read it.`,
  });
}

/** What a c: ref may name: a past conversation in any workspace recall may read, or this one's. */
function conversationScope(s: MemorySession, docId: number): RecallDocumentQuery {
  return {
    ownerUserId: s.caller.ownerUserId, docId, workspaceIds: "all" as const, includeUserScope: true,
    memoryWorkspaceIds: s.workspaceId ? [s.workspaceId] : [], currentWorkspaceId: s.workspaceId,
  };
}

/** What a save did; an automatic memory (origin extracted) is said to be one, as memory_update can make it the user's own. */
function savedNote(status: "saved" | "already_saved" | "made_theirs", record: MemoryRecord): string {
  if (status === "made_theirs") return "Michi already held this as an automatic memory; it is now the user's own.";
  if (status === "saved") {
    return record.origin === "explicit" ? "Saved to Michi Memory." : "Saved to Michi Memory as an automatic memory, not the user's own.";
  }
  return record.origin === "explicit" ? "Michi Memory already holds this; nothing new was saved."
    : "Michi Memory already holds this as an automatic memory, not the user's own; nothing new was saved.";
}

function savedResult(s: MemorySession, status: "saved" | "already_saved" | "made_theirs", record: MemoryRecord, scopeNote?: string): McpTextResult {
  const ref = refOfRecord(s, record);
  return jsonResult({
    status: status === "made_theirs" ? "saved" : status,
    ...(ref ? { ref } : {}),
    memory: memoryView(record, ref),
    note: scopeNote ? `${scopeNote} ${savedNote(status, record)}` : savedNote(status, record),
  });
}

/**
 * memory_save met a body that was removed (removedFor): not saved, and when the agent may save it again. A removal is
 * the user's doing (a delete, a decline, a conversation kept out of memory), so the note names them all.
 */
function deletedBefore(at: number, userAsked: boolean): McpTextResult {
  const day = memoryDay(at);
  return jsonResult({
    status: "not_saved", reason: "deleted_before", deletedOn: day,
    note: `The user removed this from Michi Memory on ${day} (deleted or declined it, or kept the conversation it came from out `
      + "of memory), so it was not saved. "
      + (userAsked
        ? "askedAgain true saves it if the user asks for it in this conversation (their current message included); an earlier "
          + "request in another conversation does not count."
        : "It is saved again only if the user asks you to remember it in this conversation (userAsked and askedAgain true)."),
  });
}

/**
 * When a removal of this body bars saving it in the running turn (bodyRemovedAt: the body, in the scope a memory with it
 * would show in), or null. Any removal does, unless what the user typed in this turn restates the body and the removal
 * came before the turn began: then they said it again, a new statement, as automatic extraction reads one
 * (extractionRepository.tombstoneBlocks). The turn that asked to forget it began before its removal.
 */
function removedFor(s: MemorySession, turnId: string | null, body: string, scope: MemoryScope): number | null {
  const began = turnId && typedTextBacks(typedTextOfTurn(s.nodeId, turnId), body) ? turnStartedAt(s.nodeId, turnId) : null;
  return bodyRemovedAt({
    ownerUserId: s.caller.ownerUserId, bodyHash: memoryBodyHash(body), workspaceId: s.workspaceId, everywhere: scope.kind === "user",
    since: began ?? 0,
  });
}

/** this_workspace from a caller without one (the assistant's conversation): the memory is the user's, everywhere. */
const NO_WORKSPACE_NOTE = "This conversation is in no workspace, so the memory applies everywhere.";

function saveTool(s: MemorySession, args: Record<string, unknown>): McpTextResult {
  const body = requireBody(args.body);
  const kind = requireKind(args.kind);
  const userAsked = requireUserAsked(args.userAsked);
  const askedAgain = optionalFlag(args.askedAgain, "askedAgain");
  const keywords = optionalKeywords(args.keywords);
  const topic = optionalTopic(args.topic);
  const appliesTo = optionalAppliesTo(args.appliesTo) ?? defaultAppliesTo(kind, !!s.workspaceId);
  refuseCredential(body, keywords);
  let scope: MemoryScope = { kind: "user" };
  const scopeNote = appliesTo === "this_workspace" && !s.workspaceId ? NO_WORKSPACE_NOTE : undefined;
  if (appliesTo === "this_workspace" && s.workspaceId) scope = { kind: "workspace", workspaceId: s.workspaceId };
  const provenance = writeProvenance(s.nodeId, body);
  const origin: MemoryOrigin = userAsked ? "explicit" : "extracted";
  const ownerUserId = s.caller.ownerUserId;
  // The same note is not kept twice; what Michi saved on its own and the user now asks for becomes theirs.
  const same = activeMemoryWithBody(ownerUserId, s.workspaceId, body);
  if (same && (same.record.origin === "explicit" || !userAsked)) return savedResult(s, "already_saved", same.record);
  if (provenance.companionMaterial) return companionMaterialResult();
  const turnId = provenance.turn.turnId;
  const fromTurn = turnId ? activeMemoriesFromTurn(ownerUserId, turnId).filter((memory) => memory.origin === origin).length : 0;
  if (fromTurn >= (userAsked ? ASKED_SAVES_PER_TURN : UNASKED_SAVES_PER_TURN)) {
    throw new CodedToolError("LIMIT", userAsked
      ? "this message already saved as many memories as one message can; combine related items into one memory"
      : "this message already saved as many memories unasked as one message can");
  }
  // What was removed is not saved again silently, asked or not: the tombstones automatic extraction checks, read as it
  // reads them (removedFor: what the user typed again in this turn is a new statement). The result says when; the agent
  // saves it only once the user asks for it again in this conversation (askedAgain), never from an earlier request that
  // Recent conversations or a search shows. Only the body counts: what else the agent saves in a turn is its own call.
  if (!same && !(userAsked && askedAgain)) {
    const removedAt = removedFor(s, provenance.turn.turnId, body, scope);
    if (removedAt !== null) return deletedBefore(removedAt, userAsked);
  }
  // An automatic memory the user now asks for becomes theirs, keeping its search words unless new ones are given.
  const kept = same && !keywords && same.record.keywords?.length ? { keywords: same.record.keywords } : {};
  const write = {
    body, source: provenance.source, status: "active" as const, origin, sourceRisk: provenance.sourceRisk,
    ...(keywords ? { keywords } : kept),
    ...(topic ? { topic } : {}),
  };
  const record = same
    ? supersedeMemory(s.caller, same.record.id, { kind, ...write })
    : createMemory(s.caller, { scope, kind, ...write });
  return savedResult(s, same ? "made_theirs" : "saved", record, scopeNote);
}

function optionalUserAsked(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new CodedToolError("INVALID_ARGUMENT", "userAsked must be true or false");
  return value;
}

function updateTool(s: MemorySession, args: Record<string, unknown>): McpTextResult {
  const target = resolveMemory(s, args.ref ?? args.id, "correct");
  const old = target.stored.record;
  const body = args.body === undefined || args.body === null ? old.body : requireBody(args.body);
  const keywords = optionalKeywords(args.keywords);
  const topic = optionalTopic(args.topic);
  const userAsked = optionalUserAsked(args.userAsked);
  if ((args.body === undefined || args.body === null) && keywords === null && topic === null && userAsked === null) {
    throw new CodedToolError("INVALID_ARGUMENT", "pass the complete corrected body, new keywords, a topic, or userAsked true");
  }
  if (old.status === "superseded") throw supersededError(s, old.id, "correct");
  assertCurrent(target);
  refuseCredential(body, keywords);
  // The user's own memory stays theirs; an automatic one becomes theirs when the user asked to remember it, never the other way.
  const origin: MemoryOrigin = old.origin === "explicit" || userAsked === true ? "explicit" : "extracted";
  const madeTheirs = origin !== old.origin;
  if (body === old.body && keywords === null && (topic === null || topic === old.topic) && !madeTheirs) {
    return jsonResult({ status: "unchanged", ref: refOf(target.stored), memory: memoryView(old, refOf(target.stored)) });
  }
  const provenance = writeProvenance(s.nodeId, body);
  if (provenance.companionMaterial) return companionMaterialResult();
  // The same text keeps its search words unless new ones are given; a corrected text takes only the new ones.
  const kept = body === old.body && old.keywords?.length ? { keywords: old.keywords } : {};
  const record = supersedeMemory(s.caller, old.id, {
    body, source: provenance.source, status: "active", origin, sourceRisk: provenance.sourceRisk,
    ...(keywords ? { keywords } : kept),
    // The old topic stays unless a new one is given (supersedeMemory).
    ...(topic ? { topic } : {}),
  });
  const ref = refOfRecord(s, record);
  return jsonResult({
    status: "updated",
    ...(ref ? { ref } : {}),
    memory: memoryView(record, ref),
    replaces: refOf(target.stored),
    note: `${madeTheirs ? "It is now the user's own memory." : "The correction replaced the old memory."} Michi keeps the old version as history.`,
  });
}

const READ_OUTSIDE = "this turn read content from outside the conversation (web pages, shell output or another tool's results), so Michi "
  + "deletes nothing in it.";
const UNTRUSTED_DELETE = `${READ_OUTSIDE} The user can confirm in their next message, or delete it in Settings → Memory.`;
/**
 * Check-in or collector material stays with the conversation's session (turnTrust.activeCompanionTaint): its next
 * message holds it too, so what the user typed in a message has to name what it forgets (forgetNamedBy).
 */
const COMPANION_DELETE = "this conversation holds check-in material, so Michi deletes here only what the user's own words in this "
  + "message name. The user can delete it in Settings → Memory.";
/** A turn that read outside content in such a conversation: a confirmation in the next message names nothing. */
const COMPANION_UNTRUSTED_DELETE = `${READ_OUTSIDE} The user can say in their next message what to forget, or delete it in Settings → Memory.`;
/**
 * memory_delete named a past conversation: chat history stays, but automatic memory never saves what that turn says
 * from now on. A note it saved just before the call stays (live Kiro nos-01: committed 24 ms earlier, after the agent's
 * search), so the note says so.
 */
const KEPT_OUT_NOTE = "That past conversation stays as it is (only deleting the conversation removes it), and automatic memory will not "
  + "save anything more from that turn. This deletes no memory: memories (m:) that say it, also any saved from that turn before "
  + "this call, stay until they are deleted.";

/** Consolidation put this note away into another one (memories.merged_into_id): it is a memory of its own, kept as history. */
function mergedAway(s: MemorySession, memoryId: string): boolean {
  return !!consolidationRows(s.caller.ownerUserId, [memoryId])[0]?.mergedIntoId;
}

/** Consolidation put the note the agent saw away into another since: that note says everything it said. */
function mergedSinceError(s: MemorySession, memoryId: string): CodedToolError {
  const into = currentRefOf(s, memoryId);
  return new CodedToolError("CONFLICT", into
    ? `that memory was put away into another note since you saw it, ${into}, which says it too: delete that one instead (pass ref ${into}), `
      + "which deletes this one with it"
    : "that memory was put away into another note since you saw it; search again and delete the current note that says it");
}

/** memory_update or memory_delete named a superseded memory: the error names the note that replaced it, when there is one. */
function supersededError(s: MemorySession, memoryId: string, action: "correct" | "delete"): CodedToolError {
  const current = currentRefOf(s, memoryId);
  if (action === "correct" && mergedAway(s, memoryId)) {
    // An earlier note a later one replaced: correcting the later one would change the current value, not this history.
    return new CodedToolError("INVALID_STATE", `that memory is an earlier note${current ? ` that a later one, ${current}, replaced` : " a later one replaced"}; `
      + "it is kept as history and cannot be corrected. If what the user corrects is the current value, correct "
      + `${current ? `that note (pass ref ${current})` : "its current version"}; to forget the earlier note, call memory_delete with its ref.`);
  }
  // An earlier version of a corrected memory is part of that memory: deleting the memory deletes every version.
  const all = action === "delete" ? ", which deletes it with every earlier version, this one included" : "";
  return new CodedToolError("INVALID_STATE", current
    ? `that memory was replaced by a later note, ${current}; ${action} that one instead (pass ref ${current})${all}`
    : `that memory was replaced by a later note; search again and ${action} its current version${all}`);
}

/**
 * What has to name what memory_delete forgets: nothing (null) in a turn that read no outside content; in one whose only
 * outside content is check-in or collector material (its own, or what its session took in earlier), what the user
 * typed in it (typedText.typedTextNames). A turn that read other outside content, or one Michi cannot find, forgets
 * nothing: a page cannot make Michi forget anything.
 */
function forgetNamedBy(nodeId: string): readonly string[] | null {
  const companion = activeCompanionTaint(nodeId) !== null;
  const turn = runningTurn(nodeId);
  if (!turn.untrusted && !companion) return null;
  if (!companion) throw new CodedToolError("NOT_ALLOWED", UNTRUSTED_DELETE);
  if (!turn.turnId) throw new CodedToolError("NOT_ALLOWED", COMPANION_DELETE);
  if (turn.outside) throw new CodedToolError("NOT_ALLOWED", COMPANION_UNTRUSTED_DELETE);
  return typedTextOfTurn(nodeId, turn.turnId);
}

/**
 * memory_delete: the memory a ref (m:…) or an id names, with every version and what consolidation merged into it
 * (memoryService.forgetMemory); or, for a past conversation's ref (c:…), that turn kept out of automatic memory while
 * the conversation stays as it is (recallIndex.keepConversationTurnOutOfMemory), so what the user said there and asks
 * to forget before extraction read it is never saved: an extraction reading that turn meanwhile drops its answer
 * (extractionRun.settleMemoryExtractionRun). A c: ref deletes no note; notes go by their own refs. A ref is checked
 * against the version the agent saw; a correction's earlier version names its memory's current note instead, and so
 * does a note consolidation put away since the agent saw it. In a turn that holds check-in or collector material,
 * what the user typed in it has to name the memory's body, or what they said in that past turn (forgetNamedBy). The
 * running turn stays as any other for automatic memory: the decline it carries is extraction's to honour.
 */
function deleteTool(s: MemorySession, args: Record<string, unknown>): McpTextResult {
  const value = args.ref ?? args.id;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new CodedToolError("INVALID_ARGUMENT", "ref is required: a memory's ref (m:…) or a past conversation's (c:…) from the memory notes or memory_search");
  const named = forgetNamedBy(s.nodeId);
  const ref = parseRef(text);
  if (ref?.kind === "conversation") {
    const scope = conversationScope(s, ref.docId);
    if (named !== null) {
      // What the user said in that turn; one this scope cannot read is left to the lookup below.
      const past = recallDocument({ ...scope, kinds: ["turn"] });
      if (past?.kind === "turn" && !typedTextNames(named, turnUserWords(past.content ?? past.snippet))) {
        throw new CodedToolError("NOT_ALLOWED", COMPANION_DELETE);
      }
    }
    if (!keepConversationTurnOutOfMemory(scope)) throw new CodedToolError("NOT_FOUND", `nothing found for ${text}`);
    return jsonResult({ status: "kept_out", ref: conversationRef(ref.docId), note: KEPT_OUT_NOTE });
  }
  const target = resolveMemory(s, value, "forget");
  const { record } = target.stored;
  if (record.status === "superseded") {
    // A correction's earlier version goes with its memory. A note consolidation put away is forgotten alone (with what
    // was merged into it), unless that happened since the agent saw it: then the note it went into says it too.
    if (!mergedAway(s, record.id)) throw supersededError(s, record.id, "delete");
    if (target.shownVersion !== null && target.shownVersion !== record.version) throw mergedSinceError(s, record.id);
  }
  assertCurrent(target);
  if (named !== null && !typedTextNames(named, record.body)) throw new CodedToolError("NOT_ALLOWED", COMPANION_DELETE);
  forgetMemory(s.caller, record.id);
  return jsonResult({
    status: "deleted",
    ref: refOf(target.stored),
    note: "Deleted from Michi Memory with its earlier versions; automatic memory will not save it again from where it came from. "
      + "Conversations are unchanged.",
  });
}
