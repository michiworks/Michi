import { DEFAULT_CHAT_NOTIFICATION_LEVEL, isChatNotificationLevel, type ChatNotificationLevel } from 'michi-shared';
import { getDb } from '../db';
import { readPrefs, writePrefs } from '../prefsConfig';

/**
 * The user's one notification level (Settings › Notifications), as the
 * renderer last sent it (PUT COMPANION_CHAT_NOTIFICATION_LEVEL_PATH): what
 * the desktop notifier is sent, and what may wake the quit app
 * (attentionLevelAllows). Windows apply their own copy of the pref.
 * Kept in `meta` under the key it has had since the desktop notices began.
 */
const NOTIFICATION_LEVEL_META_KEY = 'companion:chat_notification_level';

/** The level the renderer last sent; DEFAULT_CHAT_NOTIFICATION_LEVEL before any has. */
export function getNotificationLevel(): ChatNotificationLevel {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(NOTIFICATION_LEVEL_META_KEY) as { value: string } | undefined;
  return isChatNotificationLevel(row?.value) ? row.value : DEFAULT_CHAT_NOTIFICATION_LEVEL;
}

/** Stores the renderer's level. True when it changed. */
export function setNotificationLevel(level: ChatNotificationLevel): boolean {
  if (!isChatNotificationLevel(level)) throw new Error('not a notification level');
  const stored = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(NOTIFICATION_LEVEL_META_KEY) as { value: string } | undefined;
  if (stored?.value === level) return false;
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(NOTIFICATION_LEVEL_META_KEY, level);
  return true;
}

/**
 * Changes the user's level from the backend (Michi's
 * companion_set_notifications): the pref the windows read (`notifications`
 * in config.json), so a window that loads keeps it and sends it back
 * unchanged, and the copy above. Open windows read it again on
 * `companion_changed` `notifications`. Returns the level it replaced.
 */
export function changeUserNotificationLevel(level: ChatNotificationLevel): ChatNotificationLevel {
  if (!isChatNotificationLevel(level)) throw new Error('not a notification level');
  const pref = readPrefs()?.notifications;
  const previous = isChatNotificationLevel(pref) ? pref : getNotificationLevel();
  writePrefs({ notifications: level });
  setNotificationLevel(level);
  return previous;
}
