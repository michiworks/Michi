import fs from "fs";
import path from "path";
import { plural, sanitizeThreadTitle } from "michi-shared";
import type { AgentSession, ChatMessage, ExtraContext } from "./types";
import { isWithinRoot } from "./tools/pathSandbox";
import { scheduledJobsFeatureEnabled } from "../services/scheduledJobs/feature";
import { skillsAvailable } from "../services/skills/paths";
import { enabledLibrarySkills } from "../services/skills/library";
import { listBuiltinSkills } from "../services/skills/builtin";
import { multiModelToolsEnabled } from "./builtinTools";
import { ARTIFACT_TOOL_NAMES, type ArtifactToolName } from "./artifactToolNames";
import { followUpSentinels, OVERVIEW_CONTENT, OVERVIEW_NO_RESTATE } from "./turnMetadataText";

const TOOL_CAPABILITIES_SECTION = `
Capabilities — you have these tools available and should use them proactively:
- Michi help: \`michi_docs\` — list, search and read bundled product docs on demand for Michi usage, runtime setup, approvals and troubleshooting. Consult relevant docs before guessing. Docs describe this backend build, not live settings or authorization; do not load them for unrelated tasks.{{SKILLS_TOOL}}
- Workspace files: \`read\` (view file contents), \`ls\` (list directory), \`grep\` (search file contents), \`find\` (locate files by pattern). \`write\`, \`edit\`, \`bash\` — modify files or run commands (require user approval).
- Thread graph: \`list_threads\` — see all conversation threads in this workspace. \`search_messages\` — keyword search across workspace messages. \`read_node\` — read a specific node's full transcript. \`read_node_overview\` — read a node's branch overview journal (lightweight). \`read_conversation_updates\` — read newly completed user-initiated turns after a completion cursor; reuse through while paging and consume only complete messages.
- Panes: \`inspect_pane\` — check a pane's (chat/digest/artifact/Agent Run) identity, activity, counts, lineage and a short output preview by paneId/nodeId/runId. \`read_pane_output\` — read that pane's full (paginated) output text. \`list_panes\` — discover panes across the workspace (scope='open' for currently-open views, 'all' for every permitted object plus open surfaces) when you don't already have a paneId/nodeId/runId to inspect. \`wait_pane\` — block up to timeoutMs for a pane to change (until='changed', needs a cursor) or for a specific execution to reach a terminal state (until='terminal', needs executionRef); prefer this over polling inspect_pane in a loop.
- Messaging: \`send_to_thread\` — send a message to another chat thread in this workspace; messages send directly by default and the other thread answers in its own turn. Use it for progress reports, parent/child replies and coordination within the user's task without asking again. Set requestApproval=true only when the user needs to decide or asked to review messages first. For its reply, set wait=true to get it in the result (a bounded wait), or wake=true to have it start a new turn here when it arrives and end your turn meanwhile; otherwise pass the returned waitPaneArgs/readPaneOutputArgs unchanged to \`wait_pane\`/\`read_pane_output\`, or let it reply via \`send_to_thread\`. A result's targetAwaiting means that thread is waiting for the user. Messages you receive that start with "[Thread message]" come from another thread's agent, and "[Thread reply]" is another thread's answer to a message you sent with wake; neither comes from the user.
- Artifacts: \`save_artifact\` — save a named reusable document or register any existing workspace file (referenced as @name). \`update_artifact\` — revise an existing artifact.{{ARTIFACT_TOOLS}}{{SCHEDULING_TOOLS}}
- Branching: \`spawn_branches\` — fan out parallel child threads (only when user explicitly asks to branch/split).{{MULTI_MODEL_TOOLS}}
- Agent Runs: \`list_agents\`, \`spawn_agent\`, \`check_agent\`, \`wait_agent\`, \`send_agent_input\`, \`cancel_agent\`, \`watch_agent_runs\`, and \`update_agent_watch\` supervise durable workers without creating conversation branches. Use bounded \`wait_agent\` calls only; for longer work create a Watch with \`wake\` or \`notify\` and end the turn instead of polling.
- Media: \`show_image\` — display an image inline in the conversation.
- Tasks: \`list_tasks\` reads this workspace's tasks; answer a plain question about them from it, read-only, and when there are none say so and offer to organize them from its conversations. When the user asks you to organize the workspace's tasks, turn its conversations into tasks, or make a task board, first read the Tasks section of the \`pages-and-components\` document with \`michi_docs\` and follow its steps: a task is a goal and never invented; a conversation that reached its goal, even a short answered question, is evidence for a Done task; build the tasks from this workspace's conversations, also when the task database is empty, without stopping to ask.

Use tools proactively when the user's question relates to workspace content, prior conversations, or file-based tasks. If answering requires reading a file or checking thread history, just do it — don't wait to be told.`;

/** Cloud mode keeps no skill library, so only other backends name the tool. */
const SKILLS_TOOL_LINE = `
- Skills: \`michi_skills\` — list the user's Michi skill library and Michi's built-in skills, and read a skill (its SKILL.md instructions and bundled files) when a task matches its description.`;

const SCHEDULING_TOOLS_LINE = `
- Scheduling: \`list_scheduled_jobs\`, \`create_scheduled_job\`, \`update_scheduled_job\`, \`run_scheduled_job\`, \`delete_scheduled_job\` — manage this workspace's scheduled jobs (a prompt Michi sends to an agent on a schedule; each run appears as a thread). Use them when the user asks for something recurring or at a later time. Updating, running now and deleting a job need the user's approval; creating needs it only when the user turned that on in Settings. After creating a job, tell the user what you scheduled. A new job defaults to trust permissions (tools run unattended); choose ask when its prompt may edit files or run commands.`;

/**
 * The artifact tools beyond save/update, each named only in a session that
 * has it (artifactToolsForProfile): chat threads, not Agent Runs or a
 * primary Agent's allow-list.
 */
const ARTIFACT_TOOL_NOTES: Record<ArtifactToolName, string> = {
    list_artifacts: " \`list_artifacts\` — list this workspace's artifacts, pinned first, then most recently updated (filter by type or pinned, page with offset).",
    search_artifacts: " \`search_artifacts\` — find artifacts by keywords in their name, path or link and in the text of document artifacts.",
    delete_artifact: " \`delete_artifact\` — remove an artifact from the workspace's Artifacts, only when the user asks; its file is kept.",
};

/** Absent under the kill switch (MICHI_DISABLE_MULTI_MODEL=1), like the tools themselves. */
const MULTI_MODEL_TOOLS_LINE = `
- Multi-model: \`list_ready_models\` — runtimes and models ready right now. \`propose_multi_model_plan\` — when the user asks for other models' views, propose 1–5 branches (runtime, model, fork or fresh context, a self-contained prompt) and 0–2 review rounds. It only shows a plan card; the user may change models and presses Start, then Michi runs it and wakes this thread with every answer for you to write the synthesis. End your turn after proposing. Branches of a plan cannot propose one.`;

/**
 * The Michi assistant's stand-in for the tool list above: its own tools are
 * described in its opening instructions (assistant/policy.ts). Native and user
 * MCP capabilities are discovered from their actual tool schemas.
 */
const ASSISTANT_CAPABILITIES_SECTION = `
Capabilities — your tools are the Michi assistant's own, described in this conversation's opening instructions.
You also have the selected runtime's native tools and configured MCP tools. Use the available tool schemas and follow the user's permission settings.`;

/**
 * The head of the user's conversation with the agent (V, DESIGN-v2 §2.2):
 * the name the user chose is in no head or instructions (Michi gives it with
 * every message, so a rename keeps the session), and the role is in the
 * opening instructions (services/companion/prompts.ts companionMainInstructions).
 */
const ASSISTANT_PREAMBLE = `You are Michi, the user's own assistant across their workspaces: their conversations, Pages, tasks and scheduled jobs, and the check-ins you make for them. The name the user calls you comes with each of their messages.
Help the user understand their work and keep their pages useful. Ground answers in the page or conversations relevant to their request, and make only the page changes they asked for.
Reply directly in the user's language with concise, natural prose. Let the request determine the answer's shape; do not add routine closing questions or describe internal bookkeeping.
${ASSISTANT_CAPABILITIES_SECTION}`;

/**
 * A check-in's head, instead of V's above: its role, voice and tools are all
 * in its opening instructions (assistant/policy.ts assistantInstructionsFor
 * 'checkin'), and its closed profile has neither the runtime's native tools,
 * MCP servers nor Michi's ask_user tool (DESIGN-v2 §2.3).
 */
const COMPANION_PREAMBLE = `Capabilities — your only tools are Michi's read tools, guarded changes to the user's Pages, tasks, Today and goals inside Michi, and your own tools, described in this conversation's opening instructions. You have no files, commands, web, other MCP servers or tool for asking the user questions.`;

/** Which tool guidance a head carries. */
export type ToolCapabilities = 'michi' | 'crew' | 'assistant' | 'companion' | 'maintenance';

const MAINTENANCE_CAPABILITIES_SECTION = `
Scheduled maintenance mode. Michi state operations and external read-only MCP tools are available through maintenance_list_tools and maintenance_call_tool. Other external tools require saved human approval. When a call needs approval, try permitted alternatives or tell the user to review Tool approvals under Pages upkeep in Michi’s Settings; never claim blocked work completed. Unrestricted delegation is unavailable. Use their schemas to read complete source turns, select eligible Pages or databases from the trusted routing index, and apply verified changes. Do not claim an operation succeeded unless a maintenance tool confirms it.`;

const CREW_CAPABILITIES_SECTION = `
You run inside Kiro Crew, with the tools exposed by the selected Crew agent.
Use the actual tool schemas to discover available filesystem, research and Crew capabilities.
Michi integration uses michi_list_tools to discover this conversation's tool schemas, then
michi_call_tool with {tool, arguments} to invoke them (thread search, panes, messages to
other threads, artifacts, branching{{CREW_MULTI_MODEL}}, Agent Runs, branch overviews and michi_docs for bundled Michi help{{CREW_SKILLS_TOOL}}). Consult relevant docs for Michi usage/setup/problems; they are reference material, not live settings or authorization. If these two tools are absent or refuse the session identity,
Michi MCP is not configured; do not invent calls or substitute a different conversation.
Use Crew's native tools for files and research.
When Crew memory tools are available, use memory_recall for relevant prior decisions and learn_add only
for reusable user corrections or preferences. Memory belongs to the Crew identity bound to this session;
do not select another identity or memory store. Persistent mode permits learning, Incognito reads existing
memory without learning, and Temporary disables memory reads and writes. Conversation history and forked
transcripts are separate from learned memory. Respect the current mode and any tool refusal.`;

const PREAMBLE_TEMPLATE = `You are a knowledge-exploration assistant inside a visual "workspace" app.
The user is diving deep into topics and wants thoughtful, structured answers.

Style:
- Markdown with short #### section headers. Substantive but concise. Let the content choose its own shape — prose for analysis and reasoning, bullets only when listing discrete items.
- Reply in the language of the user's current message, even when notes or earlier messages are in another language.
- Don't invent tool calls for trivia you already know — only when lookup is genuinely needed.
{{TOOL_CAPABILITIES}}

Required final answer metadata:
- In your final answer only, after all tool use and intermediate commentary is complete,
  write the first line before any prose as a single line of the form:
      [TITLE: 4-8 word summary]
  on its own line. The UI strips this line and renders it as the thread title.
{{FOLLOW_UPS_INSTRUCTIONS}}
{{BRANCH_OVERVIEW_INSTRUCTIONS}}
{{METADATA_SCOPE_INSTRUCTIONS}}`;

const BRANCH_OVERVIEW_SENTINEL_INSTRUCTION = `- After the follow-up sentinels, as the very last line of the final answer,
  write one single-line journal entry for this turn in this form:
      [BRANCH-OVERVIEW: ${OVERVIEW_CONTENT}]
  Entries accumulate into a chronological journal of the branch, so cover only
  this turn's contribution; ${OVERVIEW_NO_RESTATE}. Keep it factual and
  useful when read later without the conversation. Match the user's language.
  Use inline Markdown if helpful, but no headings, lists, or closing square bracket.
  The UI strips this line and appends it to the branch's journal in the Branches document.`;

const SENTINEL_METADATA_SCOPE_INSTRUCTION = `- Do not emit [TITLE:], [BRANCH-OVERVIEW:], or [FOLLOW-UP n/3:] sentinel lines in commentary,
  progress/status updates, tool plans, or any message before you are ready to
  deliver the final answer.`;

const HYBRID_METADATA_SCOPE_INSTRUCTION = `- Do not emit [TITLE:] or [FOLLOW-UP n/3:] sentinel lines in commentary,
  progress/status updates, tool plans, or any message before you are ready to
  deliver the final answer. Never emit a [BRANCH-OVERVIEW:] sentinel; the
  runtime supplies the overview through a hidden metadata tool.`;

const STRUCTURED_BRANCH_OVERVIEW_INSTRUCTION = `- Provide this turn's branch-journal entry (what this turn did — explored, decided, discovered)
  through the runtime's structured metadata tool. Entries accumulate into a chronological journal;
  ${OVERVIEW_NO_RESTATE} and do not duplicate the entry in the visible answer.`;

const FOLLOW_UPS_INSTRUCTION = `- Near the end of the final answer, write three lines of the form:
      ${followUpSentinels((n) => `question ${n}`).join("\n      ")}
  STRICT FORMAT RULES (the UI strips these lines and renders clickable buttons,
  so any deviation will leak raw "[FOLLOW-UP …" text into the user's view):
    1. Each sentinel MUST be on its OWN line, with nothing else on that line.
    2. Each sentinel MUST end with a literal closing "]" — do NOT omit it,
       even when the question itself ends with "?" or other punctuation.
    3. The question text MUST NOT contain "]" (or any other "[" / "]" pair).
    4. Emit exactly three sentinels, numbered 1/3, 2/3, 3/3 in that order.
  ✅ Correct:
      [FOLLOW-UP 1/3: How does X relate to Y?]
      [FOLLOW-UP 2/3: What would break if we removed Z?]
      [FOLLOW-UP 3/3: Is there a contrarian read on this?]
  ❌ Wrong (missing "]" — buttons will fail to render):
      [FOLLOW-UP 1/3: How does X relate to Y?
      [FOLLOW-UP 2/3: What would break if we removed Z?
  Content rules — these are FOLLOW-UPS THE USER WOULD ASK YOU NEXT, not
  questions you ask the user. Write them in the user's voice, addressed at
  you. The user is the curious one; you are the one being asked. Match the
  language of the user's last message (if they wrote in Chinese, the
  follow-ups must be in Chinese; same for any other language).

  ❌ NEVER (these are you asking the user — wrong direction):
       [FOLLOW-UP 1/3: Would you like me to expand section 2?]
       [FOLLOW-UP 2/3: Want me to save this as a file?]
       [FOLLOW-UP 3/3: Is there a 5th topic you'd like to add?]

  ✅ ALWAYS (user asking you — correct direction):
       [FOLLOW-UP 1/3: How does X actually relate to Y under the hood?]
       [FOLLOW-UP 2/3: What would break if we removed Z?]
       [FOLLOW-UP 3/3: Is there a contrarian read on this framing?]

  One question should drill deeper into the answer; the other two should come
  at the topic from unexpected or devil's-advocate angles. Never offer to
  perform actions ("save", "expand", "adjust"), never ask about the user's
  preferences or intentions — those belong in normal prose, not follow-ups.

  Perspective check: imagine the user is typing the question into the chat
  box to ask YOU something. "I" = the user, "you" = the assistant. If the
  question sounds like something an assistant would say to a user, flip it.`;

const FOLLOW_UPS_DISABLED = `- Follow-ups are DISABLED for this thread. Do NOT emit [FOLLOW-UP n/3:] or [FOLLOW-UPS:] sentinel lines.`;

/** A client that sends no artifactCount sends its whole artifact list (at most 50): listed under this header as before. */
const CONTEXT_MANIFEST_HEADER = `\nWorkspace context files available (read with your filesystem tools when relevant; the user can also @-mention to inject contents directly):`;

const PINNED_ARTIFACTS_HEADER = `\nPinned workspace artifacts (read with your filesystem tools when relevant; the user can also @-mention an artifact to inject its contents directly):`;

/**
 * How the agent finds the artifacts the manifest does not name, with the
 * lookup tools it has; null when it has neither (artifactToolsForProfile).
 */
function artifactLookup(artifactTools: readonly ArtifactToolName[]): string | null {
    const ways = [
        ...(artifactTools.includes("list_artifacts") ? ["`list_artifacts` to browse them"] : []),
        ...(artifactTools.includes("search_artifacts") ? ["`search_artifacts` to find one by keyword"] : []),
    ];
    return ways.length > 0 ? `use ${ways.join(" and ")}; reference any of them as @name` : null;
}

/**
 * The first turn's artifact manifest. With artifactCount (the workspace's
 * total) the entries are its pinned artifacts: they are listed, and one line
 * gives the total and how to find the rest with the lookup tools the session
 * has (never a tool it lacks); with no artifacts at all there is nothing to
 * say. Without it the entries are listed as they were sent: a legacy
 * client's list, or the one ensure-session builds for a session without the
 * lookup tools (artifactTools.workspaceArtifactManifest).
 */
function renderArtifactManifest(
    entries: readonly ExtraContext[],
    artifactCount: number | undefined,
    artifactTools: readonly ArtifactToolName[],
): string | null {
    // Link artifacts have `url` and no filePath; list them by URL so the
    // manifest never prints "— undefined".
    const lines = entries.map((m) => `- ${m.name} — ${m.url ? m.url : m.filePath}`).join("\n");
    if (artifactCount === undefined) return entries.length > 0 ? `${CONTEXT_MANIFEST_HEADER}\n${lines}\n` : null;
    const total = Math.max(artifactCount, entries.length);
    if (total === 0) return null;
    const count = plural(total, "artifact");
    const lookup = artifactLookup(artifactTools);
    if (entries.length === 0) {
        return lookup
            ? `\nThis workspace has ${count}, none pinned: ${lookup}.\n`
            : `\nThis workspace has ${count}, none pinned; the user can @-mention one to share its contents.\n`;
    }
    return lookup
        ? `${PINNED_ARTIFACTS_HEADER}\n${lines}\nThis workspace has ${count} in total; ${lookup}.\n`
        : `${PINNED_ARTIFACTS_HEADER}\n${lines}\nThis workspace has ${count} in total; only the pinned ones are listed here.\n`;
}

const USER_SPEAK_TAIL = `\nThe user will now speak.\n`;

// After this many user turns, start reminding the model to produce follow-ups.
const FOLLOW_UPS_REMIND_AFTER_TURNS = 2;
// Repeat the reminder every N turns after the initial trigger.
const FOLLOW_UPS_REMIND_INTERVAL = 1;

const FOLLOW_UPS_REMINDER = `\n\n[Reminder: end with ${followUpSentinels(() => "...").join(", ")} — three user-voice questions on separate lines, each ending with "]". Then, as the very last line, include one [BRANCH-OVERVIEW: ...] line — 1-3 sentences on what this turn did or concluded (it appends to the branch's journal; ${OVERVIEW_NO_RESTATE}).]`;

/**
 * Returns a short reminder suffix when the conversation is long enough that
 * the model may have lost attention on the system-prompt follow-up instructions.
 * Returns empty string when no reminder is needed.
 */
export function followUpReminder(userTurnCount: number, enableFollowUps: boolean): string {
    if (!enableFollowUps) return "";
    if (userTurnCount < FOLLOW_UPS_REMIND_AFTER_TURNS) return "";
    const turnsSinceThreshold = userTurnCount - FOLLOW_UPS_REMIND_AFTER_TURNS;
    if (turnsSinceThreshold % FOLLOW_UPS_REMIND_INTERVAL === 0) return FOLLOW_UPS_REMINDER;
    return "";
}

/**
 * Ends a turn that runs a skill, in place of the per-turn reminders of
 * Michi's reply format (PromptPolicyPort.skillTurnNote): the skill's own
 * instructions decide that reply.
 */
export const SKILL_TURN_NOTE = "\n\n[This turn runs a skill the user chose: follow the skill's instructions for what to output and which tools to use. Michi's reply metadata does not apply to this turn: write no title or follow-up lines, and call neither set_branch_overview nor set_follow_ups.]";

/**
 * Short restatement of the [TITLE:] / [FOLLOW-UP n/3:] sentinel rules, glued
 * onto the first user message as belt-and-suspenders for weaker providers
 * (DeepSeek etc.) whose instruction-following drifts when format guidance
 * only lives in the system prompt — Claude/Anthropic don't need this because
 * --append-system-prompt rides on top of Anthropic's own conditioning.
 */
export function buildFormatReminder(enableFollowUps: boolean): string {
    if (!enableFollowUps) {
        return `(Format reminder, restated from system instructions — do not skip in this reply.)
- FIRST line of your reply MUST be: [TITLE: 4-8 word summary]
- Do NOT emit any [FOLLOW-UP n/3:] or [FOLLOW-UPS:] lines.`;
    }
    return `(Format reminder, restated from system instructions — do not skip in this reply.)
- FIRST line MUST be: [TITLE: 4-8 word summary]
- Near the end of your reply, emit these three sentinels, each on its OWN line:
    ${followUpSentinels((n) => `question ${n}`).join("\n    ")}
- Every sentinel MUST start with the literal "[" and the literal text "FOLLOW-UP", and MUST end with the literal "]". Never abbreviate to "UP 2/3:" or drop the opening "[" / closing "]" — the UI parses lines verbatim and any deviation leaks raw text into the user's view.`;
}

export type MetadataOutputMode =
    | 'sentinel'
    | 'sentinel-followups-tool-overview';

function renderHead(
    enableFollowUps: boolean,
    metadataOutputMode: MetadataOutputMode = 'sentinel',
    toolCapabilities: ToolCapabilities = 'michi',
    artifactTools: readonly ArtifactToolName[] = ARTIFACT_TOOL_NAMES,
): string {
    if (toolCapabilities === 'maintenance') return `You are processing a server-owned Pages maintenance batch.\n${MAINTENANCE_CAPABILITIES_SECTION}`;
    if (toolCapabilities === 'assistant') return ASSISTANT_PREAMBLE;
    if (toolCapabilities === 'companion') return COMPANION_PREAMBLE;
    const toolOverview = metadataOutputMode !== 'sentinel';
    const branchOverviewLine = toolOverview
        ? STRUCTURED_BRANCH_OVERVIEW_INSTRUCTION
        : BRANCH_OVERVIEW_SENTINEL_INSTRUCTION;
    const metadataScopeLine = toolOverview
        ? HYBRID_METADATA_SCOPE_INSTRUCTION
        : SENTINEL_METADATA_SCOPE_INSTRUCTION;
    const followUpsLine = enableFollowUps ? FOLLOW_UPS_INSTRUCTION : FOLLOW_UPS_DISABLED;
    return PREAMBLE_TEMPLATE
        .replace("{{TOOL_CAPABILITIES}}", toolCapabilities === 'crew'
            ? CREW_CAPABILITIES_SECTION
                .replace("{{CREW_MULTI_MODEL}}", multiModelToolsEnabled() ? ", multi-model plans" : "")
                .replace("{{CREW_SKILLS_TOOL}}", skillsAvailable() ? "; michi_skills reads the user's skill library and Michi's built-in skills" : "")
            : TOOL_CAPABILITIES_SECTION
                .replace("{{SKILLS_TOOL}}", skillsAvailable() ? SKILLS_TOOL_LINE : "")
                .replace("{{ARTIFACT_TOOLS}}", ARTIFACT_TOOL_NAMES.filter((name) => artifactTools.includes(name)).map((name) => ARTIFACT_TOOL_NOTES[name]).join(""))
                .replace("{{SCHEDULING_TOOLS}}", scheduledJobsFeatureEnabled() ? SCHEDULING_TOOLS_LINE : "")
                .replace("{{MULTI_MODEL_TOOLS}}", multiModelToolsEnabled() ? MULTI_MODEL_TOOLS_LINE : ""))
        .replace("{{BRANCH_OVERVIEW_INSTRUCTIONS}}", branchOverviewLine)
        .replace("{{METADATA_SCOPE_INSTRUCTIONS}}", metadataScopeLine)
        .replace("{{FOLLOW_UPS_INSTRUCTIONS}}", followUpsLine);
}

/**
 * Stable system prompt — fed to claude via `--append-system-prompt` at spawn time.
 *
 * MUST be pure for a given metadata mode so warm-pool entries share
 * byte-identical spawn args (otherwise the pool key `(cwd, model)` is not
 * well-defined). The mode is process-wide for the native runtime experiment.
 * `artifactTools` names the artifact tools the session has beyond
 * save/update (artifactToolsForProfile); all of them by default, as a
 * warm-pool chat has.
 */
export function buildStableSystemPrompt(
    metadataOutputMode: MetadataOutputMode = 'sentinel',
    enableFollowUps: boolean = true,
    nativeAskUser: boolean = false,
    toolCapabilities: ToolCapabilities = 'michi',
    artifactTools: readonly ArtifactToolName[] = ARTIFACT_TOOL_NAMES,
): string {
    const head = buildMetadataSystemPrompt(metadataOutputMode, enableFollowUps, toolCapabilities, artifactTools);
    // The Companion has no ask_user tool: its follow-ups are its [FOLLOW-UPS: …] line.
    if (toolCapabilities === 'companion') return head;
    return head + (nativeAskUser
        ? '\n\nUse AskUserQuestion or the Michi ask_user tool for structured questions; both are connected to the user interface.'
        : ASK_USER_INSTRUCTION);
}

/** Stable metadata-only prompt for runtimes whose custom-agent layer cannot
 * use Michi's structured ask_user tool.
 *
 * `enableFollowUps` defaults to true so existing warm-pool callers (Claude)
 * keep byte-identical spawn args; runtimes without a warm pool (Codex) may
 * pass false to honor opts.enableFollowUps in the developer instructions. */
export function buildMetadataSystemPrompt(
    metadataOutputMode: MetadataOutputMode = 'sentinel',
    enableFollowUps: boolean = true,
    toolCapabilities: ToolCapabilities = 'michi',
    artifactTools: readonly ArtifactToolName[] = ARTIFACT_TOOL_NAMES,
): string {
    return renderHead(enableFollowUps, metadataOutputMode, toolCapabilities, artifactTools);
}

const ASK_USER_INSTRUCTION = `

Tool override — AskUserQuestion:
Do NOT use the built-in AskUserQuestion tool. It does not work in this environment.
Instead, use the MCP tool ____michi_internal____ask_user to ask the user structured
questions with selectable options. The schema is identical: questions[] with question,
header, options[{label, description}], and multiSelect. The tool blocks until the user
responds in the UI.`;


export interface FirstTurnPrefixInput {
    cwd: string;
    /** Additional registered folders for this workspace (multi-folder support).
     *  When provided and non-empty, injected as an allowlist into the prefix so
     *  the agent knows it can access files across multiple directories. */
    folders?: Array<{ path: string; label?: string }>;
    /** With artifactCount: the workspace's pinned artifacts. Without: the whole list (at most 50). */
    contextManifest?: ExtraContext[];
    /** How many artifacts the workspace has in all; see renderArtifactManifest. */
    artifactCount?: number;
    /**
     * The artifact tools the session has beyond save/update
     * (artifactToolsForProfile); all of them when absent. The head names
     * them, and the manifest points only to the lookup tools among them.
     */
    artifactTools?: readonly ArtifactToolName[];
    extraContexts?: ExtraContext[];
    /** Oldest-first ancestor chain. Each entry exposes its history + pendingAssistant. */
    ancestors?: AgentSession[];
    mergeContexts?: string[];
    /** Per-workspace system-prompt addendum (Manage page → Instructions). Empty
     *  / undefined when the user hasn't set one. We inject via the first-turn
     *  prefix instead of `--append-system-prompt` so the Claude warm pool key
     *  (cwd, model) stays well-defined. */
    workspaceInstructions?: string | null;
    /** Parent chat whose native history this session copied (a native fork). */
    nativeForkParentNodeId?: string;
    /** That parent's title; the host resolves it. */
    nativeForkParentTitle?: string | null;
    /**
     * Set by a runtime for an ordinary chat that has michi_skills: whether
     * the session lists the library's skills itself (a mount). The prefix
     * then names the skills it may load that it does not list.
     */
    hostSkills?: { librarySkillsLoaded: boolean };
}

/**
 * Variable per-chat preamble — prepended to the first real user message by
 * ClaudeSession.send (after the warm-init `shouldQuery:false` dummy).
 *
 * Returns the empty string when there is nothing variable to inject. Does NOT
 * include the stable head or the "user will now speak" tail; that's
 * buildPreamble's job for the Pi/Kiro legacy callers.
 */
export function buildFirstTurnPrefix(input: FirstTurnPrefixInput): string {
    const parts: string[] = [];

    if (input.workspaceInstructions) {
        const trimmed = input.workspaceInstructions.trim();
        if (trimmed.length > 0) {
            parts.push(
                `Workspace instructions (these apply to every reply in this conversation — treat as if part of the system prompt):\n\n${trimmed}\n`,
            );
        }
    }

    // Multi-folder awareness: tell the agent about all registered directories
    if (input.folders && input.folders.length > 1) {
        const lines = input.folders.map((f, i) => {
            const label = f.label ? ` (${f.label})` : '';
            const marker = i === 0 ? ' (working directory)' : '';
            return `- ${f.path}${label}${marker}`;
        }).join('\n');
        parts.push(
            `Available source directories for this workspace:\n${lines}\nYou may read, write, and search files in any of these directories.\n`,
        );
    }

    const manifest = renderArtifactManifest(input.contextManifest ?? [], input.artifactCount, input.artifactTools ?? ARTIFACT_TOOL_NAMES);
    if (manifest) parts.push(manifest);

    if (input.extraContexts && input.extraContexts.length > 0) {
        parts.push(renderExtraContexts(input.extraContexts, input.cwd));
    }

    const ancestors = input.ancestors ?? [];
    if (ancestors.length > 0) {
        const rendered = renderAncestors(ancestors);
        if (rendered) parts.push(rendered);
    }

    if (input.mergeContexts && input.mergeContexts.length > 0) {
        parts.push(`\nContext from previous explorations this user wants to synthesize:\n\n${input.mergeContexts.join("\n\n")}\n\nThe user is now opening a new branch to synthesize across these threads.`);
    }

    if (input.nativeForkParentNodeId) {
        parts.push(renderNativeForkNotice(input.nativeForkParentNodeId, input.nativeForkParentTitle));
    }

    if (input.hostSkills) {
        const catalog = renderSkillCatalog(input.hostSkills.librarySkillsLoaded);
        if (catalog) parts.push(catalog);
    }

    return parts.join("\n").trimEnd();
}

const SKILL_CATALOG_DESCRIPTION_MAX = 250;
const SKILL_CATALOG_MAX = 6000;

/**
 * The skills a chat may load with michi_skills, by name and description, as
 * Agent Skills hosts list them up front (the body is read when a task fits).
 * Library skills its runtime lists itself are left out. Skills the user
 * keeps to / are not named.
 */
function renderSkillCatalog(librarySkillsLoaded: boolean): string {
    if (!skillsAvailable()) return "";
    const library = enabledLibrarySkills();
    const libraryNames = new Set(library.map((skill) => skill.name));
    const entries = [
        ...(librarySkillsLoaded ? [] : library.filter((skill) => skill.modelInvocable).map((skill) => ({ label: skill.name, description: skill.description }))),
        ...listBuiltinSkills().filter((skill) => skill.enabled && skill.modelInvocable).map((skill) => ({
            label: `${skill.name} (built-in${libraryNames.has(skill.name) ? "; read it with builtin: true" : ""})`,
            description: skill.description,
        })),
    ];
    if (entries.length === 0) return "";
    const lines: string[] = [];
    let size = 0;
    for (const entry of entries) {
        const text = entry.description.length > SKILL_CATALOG_DESCRIPTION_MAX
            ? `${entry.description.slice(0, SKILL_CATALOG_DESCRIPTION_MAX - 1)}…` : entry.description;
        const line = `- ${entry.label}: ${text}`;
        if (size + line.length > SKILL_CATALOG_MAX) break;
        lines.push(line);
        size += line.length + 1;
    }
    const more = entries.length - lines.length;
    return `\nSkills you can load with michi_skills (action=read) when a task matches one:\n${lines.join("\n")}`
        + (more > 0 ? `\n(${more} more: michi_skills action=list)` : "");
}

/**
 * A native fork copies the parent's turns into the child's own runtime
 * history, where nothing marks them as another thread's: without this the
 * child takes itself for the parent.
 */
function renderNativeForkNotice(parentNodeId: string, parentTitle?: string | null): string {
    return `\nThis conversation is a branch of the thread "${sanitizeThreadTitle(parentTitle)}" (node ${parentNodeId}) in the same conversation tree: `
        + "the history above is that thread's, copied when the user branched, and the parent thread has continued on its own since.";
}

function renderExtraContexts(ctxs: ExtraContext[], cwd: string): string {
    const blocks = ctxs.map((ctx) => {
        // Link artifact: url-only, no file to read. The agent is NOT told to
        // fetch it — it reads the URL only if its own tools happen to reach it
        // (e.g. an internal-docs tool). The bare marker keeps that honest.
        if (ctx.url) {
            return `### @${ctx.name}\n\n[Link: ${ctx.url}]`;
        }
        if (ctx.kind === "reference" || ctx.kind === "symlink") {
            // reference = absolute external path; symlink = a cwd-relative path
            // under .artifacts/ that resolves through a symlink to an external
            // file. Both are read live by the agent's own filesystem tools
            // (which follow symlinks) rather than embedded as a stale snapshot.
            return `### @${ctx.name}\n\n[Referenced file at: ${ctx.filePath}]`;
        }
        let content: string;
        try {
            const resolved = path.resolve(cwd, ctx.filePath);
            if (!isWithinRoot(resolved, cwd)) {
                content = `[access denied: ${ctx.filePath}]`;
            } else {
                const stat = fs.statSync(resolved);
                content = stat.isFile()
                    ? fs.readFileSync(resolved, "utf-8")
                    : `[not a file: ${ctx.filePath}]`;
            }
        } catch {
            content = `[file not found: ${ctx.filePath}]`;
        }
        return `### @${ctx.name}\n\n${content}`;
    }).join("\n\n---\n\n");
    return `\nReference context the user has pinned for this conversation:\n\n${blocks}\n`;
}

function renderAncestors(ancestors: AgentSession[]): string {
    const sections: string[] = [];
    for (let i = 0; i < ancestors.length; i++) {
        const a = ancestors[i];
        const isImmediate = i === ancestors.length - 1;
        const lines: string[] = a.getHistory().map(
            (m: ChatMessage) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`,
        );
        if (isImmediate) {
            const partial = a.getPendingAssistant();
            if (partial && partial.trim().length > 0) {
                lines.push(`Assistant (in progress): ${partial}`);
            }
        }
        if (lines.length === 0) continue;
        const label =
            ancestors.length === 1 ? "Parent thread"
                : i === 0 ? `Thread ${i + 1} (root)`
                : isImmediate ? `Thread ${i + 1} (immediate parent)`
                : `Thread ${i + 1}`;
        sections.push(`--- ${label} ---\n\n${lines.join("\n\n")}`);
    }
    if (sections.length === 0) return "";
    return `\nPrevious conversation chain leading to this branch (oldest first, for context only — do not repeat back):\n\n${sections.join("\n\n")}\n\nThe user is now drilling down from that chain.`;
}

// Michi Memory reaches the model only as a per-turn, model-only block
// (AgentTurnInput.memoryContext: services/memory/contextBuilder.ts, sent by
// agents/memoryInjection.ts), never through the stable system prompt or the
// first-turn prefix, so warm-pool spawn args stay byte-identical.

export interface PreambleInput extends FirstTurnPrefixInput {
    enableFollowUps: boolean;
    toolCapabilities?: ToolCapabilities;
}

/**
 * Backward-compat composition for Pi/Kiro callers that glue the entire
 * preamble onto the first user turn as a wholesale wrapper.
 *
 * Claude runtime does NOT use this directly — it spawns with
 * buildStableSystemPrompt() as `--append-system-prompt` and prepends
 * buildFirstTurnPrefix() to the first real user message.
 */
export function buildPreamble(input: PreambleInput): string {
    const head = renderHead(input.enableFollowUps, 'sentinel', input.toolCapabilities, input.artifactTools);
    const variable = buildFirstTurnPrefix(input);
    return variable
        ? `${head}\n${variable}${USER_SPEAK_TAIL}`
        : `${head}${USER_SPEAK_TAIL}`;
}
