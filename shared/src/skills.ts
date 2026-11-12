import type { AgentCommand } from './sessionState';

/**
 * Michi Skills: Agent Skills folders (agentskills.io), each a directory with
 * a SKILL.md whose YAML frontmatter names and describes it, that a runtime
 * loads as instructions.
 *
 * Three kinds reach the UI. The Michi library is one folder per backend
 * (<MICHI_CONFIG_DIR>/skills) that Michi mounts into every runtime's
 * sessions. Built-in skills ship with Michi itself: read-only, each can be
 * turned off, and Michi expands them into the prompt rather than mounting
 * them, so they run by / only. Runtime skills are the ones a runtime finds
 * on its own (Claude personal and plugin skills, Codex skills, Kiro skills,
 * ...); Michi lists them read-only. The backend owns
 * discovery, storage and access checks (backend/src/services/skills); these
 * are the shapes its REST API, the composer and the runtime contract share.
 */

export type SkillOrigin = 'library' | 'builtin' | 'runtime';

export interface SkillSummary {
  /** Catalog id (librarySkillId / builtinSkillId / runtimeSkillId / liveSkillId). Opaque to the UI. */
  id: string;
  /** The Agent Skills name. */
  name: string;
  description: string;
  origin: SkillOrigin;
  /** The runtime that reported it. Absent for library and built-in skills. */
  runtimeId?: string;
  /** The runtime's own scope label: user, project, plugin, system, admin, ... */
  scope?: string;
  /** The plugin or package that ships it, when the runtime says. */
  pluginId?: string;
  /** The name the runtime itself invokes it by, when it differs from `name` ('plugin:skill'). */
  nativeName?: string;
  /** Absolute SKILL.md path, when known. */
  path?: string;
  argumentHint?: string;
  /** A person may run it with / (false with `user-invocable: false`). */
  userInvocable: boolean;
  /** The agent may load it on its own (false with `disable-model-invocation: true`). */
  modelInvocable: boolean;
  /** Who owns the files when Michi must not edit them: 'Claude plugin', 'Crew', ... */
  managedBy?: string;
  /** Library and built-in: the skill is on (every runtime gets it). Runtime skills: the runtime's own enabled flag. */
  enabled: boolean;
  /** Library only: the real folder, when the library entry is a link to a folder kept elsewhere. */
  linkTarget?: string;
}

export interface SkillDetail extends SkillSummary {
  /** The whole SKILL.md, frontmatter included. */
  content: string;
  /** Other files in the skill folder, relative and POSIX-style, capped by the backend. */
  files: string[];
}

export interface SkillCatalogError {
  /** Absent for library problems. */
  runtimeId?: string;
  message: string;
  /**
   * The runtime's whole listing failed or timed out, so none of its skills
   * are in this answer. Absent: a problem with some skills (an unreadable
   * SKILL.md, a plugin that failed to load) while the rest are listed.
   */
  failed?: boolean;
  /** The runtime could not list again, so its skills are the ones it listed last time. */
  stale?: boolean;
}

/** A runtime the backend has registered, as the Skills page and the / menu name it. */
export interface SkillRuntimeInfo {
  id: string;
  /** The runtime's own display label from the backend's registry (never a client-side table). */
  label: string;
  /** Installed and able to list skills here; false means registered but not set up. */
  available: boolean;
}

export interface SkillCatalogResponse {
  /**
   * GET /skills: every skill. GET /skills/catalog: the enabled,
   * user-invocable library skills and every skill of the runtime, flags
   * included, so a client can tell a live session's command for a skill the
   * / menu must not offer (`userInvocable` or `enabled` false) from an
   * unknown one; the menu offers only the runnable ones.
   */
  skills: SkillSummary[];
  errors: SkillCatalogError[];
  /** False where this backend keeps no library (cloud mode); the page then shows it as unavailable. */
  libraryAvailable: boolean;
  /** The library folder on that backend, whenever it keeps one. */
  libraryPath?: string;
  /**
   * The registered runtimes that report skills, with their labels: every one
   * for GET /skills, the requested one for GET /skills/catalog. Clients take
   * runtime names from here and never keep a list of their own.
   */
  runtimes?: SkillRuntimeInfo[];
  /**
   * Runtimes whose listing had not answered within the backend's short wait:
   * their skills are missing from this answer and come with a later request.
   * Library skills and `commands` never wait for them.
   */
  pending?: string[];
  /**
   * GET /skills/catalog only: the commands the runtime runs before a live
   * session lists its own (Claude's SDK bridge commands, Kiro's command
   * interface, ...), so a cold chat's / menu offers and reserves them.
   */
  commands?: AgentCommand[];
}

/**
 * The folder each Claude session gets the library in, as an additional
 * directory. Library skills keep their own names there; Claude names one
 * whose name a personal or project skill already has `michi:<name>`.
 */
export const SKILL_LIBRARY_FOLDER_NAME = 'michi';

/**
 * The composer's request to run a skill (POST /chats/:id/message `skill`).
 * The backend resolves `id` against its own catalog; a path or body never
 * comes from the client.
 */
export interface SkillInvocationRequest {
  id: string;
  name: string;
  /**
   * What the user wrote after the command, as the message text carries it:
   * the composer ends the text with it, after whatever context it frames the
   * message with (comments, a quote, attached files, referenced chats). A
   * runtime that hands the skill these arguments can take them out of the
   * context it sends along.
   */
  args: string;
}

/** Kept on the user message (DurableMessageMetadata.skill), so the transcript can show it and a retry can run it again. */
export interface SkillMessageMetadata {
  id: string;
  name: string;
  origin: SkillOrigin;
  runtimeId?: string;
  args: string;
}

// ---- Ids ----------------------------------------------------------------

export function librarySkillId(name: string): string {
  return `library:${name}`;
}

/** A skill that ships with Michi. */
export function builtinSkillId(name: string): string {
  return `builtin:${name}`;
}

/** A skill a runtime reported through AgentRuntime.listSkills. */
export function runtimeSkillId(runtimeId: string, scope: string | undefined, nativeName: string): string {
  return `runtime:${runtimeId}:${scope ?? ''}:${nativeName}`;
}

/** A skill known only from a live session's command list. */
export function liveSkillId(runtimeId: string, nativeName: string): string {
  return `live:${runtimeId}:${nativeName}`;
}

export type ParsedSkillId =
  | { kind: 'library'; name: string }
  | { kind: 'builtin'; name: string }
  | { kind: 'runtime'; runtimeId: string; scope: string; nativeName: string }
  | { kind: 'live'; runtimeId: string; nativeName: string };

export function parseSkillId(id: string): ParsedSkillId | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith('library:')) {
    const name = id.slice('library:'.length);
    return isValidSkillName(name) ? { kind: 'library', name } : null;
  }
  if (id.startsWith('builtin:')) {
    const name = id.slice('builtin:'.length);
    return isValidSkillName(name) ? { kind: 'builtin', name } : null;
  }
  if (id.startsWith('runtime:')) {
    const rest = id.slice('runtime:'.length);
    const first = rest.indexOf(':');
    const second = first < 0 ? -1 : rest.indexOf(':', first + 1);
    if (first <= 0 || second < 0) return null;
    const nativeName = rest.slice(second + 1);
    if (!nativeName) return null;
    return { kind: 'runtime', runtimeId: rest.slice(0, first), scope: rest.slice(first + 1, second), nativeName };
  }
  if (id.startsWith('live:')) {
    const rest = id.slice('live:'.length);
    const first = rest.indexOf(':');
    if (first <= 0 || first === rest.length - 1) return null;
    return { kind: 'live', runtimeId: rest.slice(0, first), nativeName: rest.slice(first + 1) };
  }
  return null;
}

// ---- Names --------------------------------------------------------------

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

/**
 * The Agent Skills name rule: 1-64 lowercase letters, digits and single
 * inner hyphens, equal to the folder name. Library skills must follow it
 * (it also keeps a name safe as a path segment).
 */
export function isValidSkillName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= SKILL_NAME_MAX
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** Names a slash command may carry: Claude's command-name rule (plugin skills are 'plugin:skill'). */
export const SLASH_COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9:_-]*$/;

/** `/name args` at the very start of a message, or null. Args keep inner newlines. */
export function parseSlashInvocation(text: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z0-9_][A-Za-z0-9:_-]*)(?:[ \t]+([\s\S]*)|\n([\s\S]*))?$/.exec(text);
  if (!match) return null;
  return { name: match[1], args: (match[2] ?? match[3] ?? '').trim() };
}

// ---- SKILL.md -----------------------------------------------------------

export type SkillFrontmatterValue = string | boolean | null;

export interface ParsedSkillFile {
  /** Keys as written. Values are strings, booleans or null; lists and maps, which Michi never reads, are null. */
  data: Record<string, SkillFrontmatterValue>;
  /** Everything after the closing `---`, without the leading newline. */
  body: string;
  /** Set when the file has no frontmatter block or it could not be read. */
  error?: string;
}

const FRONTMATTER_OPEN = /^\uFEFF?---[ \t]*\r?\n/;

/**
 * Reads SKILL.md frontmatter leniently, the way skill hosts do: scalars,
 * quoted strings, `|`/`>` block scalars and plain scalars that continue on
 * indented lines. A list or map value reads as null. Anything it cannot read
 * is skipped rather than failing the file.
 */
export function parseSkillFile(content: string): ParsedSkillFile {
  const open = FRONTMATTER_OPEN.exec(content);
  if (!open) return { data: {}, body: content, error: 'SKILL.md has no frontmatter block' };
  const rest = content.slice(open[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) return { data: {}, body: content, error: 'SKILL.md frontmatter is not closed' };
  const yaml = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  return { data: parseYamlSubset(yaml), body };
}

function parseYamlSubset(source: string): Record<string, SkillFrontmatterValue> {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const data: Record<string, SkillFrontmatterValue> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) { i += 1; continue; }
    // Greedy `[^:]*` with no overlapping `\s*`: a long line without a colon must not backtrack quadratically.
    const match = /^([^:#\s][^:]*):(?:\s+(.*))?$/.exec(line);
    if (!match) { i += 1; continue; }
    const key = match[1].trim();
    const inline = (match[2] ?? '').trim();
    i += 1;
    const block: string[] = [];
    // A block sequence may sit at the key's own indentation (`tags:` then `- a`); it belongs to this key.
    const sequenceAtKeyIndent = inline === '' && i < lines.length && /^-(\s|$)/.test(lines[i]);
    while (i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i])
      || (sequenceAtKeyIndent && /^-(\s|$)/.test(lines[i])))) {
      block.push(lines[i]);
      i += 1;
    }
    while (block.length && block[block.length - 1].trim() === '') block.pop();
    data[key] = readValue(inline, block);
  }
  return data;
}

function readValue(inline: string, block: string[]): SkillFrontmatterValue {
  const header = /^([|>])([+-]?)(\d?)\s*(?:#.*)?$/.exec(inline);
  if (header) return readBlockScalar(header[1] === '|', header[2], block);
  if (inline === '') {
    const items = block.filter((line) => line.trim() !== '');
    if (items.length === 0) return null;
    // A list (`- a`) or a map (`key: value`) is not a value Michi reads.
    if (items.every((line) => /^\s*-(\s|$)/.test(line)) || items.every((line) => /^\s+[^:#\s][^:]*:(\s|$)/.test(line))) return null;
    // Otherwise a plain scalar written on the next, indented lines; YAML folds it with spaces.
    return stripComment(items.map((line) => line.trim()).join(' '));
  }
  if (inline.startsWith('"') || inline.startsWith("'")) {
    const joined = [inline, ...block.map((line) => line.trim())].join(' ');
    return readScalar(joined);
  }
  // A plain scalar may continue on more-indented lines; YAML folds them with spaces.
  const continuation = block.map((line) => line.trim()).filter(Boolean);
  if (continuation.length) return stripComment([inline, ...continuation].join(' '));
  return readScalar(inline);
}

function readBlockScalar(literal: boolean, chomp: string, block: string[]): string {
  const indents = block.filter((line) => line.trim() !== '').map((line) => /^\s*/.exec(line)![0].length);
  const indent = indents.length ? Math.min(...indents) : 0;
  const rows = block.map((line) => line.slice(Math.min(indent, /^\s*/.exec(line)![0].length)));
  let text: string;
  if (literal) {
    text = rows.join('\n');
  } else {
    text = '';
    rows.forEach((row, index) => {
      if (index === 0) { text = row; return; }
      const previous = rows[index - 1];
      if (row === '') text += '\n';
      else if (previous === '' || /^\s/.test(row) || /^\s/.test(previous)) text += (text.endsWith('\n') ? '' : '\n') + row;
      else text += ` ${row}`;
    });
  }
  if (chomp === '+') return `${text}\n`;
  if (chomp === '-') return text.replace(/\n+$/, '');
  return text.replace(/\n+$/, '') + (text ? '\n' : '');
}

function readScalar(raw: string): string | boolean | null {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const end = findClosingDoubleQuote(value);
    const inner = value.slice(1, end < 0 ? undefined : end);
    return inner.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_, esc: string) => {
      switch (esc[0]) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'u': return String.fromCharCode(parseInt(esc.slice(1), 16));
        default: return esc;
      }
    });
  }
  if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'/.exec(value);
    return (match ? match[1] : value.slice(1)).replace(/''/g, "'");
  }
  const plain = stripComment(value);
  if (plain === 'true' || plain === 'True' || plain === 'TRUE') return true;
  if (plain === 'false' || plain === 'False' || plain === 'FALSE') return false;
  if (plain === '' || plain === '~' || plain === 'null' || plain === 'Null' || plain === 'NULL') return null;
  return plain;
}

function findClosingDoubleQuote(value: string): number {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === '\\') { i += 1; continue; }
    if (value[i] === '"') return i;
  }
  return -1;
}

function stripComment(value: string): string {
  const index = value.search(/\s#/);
  return (index < 0 ? value : value.slice(0, index)).trim();
}

/** What Michi reads from a SKILL.md, with the defaults hosts apply. */
export interface SkillFileInfo {
  name: string;
  description: string;
  argumentHint?: string;
  userInvocable: boolean;
  modelInvocable: boolean;
  body: string;
  /** Frontmatter problems worth showing; the skill may still load. */
  warnings: string[];
}

/** Name falls back to the folder name, as runtimes do. */
export function readSkillFileInfo(content: string, folderName: string): SkillFileInfo {
  const parsed = parseSkillFile(content);
  const warnings: string[] = parsed.error ? [parsed.error] : [];
  const text = (key: string): string | undefined => {
    const value = parsed.data[key];
    return typeof value === 'string' ? value.trim() : undefined;
  };
  const flag = (key: string): boolean | undefined => {
    const value = parsed.data[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  };
  const name = text('name') || folderName;
  const description = text('description') ?? '';
  if (!text('name')) warnings.push('frontmatter has no name; the folder name is used');
  if (!description) warnings.push('frontmatter has no description');
  const argumentHint = text('argument-hint');
  return {
    name,
    description,
    ...(argumentHint ? { argumentHint } : {}),
    userInvocable: flag('user-invocable') ?? true,
    modelInvocable: !(flag('disable-model-invocation') ?? false),
    body: parsed.body.replace(/^\s*\n/, ''),
    warnings,
  };
}

/** Problems that keep a library skill from being saved, empty when it is valid. */
export function validateLibrarySkill(input: { name: string; content: string }): string[] {
  const errors: string[] = [];
  if (!isValidSkillName(input.name)) {
    errors.push('Name must be 1-64 lowercase letters, digits or single hyphens, not starting or ending with a hyphen.');
  }
  const parsed = parseSkillFile(input.content);
  if (parsed.error) {
    errors.push(`${parsed.error}.`);
    return errors;
  }
  const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
  if (!name) errors.push('Frontmatter needs a name.');
  else if (name !== input.name) errors.push(`Frontmatter name "${name}" must match the skill folder "${input.name}".`);
  const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';
  if (!description) errors.push('Frontmatter needs a description.');
  else if (description.length > SKILL_DESCRIPTION_MAX) errors.push(`Description is longer than ${SKILL_DESCRIPTION_MAX} characters.`);
  return errors;
}

/** A YAML double-quoted scalar that reads back as `value`. */
function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

/** A new SKILL.md from its parts. */
export function formatSkillFile(input: { name: string; description: string; argumentHint?: string; body: string }): string {
  const body = input.body.replace(/^\n+/, '');
  const hint = input.argumentHint?.trim();
  return `---\nname: ${input.name}\ndescription: ${quoteYaml(input.description.trim())}\n${hint ? `argument-hint: ${quoteYaml(hint)}\n` : ''}---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

/**
 * The same SKILL.md with its description, argument hint and body replaced,
 * for the Settings form; every other frontmatter key is kept as written. An
 * empty argument hint removes the key.
 */
export function withSkillFileFields(content: string, fields: { description: string; argumentHint?: string; body: string }): string {
  const open = FRONTMATTER_OPEN.exec(content);
  const rest = open ? content.slice(open[0].length) : '';
  const close = open ? /^---[ \t]*(?:\r?\n|$)/m.exec(rest) : null;
  // Without a readable frontmatter block there is no name to keep; the validator then says so.
  let yaml = open && close ? rest.slice(0, close.index) : '';
  yaml = setTopLevelKey(yaml, 'description', quoteYaml(fields.description.trim()));
  const hint = fields.argumentHint?.trim();
  yaml = hint ? setTopLevelKey(yaml, 'argument-hint', quoteYaml(hint)) : removeTopLevelKey(yaml, 'argument-hint');
  const body = fields.body.replace(/^\n+/, '');
  return `${open?.[0] ?? '---\n'}${yaml}---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

/** The lines of a top-level key: its own line and the indented lines that continue it. */
function topLevelKeySpan(lines: string[], key: string): [number, number] | null {
  const start = lines.findIndex((line) => new RegExp(`^${key.replace(/[-]/g, '\\-')}[ \t]*:`).test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || /^-(\s|$)/.test(lines[end]) || lines[end].trim() === '')) end += 1;
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return [start, end];
}

function setTopLevelKey(yaml: string, key: string, value: string): string {
  const lines = yaml.replace(/\n$/, '').split('\n').filter((line, index, all) => !(all.length === 1 && line === ''));
  const span = topLevelKeySpan(lines, key);
  if (span) lines.splice(span[0], span[1] - span[0], `${key}: ${value}`);
  else lines.push(`${key}: ${value}`);
  return `${lines.join('\n')}\n`;
}

function removeTopLevelKey(yaml: string, key: string): string {
  const lines = yaml.replace(/\n$/, '').split('\n');
  const span = topLevelKeySpan(lines, key);
  if (!span) return yaml;
  lines.splice(span[0], span[1] - span[0]);
  const joined = lines.join('\n');
  return joined ? `${joined}\n` : '';
}

/**
 * The same SKILL.md with its frontmatter `name` set to `name`, for a rename.
 * Other keys and the body are kept as written.
 */
export function withSkillFileName(content: string, name: string): string {
  const open = FRONTMATTER_OPEN.exec(content);
  if (!open) return formatSkillFile({ name, description: '', body: content });
  const rest = content.slice(open[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) return content;
  const yaml = rest.slice(0, close.index);
  const replaced = /^name[ \t]*:.*$/m.test(yaml)
    ? yaml.replace(/^name[ \t]*:.*$/m, `name: ${name}`)
    : `name: ${name}\n${yaml}`;
  return `${open[0]}${replaced}${rest.slice(close.index)}`;
}
