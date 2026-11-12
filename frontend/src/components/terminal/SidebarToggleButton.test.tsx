import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SidebarToggleButton from './SidebarToggleButton';
import { kbd } from '../../lib/platform';

describe('SidebarToggleButton', () => {
  it('reports the sidebar as expanded while it is open', () => {
    const { rerender } = render(
      <SidebarToggleButton collapsed={false} onToggle={() => {}} />,
    );
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.hasAttribute('aria-pressed')).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Collapse sidebar');

    rerender(<SidebarToggleButton collapsed={true} onToggle={() => {}} />);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Open sidebar');
  });

  it('shows its hint with the shortcut on keyboard focus, like the rest of the bar', () => {
    render(<SidebarToggleButton collapsed={false} onToggle={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Collapse sidebar' });
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.focus(btn);
    expect(screen.getByRole('tooltip').textContent).toBe(`Collapse sidebar${kbd('mod', 'B')}`);
    expect(btn.hasAttribute('title')).toBe(false);
  });
});
