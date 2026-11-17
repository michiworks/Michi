import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../state/chatStore', () => ({
  useChatProjects: () => ({ activeProject: { id: 'workspace-1', activeTreeId: 'tree-1' }, agentStatus: {} }),
  useChatPanes: () => ({ openPanes: ['n1', 'n2'], focusedPane: 'n1', paneItems: {} }),
  useChatActions: () => ({ closePane: vi.fn(), setPaneWidth: vi.fn(), openAgentRunPane: vi.fn() }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({ n1: { kind: 'chat' }, n2: { kind: 'chat' } }),
  shallowArrayEqual: <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index])),
}));
vi.mock('../../../state/agentDomain', () => ({
  useAgentDomain: () => ({ state: { runs: {}, eventsByRun: {}, interactionsByRun: {} }, loadRuns: vi.fn(async () => undefined), subscribeWorkspace: vi.fn(() => vi.fn()) }),
}));
vi.mock('../../../state/prefs', () => ({ usePrefs: () => ({ prefs: { singlePaneContentWidth: null, defaultPaneWidth: 480, paneWidthMode: 'adaptive' } }) }));
vi.mock('../../../services/api', () => ({ getAgentRunDetail: vi.fn(), getWebUploadCwd: vi.fn(), importWorkspaceFileUpload: vi.fn(), respondAgentRunInteraction: vi.fn() }));
vi.mock('../../../lib/electronBridge', () => ({ getElectron: () => null }));
vi.mock('../TPane', () => ({ default: ({ nodeId }: { nodeId: string }) => <div data-testid={`pane-${nodeId}`} /> }));
vi.mock('../assistant/AssistantLinks', () => ({ AssistantPaneScope: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import TerminalDashboard from './Dashboard';

const observers: Array<{ callback: IntersectionObserverCallback; root: Element | Document | null | undefined }> = [];
class RecordingObserver {
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    observers.push({ callback, root: options?.root });
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal('IntersectionObserver', RecordingObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  observers.length = 0;
});

describe('Dashboard panes off the strip', () => {
  it('marks a pane scrolled off the strip, and its top-bar caption, for the loop pause until it comes back', () => {
    const { container } = render(
      <div className="terminal-shell">
        <div data-pane-captions><div data-pane-caption-id="n1" /><div data-pane-caption-id="n2" /></div>
        <TerminalDashboard />
      </div>,
    );
    const strip = container.querySelector<HTMLElement>('.terminal-dashboard')!;
    const pane = strip.querySelector<HTMLElement>(':scope > [data-node-id="n2"]')!;
    const caption = container.querySelector<HTMLElement>('[data-pane-caption-id="n2"]')!;
    const report = (isIntersecting: boolean) => act(() => {
      const observer = observers.filter((entry) => entry.root === strip).at(-1)!;
      observer.callback([{ target: pane, isIntersecting } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    report(false);
    expect(pane.hasAttribute('data-offstrip')).toBe(true);
    expect(caption.hasAttribute('data-offstrip')).toBe(true);
    expect(strip.querySelector('[data-node-id="n1"]')!.hasAttribute('data-offstrip')).toBe(false);
    report(true);
    expect(pane.hasAttribute('data-offstrip')).toBe(false);
    expect(caption.hasAttribute('data-offstrip')).toBe(false);
  });
});
