import { useMemoryNotice, useMemoryNotifications } from '../../../../state/memory/memoryNotifications';
import { OPEN_SETTINGS_SECTION_EVENT } from '../../scheduled/metaAgent/metaAgentNav';

/** A toast's Review: opens Settings › Memory. */
function openMemorySettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'memory' } }));
}

/**
 * Memory change notices, once the workspaces have loaded (the shell mounts it
 * after hydration, like the other feeds), and the one-time notice that memory
 * learns from conversations once `noticeReady` (setup is done and there is a
 * workspace). Renders nothing; a toast's Review opens Settings › Memory on
 * request only.
 */
export function MemoryNotifications({ noticeReady = false }: { noticeReady?: boolean }) {
  useMemoryNotifications(openMemorySettings);
  useMemoryNotice(noticeReady, openMemorySettings);
  return null;
}
