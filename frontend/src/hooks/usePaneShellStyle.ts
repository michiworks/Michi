import { createElement, useMemo, useRef, type ReactElement } from 'react';
import { usePaneIsExiting, usePresentedPaneFocus } from '../components/terminal/PanePresentation';
import { useChatStore } from '../state/chatStore';
import { usePrefs } from '../state/prefs';

/**
 * How far an unfocused pane's surface sinks toward --term-recede-fill, 0–1:
 * focusDim (0–100) doubled and held at 1. The fill is the palette's deep
 * surface, one step from the pane rather than the black of the veil this
 * replaces, so the same strength needs the longer throw: the default 20 lands
 * where the black veil did, and past 50 the pane is already as deep as the
 * palette goes. The Topbar caption cell above each pane sinks by the same
 * amount, so the strip and the body stay one colour.
 */
export function paneRecedeOpacity(focusDim: number): number {
  return Math.min(1, (focusDim / 100) * 2);
}

/**
 * The pane's surface at `recede`: what a band that hides the pane's own
 * content behind its surface paints, so the band sinks with the body instead
 * of standing out as an unreceded strip. One colour, not the recede element,
 * because these bands sit over the content the recede sits under.
 */
export function paneSurface(recede: number): string {
  const pane = 'var(--term-pane-bg, var(--term-surface))';
  return recede > 0
    ? `color-mix(in srgb, var(--term-recede-fill) ${recede * 100}%, ${pane})`
    : pane;
}

export interface PaneShell {
  /** The pane root's style. */
  style: React.CSSProperties;
  /** The focus recede, rendered as the pane root's last child; null for a pane that never recedes. */
  recede: ReactElement | null;
  /** The pane's surface as the recede leaves it, for a band that paints over the pane's own content. */
  surface: string;
}

/**
 * The shared container of all pane types (TPane, DigestPane, FilePane, and
 * any future pane). Encapsulates:
 *
 *  - flex column layout
 *  - theme-driven border/radius/shadow
 *  - paneRules-gated right divider
 *  - focus recede: a `.terminal-pane__recede` element (index.css) under the
 *    pane's content, whose own opacity fades the palette's deep surface in
 *    over the pane's. Only the surface sinks — the text, code and controls
 *    the pane holds keep their own colours, where the black veil this
 *    replaces dimmed them along with it. An inherited custom property on the
 *    root would restyle the pane's whole subtree, its streaming transcript
 *    included, on every focus change; the one element confines that to itself.
 *
 * Consumers spread the style, optionally overriding specific properties, and
 * render the recede last:
 *
 *   const { style, recede } = usePaneShellStyle(nodeId);
 *   <div className="terminal-pane" style={{ ...style, borderLeft: '3px solid ...' }}>
 *     …
 *     {recede}
 *   </div>
 *
 * `dim: false` is for a pane that never takes the unfocused recede (an
 * embedded conversation, the browser pane whose native page cannot share it).
 */
export function usePaneShellStyle(nodeId: string, { dim = true }: { dim?: boolean } = {}): PaneShell {
  const { focusedPane } = useChatStore();
  const { prefs } = usePrefs();
  const { focusedPane: visualFocus } = usePresentedPaneFocus(focusedPane);
  const isFocused = visualFocus === nodeId || visualFocus == null;
  const exiting = usePaneIsExiting(nodeId);
  const recedeOpacity = dim && !isFocused ? paneRecedeOpacity(prefs.focusDim) : 0;

  const style = useMemo<React.CSSProperties>(
    () => ({
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--term-pane-bg, var(--term-surface))',
      border: 'var(--term-pane-border, none)',
      borderRight: prefs.paneRules
        ? 'var(--term-pane-divider, 1px solid var(--term-line))'
        : 'none',
      borderRadius: 'var(--term-pane-radius, 0px)',
      boxShadow: 'var(--term-pane-shadow, none)',
      minWidth: 0,
      minHeight: 0,
      height: '100%',
      overflow: 'hidden',
      fontFamily: 'var(--ui-font)',
      animation: 'none',
      // Its own stacking context, as the brightness() filter the recede
      // replaces made it. The recede sits on a negative rung, so the pane
      // must be the stacking context it paints inside: over the pane's own
      // surface, under everything the pane holds, and never behind the pane.
      isolation: dim ? 'isolate' : undefined,
      position: 'relative',
    }),
    [dim, prefs.paneRules],
  );
  const recede = useMemo(
    () => (dim ? createElement('div', { className: 'terminal-pane__recede', 'aria-hidden': true, style: { opacity: recedeOpacity } }) : null),
    [dim, recedeOpacity],
  );
  const surface = useMemo(() => paneSurface(recedeOpacity), [recedeOpacity]);
  const shell = useMemo<PaneShell>(() => ({ style, recede, surface }), [style, recede, surface]);
  const retained = useRef(shell);
  if (!exiting) retained.current = shell;
  return retained.current;
}
