import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SpacesSettings } from './SpacesSettings';

vi.mock('../settings/metaAgent/MetaAgentSettings', () => ({ PagesUpkeepSettings: () => <p>Pages upkeep form</p> }));
vi.mock('./components/ComponentsSettings', () => {
  const pending = new Promise(() => {});
  return { ComponentsSettings: () => { throw pending; } };
});

// First: the settings load once per test file, so only the first render shows the loading line.
it('shows Pages upkeep, by that name while it loads, never as the Meta agent', async () => {
  render(<SpacesSettings onBack={vi.fn()} />);
  expect(screen.getByRole('status').textContent).toBe('Loading Pages upkeep…');
  expect(await screen.findByText('Pages upkeep form')).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/meta agent/i);
});

it('keeps Pages settings navigation available while the component library is loading', async () => {
  const onBack = vi.fn();
  render(<SpacesSettings onBack={onBack} />);
  expect(await screen.findByText('Pages upkeep form')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Browse components' }));
  expect(screen.getByRole('status').textContent).toBe('Loading components…');
  fireEvent.click(screen.getByRole('button', { name: /Back to settings/ }));
  expect(await screen.findByText('Pages upkeep form')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Back to Pages/ }));
  expect(onBack).toHaveBeenCalledOnce();
});
