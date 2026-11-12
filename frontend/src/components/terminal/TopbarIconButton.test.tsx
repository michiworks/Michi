import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TopbarIconButton } from './TopbarIconButton';

describe('TopbarIconButton', () => {
  it('shows its hint on hover and on keyboard focus, and drops it on press', () => {
    render(<TopbarIconButton onClick={() => {}} label="Map" tooltip="Map" tooltipKbd="⌘M"><svg /></TopbarIconButton>);
    const button = screen.getByRole('button', { name: 'Map' });
    fireEvent.mouseEnter(button);
    expect(screen.getByRole('tooltip').textContent).toBe('Map⌘M');
    fireEvent.pointerDown(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseLeave(button);
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.focus(button);
    expect(screen.getByRole('tooltip').textContent).toBe('Map⌘M');
    fireEvent.blur(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows no hint while disabled', () => {
    render(<TopbarIconButton onClick={() => {}} label="Artifacts" tooltip="Artifacts" disabled><svg /></TopbarIconButton>);
    const button = screen.getByRole('button', { name: 'Artifacts' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.mouseEnter(button);
    fireEvent.focus(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
