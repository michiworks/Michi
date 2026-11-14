import { navPageEvent } from '../../../../state/appEvents';

/** Asks the shell to show Settings › <section>; `michi:nav-page` alone opens the global drawer. */
export const OPEN_SETTINGS_SECTION_EVENT = 'michi:open-settings-section';

/** Opens Settings › <name> at its Pages upkeep part (the old `meta-agent` section redirects there). */
export function requestMetaAgentSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'meta-agent' } }));
  navPageEvent.dispatch({ page: 'settings' });
}
