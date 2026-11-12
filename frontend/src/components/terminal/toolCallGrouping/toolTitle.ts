import type { ToolCallState } from '../../../state/chatTypes';

/**
 * Strips the `mcp__<server>__` prefix that Claude CLI prepends to MCP tool
 * names so a chip reads `list_threads` instead of
 * `mcp__michi-tools__list_threads`. Server names may contain hyphens; the
 * segment separator is always `__`, and tool names use single underscores, so
 * splitting on `__` keeps the tool segment intact. Non-MCP titles pass through.
 */
export function prettifyToolTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return title;

  const cursorPrefixed = trimmed.match(/^michi[-_][\w.-]+:\s*([\w.-]+)$/i);
  if (cursorPrefixed) return cursorPrefixed[1];

  if (trimmed.startsWith('mcp__')) {
    const parts = trimmed.split('__');
    if (parts.length >= 3) return parts.slice(2).join('__');
  }

  const michiPrefixed = trimmed.match(/^michi(?:__|-)(.+)$/i);
  if (michiPrefixed) return michiPrefixed[1];

  return trimmed;
}

/** Kiro ACP keeps this generated start label after ask_user finishes. Derive
 * its display state without rewriting raw provider titles or stored history. */
export function toolDisplayTitle(tool: ToolCallState): string {
  if (tool.title === 'Running: @michi/ask_user') {
    switch (tool.status) {
      case 'completed': return 'Completed: @michi/ask_user';
      case 'error':
      case 'failed': return 'Failed: @michi/ask_user';
      case 'interrupted':
      case 'cancelled':
      case 'canceled': return 'Interrupted: @michi/ask_user';
    }
  }
  return prettifyToolTitle(tool.title);
}

/** A tool's own name, without a runtime's prefixes: "search_docs", not "Running: @docs-server/search_docs". */
export function bareToolName(title: string): string {
  return prettifyToolTitle(title.trim().replace(/^(?:Running|Completed|Failed|Interrupted): /, ''))
    .replace(/^@[\w.-]+\//, '')
    .replace(/^michi[a-z_-]*?_{2,}(?=[a-z])/i, '');
}
