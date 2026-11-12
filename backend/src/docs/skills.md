# Skills: the Michi skill library and runtime skills

Applies to: local desktop/web and self-hosted remote backends. Source checked: 2026-11-08. Hosted multi-user deployments (`MICHI_CLOUD=1`) keep no skill library and list no runtime skills. How each runtime loads library skills depends on that runtime's version; the table below states Michi's integration, not a real-provider acceptance test.

## What a skill is

A skill is a folder with a `SKILL.md` file in the Agent Skills format: YAML frontmatter that names and describes it, then instructions for the agent. The folder may also hold scripts and reference files the instructions mention by relative path.

| Frontmatter | Meaning |
| --- | --- |
| `name` | Library skills: 1-64 lowercase letters, digits and single inner hyphens, equal to the folder name; Michi lists a skill by its folder name |
| `description` | Required for library skills, at most 1024 characters; agents decide from it when a skill fits |
| `argument-hint` | Shown with the skill in the / menu's side panel (not on touch screens) |
| `user-invocable: false` | Only the agent may load it; it is not offered in the / menu |
| `disable-model-invocation: true` | Only you run it with /: agents are not offered it |

`$ARGUMENTS` in the body stands for what you type after the command.

## Where the library lives

| Path | Holds |
| --- | --- |
| `<config dir>/skills/<name>/SKILL.md` | The library: one folder per skill. Default `~/.michi/skills`; `~/.michi-dev/skills` for development launchers; `MICHI_CONFIG_DIR` moves it |
| `<config dir>/skills-state.json` | Which library skills are turned off |
| `<data dir>/skill-mounts/` | Links Michi generates for the runtimes. Michi re-links them as the library changes; never edit them |

Each backend has its own library: a remote backend keeps its own, on that server. You may also manage the folder by hand, for example by linking a skill folder in. Michi lists folders with a valid name and a readable `SKILL.md` of at most 256 KiB, and Settings › Skills reports the folders it skips. If `skills-state.json` cannot be read, no runtime gets library skills until it can; Settings › Skills says why.

## How each runtime gets library skills

In ordinary chats every runtime gets every library skill that is on. Michi never writes into a runtime's own folders (`~/.claude`, `~/.codex`, `~/.kiro`, `~/.agents`, `~/.gemini`): it links the library into a mount and passes that mount to the runtime's sessions where the runtime can load one, and every runtime's agent in an ordinary chat also has the `michi_skills` tool, which lists the library and reads a skill's files. An Agent Run has `michi_skills` only when its worker's tools include it; the Michi assistant has no library.

| Runtime | Library skills reach it as | `/name` in the composer runs as |
| --- | --- | --- |
| Claude | An additional folder of each Claude session: skills keep their names, and one whose name a personal or project skill already uses is `michi:<name>` inside Claude. A skill named like one of your own commands (`commands/<name>.md` in Claude's config folder, `~/.claude` by default) is left out, so the command keeps its name. Sessions that skip Claude's settings (bare mode, Agent Runs) can read the library only through the `michi_skills` tool; an Agent Run has it only when its worker's tools include it | Claude's own command; where the session has not loaded the skill, Michi puts the skill into the message |
| Codex | An extra skill root of Michi's Codex app-server | A Codex skill input |
| Kiro | V3 (the default engine): an additional folder of each chat session. V2: the `michi_skills` tool | Michi puts the skill into the message |
| Pi | Skill paths of the Pi session | Michi puts the skill into the message |
| Crew, Antigravity | The `michi_skills` tool | Michi puts the skill into the message |

Codex and Kiro offer everything in their mount to their model, so their mounts leave out `disable-model-invocation: true` skills; `/name` still runs such a skill. The skill folders in a mount are links to the library folders: whatever an agent writes into one changes the library skill itself.

In Claude, a library skill whose name a personal or project skill also uses still runs from the composer as `/name`, but when Claude's model picks a skill itself it prefers the personal or project one. A library skill hides a project command of its name (`.claude/commands/<name>.md` in the chat's folder): inside Claude that name runs the library skill. Picking the command's row (labelled Claude) in the / menu still runs the command, because Michi puts the command's text into the message.

## Runtime skills

Skills a runtime finds itself (Claude's personal, project and plugin skills, Codex's user, repo and system skills, Kiro's global and workspace skills, …) are listed per workspace folder, because project skills depend on it. A workspace without a folder, such as the default Chats, lists the folder its chats run in: the backend's working folder. They are read-only in Michi: open one to read its instructions and files, and edit it where it lives. A runtime that is not installed is skipped; a runtime whose listing fails shows the reason in its group while the others still list.

Michi reads a runtime's listing again when it is more than about 30 seconds old, showing the last one meanwhile. Codex keeps its own listing until it reports a change, and a new personal or repo skill may need the ↻ button (**Check the runtimes for new skills**) before it appears.

## Run a skill from the composer

1. Type `/`. Commands come first, then skills; the highlighted row's description and argument hint show beside the menu (on touch screens each row shows its description under its name, without the hint).
2. Pick a row to run exactly that one. When a command and a skill share a name, both are listed and the skill's row says **Skill**; when two skills share it, each skill's row names its source (**Michi** or the runtime). If you type the name without picking, the command runs; between a library skill and a runtime skill of the same name, the library skill runs.
3. The text after the name is the skill's arguments.
4. A skill turn follows the skill's instructions for its output, so Michi does not ask that reply for a title, follow-up questions or a branch overview.
5. Library changes reach new chats at once; a running chat may keep the skills it loaded when it started.

Before a chat's session starts, the / menu offers the commands its runtime can run; once the session lists its own, the menu follows that list. A new Kiro V3 chat therefore offers every command Michi's Kiro command interface knows, and a kiro-cli without the matching extension answers that the command is not supported. The / menu leaves out library skills that are off and `user-invocable: false` skills. A `/word` that is neither a command nor a skill is sent as an ordinary message. The message keeps a mark of the skill it ran, and Retry runs that skill again; if that skill is gone, the message says so instead. The Michi assistant (its ⌘J / Ctrl+J panel or pane, and its windows in Pages and Scheduled) offers commands but no skills, and in cloud mode the / menu lists Michi's and the runtime's commands but no skills.

## Manage skills

Open **Settings › Skills** (or **Open Skills** in the command palette). **Source** narrows the list to the library or one runtime; **Workspace** picks the folder whose project skills are listed.

- Library skills: **New skill**, **Edit** (description, argument hint and instructions; other frontmatter stays as written), **Rename…**, **Delete…**, and **Enabled**. Deleting a linked skill folder removes only the link.
- Runtime skills: read-only.

Changes are accepted from this machine's Michi app and from the backend's authenticated remote owner (remote access or phone access), as for the Michi assistant's settings. Skill files are instructions you chose; like other Michi tools, `michi_skills` output is treated as trusted context, so add only skills you trust.

## Back up and move

Back up `skills/` and `skills-state.json` with the rest of the configuration directory; see `data-and-backups`. The mounts need no backup. The public installers keep the source checkout separate from the configuration directory and do not create a skills backup for you. Before moving or replacing your configuration directory, back it up yourself; for linked skill folders, also preserve the original folders and restore links to their new locations.

## When a skill does not appear

1. Check the backend and workspace: the library and project skills belong to that backend and folder.
2. In Settings › Skills, check that the skill is on and not `user-invocable: false`, and look for an error under its runtime or the library.
3. Press ↻ (**Check the runtimes for new skills**).
4. A long-running chat may keep the skills it loaded at start until the runtime reloads them; a new chat sees the current library.

Related documents: `runtimes`, `runtime-capabilities`, `custom-agents`, `configuration`, `data-and-backups`, `privacy-and-data`.
