import React from 'react';
import { render } from '@testing-library/react';
import { MotionConfigContext } from 'motion/react';
import { afterEach, expect, it } from 'vitest';
import { PREFS_KEY } from '../state/prefs';
import { StandaloneMotionRoot } from './MotionRoot';

function ReducedMotion() {
  return <output>{React.useContext(MotionConfigContext).reducedMotion}</output>;
}

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.reduceMotion;
});

it.each([
  [true, 'always', 'on'],
  [false, 'user', 'off'],
])('gives a root without PrefsProvider the stored Reduce motion %s: MotionConfig %s, html[data-reduce-motion=%s]', (stored, config, attribute) => {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ reduceMotion: stored }));
  const { getByRole } = render(<StandaloneMotionRoot><ReducedMotion /></StandaloneMotionRoot>);
  expect(getByRole('status').textContent).toBe(config);
  expect(document.documentElement.dataset.reduceMotion).toBe(attribute);
});
