import { randomUUID } from 'node:crypto';
import { getDb } from '../../src/services/db';

/**
 * A Pages watch as one made before new watches stopped (unification §P2):
 * nothing in Michi creates one now, but the existing ones still run.
 */
export function seedWatch(input: { workspaceId: string; ownerUserId: string; title: string; instructions: string; intervalMinutes: number; enabled?: boolean; now: number }): string {
  const id = `watch-${randomUUID()}`;
  getDb().prepare(`INSERT INTO meta_agent_watches(id,workspace_id,owner_user_id,title,instructions,interval_seconds,enabled,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, input.workspaceId, input.ownerUserId, input.title, input.instructions, input.intervalMinutes * 60,
    input.enabled === false ? 0 : 1, input.now, input.now);
  return id;
}
