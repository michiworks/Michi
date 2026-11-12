# Multi-model threads

Ask an agent in an ordinary conversation to compare answers from other models.
The agent lists ready models and proposes a plan. Nothing starts until you press
**Start**. Each participant runs in a real child conversation, optionally reviews
the other answers, and returns its result to the original conversation for a
synthesis.

## Using a plan

1. Review the plan's model choices and prompts. You can replace, remove or add a
   participant before starting. **Fork** includes the conversation's history;
   **Fresh** includes only the participant's prompt.
2. Press **Start**. The card shows progress, approvals and failures. Open a row to
   see its details in **Background work**; **Side by side** opens the child chats.
3. Answer permission requests on the card or in the child conversation. The
   children copy the caller's conversation permissions, subject to global settings.
4. Use **Stop**, **Retry** or **Replace model** where offered. A successfully
   answered participant cannot be replaced. A late answer after synthesis can
   produce an addendum in the original conversation.

A plan has 1–5 participants and 0–2 review rounds. Plan branches cannot start
nested plans. The assistant, maintenance sessions, scheduled-only threads and
Agent Runs do not receive these tools. `MICHI_DISABLE_MULTI_MODEL=1` disables them.

## Recovery and limits

Plans and their progress are stored in SQLite. A restart preserves an unstarted
plan and interrupts unfinished work; **Retry** continues the interrupted steps.
Forks preserve their history boundary during reconstruction, while fresh branches
do not acquire their parent's history. Moving the caller's tree to another
workspace stops its run rather than moving the run record.

A branch awaiting input or approval can hold the next review round until you
answer or stop it. Runtime-specific permission prompts can appear in addition to
Michi's controls. A model being listed as ready means its runtime is available;
it does not guarantee its credentials, quota or provider request will succeed.
Provider and remote-host compatibility must be checked in the environment used.

## Source and tests

- [Orchestrator](../../backend/src/services/multiModel/orchestrator.ts)
- [Ready-model selection](../../backend/src/services/multiModel/readyModels.ts)
- [Shared UI action rules](../../frontend/src/components/terminal/multiModel/multiModelPresentation.ts)
- [Orchestrator tests](../../backend/test/multiModelOrchestrator.test.ts)
- [Tool integration tests](../../backend/test/multiModelTool.test.ts)
- [Isolated browser tests](../../e2e/specs/multi-model-run.spec.ts)
