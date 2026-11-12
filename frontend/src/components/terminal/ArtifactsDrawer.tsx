import { artifactTypeForPath as typeForPath } from 'michi-shared';
import { downloadArtifactFile } from '../../services/api/artifacts';
import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Ellipsis } from 'lucide-react';
import { chatLabel, useChatNodeReader, useChatStore } from '../../state/chatStore';
import type { ArtifactEntry } from '../../state/chatTypes';
import { sanitizeContextName } from '../../lib/sanitizeContextName';
import { kbd } from '../../lib/platform';
import { getElectron } from '../../lib/electronBridge';
import { artifactHostPath, parentDirectory } from '../../lib/workspaceFilePath';
import { importWorkspaceFile, importWorkspaceFileUpload, linkWorkspaceFile } from '../../services/api';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { Lightbox } from './Lightbox';
import ContextMenu, { MenuPresence, menuOpenKey, type MenuItem, type MenuSection } from '../ContextMenu';
import { DrawerShell, type DrawerShellProps } from '../ui/DrawerShell';
import { Button } from '../ui/controls';
import { confirmDialog } from '../ui/ConfirmDialog';
import { ArtifactPreview } from './artifacts/ArtifactPreview';
import { artifactType, isEmbeddedArtifact, openArtifact as openArtifactWith } from './artifacts/artifactOpen';
import {
  artifactRowTime,
  artifactTouchedAt,
  artifactTypeLabel,
  groupArtifactsByTime,
} from './artifacts/artifactListModel';
import { useArtifactHeads } from './artifacts/useArtifactHeads';
import { InlineRenameInput } from '../ui/InlineRenameInput';
import './artifacts/ArtifactsDrawer.css';
import { isLocalProject } from '../../config/backendConnections';

/**
 * The "Artifacts" right drawer (⌘⇧A): everything this workspace has saved,
 * newest first in calendar groups (artifactListModel.ts), favorites on top.
 *
 * A row names the artifact by its page title or first heading when the file
 * has one (useArtifactHeads), else by its @name; the second line says what
 * it is and which conversation made it. A tap opens it as Manage and a chat's
 * @mention also do (artifacts/artifactOpen.ts):
 *   - link  → the URL in the default browser
 *   - image → the Lightbox
 *   - doc   → a FilePane (markdown)
 *   - HTML  → a sandboxed preview in the drawer (ArtifactPreview)
 *   - other → a download (or the OS opener for files outside the workspace)
 * Everything else (cite, download, go to conversation, rename, favorite,
 * delete) is in the row's ⋯ menu, which a long press or right-click also opens.
 */

/** A previewed page gets room on a desktop; a phone's drawer is already the screen. */
const PREVIEW_WIDTH = 960;

/** Host + trimmed path, for a compact link meta line. Falls back to the raw url. */
function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

type Menu = {
  id: string;
  x: number;
  y: number;
  /** The row a phone lifts the menu beside (long press or the row's ⋯). */
  row: HTMLElement | null;
  /** Opened from the preview's header: drops below its ⋯. */
  header?: { top: number };
  /** The ⋯ that opened it, whose second press closes it. */
  trigger?: HTMLElement;
};

export default function ArtifactsDrawer({ open, onClose, motion, onPresenceChange, openArtifactId, onOpenArtifactHandled }: Pick<DrawerShellProps, 'open' | 'onClose' | 'motion' | 'onPresenceChange'> & {
  /** An artifact another surface asked the drawer to open (showArtifactInDrawer). */
  openArtifactId?: string | null;
  onOpenArtifactHandled?: () => void;
}) {
  const {
    activeProject,
    focusedNodeId,
    createContext,
    updateContext,
    deleteContext,
    pinContext,
    openArtifactPane,
    revealNode,
  } = useChatStore();
  const readNode = useChatNodeReader();
  const phone = usePhoneLayout();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [pasteVal, setPasteVal] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const artifacts = useMemo(() => activeProject?.artifacts ?? [], [activeProject]);
  const cwd = activeProject?.cwd;
  const workspaceId = activeProject?.id;
  const heads = useArtifactHeads(workspaceId, artifacts, open);
  // Derived, so a deleted artifact's preview closes by itself.
  const preview = previewId ? artifacts.find((c) => c.id === previewId) ?? null : null;
  const previewing = !!(preview && workspaceId);
  const menuArtifact = menu ? artifacts.find((c) => c.id === menu.id) ?? null : null;

  const label = useCallback((c: ArtifactEntry) => heads.get(c.id)?.title || c.name, [heads]);
  const isMissing = useCallback((c: ArtifactEntry) => heads.get(c.id)?.missing === true, [heads]);
  /** The live conversation the artifact came from, if it still exists. */
  const originOf = useCallback((c: ArtifactEntry) => {
    const nodeId = c.origin?.nodeId;
    const node = nodeId ? readNode(nodeId) : undefined;
    return node && !node.deletedAt ? { nodeId: node.nodeId, title: node.title || chatLabel(node) } : null;
  }, [readNode]);

  /** Absolute path for a file/doc/image artifact (null if unresolvable). */
  const absPath = useCallback(
    (c: ArtifactEntry): string | null => artifactHostPath(c, activeProject),
    [activeProject],
  );

  const openInFolder = useCallback((c: ArtifactEntry) => {
    const electron = getElectron();
    if (!electron?.openPath) return;
    // Resolve to absolute, then open the parent directory.
    const abs = absPath(c);
    if (!abs) return;
    void electron.openPath(parentDirectory(abs));
  }, [absPath]);

  const download = useCallback(async (c: ArtifactEntry) => {
    if (!workspaceId) return;
    try { await downloadArtifactFile(workspaceId, c.filePath); }
    catch (err) { setPreviewId(null); setPasteErr((err as Error).message); setAdding(true); }
  }, [workspaceId]);

  const handleRename = useCallback((id: string, name: string) => {
    if (!/^[\p{L}\p{N}_-]+$/u.test(name)) return false;
    updateContext(id, { name });
  }, [updateContext]);

  const startRename = useCallback((c: ArtifactEntry) => {
    setPreviewId(null);
    setRenameId(c.id);
  }, []);

  const confirmDelete = useCallback((c: ArtifactEntry) => {
    void confirmDialog({
      title: 'Delete artifact',
      message: `Delete artifact "${c.name}"?`,
      confirmLabel: 'Delete',
    }).then((ok) => { if (ok) deleteContext(c.id); });
  }, [deleteContext]);

  const filtered = useMemo(() => {
    const norm = filter.trim().toLowerCase();
    if (!norm) return artifacts;
    return artifacts.filter((c) =>
      [c.name, heads.get(c.id)?.title, c.filePath, c.url, originOf(c)?.title]
        .some((text) => text?.toLowerCase().includes(norm)));
  }, [artifacts, filter, heads, originOf]);

  // Today and Yesterday are as of this render; the list re-renders when it changes.
  const groups = useMemo(() => groupArtifactsByTime(filtered, Date.now()), [filtered]);

  const openArtifact = useCallback(
    (c: ArtifactEntry) => openArtifactWith(c, {
      project: activeProject,
      missing: isMissing(c),
      openArtifactPane,
      onLightbox: (src) => setLightbox({ src, name: c.name }),
      onPreview: () => setPreviewId(c.id),
      onError: (message) => { setPreviewId(null); setPasteErr(message); setAdding(true); },
      onOpened: onClose,
    }),
    [activeProject, isMissing, openArtifactPane, onClose],
  );

  useEffect(() => {
    if (!openArtifactId) return;
    onOpenArtifactHandled?.();
    const requested = artifacts.find((c) => c.id === openArtifactId);
    if (requested) void openArtifact(requested);
  }, [openArtifactId, onOpenArtifactHandled, artifacts, openArtifact]);

  // "Cite" — ask the focused pane to append @name to its composer. The pane
  // owns the live draft (text + mention offsets), so it merges the token and
  // resolveAtMentions injects the artifact on send. See TPane's
  // `michi:cite-artifact` listener.
  const cite = useCallback(
    (c: ArtifactEntry) => {
      if (!focusedNodeId) return;
      window.dispatchEvent(
        new CustomEvent('michi:cite-artifact', {
          detail: { nodeId: focusedNodeId, name: c.name },
        }),
      );
      onClose();
    },
    [focusedNodeId, onClose],
  );

  const goToConversation = useCallback((nodeId: string) => {
    if (!workspaceId) return;
    revealNode(nodeId, { workspaceId });
    onClose();
  }, [workspaceId, revealNode, onClose]);

  const menuSections = useCallback((c: ArtifactEntry): MenuSection[] => {
    const t = artifactType(c);
    const missing = isMissing(c);
    const origin = originOf(c);
    const reach: MenuItem[] = [];
    if (focusedNodeId) reach.push({ id: 'cite', label: 'Cite in conversation', run: () => cite(c) });
    if (t !== 'link' && isEmbeddedArtifact(c) && !missing && workspaceId) reach.push({ id: 'download', label: 'Download', run: () => void download(c) });
    if (origin) reach.push({ id: 'goto', label: 'Go to conversation', run: () => goToConversation(origin.nodeId) });
    // Revealing a folder needs the desktop shell; a browser (a phone) has none.
    if (t !== 'link' && !missing && getElectron()?.openPath) reach.push({ id: 'open-folder', label: 'Open in Folder', run: () => openInFolder(c) });
    const sections: MenuSection[] = [
      { items: reach },
      {
        items: [
          { id: 'rename', label: 'Rename', run: () => startRename(c) },
          { id: c.pinnedAt ? 'unfavorite' : 'favorite', label: c.pinnedAt ? 'Remove from favorites' : 'Add to favorites', run: () => pinContext(c.id) },
        ],
      },
      { items: [{ id: 'delete', label: 'Delete', danger: true, run: () => confirmDelete(c) }] },
    ];
    return sections.filter((section) => section.items.length > 0);
  }, [isMissing, originOf, focusedNodeId, cite, workspaceId, download, goToConversation, openInFolder, startRename, pinContext, confirmDelete]);

  const handlePaste = useCallback(async () => {
    const raw = pasteVal.trim();
    if (!raw) return;
    setPasteErr(null);
    const existing = artifacts.map((c) => c.name);
    const isUrl = /^https?:\/\//i.test(raw);
    if (isUrl) {
      // Link artifact — pure metadata, no cwd needed.
      let host = raw;
      try {
        host = new URL(raw).host;
      } catch {
        /* keep raw */
      }
      const name = sanitizeContextName(host || 'link', existing);
      createContext(name, '', { url: raw, type: 'link', source: 'user' });
      setPasteVal('');
      setAdding(false);
      return;
    }
    // Non-URL paste → save as a doc under .artifacts/ (requires a cwd).
    if (!workspaceId || !cwd) {
      setPasteErr('Pasting text as a doc needs a workspace folder. Paste a URL to save a link.');
      return;
    }
    try {
      const stem = raw.split('\n', 1)[0].slice(0, 40) || 'note';
      const name = sanitizeContextName(stem, existing);
      const result = await importWorkspaceFile(workspaceId, cwd, `${name}.md`, raw);
      createContext(result.name, result.filePath, { size: result.size, type: 'doc', kind: 'embedded', source: 'user' });
      setPasteVal('');
      setAdding(false);
    } catch (err) {
      setPasteErr((err as Error).message);
    }
  }, [pasteVal, artifacts, workspaceId, cwd, createContext]);

  const uploadFiles = async (files: File[]) => {
    if (!workspaceId || !cwd || uploading) return;
    setUploading(true);
    setPasteErr(null);
    try {
      for (const file of files) {
        const result = await importWorkspaceFileUpload(workspaceId, cwd, file);
        createContext(result.name, result.filePath, { size: result.size, type: typeForPath(result.filePath), kind: 'embedded', source: 'user' });
      }
    } catch (err) {
      setPasteErr((err as Error).message);
      setAdding(true);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handlePickFile = useCallback(async () => {
    const electron = getElectron();
    if ((activeProject && !isLocalProject(activeProject)) || !electron?.chooseFiles) {
      if (!cwd) {
        setPasteErr('Uploading files needs a workspace folder.');
        setAdding(true);
      } else fileInputRef.current?.click();
      return;
    }
    setPasteErr(null);
    try {
      const r = await electron.chooseFiles();
      if (r.canceled || !r.paths) return;
      const existing = artifacts.map((c) => c.name);
      for (const p of r.paths) {
        const base = p.split('/').pop() ?? p;
        const type = typeForPath(p);
        // With a workspace folder, symlink the file into <cwd>/.artifacts/ (no
        // bytes copied) so the agent can read/write it live — bidirectional sync
        // — and it persists with the workspace. Without a cwd there's nowhere to
        // put the link, so fall back to a bare reference (OS-open only; the agent
        // can't see it).
        if (workspaceId && cwd) {
          try {
            const result = await linkWorkspaceFile(workspaceId, cwd, p);
            existing.push(result.name);
            createContext(result.name, result.filePath, {
              kind: 'symlink',
              type,
              size: result.size,
              source: 'user',
            });
            continue;
          } catch (err) {
            // Fall through to a reference on link failure (e.g. cross-device or
            // permission) so the file is at least added and OS-openable.
            console.warn('[ArtifactsDrawer] linkWorkspaceFile failed, adding as reference:', err);
          }
        }
        const name = sanitizeContextName(base, existing);
        existing.push(name);
        createContext(name, p, { kind: 'reference', type, source: 'user' });
      }
    } catch (err) {
      setPasteErr((err as Error).message);
    }
  }, [artifacts, createContext, activeProject, workspaceId, cwd]);

  const closePreview = useCallback(() => setPreviewId(null), []);
  const total = artifacts.length;
  const now = Date.now();

  return (
    <DrawerShell
      open={open}
      // Inside a preview, Back and Escape (and the header's chevron) return to the list.
      onClose={previewing ? closePreview : onClose}
      onBack={previewing ? closePreview : undefined}
      closeControl={previewing ? 'back' : 'close'}
      width={previewing && !phone ? PREVIEW_WIDTH : undefined}
      motion={motion}
      onPresenceChange={onPresenceChange}
      title={previewing && preview ? <span className="artifacts-preview-title">{label(preview)}</span> : 'Artifacts'}
      aria-label={previewing && preview ? `Artifact: ${label(preview)}` : undefined}
      titleBadge={previewing ? undefined : (
        <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', fontFamily: 'var(--ui-font)' }}>{total}</span>
      )}
      headerActions={previewing && preview ? (
        <button
          type="button"
          className="ws-action-btn"
          aria-label="More actions"
          title="More actions"
          onClick={(event) => {
            const trigger = event.currentTarget;
            const rect = trigger.getBoundingClientRect();
            setMenu((open) => (open?.trigger === trigger ? null : { id: preview.id, x: rect.right, y: rect.bottom + 4, row: null, header: { top: rect.top - 4 }, trigger }));
          }}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </button>
      ) : (
        <>
          <button
            type="button"
            className="ws-action-btn"
            onClick={handlePickFile}
            disabled={uploading}
            title="Add file from disk"
            aria-label="Add file"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <FileAddIcon />
          </button>
          <button
            type="button"
            className="ws-action-btn"
            onClick={() => setAdding((v) => !v)}
            title="Add link or paste text"
            aria-label="Add link or text"
            style={{ fontSize: 'var(--fs-3xl)', background: adding ? 'var(--term-alt)' : undefined, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            +
          </button>
        </>
      )}
    >
      <div className="artifacts-body" data-phone={phone || undefined}>
        {previewing && preview && workspaceId ? (
          <ArtifactPreview
            key={preview.id}
            workspaceId={workspaceId}
            artifact={preview}
            label={label(preview)}
            knownMissing={isMissing(preview)}
            onDownload={() => void download(preview)}
            onRemove={() => { deleteContext(preview.id); closePreview(); }}
          />
        ) : (
          <>
            <input ref={fileInputRef} type="file" multiple hidden aria-label="Upload artifact files"
              onChange={(event) => void uploadFiles(Array.from(event.target.files ?? []))} />
            {uploading && <div role="status">Uploading files…</div>}
            <div className="artifacts-search">
              <input
                type="search"
                className="ui-input"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search artifacts…"
                aria-label="Search artifacts"
              />
            </div>

            {/* Add bar (paste URL / text) */}
            {adding && (
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--term-line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <textarea
                  className="ui-input"
                  autoFocus
                  value={pasteVal}
                  onChange={(e) => setPasteVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void handlePaste();
                    }
                  }}
                  placeholder={`Paste a URL to save a link, or text to save a doc…  (${kbd('mod', 'enter')})`}
                  rows={2}
                  style={{ resize: 'vertical' }}
                />
                {pasteErr && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger-text)' }}>{pasteErr}</div>}
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => { setAdding(false); setPasteVal(''); setPasteErr(null); }}
                  >
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => void handlePaste()}>
                    Save
                  </Button>
                </div>
              </div>
            )}

            <div className="artifacts-list term-scrollbar">
              {total === 0 && (
                <p className="artifacts-empty">No artifacts yet. Paste a URL or add a file.</p>
              )}
              {total > 0 && groups.length === 0 && (
                <p className="artifacts-empty">No artifacts match “{filter.trim()}”.</p>
              )}
              {groups.map((g) => (
                <section key={g.key} aria-label={g.label}>
                  <h3 className="artifacts-group__label">
                    <span>{g.label}</span>
                    <span className="artifacts-group__count">{g.rows.length}</span>
                  </h3>
                  <ul className="artifacts-group">
                    {g.rows.map((c) => (
                      <ArtifactRow
                        key={c.id}
                        c={c}
                        label={label(c)}
                        meta={rowMeta(c, isMissing(c), originOf(c)?.title)}
                        missing={isMissing(c)}
                        time={artifactRowTime(artifactTouchedAt(c), now, g.byDay)}
                        renaming={renameId === c.id}
                        onRename={(name) => handleRename(c.id, name)}
                        onRenameEnd={() => setRenameId(null)}
                        onOpen={() => void openArtifact(c)}
                        onMenu={(row, point, trigger) => setMenu((open) => (trigger && open?.trigger === trigger ? null : { id: c.id, x: point.x, y: point.y, row, trigger }))}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>

      {lightbox && (
        <Lightbox src={lightbox.src} filename={lightbox.name} onClose={() => setLightbox(null)} />
      )}

      <MenuPresence>{menu && menuArtifact && (
        <ContextMenu
          key={menuOpenKey(menu)}
          x={menu.x}
          y={menu.y}
          anchor={menu.row}
          anchorBottom={menu.header?.top}
          preferBelow={!!menu.header}
          trigger={menu.trigger}
          onClose={() => setMenu(null)}
          sections={menuSections(menuArtifact).map((section) => ({
            items: section.items.map((item) => ({ ...item, run: () => { setMenu(null); item.run(); } })),
          }))}
        />
      )}</MenuPresence>
    </DrawerShell>
  );
}

/** Second line: what it is, then where it came from (or that its file is gone). */
function rowMeta(c: ArtifactEntry, missing: boolean, origin: string | undefined): React.ReactNode {
  const t = artifactType(c);
  const type = artifactTypeLabel(c, t);
  if (missing) return <>{type} · <span className="artifacts-row__missing">File missing</span></>;
  if (t === 'link' && c.url) return `${type} · ${linkLabel(c.url)}`;
  return origin ? `${type} · from ${origin}` : type;
}

function ArtifactRow({
  c,
  label,
  meta,
  missing,
  time,
  renaming,
  onRename,
  onRenameEnd,
  onOpen,
  onMenu,
}: {
  c: ArtifactEntry;
  label: string;
  meta: React.ReactNode;
  missing: boolean;
  time: string;
  renaming: boolean;
  /** False: artifacts can't take that name, and the field stays open. */
  onRename: (name: string) => boolean | void;
  onRenameEnd: () => void;
  onOpen: () => void;
  onMenu: (row: HTMLElement, point: { x: number; y: number }, trigger?: HTMLElement) => void;
}) {
  const text = (
    <span className="artifacts-row__text">
      {renaming ? (
        <InlineRenameInput
          className="ui-input artifacts-row__rename"
          autoFocus
          aria-label={`Rename ${c.name}`}
          value={c.name}
          onCommit={onRename}
          onEnd={onRenameEnd}
          blur="cancel"
        />
      ) : (
        <span className="artifacts-row__title">{label}</span>
      )}
      <span className="artifacts-row__meta">{meta}</span>
    </span>
  );
  return (
    <li
      className="artifacts-row"
      data-missing={missing || undefined}
      data-context-target=""
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.currentTarget, { x: event.clientX, y: event.clientY });
      }}
    >
      {renaming ? (
        <div className="artifacts-row__open">{text}</div>
      ) : (
        // A titled row keeps its @name a hover away, for citing by hand.
        <button type="button" className="artifacts-row__open" onClick={onOpen} title={label === c.name ? undefined : `@${c.name}`}>
          {text}
          <span className="artifacts-row__time">{time}</span>
        </button>
      )}
      <button
        type="button"
        className="artifacts-row__more"
        aria-label={`More actions for ${c.name}`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const row = event.currentTarget.closest('li');
          if (row) onMenu(row, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, event.currentTarget);
        }}
      >
        <Ellipsis size={16} aria-hidden="true" />
      </button>
    </li>
  );
}

function FileAddIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
      <path d="M3 2.5h6l4 4v7H3v-11z" />
      <path d="M9 2.5v4h4" />
      <path d="M8 8.5v3M6.5 10h3" />
    </svg>
  );
}
