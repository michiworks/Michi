import fs from 'node:fs/promises';
import path from 'node:path';
import { readSkillFileInfo, type AgentCommand } from 'michi-shared';

/**
 * One row of the Claude CLI's command table (the SDK's SlashCommand): from
 * the initialize answer, a `commands_changed` push or the skill probe.
 * Built-in rows are Claude Code's own commands and bundled skills; the
 * others are personal, project, plugin and add-dir skills, legacy commands
 * and MCP prompts.
 */
export interface ClaudeSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
  builtin?: boolean;
}

/** More rows than any real profile has (one with 6 plugins lists about 150). */
const MAX_COMMANDS = 1000;

/** The rows of an untrusted command list, or null when it is not a list. */
export function parseClaudeSlashCommands(value: unknown): ClaudeSlashCommand[] | null {
  if (!Array.isArray(value)) return null;
  const commands: ClaudeSlashCommand[] = [];
  for (const item of value) {
    if (commands.length >= MAX_COMMANDS) break;
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== 'string' || !raw.name) continue;
    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0) : [];
    commands.push({
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : '',
      argumentHint: typeof raw.argumentHint === 'string' ? raw.argumentHint : '',
      ...(aliases.length ? { aliases } : {}),
      ...(raw.builtin === true ? { builtin: true } : {}),
    });
  }
  return commands;
}

/** The SDK command bridge's own commands (ClaudeSession.executeCommand), for AgentRuntime.hostCommands and the session state. */
export function claudeHostCommands(): AgentCommand[] {
  return [
    { name: 'status', description: 'Show the session, its model, permission mode and MCP servers', kind: 'command' },
    { name: 'model', description: 'Show the models, or switch to one', kind: 'command', argumentHint: '[model]' },
    { name: 'context', description: 'Show how much of the context window is in use', kind: 'command' },
    { name: 'mcp', description: 'Show the MCP servers and their status', kind: 'command' },
  ];
}

/**
 * What a chat's / menu offers besides the bridge commands: every row that is
 * not Claude Code's own, as the CLI names it (plugin skills `plugin:skill`).
 * MCP prompts run as `/mcp__<server>__<prompt>`.
 */
export function claudeSkillCommands(commands: readonly ClaudeSlashCommand[]): AgentCommand[] {
  return commands.filter((command) => !command.builtin).map((command) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    kind: command.name.startsWith('mcp__') ? 'prompt' as const : 'skill' as const,
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    ...(command.aliases?.length ? { aliases: [...command.aliases] } : {}),
  }));
}

/**
 * Whether `/name` runs the row of that name, one that is not Claude Code's
 * own: the CLI runs a built-in row before any other of the same name.
 * Callers name the row they mean, so an alias does not count: where no row
 * has the name, the alias belongs to another skill: a process that loaded
 * no personal skills would run a plugin's `acme:review`, aliased `review`,
 * for a `/review` meant for the personal `review`.
 */
export function claudeRunsOwnCommand(commands: readonly ClaudeSlashCommand[], name: string): boolean {
  const named = commands.filter((command) => command.name === name);
  return named.length > 0 && named.every((command) => !command.builtin);
}

/**
 * The host's skill library as a process loaded it (an additional folder
 * with `.claude/skills`): the names of its skills a person may run, the
 * ones the CLI lists, and the prefix `<folder>:` Claude gives one whose
 * name a personal or project skill already has.
 */
export interface ClaudeSkillLibrary {
  prefix: string;
  names: ReadonlySet<string>;
}

export const NO_CLAUDE_SKILL_LIBRARY: ClaudeSkillLibrary = { prefix: '', names: new Set() };

/**
 * The library in folder `dir` as the CLI will load it. A
 * `user-invocable: false` skill is left out: the CLI does not list it, so a
 * personal skill of its name keeps the plain row and gets no
 * `<folder>:<name>` beside it.
 */
export async function readClaudeSkillLibrary(dir: string): Promise<ClaudeSkillLibrary> {
  const skills = path.join(dir, '.claude', 'skills');
  let entries: string[] = [];
  try { entries = await fs.readdir(skills); } catch { /* no skills yet */ }
  const names = new Set<string>();
  await Promise.all(entries.map(async (entry) => {
    try {
      if (readSkillFileInfo(await fs.readFile(path.join(skills, entry, 'SKILL.md'), 'utf8'), entry).userInvocable) names.add(entry);
    } catch { /* not a skill */ }
  }));
  return { prefix: `${path.basename(dir)}:`, names };
}

/** Whether row `name` is the library skill's: no `<folder>:<name>` row says a personal or project skill took the name. */
function isLibraryRow(library: ClaudeSkillLibrary, name: string, listed: (name: string) => boolean): boolean {
  return library.names.has(name) && !listed(`${library.prefix}${name}`);
}

/**
 * Whether the table's row `name` runs the library skill of that name. A
 * library skill hides a legacy command of its name (a project's
 * `.claude/commands/<name>.md`, CLI 2.1.319), so `/name` would run the
 * library skill instead of that command.
 */
export function claudeLibraryRow(commands: readonly ClaudeSlashCommand[], library: ClaudeSkillLibrary, name: string): boolean {
  return isLibraryRow(library, name, (row) => commands.some((command) => command.name === row));
}

/**
 * The command that runs library skill `name`: `<folder>:<name>` when the
 * table has that row (a personal or project skill has the name), else
 * `<name>` when it has that one; null when it has neither (an isolated or
 * bare process loads no library skills).
 */
export function claudeLibraryCommand(commands: readonly ClaudeSlashCommand[], library: ClaudeSkillLibrary, name: string): string | null {
  if (!library.names.has(name)) return null;
  const prefixed = `${library.prefix}${name}`;
  if (claudeRunsOwnCommand(commands, prefixed)) return prefixed;
  return claudeRunsOwnCommand(commands, name) ? name : null;
}

/**
 * The table without the library's rows, which the host lists itself:
 * `<folder>:<name>`, and `<name>` when it is the library skill's
 * (claudeLibraryRow).
 */
export function withoutClaudeLibraryRows(commands: readonly ClaudeSlashCommand[], library: ClaudeSkillLibrary): ClaudeSlashCommand[] {
  const names = new Set(commands.map((command) => command.name));
  return commands.filter((command) => {
    if (command.builtin) return true;
    if (command.name.startsWith(library.prefix) && library.names.has(command.name.slice(library.prefix.length))) return false;
    return !isLibraryRow(library, command.name, (row) => names.has(row));
  });
}
