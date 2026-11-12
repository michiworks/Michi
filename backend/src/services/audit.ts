import type { DatabaseSync } from 'node:sqlite';
import { auditDbUnavailable, getAuditDb } from './db';

export type AuditAction =
  | 'auth.sign_in.success'
  | 'auth.sign_in.failure'
  | 'auth.sign_out'
  | 'auth.sign_up'
  | 'admin.users.list'
  | 'admin.workspaces.list'
  | 'admin.user.export'
  | 'admin.user.delete'
  | 'admin.version.update';

export interface AuditRecord {
  action: AuditAction;
  actor?: { id?: string | null; email?: string | null } | null;
  target?: { type?: string; id?: string } | null;
  ip?: string | null;
  ua?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** For /api/health: present only while audit.db is unavailable and records are dropped. */
export function auditLogHealth(): { auditLog?: 'unavailable' } {
  return auditDbUnavailable() ? { auditLog: 'unavailable' } : {};
}

export function recordAudit(r: AuditRecord): void {
  let db: DatabaseSync;
  try {
    db = getAuditDb();
  } catch {
    // getAuditDb logged why, once; until a restart the record is dropped
    // without another attempt to open (and snapshot) the database.
    return;
  }
  try {
    db.prepare(`
      INSERT INTO audit_log
        (ts, actor_user_id, actor_email, action, target_type, target_id, ip, ua, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      r.actor?.id ?? null,
      r.actor?.email ?? null,
      r.action,
      r.target?.type ?? null,
      r.target?.id ?? null,
      r.ip ?? null,
      r.ua ?? null,
      r.metadata ? JSON.stringify(r.metadata) : null,
    );
  } catch (e) {
    // Audit failures should never break the request — log to console only.
    console.error('[audit] failed:', e);
  }
}
