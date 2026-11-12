import { parseTriStateFlag, readRuntimeSetting } from '../../lib/runtimeFlags';

export const MARKDOWN_REMEND_STORAGE_KEY = 'michi:markdown-remend';

/**
 * Kill switch for fake snapshot closers and styled pending-tail segments.
 * Default on; disabling it restores the legacy plain-tail path.
 */
export function markdownRemendEnabled(): boolean {
  return readRuntimeSetting(MARKDOWN_REMEND_STORAGE_KEY, import.meta.env.VITE_MARKDOWN_REMEND, parseTriStateFlag) ?? true;
}
