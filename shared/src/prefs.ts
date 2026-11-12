/**
 * The preferences the backend keeps in config.json (GET/PUT /prefs), so
 * every browser and device (a new port, the phone, another machine) uses
 * the same ones; a browser's own copy only caches them. They are what
 * Settings shows, except per-device choices. Others stay in each browser.
 * The frontend marks every pref with where it lives (PREF_STORAGE in
 * frontend/src/state/prefs.tsx), and its 'server' entries are these.
 */
export const SERVER_PREF_KEYS = [
  'homeRecommendations',
  'linkOpenTarget',
  'terminalPalette',
  'terminalAccentOverrides',
  'uiFont',
  'messageFont',
  'messageFontSize',
  'composerFontSize',
  // Phone-only text size preset; shared so a Safari tab and a home-screen
  // app (separate localStorage) use the same size.
  'phoneTextSize',
  'sidebarDensity',
  'sidebarInset',
  'sidebarRowStyle',
  'showSidebarTimestamps',
  'cornerRadius',
  'codeBlockStyle',
  'codeWrap',
  'terminalDensity',
  'focusDim',
  'defaultPaneWidth',
  'paneWidthMode',
  'paneSpawnAnimation',
  'singlePaneContentWidth',
  'paneRules',
  'notifications',
  'notificationSounds',
  'trashTTLDays',
  'digestEnabled',
  'enableKiroSidecarTitles',
  'enableFollowUps',
] as const;

export type ServerPrefKey = (typeof SERVER_PREF_KEYS)[number];
