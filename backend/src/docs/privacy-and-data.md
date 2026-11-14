# Where data goes and how access works

Applies to: local desktop/web, self-hosted remote and hosted deployments. Source checked: 2026-11-12 against storage/auth/telemetry/memory/agent documentation and implementation. Native providers, MCP servers and Crew have their own policies; this guide is not a universal retention or compliance guarantee.

## Data locations

| Data | Typical location / recipient |
| --- | --- |
| Workspace/chat/turn records, chat permission modes and tool grants | Selected backend's SQLite `data.db` |
| Michi Memory (memories, the profile of the user, the index it recalls conversations from) | Selected backend's `data.db` |
| Your agent's conversation, Today items, notes, goals, rules and settings | Local backend's `data.db`; the conversation sits in a hidden system workspace |
| Sign-in/sign-out/sign-up and admin audit events | Backend's `audit.db` |
| Pre-migration snapshots of `data.db`/`audit.db` | `backups/` in the data directory (default `~/.michi/backups/`); they keep content deleted or purged later until retention removes them |
| Project files, Artifacts, uploads | Workspace filesystem on that backend; `.contexts/` and `.attachments/` where applicable |
| Local provider credentials | `~/.michi/config.json` |
| Michi skill library | `skills/` and `skills-state.json` in the configuration directory (default `~/.michi`); generated runtime links under the data directory |
| Hosted per-user API keys | Encrypted vault in application storage, dependent on a stable server encryption key |
| Hosted login/session state | Auth service storage, including `auth.sqlite` |
| Native runtime state/auth | Runtime's own locations, such as Codex home or Crew home |
| Logs | Effective backend log directory; additional launcher/native logs may exist |
| Desktop remote tokens | Local bundled backend config; injected server-side into proxied requests |

Defaults can change through deployment/directory configuration. The public source installer uses `~/Michi`; application state defaults to `~/.michi`. Local production and development are not automatically isolated in every credential path.

## What leaves the machine?

The selected runtime/provider receives model input and tool results needed for a request. Reading a file with an agent can send its contents into model context; so does running a skill, or an agent reading one with `michi_skills`. Calling an external MCP or website can send that tool's arguments and associated data to its service. With Pi web search configured, search queries go to the chosen search provider (Jina or Tavily), and `fetch_content` requests public pages from the backend machine.

Unless Settings → Memory is Off, Michi Memory adds to chat turns' model context on every runtime, within a size budget, notes (yours, Michi's own and its profile of you, the current workspace's), what you typed in your recent other conversations and, beside the top related notes, what you wrote in the turn they came from; agents can search memories and past conversations with `memory_search`. A local backend also reads finished conversations in the background on the Background work runtime (Settings → Michi → Model) and saves what is worth remembering, without an approval step; these are model requests no user turn starts (off until you turn on Settings → Memory → **Learn from conversations**). It also imports, read-only, what Claude Code, Codex and Kiro remembered in their own memory files; `MICHI_MEMORY_IMPORT=0` turns that off. Settings → Memory lists every memory, which you can correct or delete. Off stops agents reading or saving memories; saved ones stay until deleted.

On a local backend, your agent (Michi unless renamed; see `concepts-and-context`) also checks sources on its own, read-only: Michi's own records. External code-review, pipeline, email and calendar collectors are not bundled. What they return is stored in `data.db` and goes into the model context of your conversation with the agent when it looks something up, and of check-ins and the morning brief: model requests no user turn starts, on **Background work** (Settings → Michi → Model). What they use is recorded, not limited. None of this runs until you turn your agent on (Get started's **Start**, or its switch in Settings → Michi; the page is named after your agent); turn sources off, or turn it off, there too; `MICHI_DISABLE_COMPANION=1` keeps the watcher from starting. Hosted deployments do not run it.

Local-first history does not mean all inference is offline. An available model, a tool permission and a service's data policy are separate questions. Review the actual provider/tool configuration for sensitive work.

Remote workspaces send prompts, uploads and commands to the selected remote backend, which runs the runtime and stores that workspace's state. Desktop access to a server does not relocate its files to your laptop.

## Local, remote and hosted access

Local desktop/web mode can operate without account authentication. That is appropriate for the intended local topology, not a reason to expose its HTTP port publicly. Self-hosted remote mode requires its token and is distinct from hosted login mode.

Use the built-in SSH tunnel/private networking or an appropriately protected HTTPS deployment. CORS is not universally open and is not a substitute for authentication. See `remote-backend` for exact deployment conditions.

The built-in tunnel uses SSH configuration, known hosts and ssh-agent; Michi does not store an SSH password/private key. Remote connection tokens are stored by the local backend and not returned to the renderer. Keep configuration files and backups private.

## Crew permissions and Memory

Michi MCP and sessionApproval are required Crew integration capabilities. sessionApproval lets the App receive and answer native pending tool requests. The official grant can cover user-owned Crew sessions; Michi restricts its adapter to its own local unlinked App sessions.

Crew Memory is provider-side long-term material governed by the selected mode and upstream identity/template/policy, separate from Michi Memory. Crew's Memory Off does not delete Michi chat history or establish deletion of previously saved memories. See `crew` for the supported modes and verification limits.


## Logs, exports and deleting data

Prompts, tool output, paths and credentials can appear in diagnostics. Share the smallest relevant redacted excerpt. Never paste whole config/environment files, access tokens or private database contents into a public report.

A Markdown transcript and portable JSON export still contain private conversation material. Portable-field sanitization is not universal removal of secrets someone typed into a message. Review exports before sharing.

Deleting a chat is not a universal data-erasure operation: project files, external links, native provider history, Michi memories saved from it, logs, automatic pre-migration snapshots and your own backups may remain. Use each system's supported deletion procedures when that is your goal. See `data-and-backups` for recovery and deletion scope.

Success check for a privacy/configuration question: identify the exact backend, provider/tool recipient and storage location rather than extrapolating from another deployment.

Related documents: `permissions`, `configuration`, `data-and-backups`, `performance-and-usage`, `remote-backend`, `crew`.
