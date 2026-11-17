/**
 * Which external tools an unattended Michi run may use, the same answer on
 * every runtime: the maintenance gateway (maintenanceAccess.ts) and Kiro's
 * agent config and catalog check (agents/kiro/kiroMetaAgent.ts) both ask
 * canUseExternalTool. Michi's own tools follow their toolset's lists.
 *
 * Only Pages upkeep (maintenance) reads outside Michi, and only through a
 * read-only tool: one its server declares read-only (readOnlyHint, not
 * destructive, no required task), or one config.json's
 * backgroundToolOverrides names "read-only" because its server declares
 * nothing. An override can also deny a tool; it never makes a tool its
 * server declares write-capable usable. A read-sounding name counts for
 * nothing.
 */

import type { MetaAgentToolset } from 'michi-shared';
import { getMichiConfigPaths } from '../configPaths';
import { readJsonConfig } from '../jsonConfigStore';

export type BackgroundToolRule = 'read-only' | 'deny';
/** Keyed by backgroundToolId. */
export type BackgroundToolOverrides = ReadonlyMap<string, BackgroundToolRule>;

/**
 * `server/tool`, normalizing the optional trailing `-mcp` server suffix.
 */
export function backgroundToolId(server: string, tool: string): string {
  return `${server.replace(/-mcp$/, '')}/${tool}`;
}

/**
 * config.json's `backgroundToolOverrides`, e.g. `{ "example-search-mcp/search_documents": "read-only" }`.
 * A missing, unreadable or malformed setting, and any entry that is not
 * `server/tool` with a known rule, grants nothing.
 */
export function readBackgroundToolOverrides(configPath = getMichiConfigPaths().configPath): BackgroundToolOverrides {
  const overrides = new Map<string, BackgroundToolRule>();
  let raw: unknown;
  try { raw = readJsonConfig(configPath)?.backgroundToolOverrides; } catch { return overrides; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return overrides;
  for (const [key, rule] of Object.entries(raw)) {
    const match = /^([^/\s]+)\/([^/\s]+)$/.exec(key);
    if (match && (rule === 'read-only' || rule === 'deny')) overrides.set(backgroundToolId(match[1], match[2]), rule);
  }
  return overrides;
}

/** What Michi knows of an external tool. A runtime that only lists names (Kiro) passes no annotations. */
export interface ExternalToolFacts {
  server: string;
  tool: string;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
  taskSupport?: string;
}

export function canUseExternalTool(toolset: MetaAgentToolset, tool: ExternalToolFacts, overrides: BackgroundToolOverrides): boolean {
  if (toolset !== 'maintenance') return false;
  const rule = overrides.get(backgroundToolId(tool.server, tool.tool));
  if (rule === 'deny') return false;
  const declared = tool.annotations;
  if (declared?.readOnlyHint === false || declared?.destructiveHint === true || tool.taskSupport === 'required') return false;
  return declared?.readOnlyHint === true || rule === 'read-only';
}

/** The tools, as backgroundToolId, a toolset may use on a runtime that sees no annotations: those overrides make read-only. */
export function readOnlyOverrideTools(toolset: MetaAgentToolset, overrides: BackgroundToolOverrides): string[] {
  return [...overrides.keys()].filter((id) => {
    const slash = id.indexOf('/');
    return canUseExternalTool(toolset, { server: id.slice(0, slash), tool: id.slice(slash + 1) }, overrides);
  }).sort();
}
