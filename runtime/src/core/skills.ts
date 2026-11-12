import fs from 'node:fs/promises';
import path from 'node:path';
import { readSkillFileInfo } from 'michi-shared';
import type { FirstTurnPrefixInput, SessionProfilePort } from '../contract/host';
import type { RuntimeSkill, RuntimeSkillListing, RuntimeToolProfile, SkillTurnInvocation } from '../contract/types';

/** SKILL.md files above this size are skipped rather than read into a prompt or a listing. */
export const SKILL_FILE_MAX_BYTES = 256 * 1024;
const SKILLS_PER_ROOT_MAX = 500;

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** `$ARGUMENTS` and `${ARGUMENTS}`; Claude's indexed `$ARGUMENTS[0]` is left alone, and `$1` is not a placeholder here. */
const ARGUMENTS_PLACEHOLDER = /\$\{ARGUMENTS\}|\$ARGUMENTS(?!\[)/g;

/** The body with its arguments placeholders replaced by what the user wrote (Claude-compatible). */
export function substituteSkillArguments(body: string, args: string): string {
  return body.replace(ARGUMENTS_PLACEHOLDER, () => args);
}

/**
 * The part of a skill turn's text that is not the skill's arguments: what
 * the composer or host put around them (mentions, quotes, the list of
 * attached files). The arguments are the last copy of them on lines of
 * their own: a plain search could stop inside the list, whose names and
 * paths may contain them. Without such a copy the whole text is context.
 */
export function skillContextText(text: string, args: string): string {
  const trimmed = text.trim();
  if (!args) return trimmed;
  // Each search resumes at the newline that ends the copy before, so
  // copies on adjacent lines are found and the scan stays linear.
  const lines = `\n${trimmed}\n`;
  const copy = `\n${args}\n`;
  let at = -1;
  for (let found = lines.indexOf(copy); found >= 0; found = lines.indexOf(copy, found + copy.length - 1)) at = found;
  if (at < 0) return trimmed;
  return [trimmed.slice(0, at).trimEnd(), trimmed.slice(at + args.length).trimStart()].filter(Boolean).join('\n\n');
}

/**
 * A skill turn as a session's history keeps it: the turn's context, then
 * the command the person ran. A branch's preamble quotes this history,
 * where the expanded skill would copy its whole SKILL.md.
 */
export function skillHistoryText(skill: SkillTurnInvocation, text: string): string {
  const command = `/${skill.nativeName ?? skill.name}${skill.args ? ` ${skill.args}` : ''}`;
  return [skillContextText(text, skill.args), command].filter(Boolean).join('\n\n');
}

/**
 * The Agent Skills block a host sends when the runtime does not run the
 * skill itself (the format Pi uses for `/skill:name`).
 */
export function renderSkillBlock(skill: SkillTurnInvocation): string {
  const body = substituteSkillArguments(skill.body ?? '', skill.args).trim();
  if (!skill.path) return `<skill name="${attribute(skill.name)}">\n${body}\n</skill>`;
  const baseDir = path.dirname(skill.path);
  return `<skill name="${attribute(skill.name)}" location="${attribute(skill.path)}">\n`
    + `References are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

/**
 * Prompt text for a skill turn the runtime cannot run natively: the skill
 * block, then the turn's text. A body that places the arguments itself is
 * followed by the text without them. Without a body (a skill known only by
 * name) the runtime gets the command as text, which is how Kiro and
 * Antigravity read a typed command.
 */
export function expandSkillPrompt(skill: SkillTurnInvocation, text: string): string {
  if (skill.body === undefined) {
    const command = `/${skill.nativeName ?? skill.name}`;
    return text ? `${command} ${text}` : command;
  }
  const block = renderSkillBlock(skill);
  const rest = skill.args && new RegExp(ARGUMENTS_PLACEHOLDER.source).test(skill.body) ? skillContextText(text, skill.args) : text;
  return rest ? `${block}\n\n${rest}` : block;
}

/**
 * The first-turn field that has the host name the skills a chat may load
 * (FirstTurnPrefixInput.hostSkills): only for an ordinary chat, which has the
 * host's skills tool; not for Agent Runs, the assistant or maintenance.
 */
export function hostSkillsPrefix(
  profiles: Pick<SessionProfilePort, 'isRestricted' | 'isMaintenance'>,
  input: { interactive: boolean; toolProfile: RuntimeToolProfile | null | undefined; librarySkillsLoaded: boolean },
): Pick<FirstTurnPrefixInput, 'hostSkills'> {
  const { interactive, toolProfile } = input;
  if (!interactive || toolProfile?.assistant || profiles.isRestricted(toolProfile) || profiles.isMaintenance?.(toolProfile)) return {};
  return { hostSkills: { librarySkillsLoaded: input.librarySkillsLoaded } };
}

export interface SkillScanRoot {
  /** A folder whose child folders hold SKILL.md files (~/.kiro/skills). */
  dir: string;
  scope: string;
  /** Set when the whole root is owned by another tool. */
  managedBy?: string;
}

async function isFile(target: string): Promise<boolean> {
  try { return (await fs.stat(target)).isFile(); } catch { return false; }
}

async function managedByOf(skillDir: string, rootManagedBy: string | undefined): Promise<string | undefined> {
  if (rootManagedBy) return rootManagedBy;
  try {
    const real = await fs.realpath(skillDir);
    const parts = real.split(path.sep);
    const kiro = parts.lastIndexOf('.kiro');
    // Compared as a path pair: the folder name is not a runtime id (runtimeBoundary.cjs counts bare id literals).
    if (kiro >= 0 && parts.slice(kiro, kiro + 2).join('/') === '.kiro/crew') return 'Crew';
  } catch { /* unreadable: no owner */ }
  return undefined;
}

/**
 * Reads `<root>/<name>/SKILL.md` for each root, following symlinked
 * folders, the way Kiro, Antigravity and Claude's personal and project
 * folders are laid out. A missing root is not an error. Earlier roots win
 * a name clash, matching the precedence the caller passes.
 */
export async function scanSkillRoots(roots: readonly SkillScanRoot[]): Promise<RuntimeSkillListing> {
  const skills: RuntimeSkill[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try { entries = (await fs.readdir(root.dir)).sort(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') errors.push(`${root.dir}: ${(error as Error).message}`);
      continue;
    }
    let count = 0;
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (count >= SKILLS_PER_ROOT_MAX) { errors.push(`${root.dir}: more than ${SKILLS_PER_ROOT_MAX} skills; the rest are not listed`); break; }
      const skillDir = path.join(root.dir, entry);
      const file = path.join(skillDir, 'SKILL.md');
      let stat;
      try { stat = await fs.stat(file); } catch { continue; }
      if (!stat.isFile()) continue;
      count += 1;
      if (stat.size > SKILL_FILE_MAX_BYTES) { errors.push(`${file}: larger than ${SKILL_FILE_MAX_BYTES} bytes`); continue; }
      let content: string;
      try { content = await fs.readFile(file, 'utf8'); }
      catch (error) { errors.push(`${file}: ${(error as Error).message}`); continue; }
      const info = readSkillFileInfo(content, entry);
      if (seen.has(info.name)) continue;
      seen.add(info.name);
      const managedBy = await managedByOf(skillDir, root.managedBy);
      skills.push({
        name: info.name,
        description: info.description,
        path: file,
        scope: root.scope,
        ...(info.argumentHint ? { argumentHint: info.argumentHint } : {}),
        userInvocable: info.userInvocable,
        modelInvocable: info.modelInvocable,
        ...(managedBy ? { managedBy } : {}),
      });
    }
  }
  return { skills, ...(errors.length ? { errors } : {}) };
}
