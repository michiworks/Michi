import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { companionSnapshot, jsonResponse } from '../../test/companionFixtures';
import { resetCompanionPanelForTests } from './companionPanel';
import {
  noteCompanionComposing,
  preemptCompanionTurn,
  resetCompanionPresenceForTests,
  startCompanionPresence,
} from './companionPresence';
import { resetCompanionStoreForTests } from './companionStore';

let beacons: Array<Record<string, unknown>>;
let status: number;
let panelInput: HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers();
  beacons = [];
  status = 204;
  resetCompanionPresenceForTests();
  resetCompanionStoreForTests({ snapshot: companionSnapshot() });
  resetCompanionPanelForTests({ open: true, tab: 'chat' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    beacons.push(JSON.parse(String(init?.body)));
    return jsonResponse(status === 204 ? null : { error: 'Not found' }, status);
  }));
  const panel = document.createElement('div');
  panel.setAttribute('data-companion-panel', '');
  panelInput = document.createElement('input');
  panel.append(panelInput);
  document.body.append(panel);
});

afterEach(() => {
  resetCompanionPresenceForTests();
  resetCompanionStoreForTests();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the Companion presence beacon', () => {
  it('says the user is here, and that they are writing to the Companion at once', () => {
    const release = startCompanionPresence();
    expect(beacons).toEqual([{ active: true, companionFocused: false, lastInputAt: expect.any(Number), composing: false }]);
    panelInput.focus();
    noteCompanionComposing(true);
    // Within the 5s gap, composing still goes out right away.
    expect(beacons.at(-1)).toMatchObject({ companionFocused: true, composing: true });
    const sent = beacons.length;
    noteCompanionComposing(true);
    expect(beacons).toHaveLength(sent);
    noteCompanionComposing(false);
    expect(beacons).toHaveLength(sent);
    vi.advanceTimersByTime(5_000);
    expect(beacons.at(-1)).toMatchObject({ companionFocused: true, composing: false });
    release();
  });

  it('repeats composing while the user keeps typing, every 10s at most', () => {
    const release = startCompanionPresence();
    panelInput.focus();
    noteCompanionComposing(true);
    const sent = beacons.length;
    vi.advanceTimersByTime(9_000);
    noteCompanionComposing(true);
    expect(beacons).toHaveLength(sent);
    vi.advanceTimersByTime(1_000);
    noteCompanionComposing(true);
    expect(beacons).toHaveLength(sent + 1);
    release();
  });

  it('Stop tells the backend at once that the user goes first', () => {
    const release = startCompanionPresence();
    const sent = beacons.length;
    preemptCompanionTurn();
    expect(beacons).toHaveLength(sent + 1);
    expect(beacons.at(-1)).toMatchObject({ composing: true });
    release();
  });

  it('stops sending to a backend that has no beacon route', async () => {
    status = 404;
    const release = startCompanionPresence();
    await vi.advanceTimersByTimeAsync(0);
    const sent = beacons.length;
    panelInput.focus();
    noteCompanionComposing(true);
    preemptCompanionTurn();
    vi.advanceTimersByTime(120_000);
    expect(beacons).toHaveLength(sent);
    release();
  });

  it('sends nothing for a backend without a Companion', () => {
    resetCompanionStoreForTests({ availability: 'unavailable' });
    const release = startCompanionPresence();
    noteCompanionComposing(true);
    expect(beacons).toEqual([]);
    release();
  });
});
