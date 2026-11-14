const WINDOW_DRAFTS = '__michiWindowDrafts';
const PENDING_SPAWN_PROMPT = '__michiPendingSpawnPrompt';

function parseObject(raw: string | null | undefined): Record<string, unknown> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Preserve the legacy draft and spawn outbox while changing one window's draft. */
export function mergeWindowComposerDraft(raw: string | null | undefined, windowId: string, draft: string | null): string {
  const current = parseObject(raw);
  const drafts = parseObject(JSON.stringify(current[WINDOW_DRAFTS] ?? {}));
  return JSON.stringify({ ...current, [WINDOW_DRAFTS]: { ...drafts, [windowId]: draft } });
}

/** An explicit null is a cleared draft; it must not fall back to the legacy value. */
export function selectWindowComposerDraft(raw: string | null | undefined, windowId: string): string | null {
  const current = parseObject(raw);
  const drafts = current[WINDOW_DRAFTS];
  if (drafts && typeof drafts === 'object' && Object.prototype.hasOwnProperty.call(drafts, windowId)) {
    const value = (drafts as Record<string, unknown>)[windowId];
    return typeof value === 'string' ? value : null;
  }
  return raw ?? null;
}

/** Legacy clients/outbox writers may update the shared field without erasing window drafts. */
export function mergeLegacyComposerDraft(raw: string | null | undefined, draft: string | null): string | null {
  const current = parseObject(raw);
  if (!current[WINDOW_DRAFTS]) return draft;
  return JSON.stringify({ ...parseObject(draft), [WINDOW_DRAFTS]: current[WINDOW_DRAFTS] });
}

/**
 * Drops a legacy agent-spawn outbox (a child's first prompt, which windows
 * once sent themselves), blank included, and keeps window drafts; undefined
 * when there is no outbox. The backend starts a spawned child's first turn
 * now, so only rows written before that carry one.
 */
export function clearSpawnPromptFromComposerDraft(raw: string): string | null | undefined {
  const current = parseObject(raw);
  if (typeof current[PENDING_SPAWN_PROMPT] !== 'string') return undefined;
  delete current[PENDING_SPAWN_PROMPT];
  return Object.keys(current).length > 0 ? JSON.stringify(current) : null;
}
