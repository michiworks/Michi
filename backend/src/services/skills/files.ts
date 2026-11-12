import fs from 'node:fs';
import path from 'node:path';
import { SKILL_FILE_MAX_BYTES } from 'michi-runtime';
import { isWithinRoot } from '../../agents/tools/pathSandbox';

/**
 * The files of one skill folder, for the Skills page and the michi_skills
 * tool. Callers pass a folder the backend resolved itself (a library folder
 * or the folder of a SKILL.md a runtime listed); a relative path inside it
 * may come from a client or a model, so reads stay inside the folder's real
 * path.
 */

/** Files a folder listing returns at most. */
const SKILL_FILES_MAX = 200;
const LIST_DEPTH_MAX = 8;
/** Version-control data is not part of a skill. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['.git']);

export class SkillFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFileError';
  }
}

export function realpathOrSelf(target: string): string {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

/** A link inside the folder counts as a file when it resolves to one that stays inside. */
function isListedFile(entry: fs.Dirent, full: string, root: string): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return isWithinRoot(fs.realpathSync(full), root) && fs.statSync(full).isFile();
  } catch {
    return false;
  }
}

/**
 * The folder's files other than its SKILL.md, as sorted relative POSIX
 * paths, at most SKILL_FILES_MAX. Linked folders inside it are not entered.
 */
export function listSkillFiles(dir: string): string[] {
  const root = realpathOrSelf(dir);
  const files: string[] = [];
  const walk = (current: string, prefix: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= SKILL_FILES_MAX) return;
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && depth < LIST_DEPTH_MAX) walk(full, relative, depth + 1);
      } else if (!(depth === 0 && entry.name === 'SKILL.md') && isListedFile(entry, full, root)) {
        files.push(relative);
      }
    }
  };
  walk(root, '', 0);
  return files;
}

/** A path relative to a skill folder, POSIX-style, that cannot name anything above it. */
function relativeSegments(relative: string): string[] {
  if (typeof relative !== 'string' || !relative.trim() || relative.length > 1024 || relative.includes('\0')) {
    throw new SkillFileError('file must be a path relative to the skill folder');
  }
  if (relative.includes('\\') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new SkillFileError('file must be a relative path with / separators, as the skill lists it');
  }
  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../')) throw new SkillFileError('file must stay inside the skill folder');
  return normalized.split('/').filter((segment) => segment && segment !== '.');
}

/**
 * A text file inside a skill folder, by its relative path. Links are
 * followed only while their target stays inside the folder.
 */
export function readSkillFolderFile(dir: string, relative: string): { path: string; text: string } {
  const segments = relativeSegments(relative);
  if (segments.length === 0) throw new SkillFileError('file must name a file inside the skill folder');
  let root: string;
  let target: string;
  try {
    root = fs.realpathSync(dir);
    target = fs.realpathSync(path.join(root, ...segments));
  } catch {
    throw new SkillFileError(`No file ${relative} in this skill`);
  }
  if (!isWithinRoot(target, root)) throw new SkillFileError(`${relative} is outside the skill folder`);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new SkillFileError(`${relative} is not a file`);
  if (stat.size > SKILL_FILE_MAX_BYTES) {
    throw new SkillFileError(`${relative} is larger than ${SKILL_FILE_MAX_BYTES / 1024} KiB; open it at ${target} with your own file tools`);
  }
  const bytes = fs.readFileSync(target);
  if (bytes.includes(0)) throw new SkillFileError(`${relative} is not a text file`);
  return { path: target, text: bytes.toString('utf8') };
}

/** A SKILL.md the backend may read: a regular file within the size limit. */
export function readSkillMarkdown(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > SKILL_FILE_MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
