# Claude Ultracode

Michi exposes a per-conversation Ultracode setting for ordinary Claude chats.
When the installed Claude runtime and selected model support it, the runtime can
organize work into background workflows. Michi stores the requested setting and
shows the runtime's reported active and available state separately. The presence
of the switch does not establish support in a particular CLI or account.

## Behavior

- Use the model picker in an existing Claude conversation, or the Home composer
  before starting a new one. The Home choice resets after sending.
- The backend persists the setting; graph snapshots cannot overwrite it.
- Session startup and resume pass the setting to Claude. Changes are reconciled
  before a turn and applied to a live session when its SDK supports that operation.
- The runtime reports whether the setting is active and available. Bare sessions
  and sessions without support do not report it as active.
- The setting is unavailable to the Michi assistant, maintenance sessions, custom
  agent/tool-profile sessions and Agent Runs.
- Workflow permission requests appear in the workflow UI and follow the chat's
  current permissions when the runtime asks Michi for approval.

## Limits

A new branch does not inherit this choice; it starts off. The digest follow-up
composer does not offer the switch. Stopping the chat can stop its background
workflows, and changes from YOLO to Ask cannot retroactively approve operations
already permitted by the runtime. Workflow token usage appears on workflow cards;
Michi does not provide a separate workflow budget or size control here.

Runtime availability and behavior depend on the installed CLI, SDK, model and
account. This page describes Michi's integration, not a live-provider compatibility
certification.

## Source and tests

- [Claude session integration](../../runtime/src/adapters/claude/ClaudeSession.ts)
- [Persisted chat setting](../../backend/src/services/chatUltracode.ts)
- [Runtime behavior tests](../../backend/test/claudeUltracode.test.ts)
- [Setting route tests](../../backend/test/chatUltracode.test.ts)
- [Composer tests](../../frontend/src/components/terminal/ComposerModelPicker.test.tsx)
- [Home composer tests](../../frontend/src/components/terminal/manage/ManageComposer.test.tsx)
