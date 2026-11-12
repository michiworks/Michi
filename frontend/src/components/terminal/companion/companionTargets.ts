import { useCallback } from 'react';
import { toast } from 'sonner';
import type { CompanionTarget } from 'michi-shared';
import { useChatActions } from '../../../state/chatStore';
import { openCompanionPanel } from '../../../state/companion/companionPanel';
import { openPreferredUrl } from '../../../services/openUrl';
import { OPEN_SETTINGS_SECTION_EVENT } from '../scheduled/metaAgent/metaAgentNav';

/** Settings › Companion (the shell opens Settings on the request). */
export function openCompanionSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'companion' } }));
}

/**
 * Where "Open" (and a notice's click, toast or banner alike) takes the user:
 * a Michi conversation in its workspace, a page in the preferred browser, the
 * panel's tab (on Today, at the item the target names), or Settings ›
 * Companion. Only ever called from a user action.
 */
export function useOpenCompanionTarget(): (target: CompanionTarget) => Promise<void> {
  const { revealBackendNode } = useChatActions();
  return useCallback(async (target: CompanionTarget) => {
    switch (target.kind) {
      case 'node':
        if (!(await revealBackendNode(target.workspaceId, target.nodeId))) toast.error('That conversation is no longer available');
        return;
      case 'url':
        openPreferredUrl(target.url);
        return;
      case 'companion':
        // Today scrolls to the item and highlights it (just Today when it is no longer open).
        openCompanionPanel(target.tab === 'today' && target.itemId ? { tab: 'today', focusItem: target.itemId } : { tab: target.tab });
        return;
      case 'settings':
        openCompanionSettings();
        return;
    }
  }, [revealBackendNode]);
}
