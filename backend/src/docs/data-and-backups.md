# History, deletion, backups and migration

Applies to: local and remote backend data; hosted access is owner-scoped. Source checked: 2026-11-12 against persistence, Trash, Archived, export, backup and migration-snapshot code. Recovery depends on what was actually retained; this is not evidence that your backup has been tested.

## A conversation seems to be missing

Before deleting or resetting anything:

1. Confirm the backend connection and account. A different backend has a different database.
2. Confirm the workspace and active tree. A workspace can contain several trees.
3. Check Today in your agent's panel, the workspace's threads under Conversations, Settings › Archived and Settings › Trash. Earlier conversations with your agent (the ⌘J panel) are under History in its panel menu, not in Archived.
4. Restore connectivity and allow hydration to finish. Backend unavailability is not an empty workspace.

Opening/closing chat panes affects only the view. Clearing browser storage does not restore the authoritative database. Do not replace a database merely because the initial UI looks empty.

## Archive, Trash and permanent deletion

| Action | Meaning | Recovery |
| --- | --- | --- |
| Close a pane | Hides a chat view; closing a terminal pane ends its shell, and closing a browser pane closes its page | Reopen the thread; a closed terminal or browser pane cannot be restored |
| Archive a thread/node | Retain it out of the sidebar; archived views are read-only and never expire | Settings › Archived › Unarchive |
| Move a thread, page or workspace to Trash | Soft deletion | Open Settings › Trash, preview the item and use Restore (a page comes back with its child pages and databases; a thread in a deleted workspace restores the workspace too) |
| Delete permanently / Empty Trash | Remove retained application records | Requires an independent prior backup; UI undo cannot restore them |

Settings › Trash › Cleanup › **Delete automatically** permanently deletes threads that have been in Trash longer than the chosen period (After 7, 14, 30, 60 or 90 days, or Never; default 30 days). A thread's preview shows when it is deleted for good, and threads due within three days show the days left. The check runs while Michi is open. Pages and workspaces in Trash are never removed automatically, and archived threads are excluded. Shortening the period deletes older threads at once, after a confirmation. The period is kept by the backend, so every browser, the phone and the app use the same one; each takes it again when it opens. Restore needed threads before their displayed expiry.

Conversation deletion and project-file deletion are different operations. Removing an application item is not a comprehensive erasure of files, native provider history, external resources, backups or logs. Likewise, restoring a chat does not undo or restore project-file edits.

## Transcript, portable backup and filesystem backup

| Kind | What it preserves | What it does not promise |
| --- | --- | --- |
| Thread Export / Markdown transcript | Readable selected conversation content | Reimportable complete state, project bytes, credentials or native sessions |
| Portable JSON backup | Workspace/tree/node/message/Artifact records; version 2 includes an Agents fragment | Full project directories, attachments as a byte archive, Pages and databases, scheduled jobs, memories, the assistant's system workspace (your conversations with your agent) and the agent's Today, notes, goals and rules, credentials, local settings or live native bindings |
| Stopped-backend filesystem backup | Files/databases you explicitly copy | External targets, remote-host data or provider-side state that you omitted |
| Git backup | Tracked project history and pushed commits | Untracked Artifacts/attachments, Michi databases, credentials or every native session |

Thread Export is a Markdown transcript. Settings › Backup & restore exports and restores the portable JSON backup on the backend serving the window. **Export backup** downloads `michi-backup-<time>.json` with every workspace you can access there. **Choose backup…** then **Restore backup** imports a file of 50 MiB or less; restore always merges: it creates new copies, keeps existing workspaces, and importing the same file again creates duplicates. Reload Michi to open the restored workspaces. Connected remote machines are not included. Per-workspace export and replace mode are available only through the API below.

Native Pages and their change/proposal history, databases, component versions, per-page layout-preference revisions and automatic-maintenance state are retained in the backend's SQLite database. The current conversation Markdown export and portable JSON backup do not include those native records or unpromoted page-helper conversations. Preserve the stopped backend's data directory for a complete backup of that work. Replacing a workspace through the JSON import API removes its existing native Pages and scheduled jobs as part of replacement; restoring the conversation export does not restore those records.

**Ignore** and **Archive** in a Page block menu have page-local meanings: Ignore retains and protects that block from direct automatic replacement; Archive removes it from the page while keeping its change history. They do not archive or delete the source conversation. Page-tree **Move to trash** is a separate action. See `pages-and-components`.

## Make a complete backup of your work

1. Finish or explicitly stop active work. Quit the local backend before copying its databases; for a remote backend use its documented stop procedure. Do not stop unrelated user processes.
2. Copy the effective data and configuration locations using your normal backup tool. Defaults are under `~/.michi`; custom paths and development data can differ. Keep associated SQLite WAL/SHM files with databases if present; copying only a live `data.db` is not a consistent-backup procedure. The configuration location also holds the skill library (`skills/`; copy the targets of skill folders you linked in too) and which of its skills are off (`skills-state.json`); see `skills`.
3. Separately copy workspace files, including needed `.contexts/`, `.attachments/` and imported sources. Preserve external symlink/reference targets or document how to reconnect them.
4. Preserve required private configuration/auth material securely, and record runtime versions and custom paths. Native CLI/Crew state lives outside Michi too; use the runtime's own supported backup/auth procedures.
5. Verify the copy in an isolated location with an appropriate Michi version before relying on it. Check workspace counts, a sample transcript, an Artifact and a project file. Do not point a test instance at the production database.

The default `~/.michi` directory contains application state; the public source checkout and dependencies normally live in `~/Michi`. It can be large and include credentials. A backup of that directory alone still misses workspaces elsewhere and native runtime stores.

## Snapshots before database migrations

Before an update's schema migrations change an existing `data.db` or `audit.db`, the backend saves a checked copy in `backups/` in the data directory (default `~/.michi/backups/`), named `<database>-<UTC time>-pre-<first migration>.db`. It keeps at most the five newest per database, together no larger than three times the database, and deletes older ones; other files there are not touched. A snapshot holds only that database as it was before the migration. It is not a complete backup: workspace files, configuration and credentials are not included.

On macOS and Linux, only the account running the backend can open `backups/`. On Windows, Michi sets no permissions of its own: access follows the permissions the data directory inherits (your user profile's for the default `~/.michi`). A snapshot still holds everything the database held, including conversations, memories and pages deleted or purged later (Trash, permanent deletion, account deletion), until retention removes it; delete old snapshots when that matters. Hosted multi-user backends (`MICHI_CLOUD=1`) take no snapshots unless `MICHI_MIGRATION_SNAPSHOTS=1`.

If a snapshot cannot be made (most often for lack of disk space), that database is not migrated and stays unchanged; for `data.db` the backend does not start. Free space and restart. `MICHI_SKIP_MIGRATION_SNAPSHOT=1` migrates without a snapshot; use it only with another backup in hand. For `audit.db` the backend starts anyway and keeps no audit log until it restarts; the backend log says so and `/api/health` shows `"auditLog": "unavailable"`.

To go back to a snapshot, stop the backend and move the database and its `-wal`/`-shm` files aside. Copy the snapshot to the database's name, then start the Michi version used before the update. Check workspace counts and a sample transcript before relying on it.

## Advanced: portable JSON API

These routes are relative to the selected backend's `/api` base and require that backend's normal authentication/owner permissions. They are not public unauthenticated backup links.

| Request | Purpose |
| --- | --- |
| `GET /api/backup/export` | Export accessible owner workspaces |
| `GET /api/backup/export/:workspaceId` | Export one owned workspace |
| `POST /api/backup/import?mode=merge` | Import a validated JSON payload under new IDs (the default when `mode` is omitted; what Restore backup uses) |
| `POST /api/backup/import?mode=replace` | Purge the stored workspace whose ID matches each backup workspace, including its Pages, scheduled jobs and workspace memories, as deleting it permanently does, then import under new IDs as merge does. IDs are not preserved, a workspace previously imported from that backup is not matched, and this cannot be undone; back up the target first |

Use merge into an isolated target when validating portability. Native session IDs/bindings are cleared, workspace folder bindings are sanitized, and local/external paths may need relinking. Imported Runs that had not finished are marked failed and do not resume. JSON remains private conversation data even though portable fields are sanitized.

If import fails, keep the original export and error. Check its `app`, version, graph integrity and required version-2 Agents fragment. Do not hand-edit IDs or switch to replace as a generic fix.

## Move to another machine or backend

Install a compatible Michi build, restore/import the chosen data, restore project files, then relink actual workspace folders and configure runtime credentials on the new backend. Recreate connections in Settings › Machines and verify a small read before starting writes.

Hosted deployments also depend on persistent `auth.sqlite` and the stable encryption key used for provider credentials. Losing that key can make encrypted keys unreadable. Do not treat copying only `data.db` as complete hosted disaster recovery.

Success check: the intended owner sees the expected history, paths resolve, documents open, and a new small turn works. Compare before/after counts and sample content; the existence of a backup file alone is not restore verification.

Related documents: `configuration`, `privacy-and-data`, `files-and-artifacts`, `sessions-and-recovery`, `remote-backend`.
