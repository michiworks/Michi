/**
 * An Esc that dismisses an input method's candidates (Chromium: isComposing;
 * Safari: keyCode 229 after compositionend) belongs to the composition, not
 * to the dialog, drawer or sheet around the field. A plain Esc still closes.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModalShell } from './ModalShell';
import { DrawerShell } from './DrawerShell';
import { BottomSheet } from './BottomSheet';

type Shell = (props: { onClose: () => void; children: React.ReactNode }) => React.ReactElement;
const SHELLS: Array<[string, Shell]> = [
  ['ModalShell', ({ onClose, children }) => <ModalShell open onClose={onClose} motion="none" glass="live" aria-label="New page">{children}</ModalShell>],
  ['ModalShell with captureEscape', ({ onClose, children }) => <ModalShell open onClose={onClose} motion="none" glass="live" captureEscape aria-label="New page">{children}</ModalShell>],
  ['DrawerShell', ({ onClose, children }) => <DrawerShell open onClose={onClose} title="Artifacts">{children}</DrawerShell>],
  ['BottomSheet', ({ onClose, children }) => <BottomSheet open onClose={onClose} aria-label="Rename">{children}</BottomSheet>],
];

describe.each(SHELLS)('%s and an IME Esc', (_name, Shell) => {
  it.each([{ isComposing: true }, { keyCode: 229 }])('stays open and keeps the draft (%o)', (ime) => {
    const onClose = vi.fn();
    render(<Shell onClose={onClose}><input aria-label="Name" defaultValue="zhong" /></Shell>);
    const field = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.keyDown(field, { key: 'Escape', ...ime });
    expect(onClose).not.toHaveBeenCalled();
    expect(field).toHaveProperty('value', 'zhong');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
