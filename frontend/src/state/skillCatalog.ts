import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { runtimeShortLabel, type SkillCatalogResponse } from 'michi-shared';
import { backendConnectionIdForWorkspace, LOCAL_BACKEND_CONNECTION_ID } from '../config/backendConnections';
import { fetchSkillCatalog, isSkillsUnavailable, SKILLS_CHANGED_EVENT } from '../services/api/skills';
import type { SlashSkillCatalog } from './slashEntries';

/**
 * The composer's / menu catalogs (GET /skills/catalog), one per backend,
 * workspace and runtime, which the menu and a send read synchronously (a
 * typed `/name` may first wait briefly for an answer). The backend keeps the
 * listings fresh; this shows its last answer. A pane asks again in the
 * background when it gets focus or opens its menu once that answer is older
 * than STALE_MS, or after a change, at once while it has focus: a skill
 * written in this window (SKILLS_CHANGED_EVENT), or the window coming back,
 * after which skill folders may differ.
 *
 * The backend answers with the library skills and the commands without
 * waiting long for the runtime's own listing. An answer whose runtime is
 * still listing (`pending`) or whose listing failed is shown, and asked for
 * again: a pending one shortly after, a failed one on the next focus or
 * menu open.
 *
 * Runtime labels come from the same answers and from /agent/status, so no
 * client keeps a table of them.
 */

interface CatalogEntry {
  workspaceId: string;
  runtimeId: string;
  /** Undefined once the backend said it keeps no skills (cloud mode, or a backend without the routes). */
  catalog: SlashSkillCatalog | undefined;
  /** What the shown answer lacks: the runtime's skills, still listing or failed. */
  missing: 'pending' | 'failed' | null;
  /** Bumped by every change; an answer to an older request is shown but not current. */
  generation: number;
  /** The generation the last complete answer belongs to (0: none since), and when it came. */
  answered: number;
  answeredAt: number;
  request: { controller: AbortController; generation: number; done: Promise<void> } | null;
  /** Focused panes showing it, which ask again at once when something changes. */
  users: number;
  /** The next request while the runtime is still listing, and how many of those were made. */
  followUp: ReturnType<typeof setTimeout> | null;
  followUps: number;
}

/** Before the first answer: no catalog skills or commands, while the live session's still show. */
const NOT_LOADED: SlashSkillCatalog = { skills: [], commands: [] };

/** A complete answer older than this is asked for again (the backend's own refresh age). */
const STALE_MS = 30_000;
/** While the runtime is still listing, ask again this long after each answer, at most PENDING_FOLLOW_UPS times. */
const PENDING_RETRY_MS = 1000;
const PENDING_FOLLOW_UPS = 6;

const entries = new Map<string, CatalogEntry>();
const labels = new Map<string, string>();
const listeners = new Set<() => void>();

function keyOf(workspaceId: string, runtimeId: string): string {
  return JSON.stringify([backendConnectionIdForWorkspace(workspaceId), workspaceId, runtimeId]);
}

function entryFor(workspaceId: string, runtimeId: string): CatalogEntry {
  const key = keyOf(workspaceId, runtimeId);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      workspaceId, runtimeId, catalog: NOT_LOADED, missing: null, generation: 1, answered: 0, answeredAt: 0,
      request: null, users: 0, followUp: null, followUps: 0,
    };
    entries.set(key, entry);
  }
  return entry;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(entry: CatalogEntry, catalog: SlashSkillCatalog | undefined): void {
  if (entry.catalog === catalog) return;
  entry.catalog = catalog;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const labelKey = (connectionId: string, runtimeId: string) => JSON.stringify([connectionId, runtimeId]);

/** Labels a backend gave its runtimes (SkillCatalogResponse.runtimes, AgentStatus.availableRuntimes). */
export function rememberRuntimeLabels(connectionId: string, runtimes: readonly { id: string; label: string }[] | undefined): void {
  let changed = false;
  for (const runtime of runtimes ?? []) {
    const key = labelKey(connectionId, runtime.id);
    if (!runtime.label || labels.get(key) === runtime.label) continue;
    labels.set(key, runtime.label);
    changed = true;
  }
  if (changed) notify();
}

/** A runtime's label on the backend of `workspaceId`; until that backend named it, its registered short name, else its id. */
export function runtimeLabel(workspaceId: string | undefined, runtimeId: string): string {
  const connectionId = workspaceId ? backendConnectionIdForWorkspace(workspaceId) : LOCAL_BACKEND_CONNECTION_ID;
  return labels.get(labelKey(connectionId, runtimeId)) ?? runtimeShortLabel(runtimeId) ?? runtimeId;
}

export function useRuntimeLabel(workspaceId: string | undefined, runtimeId: string | undefined): string | undefined {
  return useSyncExternalStore(subscribe, () => (runtimeId ? runtimeLabel(workspaceId, runtimeId) : undefined));
}

/** The catalog a send resolves against now; undefined where this backend runs no skills. */
export function readSkillCatalog(workspaceId: string, runtimeId: string | undefined): SlashSkillCatalog | undefined {
  if (!runtimeId) return NOT_LOADED;
  const entry = entries.get(keyOf(workspaceId, runtimeId));
  return entry ? entry.catalog : NOT_LOADED;
}

function clearFollowUp(entry: CatalogEntry): void {
  if (entry.followUp) clearTimeout(entry.followUp);
  entry.followUp = null;
}

/** What `response` lacks of the runtime's own skills. */
function missingOf(response: SkillCatalogResponse, runtimeId: string): CatalogEntry['missing'] {
  if (response.pending?.includes(runtimeId)) return 'pending';
  return response.errors.some((error) => error.failed && error.runtimeId === runtimeId) ? 'failed' : null;
}

/** Asks for the catalog unless the last answer is complete and recent, or a request for this generation is out. */
export function loadSkillCatalog(workspaceId: string, runtimeId: string): Promise<void> {
  const entry = entryFor(workspaceId, runtimeId);
  if (entry.answered === entry.generation && Date.now() - entry.answeredAt < STALE_MS) return Promise.resolve();
  if (entry.request?.generation === entry.generation) return entry.request.done;
  entry.request?.controller.abort();
  clearFollowUp(entry);
  const controller = new AbortController();
  const generation = entry.generation;
  const recordAnswer = (missing: CatalogEntry['missing']) => {
    entry.missing = missing;
    entry.answered = missing ? 0 : generation;
    entry.answeredAt = Date.now();
    if (missing !== 'pending') entry.followUps = 0;
    else if (entry.followUps < PENDING_FOLLOW_UPS) {
      entry.followUps += 1;
      entry.followUp = setTimeout(() => {
        entry.followUp = null;
        void loadSkillCatalog(workspaceId, runtimeId);
      }, PENDING_RETRY_MS);
    }
  };
  const done = fetchSkillCatalog({ workspaceId, runtimeId, signal: controller.signal }).then(
    (response) => {
      if (entry.request?.controller !== controller) return;
      entry.request = null;
      rememberRuntimeLabels(backendConnectionIdForWorkspace(workspaceId), response.runtimes);
      recordAnswer(missingOf(response, runtimeId));
      publish(entry, { skills: response.skills, commands: response.commands ?? [] });
    },
    (error: unknown) => {
      if (entry.request?.controller !== controller) return;
      entry.request = null;
      if (!isSkillsUnavailable(error)) return;
      recordAnswer(null);
      publish(entry, undefined);
    },
  );
  entry.request = { controller, generation, done };
  return done;
}

/**
 * Waits at most `timeoutMs` for the answer a typed `/name` should resolve
 * against. `need` 'answer': any answer, which lists the library skills and
 * the commands. 'skills': one with the runtime's own skills too, or the one
 * a request already out brings after its listing failed. Null when there is
 * nothing to wait for, so such a send stays synchronous.
 */
export function settleSkillCatalog(workspaceId: string, runtimeId: string, timeoutMs: number, need: 'answer' | 'skills'): Promise<void> | null {
  const entry = entryFor(workspaceId, runtimeId);
  if (entry.catalog === undefined) return null;
  const loaded = entry.catalog !== NOT_LOADED;
  if (loaded && (need === 'answer' || !entry.missing)) return null;
  const pending = entry.request?.done ?? (loaded && entry.missing === 'failed' ? null : loadSkillCatalog(workspaceId, runtimeId));
  if (!pending) return null;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void pending.then(() => { clearTimeout(timer); resolve(); });
  });
}

function markChanged(entry: CatalogEntry): void {
  entry.generation += 1;
  entry.followUps = 0;
  if (entry.users > 0) void loadSkillCatalog(entry.workspaceId, entry.runtimeId);
}

/**
 * The backend refused to run `rejectedId` from this catalog (skill_not_found,
 * skills_unavailable): the menu stops offering it now, and the catalog is
 * asked for again.
 */
export function invalidateSkillCatalog(workspaceId: string, runtimeId: string, rejectedId: string): void {
  const entry = entryFor(workspaceId, runtimeId);
  const catalog = entry.catalog;
  if (catalog?.skills.some((skill) => skill.id === rejectedId)) {
    publish(entry, { ...catalog, skills: catalog.skills.filter((skill) => skill.id !== rejectedId) });
  }
  entry.generation += 1;
  entry.followUps = 0;
  void loadSkillCatalog(workspaceId, runtimeId);
}

function onChanged(): void {
  for (const entry of entries.values()) markChanged(entry);
}

if (typeof window !== 'undefined') {
  window.addEventListener(SKILLS_CHANGED_EVENT, onChanged);
  window.addEventListener('focus', onChanged);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onChanged(); });
}

/**
 * A pane's catalog for its workspace and the runtime its next message runs
 * on, asked for when the pane gets focus. `workspaceId` undefined: the pane
 * has no / menu. `load` is for the / menu opening.
 */
export function useSkillCatalog(workspaceId: string | undefined, runtimeId: string | undefined, focused: boolean): {
  catalog: SlashSkillCatalog | undefined;
  load: () => void;
} {
  const catalog = useSyncExternalStore(subscribe, () => (workspaceId ? readSkillCatalog(workspaceId, runtimeId) : undefined));
  useEffect(() => {
    if (!workspaceId || !runtimeId || !focused) return undefined;
    const entry = entryFor(workspaceId, runtimeId);
    entry.users += 1;
    void loadSkillCatalog(workspaceId, runtimeId);
    return () => { entry.users -= 1; };
  }, [workspaceId, runtimeId, focused]);
  const load = useCallback(() => {
    if (workspaceId && runtimeId) void loadSkillCatalog(workspaceId, runtimeId);
  }, [workspaceId, runtimeId]);
  return { catalog, load };
}

/** @testonly */
export function resetSkillCatalogs(): void {
  for (const entry of entries.values()) {
    const request = entry.request;
    entry.request = null;
    request?.controller.abort();
    clearFollowUp(entry);
  }
  entries.clear();
  labels.clear();
}
