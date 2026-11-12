import { isTurnMetadataToolTitle } from 'michi-shared';
import type { ToolCallState } from '../../../state/chatTypes';
import { clip } from './phraseText';

const RUNNING_STATUSES = new Set(['running', 'in_progress', 'pending']);
const FAILED_STATUSES = new Set(['error', 'failed']);

/**
 * Michi's turn-metadata calls (follow-ups, branch overview): invisible
 * plumbing whose effects show, never a "Running set_branch_overview" banner or
 * a chip. Only Michi's: another MCP server's tool of the same name shows.
 */
export function isHiddenInternalTool(title: string): boolean {
  return isTurnMetadataToolTitle(title);
}

export function isRunningStatus(status: string | undefined): boolean {
  if (!status) return true;
  return RUNNING_STATUSES.has(status);
}

export function isTerminalStatus(status: string | undefined): boolean {
  return !isRunningStatus(status);
}

export function isFailedStatus(status: string | undefined): boolean {
  if (!status) return false;
  return FAILED_STATUSES.has(status);
}

export function failedToolCount(tools: readonly ToolCallState[]): number {
  return tools.reduce((n, t) => n + (isFailedStatus(t.status) ? 1 : 0), 0);
}

const EXIT_LINE = /^\s*(?:exit(?:ed with)? code|exit status)[:\s]+(-?\d+)\b.*$/i;

/** The exit code a shell call reported in its output ("Exit code 1"), if any. */
export function toolExitCode(tool: ToolCallState): number | undefined {
  for (const line of (tool.output ?? '').split('\n').slice(0, 8)) {
    const m = EXIT_LINE.exec(line);
    if (m) return Number(m[1]);
  }
  return undefined;
}

const DENIED = /has been denied|was denied|denied by (?:the )?user|user (?:rejected|declined)|^\s*Permission to use \S+ with command/i;
/** The user declined this call, so it did not run: a failure in status only. */
export function isDenied(tool: ToolCallState): boolean {
  return isFailedStatus(tool.status) && DENIED.test(tool.output ?? '');
}

/** Interrupted or cancelled: the call did not finish, and did not fail. */
export function isStoppedStatus(status: string | undefined): boolean {
  return status === 'interrupted' || status === 'cancelled' || status === 'canceled';
}

/** A failure's first line of output, without the "Error: " prefix or the exit-code line.
 *  Kiro wraps output as `{"output": …}`; that is unwrapped first. */
export function toolErrorLine(tool: ToolCallState): string {
  let text = tool.output ?? '';
  if (/^\s*\{"(?:output|error|stderr)"/.test(text)) {
    try { const o = JSON.parse(text) as Record<string, unknown>; text = String(o.error ?? o.stderr ?? o.output ?? text); } catch { text = text.replace(/^\s*\{"\w+":"/, '').replace(/\\n/g, '\n'); }
  }
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() && !EXIT_LINE.test(l));
  if (at < 0) return '';
  // A line that opens JSON ("Invalid arguments for tool x: [") says what went wrong on the next lines.
  const line = /[[{]\s*$/.test(lines[at]) ? lines.slice(at, at + 8).join(' ') : lines[at];
  return clip(line.trim().replace(/\s+/g, ' ').replace(/^error:\s*/i, ''), 200);
}
