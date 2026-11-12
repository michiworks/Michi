import { useMemo, useRef } from 'react';
import { usePaneIsExiting, usePresentedPaneFocus } from '../components/terminal/PanePresentation';
import { useChatStore } from '../state/chatStore';
import { usePrefs } from '../state/prefs';

/**
 * How dark an unfocused pane's veil is, 0–1: focusDim (0–100) scaled by 0.6,
 * the factor the brightness() filter it replaces used. The Topbar caption cell
 * above each pane still dims with brightness(1 - this), which a black veil at
 * this opacity matches exactly, so the strip and the body stay one color.
 */
export function paneDimOpacity(focusDim: number): number {
  return (focusDim / 100) * 0.6;
}

/**
 * Computes the shared container style for all pane types (TPane, DigestPane,
 * FilePane, and any future pane). Encapsulates:
 *
 *  - flex column layout
 *  - theme-driven border/radius/shadow
 *  - paneRules-gated right divider
 *  - focus dim: `--pane-dim`, read by the `.terminal-pane::after` veil in
 *    index.css (every consumer's root carries `.terminal-pane`)
 *
 * Consumers spread the result and optionally override specific properties:
 *
 *   const shellStyle = usePaneShellStyle(nodeId);
 *   <div className="terminal-pane" style={{ ...shellStyle, borderLeft: '3px solid ...' }}>
 *
 * `dim: false` is for a pane that never takes the unfocused dim (an embedded
 * conversation, the browser pane whose native page cannot share it).
 */
export function usePaneShellStyle(nodeId: string, { dim = true }: { dim?: boolean } = {}): React.CSSProperties {
  const { focusedPane } = useChatStore();
  const { prefs } = usePrefs();
  const { focusedPane: visualFocus } = usePresentedPaneFocus(focusedPane);
  const isFocused = visualFocus === nodeId || visualFocus == null;
  const exiting = usePaneIsExiting(nodeId);
  const dimOpacity = dim && !isFocused ? paneDimOpacity(prefs.focusDim) : 0;

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
      // Unfocused panes dim with a black veil (index.css .terminal-pane::after)
      // rather than filter: brightness() over the whole subtree, which ran
      // the filter over the pane again whenever its content changed (every
      // streamed frame). The veil fades with the same --t-soft/--t-ease.
      '--pane-dim': dimOpacity,
      // Its own stacking context, as the filter made it while dimmed: the
      // veil's z-index then lifts it over the pane's raised children (find
      // bar, drop overlays) and nothing outside the pane.
      isolation: dim ? 'isolate' : undefined,
      position: 'relative',
    }),
    [dim, dimOpacity, prefs.paneRules],
  );
  const retained = useRef(style);
  if (!exiting) retained.current = style;
  return retained.current;
}
