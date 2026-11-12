import React from 'react';
import { renderHook } from '@testing-library/react';
import { MotionConfig } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, smoothScrollBehavior, useReducedMotion } from './useReducedMotion';

function stubOs(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.reduceMotion;
});

describe('prefersReducedMotion', () => {
  it.each([
    [false, false, false],
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ])('with Michi\'s Reduce motion %s and the OS setting %s reduces: %s', (app, os, reduced) => {
    stubOs(os);
    if (app) document.documentElement.dataset.reduceMotion = 'on';
    expect(prefersReducedMotion()).toBe(reduced);
    expect(smoothScrollBehavior()).toBe(reduced ? 'auto' : 'smooth');
  });

  it('still honours an app setting the caller passes', () => {
    stubOs(false);
    expect(prefersReducedMotion(true)).toBe(true);
    expect(prefersReducedMotion(false)).toBe(false);
  });
});

describe('useReducedMotion', () => {
  const under = (reducedMotion: 'always' | 'user') => ({ children }: { children: React.ReactNode }) =>
    <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>;

  it('follows Michi\'s Reduce motion through MotionRoot\'s MotionConfig', () => {
    stubOs(false);
    expect(renderHook(() => useReducedMotion(), { wrapper: under('always') }).result.current).toBe(true);
    expect(renderHook(() => useReducedMotion(), { wrapper: under('user') }).result.current).toBe(false);
  });

  it('follows the OS setting', () => {
    stubOs(true);
    expect(renderHook(() => useReducedMotion(), { wrapper: under('user') }).result.current).toBe(true);
  });
});
