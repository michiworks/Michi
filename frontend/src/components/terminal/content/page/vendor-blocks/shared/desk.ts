// Michi shim for agent-desk shared/desk.ts: only what the mirrored files read from it.
export type ThreadState='waiting'|'stalled'|'doing'|'done'|'idea';
/** Only the static vendor specimens use this shape; live conversations are native. */
export interface DeskThread {
  id: string; projectId: string; title: string; state: ThreadState;
  lastActivityAt: number | null; idleDays: number;
  stoppedAt: string | null; next: string | null; source: null;
}
