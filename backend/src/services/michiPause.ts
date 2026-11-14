/**
 * Pause Michi: the one pause for check-ins, Pages upkeep (the Spaces Home
 * summary included) and automatic polling. Check now, Run now and Retry still
 * work; memory follows only Settings › Memory. One row per owner in
 * meta_agent_maintenance_state: `paused` holds it until the user resumes;
 * `paused_until` ends it by itself at that time. Michi is off until the user
 * turns it on (2026-11-12): an owner without a row is paused until resumed,
 * and Resume (or Get started's Start) is what turns it on.
 */

import { getDb } from './db';

export interface MichiPause {
  paused: boolean;
  /** When a timed pause ends; null while paused until resumed, or not paused. */
  until: number | null;
}

export function michiPause(ownerUserId: string, now: number = Date.now()): MichiPause {
  const row = getDb().prepare('SELECT paused, paused_until FROM meta_agent_maintenance_state WHERE owner_user_id = ?')
    .get(ownerUserId) as { paused: number; paused_until: number | null } | undefined;
  if (!row || row.paused === 1) return { paused: true, until: null };
  if (row?.paused_until != null && now < row.paused_until) return { paused: true, until: row.paused_until };
  return { paused: false, until: null };
}

/** Pauses Michi until `until`, or until the user resumes when it is null. */
export function pauseMichi(ownerUserId: string, until: number | null): void {
  getDb().prepare(`INSERT INTO meta_agent_maintenance_state(owner_user_id, paused, paused_until) VALUES(?, ?, ?)
    ON CONFLICT(owner_user_id) DO UPDATE SET paused = excluded.paused, paused_until = excluded.paused_until`)
    .run(ownerUserId, until === null ? 1 : 0, until);
}

/** Pauses Michi until resumed for every owner with a row (backgroundWorkOff.ts); an owner without one is paused already. */
export function pauseMichiForEveryOwner(): void {
  getDb().prepare('UPDATE meta_agent_maintenance_state SET paused = 1, paused_until = NULL').run();
}

export function resumeMichi(ownerUserId: string): void {
  getDb().prepare(`INSERT INTO meta_agent_maintenance_state(owner_user_id, paused, paused_until) VALUES(?, 0, NULL)
    ON CONFLICT(owner_user_id) DO UPDATE SET paused = 0, paused_until = NULL`).run(ownerUserId);
}
