# Task states, queued messages and session recovery

Applies to: ordinary desktop/web chats, including remote workspaces. Agent Runs use the lifecycle in `custom-agents`. Source checked: 2026-11-11; native behavior depends on installed runtimes.

## Is the task working or stuck?

| Observation | Possible meaning | First action |
| --- | --- | --- |
| Thinking/reasoning | Model is working | Check reasoning level and progress |
| Active tool call | Command, network request or tool running | Inspect that call's output/duration |
| Approval card | Permission decision needed | Review and answer it |
| Ask User card | Information needed | Answer the question; Trust does not answer it for you |
| Queued message | Input awaits a boundary or later turn | Check the queue before sending a copy |
| Disconnected view | Lost backend/stream connection | Reopen the same chat; check the connection |
| Complete-looking answer, briefly busy send | Runtime still owns/cleans up the turn | Allow normal cleanup |

A spinner alone does not identify the cause. Inspect recent activity and relevant logs before cancelling or restarting.

## Send while an agent is working

The composer follows current session capabilities.

| Runtime | Busy input |
| --- | --- |
| Kiro CLI | Steering at a supported agent boundary; engine/version matters |
| Pi | Steering at the next assistant-turn boundary |
| Codex | Native `turn/steer` |
| Claude | Native steer in chats: joins the running turn at its next tool round, or runs right after it within the same Michi turn. Agent Runs queue for the next turn |
| Crew | Queues for the next turn; official App callers cannot same-turn steer |
| Antigravity (opt-in: `MICHI_ENABLE_ANTIGRAVITY=1`, or `antigravity` listed in `MICHI_ENABLED_RUNTIMES`) | No steering; a busy send waits for the next turn |

Steering does not instantly roll back an executing command. If execution must stop, use Stop, inspect actual effects, then send the corrected request. Queueing and steering do not undo prior effects.

## Stop, close, refresh and quit

| Action | Effect |
| --- | --- |
| Stop a chat | Requests targeted cancellation; prior file/external changes remain |
| Close a chat pane | Closes the view; does not delete history or request cancellation |
| Refresh/reload | Detaches subscriptions, then rehydrates/reconnects |
| Close a desktop window | Does not itself send cancellation; process lifetime depends on platform/app |
| Quit the local app | An app-owned backend stops with the app, and its local execution ends; saved history remains. On macOS, with **Keep Michi running in the background** (Settings → Scheduled jobs) on, the backend keeps running after you quit, and so do its turns, scheduled jobs and SSH tunnels |
| Quit desktop using a remote workspace | Does not stop the remote backend or its turns. For an SSH machine, the local tunnel stops only when the local backend stops (not in macOS background-service mode) |
| Restart a backend | Interrupts running processes; durable records support recovery, not uninterrupted work |

Cancellation may take time while output drains. Stop is not proof of external rollback. Check actual resources before repeating consequential actions.

## Reconnect without duplicating work

1. Return to the original backend, workspace and chat.
2. Restore connectivity and let history/activity load.
3. Determine whether the original turn is active, completed, cancelled or failed.
4. Continue once its state is known; check effects before repeating an action.

A stream HTTP 410 means the live reply is no longer held: Michi keeps it in memory only briefly after a turn ends, and not across a backend restart. Michi then reads the turn's saved record. A turn that finished shows its saved reply with no error. A turn a restart cut short shows **Turn interrupted** with **Resume**, which asks the agent to carry on from the kept partial output instead of sending the request again; its tool calls may already have taken effect. A turn the agent's credentials expiring stopped (for example a lapsed Auth session: Claude's "authentication failed", a Bedrock 403, AWS credentials that cannot load, a Kiro SSO token exception) shows **Credentials expired** with the same **Resume**; sign in again first. Otherwise the error stays, and **Check original turn** reads the saved record again. A 410 does not prove provider failure or lost history. A `409` with code `turn_active` identifies a busy durable turn; Michi handles its supported retry internally. Other conflicts and ambiguous failures do not justify blind resending.

### Interrupted tasks notice

After a restart, an update or expired credentials, a notice in the top-right corner (under the agent's questions, where toasts appear) lists every task that stopped before finishing, across workspaces and connected backends. It does not close by itself. Each task has **Resume** (opens the chat and carries the turn on, as above; never a resend) and **×** (dismiss); its title opens the chat. **Resume all** carries every listed task on at once, without opening them; **All N** lists more than three; **Dismiss all** clears them. **–** (or Esc inside it) shrinks the notice to a tab with the count, and it stays shrunk after a reload of the window; a new interruption opens it again. On a phone it starts as the tab. While you type in a composer or the pane's find bar that the notices would cover, they step aside off the edge and come back when you leave it. A task leaves the list once its chat moves on (Resume, or any new message) or is dismissed; dismissals are kept on the backend. Tasks older than 7 days, Scheduled Job runs (see the Scheduled page), multi-model runs and maintenance chats are not listed.

If unclear, collect timestamp, runtime, visible status and a small adjacent log excerpt. Preserve the chat rather than deleting it to force a binding.

## Native Resume and Native Fork

Settings → Runtime & model (Model section) shows a **Native Resume** and a **Native Fork** switch for the currently selected runtime when it supports them. Each runtime keeps its own setting, and the two switches are independent. Choosing a different **Runtime** there to reach its switches also makes it the default for new chats; existing chats keep their runtime.

Native Resume restores provider-side state when available. Disabling it changes cold-session reconstruction and does not interrupt live sessions. Text reconstruction uses persisted conversation material; hidden native state and every original tool result may not be restored.

Native Fork creates a child from compatible native history. Parents generally must be idle and match runtime/workspace/owner constraints. A fork cut at an earlier message is exact when the runtime supports that anchor (for example Kiro rewind, or a persisted Claude message position); otherwise Michi falls back to a textual transcript that stops at the selected branch point, not at the parent's latest state. Missing or unsupported history uses textual context; ambiguous runtime failures can surface instead of silently starting over.

Crew forks copy Gateway transcripts into independent sessions and inherit Memory identity/mode; they are not Kiro CLI checkpoint clones. Pi uses context-based branching.

JSON backup imports deliberately clear live native bindings. See `data-and-backups`.

## Edit/resend and file changes

Editing and resending a previous message changes the conversation path. It does not rewind files. Inspect current files/diffs and use Git or another explicit recovery mechanism for rollback.

Success check: the intended chat is open, its backend/folder are correct, the original task's state is understood, and a follow-up succeeds without duplicate changes.

Related documents: `troubleshooting`, `permissions`, `runtime-capabilities`, `data-and-backups`, `remote-backend`.
