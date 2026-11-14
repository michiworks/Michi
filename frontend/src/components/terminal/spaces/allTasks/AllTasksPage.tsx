import { useCallback, useMemo, useRef, useState } from 'react';
import type { MichiDbEditOp, MichiDbRow, ThreadCardItem } from 'michi-shared';
import { ALL_TASKS_COLUMN, taskThreadIds, TASK_COLUMN, TASK_VIEW } from 'michi-shared';
import { editPageDatabase, pageEditFailure } from '../../../../services/api/pages';
import { fetchTaskOrigin, saveAllTasksViews } from '../../../../services/api/taskDatabase';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';
import { undoPageBatches } from '../../../../state/pages/pageUndo';
import { recordUndo } from '../../../../state/undoStack';
import { openConversationFromSpaces, openThreadCard } from '../../../../state/sourceNav/sourceNav';
import { DatabaseView } from '../../content/db/DatabaseView';
import { LiveThreadsContext, type LiveThreads } from '../../content/db/liveThreads';
import { pageViewOps } from '../../content/db/nativeDatabaseAdapter';
import { TaskActivityContext, type TaskActivityView } from '../../content/db/taskActivity';
import type { DbEditOptions } from '../../content/db/views/viewTypes';
import { workspaceConversations } from '../taskConversations';
import { useThreadStates } from '../useThreadStates';
import { allTasksBoard, conversationsInTaskWorkspaces, planAllTasksEdit, replaceSource, splitAllTasksRowId } from './allTasksDb';
import { useAllTasks } from './useAllTasks';
import '../home/home.css';
import './allTasks.css';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';

/** All tasks reads this computer's task databases only. */

/** A write All tasks made to one workspace's task database, for Undo. */
interface WrittenBatch { batchId: string; workspaceId: string; databaseId: string }

/**
 * All tasks: the tasks of every workspace on this computer in one database,
 * with the full set of views (kept per person). A task stays in its own
 * workspace's Tasks database: a change made here is written there, and Undo
 * puts it back. Tasks are added, put in order and given columns on a
 * workspace's own board.
 */
export default function AllTasksPage() {
  const { dto, error, refresh, replace } = useAllTasks();
  // The callbacks below read the latest answer without being made again each time it changes.
  const dtoRef = useRef(dto);
  dtoRef.current = dto;
  const db = useMemo(() => (dto ? allTasksBoard(dto) : null), [dto]);
  const [viewId, setViewId] = useState<string | null>(TASK_VIEW.board);
  const [notice, setNotice] = useState<string | null>(null);

  const linked = useMemo(() => (dto ? dto.rows.flatMap(({ row }) => taskThreadIds(row.values[TASK_COLUMN.threads])) : []), [dto]);
  const states = useThreadStates(LOCAL_BACKEND_CONNECTION_ID, linked, !!dto);
  const open = useCallback((item: ThreadCardItem) => openThreadCard(LOCAL_BACKEND_CONNECTION_ID, item, (card) => {
    void openConversationFromSpaces({ backendConnectionId: LOCAL_BACKEND_CONNECTION_ID, workspaceId: card.workspaceId, nodeId: card.nodeId, messageId: card.messageId, focus: false });
  }), []);
  const loadConversations = useCallback((row?: MichiDbRow) => {
    const workspaceId = row?.values[ALL_TASKS_COLUMN.workspace];
    return typeof workspaceId === 'string' && workspaceId ? workspaceConversations(LOCAL_BACKEND_CONNECTION_ID, workspaceId) : Promise.resolve([]);
  }, []);
  const { byNode: stateByNode, loaded: statesLoaded, failed: statesFailed } = states;
  const live = useMemo<LiveThreads | null>(() => (dto ? {
    byNode: conversationsInTaskWorkspaces(dto, stateByNode),
    loaded: statesLoaded,
    failed: statesFailed,
    workspaceId: null,
    open,
    loadConversations,
  } : null), [dto, stateByNode, statesLoaded, statesFailed, open, loadConversations]);
  const loadOrigin = useCallback((rowId: string) => {
    const at = splitAllTasksRowId(rowId);
    const source = at && dtoRef.current?.sources.find((item) => item.databaseId === at.databaseId);
    return at && source
      ? fetchTaskOrigin({ backendConnectionId: LOCAL_BACKEND_CONNECTION_ID, workspaceId: source.workspaceId, databaseId: at.databaseId, rowId: at.rowId })
      : Promise.resolve(null);
  }, []);
  // All tasks says who made a task; the Meta agent's marks and suggestions stay on each workspace's board.
  const activity = useMemo<TaskActivityView>(() => ({ loadOrigin }), [loadOrigin]);

  // The undo-history entry for what an edit wrote: each workspace's batch put back, then All tasks read again.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const undoWritten = useCallback((batches: readonly WrittenBatch[]) => {
    const revert = undoPageBatches(LOCAL_BACKEND_CONNECTION_ID, batches.map((batch) => ({
      batchId: batch.batchId,
      workspaceId: batch.workspaceId,
      changed: [{ backendConnectionId: LOCAL_BACKEND_CONNECTION_ID, workspaceId: batch.workspaceId, databaseId: batch.databaseId }],
    })), 'Change it back yourself.');
    return async () => {
      try {
        return await revert();
      } finally {
        refreshRef.current();
      }
    };
  }, []);

  // View saves go one at a time, each on the revision the one before it answered.
  const viewsRevision = useRef(0);
  if (dto) viewsRevision.current = Math.max(viewsRevision.current, dto.viewsRevision);
  const viewSaves = useRef<Promise<unknown>>(Promise.resolve());
  const saveViews = useCallback((views: Parameters<typeof pageViewOps>[0]) => {
    const run = viewSaves.current.catch(() => undefined).then(async () => {
      const saved = await saveAllTasksViews({ revision: viewsRevision.current, ops: pageViewOps(views) });
      viewsRevision.current = saved.viewsRevision;
      return saved;
    });
    viewSaves.current = run;
    return run;
  }, []);

  const edit = useCallback(async (ops: MichiDbEditOp[], label: string, options?: DbEditOptions): Promise<boolean> => {
    const current = dtoRef.current;
    if (!current || ops.length === 0) return false;
    setNotice(null);
    const plan = planAllTasksEdit(current, ops);
    if (!plan.ok) {
      setNotice(plan.reason);
      return false;
    }
    const written: WrittenBatch[] = [];
    try {
      if (plan.views.length) {
        const saved = await saveViews(plan.views);
        replace((next) => ({ ...next, views: saved.views, viewsRevision: saved.viewsRevision }));
      }
      // One write per workspace's task database, not one atomic write: Undo puts back each one written.
      for (const [databaseId, rowOps] of plan.rows) {
        const source = current.sources.find((item) => item.databaseId === databaseId)!;
        const identity = { backendConnectionId: LOCAL_BACKEND_CONNECTION_ID, workspaceId: source.workspaceId };
        const answer = await editPageDatabase(databaseId, { revision: source.revision, ops: rowOps }, identity);
        replace((next) => replaceSource(next, answer.database));
        const batchId = answer.changes.applied[0]?.batchId;
        if (batchId) written.push({ batchId, ...identity, databaseId });
        notifyPageChanged({ ...identity, databaseId });
      }
    } catch (cause) {
      const conflict = pageEditFailure(cause) === 'stale';
      setNotice(conflict ? 'All tasks just changed, so it was refreshed. Try again.' : cause instanceof Error ? cause.message : "Couldn't save that just now.");
      if (written.length) recordUndo({ label: 'Only part of it was saved', undo: undoWritten(written), toast: true });
      refresh();
      return false;
    }
    // A move or a delete takes a task out of where it was, so its toast offers Undo.
    if (written.length) recordUndo({ label, undo: undoWritten(written), toast: options?.undo === true || ops.some((op) => op.op.endsWith('.delete')) });
    return true;
  }, [refresh, replace, saveViews, undoWritten]);

  const services = useMemo(() => ({
    notice: (message: string) => setNotice(message),
  }), []);

  return (
    <main className="area-settings michi-doc space-doc spaces-home all-tasks" aria-labelledby="all-tasks-title">
      <div className="area-settings__doc spaces-home__doc all-tasks__doc">
        <header className="spaces-home__head">
          <p className="area-settings__kicker">Every workspace</p>
          <div className="spaces-home__title-row">
            <h1 id="all-tasks-title" className="spaces-home__title">All tasks</h1>
            {db && (
              <span className="all-tasks__count michi-doc-mono">
                <span aria-hidden="true">{db.rows.length}</span>
                <span className="sr-only">{db.rows.length === 1 ? '1 task' : `${db.rows.length} tasks`}</span>
              </span>
            )}
          </div>
          <p className="spaces-home__updated">Each task stays in its own workspace's Tasks database; moving a card here changes it there.</p>
        </header>
        {!db || !live ? (
          error
            ? <p className="michi-doc-unknown" role="alert">{error}</p>
            : <p className="michi-doc-unknown" role="status">Reading every workspace's tasks…</p>
        ) : (
          <TaskActivityContext.Provider value={activity}>
            <LiveThreadsContext.Provider value={live}>
              {notice && <p className="michi-doc-unknown" role="alert">{notice}</p>}
              {error && <p className="all-tasks__hint" role="status">Couldn't read the tasks again just now; these are from the last read.</p>}
              {dto?.sources.length === 0 && (
                <p className="all-tasks__hint">No tasks yet. Add a Task board to a page, or ask the assistant to gather a workspace's tasks from its conversations.</p>
              )}
              {states.failed && <p className="all-tasks__hint" role="status">Couldn't read where the linked conversations stand just now.</p>}
              <DatabaseView db={db} edit={edit} viewId={viewId} onViewChange={setViewId} threadOf={() => undefined} now={Date.now()} services={services} />
            </LiveThreadsContext.Provider>
          </TaskActivityContext.Provider>
        )}
      </div>
    </main>
  );
}
