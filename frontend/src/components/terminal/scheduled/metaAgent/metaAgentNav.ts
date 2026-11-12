import { openScheduledHome, setScheduledRoute, useScheduledRoute } from '../scheduledNav';
import { navPageEvent } from '../../../../state/appEvents';

// The detail page, its row and its crumb are titled pagesUpkeepTitle(name)
// ("<name> · Pages upkeep", metaAgentCopy.ts).

export function openMetaAgentDetail(): void { setScheduledRoute({ kind: 'meta-agent' }); }
export function closeMetaAgentDetail(): void { openScheduledHome(); }
export function useMetaAgentDetailOpen(): boolean { return useScheduledRoute().kind === 'meta-agent'; }

/** Asks the shell to show Settings › <section>; `michi:nav-page` alone opens the global drawer. */
export const OPEN_SETTINGS_SECTION_EVENT = 'michi:open-settings-section';

/** Opens Settings › <name> at its Pages upkeep part (the old `meta-agent` section redirects there). */
export function requestMetaAgentSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'meta-agent' } }));
  navPageEvent.dispatch({ page: 'settings' });
}
