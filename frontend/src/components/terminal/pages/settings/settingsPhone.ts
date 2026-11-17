import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { IconComponent } from '../../icons';
import type { SettingsPage } from '../../rail/settingsPages';
import { requestSettings } from '../../rail/settingsRequests';

/**
 * Where the Settings panes render: a drawer that fills a phone screen, or the
 * desktop Settings window. Panes leave out what only applies to a desktop
 * window on a phone (pane layout, keyboard shortcuts, the desktop app's
 * background service), and use the window's width for previews.
 */
export type SettingsLayout = 'phone' | 'window';

export const SettingsLayoutContext = createContext<SettingsLayout>('window');

export function useSettingsLayout(): SettingsLayout {
  return useContext(SettingsLayoutContext);
}

export function useSettingsPhone(): boolean {
  return useContext(SettingsLayoutContext) === 'phone';
}

/** The desktop Settings window's width (TerminalShell's ModalShell). */
export const SETTINGS_WINDOW_WIDTH = 880;
/** Widths of what the panel beside the window holds (.settings-toc, .settings-window__aside > .appearance-preview). */
export const SETTINGS_TOC_WIDTH = 196;
export const SETTINGS_PREVIEW_WIDTH = 288;

/**
 * The panel beside the Settings window, outside its right edge: a long page's
 * "On this page" and the Appearance preview render into it. Null on a phone
 * and wherever a pane renders without the window.
 */
export const SettingsAsideContext = createContext<HTMLElement | null>(null);

export function useSettingsAside(): HTMLElement | null {
  return useContext(SettingsAsideContext);
}

/**
 * Whether a panel this wide fits beside the centred window on this screen,
 * 16px from the window and 16px from the screen's edge. Without the room the
 * pane keeps it inside the window, or leaves it out.
 */
export function useSettingsAsideRoom(width: number): boolean {
  const query = `(min-width: ${SETTINGS_WINDOW_WIDTH + 2 * (width + 32)}px)`;
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window.matchMedia !== 'function') return () => {};
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
}

/**
 * The setting a search result opened, by its name as the page shows it, so a
 * pane can reveal it (Appearance opens Advanced for an advanced setting).
 */
export const SettingsTargetContext = createContext<string | null>(null);

export function useSettingsTarget(): string | null {
  return useContext(SettingsTargetContext);
}

/** The page's title (its h1), so a group named the same need not say it again (SettingsSection). */
export const SettingsPageLabelContext = createContext<string | null>(null);

/**
 * A level inside a Settings page, such as an item opened from Trash. On a
 * phone the shell's header Back closes it before it leaves the page, so a
 * page registers how to close the level while the level is open.
 */
export const SettingsBackContext = createContext<((close: (() => void) | null) => void) | null>(null);

export function useSettingsBack(close: (() => void) | null): void {
  const register = useContext(SettingsBackContext);
  useEffect(() => {
    if (!register || !close) return;
    register(close);
    return () => register(null);
  }, [register, close]);
}

/**
 * A level that names itself in the page's title, as a skill opened from
 * Settings › Skills does: while it is open, the page leaves out its own
 * heading and the level's heading is the page's h1.
 */
export const SettingsPageTitleContext = createContext<((taken: boolean) => void) | null>(null);

export function useSettingsPageTitle(taken: boolean): void {
  const register = useContext(SettingsPageTitleContext);
  // Before paint, so the page never shows two titles.
  useLayoutEffect(() => {
    if (!register || !taken) return;
    register(true);
    return () => register(false);
  }, [register, taken]);
}

/**
 * A page's primary action, such as New skill: beside the page's title in the
 * window, and in the drawer's header on a phone (as `short`).
 */
export interface SettingsHeaderAction {
  label: string;
  short?: string;
  icon?: IconComponent;
  onClick: () => void;
}

export const SettingsHeaderActionContext = createContext<((action: SettingsHeaderAction | null) => void) | null>(null);

/** Offers the action while `label` is set; null takes it away. */
export function useSettingsHeaderAction(label: string | null, onClick: () => void, options: { short?: string; icon?: IconComponent } = {}): void {
  const register = useContext(SettingsHeaderActionContext);
  const run = useRef(onClick);
  useLayoutEffect(() => { run.current = onClick; });
  const { short, icon } = options;
  const action = useMemo(() => label ? { label, short, icon, onClick: () => run.current() } : null, [label, short, icon]);
  useEffect(() => {
    if (!register || !action) return;
    register(action);
    return () => register(null);
  }, [register, action]);
}

/**
 * Opens another Settings page from a pane, pointing at one of its settings
 * by the name that page shows it under: a link such as Settings › <name>'s
 * "When Michi's windows are closed". The Settings window provides it; outside
 * the window it asks the shell to open Settings there (requestSettings).
 */
export type OpenSettingsPage = (page: SettingsPage, setting?: string) => void;

export const SettingsOpenContext = createContext<OpenSettingsPage>(requestSettings);

export function useOpenSettingsPage(): OpenSettingsPage {
  return useContext(SettingsOpenContext);
}
