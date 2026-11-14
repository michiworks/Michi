# Permissions and tool approvals

Applies to: ordinary chats on local/remote backends; hosted settings are owner-scoped. Source checked: 2026-11-12 (lane D: consequence-based approvals). Agent Runs use their own effective policy. Native sandbox and governance behavior depends on the runtime.

## Choose the mode in Michi

Open Settings → Runtime & model → Permissions. Use global permissions applies one mode to ordinary chats on that backend and hides per-chat composer controls. Turn it off to choose a mode in each chat. Individual choices are preserved while global control is enabled and restored when it is disabled. New chats default to Ask.

Kiro, Crew and Pi offer Ask / Trust in the composer, as does Antigravity, an opt-in runtime, when it is enabled. Claude and Codex also offer YOLO. Kiro V3, the default Kiro engine, also offers Approve for me. Existing YOLO choices display as Trust on Kiro, Crew, Pi and Antigravity with the same execution behavior. An Approve for me choice displays and runs as Ask on any other runtime, including Crew, Antigravity and Kiro v2. Local and remote backends each own their settings; hosted settings are scoped to the authenticated user. Agent Runs have a separate permission policy.

## Ask, Trust and YOLO

- Ask: prompts for changes and tools requiring approval. Native read-only tools can run automatically. Pi also asks for unknown/external MCP tools. Michi's own conversation tools run without a permission card on every runtime, Crew included: reading Michi docs and skills, threads, messages, panes, pages, tasks, scheduled jobs and Agent Runs; listing and searching Artifacts; recording a turn's overview, title and follow-ups; asking you a question; messaging another thread (with its own approval when requested); proposing a multi-model plan, whose plan card is the consent (its branches copy the proposing chat's own permission setting), and listing ready models; and Michi Memory. Michi's page, artifact, scheduled-job, link, image, web, branch and Agent Run actions ask on Kiro, Crew, Claude and Pi, except that in Pi Michi's branch, artifact, todo, image and web-read tools (`spawn_branches`, `save_artifact`, `update_artifact`, `todo`, `show_image`, `web_search`, `fetch_content`) also run without a card; Pi's `open_url` still asks. Codex and Antigravity run every Michi tool without a card; the tools keep their own approvals.
- Always allowed: in every mode and on every runtime, chats run Michi's own conversation tools above without a card, Michi Memory's `memory_search`, `memory_save`, `memory_update` and `memory_delete` and the Artifacts reads `list_artifacts` and `search_artifacts` included. Each tool applies its own scope and confirmation rules.
- Always asks: `delete_artifact` shows its own card for every deletion, in Ask, Trust and YOLO and on every runtime, Codex included. Only its Delete choice approves; a grant, session-wide trust, no answer or a chat with nobody to ask never does. Another MCP server's tool named `list_artifacts`, `search_artifacts` or `delete_artifact` is not Michi's: it follows the chat's mode like any other tool.
- What leaves this machine: in some turns it asks whatever the mode says. See [What leaves the machine asks](#what-leaves-the-machine-asks).
- Trust: automatically approves tools while retaining any native sandbox. For example, Codex allows workspace writes but retains sandbox restrictions.
- YOLO: automatically approves tools and requests full native access where supported. Claude uses its bypass mode and Codex uses full access. Kiro, Pi and Antigravity Trust and YOLO have the same backend auto-approval behavior; Michi does not add an OS sandbox for them.
- Approve for me (Kiro V3 only): Ask, with Kiro's own trust classifier added. Kiro allows workspace edits and read-only shell commands, and its classifier judges what no rule settles. It approves routine work, blocks actions it considers risky and sends an ordinary approval card when it is unsure. Michi does not see or record the operations Kiro approves itself; they appear as ordinary tool calls. Each classifier decision is an extra Kiro model call.

## What leaves the machine asks

Michi decides by what a call does, not by whether the turn read outside content. Two kinds of turn are guarded:

- **Michi's work:** Michi, not you, sent the turn's message. That covers a conversation your agent started that you have not written in, a follow-up it sent, or a message another conversation's agent relayed.
- **A turn that holds outside content:** what a check-in wrote or a watcher read, a web page, another MCP server's results, or content another conversation passed in. A turn's own command output does not count.

In a guarded turn, a call that leaves this machine asks on a card with only Deny and Allow Once, whatever the mode, a Trust-this-tool grant or session-wide trust says. That includes git push, gh pr/api writes, publishing a package, deploying, curl or wget sending data, ssh/scp, mail, AWS, kubectl or terraform writes, moving the default branch, another MCP server's non-read tool, and `open_url`. A command Michi cannot read (sh -c on an expansion, inline code that reaches the network, another agent CLI) asks too. Michi's work runs local, undoable work without asking: edits, builds, tests and commits. If it started from content someone else wrote, its web, network-command and credential reads also ask, for the rest of that conversation. Elsewhere the chat's mode decides as usual. Creating a scheduled job asks as before. Saves to memory keep their own rules. Approve for me is off in guarded turns.

| Call | Your turn with outside content | Michi's work | Michi's work started from someone else's content |
| --- | --- | --- | --- |
| Reads, Michi's own tools, local edits and commands | Your mode | Runs | Runs |
| Web, network-command and credential reads | Your mode | Runs | Asks |
| Leaves this machine, or Michi cannot tell | Asks | Asks | Asks |

When you ask your agent for a new conversation in your own message, it starts it without a card, whatever that turn read. One it starts in a turn you did not send (a worker report, a reply from another conversation) asks first. A conversation your agent starts in a git repository opens on its own worktree and `michi/…` branch, so its edits stay off your checkout. Merging into your default branch and pushing ask.

How each runtime enforces it:
- Pi: every call passes Michi's policy.
- Claude: Michi's PreToolUse hook sends the calls that must ask to Michi, past your own allow rules and YOLO.
- Codex: guarded turns run sandboxed with network off and on-request approval, so a command that needs more asks Michi.
- Kiro: guarded turns switch to `michi-guarded--<agent>` in `~/.kiro/agents`, a copy of the chat's agent that pre-approves only reads. A Kiro V3 mode with no agent file to copy (autonomous, for example) runs the guarded turn on vibe instead, which asks before commands and file writes. Before the chat's next unguarded turn it goes back to that mode, also after a restart. If Kiro does not confirm a switch, the turn does not run.

Known limitations:
- Commands are judged from their text. On Claude, Kiro and Pi, a script the agent wrote and then runs, a git alias, or a make target that does not name a release step reads as local, so what it sends out does not ask. Only Codex has a network-off sandbox underneath.
- Codex and Kiro set a turn up when it starts. A turn that reads outside content partway through keeps that setup for the rest of it: on Codex in Trust, commands run sandboxed with network off and without asking; in YOLO they run without asking. On Kiro, tools the chat's own Kiro agent pre-approves (its allowedTools) run without asking. Michi's own tools that leave the machine or start other work still stop: they ask on Kiro and are refused on Codex, which gives Michi no way to ask. Claude and Pi judge every call.
- Another MCP server's tool is judged by its annotations when a runtime passes them, else by its ACP kind or name. A write verb in the name asks, a read verb counts as a read, and a name with neither asks.

## Approve for me details

Kiro V3 applies Approve for me as its `approve-for-me` policy preset when it opens a session. Michi launches Kiro V3 with `KIRO_TRUST_CLASSIFIER_MODE=enforce`, which this preset requires, unless the backend environment already sets that variable. The classifier only judges rules whose effect is `evaluate`, so sessions without the preset keep Kiro's normal behavior.

Switching a chat into or out of Approve for me takes effect from its next message: Michi closes and reopens the idle native session with the new preset. The transcript, model and effort settings are kept. Michi does not reopen a session while it is running, compacting or while a Kiro workflow runs in the same process. If turning the preset off fails, the message is not sent, so Kiro's classifier never approves work in a chat set to Ask. Send the message again to retry. Trust and YOLO approve everything and leave a session's preset as it is.

Approve for me applies to ordinary chats. Agent Runs, Pages upkeep and the Pages Assistant (your agent's own conversation in its ⌘J panel) keep Kiro's default policy. With global permissions enabled, choosing Approve for me sets Ask on runtimes without it.

Changes apply from the next turn. Saving Ask or Approve for me clears applicable Michi always-allow chat grants. Approval remains enforced without a connected renderer. Approval controls do not enable a missing tool or override an upstream governance refusal.

## Approval cards

- Deny rejects this request without saving a grant.
- Allow Once approves only this request.
- Trust this tool saves a grant for that tool in the current Michi chat and can survive resume. It is disabled when the runtime cannot identify the tool reliably.
- Trust all tools for this session trusts tools in the current runtime session. This grant is temporary, is not saved to the database and expires when the session is recreated or permission settings are explicitly changed.

Choose Ask or Approve for me to clear applicable chat grants. Treat session-wide trust as temporary; a resumed native session may be recreated. A visible button or a saved mode does not prove that an upstream runtime produced a pending request.

| Choice | Saves a grant? | Survives session recreation? | Clears when |
| --- | --- | --- | --- |
| Deny | No | Not applicable | Request ends |
| Allow Once | No | No | Request ends |
| Trust this tool | Current-chat tool grant | Can survive resume | Saving Ask or Approve for me clears it |
| Trust all tools for this session | Temporary session grant | No | Session recreation or explicit permission change |

Saving Ask or Approve for me in Settings clears every chat grant on a local or remote backend, or all of your grants on a hosted one. So does turning Use global permissions on or off while the global mode is Ask or Approve for me. Saving it in one chat clears that chat's grants. Forks do not inherit those grants. Approval buttons are neutral until hover/focus; they have no dedicated shortcuts. Use click or keyboard focus plus Enter/Space.

## Approval and sandbox are different

| Runtime | Trust / full-access boundary |
| --- | --- |
| Kiro | Michi auto-approval; no added Michi OS sandbox; native policy still applies. Approve for me uses Kiro V3's classifier, not a sandbox |
| Crew | Auto-answers pending native requests; Crew allowlists/governance still apply |
| Pi | Michi policy and filesystem path checks; arbitrary shell commands are not OS-isolated by a working directory |
| Claude | Native permission handling; YOLO uses native bypass; equivalent OS isolation is not verified by Michi |
| Codex | Trust retains native sandbox/workspace writes; YOLO requests full native access |
| Antigravity | Trust auto-answers agy's requests for edits and commands; agy does not ask before workspace reads or MCP tool calls, so Ask cannot intercept them; no added Michi OS sandbox |

An approval decision authorizes the described request. It does not mean files can always be rolled back, credentials are valid, a tool is installed or an upstream service will allow the action.

## Test and diagnose an approval

1. Confirm runtime, backend, effective global/per-chat mode and tool availability.
2. In a disposable directory, ask for a small clearly identified write. Review the actual native request if one appears.
3. Allow Once for one request, then test Deny on a separate file and check actual file results.
4. Revoke any test grants by returning to Ask.

Reads may run without a card. If no card appears for an operation, check whether the upstream runtime already approved it or whether no tool ran at all. Do not claim a test passed merely because a mode or button was visible.

If the renderer disconnects, backend policy still applies; a request may wait for a decision, but disconnection is not approval. Restore the same chat and inspect pending interactions. An Ask User information card is separate from a permission card.

## Crew approvals and required consent

Michi MCP and sessionApproval are required parts of Crew setup. Missing or revoked consent is incomplete setup and blocks new turns. sessionApproval lets Michi receive and answer Crew's native pending tool requests; consent itself does not automatically approve every tool.

Crew's own allowlists, governance and global YOLO apply first. If Crew already auto-approved an operation, Michi Ask cannot intercept it because there is no pending request. Choose Ask / Trust in Michi for daily use. A global Michi YOLO preference behaves as Trust for Crew.

The upstream sessionApproval grant can also cover user-owned Crew chats. Michi's adapter limits access to its own local unlinked App sessions. Do not control the same session concurrently from Crew and Michi. Read the `crew` guide for the exact one-time authorization steps.

## Agent Runs

Custom Agent definitions select a capability surface and permission ceiling; parent restrictions can reduce it. Ordinary chat Trust does not bypass a Run's effective policy, allowlist or upstream restrictions. Inspect the Run's own interactions and environment. See `custom-agents`.

Related documents: `runtimes`, `runtime-capabilities`, `crew`, `sessions-and-recovery`, `troubleshooting`.
