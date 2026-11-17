<div align="center">

<img src="assets/icons/icon.png" alt="Michi logo" width="128" height="128" />

# Michi

**Fork, detour, side quest, btw, branch — Michi keeps up with your non-linear mind.**

A branch-native AI workspace for divergent thinking. Explore many paths from one
conversation, run them side by side, and fold the good ones back together.

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple&logoColor=white)](https://github.com/michiworks/Michi/releases/latest)
[![Electron](https://img.shields.io/badge/desktop-Electron-47848F?logo=electron&logoColor=white)](#desktop-app)
[![Stack](https://img.shields.io/badge/stack-React%20%C2%B7%20TypeScript%20%C2%B7%20SQLite-3178C6?logo=typescript&logoColor=white)](#common-commands)
[![License](https://img.shields.io/badge/license-ISC-blue)](#license)

[Features](#features) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [Shortcuts](#shortcuts) · [Configuration](#configuration)

https://github.com/user-attachments/assets/9f4cd982-0371-4921-9776-79ab58295346

</div>

See the [user guide](docs/user-guide.md) for walkthroughs, runtime setup,
permissions, recovery and troubleshooting. Agents can read the bundled help
through `michi_docs`.

## Highlights

- **Branch without losing your place.** Explore alternatives in parallel panes,
  reference other conversations, and bring findings together with Weave or Digest.
- **Choose your runtime.** Use Kiro, Kiro Crew, Claude Code, Codex, Pi,
  Antigravity, Cursor or Grok, with the models and permissions each supports.
- **Keep useful work.** Chats, branch journals, Artifacts, Pages, tasks and
  Memory persist beyond a single model session.
- **Coordinate background work.** Follow subagents, workflows and multi-model
  comparisons from the same conversation; schedule recurring or one-off work.
- **Work across machines.** Local and remote workspaces share one interface.
  Remote turns continue when you close the desktop app.
- **Use the interface that fits.** A keyboard-driven desktop with resizable
  panes, a phone web interface, and a native iOS client in this repository.
- **Own the backend.** Run locally without an account, or configure an
  authenticated deployment with per-user data and provider credentials.

## Why Michi

Linear chat is a bad fit for a curious mind. If a single answer sparks three
questions, you either open three new chats or cram everything into one runaway
thread. Inspired by the Wikipedia rabbit hole, Michi makes **branching a
first-class primitive**: every detour becomes its own persisted conversation,
so exploring an alternative does not cost you the thread you were on.

## Features

| Feature | What it does |
|---|---|
| **Branch** | Select response text or branch from the current chat to explore a follow-up in another pane. |
| **Weave / synthesize** | Start a conversation with selected chats as combined context. |
| **Digest** | Produce a source-connected synthesis of a conversation tree. Enable it in **Settings → Appearance → Features → Digest**. |
| **Map and branch journals** | Navigate the active conversation tree and read each branch's progress journal. |
| **Multi-pane workspace** | Keep chats, files, diffs, Pages, terminals and, in the desktop app, browser views side by side. |
| **Artifacts** | Save reusable documents, files, images and links; search, pin or mention them with `@`. |
| **Pages and tasks** | Organize workspace knowledge with a block editor, child pages, databases, task boards and Sources. |
| **Memory and Skills** | Carry reviewed notes across runtimes and manage reusable agent instructions. |
| **Background work** | Inspect subagents, workflow runs and multi-model participants, including progress and requests for input. |
| **Coding receipts** | Inspect files changed by a turn and open their diffs. |
| **Search and recovery** | Search messages, reopen history, archive or restore threads, and reconnect to durable turns. |

Attach files or images, quote earlier text, edit and resend user messages, and
export conversations as Markdown. The desktop's **Settings → Links** controls
whether links open in its Browser pane or in your system browser.

### Pages and tasks

Pages are native, revisioned documents stored in Michi's database. They support
blocks, database views, responsive layouts and per-item Sources. Workspace homes
can be maintained from conversations by your agent, with revision checks and
protection for human edits. **All tasks** brings together tasks from local
workspaces.

Pages on connected remote backends can be listed and opened. Workspace-home
maintenance, global Databases and All tasks currently operate on the local
backend. See the [Pages guide](backend/src/docs/pages-and-components.md),
[maintenance guide](backend/src/docs/pages-maintenance.md) and
[component design guide](backend/src/docs/page-component-design.md).

### Memory and Skills

**Settings → Memory** lets you review, edit and delete the notes Michi remembers
across runtimes. Notes supply context; they do not override your instructions.
A temporary chat neither reads nor contributes Memory, and other conversations
cannot discover or read it. Temporary does not mean its stored history is
automatically deleted.

**Settings → Skills** manages the Michi skill library and shows skills supplied
by runtimes. Skills can package instructions and supporting files; the built-in
`/compare` skill starts the multi-model comparison flow. See
[context and Memory](backend/src/docs/concepts-and-context.md) and
[Skills](backend/src/docs/skills.md).

### Your agent and background work

Your personal agent is named **Michi** by default and can be renamed. Its panel
combines a conversation for organizing your work with **Today**, which lists
items needing attention. You opt into background activity through **Get started**
or **Settings → Michi**. It can maintain workspace homes and, when enabled,
watch local conversations and failed scheduled jobs for useful check-ins.
External email, calendar and code-review collectors are not bundled.

The conversation's **Background work** badge opens details for subagents,
workflows and multi-model work. For a comparison, ask for other models' views or
use `/compare`: review the participants and prompts, then press **Start**. Plans
support 1–5 participants and 0–2 review rounds, with results returned to the
original conversation for synthesis. See
[multi-model threads](docs/features/multi-model-threads.md).

Custom Agents and durable Agent Runs are a separate experimental feature,
enabled with `MICHI_CUSTOM_AGENTS=1`; see
[Custom Agents](backend/src/docs/custom-agents.md).

## Chat permissions

**Settings → Runtime & model → Permissions** chooses global permissions or
per-chat controls. When **Use global permissions** is on, its choice applies to
ordinary chats on that backend; turning it off restores their individual choices.
New chats default to **Ask**.

| Mode | Behavior |
|---|---|
| **Ask** | Requests approval for changes and tools that require it. Native read-only tools can run automatically. |
| **Trust** | Automatically approves tools, retaining the runtime's native sandbox where one exists. |
| **YOLO** | Requests full native access as well as automatic approval; available for Claude and Codex. |
| **Approve for me** | Kiro V3's Ask mode with its trust classifier: routine work can proceed, uncertain actions ask. |

Modes and tool-level grants depend on the runtime. Trust does not create an OS
sandbox for a runtime that has none. Changes apply from the next turn, and
returning to Ask clears Michi's always-allow chat grants. Local and remote
backends own their settings independently; hosted settings are owner-scoped.

Scheduled-job management has additional approval rules, and Custom Agent Runs
have their own policy. See [permissions](backend/src/docs/permissions.md) and
[scheduled jobs](#scheduled-jobs-and-the-background-service).

## Quick Start

### macOS

On Apple Silicon, download the signed DMG from the
[latest release](https://github.com/michiworks/Michi/releases/latest), open it,
and drag Michi into Applications.

To build and install from source instead:

```bash
curl -fsSL https://raw.githubusercontent.com/michiworks/Michi/main/install.sh | bash
```

The macOS installer clones into `~/Michi`, installs a compatible Node.js locally
if needed, builds the app, and installs it to `~/Applications/michi.app`.

### Windows

On Windows x64, open PowerShell:

```powershell
irm https://raw.githubusercontent.com/michiworks/Michi/main/install.ps1 | iex
```

The installer uses `%USERPROFILE%\Michi`, installs a compatible Node.js if
needed, builds the NSIS installer and creates a Start Menu shortcut. Visual
Studio Build Tools are recommended for native builds; prebuilt binaries are
used where available.

### Run from source

For web development on macOS, Linux or Windows, install **Node.js 22.19 or
newer** and Git, then run:

```bash
git clone https://github.com/michiworks/Michi.git
cd Michi
npm install
npm run dev
```

Open `http://localhost:3001`. The development backend defaults to port `3000`
and stores application data and configuration in `~/.michi-dev`.

Michi does not include a model subscription. Choose and configure a runtime in
**Settings → Runtime & model**. CLI runtimes need their executable and sign-in
on the machine running the backend; Pi needs provider credentials instead.
See [Runtimes & Providers](#runtimes--providers).

## How It Works

1. Create a workspace and start a conversation.
2. Select response text and ask a follow-up in a new branch.
3. Keep related chats or files open in adjacent panes while work continues.
4. Use Map to navigate the thread, and reference a chat or Artifact when another
   conversation needs its findings.
5. Use Weave or Digest to bring selected work together, then keep the result as
   an Artifact, Page or Markdown export.

A workspace can contain several conversation trees. A branch inherits context
through its branch point, not future parent messages. Native fork is used when
supported and enabled; otherwise Michi reconstructs context from history.
Native Resume and Native Fork are independent settings.

**Conversation branches do not create Git worktrees.** Agents using the same
folder can edit the same files. Use separate Git worktrees and workspace folders
when you need filesystem isolation. See
[context and branching](backend/src/docs/concepts-and-context.md) and
[sessions and recovery](backend/src/docs/sessions-and-recovery.md).

## Runtimes & Providers

First-run setup lets you choose an available runtime. Existing conversations
keep their runtime when you change the default. Models, reasoning levels,
planning modes and other capabilities depend on the selected runtime.

| Runtime | Connection and setup |
|---|---|
| **Kiro** | Installed `kiro-cli` over ACP. V3 is the default engine; V2 remains a compatibility option. |
| **Kiro Crew** | Official Crew Gateway with the Michi Crew App and required MCP/approval setup. Follow the [Crew setup guide](runtime/src/adapters/crew/GETTING_STARTED.md). |
| **Claude Code** | Claude Agent SDK with an installed, authenticated Claude CLI. |
| **Codex** | Installed Codex CLI through its app-server protocol. |
| **Pi** | Provider APIs in-process; no separate agent CLI required. |
| **Antigravity** | Installed Antigravity runtime. |
| **Cursor** | Cursor CLI over ACP; uses Cursor's `agent` executable, normally `~/.local/bin/agent`. |
| **Grok** | Official xAI `grok` CLI over ACP. |

Pi supports providers including OpenAI, Anthropic, Google AI, DeepSeek, xAI,
OpenRouter and Amazon Bedrock. Configure credentials in **Settings → Runtime &
model** or the backend environment. Bedrock supports an AWS profile, bearer
token, access keys or the SDK's default credential chain. On personal backends,
existing provider environment variables take precedence over saved credentials.

Pi web search can use Jina Search or Tavily, configured under **Settings →
Runtime & model → Web search** where supported. Provider models are discovered
and cached; availability still depends on your account and runtime version.

All eight runtimes are registered by default in this public build. Set
`MICHI_ENABLED_RUNTIMES` to limit the list. See the
[runtime guide](backend/src/docs/runtimes.md),
[capability comparison](backend/src/docs/runtime-capabilities.md) and
[configuration guide](backend/src/docs/configuration.md) for setup and limits.

## Shortcuts

Use **Cmd** on macOS and **Ctrl** on Windows/Linux unless shown otherwise.
Navigation letters apply outside text inputs. The full list is in
**Settings → Keyboard shortcuts**.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+K` | Open the command palette and search |
| `Cmd/Ctrl+T` | Open Home to start a new thread |
| `Cmd/Ctrl+Alt+T` | Branch from the focused chat (`Alt` is Option on macOS) |
| `Cmd/Ctrl+Enter` | Send the composer's message as a branch |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle panes forward / backward |
| `Cmd/Ctrl+Shift+Enter` | Zoom the focused pane |
| `Cmd/Ctrl+F` | Find in the focused pane |
| `Cmd/Ctrl+Shift+A` | Open Artifacts |
| `Cmd/Ctrl+J` | Open your agent's conversation when enabled |
| `Cmd/Ctrl+Shift+J` | Open your agent's Today view when enabled |
| `Cmd/Ctrl+,` | Open Settings |
| `Cmd/Ctrl+W` | Close the focused pane |
| `Cmd/Ctrl+[` / `Cmd/Ctrl+]` | Navigate back / forward |
| `M` / `D` | Open Map / Digest |
| `0` / `1` / `O` | Open Home / dashboard / workspaces |

## Desktop App

```bash
npm run electron:dev      # local backend, frontend and Electron window
npm run electron:build    # package the desktop app
npm run electron:install  # repeat the install step
```

On macOS, a local build produces an unsigned Apple Silicon DMG in
`dist-electron/`. **The build's post-hook quits Michi and replaces
`~/Applications/michi.app`.** Use it when you intend to install a new build,
not as a routine validation command. Windows builds target x64.

Desktop windows share one backend while keeping their own panes and drafts.
Closing a chat pane does not cancel its durable turn. Notifications can return
you to work that finished or needs input.

### Remote backend

#### Connect by host (experimental)

Open **Settings → Machines → Connect remote SSH**, or choose **New workspace →
machine → Connect remote SSH…**. Enter an SSH alias, hostname or `user@hostname`.

The remote machine needs Linux, Bash, Python 3, Git, curl and tar, with working
noninteractive SSH. Michi uses your SSH config and agent without storing SSH
passwords or private keys, and keeps host-key checks enabled.

Setup installs the public backend, shared, runtime and frontend workspaces,
builds them, starts a loopback backend, and saves its connection. Existing
installations and tokens are reused where supported. Remote workspaces run
their agents and file operations on that machine.

#### Manual launch

On a remote Linux machine:

```bash
git clone https://github.com/michiworks/Michi.git
cd Michi
npm run remote:launch
```

The launcher sets up dependencies, builds and starts the backend. Useful controls:

```bash
npm run remote:status
npm run remote:restart
npm run remote:stop
npm run remote:launch -- --service  # install a systemd user service
```

The generated connection token is stored in `~/.michi/remote.env`. Connect
through SSH or a deliberately configured private/HTTPS endpoint; do not publish
an unauthenticated backend to the internet.

Local and remote chats can stream side by side. Remote history opens with the
newest 15 messages and loads older messages on demand. An owner- and
connection-scoped IndexedDB cache can show recent remote content while
reconnecting; it is not the source of truth. Read the
[remote backend guide](docs/remote-backend.md) for installation, updates,
service management and connection recovery.

### Phone and iOS

In **Settings → Machines → Phone access**, enable access to the local or a saved
remote machine. Install Tailscale on that machine and your phone, use the same
owner account, and scan the displayed QR code. Michi uses private Tailscale
Serve over HTTPS; the backend machine must remain awake and running.

For a macOS host, the current QR code opens the **phone web interface**. It is a
paired link, revoked when Michi restarts or phone access is re-enabled, and is
not accepted by the native iOS scanner. Linux and Windows use the root-link
connection flow. Windows hosting still needs real-device acceptance; see the
[phone access guide](docs/mobile-access.md) for platform limits.

The repository also includes a **native SwiftUI/UIKit client for iOS 17+**.
Open `ios/Michi.xcodeproj` in Xcode to build it; device builds require your own
signing team. It connects to an existing HTTPS backend and stores credentials in
Keychain. It does not start or wake the backend. See [iOS setup](ios/README.md).

Phone terminals are optional and off by default. Enable **Phone access →
Terminal** on the backend machine if needed; this requires its optional
`node-pty` dependency. Authenticated/cloud backends do not provide terminals.

## Common Commands

Run these from the repository root:

| Command | Purpose |
|---|---|
| `npm install` | Install the root and workspace dependencies |
| `npm run dev` | Start the backend watcher and Vite frontend |
| `npm run backend:dev` / `npm run frontend:dev` | Start one development side |
| `npm run build` | Build the frontend and typecheck/bundle the backend |
| `npm start` | Start the built backend, serving the built frontend when present |
| `npm run typecheck -w frontend` | Check frontend TypeScript, including tests |
| `npm run lint -w frontend` | Run frontend ESLint |
| `npm test -w frontend` | Run the isolated frontend Vitest suite |
| `npm test -w backend` | Typecheck and run backend tests |
| `npm run test:runtime` | Run runtime tests and the runtime boundary check |
| `npm test -w michi-shared` | Run shared protocol/projection tests |
| `npm run test:e2e` | Run Playwright with mock APIs, without real agents or user data |
| `npm run check` | Run repository contracts, shared tests and dependency checks |
| `npm run preflight` | Check workspace dependency resolution and install state |
| `npm run icons:generate` | Regenerate application and tray icons from their source assets |

The root npm workspaces are `frontend/`, `backend/`, `shared/` and `runtime/`.
Electron's main/preload code lives separately in `electron/`. Vite builds do not
replace the frontend TypeScript check. Build output goes to `frontend/build`,
`backend/dist` and `shared/dist`.

### Frontend Test Workflow

Choose checks for the behavior you changed. During frontend work, run an explicit
test file or related tests, then typecheck after the final TypeScript edits:

```bash
npm test -w frontend -- src/state/chatStreamRunner.test.ts
npm run test:related -w frontend -- src/components/ui/DrawerShell.tsx
npm run typecheck -w frontend
```

For backend changes, build shared code before a focused test; `test:file` does
not typecheck:

```bash
npm run shared:build
npm run test:file -w backend -- test/kiroCancelResume.integration.test.ts
npm run typecheck:tests -w backend
```

Use the affected full suites for broad refactors, shared infrastructure or
release preparation. Paths after `-w frontend --` are relative to `frontend/`.
For documentation-only edits, check references and commands without launching
the app:

```bash
node --test scripts/doc-freshness.test.mjs
```

See [AGENTS.md](AGENTS.md) for test isolation, worktree setup and release checks.

## Configuration

Most personal setup is available in Settings:

| Page | Controls |
|---|---|
| **Runtime & model** | Default runtime, model, reasoning, permissions, provider credentials and supported runtime options |
| **Michi** (or your agent's name) | Enablement, instructions, background-work model, sources and Pages upkeep |
| **Memory** / **Skills** | Remembered notes and reusable agent instructions |
| **Machines** | Remote connections and phone access |
| **Scheduled jobs** | Schedules, default run behavior and creation approvals |
| **Notifications** | Notification level, menu-bar/tray behavior and supported background service options |
| **Appearance** / **Links** | Theme, layout, optional features and desktop link handling |
| **Backup & restore** | Portable workspace export and import |

For repository runs, `backend/.env` can be created from
`backend/.env.example`, which enables Pi only; adjust its runtime list if you
want other runtimes. Existing process variables take precedence. Packaged
Electron startup also reads `~/.michi/.env`. Frontend values in
`frontend/.env.local` are build-time `VITE_*` settings. See the
[configuration guide](backend/src/docs/configuration.md) for precedence and
platform-specific exceptions.

Common backend overrides:

```bash
# Limit registration; omit to register all eight runtimes.
MICHI_ENABLED_RUNTIMES=kiro,crew,pi,claude,codex,antigravity,cursor,grok

# Optional default for new conversations.
MICHI_DEFAULT_RUNTIME=pi

# Override state, configuration and log directories where supported.
MICHI_DATA_DIR=/path/to/michi-data
MICHI_CONFIG_DIR=/path/to/michi-config
MICHI_LOG_DIR=/path/to/michi-logs
```

CLI path overrides include `KIRO_CLI_BIN`, `CLAUDE_CLI_BIN`, `CODEX_CLI_BIN`,
`ANTIGRAVITY_CLI_BIN`, `CURSOR_CLI_BIN` and `GROK_CLI_BIN`. Set them on the
backend host, not only on the desktop connecting to it.

### Scheduled jobs and the background service

Ask an agent to schedule a task, or manage it in **Settings → Scheduled jobs**.
Jobs support one-off and recurring schedules, including intervals, daily,
weekdays, weekly and cron with a timezone. Runs can appear in the workspace or
stay under Scheduled, and can reuse a conversation or start a new one.

- Creation follows **Ask before agents create scheduled jobs**. A turn that read
  outside content can still require approval even when this switch is off.
- Updating, running immediately or deleting a job requires explicit approval,
  regardless of ordinary chat permissions. Pausing does not.
- Scheduled work defaults to Trust. Overlapping runs are skipped; missed runs
  are coalesced rather than replayed in a burst.
- A job run or Agent Run cannot recursively create more scheduled jobs.

Scheduling requires a running backend. In the installed macOS app,
**Settings → Notifications → When Michi's windows are closed → Keep Michi
running after you quit** installs a per-user launchd service. Closing windows
and quitting the app are different: the menu-bar/tray option keeps the app
alive after its last window closes; the macOS service keeps its backend alive
after the app quits. Windows offers tray and login-startup options.

### Development isolation

Root development launchers default data and configuration to `~/.michi-dev`.
Use explicit data/config/log directories for disposable instances. Some settings
do not follow every override: local provider credentials and Electron settings
still use `~/.michi/config.json`, while native CLIs have their own config and
session stores. A development data directory alone does not isolate credentials.

For a worktree, use `node scripts/worktree-setup.mjs <worktree>` to link the
main checkout's dependencies; do not install a second dependency tree there.
Development launchers can stop stale development processes, and desktop
packaging can replace the installed app.

### Hosted auth configuration

Personal local use needs no account. For a multi-user deployment, enable both
`MICHI_REQUIRE_AUTH=true` and `MICHI_CLOUD=1`, configure Better Auth/Google OAuth,
and provide a persistent data directory. The Dockerfile defaults to this
Pi-only hosted mode.

Relevant secrets include `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` and `MICHI_ENCRYPTION_KEY`; set the public origin with
`BETTER_AUTH_URL`. Keep the encryption key stable and back it up securely:
changing it makes saved provider keys unreadable. Persist both application
`data.db` and authentication `auth.sqlite`.

Authenticated personal mode is different: with cloud mode off,
`MICHI_LOCAL_AUTH_EMAIL` must identify the single owner. It does not isolate
multiple users. Hosted mode also restricts desktop/local features, including
terminals, the personal background watcher and the local skill library.
See [access modes](docs/access-modes.md) before exposing a backend or migrating
an existing installation.

### Metrics and startup profiling

Metrics are off by default. `MICHI_METRICS=1` enables structured metrics;
`MICHI_FRAME_METRICS=1` and `MICHI_STARTUP_TRACE=1` add renderer/startup detail.
Analyze a captured JSONL log with:

```bash
npm run startup:analyze -- logs/metrics.jsonl
npm run metrics:analyze -- logs/metrics.jsonl
```

## Architecture

```text
Electron / web / phone / native iOS
                 │
          HTTP API + streams
                 │
       Backend: auth, workspaces,
       durable turns, tools, jobs,
       Pages, Memory and persistence
                 │
       Runtime adapters / providers
                 │
       Agent CLIs and model APIs
```

### Backend

`backend/src/server.ts` configures databases, authentication and routes.
`backend/src/agents/runtimeFactories.ts` registers the selected runtimes.
The backend owns workspace/owner authorization, persistence, scheduled work and
the host services exposed to agents.

### Runtime and stream model

`runtime/` contains the shared runtime contract and reusable adapters; Pi and
some adapters remain in `backend/src/agents/`. The backend injects application
services through runtime host interfaces. Runtime code must not depend on
application code or introduce its own environment reads.

`backend/src/agents/chatHub.ts` owns durable turns and subscriber replay.
`sessionRegistry.ts` tracks live sessions. Shared event schemas and turn
projection keep backend, browser and native clients aligned. Streams multiplex
over a WebSocket per gateway/window where supported, with HTTP SSE fallback.

A renderer disconnect is not an explicit cancellation. Turn IDs, assistant IDs
and sequence watermarks support reconnection and replay, while runtime cleanup
can outlast the visible answer. See
[sessions and recovery](backend/src/docs/sessions-and-recovery.md).

### Tools and permissions

The tool bridge exposes workspace-scoped navigation, Artifacts, Pages,
background work and other host capabilities. Runtime-native tools retain their
own capability and approval rules. Read-only access, mutation approval and
owner/workspace boundaries are enforced by the backend, not just by UI controls.

### Frontend

The React/TypeScript frontend is a page-routed, keyboard-driven terminal shell.
`TerminalShell.tsx` handles navigation; Dashboard arranges resizable panes; Map
navigates the active conversation tree. Shared composers and the TipTap editor
handle chat, management and new-chat input. Theme tokens and UI rules live in
[DESIGN.md](DESIGN.md) and [docs/design](docs/design/).

### Persistence and recovery

SQLite is the durable source of truth. Browser hydration must finish before
saved state is replaced; an unreachable backend is not an empty workspace.
LocalStorage supports small preferences, caches and legacy migration, while
sessionStorage retains scoped pane state and IndexedDB caches remote views.

Backups taken before schema migrations protect database upgrades, not the whole
installation. Recovery and portability still require workspace files,
configuration and any needed native runtime state.

#### Kiro ACP Engines

Kiro V3 is the default. `MICHI_KIRO_ENGINE=v2` selects the compatibility engine.
Crew pins its own V2 engine independently of that setting. Preserve queue
ordering, cancellation and per-session ownership when changing ACP adapters.

### Electron

Electron owns native windows, browser views, file dialogs, notifications and
local terminals. Production normally starts or attaches to a backend and loads
its HTTP-served UI. Multiple windows share that backend. Optional macOS service
and Windows tray behavior are separate from renderer lifecycle.

## Project Structure

```text
frontend/          React UI, state and client API
backend/           HTTP server, host services, Pi and app-specific adapters
shared/            Shared types, schemas and turn projection
runtime/           Runtime contract and reusable agent adapters
electron/          Desktop main process and preload bridge
ios/               Native iOS app and Swift packages
crew-app/          Michi's Crew App bundle
e2e/               Isolated Playwright tests
scripts/           Build, install, validation and development tools
assets/            Application icon and other source assets
docs/              Guides, feature records and design documentation
```

## Data and Logs

Production state/configuration defaults to `~/.michi`; source installation
defaults to `~/Michi`, and workspace files live wherever their folders point.
Important state includes `data.db`, `audit.db`, `config.json`, the skill library
and logs. Hosted authentication also uses `auth.sqlite`. A remote backend keeps
its own state and logs on the remote machine.

**Settings → Backup & restore** exports portable workspace data; it is not a
complete installation backup. It does not include Pages/databases, scheduled
jobs, Memory, your agent's own history, credentials or the bytes of project
files. For full recovery, stop the backend and copy its data/configuration,
workspace files and any required external/native runtime state. See
[data and backups](backend/src/docs/data-and-backups.md) for exact scope and
restore steps.

## Development Notes

- Treat [AGENTS.md](AGENTS.md) and current package scripts as the development
  guide. Check affected consumers when changing shared protocol or runtime code.
- Preserve owner and workspace isolation, including search, exports, recovery,
  tools and remote caches.
- Keep tests away from live user state. The isolated browser suite uses mock
  APIs and does not require real agents or credentials.
- Validate bundling or packaging when resources change; do not run desktop
  installation as a routine test.
- Public feature and validation records are indexed in
  [docs/features/README.md](docs/features/README.md).

## Data & Privacy

Conversation history, Pages, Memory, Artifacts and audit records can contain
private material. Providers receive the context and tool results sent through
their selected runtime; local storage does not imply that model requests stay
on the machine. Remote workspaces run on their selected backend.

Review stored Memory, permissions, provider configuration and backups according
to your needs. Deleting a conversation does not automatically delete notes
learned from it or copies in existing backups. See
[privacy and data](backend/src/docs/privacy-and-data.md).

## License

ISC.
