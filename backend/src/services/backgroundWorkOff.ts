/**
 * Michi's agent and its background work are off until the user turns them on
 * (2026-11-12): Pause Michi holds check-ins, watching and Pages upkeep until
 * Resume in Settings › Michi or Get started's Start, and automatic memory
 * stays off until Settings › Memory turns it on. New installs get that from
 * the defaults (michiPause.ts: an owner without a row is paused; memory's
 * extraction state likewise). Older versions stored them on without asking,
 * so once per database what they left on is turned off here: every owner's
 * Michi is paused until resumed, and automatic memory is paused.
 *
 * At boot after migrateCompanionPause (server.ts), so the Companion's own
 * off switch or pause has already become Pause Michi; this keeps it paused,
 * until the user resumes.
 */

import { getDb, runInTransaction } from './db';
import { pauseEveryExtraction } from './memory/extractionRepository';
import { pauseMichiForEveryOwner } from './michiPause';

const DONE_META_KEY = 'background_work:off_by_default_at';

/** True when it turned things off now; false when it already ran on this database. */
export function turnBackgroundWorkOffOnce(now = Date.now()): boolean {
  return runInTransaction(() => {
    const db = getDb();
    if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(DONE_META_KEY)) return false;
    pauseMichiForEveryOwner();
    pauseEveryExtraction(now);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(DONE_META_KEY, String(now));
    return true;
  });
}
