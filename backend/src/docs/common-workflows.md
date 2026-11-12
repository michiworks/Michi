# Complete common tasks with Michi

Applies to: ordinary chats with the relevant Michi tools available. Source checked: 2026-11-08. These are example workflows, not claims that a task has already run. Custom Agent Runs require the separate experimental feature.

## Research alternatives and make a decision

Goal: compare alternatives, preserve evidence and keep the final choice with you.

1. Create a workspace for the research and start a root chat. State the question, constraints and evidence standard.
2. Ask for explicit branches, for example:

   > Create three research branches comparing A, B and C. Each should report sources, tradeoffs and unresolved questions. Do not make a purchase or change any accounts.

3. Keep branches in separate panes. Use Overview to catch up and read original passages when a claim matters. `spawn_branches` supports at most five children per call.
4. Select relevant chats and use Weave for a comparison conversation, or Digest for a source-connected synthesis. These do not imply the source transcripts were all copied verbatim.
5. Ask the synthesis to cite evidence, identify disagreements and recommend a choice under your constraints. Correct assumptions before accepting the decision.
6. Save the reviewed result as an Artifact, including sources, decision criteria and open questions.

Success check: each alternative has traceable evidence; the comparison reflects the constraints; the saved Artifact can be read from a new chat. If sources change, re-read them and rebuild the synthesis.

## Implement a feature and verify it

Goal: make a scoped change with inspectable evidence.

1. Choose the repository workspace and confirm its backend/path. Preserve unrelated edits.
2. Start with a concrete behavior and acceptance criteria:

   > Inspect the current implementation. Fix this reproduction case, preserve unrelated changes, run the relevant checks and report exactly what was verified. Ask before expanding the scope.

3. For parallel implementation, create separate Git worktrees and separate workspaces pointing to them first. Ordinary conversation branches share files unless you explicitly arrange isolation.
4. Supply the relevant spec/Artifact and project instructions. Ask for a short plan when the change spans several modules.
5. Inspect tool activity, approval requests and changed-file receipts. A receipt/diff helps inspect work but does not itself prove correctness or assign exclusive ownership of every displayed change.
6. Run appropriate tests/build checks for the behavior. Ask the agent to distinguish automated checks, real-provider checks and unverified cases.
7. Request review in a separate branch/chat with the exact path and diff scope. Ask it to inspect current files, not just the implementer's description.
8. Resolve findings, inspect the final diff and explicitly decide whether to commit, merge or publish.

Success check: the reproduction is fixed, evidence matches the requested behavior, unrelated changes remain intact and remaining limits are disclosed. A green mock test alone does not prove real-runtime compatibility.

## Review existing work without editing

Open the repository workspace and ask:

> Review the current changes for correctness and regressions. Read the relevant implementation and tests. Report actionable findings with file locations and reproduction conditions. Do not edit or commit.

If multiple chats share the directory, state the exact base/ref or file set. A new review conversation does not freeze the files. Finish with findings and supporting evidence, including when no actionable issue was found.

## Continue a long-running investigation

1. Reopen the original chat and wait for history/activity to hydrate.
2. Read Overview, then ask for the exact source messages/files behind uncertain details.
3. State the new constraint or next goal. Use steering if supported, otherwise queue the next turn.
4. Save a compact handoff Artifact named `handoff` containing the goal, current state, paths, verification, pending decisions and sources. A `save_artifact` name uses only ASCII letters, digits, `_` and `-`, with no extension; an @-mention attaches an Artifact only when it matches the whole name, ignoring case.

Example:

> Read `@handoff`, verify the current files and task status, then continue the next unresolved item. Do not repeat completed external actions.

Success check: the agent confirms current state before acting. Saved history, a handoff Artifact and Memory (**Settings → Memory**) have different scopes; none removes the need to verify drift-prone facts.

## Maintain a source-backed Page

1. Open a local workspace page in **Pages**, or ask a workspace chat with native Page tools to create a page when the task needs one. Read the page and current revisions before changing it.
2. Set page-local **Layout preferences** for organization. Ask the Assistant to preserve manual edits, use native blocks, and cite the exact conversations it read.
3. Publish complete groups of related edits. Inspect applied/proposed/rejected receipts; a suggestion is not an applied change. Use **Sources** to inspect the original evidence.
4. Opening **Pages** turns on **Conversation maintenance** for each local workspace that has none yet and, while **Settings → Michi → Pages upkeep → Workspace homes** is on (the Settings page is named after your agent: Michi unless you renamed it), starts its initial workspace-home read over the **First run** range. Every page tree that is not excluded takes part, existing ones included; clear a page's **Keep … up to date from workspace conversations** checkbox in its **Conversation maintenance** panel to exclude it. Check **Settings → Michi → Pages upkeep**, exclusions and progress. Incremental maintenance reads only newly completed turns; turns completed while a page was excluded need an explicit catch-up.
5. For a missing native capability, read `page-component-design` and the component contract before generating source. Inspect a preview and the actual host when UI tools are available; saving alone does not prove rendering.

Success check: the saved page reflects the intended content, manual changes remain protected, Sources resolve to actual evidence, and maintenance status distinguishes completed decisions from unaccepted suggestions. These are local Pages operations; Pages on a remote machine are not supported.

## Share a result or hand it to another chat

Use a reviewed Artifact for the deliverable and thread Export for a readable transcript. Remove private content before sharing externally. Agents use `send_to_thread` directly for coordination within your task, including progress reports and replies to a parent thread. They can set `requestApproval=true` when a user decision is needed or you asked to review messages first. A received message stays attributed to its sending agent and does not authorize work beyond your request.

The sending agent gets the reply one of three ways. By default it checks the other chat's turn itself. With `wait` it waits for the reply (20 seconds by default, at most 30, including any time the other chat is busy) and gets it in the same call; if time runs out, the call returns the same follow-up arguments as the default, so the agent can keep checking. With `wake` it ends its turn, and when the other chat finishes, the reply starts a new turn in the sending chat, shown as **Reply from** that chat. With `wait` or `wake`, the other chat is told that its answer goes back by itself, so it does not send it a second time. The agent is also told when the other chat is waiting for your approval or answer: its message, and so the reply, comes only after you respond there. Stopping either side ends a wake: if you stop the sending chat's turn, or the other chat's turn for the message, no reply turn starts. A wake survives a backend restart, but after a restart Michi starts no turn on its own for a reply that the restart cut short or for a message that never started. If the sending chat cannot be opened or its reply turn cannot start when the reply arrives, Michi tries again at the next restart; after three failed attempts in total, the first included, it drops the wake. Michi also drops a wake if, meanwhile, the sending chat was deleted, archived or put in the trash, its workspace was archived or put in the trash, or the workspace's AI navigation setting was turned off (it is on by default, and Settings has no control for it). To keep chats from waking each other indefinitely, `wake` is refused after two automatic reply round trips without you. Only your next message in the chain resets the count; a turn that no one typed, such as a scheduled job or a background task finishing, continues the count of the turn before it. If no earlier turn in that chat records a count (for example, a scheduled job's first turn in a new chat), `wake` is refused and the agent uses `wait` or the default instead. The Pages Assistant cannot use `wake`.

When experimental Runs are enabled, Continue as Branch can import selected Run task/result/transcript material. It does not merge a Run worktree automatically. See `custom-agents`.

Related documents: `concepts-and-context`, `files-and-artifacts`, `sessions-and-recovery`, `permissions`, `data-and-backups`.
