import { isChatPermissionSettings, type ChatPermissionSettings } from 'michi-shared';
import { backendFetch } from './api/backendRequest';
import { savePermissionSettings } from './api/prefs';
import { connectionIdFromApiUrl } from '../config/backendIdentity';
import { remoteFirstPainted, whenRemoteFirstPaint } from '../state/remoteFirstPaint';

/** A settled read is reused this long by mounts that did not ask for a fresh one. */
const PERMISSION_REUSE_MS = 5000;

interface Snapshot { settings?: ChatPermissionSettings; loading: boolean; error: string | null }
interface Entry { snapshot: Snapshot; revision: number; listeners: Set<() => void>; pending?: Promise<void>; loadedAt?: number }
const entries = new Map<string, Entry>();
function entry(key: string): Entry {
  let current = entries.get(key);
  if (!current) { current = { snapshot: { loading: true, error: null }, revision: 0, listeners: new Set() }; entries.set(key, current); }
  return current;
}
function publish(current: Entry, snapshot: Snapshot) {
  current.snapshot = snapshot;
  current.listeners.forEach((listener) => listener());
}
export const permissionSnapshot = (key: string) => entry(key).snapshot;
export function subscribePermissionPreferences(key: string, listener: () => void) {
  const current = entry(key);
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    // A read that just settled outlives a remount, so a quick unmount/mount does not read again.
    const recent = current.loadedAt !== undefined && Date.now() - current.loadedAt < PERMISSION_REUSE_MS;
    if (!current.listeners.size && !recent && !current.pending) entries.delete(key);
  };
}
/**
 * `fresh` is for an explicit retry or a window refocus. A mount reuses a read
 * that settled moments ago; a remote's first read waits for its first paint.
 */
export function loadPermissionPreferences(key: string, base: string, opts?: { fresh?: boolean }): Promise<void> {
  const current = entry(key);
  if (current.pending) return current.pending;
  if (!opts?.fresh && current.loadedAt !== undefined && Date.now() - current.loadedAt < PERMISSION_REUSE_MS
    && current.snapshot.settings && !current.snapshot.error) return Promise.resolve();
  const revision = current.revision;
  publish(current, { ...current.snapshot, loading: true, error: null });
  const pending = (async () => {
    try {
      const connectionId = connectionIdFromApiUrl(base);
      if (!opts?.fresh && !remoteFirstPainted(connectionId)) await whenRemoteFirstPaint(connectionId);
      const response = await backendFetch(`${base}/permissions/settings`);
      const settings: unknown = await response.json();
      if (!response.ok || !isChatPermissionSettings(settings)) throw new Error('Permission settings are unavailable on this Backend');
      if (revision === current.revision) { current.loadedAt = Date.now(); publish(current, { settings, loading: false, error: null }); }
    } catch (error) {
      if (revision === current.revision) publish(current, { ...current.snapshot, loading: false, error: error instanceof Error ? error.message : 'Permission settings unavailable' });
    }
  })().finally(() => { if (current.pending === pending) current.pending = undefined; });
  current.pending = pending;
  return pending;
}
export async function saveScopedPermissionPreferences(key: string, base: string, settings: ChatPermissionSettings) {
  const current = entry(key);
  const revision = ++current.revision;
  current.loadedAt = undefined;
  try {
    const saved = await savePermissionSettings(settings, base);
    if (revision === current.revision) publish(current, { settings: saved, loading: false, error: null });
  } catch (error) {
    if (revision === current.revision) publish(current, { ...current.snapshot, loading: false, error: error instanceof Error ? error.message : 'Failed to save permission settings' });
    throw error;
  } finally { if (revision === current.revision) current.revision += 1; }
}
