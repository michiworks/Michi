import { extractToolUsePurpose } from 'michi-shared';
import type { ToolCallState } from '../../../state/chatTypes';

export function compactWhitespace(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, ' ').trim();
  return compact || undefined;
}

function objectStringField(
  obj: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return compactWhitespace(value);
  }
  return undefined;
}

function decodeJsonStringFragment(fragment: string): string {
  try {
    return JSON.parse(`"${fragment}"`);
  } catch {
    return fragment
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function regexStringField(detail: string | undefined, keys: string[]): string | undefined {
  if (!detail) return undefined;
  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = detail.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (match) return compactWhitespace(decodeJsonStringFragment(match[1]));
  }
  return undefined;
}

export function parseDetailObject(detail: string | undefined): Record<string, unknown> | null {
  if (!detail?.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(detail);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function detailField(
  detail: string | undefined,
  obj: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  return objectStringField(obj, keys) ?? regexStringField(detail, keys);
}

/** Priority order for the one-line argument shown beside a tool name.
 *  Matches what each bucket's primary argument is (command for bash,
 *  file_path for read/edit, pattern for grep, …). */
const ROW_DETAIL_KEYS = [
  'command',
  'pattern',
  'file_path',
  'filePath',
  'path',
  'query',
  'url',
];

const ROW_DETAIL_MAX = 200;

function clampLine(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Paths and "Read: /foo" labels are command detail, not the agent's why. */
function looksLikeToolArg(value: string): boolean {
  if (/^(\/|\.\/|\.\.\/|[A-Za-z]:[\\/])/.test(value)) return true;
  if (/^(Read|Write|Edit|Bash|Grep|Glob|List|Search)\b[:\s]/i.test(value)) return true;
  return false;
}

/**
 * Agent's stated why-string for a tool row. Only `__tool_use_purpose` counts —
 * `detail` is overloaded (path, command dump, stdout, result JSON) and must
 * not be treated as purpose. Returns undefined when the field is absent so
 * renderers fall back to name + command detail.
 */
export function toolPurpose(tool: ToolCallState): string | undefined {
  return clampLine(
    extractToolUsePurpose(tool.inputJson) ?? extractToolUsePurpose(tool.detail),
    ROW_DETAIL_MAX,
  );
}

/**
 * One-line technical argument for a tool row ("npm test", a file path,
 * a grep pattern) — the machine-level command/operation detail. Sources:
 *   1. the structured input (`inputJson`) — the primary argument key;
 *   2. `detail` parsed as JSON — Claude runtime backfills detail with a raw
 *      input dump, and completed MCP tools overwrite it with result content,
 *      so a raw `detail` is only trusted after extraction, never verbatim.
 *
 * This is the secondary line shown below purpose. When purpose is absent,
 * renderers show this as the only line (preserving current behavior).
 */
export function toolRowDetail(tool: ToolCallState): string | undefined {
  const input = tool.inputJson;
  if (input?.trim().startsWith('{')) {
    const fromInput = detailField(input, parseDetailObject(input), ROW_DETAIL_KEYS);
    if (fromInput) return clampLine(fromInput, ROW_DETAIL_MAX);
  }
  const detail = compactWhitespace(tool.detail);
  if (detail && !/^[[{]/.test(detail)) {
    // Human purpose lives on the primary line; a path/title is the row argument.
    return looksLikeToolArg(detail) ? clampLine(detail, ROW_DETAIL_MAX) : undefined;
  }
  if (detail?.startsWith('{')) {
    const fromDetail = detailField(tool.detail, parseDetailObject(tool.detail), ROW_DETAIL_KEYS);
    if (fromDetail) return clampLine(fromDetail, ROW_DETAIL_MAX);
  }
  return undefined;
}

/** A string field of the tool's structured input (or its JSON detail). */
export function inputField(tool: ToolCallState, keys: string[]): string | undefined {
  const input = tool.inputJson;
  if (input?.trim().startsWith('{')) {
    const obj = parseDetailObject(input);
    const value = detailField(input, obj, keys);
    if (value) return value;
    const raw = (obj?.__unparsedToolInput as { raw?: unknown } | undefined)?.raw;
    if (typeof raw === 'string') { const v = detailField(raw, parseDetailObject(raw), keys); if (v) return v; }
  }
  if (tool.detail?.trim().startsWith('{')) return detailField(tool.detail, parseDetailObject(tool.detail), keys);
  return undefined;
}

/** The command as typed: newlines kept, since they separate commands and end heredocs. */
export function toolCommand(tool: ToolCallState): string | undefined {
  for (const raw of [tool.inputJson, tool.detail]) {
    if (!raw?.trim().startsWith('{')) continue;
    const obj = parseDetailObject(raw);
    const value = obj?.command ?? obj?.cmd;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return inputField(tool, ['command', 'cmd']);
}

export function toolPath(tool: ToolCallState): string | undefined {
  const path = inputField(tool, ['file_path', 'filePath', 'path', 'notebook_path']);
  if (path) return path;
  // Kiro reads several files in one call: {operations: [{path}, …]}.
  const ops = parseDetailObject(tool.inputJson)?.operations;
  const op = Array.isArray(ops) ? (ops[0] as Record<string, unknown> | undefined) : undefined;
  const first = op?.path ?? (Array.isArray(op?.image_paths) ? op.image_paths[0] : undefined);
  return typeof first === 'string' ? first : undefined;
}

export function toolPattern(tool: ToolCallState): string | undefined {
  return inputField(tool, ['pattern', 'query', 'glob']);
}
