import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { IS_MAC } from '../lib/platform';
import { recordUndo, resetUndoStackForTests } from '../state/undoStack';
import { isUndoChord, textFieldOf, undoTarget, useUndoShortcut } from './useUndoShortcut';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));

const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true };
function pressUndo(target: Element, extra: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true, ...mod, ...extra });
  target.dispatchEvent(event);
  return event;
}
function typeInto(field: HTMLElement) {
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000);
  resetUndoStackForTests();
  vi.mocked(toast).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('undoTarget', () => {
  it('gives ⌘Z to the app outside a field, and to the field when the app has nothing', () => {
    expect(undoTarget({ inField: false, fieldEditedAt: null, newestUndoAt: null })).toBe('app');
    expect(undoTarget({ inField: true, fieldEditedAt: null, newestUndoAt: null })).toBe('field');
  });

  it('gives ⌘Z in a field to whichever was done last', () => {
    expect(undoTarget({ inField: true, fieldEditedAt: 5, newestUndoAt: 3 })).toBe('field');
    expect(undoTarget({ inField: true, fieldEditedAt: 3, newestUndoAt: 5 })).toBe('app');
    // A composer focused after a reply, never typed in.
    expect(undoTarget({ inField: true, fieldEditedAt: null, newestUndoAt: 5 })).toBe('app');
  });
});

describe('isUndoChord and textFieldOf', () => {
  it('takes the platform’s undo chord, not redo or other chords', () => {
    expect(isUndoChord({ key: 'z', metaKey: IS_MAC, ctrlKey: !IS_MAC, shiftKey: false, altKey: false })).toBe(true);
    expect(isUndoChord({ key: 'Z', metaKey: IS_MAC, ctrlKey: !IS_MAC, shiftKey: true, altKey: false })).toBe(false);
    expect(isUndoChord({ key: 'z', metaKey: true, ctrlKey: true, shiftKey: false, altKey: false })).toBe(false);
    expect(isUndoChord({ key: 'z', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
  });

  it('finds the editor root a caret sits in, and no field for buttons or checkboxes', () => {
    document.body.innerHTML = '<div id="pm" contenteditable="true"><p><span id="in">x</span></p></div><button id="b"></button><input id="c" type="checkbox">';
    expect(textFieldOf(document.getElementById('in'))?.id).toBe('pm');
    expect(textFieldOf(document.getElementById('b'))).toBeNull();
    expect(textFieldOf(document.getElementById('c'))).toBeNull();
  });
});

describe('useUndoShortcut', () => {
  it('undoes the newest action from the page and stops the key there', () => {
    const undo = vi.fn();
    recordUndo({ label: 'Archived “A”', undo });
    renderHook(() => useUndoShortcut(true));
    const event = pressUndo(document.body);
    expect(event.defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('says there is nothing to undo when the history is empty', () => {
    renderHook(() => useUndoShortcut(true));
    pressUndo(document.body);
    expect(toast).toHaveBeenCalledWith('Nothing to undo', { id: 'undo-nothing' });
  });

  it('leaves ⌘Z to a field typed in after the newest action, and takes it back once the action is newer', () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const field = document.getElementById('t')!;
    field.focus();
    const undo = vi.fn();
    renderHook(() => useUndoShortcut(true));
    recordUndo({ label: 'Archived “A”', undo });
    vi.setSystemTime(2_000);
    typeInto(field);
    expect(pressUndo(field).defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();

    vi.setSystemTime(3_000);
    recordUndo({ label: 'Renamed “B”', undo });
    expect(pressUndo(field).defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('counts a Backspace or a paste the editor handles itself as typing in the field', () => {
    document.body.innerHTML = '<div id="pm" contenteditable="true" tabindex="0"><p>draft</p></div>';
    const composer = document.getElementById('pm')!;
    composer.focus();
    const undo = vi.fn();
    recordUndo({ label: 'Archived “A”', undo });
    renderHook(() => useUndoShortcut(true));
    vi.setSystemTime(2_000);
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    expect(pressUndo(composer).defaultPrevented).toBe(false);
    vi.setSystemTime(3_000);
    recordUndo({ label: 'Renamed “B”', undo });
    vi.setSystemTime(4_000);
    composer.dispatchEvent(new Event('paste', { bubbles: true }));
    expect(pressUndo(composer).defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });

  it('reaches the app from an auto-focused composer nobody typed in', () => {
    document.body.innerHTML = '<div id="pm" contenteditable="true" tabindex="0"><p>draft</p></div>';
    const composer = document.getElementById('pm')!;
    composer.focus();
    expect(document.activeElement).toBe(composer);
    const undo = vi.fn();
    recordUndo({ label: 'Archived “A”', undo });
    renderHook(() => useUndoShortcut(true));
    expect(pressUndo(composer).defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalled();
  });

  it('never takes the key from a terminal, behind a modal dialog, or while disabled', () => {
    const undo = vi.fn();
    recordUndo({ label: 'Archived “A”', undo });
    document.body.innerHTML = '<div class="xterm"><textarea id="term"></textarea></div><button id="page"></button>';
    const { rerender } = renderHook(({ on }) => useUndoShortcut(on), { initialProps: { on: true } });
    const term = document.getElementById('term')!;
    term.focus();
    expect(pressUndo(term).defaultPrevented).toBe(false);

    const page = document.getElementById('page')!;
    page.focus();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    expect(pressUndo(page).defaultPrevented).toBe(false);
    dialog.remove();

    rerender({ on: false });
    expect(pressUndo(page).defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });

  it('runs one undo for a held-down chord', () => {
    const undo = vi.fn();
    recordUndo({ label: 'A', undo });
    recordUndo({ label: 'B', undo });
    renderHook(() => useUndoShortcut(true));
    pressUndo(document.body);
    expect(pressUndo(document.body, { repeat: true }).defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
