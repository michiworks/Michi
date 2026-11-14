import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_PREFS } from '../../../state/prefs';
import { AppearancePane } from '../pages/settings/AppearancePane';
import { searchSettings, settingsSearchIndex } from './settingsSearch';
import {
  BACKGROUND_WORK_LABEL, SETTINGS_GROUPS, SETTINGS_PAGES, pageForSection, settingsPageForRequest, settingsPageLabel, settingsRevealForRequest, type SettingsPage,
} from './settingsPages';

vi.mock('../../../state/prefs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../state/prefs')>(),
  usePrefs: () => ({ prefs: DEFAULT_PREFS, setPref: () => {} }),
}));

const ALL_PAGES = Object.keys(SETTINGS_PAGES) as SettingsPage[];
const groupOf = (page: SettingsPage) => SETTINGS_GROUPS.find((group) => group.pages.includes(page))?.title ?? '';
const search = (query: string, pages = ALL_PAGES, name?: string) => searchSettings(query, pages, groupOf, { name });

describe('Settings pages', () => {
  it('has no Meta agent page: Settings › <name> is called by the agent’s name', () => {
    expect(ALL_PAGES).not.toContain('meta-agent');
    expect(settingsPageLabel('companion', 'Robin')).toBe('Robin');
    expect(settingsPageLabel('companion', '  ')).toBe('Michi');
    expect(settingsPageLabel('memory', 'Robin')).toBe('Memory');
  });

  it('lists every page in exactly one group', () => {
    const listed = SETTINGS_GROUPS.flatMap((group) => group.pages);
    expect([...listed].sort()).toEqual([...ALL_PAGES].sort());
  });

  it('groups pages by what they are about: the agent, the workspace, the app and its data', () => {
    expect(SETTINGS_GROUPS.map((group) => [group.title, group.pages])).toEqual([
      ['Agent', ['runtime', 'companion', 'memory', 'skills']],
      ['Workspace', ['machines', 'scheduled', 'links']],
      ['App', ['appearance', 'notifications', 'shortcuts', 'update', 'account']],
      ['Data', ['trash', 'archived', 'backup']],
    ]);
  });

  it('opens a page or one of the older sections a request names; the old Meta agent page is Settings › <name> › Background work', () => {
    expect(settingsPageForRequest('meta-agent')).toBe('companion');
    expect(pageForSection('meta-agent')).toBe('companion');
    expect(settingsRevealForRequest('meta-agent')).toBe(BACKGROUND_WORK_LABEL);
    expect(settingsRevealForRequest('companion', ' Name ')).toBe('Name');
    expect(settingsRevealForRequest('companion')).toBeNull();
    expect(settingsRevealForRequest('notifications', 42)).toBeNull();
    expect(settingsPageForRequest('companion')).toBe('companion');
    expect(settingsPageForRequest('links')).toBe('links');
    expect(settingsPageForRequest('trash')).toBe('trash');
    expect(settingsPageForRequest('general')).toBe('machines');
    expect(settingsPageForRequest('data')).toBe('backup');
    expect(settingsPageForRequest('nope')).toBeNull();
    expect(pageForSection('runtime')).toBe('runtime');
  });
});

describe('Settings search', () => {
  it('finds nothing for an empty query', () => {
    expect(search('  ')).toEqual([]);
  });

  it('puts names that start with the query first, then other matches in page order', () => {
    const results = search('sidebar');
    expect(results[0].label).toBe('Sidebar row style');
    expect(results.map((result) => result.label)).toEqual(expect.arrayContaining(['Sidebar row style', 'Density', 'Sidebar timestamps']));
    expect(search('sidebar time')[0].label).toBe('Sidebar timestamps');
  });

  it('matches descriptions, keywords and preference keys, and says where each setting is', () => {
    expect(search('yolo')[0]).toMatchObject({ page: 'runtime', label: 'Use global permissions', path: 'Agent › Runtime & model › Permissions' });
    expect(search('theme.codeWrap')[0]).toMatchObject({ label: 'Code wrap', path: 'App › Appearance › Advanced' });
    expect(search('theme.messageFontSize')[0]).toMatchObject({ label: 'Text size', path: 'App › Appearance › Reading' });
    expect(search('accent hue')[0]).toMatchObject({ label: 'Accent', path: 'App › Appearance › Theme' });
    expect(search('notify')[0]).toMatchObject({ page: 'notifications', path: 'App › Notifications' });
    expect(search('qr')[0]).toMatchObject({ page: 'machines', label: 'Phone access', path: 'Workspace › Machines' });
    expect(search('telemetry')).toEqual([]);
    expect(search('slash commands')[0]).toMatchObject({ page: 'skills', label: 'Library', path: 'Agent › Skills' });
    expect(search('plugin skills')[0]).toMatchObject({ page: 'skills', label: 'Runtime skills' });
    // Keyboard shortcuts are searchable by what they do.
    expect(search('command palette').map((result) => result.label)).toContain('Open command palette');
  });

  it('ignores case and accents, and every word must match', () => {
    expect(search('RÉDUCE Motion')[0].label).toBe('Reduce motion');
    expect(search('reduce zebra')).toEqual([]);
  });

  it('leaves a group out of the path on a page that shows only one group, as the page leaves out its title', () => {
    expect(search('open links in')[0]).toMatchObject({ page: 'links', group: 'Browser', path: 'Workspace › Links' });
    expect(search('scheduled job thread')[0]).toMatchObject({ page: 'scheduled', path: 'Workspace › Scheduled jobs' });
    // Machines shows two groups, and Trash its Cleanup beside the deleted items.
    expect(search('empty trash')[0]).toMatchObject({ path: 'Data › Trash › Cleanup' });
  });

  it('finds the block styles and glass settings under Advanced', () => {
    expect(search('agent block style')[0]).toMatchObject({ label: 'Agent blocks', path: 'App › Appearance › Advanced' });
    expect(search('theme.codeBlockStyle')[0]).toMatchObject({ label: 'Code blocks' });
    expect(search('glass').map((result) => result.label)).toEqual(expect.arrayContaining(['Sidebar glass', 'Glass blur', 'Glass saturation', 'Glass defaults']));
  });

  it('finds the settings that need window vibrancy only where the window has it', () => {
    expect(search('vibrancy').map((result) => result.label)).toEqual([]);
    expect(searchSettings('vibrancy', ALL_PAGES, groupOf, { vibrancy: true }).map((result) => result.label)).toEqual(['Window glass', 'Sidebar material']);
  });

  it('only searches the pages it is given', () => {
    expect(search('motion', ['notifications'])).toEqual([]);
  });

  it('names Appearance settings as the pane shows them, so a result can find its row', () => {
    // Window glass only shows in the macOS app, where the bridge has vibrancy.
    window.electron = { hasVibrancy: true } as unknown as typeof window.electron;
    try {
      render(<AppearancePane />);
      fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
      const shown = new Set(Array.from(document.querySelectorAll('.settings-row__label')).map((label) => label.textContent));
      const missing = settingsSearchIndex('Michi').filter((entry) => entry.page === 'appearance' && !shown.has(entry.label)).map((entry) => entry.label);
      expect(missing).toEqual([]);
    } finally {
      delete window.electron;
    }
  });

  it('shows Window glass only where the window can be see-through', () => {
    render(<AppearancePane />);
    expect(screen.queryByText('Window glass')).toBeNull();
  });

  it('finds Settings › <name> by its old names and its shortcut, under the agent’s name, and shows none of them', () => {
    for (const query of ['companion', 'assistant', '⌘J', 'check-in', 'meta agent', 'pages upkeep']) {
      const results = search(query, ALL_PAGES, 'Robin');
      expect(results.some((result) => result.page === 'companion'), query).toBe(true);
    }
    const upkeep = search('meta agent', ALL_PAGES, 'Robin');
    expect(upkeep.every((result) => result.page === 'companion')).toBe(true);
    expect(upkeep.map((result) => result.path)).toContain('Agent › Robin › Pages');
    expect(upkeep.map((result) => result.label)).toEqual(expect.arrayContaining(['Background work', 'Robin', 'Pages', 'First read', 'Keep workspace homes up to date']));
    // What a result shows (its name, description and path) never says Meta agent.
    for (const entry of settingsSearchIndex('Robin')) expect(`${entry.label} ${entry.description ?? ''} ${entry.group ?? ''}`).not.toMatch(/meta agent/i);
  });

  it('finds the switch that turns the agent on and off by its name first, and by the words people use', () => {
    expect(search('robin', ['companion'], 'Robin')[0]).toMatchObject({ page: 'companion', label: 'Robin', path: 'Agent › Robin' });
    for (const query of ['turn off', 'pause', 'resume']) expect(search(query, ['companion'], 'Robin')[0], query).toMatchObject({ label: 'Robin' });
    expect(search('automatic memory')[0]).toMatchObject({ page: 'memory', label: 'Learn from conversations', path: 'Agent › Memory' });
    expect(search('notification sounds')[0]).toMatchObject({ page: 'notifications', label: 'Sounds' });
  });

  it('names the agent’s two shortcuts by its name, and finds the moved background switch under Notifications', () => {
    expect(search('today', ['shortcuts'], 'Robin').map((result) => result.label)).toContain('Robin: Today');
    expect(search('open robin', ['shortcuts'], 'Robin')[0]).toMatchObject({ label: 'Open Robin', path: 'App › Keyboard shortcuts › Navigation (terminal)' });
    expect(search('keep michi running')[0]).toMatchObject({ page: 'notifications', path: 'App › Notifications › When Michi’s windows are closed' });
    expect(search('tray')[0]).toMatchObject({ page: 'notifications' });
  });
});
