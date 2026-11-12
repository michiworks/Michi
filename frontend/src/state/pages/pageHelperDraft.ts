import { PAGE_COMPONENT_LIMITS } from 'michi-shared';

export const PAGE_HELPER_DRAFT_EVENT = 'michi:page-helper-draft';

/** A page block's Ask (a database's or component's helper): a draft for the panel, about that block. */
export interface PageHelperDraftRequest {
  backendConnectionId: string;
  workspaceId: string;
  pageId: string;
  text: string;
  blockContext?: { blockId: string; title: string; content: string };
}

/**
 * Hands the draft to the one panel: its host (CompanionPanel.tsx, mounted
 * with the shell) opens on it with the block as its target, without sending.
 * Empty and oversized drafts are dropped.
 */
export function dispatchPageHelperDraft(request: PageHelperDraftRequest): void {
  const text = request.text.trim();
  if (!text || text.length > PAGE_COMPONENT_LIMITS.draftChars) return;
  window.dispatchEvent(new CustomEvent<PageHelperDraftRequest>(PAGE_HELPER_DRAFT_EVENT, { detail: { ...request, text } }));
}
