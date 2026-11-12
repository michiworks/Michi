/**
 * Which tool a tool call's title names, and whether it is one of Michi's own.
 * Runtimes spell a Michi tool differently: `mcp____michi_internal____x`
 * (Claude), `@michi/x` and "Running: @michi/x" (Kiro), `mcp__michi-tools__x`,
 * `michi_internal____x` (Codex) or the bare name (Pi, and Codex's host calls).
 */

/** The name Claude's and Codex's configs register Michi's MCP server under (a frozen external name). */
export const MICHI_MCP_SERVER = '__michi_internal__';

/** The MCP server names Michi's own tools arrive under. */
export const MICHI_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([MICHI_MCP_SERVER, 'michi', 'michi-tools', 'michi_internal']);

/** Michi's turn-metadata tools: plumbing whose effects show, never the calls. */
export const TURN_METADATA_TOOL_NAMES: ReadonlySet<string> = new Set([
  'set_branch_overview', 'set_follow_ups',
]);

/** Metadata tools Michi no longer has; only old history holds their calls. */
export const LEGACY_METADATA_TOOL_NAMES: ReadonlySet<string> = new Set(['set_title', 'validate_follow_ups', 'validate_turn_metadata']);

/** Kiro reports a call as "Running: @michi/x" and keeps that label once it settles. */
const STATE_LABEL = /^(?:Running|Completed|Failed|Interrupted): /i;
/** `server____x`, `server__x`, `server::x`, `server.x`, `server:x` or `server/x`. */
const SEPARATED = /^([^\s]+?)(?:_{2,}|::|[/.:])([A-Za-z][\w-]*)$/;

function isMichiMcpServer(server: string): boolean {
  const name = server.toLowerCase();
  return MICHI_MCP_SERVER_NAMES.has(name) || MICHI_MCP_SERVER_NAMES.has(name.replace(/^_+|_+$/g, ''));
}

/** The server a title names, if any, and the tool name. */
export function parseToolTitle(title: string): { server?: string; name: string } {
  const t = title.trim().replace(STATE_LABEL, '');
  if (t.startsWith('mcp__')) {
    const rest = t.slice('mcp__'.length);
    for (const server of MICHI_MCP_SERVER_NAMES) {
      if (rest.startsWith(`${server}__`) && rest.length > server.length + 2) return { server, name: rest.slice(server.length + 2) };
    }
    const cut = rest.indexOf('__');
    return cut > 0 && cut + 2 < rest.length ? { server: rest.slice(0, cut), name: rest.slice(cut + 2) } : { name: t };
  }
  const kiro = /^@([^/\s]+)\/(.+)$/.exec(t);
  if (kiro) return { server: kiro[1], name: kiro[2] };
  const separated = SEPARATED.exec(t);
  return separated ? { server: separated[1], name: separated[2] } : { name: t };
}

/** The tool's name when the title names no server or one of Michi's; undefined for any other server's tool. */
export function michiBareToolName(title: string): string | undefined {
  const { server, name } = parseToolTitle(title);
  return server === undefined || isMichiMcpServer(server) ? name : undefined;
}

/** Whether the title names a Michi turn-metadata call, current or legacy. */
export function isTurnMetadataToolTitle(title: string): boolean {
  const name = michiBareToolName(title)?.toLowerCase();
  return name !== undefined && (TURN_METADATA_TOOL_NAMES.has(name) || LEGACY_METADATA_TOOL_NAMES.has(name));
}
