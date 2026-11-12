/**
 * Keys an input method still owns. Safari sends the key that ends a
 * composition after compositionend, without isComposing, as keyCode 229.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChecklistEditor, TextBlockEditor } from './BlockEditor';

const SAFARI_IME = { keyCode: 229 };

describe('block editors and an input method', () => {
  it('keeps a one-line block editing on the Enter or Esc that ends a composition', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<TextBlockEditor label="Heading" initial="发布" multiline={false} onSave={onSave} onCancel={onCancel} />);
    const line = screen.getByRole('textbox');
    fireEvent.change(line, { target: { value: '发布计划' } });
    fireEvent.keyDown(line, { key: 'Enter', ...SAFARI_IME });
    fireEvent.keyDown(line, { key: 'Escape', ...SAFARI_IME });
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(line, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('发布计划', true, undefined);
  });

  it('adds no to-do on the Enter that ends a composition', () => {
    render(<ChecklistEditor label="Checklist" title="" items={[{ text: 'mai', done: false }]} onSave={vi.fn()} onCancel={vi.fn()} />);
    const item = screen.getByRole('textbox', { name: 'Item 1' });
    fireEvent.keyDown(item, { key: 'Enter', ...SAFARI_IME });
    expect(screen.queryByRole('textbox', { name: 'Item 2' })).toBeNull();
    fireEvent.keyDown(item, { key: 'Enter' });
    expect(screen.getByRole('textbox', { name: 'Item 2' })).toBeTruthy();
  });
});
