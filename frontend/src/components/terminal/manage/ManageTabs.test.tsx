import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
