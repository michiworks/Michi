import React, { useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import type { PageSummaryDto } from 'michi-shared';
import { createPage, deletePage, fetchPage, patchPage, restorePage, type PageApiIdentity } from '../../../services/api/pages';
import { notifyPageChanged } from '../../../state/pages/pageEvents';
import { recordUndo } from '../../../state/undoStack';
import { ModalShell } from '../../ui/ModalShell';
import { Button } from '../../ui/controls';
import './pageActions.css';

const named = (title: string) => `“${title || 'Untitled page'}”`;

type PageActionKind = 'create' | 'rename' | 'move' | 'trash';

/** Puts a page action on the window's undo history (state/undoStack.ts); each Undo goes through the pages API. */
function recordPageUndo(kind: PageActionKind, page: PageSummaryDto, changedId: string, title: string, identity: PageApiIdentity) {
  const changed = (pageId: string) => notifyPageChanged({ ...identity, pageId });
  // Patches the page as it stands when Undo runs, after whatever came since.
  const patchBack = async (body: { title?: string; parentId?: string | null }) => {
    const current = await fetchPage(page.id, identity);
    if (!current) return false;
    await patchPage(page.id, { revision: current.revision, ...body }, identity);
    changed(page.id);
    return true;
  };
  if (kind === 'create') {
    recordUndo({ label: `Created ${named(title)}`, undo: async () => { await deletePage(changedId, identity); changed(changedId); } });
  } else if (kind === 'trash') {
    recordUndo({ label: `Moved ${named(page.title)} to Trash`, toast: true, undo: async () => { await restorePage(page.id, identity); changed(page.id); } });
  } else if (kind === 'rename') {
    recordUndo({ label: `Renamed ${named(page.title)} to ${named(title)}`, undo: () => patchBack({ title: page.title }) });
  } else {
    recordUndo({ label: `Moved ${named(page.title)}`, undo: () => patchBack({ parentId: page.parentId }) });
  }
}

export function pageIsWithin(pages: readonly PageSummaryDto[], candidateId: string, ancestorId: string): boolean {
  const byId = new Map(pages.map(page => [page.id, page]));
  let current = byId.get(candidateId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === ancestorId) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

export function pageSpaceSubtree(pages: readonly PageSummaryDto[], pageId: string): PageSummaryDto[] {
  const byId = new Map(pages.map(page => [page.id, page]));
  let root = byId.get(pageId);
  const seen = new Set<string>();
  while (root?.parentId && byId.has(root.parentId) && !seen.has(root.id)) {
    seen.add(root.id);
    root = byId.get(root.parentId);
  }
  const rootId = root?.id;
  return rootId ? pages.filter(page => pageIsWithin(pages, page.id, rootId)) : [];
}

type Action = { kind: PageActionKind; page: PageSummaryDto };
const TITLES = { create: 'New page', rename: 'Rename page', move: 'Move page', trash: 'Move to trash' };

/** The sidebar and document outline share the same page operations and dialogs. */
export function usePageActions(options: {
  identity: PageApiIdentity;
  pages: readonly PageSummaryDto[];
  readOnly: boolean;
  onOpen(pageId: string): void;
  onChanged(pageId: string): void;
  onTrashed(page: PageSummaryDto): void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const open = (kind: Action['kind'], page: PageSummaryDto) => {
    if (options.readOnly || running.current) return;
    setValue(kind === 'rename' ? page.title : kind === 'move' ? page.parentId ?? '' : '');
    setError(null);
    setAction({ kind, page });
  };
  const destinations = action?.kind === 'move'
    ? pageSpaceSubtree(options.pages, action.page.id).filter(page => !pageIsWithin(options.pages, page.id, action.page.id))
    : [];
  const close = () => { if (!running.current) setAction(null); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!action || options.readOnly || running.current) return;
    const { kind, page } = action;
    const title = value.trim();
    if ((kind === 'create' || kind === 'rename') && !title) return;
    if (kind === 'move' && value && !destinations.some(candidate => candidate.id === value)) {
      setError('Choose a page in this page.');
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    const identity = options.identity;
    try {
      let changedId = page.id;
      if (kind === 'create') {
        const created = await createPage({ workspaceId: identity.workspaceId, parentId: page.id, title }, identity);
        changedId = created.id;
      } else if (kind === 'trash') {
        await deletePage(page.id, identity);
      } else {
        const current = await fetchPage(page.id, identity);
        if (!current) throw new Error('This page is no longer available.');
        await patchPage(page.id, { revision: current.revision, ...(kind === 'rename' ? { title } : { parentId: value || null }) }, identity);
      }
      notifyPageChanged({ ...identity, pageId: changedId });
      recordPageUndo(kind, page, changedId, title, identity);
      const callbacks = latest.current;
      if (callbacks.identity.workspaceId === identity.workspaceId && callbacks.identity.backendConnectionId === identity.backendConnectionId) {
        callbacks.onChanged(changedId);
        if (kind === 'create') callbacks.onOpen(changedId);
        if (kind === 'trash') callbacks.onTrashed(page);
      }
      setAction(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the page.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return {
    createChild: (parentId: string) => { const parent = options.pages.find(page => page.id === parentId); if (parent) open('create', parent); },
    rename: (page: PageSummaryDto) => open('rename', page),
    move: (page: PageSummaryDto) => open('move', page),
    trash: (page: PageSummaryDto) => open('trash', page),
    // Closing fades the dialog out with the action it last showed.
    dialog: <AnimatePresence>{action && <ModalShell key="page-action" open onClose={close} title={TITLES[action.kind]} width={420} dismissible={!busy} captureEscape>
      <form className="page-action-form" onSubmit={event => void submit(event)}>
        {action.kind === 'trash'
          ? <p>Move “{action.page.title}” and its child pages to trash?</p>
          : action.kind === 'move'
            ? <label>Move under<select className="ui-input" value={value} disabled={busy || options.readOnly} onChange={event => setValue(event.target.value)}>
              <option value="">Top level (new page)</option>
              {destinations.map(page => <option key={page.id} value={page.id}>{page.title || 'Untitled page'}</option>)}
            </select></label>
            : <label>Name<input className="ui-input" value={value} disabled={busy || options.readOnly} autoFocus onFocus={event => event.target.select()} onChange={event => setValue(event.target.value)} /></label>}
        {error && <p role="alert">{error}</p>}
        {options.readOnly && <p role="status">Page changes are unavailable. Reconnect before editing.</p>}
        <footer>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" danger={action.kind === 'trash'} disabled={busy || options.readOnly || ((action.kind === 'create' || action.kind === 'rename') && !value.trim())}>
            {busy ? 'Saving…' : action.kind === 'create' ? 'Create page' : action.kind === 'move' ? 'Move' : action.kind === 'trash' ? 'Move to trash' : 'Save'}
          </Button>
        </footer>
      </form>
    </ModalShell>}</AnimatePresence>,
  };
}
