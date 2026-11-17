import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { MEMORY_TOPIC_MAX_CHARS, type MemoryImportSource, type MemoryKind } from 'michi-shared';
import { getDb } from '../db';
import { memoryDay, memoryRef, parseRef } from './memoryRefs';
import { labelMemoryTopic } from './memoryService';

/**
 * The topic pass: Michi files the memories that have no topic
 * (MemoryRecord.topic) under the broad area they belong to, as saving does for
 * new ones (memory_save, extraction): what was saved before topics existed,
 * imported notes (a file's name names one note, not an area), and anything
 * saved without one. A run of kind 'topics' on the maintenance scheduler
 * (extractionRun.planTopicsRun), between consolidation and the profile, lists
 * up to TOPIC_PASS_LIMITS.batch of them, oldest row first, with the topics in
 * use; one direct structured call answers. It sets only the topic
 * (memoryService.labelMemoryTopic): never a body, a version or who saved it.
 * A runtime without direct calls (Kiro, Crew) does not run it.
 *
 * A per-owner cursor (meta) moves past the rows a run lists when it is
 * planned, so a failed run never retries them; rows saved later come in the
 * next run.
 */

export const TOPIC_PASS_LIMITS = Object.freeze({
  /** Notes one run lists at most. */
  batch: 60,
  /** What the prompt shows of a note's body. */
  bodyChars: 300,
  /** Topics in use the prompt lists at most, most used first. */
  topicsListed: 40,
});

export const TOPICS_RUN_ID_PREFIX = 'mtr-';

const REF_MAX = 40;

function cursorKey(ownerUserId: string): string {
  return `memory_topic_pass:${ownerUserId}`;
}

/** The last row a run listed (memories.row_id); 0 before the first. */
export function topicPassCursor(ownerUserId: string): number {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey(ownerUserId)) as { value: string } | undefined;
  const value = Number(row?.value ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function setTopicPassCursor(ownerUserId: string, rowId: number): void {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(cursorKey(ownerUserId), String(rowId));
}

interface UntaggedRow {
  row_id: number;
  id: string;
  version: number;
  kind: MemoryKind;
  workspace_id: string | null;
  body: string;
  import_source: MemoryImportSource | null;
  observed_at: number | null;
  created_at: number;
}

const UNTAGGED_SQL = `SELECT row_id, id, version, kind, workspace_id, body, import_source, observed_at, created_at FROM memories
  WHERE owner_user_id = ? AND status = 'active' AND topic IS NULL AND row_id > ? ORDER BY row_id LIMIT ?`;

/** Whether an active memory past the cursor has no topic. */
export function topicPassPending(ownerUserId: string): boolean {
  return getDb().prepare(UNTAGGED_SQL).all(ownerUserId, topicPassCursor(ownerUserId), 1).length > 0;
}

function topicsInUseEverywhere(ownerUserId: string, limit: number): string[] {
  return (getDb().prepare(`SELECT topic FROM memories WHERE owner_user_id = ? AND topic IS NOT NULL AND status = 'active'
      GROUP BY topic ORDER BY COUNT(*) DESC, MAX(updated_at) DESC LIMIT ?`).all(ownerUserId, limit) as Array<{ topic: string }>)
    .map((row) => row.topic);
}

function workspaceName(workspaceId: string): string {
  const row = getDb().prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId) as { name: string | null } | undefined;
  return row?.name?.trim() || 'a workspace';
}

const IMPORT_NAMES: Record<MemoryImportSource, string> = { claude: 'Claude Code', codex: 'Codex', kiro: 'Kiro' };

function clip(text: string, chars: number): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  const all = Array.from(line);
  return all.length > chars ? `${all.slice(0, chars - 1).join('')}…` : line;
}

export function buildTopicPassInstructions(): string {
  return [
    'You file the notes Michi keeps about the user under topics, as Settings › Memory groups them.',
    '- A topic is the broad area of the user\'s life or work a note belongs to, one that other notes share (Work, Home, Travel, Health, Family, or a named project, person or pet), in the language of the note.',
    '- Reuse a topic from "Topics in use" unless none fits; a new topic should be able to hold several notes.',
    `- Give every listed note one topic of at most ${MEMORY_TOPIC_MAX_CHARS} characters.`,
    'Answer with the JSON object only: { "topics": [{ "ref": "m:…", "topic": "…" }] }.',
  ].join('\n');
}

export interface TopicPassListing { ref: string; memoryId: string }

export interface TopicPassPrompt {
  system: string;
  prompt: string;
  listed: TopicPassListing[];
  /** The last row scanned: the cursor once the run is planned. */
  through: number;
}

/**
 * The prompt for the next batch, or null when no untagged memory is left past
 * the cursor. `liveWorkspace`: a workspace whose memories may be listed (one
 * archived, deleted or with AI navigation off is passed over).
 */
export function buildTopicPassPrompt(input: { ownerUserId: string; now: number; liveWorkspace: (workspaceId: string) => boolean }): TopicPassPrompt | null {
  const rows = getDb().prepare(UNTAGGED_SQL).all(input.ownerUserId, topicPassCursor(input.ownerUserId), TOPIC_PASS_LIMITS.batch * 2) as unknown as UntaggedRow[];
  if (rows.length === 0) return null;
  const picked: UntaggedRow[] = [];
  let through = 0;
  for (const row of rows) {
    if (picked.length >= TOPIC_PASS_LIMITS.batch) break;
    through = row.row_id;
    if (row.workspace_id === null || input.liveWorkspace(row.workspace_id)) picked.push(row);
  }
  if (picked.length === 0) return { system: buildTopicPassInstructions(), prompt: '', listed: [], through };
  const names = new Map<string, string>();
  const scope = (row: UntaggedRow) => {
    if (row.workspace_id === null) return 'everywhere';
    if (!names.has(row.workspace_id)) names.set(row.workspace_id, workspaceName(row.workspace_id));
    return `workspace ${JSON.stringify(names.get(row.workspace_id))}`;
  };
  const listed = picked.map((row) => ({ ref: memoryRef(row.row_id, row.version), memoryId: row.id }));
  const topics = topicsInUseEverywhere(input.ownerUserId, TOPIC_PASS_LIMITS.topicsListed);
  const lines = [
    `Michi Memory topics · today ${memoryDay(input.now)} · ${picked.length} note${picked.length === 1 ? '' : 's'}`,
    '',
    topics.length ? `Topics in use: ${topics.map((topic) => JSON.stringify(topic)).join(', ')}` : 'Topics in use: none yet.',
    '',
    'Notes:',
    ...picked.map((row, index) => {
      const marks = [row.kind, scope(row), ...(row.import_source ? [`from ${IMPORT_NAMES[row.import_source]}`] : []),
        `said ${memoryDay(row.observed_at ?? row.created_at)}`];
      return `- ${listed[index].ref} · ${marks.join(' · ')}: ${clip(row.body, TOPIC_PASS_LIMITS.bodyChars)}`;
    }),
  ];
  return { system: buildTopicPassInstructions(), prompt: lines.join('\n'), listed, through };
}

/** Moves the owner's cursor to `through` (never back). */
export function advanceTopicPass(ownerUserId: string, through: number): void {
  if (through > topicPassCursor(ownerUserId)) setTopicPassCursor(ownerUserId, through);
}

export const TOPICS_PAYLOAD_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['topics'],
  properties: {
    topics: {
      type: 'array',
      maxItems: TOPIC_PASS_LIMITS.batch,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'topic'],
        properties: {
          ref: { type: 'string', minLength: 1, maxLength: REF_MAX },
          // Longer is cut to MEMORY_TOPIC_MAX_CHARS when saved, not refused.
          topic: { type: 'string', minLength: 1, maxLength: MEMORY_TOPIC_MAX_CHARS * 3 },
        },
      },
    },
  },
});

export interface TopicsPayload { topics: Array<{ ref: string; topic: string }> }

export class TopicsPayloadError extends Error {}

let payloadCheck: ((value: unknown) => { valid: boolean; errorMessage?: string }) | null = null;

/**
 * The answer as stored: refs the run listed (as it listed them), topics on
 * one line, one per note (the last wins). strict: a ref the run did not list
 * fails the answer; else it is left out.
 */
export function validateTopicsPayload(raw: unknown, listed: readonly TopicPassListing[], options: { strict?: boolean } = {}): TopicsPayload {
  payloadCheck ??= new AjvJsonSchemaValidator().getValidator(TOPICS_PAYLOAD_SCHEMA as Record<string, unknown>);
  const checked = payloadCheck(raw);
  if (!checked.valid) throw new TopicsPayloadError(checked.errorMessage ?? 'the answer does not match the schema');
  const byRef = new Map<string, string>();
  for (const entry of listed) {
    const parsed = parseRef(entry.ref);
    if (parsed?.kind === 'memory') byRef.set(`${parsed.rowId}v${parsed.version}`, entry.ref);
  }
  const out = new Map<string, string>();
  const problems: string[] = [];
  for (const [index, entry] of (raw as TopicsPayload).topics.entries()) {
    const parsed = parseRef(entry.ref);
    const ref = parsed?.kind === 'memory' ? byRef.get(`${parsed.rowId}v${parsed.version}`) : undefined;
    if (!ref) {
      if (options.strict) problems.push(`topics[${index}].ref ${JSON.stringify(entry.ref)} is not a listed note`);
      continue;
    }
    const topic = entry.topic.replace(/\s+/gu, ' ').trim();
    if (topic) out.set(ref, topic);
  }
  if (problems.length) throw new TopicsPayloadError(problems.join('; '));
  return { topics: [...out].map(([ref, topic]) => ({ ref, topic })) };
}

/** Sets each listed note's topic when it still has none; returns how many it set. */
export function commitTopicsPayload(payload: TopicsPayload, ctx: { ownerUserId: string; listed: readonly TopicPassListing[] }): number {
  const ids = new Map(ctx.listed.map((entry) => [entry.ref, entry.memoryId]));
  let labeled = 0;
  for (const { ref, topic } of payload.topics) {
    const id = ids.get(ref);
    if (id && labelMemoryTopic({ ownerUserId: ctx.ownerUserId }, id, topic)) labeled += 1;
  }
  return labeled;
}
