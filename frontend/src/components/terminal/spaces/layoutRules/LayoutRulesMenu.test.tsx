import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageLayoutRule } from 'michi-shared';
import { noteCompanionTurnEnded, resetCompanionStoreForTests } from '../../../../state/companion/companionStore';
import { subscribePageChanges, type PageEventIdentity } from '../../../../state/pages/pageEvents';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), remove: vi.fn() }));
vi.mock('../../../../services/api/spacesHome', () => ({ fetchLayoutRules: mocks.fetch, deleteLayoutRule: mocks.remove, fetchLayoutPreferences: vi.fn().mockResolvedValue({ text: '', revision: 0, updatedAt: null, updatedBy: null }), saveLayoutPreferences: vi.fn() }));

import { LayoutRulesMenuButton } from './LayoutRulesMenu';
import { layoutRuleMeta } from './LayoutRulesPopover';

const NOW = Date.UTC(2026, 9, 23, 12);
const stalled: PageLayoutRule = {
  id: 'rule-1', text: 'Stalled: only the last 3 days', createdBy: 'agent', createdAt: NOW - 2 * 3_600_000,
  sourceMessage: { nodeId: 'n', turnId: 't', messageId: 'm' }, sectionLimit: { section: 'stalled', maxAgeDays: 3 },
};
const lead: PageLayoutRule = { id: 'rule-2', text: 'Lead with the release', createdBy: 'user', createdAt: NOW - 3 * 86_400_000, sourceMessage: null };

function openList() {
  fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Layout preferences/ }));
  return screen.getByRole('dialog', { name: 'Layout preferences' });
}

describe('Layout rules in the ⋯ menu', () => {
  let changed: PageEventIdentity[];
  let stopChanges = () => {};

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    resetCompanionStoreForTests();
    mocks.fetch.mockReset().mockResolvedValue([stalled, lead]);
    mocks.remove.mockReset().mockImplementation(async () => { mocks.fetch.mockResolvedValue([lead]); return [lead]; });
    changed = [];
    stopChanges = subscribePageChanges({ backendConnectionId: 'local' }, (identity) => changed.push(identity));
  });
  afterEach(() => {
    stopChanges();
    vi.useRealTimers();
  });

  it('counts the rules in the menu and lists each with what it binds', async () => {
    render(<LayoutRulesMenuButton pageId="pg-home" backendConnectionId="local" />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith('pg-home', 'local', expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
    const entry = await screen.findByRole('menuitem', { name: /Layout preferences/ });
    await waitFor(() => expect(within(entry).getByText('2')).toBeTruthy());
    fireEvent.click(entry);
    const list = screen.getByRole('dialog', { name: 'Layout preferences' });
    const rows = within(list).getAllByTestId('layout-rule');
    expect(rows.map((row) => row.querySelector('.michi-doc-menu__title')?.textContent)).toEqual(['Stalled: only the last 3 days', 'Lead with the release']);
    expect(rows[0].textContent).toContain('Stalled · applied by Michi · from your message to the assistant · 2h ago');
    expect(rows[1].textContent).toContain('followed by Michi · added by you · 3d ago');
    expect(document.activeElement).toBe(within(rows[0]).getByRole('button', { name: 'Delete rule: Stalled: only the last 3 days' }));
  });

  it('deletes a rule and tells the page\'s readers, so the counted sections re-lay out', async () => {
    render(<LayoutRulesMenuButton pageId="pg-home" backendConnectionId="local" />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    const list = openList();
    await waitFor(() => expect(within(list).getAllByTestId('layout-rule')).toHaveLength(2));
    fireEvent.click(within(list).getByRole('button', { name: 'Delete rule: Stalled: only the last 3 days' }));
    await waitFor(() => expect(within(list).getAllByTestId('layout-rule')).toHaveLength(1));
    expect(mocks.remove).toHaveBeenCalledWith('pg-home', 'rule-1', 'local');
    expect(changed).toContainEqual({ backendConnectionId: 'local', pageId: 'pg-home' });
  });

  it('says a failed delete in the list, and offers no Delete on a read-only page', async () => {
    mocks.remove.mockRejectedValueOnce(new Error('Archived workspace is read-only'));
    const { rerender } = render(<LayoutRulesMenuButton pageId="pg-home" backendConnectionId="local" />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    let list = openList();
    await waitFor(() => expect(within(list).getAllByTestId('layout-rule')).toHaveLength(2));
    fireEvent.click(within(list).getByRole('button', { name: 'Delete rule: Lead with the release' }));
    await waitFor(() => expect(within(list).getByRole('alert').textContent).toBe("Couldn't delete: Archived workspace is read-only"));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Layout preferences' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Page actions' }));

    rerender(<LayoutRulesMenuButton pageId="pg-home" backendConnectionId="local" readOnly />);
    list = openList();
    for (const button of within(list).getAllByRole('button', { name: /Delete rule/ })) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows how to add one when the page has none', async () => {
    mocks.fetch.mockResolvedValue([]);
    render(<LayoutRulesMenuButton pageId="pg-home" backendConnectionId="local" />);
    const list = openList();
    await waitFor(() => expect(list.textContent).toContain('No layout rules yet. Ask Michi, for example “Stalled: only the last 3 days”.'));
  });

  it('keeps the editable document open and retains its draft when the window resizes', async () => {
    render(<LayoutRulesMenuButton pageId="pg-home" backendConnectionId="local" />);
    const list = openList();
    const input = await within(list).findByRole('textbox', { name: 'Layout preferences' });
    fireEvent.change(input, { target: { value: 'Keep risks first' } });
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('dialog', { name: 'Layout preferences' })).toBe(list);
    expect(input).toHaveProperty('value', 'Keep risks first');
  });

  it('stays under its ⋯ button while the page scrolls', async () => {
    render(<LayoutRulesMenuButton pageId="pg-home" backendConnectionId="local" />);
    const button = screen.getByRole('button', { name: 'Page actions' });
    let top = 100;
    vi.spyOn(button, 'getBoundingClientRect').mockImplementation(() => ({ left: 600, right: 628, top, bottom: top + 28, width: 28, height: 28, x: 600, y: top, toJSON() {} }));
    const list = openList();
    expect(list.style.top).toBe('132px');
    top = 40;
    fireEvent.scroll(window);
    expect(screen.getByRole('dialog', { name: 'Layout preferences' })).toBe(list);
    expect(list.style.top).toBe('72px');
  });

  it('reads the rules again after a turn of the agent’s conversation and re-lays out the page when they changed', async () => {
    mocks.fetch.mockResolvedValueOnce([]);
    resetCompanionStoreForTests({ assistant: { status: 'ready', error: null, info: { workspaceId: 'w', nodeId: 'n', treeId: 't', settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] } } });
    render(<LayoutRulesMenuButton pageId="pg-home" backendConnectionId="local" />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    // What the chat store calls when a turn in V ends (F1a-review #7), panel shown or not.
    const turnEnded = () => noteCompanionTurnEnded('n');
    await act(async () => { turnEnded(); });
    await waitFor(() => expect(changed).toEqual([{ backendConnectionId: 'local', pageId: 'pg-home' }]));
    const reads = mocks.fetch.mock.calls.length;
    await act(async () => { turnEnded(); });
    await waitFor(() => expect(mocks.fetch.mock.calls.length).toBeGreaterThan(reads));
    // The same rules again announce nothing.
    expect(changed).toHaveLength(1);
  });

  it('describes a user rule with no time', () => {
    expect(layoutRuleMeta({ ...lead, createdAt: NOW }, 'Robin', NOW)).toBe('followed by Robin · added by you · just now');
  });
});
