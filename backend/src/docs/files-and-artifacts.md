# Files, Artifacts, attachments and the browser

Applies to: desktop/web with local or remote workspaces. Source checked: 2026-11-08. Native dialogs, raw folder browsing, Terminal and the Browser pane require desktop support; attachment interpretation depends on runtime/model.

## Where did the agent write my file?

Filesystem tools act on the workspace's backend machine. Ask the agent to report the absolute path and read back the result. A remote server path is not a local Finder/Explorer path.

The workspace folder is the working root, not the Michi installation directory. The public source installation is `~/Michi`; your repository can live elsewhere. The selected folder is not a universal OS sandbox for every native tool or shell command.

## Choose the right kind of material

| Material | Use it for | Persistence and limits |
| --- | --- | --- |
| Generated project file | Code, data and deliverables | Lives on the backend filesystem; chat history is not a backup of its bytes |
| Document Artifact | Reusable report/spec/summary | `save_artifact` writes `.contexts/<name>.md` in the workspace and registers it |
| Imported file/image Artifact | A reusable source of any file type | `save_artifact` with `name` and `path` registers an existing workspace file without changing its bytes; uploads copy files, desktop imports may link them |
| External reference/symlink | Reuse a source without copying | Target must remain accessible; moving/deleting it can break the source |
| Link Artifact | A URL you want to retain | Saving a link does not automatically download or authenticate its target |
| Composer attachment | Material for a particular message | Uploads go under workspace `.attachments/`, up to 20 MB per file; they are not automatically shelf Artifacts |

The workspace's Artifacts tab lists Documents, Files, Images and Links; its + Add source button and drag/drop add files. The Artifacts drawer (topbar Artifacts button, or ⌘⇧A / Ctrl+Shift+A) lists the same material, and its + button saves a pasted URL as a Link Artifact and other pasted text as a document in `.contexts/`. Composer upload/paste is a separate message-attachment flow.

## Save and reuse a document

1. Ask: “Save the reviewed decision as an Artifact named `decision`, including source links and unresolved questions.” It is written to `.contexts/decision.md`; Artifact names may contain only letters, digits, `_` and `-`.
2. Confirm a successful tool result and find it in the workspace's Artifacts tab.
3. Open its preview to inspect the contents.
4. In another chat, choose/type its `@` mention and ask the agent to read the relevant part.

`save_artifact` accepts exactly one of `body` (Markdown text) or `path` (an existing file inside the workspace). Use `path` for screenshots in `.attachments/`, PDFs, code, HTML, archives, audio, video or any other file type. Registration retains the source path; keep that file available. Browser and remote Artifacts uploads accept all file types up to 20 MB per file; pasted text is limited to 1,000,000 characters. On a local workspace, the desktop Artifacts tab's + Add source and drag/drop reference the file in place instead of uploading it. Workspace images in PNG, JPEG, GIF or WebP preview inline. In the Artifacts drawer, HTML files open in a sandboxed preview. Other non-document files download in their original format; on desktop, references to files outside the workspace open with the system app.

`update_artifact` replaces an existing Markdown document Artifact's content; for registered files, edit the source file and call `save_artifact` with the same name and path to refresh metadata. If a document was already written to `.contexts/` and registered, an extra save can be redundant. An Artifact preview is read-only; ask for an update or use your file editor when editing is required.

Success check: the shelf entry points to the expected file and the next chat can read it. A shelf favorite affects ordering, not automatic full-content injection.

## Find and remove Artifacts from a chat

A chat's first message names only the pinned Artifacts and says how many the workspace has. The agent finds the others itself: `list_artifacts` lists the workspace's Artifacts, pinned first and then the most recently updated, with filters by type or pinned and paging; `search_artifacts` matches keywords in an Artifact's name, path or link and in the text of document Artifacts in `.contexts/`, reading a bounded amount of text per call. Both read only the chat's own workspace and run without an approval card.

A conversation with a primary Agent has only the tools its definition lists, which never include these three, so its first message names the workspace's Artifacts itself instead: pinned first, then the most recently updated, at most 50.

`delete_artifact` removes one Artifact by name when you ask, as the Artifacts drawer's Delete does: the entry leaves the shelf and can no longer be `@`-mentioned, but its file is not deleted. It always asks you first, on every runtime (Codex included) and in Ask, Trust and YOLO alike: a card names the Artifact, its type and its file or link, and only Delete removes it. Cancel, no answer, or a chat with nobody to ask deletes nothing, and a saved "always allow" never answers the card; see `permissions`. An Artifact that was removed, saved again or changed while the card was open is not deleted either: the agent has to ask again. Open windows drop the entry when the agent reports the deletion.

## Upload and interpret attachments

Wait for upload completion before sending. Upload errors such as “No workspace folder for file attachment” require a usable workspace folder/backend, not a different permission mode.

Kiro CLI, Pi, Claude and Codex have image-input paths, subject to model/runtime support. Antigravity (opt-in) receives attached images as file links with a note asking it to open them with its own file tool, not as inline image pixels. Non-image attachments are generally supplied as paths for tools to read; they are not all converted into native multimodal blocks. A PDF, archive, video or audio file may need a suitable extraction tool. Do not claim successful inspection merely because its name appeared in a prompt.

Crew's adapter does not support image/audio attachments. A thumbnail in Michi does not prove Crew received image pixels. Use a supported Runtime for image analysis or provide an appropriate textual extraction and identify that limitation.

For remote workspaces, message uploads are sent to the remote backend. A desktop path alone is not an upload. Confirm the remote file exists and that the selected tools can read it.

## Broken or stale sources

If a source stops opening:

1. Confirm the backend connection and workspace folder.
2. Check the reported target path/URL and access permissions.
3. For an external reference, restore the target or add/relink the correct source.
4. Re-read changed files and rebuild dependent summaries/digests where appropriate.

A symlink/reference is not an independent copy. Back up the original target and preserve or recreate its relationship after migration. See `data-and-backups` before removing source files.

## Browser pane and website access

Opening a URL in Michi's Browser pane is a viewing action. It does not automatically give the agent browser automation, computer use, your page text or every logged-in cookie. Those require a separately available tool/integration and its permissions.

Likewise, saving a URL as an Artifact does not prove the agent read the page. Ask it to use an available retrieval/browser tool and cite the content actually obtained. If the tool cannot access a login-only page, provide the relevant allowed content or use an authorized integration rather than assuming shared authentication.

In remote workspaces, the native Terminal and raw folder browser remain local-only. Use the remote agent's shell/filesystem tools and chat Artifacts for server files.

## Share results

Use the thread menu's “Export this thread…” action to get Markdown, then “Save as…”. Review it before sharing: transcripts can contain private prompts, tool results and paths. Share a reviewed Artifact when the recipient needs the deliverable rather than the whole conversation. Neither the Markdown export nor a JSON backup (Settings › Backup & restore › Export backup) packages every referenced external file; the backup also excludes attachment files.

Related documents: `concepts-and-context`, `data-and-backups`, `runtime-capabilities`, `privacy-and-data`, `remote-backend`.
