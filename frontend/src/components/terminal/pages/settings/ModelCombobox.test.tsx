import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelCombobox } from './ModelCombobox';

const models = Array.from({ length: 12 }, (_, index) => ({ id: `model-${index}`, label: `Model ${index}` }));

describe('ModelCombobox', () => {
  it('fades its list out as a ghost that takes no keys, and a reopen mounts a fresh list', async () => {
    render(<>
      <span id="model-label">Model</span>
      <ModelCombobox id="model" labelId="model-label" value="model-0" models={models} searchable placeholder="Default" onSelect={() => {}} />
    </>);
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.click(trigger);
    const first = screen.getByRole('searchbox', { name: 'Filter models' });
    fireEvent.change(first, { target: { value: 'Model 1' } });
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Models' })).toBeNull();
    expect(first.closest('[aria-hidden="true"]')).not.toBeNull();
    // The window under the fading list gets the next Esc.
    const underneath = vi.fn();
    window.addEventListener('keydown', underneath);
    fireEvent.keyDown(window, { key: 'Escape' });
    window.removeEventListener('keydown', underneath);
    expect(underneath).toHaveBeenCalledOnce();

    fireEvent.click(trigger);
    const second = screen.getByRole('searchbox', { name: 'Filter models' }) as HTMLInputElement;
    expect(second).not.toBe(first);
    expect(second.value).toBe('');
    expect(document.activeElement).toBe(second);
    await waitFor(() => expect(first.isConnected).toBe(false));
  });
});
