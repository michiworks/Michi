# Understand workspaces, branches and context

Applies to: ordinary Michi chats across registered runtimes; Custom Agent Run exceptions are noted under the agent-context and branch sections. Source checked: 2026-11-08. Native memory and context limits depend on the runtime/version.

## What belongs where?

| Term | Meaning | Example |
| --- | --- | --- |
| Backend | Machine/process storing state and running tools | Desktop backend or remote Linux server |
| Workspace | Project with a backend association and working folder | A repository or research directory |
| Thread / tree | Root conversation and its branches | Research into a product decision |
| Chat / node | Conversation at one point in a tree | A branch comparing two designs |
| Pane | View of a chat, file/Artifact, diff, review, terminal, browser, Page, Agent Run or workflow run | Two investigations side by side |
| Map | Navigation through the active tree | Finding where a branch began |
| Overview | Branch journal of recorded progress | Catching up before reading the transcript |
| Digest | Synthesis connected to selected conversation sources | A research comparison |
| Artifact | Reusable material registered in the workspace | Requirements or a report |
| Page | A native, revisioned document with blocks and optional database references | A workspace home, research summary or child page |
| Pages Assistant / Pages upkeep | Assistant conversation for organizing Michi work, plus background generation and maintenance with restricted tools | Summarizing a page or maintaining it from completed conversations |

A workspace can contain several trees. Switching trees changes your view; it does not combine every conversation into one agent context. Closing a chat pane does not delete its history or cancel its running turn. Closing a terminal pane ends its shell process, and closing a browser pane closes that browser view.

## What does an agent see?

An agent receives the request, applicable instructions, session context and supplied references. Michi advertises available Artifacts and provides retrieval tools; the agent does not automatically read every file or every chat.

| Material | How to use it | Boundary |
| --- | --- | --- |
| Current conversation | Continue the same chat | Finite context window; compaction/reconstruction changes its representation |
| Another chat | Mention the node, or ask the agent to find and read it | A reference may contain a summary rather than the full transcript |
| Artifact | Mention its name with `@`, or request a read | Shelf presence is not full-content injection |
| Project file | Supply its path and request relevant sections | Must exist on the selected backend and be accessible |
| Workspace instructions | Use workspace Instructions for standing guidance | Native runtime instruction files can add rules |
| Michi Memory | Tell the agent, or ask it to remember something; review it in Settings › Memory | Notes reach ordinary chats as data, not instructions; separate from transcripts and Crew Memory |
| Crew Memory | Choose the default in the Crew **Memory** selector (Settings › Runtime & model, shown when Crew is the runtime) before creating a Crew chat | Separate from transcripts, Artifacts, workspace instructions and Michi Memory |
| Product documentation | Ask the agent to consult `michi_docs` | Reference, not live settings inspection |

Current node references inline short conversations; longer conversations use a summary and retrieval hint. If a detail matters, ask: “Read the original messages in that referenced chat and cite the relevant passage.” Available tools include `search_messages`, `read_node` and `read_node_overview`.

Artifact favorites/pins affect UI ordering. The send path injects explicit `@` references, not all favorites. The Artifact manifest in a chat's first message names the pinned Artifacts' names/locations, not their full contents, and gives how many Artifacts the workspace has; the agent finds the others with `list_artifacts` and `search_artifacts`.

Custom Agent Runs receive no Michi Memory and have no memory tools; see `custom-agents`.

## Pages, preferences and scope

Native Pages use Michi SQLite records rather than project Markdown files or an external Desk service. A Page can show native blocks, database views and versioned components. Pages Home summarizes workspace homes; its automatic summary does not independently read every original conversation. The current Pages interface is local-only.

Each page has independent **Layout preferences** and layout rules. Preferences guide future organization; they do not grant permissions, trigger a model on save or replace program-applied section limits. A page’s content and Sources remain evidence to read, not higher-priority instructions. The Pages Assistant’s conversation history is distinct from ordinary workspace chats; initial generation and automatic maintenance also have their own restricted processing paths. See `pages-and-components` and `pages-maintenance`.

## What does a branch inherit?

A branch starts a separate direction using selected conversation context. Compatible idle parents can use native fork where supported; otherwise Michi reconstructs the parent transcript only through the selected branch point as textual context. Later parent messages do not automatically synchronize into an existing child.

Inherited context does not guarantee identical hidden provider state. Native Resume and Native Fork are independent. See `sessions-and-recovery` and `runtime-capabilities`.

Conversation branches do not automatically create Git branches or worktrees. Two agents editing the same folder can overlap. For isolated implementation, create separate Git worktrees and point separate workspaces at them; specify each agent's directory. A write-capable Agent Run with the automatic execution environment works in its own Git worktree; inspect the Run's environment before relying on isolation (see `custom-agents`).

## Bring findings together

Use a reference when one chat needs another's material. Use Weave for a conversation based on selected chats. Use Digest for a source-connected synthesis with stale-source awareness. Use an Artifact for a document you want to reuse beyond the conversational flow.

These operations do not merge Git changes or resolve code conflicts. A digest is a synthesis, not an exact transcript. Inspect its sources or request original passages when wording/evidence matters.

## History, context and Memory

Michi history is the durable record. Model context is the material used for a particular request. Compaction summarizes model context; it is not a full-history export. Michi Memory and Crew Memory are separate long-term facilities; neither is the chat history.

Michi Memory works the same with every runtime, the way ChatGPT, Claude and Gemini memory works. Each chat turn carries, as data rather than instructions and with the current date and time, the notes the user saved, Michi's profile of the user ("About the user"), the preferences and conventions Michi noted, what the user typed in their most recent other conversations ("Recent conversations": their own words, newest first, from this and every other workspace AI navigation may read, each named by its workspace; never a conversation in Trash, set to Use only or Off, nor a turn that read web pages or tool output) and the notes and past-conversation excerpts related to the message. Each note says whether the user saved it, Michi noted it, or it came from another tool's memory; what is shown of other conversations leaves out credentials such as API keys and card numbers. Agents search memories and past conversations with `memory_search` (current notes, earlier versions on request, the user's other workspaces when nothing is found in this one) and save, correct or forget notes with `memory_save`, `memory_update` and `memory_delete`. The model decides what to keep, and Michi also keeps durable things the user says by itself, in the background. Notes about the user themself apply in every workspace; what the user asked Michi to remember is pinned in every later conversation. Forgetting a note (`memory_delete`, or a delete in Settings → Memory or under a reply) deletes it with its earlier versions, and the background pass never saves it again from where it came from; a past conversation's `c:` ref keeps that turn out of the background pass. Conversations are chat history and stay as they are, as in ChatGPT and Claude, until the conversation is deleted. A removed note is not saved again silently: `memory_save` says when it was removed and saves it again only when the user asks for it again in that conversation. Under a reply Michi may show the memories and past chats it repeated, where the user can forget a memory or stop Michi recalling that part of a chat (Don't recall); the list can miss items. Deleting a conversation does not delete the memories learned from it. The user reviews, edits or deletes memories, deletes all of them, or turns Memory off, in Settings → Memory.

The background pass reads a conversation once it has been quiet for 30 minutes, once 20 of its turns wait, or as soon as the user left it, and after a restart what waited before it. It reads the whole new part at once; saves nothing from what the user asked not to remember or took back, also when the decline comes later (and then forgets what Michi had noted of it on its own); reads a conversation again when the user came back and typed in it while it was being read; and keeps a request to remember that the agent missed as the user's own. Where the Pages upkeep runtime has a direct structured call (Claude, Codex, Pi), that is one small-model call per conversation with no tools and nothing persisted; otherwise a short maintenance session. `MICHI_MEMORY_MODEL` names the model of the direct call (default: Pages upkeep's own model choice, else the runtime's cheap model), and `MICHI_MEMORY_DIRECT=0` uses the maintenance session instead. The same pass rebuilds the profile of the user after five changed notes, or a day after any change; Settings → Memory shows its lines with the notes each cites, rebuilds it on request, and removes a line by deleting the notes it cites. Michi also tidies its own notes in the background: a note that repeats another or that a newer note replaced is put away (`memory_search` with history finds it, marked superseded); notes the user saved, imported or edited are never changed.

Each conversation has its own memory setting: Learn (the default), Use only (memory is read and searched, but nothing said in the conversation is indexed, extracted or saved) or Off (a temporary chat: neither memory nor other conversations are read, its thread and pane tools see only the conversation itself, and nothing said in it goes into memory). In both, the agent keeps nothing said there in a file, artifact or page either unless the user explicitly asks for one, and the memory tools tell an agent that tries to save that nothing said there goes into memory. Leaving Learn hides the conversation's turns from recall and removes the notes Michi learned from it on its own; the user's own saved notes stay. Coming back to Learn starts after what was said meanwhile.

Michi Memory is the one memory store. In the sessions Michi starts, Claude Code's auto memory and Codex memories are off; CLAUDE.md, AGENTS.md and rules load as before. What Claude Code, Codex and Kiro remembered in their own files (Claude Code's for the folders of the user's workspaces) is imported into Michi Memory one way, marked with the runtime it came from, and followed as those files change; one deleted or edited in Michi stays as Michi has it. Kiro's own memory exists only with its KAS engine and follows Kiro's `memory.mode` setting, which Michi leaves as the user set it. `MICHI_MEMORY_IMPORT=0` turns the import off.

Crew Memory is set with the Crew **Memory** selector in Settings › Runtime & model and is also governed by Crew's upstream policies. It offers Read & learn, Read only and Off; new chats default to Read only, so Crew recalls what it already knows while Michi Memory learns from Michi's chats. The default affects new chats; established chats keep their mode and native forks keep the parent's. Off does not delete transcripts or necessarily erase memories Crew already stored.

Put workspace-wide rules in workspace Instructions, personal preferences or conventions you want agents to remember in Michi Memory, variable goals in the current request, and reusable material in Artifacts. Retrieve details as needed. Moving a long prompt to the system role alone does not guarantee lower latency.

## Why did it forget?

1. Identify the source: this chat, another branch, an Artifact, a file, Michi Memory (check Settings › Memory and the conversation's memory setting) or a runtime's native memory.
2. Reference it explicitly and ask for the relevant original section.
3. Ask the agent to state the facts and sources before continuing.
4. If the source changed, read the current file or rebuild its synthesis.

Success check: the answer cites the actual source and incorporates the missing detail. Otherwise inspect tool availability and backend/path selection instead of repeatedly lengthening the prompt.

Related documents: `files-and-artifacts`, `common-workflows`, `sessions-and-recovery`, `custom-agents`, `crew`.
