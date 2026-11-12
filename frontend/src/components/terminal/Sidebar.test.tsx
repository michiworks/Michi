import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import TerminalSidebar from './Sidebar';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import { clearRemoteRecoveryIssue, reportRemoteRecoveryFailure, REMOTE_RECOVERY_GRACE_MS } from '../../state/remoteRecovery';
import { OPEN_SETTINGS_SECTION_EVENT } from './scheduled/metaAgent/metaAgentNav';

function wrap(ui: React.ReactElement) {
  return (
    <PrefsProvider>
      <ChatProvider>{ui}</ChatProvider>
    </PrefsProvider>
  );
}

describe('TerminalSidebar narrow drawer entry points', () => {
  it('closes the drawer before its Search opens the palette', () => {
    const calls: string[] = [];
    render(
      wrap(
        <TerminalSidebar
          activePage="dashboard"
          workspaceReady
          onNav={() => {}}
          narrowMode
          narrowOverlayOpen
          onCloseOverlay={() => calls.push('close')}
          onOpenPalette={() => calls.push('palette')}
          onNewThread={() => calls.push('new')}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(calls).toEqual(['new', 'close', 'palette']);
  });
});

describe('TerminalSidebar BottomNav', () => {
  it('leaves New chat and Search to the Topbar in a wide window, and carries them in the narrow drawer', () => {
    const onNewThread = vi.fn();
    const onOpenPalette = vi.fn();
    const ui = (narrow: boolean) => wrap(
      <TerminalSidebar
        activePage="dashboard"
        onNav={() => {}}
        onOpenPalette={onOpenPalette}
        onNewThread={onNewThread}
        narrowMode={narrow}
        narrowOverlayOpen={narrow}
      />,
    );
    const { rerender } = render(ui(false));
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();

    // The drawer's scrim covers the Topbar: New chat (⌘T, which opens Home) and Search (⌘K).
    rerender(ui(true));
    const newChat = screen.getByRole('button', { name: 'New chat' });
    expect(newChat.textContent).toContain('T');
    fireEvent.click(newChat);
    expect(onNewThread).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it('leaves Home, Workspaces, Scheduled, Spaces, Settings and Skills to other entry points', () => {
    render(wrap(<TerminalSidebar activePage="dashboard" customAgentsEnabled onNav={() => {}} />));
    expect(screen.getByText('Agents')).toBeTruthy();
    // Home is the logo, ⌘0 and New chat; Workspaces is "All N ›" on the Projects header.
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Workspaces' })).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByText('Scheduled')).toBeNull();
    expect(screen.queryByText('Spaces')).toBeNull();
    // Skills are managed in Settings.
    expect(screen.queryByText('Skills')).toBeNull();
    // Branches / Map / Digest / Artifacts are thread-scoped views — their
    // entries moved to the Topbar right cluster (Artifacts removed 1a1348d0).
    expect(screen.queryByText('Branches')).toBeNull();
    expect(screen.queryByText('Map')).toBeNull();
    expect(screen.queryByText('Digest')).toBeNull();
    expect(screen.queryByText('Artifacts')).toBeNull();
  });

  it.each([false, true])('switches between By project and Recent with the view tabs (narrow: %s)', (narrow) => {
    render(wrap(<TerminalSidebar activePage="dashboard" onNav={() => {}} narrowMode={narrow} narrowOverlayOpen={narrow} />));
    const tablist = screen.getByRole('tablist', { name: 'Sidebar view' });
    const byProject = within(tablist).getByRole('tab', { name: 'By project' });
    const recent = within(tablist).getByRole('tab', { name: 'Recent' });
    const panel = screen.getByRole('tabpanel');
    expect(byProject.getAttribute('aria-selected')).toBe('true');
    expect(recent.getAttribute('aria-selected')).toBe('false');
    expect(panel.getAttribute('aria-labelledby')).toBe(byProject.id);
    // One tab stop for the pair; the arrows move between them.
    expect(byProject.tabIndex).toBe(0);
    expect(recent.tabIndex).toBe(-1);

    fireEvent.click(recent);
    expect(recent.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(recent.id);
    // Recent is the Activity view.
    expect(document.querySelector('.activity-view')).not.toBeNull();

    fireEvent.keyDown(recent, { key: 'ArrowRight' });
    expect(byProject.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(byProject);
    expect(document.querySelector('.activity-view')).toBeNull();
    // The topbar's old toggle has no copy in the sidebar.
    expect(screen.queryByRole('button', { name: 'Activity view' })).toBeNull();
  });

  it('shows a machine that went offline in the foot and opens Settings on Machines from it', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-10T10:00:00Z') });
    const opened = vi.fn();
    const onSection = (event: Event) => opened((event as CustomEvent<{ section?: string }>).detail?.section);
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onSection);
    try {
      render(wrap(<TerminalSidebar activePage="dashboard" onNav={() => {}} />));
      expect(screen.queryByRole('button', { name: /offline/ })).toBeNull();

      act(() => {
        reportRemoteRecoveryFailure(
          { id: 'cplus', name: 'c+', transport: 'ssh', sshHost: 'c-plus.example', hasToken: false, createdAt: 0, updatedAt: 0 },
          new Error('ssh: connect timed out'),
        );
      });
      // A blip inside the recovery grace period stays quiet, as the topbar's does.
      expect(screen.queryByRole('button', { name: /offline/ })).toBeNull();

      act(() => { vi.advanceTimersByTime(REMOTE_RECOVERY_GRACE_MS + 1); });
      const chip = screen.getByRole('button', { name: 'c+ offline, open Machines settings' });
      expect(chip.textContent).toBe('c+ offline');
      expect(chip.querySelector('.sidebar-conn-chip__dot')).not.toBeNull();
      fireEvent.click(chip);
      expect(opened).toHaveBeenCalledWith('machines');

      act(() => { clearRemoteRecoveryIssue('cplus'); });
      expect(screen.queryByRole('button', { name: /offline/ })).toBeNull();
    } finally {
      window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onSection);
      clearRemoteRecoveryIssue('cplus');
      vi.useRealTimers();
    }
  });

  it('slides the narrow drawer out as a ghost that is no longer a layer', async () => {
    const onClose = vi.fn();
    const ui = (open: boolean) => wrap(
      <TerminalSidebar activePage="dashboard" onNav={() => {}} narrowMode narrowOverlayOpen={open} onCloseOverlay={onClose} />,
    );
    const { container, rerender } = render(ui(false));
    expect(container.querySelector('aside')).toBeNull();

    rerender(ui(true));
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.dataset.escapeLayer).toBe('shell');
    expect(aside.getAttribute('aria-hidden')).toBeNull();
    const scrim = aside.previousElementSibling as HTMLElement;
    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(ui(false));
    // While it leaves: no Esc layer, out of the accessibility tree, inert, and
    // its scrim no longer closes anything.
    // (Exits resolve a frame later even with skipAnimations, setupTests.ts.)
    const ghost = container.querySelector('aside') as HTMLElement;
    expect(ghost).toBe(aside);
    expect(ghost.dataset.escapeLayer).toBeUndefined();
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[data-escape-layer]')).toBeNull();
    fireEvent.mouseDown(ghost.previousElementSibling as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(container.querySelector('aside')).toBeNull());
    expect(container.childElementCount).toBe(0);
  });

  it('closes the narrow drawer at once when a destination inside it is chosen', async () => {
    // The shell closes the drawer from the same click (handleNavWithClose).
    function Shell() {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen((value) => !value)}>Toggle drawer</button>
          <TerminalSidebar activePage="dashboard" customAgentsEnabled onNav={() => setOpen(false)} narrowMode narrowOverlayOpen={open} onCloseOverlay={() => setOpen(false)} />
        </>
      );
    }
    const { container } = render(wrap(<Shell />));
    expect(container.querySelector('aside')).not.toBeNull();

    // Switching views is not a destination: the drawer stays.
    fireEvent.click(screen.getByRole('tab', { name: 'Recent' }));
    expect(container.querySelector('aside')?.getAttribute('aria-hidden')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'By project' }));

    // A tap on a destination: no ghost, so the page it opens is the only copy.
    fireEvent.click(screen.getByText('Agents'));
    expect(container.querySelector('aside')).toBeNull();

    // Reopen, then choose with the keyboard.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle drawer' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Agents' }), { key: 'Enter' });
    expect(container.querySelector('aside')).toBeNull();

    // A dismissal from outside the drawer still slides it out.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle drawer' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle drawer' }));
    expect(container.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(container.querySelector('aside')).toBeNull());
  });

  it('quiets sidebar scrollbars until the pointer enters, then lingers for 2s', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        wrap(
          <TerminalSidebar
            activePage="dashboard"
            onNav={() => {}}
            onOpenPalette={() => {}}
            onNewThread={() => {}}
          />,
        ),
      );
      const aside = container.querySelector('aside') as HTMLElement | null;
      expect(aside).not.toBeNull();
      expect(aside!.dataset.scrollbars).toBe('quiet');

      fireEvent.pointerEnter(aside!);
      expect(aside!.dataset.scrollbars).toBe('visible');

      fireEvent.pointerLeave(aside!);
      expect(aside!.dataset.scrollbars).toBe('visible');
      act(() => { vi.advanceTimersByTime(1999); });
      expect(aside!.dataset.scrollbars).toBe('visible');
      act(() => { vi.advanceTimersByTime(1); });
      expect(aside!.dataset.scrollbars).toBe('quiet');
    } finally {
      vi.useRealTimers();
    }
  });
});
