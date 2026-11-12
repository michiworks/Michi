/** /compare: ask several models, through the multi-model plan card. */
export const COMPARE_SKILL = `---
name: compare
description: Ask several models the same question, then write one synthesis. The agent first works out what to compare, then proposes a plan you start.
argument-hint: <question>
disable-model-invocation: true
---

The user wants several models to answer this, then a synthesis: $ARGUMENTS
If that is empty, use the question under discussion in this conversation.

If it is unclear what to compare, ask at most one short round of questions first.
Then call list_ready_models and propose_multi_model_plan. Choose models that suit the
question, give each branch a self-contained prompt, and use Fork when a branch needs this
conversation, Fresh otherwise. Do not start the plan: the user starts it from its card.
If you have no propose_multi_model_plan tool here, say so in one sentence.
`;
