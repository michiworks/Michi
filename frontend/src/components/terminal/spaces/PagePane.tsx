import React, { useCallback, useMemo } from 'react';
import type { BlockSource, PageBlock, PageChangeDto, PageEditOp, PageSummaryDto } from 'michi-shared';
import type { PagePaneItem } from '../../../state/paneItems';
import { useChatActions, useChatProjects, useChatNodesSnapshot } from '../../../state/chatStore';
import { usePage, type PageApplyResult } from '../../../state/pages/usePage';
import { revealPageSource } from '../../../state/pages/revealSource';
import { useSpaceTree } from '../../../state/pages/useSpaceTree';
import { backendConnectionIdForWorkspace } from '../../../config/backendConnections';
import NativePageDocument, { spaceBlockTitle, useCompanionTargeting } from './NativePageDocument';
import { dispatchPageHelperDraft } from '../../../state/pages/pageHelperDraft';
import NativeDatabase from './NativeDatabase';
import { NativeTaskView } from './NativeTaskView';
import { PageChangeTargets } from './PageChangeTargets';
import { pageChangeHandlers } from './nativePageHost';
import { pageBlockTarget } from './metaChat/blockTarget';
import { DocumentHeader, DocumentShell } from '../content/page/DocumentShell';
import { pageBackground } from '../../../lib/pageBackground';
import { Maximize2 } from 'lucide-react';
import { toast } from 'sonner';
import { CustomBlock } from './components/CustomBlock';
import { openNativePageRoute } from './SpacesPage';
import { LiveThreadCards } from './NativeThreadCards';
import './spaces.css';

function PagePane({ item }: { item: PagePaneItem }) {
  const { projects } = useChatProjects();
  const { revealBackendNode } = useChatActions();
  const nodes = useChatNodesSnapshot();
  const host = projects.find((project) => project.id === item.projectId);
  const owner = projects.find((project) => project.id === item.workspaceId);
  const pageState = usePage({
    backendConnectionId: item.backendConnectionId,
    workspaceId: item.workspaceId,
    pageId: item.pageId,
  });
  const { pages } = useSpaceTree({ backendConnectionId: item.backendConnectionId, workspaceId: item.workspaceId });
  const page = pageState.page;
  const changes = pageState.changes ?? [];
  const ownerArchived = owner?.archivedAt != null || owner?.deletedAt != null;
  const readOnly = ownerArchived || !owner || pageState.status !== 'ready' || pageState.stale;
  const readOnlyReason = ownerArchived
    ? 'This workspace is archived or deleted. The page is read-only.'
    : !owner
      ? 'This page’s workspace is unavailable here. The page is read-only.'
      : pageState.stale || pageState.status !== 'ready'
        ? 'This page is out of date. Reconnect before editing.'
        : null;
  const openStandalone = useCallback(() => openNativePageRoute({
    pageId: item.pageId,
    workspaceId: item.workspaceId,
    backendConnectionId: item.backendConnectionId,
  }), [item.backendConnectionId, item.pageId, item.workspaceId]);
  const onOpenSource = useCallback((source: BlockSource) => {
    if (!page) return false;
    return revealPageSource({ backendConnectionId: item.backendConnectionId, workspaceId: item.workspaceId }, source, revealBackendNode);
  }, [item.backendConnectionId, item.workspaceId, page, revealBackendNode]);
  const { apply, accept, dismiss, reopen, revert, redo } = pageState;
  const onEdit = useCallback(async (ops: PageEditOp[], revision: number): Promise<PageApplyResult> => (
    readOnly ? 'failed' : apply(ops, revision)
  ), [apply, readOnly]);
  const changeHandlers = useMemo(() => pageChangeHandlers({ accept, dismiss, reopen, revert, redo }), [accept, dismiss, redo, reopen, revert]);
  const onOpenPage = useCallback((pageId: string) => openNativePageRoute({
    pageId,
    workspaceId: item.workspaceId,
    backendConnectionId: item.backendConnectionId,
  }), [item.backendConnectionId, item.workspaceId]);
  // A database's or component's Ask is a page helper's draft: the panel opens
  // with it right here, the block as its target, with no detour to the page
  // in Pages first (DESIGN-v2 §1.2, §1.3).
  const handoffDraft = useCallback((text: string, blockContext: { blockId: string; title: string; content: string }) => {
    dispatchPageHelperDraft({
      backendConnectionId: item.backendConnectionId,
      workspaceId: item.workspaceId,
      pageId: item.pageId,
      text,
      blockContext,
    });
  }, [item.backendConnectionId, item.pageId, item.workspaceId]);
  const renderDatabaseRef = useCallback((block: Extract<PageBlock, { type: 'database-ref' }>) => (
    <>
      <NativeDatabase
        databaseId={block.databaseId}
        workspaceId={item.workspaceId}
        connectionId={item.backendConnectionId}
        viewId={block.viewId}
        compact
        readOnly={readOnly}
        onNavigatePage={onOpenPage}
        onOpenSource={onOpenSource}
        onAskDraft={(text) => handoffDraft(text, { blockId: block.id, title: pageBlockTarget(block).title, content: 'Native database view' })}
      />
      <PageChangeTargets changes={changes} target={{ kind: 'database', databaseId: block.databaseId }} {...changeHandlers}
        onOpenSource={onOpenSource} loading={readOnly} error={pageState.error} />
    </>
  ), [changeHandlers, changes, handoffDraft, item.backendConnectionId, item.workspaceId, onOpenPage, onOpenSource, pageState.error, readOnly]);
  const renderComponent = useCallback((block: PageBlock) => block.type === 'component' ? (
    <CustomBlock
      block={block}
      pageId={item.pageId}
      workspaceId={item.workspaceId}
      connectionId={item.backendConnectionId}
      readOnly={readOnly}
      onNavigatePage={onOpenPage}
      onOpenSource={onOpenSource}
      onAskDraft={(text) => handoffDraft(text, { blockId: block.id, title: pageBlockTarget(block).title, content: 'Custom page component' })}
    />
  ) : null, [handoffDraft, item.backendConnectionId, item.pageId, item.workspaceId, onOpenPage, onOpenSource, readOnly]);
  // Blocks and checklist items are the panel's targets here too: Ask <name>, and a click while the panel is open (DESIGN-v2 §1.3).
  const targeting = useCompanionTargeting(page, spaceBlockTitle, readOnly, item.backendConnectionId);

  const paneIdentity = {
    'data-native-page-pane': '',
    'data-page-id': item.pageId,
    'data-workspace-id': item.workspaceId,
    'data-backend-connection-id': item.backendConnectionId,
  } as const;
  if (pageState.status === 'loading' && !page) return <section className="page-pane" aria-label="Native Page" {...paneIdentity}><p role="status">Loading page…</p></section>;
  if (pageState.status === 'error' && !page) return <section className="page-pane" aria-label="Native Page" {...paneIdentity}><p className="spaces-error" role="alert">{pageState.error || 'This page could not be loaded.'}</p><button type="button" className="spaces-secondary" onClick={pageState.refresh}>Retry</button></section>;
  if (!page) return <section className="page-pane" aria-label="Native Page" {...paneIdentity}><p role="alert">This page is unavailable.</p></section>;

  const ownerName = owner?.name || item.workspaceId;
  const isCrossWorkspace = item.projectId !== item.workspaceId
    || backendConnectionIdForWorkspace(item.projectId) !== item.backendConnectionId;
  const pagePath: string[] = [];
  let pathPage: PageSummaryDto | null = page;
  const byId = new Map((pages ?? []).map((entry) => [entry.id, entry]));
  const visited = new Set<string>();
  while (pathPage && !visited.has(pathPage.id)) {
    visited.add(pathPage.id);
    pagePath.unshift(pathPage.title || 'Untitled page');
    pathPage = pathPage.parentId ? byId.get(pathPage.parentId) ?? null : null;
  }
  const rootTitle = pagePath.length > 1 ? pagePath[0] : null;
  const sourceLabel = (source: PageChangeDto['source']) => ('nodeId' in source ? nodes[source.nodeId]?.title?.trim() : undefined) || undefined;
  return (
    <section
      className="page-pane"
      aria-label={page.title || 'Untitled page'}
      {...paneIdentity}
    >
      <header className="page-pane-header">
        <div className="page-pane-heading">
          <span className="page-pane-tag">Page</span>
          <strong title={pagePath.join(' / ')}>{page.title || 'Untitled page'}</strong>
          <span className="page-pane-visibility">· {isCrossWorkspace ? `Belongs to ${ownerName}` : `${host?.name || ownerName} chats can read and write this`}</span>
        </div>
        <div className="page-pane-actions">
          <button type="button" className="space-helper-icon" onClick={openStandalone} aria-label="Open standalone" title="Open standalone"><Maximize2 size={14} strokeWidth={1.6} /></button>
        </div>
      </header>
      {readOnlyReason && <p className="page-pane-notice" role="status">{readOnlyReason}</p>}
      {pageState.error && <p className="page-pane-notice" role="alert">{pageState.error}</p>}
      <DocumentShell label={`${page.title || 'Untitled page'} document`} compact background={pageBackground('space')}>
        <DocumentHeader caption={rootTitle ? `Page · ${rootTitle}` : `Page · ${ownerName}`} title={page.title || 'Untitled page'} />
        <NativePageDocument
          page={page}
          onEdit={onEdit}
          onOpenPage={onOpenPage}
          onOpenSource={onOpenSource}
          renderDatabaseRef={renderDatabaseRef}
          renderDecorations={(block) => <PageChangeTargets changes={changes} target={{ kind: 'block', pageId: page.id, blockId: block.id }} sourceLabel={sourceLabel}
            {...changeHandlers} onOpenSource={onOpenSource} loading={readOnly} error={pageState.error} />}
          renderComponent={renderComponent}
          renderThreads={(block) => <LiveThreadCards block={block} connectionId={item.backendConnectionId} workspaceId={item.workspaceId}
            onOpen={(card) => { void revealBackendNode(card.workspaceId, card.nodeId); }} />}
          renderTaskView={(block, _compact, blockReadOnly) => <NativeTaskView workspaceId={item.workspaceId} connectionId={item.backendConnectionId}
            viewId={block.viewId} title={block.title} compact readOnly={blockReadOnly || readOnly}
            onOpenThread={(card) => { void revealBackendNode(card.workspaceId, card.nodeId); }} onNavigatePage={onOpenPage} onOpenSource={onOpenSource} />}
          onOpenConversation={(nodeId) => { void revealBackendNode(item.workspaceId, nodeId).then((opened) => { if (!opened) toast.error('This conversation is no longer in this workspace.'); }); }}
          onAskAssistant={targeting.onAskAssistant}
          onSelectionChange={targeting.onSelectionChange}
          selectedBlockIds={targeting.selectedBlockIds}
          selectOnClick={targeting.selectOnClick}
          compact
          readOnly={readOnly}
        />
      </DocumentShell>
    </section>
  );
}

export default PagePane;
