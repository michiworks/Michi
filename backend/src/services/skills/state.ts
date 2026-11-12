import { readJsonConfig, updateJsonConfig, type JsonConfig } from '../jsonConfigStore';
import { skillStatePath } from './paths';

/**
 * skills-state.json: which library and built-in skills are off; a skill
 * without an entry is on. A file an older build wrote (runtime lists, hidden ids, import
 * sources) reads the same way: anything but `enabled: false` is ignored, and
 * the next write keeps only the off entries.
 */
export interface SkillsState {
  version: 1;
  library: Record<string, { enabled: false }>;
  /** Built-in skills (builtin.ts) that are off, by name: a library skill may share one. */
  builtin: Record<string, { enabled: false }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function offEntries(value: unknown): Record<string, { enabled: false }> {
  const off: Record<string, { enabled: false }> = {};
  if (isObject(value)) {
    for (const [name, settings] of Object.entries(value)) {
      if (isObject(settings) && settings.enabled === false) off[name] = { enabled: false };
    }
  }
  return off;
}

function parseSkillsState(value: JsonConfig | null): SkillsState {
  return { version: 1, library: offEntries(value?.library), builtin: offEntries(value?.builtin) };
}

/** Throws when the file cannot be read (jsonConfigStore: corrupt, locked, unreadable). */
export function readSkillsState(): SkillsState {
  return parseSkillsState(readJsonConfig(skillStatePath()));
}

/** The library skills that are off, or null when the state file cannot be read. */
export function disabledLibrarySkills(): ReadonlySet<string> | null {
  try { return new Set(Object.keys(readSkillsState().library)); }
  catch { return null; }
}

/** The built-in skills that are off, or null when the state file cannot be read. */
export function disabledBuiltinSkills(): ReadonlySet<string> | null {
  try { return new Set(Object.keys(readSkillsState().builtin)); }
  catch { return null; }
}

/** Read, change and replace the state file under its lock. */
export function updateSkillsState(update: (state: SkillsState) => SkillsState): void {
  updateJsonConfig(skillStatePath(), (existing) => update(parseSkillsState(existing)) as unknown as JsonConfig);
}
