/**
 * The read-only page an agent's browser opens from a preview_page link
 * (backend/src/services/pages/pagePreview.ts): one Page drawn by the same
 * document as Spaces, without the app shell. The backend's preview cookie
 * covers only this page's reads, so nothing here writes. Custom components
 * stay paused (minting their capability is a write) and conversation cards
 * fall back to their unavailable state (they read the chat store).
 * `data-page-preview` on <body> turns "ready" or "error" once the page loaded.
 */
import { useEffect, useLayoutEffect, useMemo } from 'react';
import type { PageBlock } from 'michi-shared';
import { usePage } from '../../../state/pages/usePage';
import type { TerminalPalette } from '../../../state/prefs';
import { cssVarsFor, DARK_PALETTES, PALETTES } from '../tokens';
import { DocumentHeader, DocumentShell } from '../content/page/DocumentShell';
import { MichiMantine } from '../content/page/mantine/MichiMantine';
import NativePageDocument from './NativePageDocument';
import NativeDatabase from './NativeDatabase';
import { NativeTaskView } from './NativeTaskView';
import './spaces.css';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendConnections';

const DEFAULT_PALETTE: TerminalPalette = 'slate';
const ignore = () => {};

export default function PagePreview({ pageId, workspaceId, palette: asked }: { pageId: string; workspaceId: string; palette: string | null }) {
  const palette = asked && Object.hasOwn(PALETTES, asked) ? asked as TerminalPalette : DEFAULT_PALETTE;
  const vars = useMemo(() => cssVarsFor(palette, PALETTES[palette].accent), [palette]);
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-terminal-palette', palette);
    for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value);
  }, [palette, vars]);

  const state = usePage({ backendConnectionId: LOCAL_BACKEND_CONNECTION_ID, workspaceId, pageId });
  const page = state.page;
  const outcome = page ? 'ready' : state.status === 'error' ? 'error' : 'loading';
  useEffect(() => {
    document.body.dataset.pagePreview = outcome;
    document.title = page ? `${page.title || 'Untitled page'} · Preview` : 'Page preview';
  }, [outcome, page]);

  if (!page) {
    return <main className="page-preview-status" style={{ padding: 24, color: 'var(--term-fg)', background: 'var(--term-bg)', minHeight: '100vh' }}>
      <p role={outcome === 'error' ? 'alert' : 'status'}>{outcome === 'error' ? state.error || 'This page could not be loaded.' : 'Loading page…'}</p>
    </main>;
  }

  // Databases draw as in Spaces: their read-only form is a plain fallback
  // table, so they stay editable in code and `inert` keeps them from taking
  // input (writes would also meet the token check on a remote backend).
  const renderDatabaseRef = (block: Extract<PageBlock, { type: 'database-ref' }>, compact = false) => (
    <div inert>
      <NativeDatabase databaseId={block.databaseId} workspaceId={workspaceId} connectionId={LOCAL_BACKEND_CONNECTION_ID}
        viewId={block.viewId} compact={compact} presentation="page" />
    </div>
  );
  return (
    <main style={{ height: '100vh', background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
      <MichiMantine dark={DARK_PALETTES.has(palette)}>
        <DocumentShell label={`${page.title || 'Untitled page'} document`} layout="column" className="space-doc spaces-home spaces-space" columnClassName="spaces-home__doc">
          <DocumentHeader caption="Page preview" title={page.title || 'Untitled page'} />
          <NativePageDocument
            page={page}
            readOnly
            onEdit={async () => 'failed'}
            onOpenPage={ignore}
            renderDatabaseRef={renderDatabaseRef}
            renderComponent={(block) => block.type === 'component'
              ? <div className="page-component-fallback" role="status" data-component-id={block.componentId}><strong>Component</strong><p>Custom components are paused in page previews.</p></div>
              : null}
            renderTaskView={(block, compact) => <div inert><NativeTaskView workspaceId={workspaceId} connectionId={LOCAL_BACKEND_CONNECTION_ID}
              viewId={block.viewId} title={block.title} compact={compact} onOpenThread={ignore} onNavigatePage={ignore} /></div>}
          />
        </DocumentShell>
      </MichiMantine>
    </main>
  );
}
