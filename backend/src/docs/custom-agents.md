# Custom Agents, Runs and watches (experimental)

Applies to: backends started with `MICHI_CUSTOM_AGENTS=1`. Disabled by default. Source checked: 2026-11-08 against the feature gate, definition editor, Run UI and recovery code. This is a source-reviewed experimental guide, not a new live-provider certification.

## Why is there no Agents page?

The backend reads `MICHI_CUSTOM_AGENTS=1` at startup. Without exactly that value, the Agents entry, definitions, Runs and related tools are unavailable. Existing definitions/history remain in the database. There is no Settings switch or API to enable the feature, and old `customAgents.enabled` config values are ignored.

Set `MICHI_CUSTOM_AGENTS=1` only in the environment of the backend you intend to use (its shell, `backend/.env`, or `~/.michi/.env` for the packaged app; see `configuration` for precedence), then restart that backend. Local and remote backends are separate. A renderer reload alone does not change the startup gate. Restarting can interrupt active work, so finish or stop it first.

## Branch, subagent, definition or Run?

| Object | Purpose | State/authority |
| --- | --- | --- |
| Conversation branch | Another conversational direction | Michi tree context; no automatic file isolation |
| Runtime-native subagent | Child work managed by the selected engine | Visibility/control depends on runtime integration |
| Custom Agent definition | Reusable instructions, profile, context/capability and permission limits | Workspace/global scope on its backend |
| Agent Run | One durable execution using a definition snapshot or ephemeral configuration | Own attempts, interactions, results and effective policy |
| Run watch | Follow selected Runs for a completion condition | Application completion subscription; not a Crew cron job |

Definitions describe method and allowed capabilities. A Run supplies a concrete task. Editing a definition does not rewrite a running Run's saved snapshot.

## Create a reusable worker

1. Open Agent Library and choose + workspace agent or + global agent.
2. Set a name and description explaining when the worker should be used.
3. Choose an available runtime/provider/model profile on that backend. Agent Runs support only Pi, Claude, Kiro and Codex; other runtimes, such as Crew and Antigravity, cannot be enabled as a primary or fallback profile.
4. Put stable methods in System instructions, such as “Use primary sources and cite uncertainty.” Leave the one-off task for each Run.
5. Select tools from the capability catalog under Tools, Skills & MCP. This is the worker's whole selected surface; parent capabilities are not automatically inherited. Include `michi_docs` when the worker needs product help. The catalog lists only Michi tools: skill refs and MCP server refs are never resolved and block Enable. A Pi or Codex run sees the whole skill library through its runtime; a Kiro run does not, and a Claude run starts in Claude's bare mode, which is not meant to load it natively. Select the `michi_skills` tool to let a Claude or Kiro run list and read library skills.
6. Choose allowed context: workspace instructions, messages, files and Artifacts, plus the estimated character limit.
7. Set permission preset and execution limits. Choose Enable before using it: Enable saves the definition and then enables it, while Save Draft only saves it.

Success check: the definition is enabled, its profile is available, and selected capabilities are ready rather than unresolved references. Provider secrets stay in backend bindings, not in the description or instructions.

## Permissions and environments

Research allows read, search, browse and Artifact write and denies the rest. Build allows every category except external action and spawn agent, which ask; by default a write-capable Run gets its own Git worktree and fails without a Git repository. Custom lets you choose allow, ask or deny for each category (read, search, browse, artifact write, filesystem write, shell exec, external action, spawn agent); unset categories are denied.

A definition is a ceiling: parent restrictions can reduce it. Ordinary chat Trust does not bypass a Run's independent effective policy or capability allowlist. Execution environment and tool policy are distinct; inspect the Run's environment before relying on file isolation.

Limits include delegation depth, concurrent Runs, wall time and attempts. Increasing a number does not provide an unavailable model, tool, credential or native capability.

## Run, inspect and respond

Ask the parent agent to use an enabled worker for a specific bounded task, with explicit context and expected result. It can use the exposed Run tools when the feature and permissions allow. Open the resulting Run pane to inspect task, profile, environment, attempts, status and interactions.

| State | What to inspect |
| --- | --- |
| Queued / preparing | Capacity, environment preparation and selected capabilities |
| Running | Timeline, current attempt and tool output |
| Waiting | Approval, user-input or recovery reason |
| Recovering | Classified error and attempt/fallback information |
| Completed | Result bundle, changed files and unresolved issues |
| Failed / cancelled | Last error and actual effects before repeating |

Queue input sends additional guidance without cancelling active work. Stop & redirect requests interruption and redirects according to the Run's action path. Cancel Run requests cancellation. Enter alone never means cancel. Answer pending interactions in the Run rather than assuming a parent message resolves them.

## Retry, fallback and completion

Configured fallback profiles are considered after classified failures and within attempt limits. Recovery may wait when a side effect cannot be safely replayed. Do not force repeated external actions just because an attempt failed.

Watches notify or wake a parent when their condition is met: all, any or a quorum of the watched Runs finished (a failed or cancelled Run settles all/quorum early), or a deadline timestamp has passed. A deadline is checked only when an Agent Run changes, a wait runs, or the backend starts; there is no timer. Wake needs a parent target; a parent chat that has meanwhile been archived or put in the trash, or whose workspace has, is not woken. A watch is a one-shot subscription over Runs, not recurring or time-based scheduling, and it does not subscribe to native Crew background jobs.

Durable records survive a UI disconnect. Backend restart may trigger recovery, which is not a promise of uninterrupted execution or exactly-once external actions. Inspect attempts and resources after recovery.

## Use the result

Terminal Runs expose Continue as Branch with task/result/transcript selection. If the original parent is unavailable, the UI can offer Continue as new thread. This imports conversation material; it does not merge code changes.

An ephemeral Run can offer Save as Custom Agent, which creates a draft to review. Inspect results marked “Inferred from final output” with that provenance in mind. A Change Set explicitly does not mean changes were automatically merged.

Retention is indefinite unless a bounded default is selected. Back up needed Run records and actual worktree files separately. See `data-and-backups`.

Related documents: `permissions`, `common-workflows`, `runtime-capabilities`, `sessions-and-recovery`, `data-and-backups`.
