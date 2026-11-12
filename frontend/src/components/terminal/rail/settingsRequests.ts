import type { SettingsAreaSection } from '../../../state/shellArea';
import { OPEN_SETTINGS_SECTION_EVENT } from '../scheduled/metaAgent/metaAgentNav';
import { settingsPageForRequest, settingsRevealForRequest, type SettingsPage } from './settingsPages';

/**
 * Requests to open Settings at a page, and the setting there to point at.
 *
 * The shell opens Settings on OPEN_SETTINGS_SECTION_EVENT `{section}` and
 * owns the page; Settings itself only learns the page. So the setting a
 * request names (`{section, setting}`, or the Pages upkeep part of
 * Settings › <name> for the old `meta-agent` section) waits here until the
 * Settings window shows that page, which then scrolls to it and marks it the
 * way a search result does.
 */

export interface SettingsRequestDetail {
  /** A page id, or one of the older sections (settingsPageForRequest). */
  section?: unknown;
  /** The setting to point at, by the name its page shows it under. */
  setting?: unknown;
}

/** A request older than this is not one the user is still waiting on. */
const PENDING_MS = 10_000;

let pending: { page: SettingsPage; label: string; at: number } | null = null;
const listeners = new Set<() => void>();

function onRequest(event: Event): void {
  const detail = (event as CustomEvent<SettingsRequestDetail | null | undefined>).detail;
  const page = settingsPageForRequest(detail?.section);
  const label = page ? settingsRevealForRequest(detail?.section, detail?.setting) : null;
  pending = page && label ? { page, label, at: Date.now() } : null;
  for (const listener of [...listeners]) listener();
}

/** Called after every request, so a Settings window already on the requested page can take its setting. */
export function subscribeSettingsRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== 'undefined') window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onRequest);

/**
 * Opens Settings at `page` (a page, or one of the older sections), pointing
 * at `setting` there when given: e.g. requestSettings('notifications',
 * "When Michi's windows are closed").
 */
export function requestSettings(page: SettingsPage | SettingsAreaSection, setting?: string): void {
  const detail: SettingsRequestDetail = setting ? { section: page, setting } : { section: page };
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail }));
}

/** The setting the latest request named on `page`, once: null when none waits, or it is for another page. */
export function takeSettingsReveal(page: SettingsPage, now = Date.now()): string | null {
  const request = pending;
  if (!request || request.page !== page) return null;
  pending = null;
  return now - request.at <= PENDING_MS ? request.label : null;
}

/** @testonly */
export function resetSettingsRequestsForTests(): void {
  pending = null;
}
