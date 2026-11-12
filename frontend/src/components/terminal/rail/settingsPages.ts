import {
  Archive, Bell, BookOpen, Brain, CalendarClock, ChartColumn, CircleUser, Cpu, ExternalLink, HardDriveDownload, Keyboard, Palette, Radar, RefreshCw, Server,
  Trash2, type LucideIcon,
} from 'lucide-react';
import { DEFAULT_COMPANION_NAME } from 'michi-shared';
import { SETTINGS_AREA_SECTIONS, type SettingsAreaSection } from '../../../state/shellArea';

/**
 * Settings pages, one topic each, shared by the phone list and the desktop
 * window. `section` is the older five-section grouping that requests and
 * tests still name (General holds several pages).
 */
export type SettingsPage =
  | 'account' | 'runtime' | 'companion' | 'memory' | 'skills' | 'machines' | 'appearance'
  | 'notifications' | 'links' | 'trash' | 'archived' | 'backup' | 'scheduled' | 'shortcuts' | 'update';

export interface SettingsPageInfo {
  label: string;
  icon: LucideIcon;
  section: SettingsAreaSection;
  /** Only where it applies: shortcuts need a keyboard; a phone updates the machine it opened. */
  only?: 'window' | 'phone';
}

export const SETTINGS_PAGES: Readonly<Record<SettingsPage, SettingsPageInfo>> = {
  runtime: { label: 'Runtime & model', icon: Cpu, section: 'runtime' },
  /**
   * Settings › <name> (DESIGN-v2 §1.5): the agent the user talks to, with
   * what used to be Settings › Meta agent as its Pages upkeep part. Its label
   * is the agent's name (settingsPageLabel); this one is the default name.
   */
  companion: { label: DEFAULT_COMPANION_NAME, icon: Radar, section: 'meta-agent' },
  /** Memory on or off, and what agents remember across runtimes. */
  memory: { label: 'Memory', icon: Brain, section: 'general' },
  /** The Michi skill library, and the skills each runtime finds on its own. */
  skills: { label: 'Skills', icon: BookOpen, section: 'general' },
  /** Connected machines, and phone access, which opens one of them on a phone. */
  machines: { label: 'Machines', icon: Server, section: 'general' },
  appearance: { label: 'Appearance', icon: Palette, section: 'appearance' },
  notifications: { label: 'Notifications', icon: Bell, section: 'general' },
  links: { label: 'Links', icon: ExternalLink, section: 'general' },
  /** Deleted threads, pages and workspaces, and how long Trash keeps threads. */
  trash: { label: 'Trash', icon: Trash2, section: 'data' },
  /** Threads and nodes archived out of the sidebar. */
  archived: { label: 'Archived', icon: Archive, section: 'data' },
  backup: { label: 'Backup & restore', icon: HardDriveDownload, section: 'data' },
  scheduled: { label: 'Scheduled jobs', icon: CalendarClock, section: 'general' },
  shortcuts: { label: 'Keyboard shortcuts', icon: Keyboard, section: 'general', only: 'window' },
  /** The machine serving the phone updates itself to the latest main branch (UpdatePane). */
  update: { label: 'Update', icon: RefreshCw, section: 'general', only: 'phone' },
  /** Who is signed in; the window lists it only for a signed-in user. */
  account: { label: 'Account', icon: CircleUser, section: 'general' },
};

/** A page's label as the navigation and its heading show it: Settings › <name> is called by the agent's name. */
export function settingsPageLabel(page: SettingsPage, name: string): string {
  return page === 'companion' ? name.trim() || DEFAULT_COMPANION_NAME : SETTINGS_PAGES[page].label;
}

/**
 * The groups both layouts list, in order. App ends with the pages only one
 * layout shows: Update on a phone, Account in the window (a phone lists the
 * account above the groups instead).
 */
export const SETTINGS_GROUPS: ReadonlyArray<{ title: string; pages: readonly SettingsPage[] }> = [
  { title: 'Agent', pages: ['runtime', 'companion', 'memory', 'skills'] },
  { title: 'Workspace', pages: ['machines', 'scheduled', 'links'] },
  { title: 'App', pages: ['appearance', 'notifications', 'shortcuts', 'update', 'account'] },
  { title: 'Data', pages: ['trash', 'archived', 'backup'] },
];

export function isSettingsPage(value: unknown): value is SettingsPage {
  return typeof value === 'string' && Object.hasOwn(SETTINGS_PAGES, value);
}

/** The page a request for one of the older sections opens; General opens on its first page. */
export function pageForSection(section: SettingsAreaSection): SettingsPage {
  switch (section) {
    case 'runtime': return 'runtime';
    case 'meta-agent': return 'companion';
    case 'appearance': return 'appearance';
    case 'data': return 'backup';
    case 'general': return 'machines';
  }
}

/** A request names a page, or one of the older sections ('meta-agent' opens Settings › <name>). */
export function settingsPageForRequest(value: unknown): SettingsPage | null {
  if (isSettingsPage(value)) return value;
  const section = SETTINGS_AREA_SECTIONS.find((item) => item.id === value);
  return section ? pageForSection(section.id) : null;
}

/** The heading of Settings › <name>'s part that was Settings › Meta agent. */
export const PAGES_UPKEEP_TITLE = 'Pages upkeep';

/**
 * The setting a request points at on its page, by the name the page shows
 * it under: the request's own `setting`, or, for the old Meta agent page,
 * the Pages upkeep part of Settings › <name>. Null when it names none.
 */
export function settingsRevealForRequest(section: unknown, setting?: unknown): string | null {
  if (typeof setting === 'string' && setting.trim()) return setting.trim();
  return section === 'meta-agent' ? PAGES_UPKEEP_TITLE : null;
}
