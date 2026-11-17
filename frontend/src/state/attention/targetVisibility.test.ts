import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetCompanionPanelForTests } from '../companion/companionPanel';
import { resetCompanionStoreForTests } from '../companion/companionStore';
import { setDashboardUncovered, setPanePresenceDashboardVisible } from '../panePresenceVisibility';
import { isNodeShownInWindow, isPaneSeenInWindow, isPaneShownInWindow } from './targetVisibility';

function box(left: number, width: number): DOMRect {
  return { left, right: left + width, width, top: 0, bottom: 100, height: 100, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
}

/** A Dashboard strip 1000px wide holding the given panes. */
function paintStrip(panes: Array<{ id: string; left?: number; width?: number; hidden?: boolean; exiting?: boolean }>): void {
  const strip = document.createElement('div');
  strip.setAttribute('data-pane-strip', '');
  strip.getBoundingClientRect = () => box(0, 1000);
  for (const pane of panes) {
    const wrapper = document.createElement('div');
    wrapper.dataset.nodeId = pane.id;
    if (pane.hidden) wrapper.setAttribute('aria-hidden', 'true');
    if (pane.exiting) wrapper.setAttribute('data-pane-exiting', '');
    wrapper.getBoundingClientRect = () => box(pane.left ?? 0, pane.width ?? 500);
    strip.appendChild(wrapper);
  }
  document.body.appendChild(strip);
}

beforeEach(() => {
  setPanePresenceDashboardVisible(true);
  resetCompanionStoreForTests();
  resetCompanionPanelForTests();
});

afterEach(() => {
  document.body.innerHTML = '';
  setPanePresenceDashboardVisible(false);
  setDashboardUncovered(false);
  resetCompanionStoreForTests();
  resetCompanionPanelForTests();
});

describe('target visibility in this window', () => {
  it('needs the Dashboard page and the pane open in the active layout', () => {
    expect(isPaneShownInWindow('a', ['a'])).toBe(true);
    expect(isPaneShownInWindow('a', ['b'])).toBe(false);
    setPanePresenceDashboardVisible(false);
    expect(isPaneShownInWindow('a', ['a'])).toBe(false);
  });

  it('trusts the painted strip: hidden, exiting or scrolled-away panes are not shown', () => {
    paintStrip([
      { id: 'on', left: 0 },
      { id: 'mostly-on', left: 700 },
      { id: 'mostly-away', left: 750 },
      { id: 'away', left: 1200 },
      { id: 'phone-hidden', hidden: true },
      { id: 'closing', exiting: true },
      { id: 'wide', left: -200, width: 1400 },
    ]);
    const open = ['on', 'mostly-on', 'mostly-away', 'away', 'phone-hidden', 'closing', 'wide', 'unpainted'];
    // 60% of a pane inside the strip counts, as Dashboard's own paneOnScreen.
    expect(open.filter((id) => isPaneShownInWindow(id, open))).toEqual(['on', 'mostly-on', 'wide', 'unpainted']);
    // Without the layout's pane list (a server-decided notice), only what the strip paints.
    expect(open.filter((id) => isPaneShownInWindow(id))).toEqual(['on', 'mostly-on', 'wide']);
    setPanePresenceDashboardVisible(false);
    expect(open.filter((id) => isPaneShownInWindow(id))).toEqual([]);
  });

  it('for a saved view mark, needs the Dashboard uncovered and the pane laid out on screen', () => {
    paintStrip([
      { id: 'on', left: 0 },
      { id: 'away', left: 1200 },
      { id: 'phone-hidden', hidden: true },
      { id: 'unmeasured', width: 0 },
    ]);
    const open = ['on', 'away', 'phone-hidden', 'unmeasured', 'unpainted'];
    expect(open.filter((id) => isPaneSeenInWindow(id, open)), 'something lies over the Dashboard').toEqual([]);
    setDashboardUncovered(true);
    // Unlike isPaneShownInWindow, a pane not laid out yet does not count.
    expect(open.filter((id) => isPaneSeenInWindow(id, open))).toEqual(['on']);
    expect(isPaneSeenInWindow('on', ['away']), 'not open in the active layout').toBe(false);

    const confirm = document.createElement('div');
    confirm.setAttribute('aria-modal', 'true');
    document.body.appendChild(confirm);
    expect(isPaneSeenInWindow('on', open), 'a modal the shell does not own lies over it').toBe(false);
    confirm.setAttribute('aria-hidden', 'true');
    expect(isPaneSeenInWindow('on', open), 'the modal is on its way out').toBe(true);
  });

  it('counts a conversation the assistant panel shows, whatever the Dashboard shows', () => {
    setPanePresenceDashboardVisible(false);
    expect(isNodeShownInWindow('n-sys', [])).toBe(false);
    resetCompanionStoreForTests({
      assistant: {
        status: 'ready',
        info: { nodeId: 'n-sys', workspaceId: 'sys', treeId: 't-sys', settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] },
        error: null,
      },
    });
    // Loaded but closed, or open on Today, the panel does not show the conversation.
    expect(isNodeShownInWindow('n-sys', [])).toBe(false);
    resetCompanionPanelForTests({ open: true, tab: 'today' });
    expect(isNodeShownInWindow('n-sys', [])).toBe(false);
    resetCompanionPanelForTests({ open: true, tab: 'chat' });
    expect(isNodeShownInWindow('n-sys', [])).toBe(true);
  });
});
