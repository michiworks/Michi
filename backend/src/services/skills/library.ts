import fs from 'node:fs';
import path from 'node:path';
import { isValidSkillName, readSkillFileInfo } from 'michi-shared';
import { readSkillMarkdown } from './files';
import { skillLibraryRoot, skillsAvailable } from './paths';
import { disabledLibrarySkills } from './state';

/** One skill folder in the Michi library. */
export interface LibrarySkill {
  name: string;
  /** The skill folder. */
  dir: string;
  /** Its SKILL.md. */
  path: string;
  description: string;
  argumentHint?: string;
  userInvocable: boolean;
  modelInvocable: boolean;
  /** Off while skills-state.json cannot be read: runtimes then get no library skill. */
  enabled: boolean;
  /** The real folder when the library entry is a link to one kept elsewhere. */
  linkTarget?: string;
  /** Frontmatter problems worth showing. */
  warnings: string[];
}

function toLibrarySkill(name: string, content: string, disabled: ReadonlySet<string> | null): LibrarySkill {
  const dir = path.join(skillLibraryRoot(), name);
  const info = readSkillFileInfo(content, name);
  const warnings = [...info.warnings];
  if (info.name !== name) warnings.push(`frontmatter name "${info.name}" differs from the folder name`);
  let linkTarget: string | undefined;
  try { if (fs.lstatSync(dir).isSymbolicLink()) linkTarget = fs.realpathSync(dir); } catch { /* the SKILL.md read above already answered */ }
  return {
    name,
    dir,
    path: path.join(dir, 'SKILL.md'),
    description: info.description,
    ...(info.argumentHint ? { argumentHint: info.argumentHint } : {}),
    userInvocable: info.userInvocable,
    modelInvocable: info.modelInvocable,
    enabled: disabled !== null && !disabled.has(name),
    ...(linkTarget ? { linkTarget } : {}),
    warnings,
  };
}

/**
 * The library's skills, by folder name. Folders whose name is not a valid
 * skill name, or that hold no readable SKILL.md, are skipped: they can be
 * neither mounted nor invoked by name. Empty in cloud mode.
 */
export function listLibrarySkills(): LibrarySkill[] {
  if (!skillsAvailable()) return [];
  let entries: string[];
  try { entries = fs.readdirSync(skillLibraryRoot()).sort(); }
  catch { return []; }
  const disabled = disabledLibrarySkills();
  const skills: LibrarySkill[] = [];
  for (const name of entries) {
    if (!isValidSkillName(name)) continue;
    const content = readSkillMarkdown(path.join(skillLibraryRoot(), name, 'SKILL.md'));
    if (content !== null) skills.push(toLibrarySkill(name, content, disabled));
  }
  return skills;
}

/** The skills every runtime's sessions get. */
export function enabledLibrarySkills(): LibrarySkill[] {
  return listLibrarySkills().filter((skill) => skill.enabled);
}

export function getLibrarySkill(name: string): LibrarySkill | null {
  const content = readLibrarySkillContent(name);
  return content === null ? null : toLibrarySkill(name, content, disabledLibrarySkills());
}

/** The whole SKILL.md of a library skill, or null. */
export function readLibrarySkillContent(name: string): string | null {
  if (!skillsAvailable() || !isValidSkillName(name)) return null;
  return readSkillMarkdown(path.join(skillLibraryRoot(), name, 'SKILL.md'));
}
