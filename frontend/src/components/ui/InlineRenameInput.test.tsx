import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlineRenameInput } from './InlineRenameInput';

function renderField(blur?: 'commit' | 'cancel') {
  const onCommit = vi.fn();
  const onEnd = vi.fn();
  render(<InlineRenameInput aria-label="Name" value="Plan" onCommit={onCommit} onEnd={onEnd} blur={blur} />);
  return { onCommit, onEnd, field: screen.getByRole('textbox', { name: 'Name' }) };
}

describe('InlineRenameInput', () => {
  it('saves a changed name once, trimmed, however the field is left', () => {
    const { onCommit, onEnd, field } = renderField();
    fireEvent.change(field, { target: { value: '  Release plan ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Release plan');
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it.each(['Plan', '  Plan ', '   '])('saves nothing for %j, an unchanged or empty name', (value) => {
    const { onCommit, onEnd, field } = renderField();
    fireEvent.change(field, { target: { value } });
    fireEvent.blur(field);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('gives up on leaving when blur is cancel', () => {
    const { onCommit, onEnd, field } = renderField('cancel');
    fireEvent.change(field, { target: { value: 'Release plan' } });
    fireEvent.blur(field);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
  });
});
