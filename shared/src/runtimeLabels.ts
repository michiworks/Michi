/**
 * The short names of the agent runtimes, as their backend registers them
 * (each runtime's `label`, shortened by shortRuntimeLabel). A backend's own
 * labels, from /agent/status or the skill catalog, come first; this is the
 * fallback until they are known, and for code without a backend to ask.
 * backend/test/runtimeFactoryHost.test.ts keeps it equal to the registrations.
 */
export const RUNTIME_SHORT_LABELS: Readonly<Record<string, string>> = {
  kiro: 'Kiro',
  crew: 'Kiro Crew',
  pi: 'Pi',
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  grok: 'Grok',
};

/** The short name of a known runtime id; undefined for one this table does not know. */
export function runtimeShortLabel(runtimeId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(RUNTIME_SHORT_LABELS, runtimeId) ? RUNTIME_SHORT_LABELS[runtimeId] : undefined;
}

/** "Pi (multi-provider)" → "Pi". */
export function shortRuntimeLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label;
}
