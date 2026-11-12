# Scheduled-only runs

A scheduled job can show its runs in the workspace, or only under **Scheduled**.
Workspace visibility is the default. A scheduled-only thread still belongs to its
workspace, but stays out of the ordinary conversation list and search results.

## Behavior

- Open a run from the job's details in **Scheduled**. The read-only conversation
  shows live output and still accepts answers to approvals and agent questions.
- **Move to workspace** makes the thread an ordinary conversation you can continue.
  For a job using one ongoing thread, the next run starts a new hidden thread.
- Moving a thread keeps its permission setting. Review it in the composer before
  continuing; scheduled jobs default to Trust.
- Agent tools `list_threads` and `search_messages` omit these runs unless called
  with `includeScheduledRuns: true`. Reading a known node ID still works.
- Hidden-thread retention keeps the latest five runs, plus runs among the latest
  twenty that are no more than seven days old. Older run records remain in the
  history after their threads are removed.
- A shared ongoing thread stays while one of its runs is retained. After twenty
  runs, the next run starts a new thread and receives summaries of the last five
  results. The runtime still manages its own context compaction.
- Deleting a job removes its hidden threads, but preserves threads already moved
  to the workspace. Paused jobs remain subject to retention.

The backend owns the hidden-thread marker. Graph snapshots cannot set or clear
it, and branches inherit it from their parent.

## Source and tests

- [Retention and thread lifecycle](../../backend/src/services/scheduledJobs/scheduledOnly.ts)
- [Scheduled run viewer](../../frontend/src/components/terminal/scheduled/ScheduledRunPage.tsx)
- [Lifecycle tests](../../backend/test/scheduledOnlyRuns.test.ts)
- [Ongoing-thread executor tests](../../backend/test/scheduledJobsChatExecutor.test.ts)
- [Run-opening tests](../../frontend/src/components/terminal/scheduled/useScheduledRunOpening.test.tsx)
- [Structure synchronization tests](../../frontend/src/state/structureMerge.test.ts)
