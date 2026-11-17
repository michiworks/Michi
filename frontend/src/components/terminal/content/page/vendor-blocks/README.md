# Michi's block renderers (from Agent Desk)

Michi native Pages draw most block types with the code in this directory, on
Mantine (scoped by `../mantine/MichiMantine.tsx`). It started as a copy of
Agent Desk's block code. Agent Desk is deprecated, nothing syncs from it any
more, and Michi owns every file here: edit them like any other Michi code.

The files keep Desk's paths (`shared/…`, `src/…` as in `~/agent-desk`), so they
import each other as they did there, and most keep Desk's compact style.
Comments marked `// Michi:` record where a file departed from Desk's version
before the copy became Michi's.

## What is here

- Desk's block code: the display catalog (`shared/desk-catalog`), the block
  renderers (`src/desk/blocks/catalog/…`) and the helpers they use.
- Small modules that stand in for Desk modules the renderers import:
  - `shared/i18n.ts`: `L()` takes the English side; Michi has no Chinese UI.
  - `shared/desk.ts`: the few types and limits the renderers read.
  - `src/desk/blocks/types.ts`: Desk's `BlockProps`, with Michi's block
    context (`../blockTypes.ts`) as `ctx`.
  - `src/desk/blocks/catalog/interactive/useBlockSend.ts`: delegates to the current native page context. Actions and forms prefill the visible Spaces Assistant; polls and choices send only their visible question and selected answer. A host whose context sets `sendsAlways` (a chat reply's blocks, ChatBlocksView.tsx) sends every one at once. Where the host keeps block submissions (`recordSubmission` in `../blockTypes.ts`), forms, polls and choices store what they send first and afterwards show it read-only. There is no Desk service or Desk assistant bridge.
  - `src/desk/blocks/catalog/interactive/SubmittedNote.tsx`: the line a submitted form, poll or choice shows.
  - `src/desk/peek/use-peek.ts`: the contents block finds and lights blocks by
    Michi's page markers.

`../richRenderers.tsx` registers these renderers for the block types Michi does
not draw elsewhere. Each block is first read with the display catalog
(`shared/desk-catalog`, `validateBlock`), so a renderer only ever sees a block
in the shape it expects; one the catalog will not read shows Michi's one-line
label. The catalog is forgiving (what does not fit is clipped or dropped);
native write validation and tool schemas live in `shared/src/pages/`, and a
field added there needs the matching change in the display catalog, or the
renderer never sees it.

The native block menu, hover toolbar, drag and history live outside this
directory and follow Michi's product requirements.

The old labels/values chart format and gallery titles remain supported by `../richRenderers.tsx`. A database is a native database reference; executable components remain in Michi's component library. Containers are atomic content groups; references stay top-level.

Repeated labels in an existing labels/values chart use the original positional renderer so no data is coalesced. Shared stored content, metadata and history are never rewritten by display adapters.

After a change here, run the page tests
(`npm test -w frontend -- src/components/terminal/content/page`) and look at
`?specimen=native-blocks` in each palette.
