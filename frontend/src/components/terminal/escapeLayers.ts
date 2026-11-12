import { composerKeptEscape } from '../composerEscape';
import { isImeComposing } from '../../lib/ime';

/**
 * Which surface an Esc belongs to. The page (leave it, clear its selection,
 * close its drawer) is the last in line: the layers that close on Esc float
 * over it and take theirs first. The <name> panel (DESIGN-v2 §1.2) is not
 * one of them while it is docked beside the page: only an Esc pressed inside
 * it closes it, and the page's Esc stays the page's. Over the page (a narrow
 * window) the shell closes it first (TerminalShell).
 */

/**
 * The panel's root (`aside[data-assistant-panel][data-companion-panel]`,
 * DESIGN-v2 §1.1). Both marks count, so a panel carrying either is the panel.
 */
const PANEL = '[data-assistant-panel], [data-companion-panel]';

/** Focus is in the <name> panel (pane shortcuts such as ⌘W leave the grid alone). */
export function isInAssistantPanel(element: Element | null): boolean {
  return !!element?.closest(PANEL);
}

/**
 * A layer on its way out is gone already: a drawer sliding out, a modal,
 * panel or menu fading out stays mounted a moment, aria-hidden or inert, and
 * so does everything inside it (a find bar in the panel, a popover in
 * Settings).
 */
const LIVE = ':not([inert], [inert] *, [aria-hidden="true"], [aria-hidden="true"] *)';

function liveLayers(...selectors: string[]): string {
  return selectors.map((selector) => `${selector}${LIVE}`).join(', ');
}

/** Whether the <name> panel is on screen now (not closed, nor on its way out). */
export function companionPanelOnScreen(): boolean {
  return !!document.querySelector(liveLayers('[data-assistant-panel]', '[data-companion-panel]'));
}

/**
 * Menus, lists and modals close on any Esc while they are up, wherever the
 * focus is, and so does the selection toolbar (`data-escape-layer="over"`).
 */
export const MENU_LAYER_SELECTOR = liveLayers('[role="menu"]', '[role="listbox"]', '[role="alertdialog"]', '[aria-modal="true"]', '[data-escape-layer="over"]');

/**
 * With focus outside the panel, any other open layer takes Esc first: menus,
 * lists, the peek drawer and every other open dialog, and every Esc-closing
 * layer (`data-escape-layer`, wherever it is: the page has the focus).
 */
export const OTHER_LAYER_SELECTOR = liveLayers('[role="menu"]', '[role="listbox"]', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[data-escape-layer]');

/**
 * Focus something else holds, which a composer focusing itself must leave
 * alone: any form control (a checkbox and a select too), or anything in an
 * open dialog, menu or list other than one the composer (`home`) sits in.
 */
export function focusIsTaken(home?: Element | null, active: Element | null = document.activeElement): boolean {
  if (!(active instanceof HTMLElement) || active === document.body) return false;
  const tag = active.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable) return true;
  const layer = active.closest(OTHER_LAYER_SELECTOR);
  return !!layer && !(home && layer.contains(home));
}

/**
 * Whether an Esc is still the page's to act on. Not once something took it
 * (its default prevented; the composer kept it for its own popup; an IME
 * composition ended), not when it was pressed inside the <name> panel or an
 * Esc layer (the find bar, the selection toolbar), and not while a menu, a
 * list or a modal is open: that takes the key, whichever listener happens to
 * run first. `'all'` is for the shell under everything: then an open drawer,
 * find bar or sidebar overlay keeps the key too. A drawer's own listener
 * passes the default (`'menus'`): other drawers don't stop it closing.
 */
export function escapeIsForPage(event: KeyboardEvent, layers: 'menus' | 'all' = 'menus'): boolean {
  if (!escapeUntaken(event)) return false;
  return !document.querySelector(layers === 'all' ? OTHER_LAYER_SELECTOR : MENU_LAYER_SELECTOR);
}

/**
 * Whether an Esc on the page closes the <name> panel lying over it (a narrow
 * window, DESIGN-v2 §1.2): the panel is on screen, nothing took the key, it
 * was not pressed inside the panel or an Esc layer, and no other layer is
 * open. The panel itself is not one of those layers, whatever role it has
 * over the page; a menu or dialog inside it is.
 */
export function escapeClosesPanelOverPage(event: KeyboardEvent): boolean {
  if (!escapeUntaken(event) || !companionPanelOnScreen()) return false;
  return !Array.from(document.querySelectorAll(OTHER_LAYER_SELECTOR)).some((layer) => !layer.matches(PANEL));
}

/** An Esc nothing took yet, pressed outside the panel and every Esc layer. */
function escapeUntaken(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || isImeComposing(event) || composerKeptEscape(event)) return false;
  const target = event.target instanceof Element ? event.target : null;
  return !target?.closest(`${PANEL}, [data-escape-layer]`);
}
