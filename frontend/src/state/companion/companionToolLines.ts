import type { CompanionBucket, CompanionSourceKind } from 'michi-shared';
import type { ToolCallState } from '../chatTypes';
import { normalizeToolResultEnvelope, normalizeTurnToolName } from '../../lib/turnPageReceipt';
import { metaAgentToolLine, type ToolLineNames } from '../metaChat/toolLines';

/**
 * How the Companion's chat words its tool calls: what it did in plain words
 * ("Looked at Today’s items", "Read CR-123456"), never a raw tool name
 * (`@michi/companion_items`). One line per call (toolLine) and one for an
 * activity block (workLine). The Companion's own tools are
 * backend/src/assistant/policy.ts COMPANION_OWN_TOOL_NAMES; its Michi read
 * tools (COMPANION_MICHI_READ_TOOL_NAMES) are worded as the Meta agent's are.
 */

const OWN_TOOLS = [
  'companion_items',
  'companion_item',
  'companion_check_now',
  'companion_update_item',
  'companion_save_notes',
  'companion_goal_progress',
  'companion_propose',
  'companion_publish_brief',
  'companion_set_name',
  'companion_set_notifications',
  'companion_cr_detail',
  'companion_pipeline_detail',
  'companion_email_search',
  'nothing_to_do',
] as const;
type OwnTool = typeof OWN_TOOLS[number];

const MICHI_READ_TOOLS = [
  'michi_docs', 'list_workspaces', 'list_threads', 'search_messages', 'read_node', 'read_node_overview',
  'list_panes', 'inspect_pane', 'read_pane_output', 'read_conversation_updates', 'list_tasks',
] as const;

/** Michi Memory's writes, worded by what they did: a save that was not made says so. */
const MEMORY_WRITE_TOOLS = ['memory_save', 'memory_update', 'memory_delete'] as const;
type MemoryWriteTool = typeof MEMORY_WRITE_TOOLS[number];

/** What the window knows to name what a call is about. */
export interface CompanionToolLineNames extends ToolLineNames {
  /** An open item's title by id (the snapshot's items). */
  item: (itemId: string) => string | null;
  /** A goal's text by id. */
  goal: (goalId: string) => string | null;
}

const SOURCE_WORDS: Record<CompanionSourceKind, string> = {
  michi: 'Michi conversations',
  cr: 'code reviews',
  pipeline: 'pipelines',
  email: 'email',
  calendar: 'calendar',
  // Its own items (reminders that came due, notices about its sources): never "Companion" (§1.5).
  system: 'reminders and source notices',
};

const BUCKET_WORDS: Record<CompanionBucket, string> = {
  needs_you: 'what needs you',
  update: 'updates',
  stalled: 'stalled',
  fyi: 'FYI',
};

/** What a proposal (companion_propose `kind`) suggests. */
const PROPOSAL_WORDS: Record<string, string> = {
  'goal.add': 'a goal',
  'goal.update': 'a goal change',
  'goal.remove': 'removing a goal',
  'source.update': 'a source change',
  'pipeline.watch': 'a pipeline to watch',
  'conversation.start': 'a new conversation',
  'reminder.add': 'a reminder',
  'watch.add': 'a watch',
  'rules.update': 'a change to your rules',
};

const RUNNING = new Set(['running', 'in_progress', 'pending']);

function parse(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const clip = (text: string, max = 40): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const quoted = (text: string, max?: number) => `“${clip(text, max)}”`;

function sentence(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "CR-123456" from what the model passed (CR-123456, 123456 or its link); null when it is none of those. */
function crName(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const match = /CR-(\d+)/i.exec(raw) ?? /^(\d+)$/.exec(raw);
  return match ? `CR-${match[1]}` : null;
}

function ownTool(tool: Pick<ToolCallState, 'title'>): OwnTool | null {
  return normalizeTurnToolName(tool.title, OWN_TOOLS) as OwnTool | null;
}

/** The line for one of the Companion's own tools, as it runs (`doing`) or once it ran. */
function ownLine(name: OwnTool, input: Record<string, unknown>, doing: boolean, names: CompanionToolLineNames): string {
  const say = (now: string, then: string) => (doing ? now : then);
  const item = () => {
    const id = str(input.itemId);
    const title = id ? names.item(id) : null;
    return title ? quoted(title) : 'an item';
  };
  switch (name) {
    case 'companion_items': {
      const source = str(input.source);
      const bucket = str(input.bucket);
      const scope = [
        source && source in SOURCE_WORDS ? SOURCE_WORDS[source as CompanionSourceKind] : null,
        bucket && bucket in BUCKET_WORDS ? BUCKET_WORDS[bucket as CompanionBucket] : null,
      ].filter((part): part is string => !!part);
      return [say('Looking at Today’s items', 'Looked at Today’s items'), ...scope].join(' · ');
    }
    case 'companion_item': return `${say('Looking at', 'Looked at')} ${item()}`;
    case 'companion_check_now': {
      const sources = Array.isArray(input.sources)
        ? input.sources.filter((source): source is CompanionSourceKind => typeof source === 'string' && source in SOURCE_WORDS).map((source) => SOURCE_WORDS[source])
        : [];
      return `${say('Checking', 'Checked')} ${sources.length > 0 ? sentence([...new Set(sources)]) : 'sources'}`;
    }
    case 'companion_update_item':
      switch (input.action) {
        case 'snooze': return `${say('Snoozing', 'Snoozed')} ${item()}`;
        case 'dismiss': return `${say('Marking', 'Marked')} ${item()} done`;
        case 'mute': return `${say('Muting', 'Muted')} ${item()}`;
        case 'restore': return `${say('Bringing back', 'Brought back')} ${item()}`;
        default: return `${say('Updating', 'Updated')} ${item()}`;
      }
    case 'companion_save_notes': return say('Saving its notes', 'Saved its notes');
    case 'companion_goal_progress': {
      const id = str(input.goalId);
      const goal = id ? names.goal(id) : null;
      return `${say('Noting progress on', 'Noted progress on')} ${goal ? quoted(goal) : 'a goal'}`;
    }
    case 'companion_propose': return `${say('Suggesting', 'Suggested')} ${PROPOSAL_WORDS[str(input.kind) ?? ''] ?? 'a change'}`;
    case 'companion_publish_brief': return say('Writing today’s brief', 'Wrote today’s brief');
    case 'companion_set_name': {
      const next = str(input.name);
      return next ? `${say('Changing its name to', 'Changed its name to')} ${quoted(next)}` : say('Changing its name', 'Changed its name');
    }
    case 'companion_set_notifications':
      switch (str(input.level)) {
        case 'all': return say('Turning on all notifications', 'Turned on all notifications');
        case 'approval-only': return say('Setting notifications to only what needs you', 'Set notifications to only what needs you');
        case 'off': return say('Turning off notifications', 'Turned off notifications');
        default: return say('Changing your notifications', 'Changed your notifications');
      }
    case 'companion_cr_detail': return `${say('Reading', 'Read')} ${crName(input.cr) ?? 'a CR'}`;
    case 'companion_pipeline_detail': {
      const pipeline = str(input.pipeline);
      return `${say('Reading', 'Read')} ${pipeline ? `pipeline ${clip(pipeline)}` : 'a pipeline'}`;
    }
    case 'companion_email_search': {
      const query = str(input.query);
      return `${say('Searching', 'Searched')} email${query ? ` for ${quoted(query, 24)}` : ''}`;
    }
    case 'nothing_to_do': return 'Nothing worth a message';
  }
}

/** The memory tool's answer: its last object with a `status` (memoryTools.ts jsonResult). */
function memoryStatus(tool: ToolCallState): { status: string | null; reason: string | null } {
  const values = normalizeToolResultEnvelope(tool.output);
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value && typeof value === 'object' && !Array.isArray(value) && 'status' in value) {
      const record = value as Record<string, unknown>;
      return { status: str(record.status), reason: str(record.reason) };
    }
  }
  return { status: null, reason: null };
}

const NOT_SAVED_BECAUSE: Record<string, string> = {
  deleted_before: 'you removed it before',
  companion_material: 'this turn read check-in material',
};

/**
 * A memory write in V: "Remembered …", "Updated a memory", "Forgot a
 * memory". A save or update the backend did not make (status not_saved:
 * removed before, or a turn that read check-in material) is an ordinary
 * answer, worded as not saved, never as saved.
 */
function memoryLine(name: MemoryWriteTool, tool: ToolCallState, doing: boolean): string {
  const input = parse(tool.inputJson);
  if (doing) return name === 'memory_save' ? 'Saving a memory' : name === 'memory_update' ? 'Updating a memory' : 'Forgetting a memory';
  if (tool.status === 'failed') return name === 'memory_delete' ? 'Couldn’t forget a memory' : `Couldn’t ${name === 'memory_save' ? 'save' : 'update'} a memory`;
  const { status, reason } = memoryStatus(tool);
  if (status === 'not_saved') {
    const why = reason ? NOT_SAVED_BECAUSE[reason] : undefined;
    return `Didn’t save it${why ? `: ${why}` : ''}`;
  }
  if (name === 'memory_delete') return 'Forgot a memory';
  if (name === 'memory_update') return status === 'unchanged' ? 'Memory already said that' : 'Updated a memory';
  const body = str(input.body);
  return body ? `Remembered ${quoted(body)}` : 'Remembered it';
}

/**
 * One line for one call in the Companion's chat (MetaChatDecorations
 * toolLine): its own tools in plain words, Michi Memory's writes by what
 * they did, its Michi read tools as the Meta agent words them, null for
 * anything else (the generic row).
 */
export function companionToolLine(tool: ToolCallState, names: CompanionToolLineNames): string | null {
  const memory = normalizeTurnToolName(tool.title, MEMORY_WRITE_TOOLS) as MemoryWriteTool | null;
  if (memory) return memoryLine(memory, tool, !tool.status || RUNNING.has(tool.status));
  const name = ownTool(tool);
  if (!name) return metaAgentToolLine(tool, names);
  return ownLine(name, parse(tool.inputJson), !tool.status || RUNNING.has(tool.status), names);
}

/** A tool's part of an activity block's line, counted ("read 4 CRs"); null for one that says nothing. */
function phrase(name: OwnTool | 'michi' | 'tasks' | 'docs', tools: readonly ToolCallState[]): string | null {
  const n = tools.length;
  switch (name) {
    case 'companion_items': return 'looked at Today’s items';
    case 'companion_item': return n === 1 ? 'looked at an item' : `looked at ${n} items`;
    case 'companion_check_now': return 'checked sources';
    case 'companion_update_item': return n === 1 ? 'updated an item' : `updated ${n} items`;
    case 'companion_save_notes': return 'saved its notes';
    case 'companion_goal_progress': return 'noted goal progress';
    case 'companion_propose': return n === 1 ? 'suggested a change' : `suggested ${n} changes`;
    case 'companion_publish_brief': return 'wrote today’s brief';
    case 'companion_set_name': return 'changed its name';
    case 'companion_set_notifications': return 'changed your notifications';
    case 'companion_cr_detail': {
      // Distinct CRs: reading one twice is still one CR (a call it cannot name counts on its own).
      const crs = new Set(tools.map((tool) => crName(parse(tool.inputJson).cr) ?? `call:${tool.id}`));
      if (crs.size > 1) return `read ${crs.size} CRs`;
      return `read ${crName(parse(tools[0].inputJson).cr) ?? 'a CR'}`;
    }
    case 'companion_pipeline_detail': return n === 1 ? 'read a pipeline' : `read ${n} pipelines`;
    case 'companion_email_search': return n === 1 ? 'searched email' : `searched email ${n} times`;
    case 'nothing_to_do': return null;
    case 'michi': return 'looked at your conversations';
    case 'tasks': return 'looked at your tasks';
    case 'docs': return 'read the Michi docs';
  }
}

const MAX_PHRASES = 4;

/**
 * One line for what a finished activity block did (MetaChatDecorations
 * workLine): a lone call's own line, else its kinds of work in order
 * ("Looked at Today’s items, checked sources and read 4 CRs"). null when
 * none of the calls is the Companion's, so the generic header stays.
 */
export function companionWorkLine(tools: readonly ToolCallState[], names: CompanionToolLineNames): string | null {
  const groups = new Map<OwnTool | 'michi' | 'tasks' | 'docs', ToolCallState[]>();
  let others = 0;
  for (const tool of tools) {
    const own = ownTool(tool);
    const michi = own ? null : normalizeTurnToolName(tool.title, MICHI_READ_TOOLS);
    const key = own ?? (michi === 'list_tasks' ? 'tasks' : michi === 'michi_docs' ? 'docs' : michi ? 'michi' : null);
    if (!key) { others += 1; continue; }
    groups.set(key, [...(groups.get(key) ?? []), tool]);
  }
  if (groups.size === 0) return null;
  if (tools.length === 1) {
    const line = companionToolLine({ ...tools[0], status: 'completed' }, names);
    if (line) return line;
  }
  const phrases = [...groups].map(([key, group]) => phrase(key, group)).filter((part): part is string => !!part);
  if (others > 0) phrases.push(`used ${others} more ${others === 1 ? 'tool' : 'tools'}`);
  if (phrases.length === 0) return 'Nothing worth a message';
  const shown = phrases.length > MAX_PHRASES ? [...phrases.slice(0, MAX_PHRASES - 1), 'more'] : phrases;
  const line = sentence(shown);
  return line.charAt(0).toUpperCase() + line.slice(1);
}
