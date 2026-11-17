const COMPOSER_EDITOR = '.terminal-composer [role="textbox"][contenteditable="true"]';

/**
 * Where the keyboard goes when a control that edits the conversation closes
 * and nothing takes its place (states.md ST-10): the composer of the pane
 * that holds `within`. It is focused at once, in the commit that removes the
 * control (TipTap's own focus waits a frame, which leaves <body> focused in
 * between). False when that pane has no editable composer.
 */
export function focusPaneComposer(within: Element | null | undefined): boolean {
  const editor = within?.closest('.terminal-pane')?.querySelector<HTMLElement>(COMPOSER_EDITOR);
  if (!editor) return false;
  editor.focus({ preventScroll: true });
  return document.activeElement === editor;
}
