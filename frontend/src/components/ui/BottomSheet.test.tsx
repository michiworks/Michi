import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './BottomSheet';

describe('BottomSheet presence', () => {
  it('returns focus at close and drops away as an inert ghost that is no longer a dialog', async () => {
    const sheet = (open: boolean) => <><button type="button">Actions</button><BottomSheet open={open} onClose={() => {}} aria-label="Workspace actions"><button type="button">Rename</button></BottomSheet></>;
    const view = render(sheet(false));
    const opener = screen.getByRole('button', { name: 'Actions' });
    opener.focus();
    view.rerender(sheet(true));
    expect(screen.getByRole('dialog', { name: 'Workspace actions' })).toBeTruthy();
    view.rerender(sheet(false));
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    const ghost = document.querySelector('.ui-sheet');
    expect(ghost?.hasAttribute('inert')).toBe(true);
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(document.querySelector('.ui-sheet')).toBeNull());
    expect(document.querySelector('.ui-scrim--modal')).toBeNull();
  });

  it('closes on a tap that started on the scrim, not on the release of the opening press', () => {
    const close = vi.fn();
    render(<BottomSheet open onClose={close} aria-label="Actions">Content</BottomSheet>);
    const scrim = document.querySelector('.ui-scrim--modal') as HTMLElement;
    fireEvent.click(scrim);
    expect(close).not.toHaveBeenCalled();
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(close).toHaveBeenCalledOnce();
  });
});

class FakeViewport extends EventTarget {
  constructor(public height: number, public offsetTop: number, public scale: number) { super(); }
}

describe('BottomSheet over the on-screen keyboard', () => {
  afterEach(() => vi.unstubAllGlobals());

  function placement(viewport: FakeViewport) {
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('visualViewport', viewport);
    render(<BottomSheet open onClose={() => {}} aria-label="Actions">Content</BottomSheet>);
    const sheet = document.querySelector('.ui-sheet') as HTMLElement;
    return { bottom: sheet.style.bottom, maxHeight: sheet.style.maxHeight };
  }

  it('sits on the keyboard at scale 1', () => {
    expect(placement(new FakeViewport(500, 0, 1))).toEqual({ bottom: '300px', maxHeight: '488px' });
  });

  it('stays at the bottom of the visible region under a pinch zoom without a keyboard', () => {
    expect(placement(new FakeViewport(400, 0, 2))).toEqual({ bottom: '400px', maxHeight: '388px' });
  });

  it('still lifts above the keyboard while zoomed', () => {
    expect(placement(new FakeViewport(250, 100, 2))).toEqual({ bottom: '450px', maxHeight: '238px' });
  });

  it('keeps its stylesheet place when nothing covers the bottom edge', () => {
    expect(placement(new FakeViewport(800, 0, 1))).toEqual({ bottom: '', maxHeight: '' });
  });
});
