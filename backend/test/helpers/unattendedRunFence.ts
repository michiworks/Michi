import { getDb } from '../../src/services/db';

type Row = Record<string, unknown>;

/** Each way a running scheduler run stops being `holder`'s to write for. */
const BREAKS: Array<[string, (runId: string, now: number) => void]> = [
  ['the lease expired', (_runId, now) => { getDb().prepare('UPDATE scheduler_lease SET expires_at=? WHERE id=1').run(now); }],
  ['another process holds the lease', () => { getDb().prepare("UPDATE scheduler_lease SET holder='another-scheduler' WHERE id=1").run(); }],
  ['the run has no execution claim', (runId) => { getDb().prepare('DELETE FROM scheduler_execution_claims WHERE run_id=?').run(runId); }],
  ['the claim is from an older lease generation', () => { getDb().prepare('UPDATE scheduler_lease SET generation=generation+1 WHERE id=1').run(); }],
  ['the run is no longer running', (runId) => { getDb().prepare("UPDATE scheduled_job_runs SET status='failed' WHERE id=?").run(runId); }],
  ['the run waits for approval', (runId) => { getDb().prepare("UPDATE scheduled_job_runs SET attention='approval' WHERE id=?").run(runId); }],
  ['another process claimed the run', (runId) => { getDb().prepare("UPDATE scheduled_job_runs SET claimed_by='another-scheduler' WHERE id=?").run(runId); }],
];

function restore(table: string, key: string, row: Row | undefined, id: unknown): void {
  getDb().prepare(`DELETE FROM ${table} WHERE ${key}=?`).run(id as string);
  if (!row) return;
  const columns = Object.keys(row);
  getDb().prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    .run(...(Object.values(row) as never[]));
}

/** Runs `check` once per break of the run's fence, restoring the lease, run and claim rows after each. */
export function forEachFenceBreak(runId: string, now: number, check: (name: string) => void): void {
  for (const [name, apply] of BREAKS) {
    const db = getDb();
    const lease = db.prepare('SELECT * FROM scheduler_lease WHERE id=1').get() as Row | undefined;
    const run = db.prepare('SELECT status, claimed_by, attention FROM scheduled_job_runs WHERE id=?').get(runId) as Row;
    const claim = db.prepare('SELECT * FROM scheduler_execution_claims WHERE run_id=?').get(runId) as Row | undefined;
    apply(runId, now);
    try { check(name); } finally {
      restore('scheduler_lease', 'id', lease, 1);
      restore('scheduler_execution_claims', 'run_id', claim, runId);
      db.prepare('UPDATE scheduled_job_runs SET status=?, claimed_by=?, attention=? WHERE id=?')
        .run(run.status as string, run.claimed_by as string, run.attention as string | null, runId);
    }
  }
}
