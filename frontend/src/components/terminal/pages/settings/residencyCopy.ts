import { IS_MAC } from '../../../../lib/platform';

/**
 * Names of the Settings › Notifications rows for when Michi's windows are
 * closed (DESIGN-v2 §1.5, §5): the pane shows them, Settings search finds
 * them, and links from Settings › <name> and Settings › Scheduled jobs
 * point at them, so all of them read these.
 */

export const WINDOWS_CLOSED_TITLE = 'When Michi’s windows are closed';

/** The menu bar on a Mac; the notification area on Windows. */
export const TRAY_LABEL = IS_MAC ? 'Keep Michi in the menu bar' : 'Keep Michi in the notification area';

export const HIDE_DOCK_LABEL = 'Hide the Dock icon when no windows are open';

export const OPEN_AT_LOGIN_LABEL = 'Open Michi at login';

/** The background service (macOS LaunchAgent), moved here from Settings › Scheduled jobs. */
export const KEEP_RUNNING_LABEL = 'Keep Michi running after you quit';
