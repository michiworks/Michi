import type { ToolCallState } from '../../../state/chatTypes';
import { michiToolName, michiToolPhrase } from '../michiToolCopy';
import { subagentToolInfo } from './subagentTools';
import { parseDetailObject, toolCommand } from './toolInput';

export type BucketKey = 'read' | 'edit' | 'write' | 'bash' | 'grep' | 'glob' | 'unknown';

interface BucketDef {
  verb: string;          // "Read", "Edited", "Ran"
  noun: string;          // "file", "command"
}

const BUCKETS: Record<BucketKey, BucketDef> = {
  read:    { verb: 'read',     noun: 'file' },
  edit:    { verb: 'edited',   noun: 'file' },
  write:   { verb: 'created',  noun: 'file' },
  bash:    { verb: 'ran',      noun: 'command' },
  grep:    { verb: 'searched', noun: 'pattern' },
  glob:    { verb: 'listed',   noun: 'path' },
  unknown: { verb: 'used',     noun: 'tool' },
};

/** Counted phrases per toolKind: "read 3 files", "ran 2 SubAgents". */
export const KINDS: Record<BucketKey | 'subagent', BucketDef> = { ...BUCKETS, subagent: { verb: 'ran', noun: 'SubAgent' } };

/** The runtime's own kind, read from its kind or title: toolKind's fallback. */
function toolBucketKey(tool: ToolCallState): BucketKey {
  // Try kind first, but fall through to the title when the kind is a value
  // outside our bucket set — Claude runtime reports kind 'tool' for
  // everything, kiro ACP uses kinds like 'execute'. Without the fallback a
  // Bash/Read title lands in 'unknown' and loses its icon + verb.
  const kind = (tool.kind || '').toLowerCase();
  if (kind in BUCKETS) return kind as BucketKey;
  const first = (tool.title.split(/\s+/)[0] || '').toLowerCase();
  if (first in BUCKETS) return first as BucketKey;
  if (kind === 'execute') return 'bash';
  return 'unknown';
}

export type PhraseKind = BucketKey | 'subagent';

/** An MCP tool in any runtime's spelling: `mcp__server__x`, Kiro's `@server/x` (or `Running: @server/x`). */
const MCP_TITLE = /^(?:(?:Running|Completed|Failed|Interrupted): )?(?:mcp__|@[\w.-]+\/)/;

/**
 * What kind of call this is, for its words, counts and icons in every chrome.
 * Runtimes disagree: Pi reports every tool as "execute", Kiro marks read-only
 * shell lines "read" and searches "search". A shell line is a shell line
 * whatever kind it came with; Michi's and MCP tools are tools.
 */
export function toolKind(tool: ToolCallState): PhraseKind {
  if (subagentToolInfo(tool)) return 'subagent';
  if (knownToolName(tool) || MCP_TITLE.test(tool.title)) return 'unknown';
  if (/^read_file$/.test(tool.title)) return 'read';
  const kind = (tool.kind ?? '').toLowerCase();
  const command = toolCommand(tool);
  if (command && kind !== 'edit' && kind !== 'write' && /\s/.test(command.trim())) return 'bash';
  if (kind === 'search') return /^Finding\b/.test(tool.title) ? 'glob' : 'grep';
  if (kind === 'edit') {
    // Kiro writes a whole file as an edit: {command: "create", content} or {text}.
    const input = parseDetailObject(tool.inputJson);
    if (input && (input.command === 'create' || (typeof input.text === 'string' && input.oldStr === undefined))) return 'write';
  }
  if (!command && /^(?:ls|find)$/.test(tool.title)) return 'glob';
  return toolBucketKey(tool);
}

/** A Michi tool call's own copy (michiToolCopy): verb, object, and `generic` when its input named nothing. */
/** Kiro's task list tool: its title changes with each call ("Completing #1"), its input does not. */
export function isTaskListCall(tool: ToolCallState): boolean {
  const input = parseDetailObject(tool.inputJson);
  return !!input && ('completed_task_ids' in input || 'task_list_description' in input || (input.command === 'add' && Array.isArray(input.tasks)));
}

/** A tool Michi has copy for that a runtime reports under another name: Kiro's task list, web fetch and docs lookup. */
function knownToolName(tool: ToolCallState): string | undefined {
  const name = michiToolName(tool.title);
  if (name) return name;
  if (isTaskListCall(tool)) return 'TodoWrite';
  const input = parseDetailObject(tool.inputJson);
  if (/^Fetching web content$/.test(tool.title) && typeof input?.url === 'string') return 'WebFetch';
  if (/^Introspecting$/.test(tool.title)) return 'KiroIntrospect';
  return undefined;
}

export function michiCopy(tool: ToolCallState) {
  const name = knownToolName(tool);
  return name ? michiToolPhrase(name, parseDetailObject(tool.inputJson) ?? parseDetailObject(tool.detail)) : undefined;
}
