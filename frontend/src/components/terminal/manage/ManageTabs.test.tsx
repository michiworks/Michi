import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ManageTabs from './ManageTabs';

const props = { activeTab: 'chats' as const, onChange: () => {}, counts: { chats: 1, artifacts: 0, digests: 0 }, filter: '', onFilterChange: () => {} };

describe('ManageTabs search', () => {
  it('leaves keyboard focus its ring', () => {
    render(<ManageTabs {...props} />);
    expect(screen.getByRole('textbox', { name: 'Search this workspace' }).style.outline).toBe('');
  });

  it('is the shared search field on a phone', () => {
    render(<ManageTabs {...props} compact />);
    const input = screen.getByRole('textbox', { name: 'Search this workspace' });
    expect(input.closest('label')?.className).toBe('ui-search');
    expect(input.style.outline).toBe('');
  });
});

describe('ManageTabs tabs', () => {
  it('are one tab stop that the arrow keys move along, selecting as they go', () => {
    const onChange = vi.fn();
    render(<ManageTabs {...props} activeTab="artifacts" onChange={onChange} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Artifacts0');
    fireEvent.keyDown(tabs[1], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('digests');
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('chats');
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(document.activeElement).toBe(tabs[2]);
  });
});
