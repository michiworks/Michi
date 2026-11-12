# Configure Michi, credentials and updates

Applies to: installed desktop/web, source checkouts and remote backends. Shell examples use macOS/Linux syntax unless stated otherwise. Source checked: 2026-11-08. Configuration is backend-specific; some credential/Electron paths do not honor every directory override.

## Pages and Pages upkeep settings

**Settings → Michi → Pages upkeep → Runtime** (the Settings page is named after your agent: Michi unless you renamed it) chooses the runtime/provider/model for background maintenance and automatic memory extraction: "Follow global settings" or "Custom" (Claude, Pi, Codex or Kiro; Pages upkeep can't use Kiro Crew or Antigravity). The Pages Assistant does not use it. An Assistant conversation runs on the global runtime and model from Settings → Runtime & model (or, when that runtime can't host the Assistant, as with Crew or Antigravity, the first one that can) until you pick a runtime, model or reasoning in its composer; that conversation then keeps its pick. Ordinary workspace conversations retain their own settings. Pages and Pages upkeep support the local backend only. See `pages-maintenance` for workspace enablement, page-tree exclusions and runtime checks.

**Layout preferences** is a separate per-page document under Page actions/Page settings. It is not a global appearance setting or runtime profile, and saving it does not invoke a model. See `pages-and-components` and `page-component-design`.

## Know which installation you are configuring

| Location | Default purpose |
| --- | --- |
| `~/Michi` | Public source installer checkout |
| `~/.michi` | Default production state/config root |
| `~/Applications/michi.app` | Installed macOS desktop application |
| Your project directory | Workspace files; independent of installation |
| `~/.michi-dev` | Default data directory for root development launchers |
| Remote server paths | Runtime processes, workspace files and state belonging to that remote backend |

Custom installations and data directories may differ. Do not substitute a developer's absolute checkout path into end-user instructions. A standalone desktop bundle's state folder is not necessarily a built installation checkout.

## Configuration sources and precedence

| Source | Used for | Precedence/limitations |
| --- | --- | --- |
| Backend process environment | Runtime launch, deployment and overrides | Takes precedence over `backend/.env` |
| `backend/.env` | Backend environment for repository runs | Does not override existing process values |
| `~/.michi/.env` | Packaged Electron startup environment | Loaded before the desktop backend starts; the macOS background service reads it itself. Existing process values win, except that Michi always sets the port, log directory and loopback-only binding |
| `<installation>/.env` | `michi` launcher configuration, including web `PORT` | Sourced by that launcher; not a universal configuration loader |
| `config.json` under `MICHI_CONFIG_DIR` | Runtime/model/UI preferences in supporting modules | Default `~/.michi`; provider credentials and Electron settings still use `~/.michi/config.json`, and saved remote-connection records use `config.json` under `MICHI_DATA_DIR` |
| `skills/` and `skills-state.json` under `MICHI_CONFIG_DIR` | The Michi skill library and which of its skills are off | Default `~/.michi`; managed in Settings › Skills or by hand; see `skills` |
| Frontend `.env.local` / Vite mode files | Renderer build-time `VITE_*` values | Not a live backend runtime-setting mechanism |

Restart the owning process after changing startup environment. A helper command does not necessarily load the desktop `.env`; Crew custom preparation requires its environment to be passed explicitly as described in `crew`.

## Which settings affect an existing chat?

| Setting | Scope and timing |
| --- | --- |
| Runtime in Settings → Runtime & model (shown when more than one runtime is available) | New chats; existing chats keep their runtime |
| Provider/model/reasoning | Depends on runtime and the current chat's controls; verify the next response's effective choice |
| Global permissions | Ordinary chats on that backend, scoped by owner when hosted; applies from the next turn |
| Per-chat permissions | Used when global control is off; individual choices are preserved while global control is on |
| Native Resume | Per runtime; changes future cold restoration, not already-live sessions |
| Native Fork | Per runtime; changes future child creation, independently of Native Resume |
| Crew Memory default | New Crew chats; existing chats keep their mode, forks inherit it |
| Custom Agents (`MICHI_CUSTOM_AGENTS=1`) | Backend environment only, read at startup; no Settings switch; requires backend restart |

A disabled or absent control may mean the current runtime does not expose that capability. Changing a default does not migrate all existing sessions.

## CLI works in Terminal but not in Michi

1. Confirm the CLI is on the backend machine. Installing it on the desktop does not install it on a remote server.
2. In a terminal on that machine, locate the executable and check its version. macOS/Linux examples: `command -v kiro-cli`, `command -v claude`, `command -v codex`. On Windows use `where kiro-cli`, `where claude` or `where codex`.
3. Desktop applications do not necessarily inherit interactive shell startup files or version-manager PATH. Configure an absolute executable override when needed.
4. Authenticate/configure that runtime using its supported local mechanism under the same user/home the backend runs as.
5. Restart Michi after environment changes and test a small request.

Supported launch variables include `KIRO_CLI_BIN`, `CLAUDE_CLI_BIN`, `CODEX_CLI_BIN`, optionally `CODEX_HOME`, and `MICHI_ANTIGRAVITY_BIN` for the opt-in Antigravity runtime (otherwise `agy` is searched on PATH, then `~/.local/bin`). Of these, the macOS background service passes through only `KIRO_CLI_BIN`; see below. Do not paste credentials into a prompt or into a shared diagnostic transcript. See `runtimes` for provider details.

## Pi provider credentials

Configure the provider in Settings → Runtime & model (Provider and Model rows in its Model section). API-key providers need the selected provider's credentials. Amazon Bedrock supports an AWS Profile, Bearer Token, Access Keys or the SDK default credential chain, plus region and optional credential refresh command.

On a local or desktop backend, existing environment variables take precedence over saved settings: AWS variables over saved Bedrock configuration, and a provider's API-key variable (for example `ANTHROPIC_API_KEY`) over a key saved in Settings. Hosted per-user keys come only from the user's encrypted vault. If Michi uses an unexpected account/region, inspect which credential source is active without printing secrets. Credential presence is not proof of valid access to a chosen model.

Local credentials are stored in `~/.michi/config.json`; hosted per-user keys use a separate encrypted vault. Use `privacy-and-data` for storage boundaries.

## Pi web search

Local and desktop backends, including one reached by remote or phone access, offer web search; hosted multi-user deployments other than Railway do not. In Settings → Runtime & model → Web search, set Search provider to Jina Search or Tavily and save its API key. The key stays on the backend with the other provider keys. On a local or desktop backend `JINA_API_KEY` / `TAVILY_API_KEY` take precedence; a hosted (Railway) deployment keeps each user's key in its encrypted vault and ignores those variables. Settings only shows whether a key is saved. New Pi chats then receive `web_search` and `fetch_content`; choose Disabled to remove them. Queries go to the chosen provider, and `fetch_content` fetches public pages from the backend machine. `MICHI_WEB_SEARCH_ENABLED=0` hides the feature on any backend.

## Update an installed checkout

Preserve local source edits, pull the public `main` branch, run `npm install`, and rebuild the relevant target from the installation checkout. Follow the repository README for the platform you use. A local development commit is available to others only after publication.

On macOS, `npm run electron:build` quits/replaces the app. For a remote service, follow `remote-backend` to rebuild and restart it. Forced resets and deleting application state are not routine update steps.

Crew users must also Sync their existing App and approve the current Stub / Routed launch when it changes, following the `crew` guide. Do not uninstall the App or create a second one as an update shortcut.

## Keep the backend running on macOS

In the installed macOS app, **Settings → Scheduled jobs → Background → Keep Michi running in the background** runs the bundled backend as a per-user launchd LaunchAgent (`com.michi.backend`, `~/Library/LaunchAgents/com.michi.backend.plist`; state in `~/.michi/service.json`). It keeps running after you quit the app, starts when you log in, and the app attaches to it on the same loopback port. Other platforms, development runs and browsers do not offer it. If the service does not start, the app uses its own backend for that session; see `service.err.log` in the log directory (default `~/.michi/logs`).

The service always binds to 127.0.0.1 with remote access off. It does not inherit the app's environment: it receives `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `MICHI_DATA_DIR`, `MICHI_CONFIG_DIR`, `MICHI_DEFAULT_RUNTIME`, `MICHI_ENABLED_RUNTIMES`, `MICHI_CUSTOM_AGENTS` and `KIRO_CLI_BIN` when set, and reads `~/.michi/.env` itself (existing values win). Put other variables, such as `CLAUDE_CLI_BIN`, `CODEX_CLI_BIN`, `CODEX_HOME`, `MICHI_ENABLE_ANTIGRAVITY` or provider API-key variables, in `~/.michi/.env`. Quitting and reopening the app leaves the service running; turn the setting off and on to apply a changed `~/.michi/.env`. A new app build restarts it at the next launch.

## Directory and deployment overrides

`MICHI_DATA_DIR`, `MICHI_CONFIG_DIR` and `MICHI_LOG_DIR` choose state/config/log locations in supporting modules. The skill library follows `MICHI_CONFIG_DIR`; the skill mounts Michi generates for runtimes follow `MICHI_DATA_DIR`. `MICHI_ENABLED_RUNTIMES` (comma-separated ids) limits registration to the listed runtimes. The opt-in Antigravity runtime (`agy acp`) is registered only when listed there or when `MICHI_ENABLE_ANTIGRAVITY=1`, which adds it even to a restricted list. `MICHI_CUSTOM_AGENTS=1` turns on Custom Agents. Node.js 22.19+ is the source/remote baseline. The backend's default repository port and installed web launcher's port differ; use the actual printed address.

Development launchers, updates and Electron packaging can stop processes or replace the app. They are not read-only diagnostic commands. For remote deployment use `remote-backend` rather than a local desktop launch recipe.

Success check: the intended backend reports the expected runtime/model, a small request works, and the chosen settings survive reopening the relevant UI. If not, retain the error and inspect that backend's effective configuration source.

Related documents: `runtimes`, `permissions`, `crew`, `remote-backend`, `troubleshooting`.
