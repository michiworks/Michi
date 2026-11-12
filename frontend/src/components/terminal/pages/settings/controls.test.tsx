import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Radio, Segmented } from './controls';

describe('Settings Radio', () => {
  it('uses independently named native radio groups and exposes descriptive options', () => {
    const changed = vi.fn();
    render(<><Radio label="Notification level" value="all" onChange={changed} opts={[
      { value: 'all', label: 'All', description: 'Every completion.' }, { value: 'off', label: 'Off', description: 'No notifications.' },
    ]} /><Radio label="Density" value="compact" onChange={() => {}} opts={['compact', 'airy']} /></>);
    const group = screen.getByRole('radiogroup', { name: 'Notification level' });
    const all = within(group).getByRole('radio', { name: 'All' }) as HTMLInputElement;
    const off = within(group).getByRole('radio', { name: 'Off' }) as HTMLInputElement;
    expect(all.type).toBe('radio');
    expect(all.checked).toBe(true);
    expect(off.checked).toBe(false);
    expect(off.getAttribute('aria-describedby')).toBeTruthy();
    expect(all.name).toBe(off.name);
    expect(all.name).not.toBe((screen.getByRole('radio', { name: 'compact' }) as HTMLInputElement).name);
    off.focus();
    expect(document.activeElement).toBe(off);
    fireEvent.click(off);
    expect(changed).toHaveBeenCalledWith('off');
  });
});

describe('Settings Segmented', () => {
  it('is a named group of native radios, each named by its label', () => {
    const changed = vi.fn();
    render(<Segmented label="Density" value="comfortable" onChange={changed}
      opts={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }]} />);
    const group = screen.getByRole('radiogroup', { name: 'Density' });
    const [compact, comfortable] = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(compact.name).toBe(comfortable.name);
    expect(comfortable.checked).toBe(true);
    fireEvent.click(within(group).getByRole('radio', { name: 'Compact' }));
    expect(changed).toHaveBeenCalledExactlyOnceWith('compact');
  });
});
