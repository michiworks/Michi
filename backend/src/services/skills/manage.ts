import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isValidSkillName, validateLibrarySkill, withSkillFileName } from 'michi-shared';
import { SKILL_FILE_MAX_BYTES } from 'michi-runtime';
import { writeFileAtomicSync } from 'michi-runtime/internal/core/atomicFile';
import { log } from '../logger';
import { getBuiltinSkill, type BuiltinSkill } from './builtin';
import { notifySkillLibraryChanged } from './events';
import { getLibrarySkill, readLibrarySkillContent, type LibrarySkill } from './library';
import { skillLibraryRoot, skillsAvailable } from './paths';
import { disabledLibrarySkills, updateSkillsState, type SkillsState } from './state';

/**
 * Changes to the Michi skill library: one folder per skill under
 * skillLibraryRoot(), which ones are off in skills-state.json. A new folder
 * is staged under a dot name, which neither the library nor runtimes list,
 * and moved into place whole; SKILL.md edits replace the file whole. Each
 * change ends with notifySkillLibraryChanged(), which re-links the runtime
 * mounts.
 */

export type SkillLibraryErrorCode = 'invalid_argument' | 'invalid_skill' | 'name_taken' | 'not_found' | 'skills_unavailable' | 'runtime_unavailable';

export class SkillLibraryError extends Error {
  constructor(readonly code: SkillLibraryErrorCode, message: string, readonly problems: string[] = []) {
    super(message);
    this.name = 'SkillLibraryError';
  }
}

export interface LibrarySkillPatch {
  content?: string;
  newName?: string;
  enabled?: boolean;
}

function requireLibrary(): void {
  if (!skillsAvailable()) throw new SkillLibraryError('skills_unavailable', 'The skill library is not available on this backend');
}

function exists(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch { return false; }
}

function nameTaken(name: string): SkillLibraryError {
  return new SkillLibraryError('name_taken', `A library skill named "${name}" already exists`);
}

function notFound(name: string): SkillLibraryError {
  return new SkillLibraryError('not_found', `No library skill named "${name}"`);
}

function validated(name: string, content: string): string {
  const problems = Buffer.byteLength(content, 'utf8') > SKILL_FILE_MAX_BYTES
    ? [`SKILL.md is larger than ${SKILL_FILE_MAX_BYTES / 1024} KiB.`]
    : validateLibrarySkill({ name, content });
  if (problems.length) throw new SkillLibraryError('invalid_skill', problems[0], problems);
  return content;
}

function invalidName(name: string): SkillLibraryError {
  const problem = 'Name must be 1-64 lowercase letters, digits or single hyphens, not starting or ending with a hyphen.';
  return new SkillLibraryError('invalid_skill', `"${name}" is not a skill name. ${problem}`, [problem]);
}

/** Replace a SKILL.md whole, keeping its mode; a linked one is written where it points. */
function writeSkillFile(file: string, content: string): void {
  writeFileAtomicSync(file, content, { mode: 'preserve', followSymlink: true });
}

/** A failed rename onto a name another skill took meanwhile is name_taken. */
function renameError(error: unknown, target: string, name: string): unknown {
  return exists(target) ? nameTaken(name) : error;
}

function installed(name: string): LibrarySkill {
  const skill = getLibrarySkill(name);
  if (!skill) throw new Error(`The library skill "${name}" could not be read back`);
  return skill;
}

/** The state without the setting a name keeps (a folder deleted by hand may have left it off). */
function withoutSetting(state: SkillsState, name: string): SkillsState {
  if (!(name in state.library)) return state;
  const { [name]: _dropped, ...library } = state.library;
  return { ...state, library };
}

/** A new skill, on. */
export function createLibrarySkill(name: string, content: string): LibrarySkill {
  requireLibrary();
  if (!isValidSkillName(name)) throw invalidName(name);
  validated(name, content);
  const root = skillLibraryRoot();
  const dir = path.join(root, name);
  if (exists(dir)) throw nameTaken(name);
  // Staged and moved whole: an interrupted create leaves no folder that holds the name without a SKILL.md.
  fs.mkdirSync(root, { recursive: true });
  const staged = path.join(root, `.${name}.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, 'SKILL.md'), content);
    if (disabledLibrarySkills()?.has(name)) updateSkillsState((state) => withoutSetting(state, name));
    if (exists(dir)) throw nameTaken(name);
    try { fs.renameSync(staged, dir); }
    catch (error) { throw renameError(error, dir, name); }
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
  notifySkillLibraryChanged();
  return installed(name);
}

/**
 * Edit, turn on or off, or rename a library skill. A rename moves the folder
 * and its setting; without new content the frontmatter name follows the
 * folder.
 */
export function updateLibrarySkill(name: string, patch: LibrarySkillPatch): LibrarySkill {
  requireLibrary();
  const current = getLibrarySkill(name);
  const previousContent = current ? readLibrarySkillContent(name) : null;
  if (!current || previousContent === null) throw notFound(name);
  const target = patch.newName ?? name;
  if (!isValidSkillName(target)) throw invalidName(target);
  const renaming = target !== name;
  const targetDir = path.join(skillLibraryRoot(), target);
  if (renaming && exists(targetDir)) throw nameTaken(target);
  const content = patch.content !== undefined ? validated(target, patch.content)
    : renaming ? withSkillFileName(previousContent, target) : previousContent;
  const contentChanged = content !== previousContent;
  if (!contentChanged && !renaming && patch.enabled === undefined) return current;

  if (contentChanged) writeSkillFile(current.path, content);
  const undoContent = () => { if (contentChanged) { try { writeSkillFile(current.path, previousContent); } catch { /* best effort */ } } };
  if (renaming) {
    try {
      fs.renameSync(current.dir, targetDir);
    } catch (error) {
      undoContent();
      throw renameError(error, targetDir, target);
    }
  }
  // A SKILL.md edit alone needs no settings, so a locked or unreadable state
  // file must not refuse it. A rename or a switch does need them, and is
  // then refused whole: a failed request leaves nothing half done.
  if (renaming || patch.enabled !== undefined) {
    try {
      updateSkillsState((state) => {
        const off = patch.enabled === undefined ? name in state.library : !patch.enabled;
        // The new name's own setting, if any, is a leftover of a folder deleted by hand.
        const next = withoutSetting(withoutSetting(state, name), target);
        return off ? { ...next, library: { ...next.library, [target]: { enabled: false } } } : next;
      });
    } catch (error) {
      if (renaming) { try { fs.renameSync(targetDir, current.dir); } catch { /* best effort */ } }
      undoContent();
      throw error;
    }
  }
  notifySkillLibraryChanged();
  return installed(target);
}

/** Remove a library skill. A linked folder loses only its link; what it points to is left alone. */
export function deleteLibrarySkill(name: string): void {
  requireLibrary();
  if (!isValidSkillName(name)) throw notFound(name);
  const dir = path.join(skillLibraryRoot(), name);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(dir); }
  catch { throw notFound(name); }
  if (stat.isSymbolicLink()) fs.unlinkSync(dir);
  else if (stat.isDirectory()) fs.rmSync(dir, { recursive: true });
  else throw notFound(name);
  try {
    if (disabledLibrarySkills()?.has(name)) updateSkillsState((state) => withoutSetting(state, name));
  } catch (error) {
    // A skill created under the name later clears what is left.
    log.warn('workspace', 'could not clear the settings of a deleted skill', { name, error: (error as Error).message });
  }
  notifySkillLibraryChanged();
}

/** Turn a built-in skill on or off; it has nothing else to change. */
export function setBuiltinSkillEnabled(name: string, enabled: boolean): BuiltinSkill {
  requireLibrary();
  if (!getBuiltinSkill(name)) throw new SkillLibraryError('not_found', `No built-in skill named "${name}"`);
  updateSkillsState((state) => {
    const { [name]: _dropped, ...builtin } = state.builtin;
    return { ...state, builtin: enabled ? builtin : { ...builtin, [name]: { enabled: false } } };
  });
  const skill = getBuiltinSkill(name);
  if (!skill) throw new Error(`The built-in skill "${name}" could not be read back`);
  return skill;
}
