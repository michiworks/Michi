import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TopbarIconButton } from './TopbarIconButton';

describe('TopbarIconButton', () => {
  it('announces what its on look means: a panel open, the page shown, or nothing', () => {
    const noop = () => {};
    render(<>
      <TopbarIconButton onClick={noop} label="Artifacts" tooltip="Artifacts" expanded>A</TopbarIconButton>
      <TopbarIconButton onClick={noop} label="Map" tooltip="Map" current>M</TopbarIconButton>
      <TopbarIconButton onClick={noop} label="Digest" tooltip="Digest" current={false}>D</TopbarIconButton>
      <TopbarIconButton onClick={noop} label="Sign in" tooltip="Sign in" active>K</TopbarIconButton>
    </>);
    const artifacts = screen.getByRole('button', { name: 'Artifacts', expanded: true });
    const map = screen.getByRole('button', { name: 'Map', current: 'page' });
    const digest = screen.getByRole('button', { name: 'Digest' });
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    expect([artifacts, map, digest, signIn].map((button) => button.classList.contains('is-on'))).toEqual([true, true, false, true]);
    expect(digest.hasAttribute('aria-current')).toBe(false);
    expect(['aria-pressed', 'aria-expanded', 'aria-current'].some((name) => signIn.hasAttribute(name))).toBe(false);
  });
});
