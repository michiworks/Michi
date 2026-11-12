import type { Input } from 'electron';

type PaneShortcutInput = Pick<Input, 'type' | 'key' | 'meta' | 'control' | 'shift' | 'alt'>;
/** Matches the shared BrowserShellChord that main sends on. */
type ShellChord = Pick<Input, 'key' | 'meta' | 'control' | 'shift' | 'alt'>;

/**
 * ⌘ on macOS, Ctrl elsewhere, never both. A Browser pane cannot tell whether
 * the page is typing, so macOS Ctrl chords (Ctrl+T transposes) stay the page's.
 */
function platformModifier(input: PaneShortcutInput, platform: NodeJS.Platform): boolean {
  return platform === 'darwin'
    ? input.meta && !input.control
    : input.control && !input.meta;
}

/**
 * Native WebContentsViews do not bubble keyboard events into the host renderer.
 * Match the host shell's close-pane shortcut without stealing modified variants
 * such as Shift+Cmd+W (which remains the native Close Window accelerator).
 */
export function isClosePaneShortcut(input: PaneShortcutInput, platform = process.platform): boolean {
  if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'w' || input.shift || input.alt) return false;
  return platformModifier(input, platform);
}

/**
 * The other shell chords a focused Browser pane hands back for the renderer to
 * replay: pane cycling, new thread, the assistant and Settings. ⌘K and ⌘[ ⌘]
 * stay the page's, since sites use them for their own palette and history.
 */
export function forwardedShellChord(input: PaneShortcutInput, platform = process.platform): ShellChord | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const key = input.key.toLowerCase();
  const forwarded = key === 'tab'
    ? input.control && !input.meta
    : !input.shift && platformModifier(input, platform) && (key === 't' || key === 'j' || key === ',');
  return forwarded
    ? { key: input.key, meta: input.meta, control: input.control, shift: input.shift, alt: input.alt }
    : null;
}
