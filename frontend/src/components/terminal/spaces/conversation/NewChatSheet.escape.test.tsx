/**
 * Esc in the "Start a task" sheet with the real composer (TipTap /
 * ProseMirror, which prevents the default of every Escape): it closes the
 * sheet unless the composer kept the key for an IME composition, or the
 * workspace menu is open.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../state/chatStore', () => ({
  useChatProjects: () => ({
    activeProjectId: 'w1',
    agentStatus: { label: 'Kiro', availableRuntimes: [{ id: 'kiro', label: 'Kiro' }] },
    projects: [{ id: 'w1', name: 'sample-project' }, { id: 'w2', name: 'agent-desk' }],
  }),
  useChatActions: () => ({ revealBackendNode: vi.fn() }),
  useNodesSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
}));
vi.mock('../../../../state/assistant/systemWorkspace', () => ({ isSystemWorkspace: () => false }));
vi.mock('../../../../services/api/spacesHome', () => ({ dismissProgressCard: vi.fn() }));
vi.mock('../../../../state/pages/useSpacesHome', () => ({
  useProgressCards: () => ({ data: [], status: 'ready', error: null, stale: false, refresh: vi.fn() }),
}));

import { NewChatSheetSlot } from './SpaceConversationSlot';
import { openNewChatSheet, resetSpaceConversationsForTests } from '../../../../state/spaceConversations/store';

const scope = { backendConnectionId: 'local', pageId: 'p1', workspaceId: 'w1', workspaceName: 'sample-project', pageTitle: 'Plan' };
const sheet = () => screen.queryByRole('region', { name: 'Start a task' });

/** A real Escape: ProseMirror reads keyCode 27. */
const escape = (target: Element, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: 'Escape', code: 'Escape', keyCode: 27, ...init });

async function openSheet() {
  render(<NewChatSheetSlot scope={scope} />);
  act(() => { openNewChatSheet({ text: '跑完回滚用例' }); });
  const region = await screen.findByRole('region', { name: 'Start a task' });
  const editor = await waitFor(() => {
    const dom = region.querySelector<HTMLElement>('.ProseMirror');
    expect(dom).toBeTruthy();
    return dom!;
  });
  await waitFor(() => expect(document.activeElement).toBe(editor));
  return { region, editor };
}

beforeEach(() => {
  resetSpaceConversationsForTests();
});

describe('Esc in the Start a task sheet, real composer', () => {
  it('closes the sheet from the composer', async () => {
    const { editor } = await openSheet();
    const event = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
    act(() => { editor.dispatchEvent(event); });
    // ProseMirror took the default; the sheet closes all the same.
    expect(event.defaultPrevented).toBe(true);
    expect(sheet()).toBeNull();
  });

  it('leaves an Esc that ends an IME composition to the composition', async () => {
    const { editor } = await openSheet();
    escape(editor, { isComposing: true, keyCode: 229 });
    expect(sheet()).not.toBeNull();
    // Safari: the Escape that ends a composition comes after compositionend.
    escape(editor, { isComposing: false, keyCode: 229 });
    expect(sheet()).not.toBeNull();
    expect(editor.textContent).toContain('跑完回滚用例');
    escape(editor);
    expect(sheet()).toBeNull();
  });

  it('leaves the Esc to an open workspace menu', async () => {
    const { region } = await openSheet();
    fireEvent.click(within(region).getByRole('button', { name: 'Workspace: sample-project' }));
    const item = within(screen.getByRole('menu', { name: 'Start the chat in' })).getAllByRole('menuitem')[0];
    await waitFor(() => expect(document.activeElement).toBe(item));
    escape(item);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(sheet()).not.toBeNull();
  });
});
