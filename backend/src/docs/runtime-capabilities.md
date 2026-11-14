# Runtime capabilities in Michi

Applies to: registered Kiro CLI, Crew, Pi, Claude and Codex integrations, and Antigravity when it is turned on. Source checked: 2026-11-12. Upstream behavior notes follow the versions the adapters were probed against: kiro-cli 2.35.1, Crew Gateway 0.11.0.1 and agy 1.4.12. This is an integration reference, not a claim that every upstream version/model has passed live acceptance.

## Read this table

Native means Michi connects to a runtime facility. Michi-managed means the application implements the behavior. Conditional means engine, model, session state or provider support matters. An upstream feature can exist without being connected to Michi.

| Capability | Kiro CLI | Kiro Crew | Pi | Claude | Codex | Antigravity (opt-in) |
| --- | --- | --- | --- | --- | --- | --- |
| Connection | CLI over ACP | Bundled ACP adapter → official local Gateway | Provider APIs in process | Agent SDK with installed CLI | CLI app-server JSON-RPC | `agy acp` over standard ACP, no Kiro extensions |
| Model selection | CLI-discovered; engine dependent | Gateway models | Provider/model catalog | CLI catalog | app-server catalog | Session `model` option |
| Reasoning control | Engine/model dependent | Gateway/model dependent | Provider/model dependent | Model dependent | Model dependent | Low / medium / high (session `thought_level` option) |
| Ordinary chat permission modes | Ask / Approve for me / Trust on V3 (default); Ask / Trust on V2 | Ask / Trust | Ask / Trust | Ask / Trust / YOLO | Ask / Trust / YOLO | Ask / Trust |
| Work modes (composer agent menu) | Kiro agents from the CLI | Crew templates | None | Default / Plan in chats; separate from the permission mode; not in Agent Runs | Default / Plan collaboration modes; separate from the permission mode | None |
| Michi tools | Shared MCP | Official broker relay | Direct in-process tools | Shared MCP | Shared MCP | Shared MCP |
| Product docs | `michi_docs` | Through relay discovery/call | `michi_docs` | `michi_docs` | `michi_docs` | `michi_docs` |
| Image input | ACP image blocks; CLI/model support needed | Not supported by adapter | Image blocks; model support needed | Image blocks; model support needed | Local image input; model support needed | Sent as file links (`resource_link`) that agy reads itself |
| Other file attachments | Paths supplied for tool reads | No image/audio support; do not assume generic rich attachment ingestion | Paths supplied for tool reads | Paths supplied for tool reads | Paths supplied for tool reads | Paths supplied for tool reads |
| Same-turn steer | Native; engine dependent | Unavailable to official App callers | Native at assistant boundary | Native in chats: joins the turn at its next tool round, or runs right after it within the same Michi turn; Agent Runs use the next turn | Native | Unavailable |
| Busy-input fallback | Michi queue where applicable | Next-turn queue | Michi queue where applicable | Michi queue where applicable | Michi queue where applicable | Next-turn queue |
| Native resume | Conditional native load | Gateway session load | Native SDK transcript restored when its checkpoint matches Michi's history; otherwise text/context reconstruction (always in the agent-core rollback, `MICHI_PI_SESSION_SDK=0`) | Native resume | Native thread resume | `session/load` after a `session/list` check; a lost session is rebuilt from Michi's history |
| Branch/fork | Native for compatible idle parents; text fallback | Independent Gateway transcript fork with context replay | Michi context-based branch | Native historical fork when a saved message position exists; text fallback | Native for compatible idle parents; text fallback | Michi history replay; no native fork |
| Manual compact from Michi | Connected; engine/version dependent | Connected (`/compact` on the chat's own idle Gateway slot); Crew also compacts automatically | Connected (`/compact` between turns; declined while a turn runs); unavailable in the agent-core rollback | Connected (`/compact` between turns) | Connected | Unavailable (`/compact` reports it unsupported) |
| Dedicated Crew Memory controls | Not applicable | Read & learn / Read only / Off | Not applicable | Not applicable | Not applicable | Not applicable |
| Native subagent visibility | Experimental/version dependent | Gateway subagent events for the chat's own slot; each spawn is approved in the Crew dashboard, not Michi | No native roster | Native task lifecycle and forwarded subagent messages | Native child discovery with projected events | No native roster; agy subagents run as tool calls |
| Usage display | Native credits and context %; no token counts or cost | Native per-turn credits and context %; no token totals | Provider usage fields | Native per-turn token counts of the main agent; no cost (the CLI only estimates list prices) | Native token-usage events | Native token counts; no cost or context % |

## Shared Michi features

Workspace history, panes, branches, Artifacts, source references, search, digests, ordinary queues and durable turn recovery belong to Michi. They do not imply identical native runtime state or filesystem isolation. A native subagent roster, a Michi conversation branch and an Agent Run are different objects. A conversation's native subagents show as one line of counts (working, done, failed, stopped) under its newest reply; **Details** opens the Background work drawer, which lists each agent and its result.

Multi-model plans are Michi's too: an ordinary chat on any runtime, Crew and Antigravity included, can propose one (`list_ready_models`, then `propose_multi_model_plan`), and you start it from its plan card; its branches run on the ready runtimes and models the card keeps. Agent Runs, the Pages Assistant and maintenance do not get these tools, a plan's branches and threads shown only under Scheduled cannot propose one, and `MICHI_DISABLE_MULTI_MODEL=1` turns the feature off.

Michi Memory (**Settings → Memory**) is also Michi's own: its memory tools reach chat threads and Pages Assistant conversations on every runtime (what the Assistant saves applies to every workspace), not Agent Runs, check-ins or background maintenance. In the sessions Michi starts, Claude Code's auto memory and Codex memories are off; what Claude Code, Codex and Kiro already remembered is imported into Michi Memory (see `concepts-and-context`). Crew Memory is separate and has its own controls.

Tool availability also depends on configuration and capability allowlists. A selected template may omit tools. Trust cannot expose a missing tool; native provider authentication is independent of Michi permission mode.

## Pages Assistant and automatic maintenance

Restricted background runs (Pages upkeep's maintenance and memory extraction) use **Settings → Michi → Model → Background work** (Same as conversations or Custom; the Settings page is named after your agent: Michi unless you renamed it). They run on Pi, Claude, Codex or Kiro; Crew and Antigravity are refused. On Claude, Codex and Pi, memory extraction is one direct model call with no tools (`MICHI_MEMORY_DIRECT=0` uses a maintenance session instead). Each maintenance session must pass a runtime tool-catalog check, and on Codex it cannot use sub-agents: Codex refuses the spawn, and if a sub-agent starts anyway Michi stops the turn and the sub-agent and reports an error. A configured runtime can still fail startup or provider authentication.

The interactive Pages Assistant, the conversation with your agent that ⌘J / Ctrl+J and a page's Ask open, is not restricted this way. It follows the global runtime settings (**Settings → Runtime & model**), or the runtime picked in its composer for that conversation; when the global runtime cannot host it (Crew or Antigravity), it uses the first registered of Claude, Codex, Pi and Kiro, in that order. It uses the runtime's ordinary tools, MCP configuration and approvals, except that Kiro's Approve for me does not apply to it. Its check-ins (watching, in **Settings → Michi**) run unattended on the conversation's runtime, in throwaway sessions whose native transcript Michi discards afterwards, with only Michi's read tools, guarded Michi writes and the agent's own tools; Claude, Codex, Pi and Kiro V3 can run them, Kiro V2 cannot.

The current Pages and Pages upkeep interface supports only the local backend. Ordinary workspace Page tools, the Assistant catalog and maintenance tools are separate capabilities; Agent Runs do not automatically inherit them. See `pages-and-components` and `pages-maintenance`.

## Kiro engines, Crew and Antigravity

Kiro CLI engines have separate protocol behavior. Michi starts V3 unless `MICHI_KIRO_ENGINE=v2` is set. A chat's native Kiro session belongs to the engine that created it: if the backend now runs the other engine (for example a V2 chat after switching to V3), Michi cannot load that native session and reconstructs the chat from its transcript on the current engine. Crew reuses Michi's Kiro adapter layer but pins its own engine independently of `MICHI_KIRO_ENGINE`. Changing that variable does not enable Kiro private steer/compact extensions in Crew. Only Kiro V3 offers Approve for me (see `permissions`).

Kiro CLI (V2 and V3) keeps Michi's tool schemas loaded through Kiro's mandatory-MCP list unless `MICHI_KIRO_PRELOAD_TOOLS=false`, while external MCP tools can stay deferred. This is not a guarantee that every external tool appears directly. Use the actual engine's discovery mechanism.

On Kiro CLI (both engines, checked with 2.35.1), Stop is confirmed by Kiro itself: the stopped prompt ends with a cancelled result, normally within a few tens of milliseconds, and the same session takes the next message. If Kiro does not confirm within the cancel deadline, Michi reports the Stop as dispatched only and keeps the session for recovery. On Crew (Gateway 0.11.0.1), Stop is confirmed by the Gateway's own record of the stop; without that record it is reported as dispatched only.

Crew requires the full App setup, required MCP and sessionApproval. Daily controls remain in Michi. Its default `michi-crew` template carries fixed integration instructions; another template must preserve equivalent instructions and MCP configuration.

Antigravity is off by default. `MICHI_ENABLE_ANTIGRAVITY=1`, or listing `antigravity` in `MICHI_ENABLED_RUNTIMES`, registers it. Michi runs `agy acp` (`MICHI_ANTIGRAVITY_BIN`, else `agy` on `PATH` or in `~/.local/bin`) on Michi's Kiro adapter layer with the engine pinned to V2. agy keeps its own sign-in: run `agy` in a terminal and sign in with Google. Antigravity has no Agent Runs and cannot run Pages upkeep. Stop is confirmed when agy settles the stopped prompt as cancelled.

## Native sessions are conditional

Native Resume and Native Fork switches do different things. Native forks require compatible idle parents and usable native history. A text fallback preserves conversational context, not an exact copy of hidden native state.

Crew's fork preserves its own transcript/Memory semantics; do not call it a Kiro CLI checkpoint. Pi branches are Michi-managed. A resumed Pi chat reopens its native SDK transcript only when it matches Michi's saved history; otherwise Michi reconstructs the context. Michi's history is authoritative either way. See `sessions-and-recovery`.

## Permissions are not one universal sandbox

Codex Trust retains its native sandbox and permits workspace writes; YOLO requests full native access. Codex Plan mode is a working mode, not a permission: it keeps the chat's Ask / Trust / YOLO policy and sandbox, so do not treat it as a write barrier. Claude YOLO uses the CLI bypass mode; Michi does not verify an equivalent OS sandbox for its ordinary integration. Claude Plan mode lets Claude explore and propose a plan; approving that plan is always your decision, also under Trust and YOLO, and an approved plan returns the chat to Default under its permission mode. Tools the CLI still asks about in plan mode follow the chat's permission mode. Kiro/Crew depend on their upstream policies. Antigravity asks only for edits and commands; agy does not ask before workspace reads or MCP tool calls. Pi's path checks do not make arbitrary shell execution OS-isolated. See `permissions` before relying on containment.

## Verify a capability on your installation

1. Identify backend, runtime, engine/CLI/Gateway version and model.
2. Check whether the control is available for that specific chat.
3. Run a small disposable example with a clear expected result.
4. Inspect the tool/result or resulting file, not just the button or model's assertion.

Success check: the requested behavior actually occurred in the selected runtime. A mock test, descriptor or an upstream documentation page alone is not live provider acceptance. Crew's canonical guide records its dated acceptance scope and unverified platform cases.

Related documents: `runtimes`, `permissions`, `sessions-and-recovery`, `crew`, `custom-agents`.
