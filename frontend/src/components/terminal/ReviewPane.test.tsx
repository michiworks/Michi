import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../lib/electronBridge', () => ({ getElectron: () => undefined }));
vi.mock('../../hooks/usePaneShellStyle', () => ({ usePaneShellStyle: () => ({}) }));
vi.mock('./useSideColumn', () => ({ useSideColumn: () => ({ columns: '1fr 200px', columnRef: { current: null }, handle: null }) }));
const store = vi.hoisted(() => ({ projects: [{ id: 'p1', name: 'P', cwd: '/repo', chatIds: [], edges: [], createdAt: 1, trees: [], activeTreeId: null }] }));
vi.mock('../../state/chatStore', () => ({
  useChatProjects: () => store,
  useChatActions: () => ({ focusPane: vi.fn(), setFocusedNodeId: vi.fn() }),
}));

import ReviewPane from './ReviewPane';

describe('ReviewPane filter', () => {
  it('is the shared search field, so keyboard focus shows its ring', () => {
    render(<ReviewPane item={{ id: 'pane:review:1', kind: 'review', projectId: 'p1', title: 'Review', createdAt: 1 } as never} />);
    const input = screen.getByRole('textbox', { name: 'Filter changes' });
    expect(input.closest('label')?.className).toBe('ui-search ui-search--compact');
    expect(input.getAttribute('style')).toBeNull();
  });
});
