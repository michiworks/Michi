/**
 * Michi Memory: durable, owner-scoped notes (preferences, facts, decisions,
 * conventions) that every runtime can read and correct. The backend owns
 * storage and access checks (services/memory); these are the shapes its
 * service, REST API and change events share with the renderer.
 */

export const MEMORY_KINDS = ['preference', 'fact', 'decision', 'convention'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

/**
 * active: visible to search and injection. pending: legacy, written only by
 * older Michi versions that asked for approval; this backend activates such
 * rows once at startup and never writes new ones. superseded: replaced by a
 * correction; kept for history, hidden by default.
 */
export const MEMORY_STATUSES = ['active', 'pending', 'superseded'] as const;
export type MemoryStatus = typeof MEMORY_STATUSES[number];

export const MEMORY_ORIGINS = ['explicit', 'extracted'] as const;
export type MemoryOrigin = typeof MEMORY_ORIGINS[number];

/** Set when the memory was written from a turn that read untrusted content. */
export type MemorySourceRisk = 'untrusted';

/** The whole user (every workspace), or one workspace the owner owns. */
export type MemoryScope = { kind: 'user' } | { kind: 'workspace'; workspaceId: string };

/** Where the memory came from; every field is optional and none grants access. */
export interface MemorySource {
  nodeId?: string;
  messageId?: string;
  turnId?: string;
  artifactId?: string;
}

/** The runtime whose own memory an imported memory was read from: Claude Code's auto memory, Codex memories, Kiro's. */
export type MemoryImportSource = 'claude' | 'codex' | 'kiro';

export interface MemoryRecord {
  id: string;
  ownerUserId: string;
  scope: MemoryScope;
  kind: MemoryKind;
  body: string;
  source: MemorySource | null;
  status: MemoryStatus;
  origin: MemoryOrigin;
  /** Optimistic-lock version of this record; starts at 1, +1 on every change. */
  version: number;
  /** The record this one corrects; it becomes superseded once this one is active. */
  supersedesId: string | null;
  sourceRisk: MemorySourceRisk | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Search aliases that help recall find this memory (both languages,
   * synonyms, names); empty when there are none. Absent from older backends.
   */
  keywords?: string[];
  /**
   * What the memory is about, in a few words (a person, project, place or area
   * of the user's life), chosen when it is saved; null when none was given.
   * Settings groups memories by it, and About the user takes its topics from
   * it. Absent from older backends.
   */
  topic?: string | null;
  /** When the event the memory describes happens or happened (ms epoch); null when it describes none. */
  eventAt?: number | null;
  /** When the user said it (ms epoch); createdAt unless the writer knew the message time. */
  observedAt?: number;
  /**
   * Set on a memory Michi imported, read-only, from a runtime's own memory:
   * which runtime, and the item there (a file such as
   * '<project>/<note>.md', with '#<part>' for a part of a split note).
   * Absent on every other memory and from older backends.
   */
  importSource?: MemoryImportSource;
  importRef?: string;
}

/**
 * off: memory is neither read nor written by agents (existing entries can
 * still be listed and deleted). auto: on: agents save what they are asked to
 * remember and background extraction saves what users state. explicit:
 * retired (explicit-only); the backend treats it as auto, so the UI offers
 * only on (auto) and off. All three stay on the wire for older clients.
 */
export const MEMORY_MODES = ['off', 'explicit', 'auto'] as const;
export type MemoryMode = typeof MEMORY_MODES[number];

export interface MemorySettings {
  mode: MemoryMode;
  /**
   * The one-time notice about memory being on (GET /api/memory-settings;
   * absent from older backends): the owner had chosen the retired
   * explicit-only mode, which became on, and whether they have seen the
   * notice (PUT { noticeSeen: true }).
   */
  migratedFromExplicit?: boolean;
  noticeSeen?: boolean;
}

/**
 * A conversation's memory setting (GET/PUT /api/nodes/:nodeId/memory-mode):
 * learn (the default: memory is read, and what is said here is remembered),
 * use_only (memory is read and searched; nothing from this conversation is
 * indexed, extracted or saved) or off (memory is not read either).
 */
export const CONVERSATION_MEMORY_MODES = ['learn', 'use_only', 'off'] as const;
export type ConversationMemoryMode = typeof CONVERSATION_MEMORY_MODES[number];

export function isConversationMemoryMode(value: unknown): value is ConversationMemoryMode {
  return typeof value === 'string' && (CONVERSATION_MEMORY_MODES as readonly string[]).includes(value);
}

/** One memory a profile line rests on, as GET /api/memory-profile lists it. */
export interface MemoryProfileCitation {
  /** m:<row>v<version>, as agents see it. */
  ref: string;
  id: string;
  body: string;
}

/** GET /api/memory-profile: Michi's profile of the user ("About the user"), its lines in order. */
export interface MemoryProfileResponse {
  lines: Array<{ topic: string; text: string; refs: MemoryProfileCitation[] }>;
  /** When the lines were built (ms epoch); null before the first build. */
  builtAt: number | null;
  /** Goes up with every rebuild; 0 before the first. */
  version: number;
  /** A rebuild the user asked for is waiting to run. */
  rebuildRequested: boolean;
}

/**
 * What a reply was based on (GET /api/nodes/:nodeId/memory-sources): a memory
 * or a past-conversation turn the conversation's session was given and the
 * reply repeated, as Michi tracks it (backend services/memory/replySources.ts).
 */
export type ReplyMemorySource =
  | {
    kind: 'memory';
    memoryId: string;
    text: string;
    /** The user saved it; Michi noted it on its own; it was imported from a runtime's own memory. */
    savedBy: 'user' | 'michi' | 'import';
    importSource?: MemoryImportSource;
    /** When the user said it (ms epoch). */
    at: number;
    /** The conversation it came from, while its title may be shown. */
    from: { nodeId: string; messageId: string | null; title: string } | null;
  }
  | {
    kind: 'conversation';
    /** memory_recall_docs.id: what POST /api/memory-recall/hide takes. */
    docId: number;
    /** The user's words in that turn, clipped. */
    text: string;
    at: number;
    from: { nodeId: string; messageId: string | null; title: string | null };
  };

export interface ReplyMemorySourcesResponse {
  messages: Array<{ messageId: string; sources: ReplyMemorySource[] }>;
}

/** Memory is on for everyone until they turn it off. */
export const DEFAULT_MEMORY_SETTINGS: Readonly<MemorySettings> = Object.freeze({ mode: 'auto' });

/** Longest memory body accepted, in UTF-16 code units, after trimming. */
export const MEMORY_BODY_MAX_CHARS = 2000;

/** Keywords one memory may carry, and the longest keyword, in characters after trimming. */
export const MEMORY_KEYWORDS_MAX_COUNT = 32;
export const MEMORY_KEYWORD_MAX_CHARS = 100;

/** The longest topic, in characters after trimming. */
export const MEMORY_TOPIC_MAX_CHARS = 40;

export type MemoryChangeAction = 'created' | 'updated' | 'superseded' | 'deleted' | 'approved' | 'rejected';

/** One stored change; `status` is the record's status after the change (before it, for deleted/rejected). */
export interface MemoryChangedEvent {
  ownerUserId: string;
  workspaceId: string | null;
  memoryId: string;
  action: MemoryChangeAction;
  status: MemoryStatus;
  body: string;
  origin: MemoryOrigin;
  nodeId?: string;
  supersedesId: string | null;
}

// ── REST (/api/memories, /api/memory-settings) ─────────────────────────────

export interface MemoryListResponse {
  items: MemoryRecord[];
  nextCursor: string | null;
}

/** POST /api/memories: a memory the user adds by hand (origin explicit, status active). */
export interface MemoryCreateRequest {
  scope: MemoryScope;
  kind: MemoryKind;
  body: string;
  topic?: string | null;
}

/** PATCH /api/memories/:id */
export interface MemoryUpdateRequest {
  body?: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  /** null clears it. */
  topic?: string | null;
  expectedVersion: number;
}

export type MemoryErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'version_conflict'
  | 'invalid_state'
  | 'memory_disabled';

/** Error body; `currentVersion` accompanies version_conflict. */
export interface MemoryErrorResponse {
  error: string;
  code: MemoryErrorCode | 'unauthorized';
  currentVersion?: number;
}

// ── Automatic memory extraction (C5: /api/memory-extraction) ───────────────

/**
 * The extractor's call: this workspace only, or every workspace (a preference
 * for all of the user's work, or a fact about the user themself; such
 * memories are saved in the user scope).
 */
export type MemoryExtractionScopeHint = 'workspace' | 'maybe_global';

/**
 * What automatic extraction is doing now, most blocking first:
 * off (memory mode is not auto), unsupported (this backend or the Meta agent
 * runtime cannot run it; see stateReason), paused (POST pause),
 * maintenance_paused (the Meta agent's global maintenance pause), stopped
 * (a workspace's runs stopped after repeated failures; resume restarts them),
 * budget_exhausted (the daily token limit is reached), running, waiting
 * (new turns not yet processed) and idle (up to date).
 */
export type MemoryExtractionState =
  | 'off' | 'unsupported' | 'paused' | 'maintenance_paused' | 'stopped' | 'budget_exhausted' | 'running' | 'waiting' | 'idle';

export interface MemoryExtractionRunSummary {
  id: string;
  workspaceId: string;
  state: 'active' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  sources: number;
  proposed: number;
  noChange: number;
  dropped: number;
  /** Reported by the runtime, else Michi's estimate; null while running. */
  tokens: number | null;
}

/** GET /api/memory-extraction/status, and the answer of pause/resume/cancel. */
export interface MemoryExtractionStatus {
  /** Memory mode is auto. */
  enabled: boolean;
  /** Paused for every workspace (POST /api/memory-extraction/pause without workspaceId). */
  paused: boolean;
  lastRunAt: number | null;
  /** The newest run's error when it did not succeed, or why runs are held. */
  lastError: string | null;
  /** Legacy: extracted memories still pending from an older version; 0 once startup activated them. */
  pendingCount: number;
  todayTokens: number;
  dailyTokenLimit: number;
  executionTokenLimit: number;
  state: MemoryExtractionState;
  stateReason: string | null;
  /** False on backends that cannot run background extraction (cloud, no scheduler). */
  supported: boolean;
  pausedWorkspaceIds: string[];
  /** Legacy: pending extracted memories marked maybe_global; empty once startup activated them. */
  maybeGlobalMemoryIds: string[];
  /** What extraction never proposes (EXTRACTION_EXCLUSIONS). */
  exclusions: string[];
  recentRuns: MemoryExtractionRunSummary[];
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value);
}

export function isMemoryOrigin(value: unknown): value is MemoryOrigin {
  return typeof value === 'string' && (MEMORY_ORIGINS as readonly string[]).includes(value);
}

export function isMemoryMode(value: unknown): value is MemoryMode {
  return typeof value === 'string' && (MEMORY_MODES as readonly string[]).includes(value);
}
