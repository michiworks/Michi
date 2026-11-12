import {
  liveSkillId,
  parseSlashInvocation,
  SLASH_COMMAND_NAME,
  type AgentCommand,
  type SkillMessageMetadata,
  type SkillOrigin,
  type SkillSummary,
} from 'michi-shared';
import type { ChatNodeState } from './chatTypes';

/**
 * What `/name` means in a chat: the / menu lists these entries and a send
 * resolves its text against the same list, so the row picked is what runs.
 * Order: Michi's own commands, the runtime's commands, library skills,
 * Michi's built-in skills, then the runtime's skills. A command and skills may share a name.
 */
export interface SlashEntry {
  name: string;
  description?: string;
  /** local: Michi's own command; runtime: the runtime's; skill: the message runs a skill. */
  source: 'local' | 'runtime' | 'skill';
  /** The menu inserts `/<name> ` with a trailing space, so arguments can follow. */
  takesArgs: boolean;
  /** The arguments it expects. */
  hint?: string;
  /** Who provides a skill: Michi for the library, Built-in for Michi's own, else the runtime's label. */
  sourceLabel?: string;
  /** Another entry has the same name: the menu marks this row with it ("Skill", or the source where skills share it). */
  tag?: string;
  /** A whole-line `/name [value]` goes to the command path (executeComposerCommand), not to the model. */
  runsCommand?: boolean;
  /** Set for source 'skill': what a `/name args` message runs. */
  skill?: SlashSkill;
}

export interface SlashSkill {
  /** The catalog id the message request carries. */
  id: string;
  /** The skill's own name. */
  name: string;
  origin: SkillOrigin;
  runtimeId?: string;
}

/** The backend's / menu catalog for one workspace and runtime (GET /skills/catalog). */
export interface SlashSkillCatalog {
  /** The library skills a person may run, and every skill of the runtime with its flags. */
  skills: readonly SkillSummary[];
  /** What the runtime runs as commands before a live session lists its own. */
  commands: readonly AgentCommand[];
}

/** A row picked from the / menu, and the runtime whose menu offered it. */
export interface SlashPick {
  entry: SlashEntry;
  runtimeId?: string;
}

/** Commands Michi handles itself: TPane runs /agent, /branch and /fanout, the chat store /compact. */
const LOCAL_SLASH_COMMANDS: readonly SlashEntry[] = [
  { name: 'agent', description: 'Switch this chat’s agent.', source: 'local', takesArgs: true },
  { name: 'branch', description: 'Open this message as a new child thread.', source: 'local', takesArgs: true },
  { name: 'btw', description: 'Alias for /branch.', source: 'local', takesArgs: true },
  { name: 'fanout', description: 'Spawn N parallel child branches: /fanout A; B; C', source: 'local', takesArgs: true },
  { name: 'fan-out', description: 'Alias for /fanout.', source: 'local', takesArgs: true },
  { name: 'explore', description: 'Alias for /fanout.', source: 'local', takesArgs: true },
  { name: 'compact', description: 'Summarize the conversation so far to free up context.', source: 'local', takesArgs: true,
    hint: '[instructions]', runsCommand: true },
];

/** Who provides a library skill, in the / menu and the transcript. */
const LIBRARY_SKILL_SOURCE = 'Michi';
/** Who provides one of Michi's built-in skills. */
const BUILTIN_SKILL_SOURCE = 'Built-in';

/** The label of a skill's source: the library's, the built-in one, or its runtime's. */
export function skillSourceLabel(origin: SkillOrigin, runtimeLabel: string): string {
  return origin === 'library' ? LIBRARY_SKILL_SOURCE : origin === 'builtin' ? BUILTIN_SKILL_SOURCE : runtimeLabel;
}

/**
 * The node's live session commands, when that session runs on `runtimeId`.
 * After a runtime switch they belong to the old runtime until the next
 * session reports its own.
 */
export function liveSlashCommands(
  node: Pick<ChatNodeState, 'agentCommands' | 'runtimeId' | 'sessionState'> | undefined,
  runtimeId: string | undefined,
): AgentCommand[] | undefined {
  const sessionRuntimeId = node?.sessionState?.runtimeId ?? node?.runtimeId;
  return sessionRuntimeId && runtimeId && sessionRuntimeId !== runtimeId ? undefined : node?.agentCommands;
}

function commandEntry(command: AgentCommand, runs: boolean): SlashEntry {
  const hint = command.argumentHint ?? command.input?.hint;
  return {
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    source: 'runtime',
    // An `input` (ACP: unstructured) means free text may follow the command.
    takesArgs: !!command.input || !!command.argumentHint,
    ...(hint ? { hint } : {}),
    ...(runs ? { runsCommand: true } : {}),
  };
}

/**
 * The runtime's commands: the catalog's, then those only the live session
 * lists; for a command both list, what the session says wins. Only the
 * catalog's and the session's `kind: 'command'` ones go to the command
 * path. Another command a session advertises is listed and sent as text,
 * which its agent may run itself (a standard ACP agent has no command
 * request). A runtime that advertises its skills as plain commands marks
 * them as skills in its adapter.
 */
function runtimeCommandEntries(catalog: readonly AgentCommand[], live: readonly AgentCommand[]): SlashEntry[] {
  const byName = new Map<string, { command: AgentCommand; runs: boolean }>();
  const add = (command: AgentCommand, runs: boolean) => {
    if (command.kind === 'skill' || command.kind === 'prompt' || !SLASH_COMMAND_NAME.test(command.name)) return;
    const key = command.name.toLowerCase();
    const known = byName.get(key);
    byName.set(key, { command: { ...known?.command, ...command }, runs: runs || !!known?.runs });
  };
  // Once a session names the commands Michi runs for it, the catalog's list (the runtime's
  // guess for a chat without a session) keeps only what the session lists too.
  const sessionNamed = live.some((command) => command.kind === 'command');
  const liveNames = new Set(live.map((command) => command.name.toLowerCase()));
  for (const command of catalog) if (!sessionNamed || liveNames.has(command.name.toLowerCase())) add(command, true);
  for (const command of live) add(command, command.kind === 'command');
  return [...byName.values()].map(({ command, runs }) => commandEntry(command, runs));
}

function skillEntry(name: string, skill: SlashSkill, fields: { description?: string; hint?: string; sourceLabel: string }): SlashEntry {
  return {
    name,
    ...(fields.description ? { description: fields.description } : {}),
    source: 'skill',
    takesArgs: true,
    ...(fields.hint ? { hint: fields.hint } : {}),
    sourceLabel: fields.sourceLabel,
    skill,
  };
}

/**
 * The catalog's skills a person may run, library first, then built-in, by the name each is
 * run by; then the skill commands the live session lists that the runtime's
 * catalog skills lack (Kiro powers and agent resources, and every one before
 * the runtime's listing answers). A runtime skill the menu must not offer
 * (`userInvocable` or `enabled` false) keeps its live command out too.
 * Sessions leave the library's own rows out, since the catalog lists the
 * library. Prompts stay out for now: Kiro expands one only when it starts
 * the whole message, which the context Michi adds prevents. Of two skills
 * one runtime runs by the same name, the first listed is kept.
 */
function skillEntries(catalog: SlashSkillCatalog, live: readonly AgentCommand[], runtimeId: string | undefined, runtimeLabel: string): SlashEntry[] {
  const entries: SlashEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: SlashEntry) => {
    const key = `${entry.skill?.origin}:${entry.name.toLowerCase()}`;
    if (!SLASH_COMMAND_NAME.test(entry.name) || seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };
  const ofOrigin = (origin: SkillOrigin) => catalog.skills.filter((skill) => skill.origin === origin);
  const runtimeSkills = ofOrigin('runtime');
  const runnable = (skill: SkillSummary) => skill.userInvocable && skill.enabled;
  for (const skill of [...ofOrigin('library'), ...ofOrigin('builtin'), ...runtimeSkills].filter(runnable)) {
    const michi = skill.origin !== 'runtime';
    const skillRuntimeId = michi ? undefined : skill.runtimeId ?? runtimeId;
    add(skillEntry(michi ? skill.name : skill.nativeName ?? skill.name,
      { id: skill.id, name: skill.name, origin: skill.origin, ...(skillRuntimeId ? { runtimeId: skillRuntimeId } : {}) },
      { description: skill.description, hint: skill.argumentHint, sourceLabel: skillSourceLabel(skill.origin, runtimeLabel) }));
  }
  if (!runtimeId) return entries;
  const known = new Set(runtimeSkills.flatMap((skill) => [skill.name, skill.nativeName ?? '']).filter(Boolean).map((name) => name.toLowerCase()));
  for (const command of live) {
    if (command.kind !== 'skill') continue;
    if ([command.name, ...(command.aliases ?? [])].some((name) => known.has(name.toLowerCase()))) continue;
    add(skillEntry(command.name, { id: liveSkillId(runtimeId, command.name), name: command.name, origin: 'runtime', runtimeId },
      { description: command.description, hint: command.argumentHint ?? command.input?.hint, sourceLabel: runtimeLabel }));
  }
  return entries;
}

/** Skill rows whose name another entry has get a tag: "Skill" beside a command, the source beside another skill. */
function tagSharedNames(entries: SlashEntry[]): SlashEntry[] {
  const byName = new Map<string, SlashEntry[]>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  return entries.map((entry) => {
    const same = byName.get(entry.name.toLowerCase()) ?? [];
    if (entry.source !== 'skill' || same.length < 2) return entry;
    return { ...entry, tag: same.filter((other) => other.source === 'skill').length > 1 ? entry.sourceLabel : 'Skill' };
  });
}

export interface SlashEntrySources {
  /** The live session's commands (liveSlashCommands). */
  agentCommands?: readonly AgentCommand[];
  /** Absent on a backend without skills. */
  catalog?: SlashSkillCatalog;
  /** False where skills do not run (the assistant's chats): only the commands are listed. */
  skills?: boolean;
  /** The runtime the next message runs on. */
  runtimeId?: string;
  /** Its label, for the skills it provides; the id when unknown. */
  runtimeLabel?: string;
}

/** Every / entry for a chat, in menu order. A runtime command named like one of Michi's is left out. */
export function buildSlashEntries({ agentCommands = [], catalog, skills = true, runtimeId, runtimeLabel }: SlashEntrySources): SlashEntry[] {
  const local = new Set(LOCAL_SLASH_COMMANDS.map((entry) => entry.name));
  const commands = runtimeCommandEntries(catalog?.commands ?? [], agentCommands)
    .filter((command) => !local.has(command.name.toLowerCase()));
  const skillRows = catalog && skills ? skillEntries(catalog, agentCommands, runtimeId, runtimeLabel ?? runtimeId ?? 'Runtime') : [];
  return tagSharedNames([...LOCAL_SLASH_COMMANDS, ...commands, ...skillRows]);
}

export type SlashRun =
  | { kind: 'skill'; skill: SlashSkill; args: string }
  | { kind: 'command'; name: string; value?: string };

/**
 * What sending `text` runs. The row picked from the menu, while the text
 * still starts with its `/name`; otherwise the first entry of that name, so
 * a command wins over a skill and a library skill over a runtime's. Null for
 * an ordinary message: prose, a name nothing has, Michi's TPane commands,
 * or a command followed by more lines.
 */
export function resolveSlashRun(text: string, entries: readonly SlashEntry[], picked?: SlashEntry): SlashRun | null {
  const trimmed = text.trim();
  const invocation = parseSlashInvocation(trimmed);
  if (!invocation) return null;
  const name = invocation.name.toLowerCase();
  const entry = picked?.name === invocation.name ? picked : entries.find((candidate) => candidate.name.toLowerCase() === name);
  if (entry?.skill) return { kind: 'skill', skill: entry.skill, args: invocation.args };
  if (!entry?.runsCommand) return null;
  const line = /^\S+(?:[ \t]+([^\r\n]*))?$/.exec(trimmed);
  if (!line) return null;
  const value = line[1]?.trim();
  return { kind: 'command', name: entry.name, ...(value ? { value } : {}) };
}

/** The pick a send honours: one made in the menu of the runtime it runs on. */
export function pickedSlashEntry(pick: SlashPick | undefined, runtimeId: string | undefined): SlashEntry | undefined {
  return pick && pick.runtimeId === runtimeId ? pick.entry : undefined;
}

/** Whether `text` still starts with the `/name` a row was picked for, so the pick stands. */
export function keepsSlashPick(text: string, name: string): boolean {
  return text.startsWith(`/${name}`) && /^(\s|$)/.test(text.slice(name.length + 1));
}

/**
 * What a repeated message (a retry, or an edit that keeps its /name) runs:
 * the skill it ran, by the id it ran with, with the arguments its text has
 * now. Where that skill is gone the backend refuses it, and the chat says
 * so; a repeat never becomes a command or plain text instead.
 */
export function recordedSlashSkill(recorded: SkillMessageMetadata | undefined, text: string): SlashRun | null {
  if (!recorded) return null;
  return {
    kind: 'skill',
    skill: { id: recorded.id, name: recorded.name, origin: recorded.origin, ...(recorded.runtimeId ? { runtimeId: recorded.runtimeId } : {}) },
    args: parseSlashInvocation(text.trim())?.args ?? recorded.args,
  };
}
