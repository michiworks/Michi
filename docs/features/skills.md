# Michi Skills

Skills are folders containing an Agent Skills `SKILL.md`: frontmatter names and
describes the skill, followed by its instructions. Manage Michi's library in
**Settings › Skills**, and type `/` in an ordinary conversation to run one.
See the [skills user guide](../../backend/src/docs/skills.md) for the full workflow.

## Sources

- **Library:** skills in `<MICHI_CONFIG_DIR>/skills`, normally `~/.michi/skills`.
  Create, edit, rename, delete or enable them in Settings. Disabling a linked skill
  does not modify the folder it points to; deleting its link leaves that folder.
- **Built-in:** read-only skills shipped with Michi. `/compare` helps formulate a
  multi-model comparison and propose its plan. Built-in skills can be enabled or
  disabled, but not edited. A library skill with the same name remains distinct.
- **Runtime:** skills a supported runtime lists for the workspace folder. These
  are read-only in Michi; edit them where that runtime stores them. Listings report
  failures and refresh in the background, while the library remains available.

## Invocation

The `/` menu lists commands before skills. Picking a row runs that exact entry;
when typing without selecting, a command takes precedence, then a library skill,
then a built-in skill, then a runtime skill of the same name. Text after the name
is passed as arguments. A skill turn follows the skill's output instructions
rather than Michi's usual follow-up and branch-overview formatting.

Michi supplies library skills through Claude additional directories, Codex extra
roots, Kiro V3 additional directories and Pi skill paths where supported. The
`michi_skills` tool also provides library access. Built-in instructions are compiled
into the backend and expanded into the message, so external CLIs need not read
inside the packaged application.

`user-invocable: false` hides a skill from the menu. Skills marked
`disable-model-invocation: true` remain user-run only and are excluded from the
Codex and Kiro mounts. The library is disabled for runtimes when its state file
cannot be read. Hosted cloud mode offers neither the library nor built-in skills.

## Limits

The library belongs to its backend; a remote backend has its own. Project skill
listings depend on the workspace folder. Long-running sessions may retain the
skills loaded at startup. Mounts link to the library, so edits through a mount
change the library's files. Runtime name collisions and native command behavior
vary; the user guide describes Michi's handling. Availability depends on the
installed runtime, and automated adapter tests do not certify every CLI version.

## Source and tests

- [Library and mounts](../../backend/src/services/skills/library.ts)
- [Built-in skills](../../backend/src/services/skills/builtin.ts)
- [Invocation](../../backend/src/services/skills/invocation.ts)
- [Library tests](../../backend/test/skillsLibraryCore.test.ts)
- [Routes and built-in behavior tests](../../backend/test/skillsRoutes.test.ts)
- [Composer selection tests](../../frontend/src/components/terminal/TPane.slashPick.test.tsx)
- [Isolated Skills page tests](../../e2e/specs/skills-page.spec.ts)
