import { useEffect, useRef } from 'react';

/**
 * The phone's Back: one stack that the back swipe (right from the left
 * screen edge), the system Back (Android's gesture or button, through the
 * browser history) and the topbar's back button all step through.
 *
 * An open layer (a drawer, a modal, a sheet, a menu, the narrow sidebar)
 * registers what Back does to it: close it, or step back inside it. The
 * newest open overlay is on top; the shell's page history is one `page`
 * layer under every overlay. Menus and lists the app closes on any Esc
 * (escapeLayers.ts) need no entry: Back sends them an Esc first.
 */

/** What a back swipe drags when it is not an edge arrow. */
export interface BackSwipePanel {
  /** The element that follows the finger to the right. */
  panel: () => HTMLElement | null;
  /**
   * 'owner': committing hands the element, where the finger left it, to its
   * owner's own exit transition (a drawer slides on out). 'slide': the
   * swipe slides it out, steps back, and puts it back for what comes next
   * (the page).
   */
  exit: 'owner' | 'slide';
}

export interface BackLayer {
  /** Goes back one step: closes the layer, or steps back inside it. */
  back: () => void;
  /** Default 'overlay'. A 'page' layer sits under every overlay. */
  level?: 'page' | 'overlay';
  /**
   * What a back swipe drags. Omitted: an arrow at the edge follows the
   * finger. false: the swipe leaves this layer alone (system Back only).
   */
  swipe?: BackSwipePanel | false;
}

/** Open layers, oldest first. */
const entries: Array<() => BackLayer> = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

/** Registers a layer (read through `layer()` when Back runs). Returns its removal. */
export function registerBackLayer(layer: () => BackLayer): () => void {
  const entry = () => layer();
  entries.push(entry);
  notify();
  return () => {
    // Each registration is its own entry, even for the same function.
    const index = entries.indexOf(entry);
    if (index < 0) return;
    entries.splice(index, 1);
    notify();
  };
}

/** Called when a layer opens or closes. */
export function subscribeBackLayers(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The layer Back steps: the newest overlay, else the page. */
export function topBackLayer(): BackLayer | null {
  const rank = (layer: BackLayer) => (layer.level === 'page' ? 0 : 1);
  let top: BackLayer | null = null;
  for (const entry of entries) {
    const layer = entry();
    if (!top || rank(layer) >= rank(top)) top = layer;
  }
  return top;
}

/** A layer on its way out is gone already (escapeLayers.ts LIVE). */
const LIVE = ':not([inert], [inert] *, [aria-hidden="true"], [aria-hidden="true"] *)';
/** What closes on any Esc while it is up: menus, lists, the selection toolbar. */
const ESC_LAYER_SELECTOR = ['[role="menu"]', '[role="listbox"]', '[data-escape-layer="over"]'].map((s) => s + LIVE).join(', ');
const MODAL_SELECTOR = `[aria-modal="true"]${LIVE}`;

export function escLayerOpen(): boolean {
  return !!document.querySelector(ESC_LAYER_SELECTOR);
}

/** A modal is up (one nobody registered cannot be dismissed: the swipe leaves it alone). */
export function modalOpen(): boolean {
  return !!document.querySelector(MODAL_SELECTOR);
}

/** Closes the open menu or list the way a key press would: they all close on any Esc. */
function sendEscape() {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

type BackTarget =
  | { kind: 'escape'; back: () => void }
  | { kind: 'layer'; layer: BackLayer; back: () => void };

/**
 * What Back acts on now: an open menu or list, else the top layer. Null
 * when there is nothing to go back to, or when a modal nobody registered
 * (one that cannot be dismissed) sits over the page.
 */
export function backTarget(): BackTarget | null {
  if (escLayerOpen()) return { kind: 'escape', back: sendEscape };
  const layer = topBackLayer();
  if (!layer) return null;
  if (layer.level === 'page' && modalOpen()) return null;
  return { kind: 'layer', layer, back: () => layer.back() };
}

/** Whether any layer is registered (the system Back then has somewhere to go). */
export function hasBackLayer(): boolean {
  return entries.length > 0;
}

/**
 * Registers a layer while `active`. The layer's fields are read when Back
 * runs, so callers can pass a fresh object every render.
 */
export function useBackLayer(active: boolean, layer: BackLayer): void {
  const ref = useRef(layer);
  ref.current = layer;
  useEffect(() => {
    if (!active) return;
    return registerBackLayer(() => ref.current);
  }, [active]);
}
