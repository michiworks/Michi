import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANION_NAME } from 'michi-shared';
import { companionSnapshot } from '../../test/companionFixtures';
import { adoptCompanionSnapshot, resetCompanionStoreForTests, updateCompanionSnapshot } from './companionStore';
import { companionNameNow, companionNameOf, useCompanionName } from './companionName';

afterEach(() => resetCompanionStoreForTests());

const named = (displayName: string) => companionSnapshot({ settings: { ...companionSnapshot().settings, displayName } });

describe('the agent’s name in this window’s labels', () => {
  it('is Michi before any snapshot arrives, and on a backend without a Companion', () => {
    expect(DEFAULT_COMPANION_NAME).toBe('Michi');
    resetCompanionStoreForTests();
    expect(companionNameNow()).toBe('Michi');
    resetCompanionStoreForTests({ availability: 'unavailable' });
    expect(companionNameNow()).toBe('Michi');
  });

  it('is the name the user gave it; the default settings and a blank name read as Michi', () => {
    resetCompanionStoreForTests({ snapshot: named('Robin') });
    expect(companionNameNow()).toBe('Robin');
    expect(companionNameOf(companionSnapshot())).toBe('Michi');
    expect(companionNameOf(named('   '))).toBe('Michi');
    expect(companionNameOf(null)).toBe('Michi');
  });

  it('re-renders a label when the name changes, not on every snapshot', () => {
    resetCompanionStoreForTests({ snapshot: named('Robin') });
    let renders = 0;
    const view = renderHook(() => {
      renders += 1;
      return useCompanionName();
    });
    expect(view.result.current).toBe('Robin');
    const before = renders;
    act(() => updateCompanionSnapshot((current) => ({ ...current, counts: { ...current.counts, unreadMessages: 3 } })));
    expect(renders).toBe(before);
    act(() => adoptCompanionSnapshot(named('Nova')));
    expect(view.result.current).toBe('Nova');
  });
});
