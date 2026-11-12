import { estimateTokens } from 'michi-shared';
import type { MaintenanceExecutionContext } from '../../agents/types';
import { getDb } from '../db';
import {
  CONSOLIDATION_PAYLOAD_SCHEMA, CONSOLIDATION_RUN_ID_PREFIX, ConsolidationPayloadError, consolidationChangesToday, listedConsolidationBatch,
  parseConsolidationListing, plannedCursorOf, validateConsolidationPayload,
} from './consolidation';
import { MEMORY_CONSOLIDATE_TOOL_NAME, MEMORY_EXTRACTION_TOOL_NAMES, MEMORY_PROFILE_TOOL_NAME, type MemoryExtractionToolName } from './extractionProfile';
import {
  chargeExtractionCall, getExtractionRun, listExtractionSources, recordExtractionDecision, recordExtractionInvalidCall,
  stageExtractionPayload, type ExtractionRunRecord,
} from './extractionRepository';
import { EXTRACTION_RUN_ID_PREFIX, MEMORY_EXTRACTION_LIMITS, PROFILE_RUN_ID_PREFIX } from './extractionRun';
import { ownsUnattendedRun } from '../scheduledJobs/repository';
import { activeMichiNoteCount } from './memoryRepository';
import { EXTRACTION_PAYLOAD_SCHEMA, ExtractionPayloadError, validateExtractionPayload, type ExtractionPayload } from './extractionV2';
import { getMemorySettings } from './memoryService';
import { listedProfileSources, PROFILE_PAYLOAD_SCHEMA, ProfilePayloadError, validateProfilePayload } from './userProfile';

/**
 * The tools of an automatic memory session, for a runtime that cannot answer
 * a run with one direct structured call (extractionDirect.ts answers it
 * then, through stageMemoryAnswer here), one per kind of run:
 *
 *  - memory_extract: the prompt carries the run's source turns
 *    (extractionRun.ts), so the model answers with a single call: every
 *    memory of those turns and every turn's keyphrases
 *    (extractionV2.EXTRACTION_PAYLOAD_SCHEMA). A valid call is every source
 *    turn's receipt; the settling run commits it (commitExtractionPayload)
 *    with the conversation's position.
 *  - memory_profile: the prompt lists the user's notes, and the model answers
 *    with the profile (userProfile.PROFILE_PAYLOAD_SCHEMA); the settling run
 *    stores it (commitProfilePayload).
 *  - memory_consolidate: the prompt lists groups of Michi's notes, and the
 *    model answers with a decision for each (consolidation.ts,
 *    CONSOLIDATION_PAYLOAD_SCHEMA); the settling run checks them again and
 *    applies those that pass (commitConsolidation).
 *
 * Each call is bound to the run the scheduler claimed (the context's planId)
 * and rechecks that run's authority; a tool refuses the other kind's run
 * without counting it. An invalid call is a tool error the model can repair
 * and is counted: after MEMORY_EXTRACTION_LIMITS.maxRepairs repairs the next
 * invalid call ends the run's answer (extraction skips its turns as
 * unreadable; a rebuild keeps the profile it had). The last repair's check
 * is lenient: a profile line that breaks a rule no longer fails the answer
 * (the line is left out). The first valid call stages the answer. Nothing here writes a memory, runs a
 * command or reaches outside Michi.
 */

export interface ExtractionToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  details?: unknown;
}

export interface ExtractionToolDefinition {
  name: MemoryExtractionToolName;
  description: string;
  /**
   * What the runtime lists: the fields, their types and descriptions,
   * nothing it would enforce itself. Required fields, enums and lengths are
   * checked here against `schema`, so a malformed call reaches the host and
   * counts.
   */
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  /** The strict schema every call must satisfy. */
  schema: Record<string, unknown>;
  execute(args: unknown): ExtractionToolResult;
}

/** An answer that breaks its schema or a rule; its message lists the problems for the model to fix. */
export class InvalidMemoryAnswer extends Error {}

const text = (value: unknown) => JSON.stringify(value);
const success = (value: unknown): ExtractionToolResult => ({ content: [{ type: 'text', text: text(value) }], details: value });
const failure = (message: string): ExtractionToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

type Described = string | { description: string; items: Record<string, Described> };

/** What each memory_extract field means, as the runtime lists it. */
const EXTRACT_DESCRIPTIONS: Record<string, Described> = {
  memories: {
    description: 'Every memory worth keeping from these turns; [] when there is none.',
    items: {
      op: 'Required. add, or update to replace the existing memory named by target.',
      target: 'For op update: the ref of an existing memory the prompt lists.',
      explicit: 'Optional. true when the user asked in their own words to remember it; with op update, it makes an automatic memory (not savedByUser) theirs.',
      kind: 'Required. preference, fact, decision or convention.',
      about: 'Required. user (the user themself and all their work, wherever said) or project (this workspace\'s own project only).',
      body: 'Required. At most 300 characters: the memory, self-contained, in the user\'s language, with absolute dates.',
      keywords: 'Required. 3-10 search terms in both Chinese and English.',
      event_date: 'Optional. YYYY-MM-DD of the event the memory describes, past or planned.',
      quote: 'Required. The user\'s own words that state it, copied exactly from the turn\'s "user" text.',
      source_turn: 'Required. The "turn" id of the turn it comes from.',
    },
  },
  turn_keys: {
    description: 'One entry for every turn: { source_turn, keys }.',
    items: {
      source_turn: 'Required. The turn\'s "turn" id.',
      keys: 'Required. 5-15 keyphrases in both Chinese and English to find this exchange later.',
    },
  },
  exclude_turns: 'The "turn" ids of turns whose content the user asked not to remember or took back: nothing is saved from them; [] when none.',
  forget: 'The refs (m:…) of listed memories not marked savedByUser whose content these turns decline or take back, said before them: they are deleted; [] when none.',
};

/** What each memory_consolidate field means, as the runtime lists it. */
const CONSOLIDATE_DESCRIPTIONS: Record<string, Described> = {
  decisions: {
    description: 'One decision for each > note of every group, and one for a - note only when you change it.',
    items: {
      ref: 'Required. The note\'s ref, exactly as listed (m:…).',
      op: 'Required. keep (the default), duplicate (into already says everything it says) or outdated (into, said later, makes it no longer true).',
      into: 'Required. For duplicate or outdated, the ref of another note of the same group; null for keep.',
      why: 'Required. At most 80 characters: why.',
    },
  },
};

/** What each memory_profile field means, as the runtime lists it. */
const PROFILE_DESCRIPTIONS: Record<string, Described> = {
  sections: {
    description: 'The profile, grouped by topic; [] when nothing is worth keeping.',
    items: {
      topic: 'Required. A short topic.',
      lines: {
        description: 'Required. The lines under the topic.',
        items: {
          text: 'Required. One fact about the user as a short phrase, in the language the prompt names.',
          refs: 'Required. The refs (m:…) of the listed notes the line rests on.',
        },
      },
    },
  },
};

/** The listed form of a strict schema: the same fields and types, nested, with descriptions; nothing enforced. */
function listed(schema: Record<string, unknown>, describe: Record<string, Described>): ExtractionToolDefinition['parameters'] {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const field = (definition: Record<string, unknown>, about: Described | undefined): Record<string, unknown> => {
    const description = typeof about === 'string' ? about : about?.description;
    const out: Record<string, unknown> = { type: definition.type, ...(description ? { description } : {}) };
    const items = definition.items as Record<string, unknown> | undefined;
    if (items?.type === 'object') {
      const nested = (items.properties ?? {}) as Record<string, Record<string, unknown>>;
      const notes = typeof about === 'object' ? about.items : {};
      out.items = { type: 'object', properties: Object.fromEntries(Object.entries(nested).map(([key, value]) => [key, field(value, notes[key])])) };
    } else if (items) {
      out.items = { type: items.type };
    }
    return out;
  };
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, field(value, describe[key])])),
    required: [],
  };
}

/** The run the context is bound to, if it still owns its scheduler run. Not a counted error: the model cannot fix it. */
function authorize(context: MaintenanceExecutionContext, now: number): ExtractionRunRecord {
  if (![EXTRACTION_RUN_ID_PREFIX, PROFILE_RUN_ID_PREFIX, CONSOLIDATION_RUN_ID_PREFIX].some((prefix) => context.planId.startsWith(prefix))) {
    throw new Error('This session is not bound to an automatic memory run');
  }
  const run = getExtractionRun(context.planId, context.ownerUserId);
  if (!run || run.workspaceId !== context.workspaceId || run.jobId !== context.jobId || run.runId !== context.runId) {
    throw new Error('This automatic memory run no longer owns the tool call; stop');
  }
  const consumer = getDb().prepare(`SELECT 1 FROM scheduled_job_runs r
      JOIN memory_extraction_cursors c ON c.workspace_id = ? AND c.owner_user_id = ? AND c.job_id = r.job_id
      WHERE r.id = ? AND r.job_id = ?`).get(run.workspaceId, run.ownerUserId, run.runId, run.jobId);
  if (!consumer || run.state !== 'active' || !ownsUnattendedRun(run.runId, context.claimedBy, now)) {
    throw new Error('This automatic memory run was stopped or lost its scheduler ownership; stop calling tools');
  }
  if (getMemorySettings(run.ownerUserId).mode !== 'auto') throw new Error('Automatic memory was turned off; stop calling tools');
  return run;
}

const DONE_NOTE = 'Recorded. You are done: reply with one word and stop.';
const CONSOLIDATE_DONE_NOTE = DONE_NOTE;

/** Stages the payload; it is every source turn's receipt: proposed for a turn it names, no change for the rest. */
function stageExtraction(run: ExtractionRunRecord, payload: ExtractionPayload, now: number) {
  if (!stageExtractionPayload(run.id, JSON.stringify(payload))) return { status: 'already_recorded', note: DONE_NOTE };
  const sources = listExtractionSources(run.id);
  const named = new Set(payload.memories.map((memory) => memory.source_turn));
  const single = sources.length === 1 && payload.memories.length > 0;
  for (const source of sources) {
    const proposed = single || named.has(source.sourceTurnId);
    recordExtractionDecision(run.id, source.sourceTurnId, proposed ? 'proposed' : 'no_change', proposed ? null : 'nothing to save', now);
  }
  return {
    status: 'recorded',
    memories: payload.memories.length,
    turnKeys: payload.turn_keys.length,
    ...(payload.exclude_turns.length ? { excludedTurns: payload.exclude_turns.length } : {}),
    ...(payload.forget.length ? { forget: payload.forget.length } : {}),
    note: DONE_NOTE,
  };
}

/**
 * Validates an answer for this run and stages it, as the tool call or the
 * direct call (extractionDirect.ts) gave it: an extraction run's payload
 * (validateExtractionPayload) with every source turn's receipt, or a profile
 * run's profile (validateProfilePayload, lenient once no repair is left).
 * Throws InvalidMemoryAnswer listing the problems. Returns what the tool
 * reports.
 */
export function stageMemoryAnswer(run: ExtractionRunRecord, raw: unknown, now: number): Record<string, unknown> {
  if (run.kind === 'consolidate') {
    const batch = listedConsolidationBatch(run.ownerUserId, parseConsolidationListing(run.related), plannedCursorOf(run.ownerUserId, run.id));
    let payload;
    try {
      // While a repair is left a decision that breaks a rule fails the answer; the last one keeps such notes as they are.
      payload = validateConsolidationPayload(raw, batch, {
        strict: run.invalidCalls < MEMORY_EXTRACTION_LIMITS.maxRepairs,
        appliedToday: consolidationChangesToday(run.ownerUserId, now), activeMichiNotes: activeMichiNoteCount(run.ownerUserId),
      });
    } catch (error) {
      if (error instanceof ConsolidationPayloadError) throw new InvalidMemoryAnswer(error.message);
      throw error;
    }
    if (!stageExtractionPayload(run.id, JSON.stringify(payload))) return { status: 'already_recorded', note: CONSOLIDATE_DONE_NOTE };
    return { status: 'recorded', decisions: payload.decisions.length, note: CONSOLIDATE_DONE_NOTE };
  }
  if (run.kind === 'profile') {
    const sources = listedProfileSources(run.ownerUserId, run.related);
    let payload;
    try {
      // While a repair is left a line that breaks a rule fails the answer; the last one leaves such lines out.
      payload = validateProfilePayload(raw, { sources, strict: run.invalidCalls < MEMORY_EXTRACTION_LIMITS.maxRepairs });
    } catch (error) {
      if (error instanceof ProfilePayloadError) throw new InvalidMemoryAnswer(error.message);
      throw error;
    }
    if (!stageExtractionPayload(run.id, JSON.stringify(payload))) return { status: 'already_recorded', note: DONE_NOTE };
    return { status: 'recorded', lines: payload.sections.reduce((sum, section) => sum + section.lines.length, 0), note: DONE_NOTE };
  }
  let payload: ExtractionPayload;
  try { payload = validateExtractionPayload(raw); } catch (error) {
    if (error instanceof ExtractionPayloadError) throw new InvalidMemoryAnswer(error.message);
    throw error;
  }
  return stageExtraction(run, payload, now);
}

const EXTRACT: { name: MemoryExtractionToolName; description: string; schema: Record<string, unknown> } = {
  name: MEMORY_EXTRACTION_TOOL_NAMES[0],
  description: 'Record this run\'s answer in one call: the memories of its turns (each quoting the user\'s own words), every turn\'s keyphrases, and what the user declined.',
  schema: EXTRACTION_PAYLOAD_SCHEMA as Record<string, unknown>,
};

const PROFILE: typeof EXTRACT = {
  name: MEMORY_PROFILE_TOOL_NAME,
  description: 'Record the user\'s profile in one call: short lines grouped by topic, each citing the listed notes it rests on.',
  schema: PROFILE_PAYLOAD_SCHEMA as Record<string, unknown>,
};

const CONSOLIDATE: typeof EXTRACT = {
  name: MEMORY_CONSOLIDATE_TOOL_NAME,
  description: 'Record this run\'s decisions in one call: keep each listed note, or put Michi\'s own note into another note of its group that it duplicates or that replaced it.',
  schema: CONSOLIDATION_PAYLOAD_SCHEMA as Record<string, unknown>,
};

/** What a run of each kind does, and its tool, for a refusal of another kind's tool. */
const RUN_TASK: Record<ExtractionRunRecord['kind'], { does: string; tool: MemoryExtractionToolName; failed: string }> = {
  extract: {
    does: 'reads conversation turns', tool: MEMORY_EXTRACTION_TOOL_NAMES[0],
    failed: 'its turns are skipped and nothing will be saved',
  },
  profile: { does: 'writes the user\'s profile', tool: MEMORY_PROFILE_TOOL_NAME, failed: 'the profile stays as it was' },
  consolidate: { does: 'tidies Michi\'s own notes', tool: MEMORY_CONSOLIDATE_TOOL_NAME, failed: 'every note stays as it was' },
};

/**
 * Answers one call: authority, the run's kind and state, then `answer` (which
 * stages the answer or throws InvalidMemoryAnswer), counting invalid calls.
 */
function serve(
  name: MemoryExtractionToolName, kind: ExtractionRunRecord['kind'],
  context: MaintenanceExecutionContext | null, now: number, answer: (run: ExtractionRunRecord) => unknown,
): ExtractionToolResult {
  if (!context) return failure('No automatic memory run owns this tool call');
  let run: ExtractionRunRecord;
  try { run = authorize(context, now); } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
  if (run.kind !== kind) {
    return failure(`This run ${RUN_TASK[run.kind].does}: answer with ${RUN_TASK[run.kind].tool}, not ${name}.`);
  }
  if (run.stoppedReason === 'invalid_limit') {
    return failure(kind === 'profile'
      ? `This run already failed after ${run.invalidCalls} invalid tool calls; the profile stays as it was. Stop calling tools.`
      : kind === 'consolidate'
        ? `This run already failed after ${run.invalidCalls} invalid tool calls; every note stays as it was. Stop calling tools.`
        : `This automatic memory run already failed after ${run.invalidCalls} invalid tool calls; its turns are skipped and nothing will be saved. Stop calling tools.`);
  }
  // One answer per run: a repeated call changes nothing and is not an error the model must repair.
  if (run.payload !== null) return success({ status: 'already_recorded', note: kind === 'consolidate' ? CONSOLIDATE_DONE_NOTE : DONE_NOTE });
  try {
    return success(answer(run));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof InvalidMemoryAnswer)) return failure(message);
    const { invalidCalls, stopped } = recordExtractionInvalidCall(run.id, MEMORY_EXTRACTION_LIMITS.maxRepairs);
    if (stopped) {
      const outcome = RUN_TASK[kind].failed;
      return failure(`Invalid ${name} call: ${message}. That was invalid call ${invalidCalls}, past the ${MEMORY_EXTRACTION_LIMITS.maxRepairs} repairs this run allows, so the run failed: ${outcome}. Stop calling tools.`);
    }
    const left = MEMORY_EXTRACTION_LIMITS.maxRepairs - invalidCalls + 1;
    return failure(`Invalid ${name} call: ${message}. Fix the arguments and call again (${left} repair${left === 1 ? '' : 's'} left in this run).`);
  }
}

/** Builds the tools, bound to whatever automatic memory run the session's current turn carries. */
export function createMemoryExtractionTools(
  contextSource: MaintenanceExecutionContext | (() => MaintenanceExecutionContext | null),
  dependencies: { now?: () => number } = {},
): ExtractionToolDefinition[] {
  const currentTime = dependencies.now ?? Date.now;
  const getContext = typeof contextSource === 'function' ? contextSource : () => contextSource;
  const tool = (definition: typeof EXTRACT, kind: ExtractionRunRecord['kind'], describe: Record<string, Described>): ExtractionToolDefinition => ({
    ...definition,
    parameters: listed(definition.schema, describe),
    execute: (raw: unknown) => {
      const now = currentTime();
      return serve(definition.name, kind, getContext(), now, (run) => {
        const result = stageMemoryAnswer(run, raw, now);
        chargeExtractionCall(run.id, estimateTokens(text(raw)) + estimateTokens(text(result)));
        return result;
      });
    },
  });
  const extract = tool(EXTRACT, 'extract', EXTRACT_DESCRIPTIONS);
  const profile = tool(PROFILE, 'profile', PROFILE_DESCRIPTIONS);
  const consolidate = tool(CONSOLIDATE, 'consolidate', CONSOLIDATE_DESCRIPTIONS);
  const tools = [extract, profile, consolidate];
  if (tools.map((tool) => tool.name).join('|') !== MEMORY_EXTRACTION_TOOL_NAMES.join('|')) {
    throw new Error('Memory extraction tools differ from the approved extraction profile');
  }
  return tools;
}
