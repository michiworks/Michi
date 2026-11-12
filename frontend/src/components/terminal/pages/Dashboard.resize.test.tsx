import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaneDragWidth } from '../paneDragWidth';

const mocks = vi.hoisted(() => ({ setPaneWidth: vi.fn() }));

vi.mock('../../../state/chatStore', () => ({
  useChatProjects: () => ({ activeProject: { id: 'workspace-1', activeTreeId: 'tree-1' }, agentStatus: {} }),
  useChatPanes: () => ({ openPanes: ['n1', 'n2'], focusedPane: 'n1', paneItems: {} }),
  useChatActions: () => ({ closePane: vi.fn(), setPaneWidth: mocks.setPaneWidth, openAgentRunPane: vi.fn() }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({ n1: { kind: 'chat', paneWidth: 500 }, n2: { kind: 'chat' } }),
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

function DragWidth() {
  const drag = usePaneDragWidth();
  return <output data-testid="drag-width">{drag ? `${drag.id}:${drag.width}` : 'none'}</output>;
}

beforeEach(() => {
  mocks.setPaneWidth.mockClear();
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(cleanup);

describe('Dashboard pane edge drag', () => {
  it('shares the live width with the topbar during the drag and saves it once on release', async () => {
    const { container, rerender } = render(<><TerminalDashboard /><DragWidth /></>);
    // The handle reads the pane element captured on the render after mount.
    rerender(<><TerminalDashboard /><DragWidth /></>);
    const pane = container.querySelector<HTMLElement>('.terminal-dashboard > [data-node-id="n1"]')!;
    pane.getBoundingClientRect = () => ({ width: 500 } as DOMRect);
    const handle = pane.querySelector<HTMLElement>(':scope > [title^="Drag to resize"]')!;
    handle.setPointerCapture = vi.fn();

    // jsdom has no PointerEvent; a MouseEvent carries the pointer's x.
    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 600 }));
    for (const x of [620, 640, 660]) {
      await act(async () => {
        handle.dispatchEvent(new MouseEvent('pointermove', { clientX: x }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    }
    expect(screen.getByTestId('drag-width').textContent).toBe('n1:560');
    expect(mocks.setPaneWidth).not.toHaveBeenCalled();

    act(() => { handle.dispatchEvent(new MouseEvent('pointerup', { clientX: 660 })); });
    expect(mocks.setPaneWidth).toHaveBeenCalledTimes(1);
    expect(mocks.setPaneWidth).toHaveBeenCalledWith('n1', 560);
    expect(screen.getByTestId('drag-width').textContent).toBe('none');
  });
});
