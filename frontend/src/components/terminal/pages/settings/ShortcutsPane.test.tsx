import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resetCompanionStoreForTests } from '../../../../state/companion/companionStore';
import { companionSnapshot } from '../../../../test/companionFixtures';
import { ShortcutsPane } from './ShortcutsPane';

afterEach(() => resetCompanionStoreForTests());

function nameAgent(displayName: string) {
  const snapshot = companionSnapshot();
  resetCompanionStoreForTests({ snapshot: { ...snapshot, settings: { ...snapshot.settings, displayName } } });
}

const keysOf = (label: string) => screen.getByText(label).closest('.settings-shortcut-row')!.querySelector('.settings-shortcut-row__keys')!.textContent;

describe('Settings › Keyboard shortcuts', () => {
  it('lists ⌘J and ⇧⌘J by the agent’s name, and follows a rename', () => {
    render(<ShortcutsPane />);
    // Before a snapshot the agent has its default name.
    expect(keysOf('Open Michi')).toMatch(/^(⌘J|Ctrl\+J)$/);
    expect(keysOf('Michi: Today')).toMatch(/^(⇧⌘J|Shift\+Ctrl\+J)$/);
    act(() => nameAgent('Robin'));
    expect(screen.getByText('Open Robin')).toBeTruthy();
    expect(screen.getByText('Robin: Today')).toBeTruthy();
    expect(screen.queryByText(/Companion/)).toBeNull();
  });
});
