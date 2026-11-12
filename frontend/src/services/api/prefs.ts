import { backendFetch } from './backendRequest';
import { API_BASE_URL } from '../../config/env';
import {
  COMPANION_CHAT_NOTIFICATION_LEVEL_PATH,
  isChatPermissionSettings,
  type ChatNotificationLevel,
  type ChatPermissionSettings,
  type CompanionChatNotificationLevelInput,
} from 'michi-shared';

export async function savePermissionSettings(settings: ChatPermissionSettings, apiBase = API_BASE_URL): Promise<ChatPermissionSettings> {
  const res = await backendFetch(`${apiBase}/permissions/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error('Failed to save permission settings');
  const saved: unknown = await res.json();
  if (!isChatPermissionSettings(saved)) throw new Error('Backend does not support permission settings');
  return saved;
}

// ── Prefs API (SQLite-backed, survives port changes) ──

export async function fetchPrefs(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/prefs`);
    if (!res.ok) return null;
    const body = await res.json();
    return body.prefs ?? null;
  } catch {
    return null;
  }
}

/** Whether the backend saved them. Best-effort: localStorage is the fallback. */
export async function savePrefs(prefs: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/prefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── The chat notification level, as the backend keeps it (DESIGN-v2 §5.2) ──

/** What a PUT of the chat notification level came to. */
export type ChatNotificationLevelWrite = 'saved' | 'unsupported' | 'failed';

/** A backend without the route (no Companion, an older build), or one that refused the body: trying again would not help. */
const LEVEL_UNSUPPORTED_STATUSES: ReadonlySet<number> = new Set([400, 404, 405]);

/**
 * PUT COMPANION_CHAT_NOTIFICATION_LEVEL_PATH: the backend notifies by this
 * level for this renderer while no Michi window is open. `unsupported`: a
 * 400, 404 or 405 (LEVEL_UNSUPPORTED_STATUSES). `failed`: anything else that
 * did not save it (unreachable, signed out, rate-limited, a server error),
 * worth another try.
 */
export async function putChatNotificationLevel(level: ChatNotificationLevel): Promise<ChatNotificationLevelWrite> {
  const body: CompanionChatNotificationLevelInput = { level };
  try {
    const response = await fetch(`${API_BASE_URL}${COMPANION_CHAT_NOTIFICATION_LEVEL_PATH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return 'saved';
    return LEVEL_UNSUPPORTED_STATUSES.has(response.status) ? 'unsupported' : 'failed';
  } catch {
    return 'failed';
  }
}
