import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsPageLabelContext } from './settingsPhone';
import { SettingsRow, SettingsSection } from './SettingsSection';

const repeats = (name: string) => screen.getByRole('region', { name }).hasAttribute('data-title-repeats');

describe('SettingsSection', () => {
  it('does not show a title that repeats the page’s, or its one row’s, and keeps it as the group’s name', () => {
    render(
      <SettingsPageLabelContext.Provider value="Notifications">
        <SettingsSection title="Notifications"><SettingsRow label="Sounds" /></SettingsSection>
        <SettingsSection title="Name"><SettingsRow label="Name" /></SettingsSection>
        <SettingsSection title="Check-ins"><SettingsRow label="Check-ins" /><SettingsRow label="Morning brief" /></SettingsSection>
        <SettingsSection title="Watching"><SettingsRow label="Email" /></SettingsSection>
      </SettingsPageLabelContext.Provider>,
    );
    expect(repeats('Notifications')).toBe(true);
    expect(repeats('Name')).toBe(true);
    // Two rows: the title names the group, not the first of them.
    expect(repeats('Check-ins')).toBe(false);
    expect(repeats('Watching')).toBe(false);
  });

  it('shows every title outside a Settings page', () => {
    render(<SettingsSection title="Notifications"><SettingsRow label="Sounds" /></SettingsSection>);
    expect(repeats('Notifications')).toBe(false);
  });
});
