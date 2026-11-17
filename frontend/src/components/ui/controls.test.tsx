import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Button, Switch } from './controls';

describe('Button', () => {
  it('while busy keeps focus, takes no press or submit, and names itself by its in-flight label', () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    cleanup();
    render(<form onSubmit={onSubmit}><Button type="submit" busy busyLabel="Saving…" onClick={onClick}>Save</Button></form>);
    const button = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(false);
  });
});

describe('Switch', () => {
  it('toggles and reports the flipped value, stopping propagation', () => {
    const onChange = vi.fn();
    const parentClick = vi.fn();
    cleanup();
    render(
      <div onClick={parentClick}>
        <Switch on={false} onChange={onChange} aria-label="Feature" />
      </div>,
    );
    const sw = screen.getByRole('switch', { name: 'Feature' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    // stopPropagation → the wrapping row's handler must not also fire.
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('stays focusable and ignores presses while its save is in flight', () => {
    const onChange = vi.fn();
    cleanup();
    render(<Switch on={false} busy onChange={onChange} aria-label="Feature" />);
    const sw = screen.getByRole('switch', { name: 'Feature' }) as HTMLButtonElement;
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    // Native disabled would drop keyboard focus to the page.
    expect(sw.disabled).toBe(false);
  });
});
