import { useEffect } from 'react';
import { toast } from 'sonner';
import { isImeComposing } from '../lib/ime';
import { IS_MAC } from '../lib/platform';
import { newestUndoAt, undoLatest } from '../state/undoStack';

/** ⌘Z on macOS, Ctrl+Z elsewhere; ⇧ (redo) and ⌥ chords are not undo. */
export function isUndoChord(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean {
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z');
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']);
const EDITABLE = '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const EDIT_EVENTS = ['input', 'paste', 'cut', 'drop'] as const;
const EDITING_KEYS = new Set(['Backspace', 'Delete', 'Enter']);

/** The text field `el` types into: an input or textarea, or the root of the contenteditable it sits in. */
export function textFieldOf(el: EventTarget | null): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) ? el : null;
  let root = el.closest<HTMLElement>(EDITABLE);
  for (let up = root?.parentElement?.closest<HTMLElement>(EDITABLE); up; up = up.parentElement?.closest<HTMLElement>(EDITABLE)) root = up;
  return root;
}

/**
 * Who gets ⌘Z. The field the caret is in keeps it when its own last edit is
 * newer than the app's newest action, so ⌘Z always undoes what the user did
 * last; otherwise the app takes it. A composer refocused after a reply has
 * nothing newer to undo, so ⌘Z there reaches the app.
 */
export function undoTarget(input: { fieldEditedAt: number | null; inField: boolean; newestUndoAt: number | null }): 'field' | 'app' {
  if (!input.inField) return 'app';
  if (input.newestUndoAt === null) return 'field';
  return input.fieldEditedAt !== null && input.fieldEditedAt >= input.newestUndoAt ? 'field' : 'app';
}

/**
 * Binds ⌘Z to the window's undo history (state/undoStack.ts). Listens in the
 * capture phase so it decides before a focused editor runs its own undo.
 * A terminal keeps every key (Ctrl+Z suspends its job), and while a modal
 * dialog is open ⌘Z never reaches what lies behind it.
 */
export function useUndoShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const editedAt = new WeakMap<HTMLElement, number>();
    const onEdit = (e: Event) => {
      const field = textFieldOf(e.target);
      if (field) editedAt.set(field, Date.now());
    };
    const onKey = (e: KeyboardEvent) => {
      // An editor's own keymap takes these and cancels them, so no input event says they edited.
      if (EDITING_KEYS.has(e.key) && !e.metaKey && !e.ctrlKey) onEdit(e);
      if (!isUndoChord(e) || e.defaultPrevented || isImeComposing(e)) return;
      const active = document.activeElement;
      if (active instanceof Element && active.closest('.xterm')) return;
      const field = textFieldOf(active);
      const newest = newestUndoAt();
      if (undoTarget({ inField: field !== null, fieldEditedAt: field ? editedAt.get(field) ?? null : null, newestUndoAt: newest }) === 'field') return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (newest === null) {
        toast('Nothing to undo', { id: 'undo-nothing' });
        return;
      }
      void undoLatest();
    };
    // An editor that handles a paste, cut or drop itself cancels it, so no input event follows either.
    for (const type of EDIT_EVENTS) document.addEventListener(type, onEdit, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      for (const type of EDIT_EVENTS) document.removeEventListener(type, onEdit, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [enabled]);
}
