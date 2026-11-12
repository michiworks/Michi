/**
 * Settings a developer can change without a rebuild: a localStorage
 * override first, then the build's VITE_* value. A value the parser does
 * not accept counts as unset.
 */
export function readRuntimeSetting<T>(storageKey: string, env: unknown, parse: (value: unknown) => T | null): T | null {
  if (typeof window !== 'undefined') {
    try {
      const stored = parse(window.localStorage.getItem(storageKey));
      if (stored !== null) return stored;
    } catch {
      // Storage can be unavailable (privacy mode); the build's value still applies.
    }
  }
  return parse(env);
}

const ON = new Set(['1', 'true', 'yes', 'on']);
const OFF = new Set(['0', 'false', 'no', 'off']);

/** On, off, or null when unset or unrecognised, so the caller's default applies. Any case. */
export function parseTriStateFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase();
  if (ON.has(word)) return true;
  if (OFF.has(word)) return false;
  return null;
}
