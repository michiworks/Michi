import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MARKDOWN_REMEND_STORAGE_KEY,
  markdownRemendEnabled,
} from './markdownRemendFlag';

describe('markdownRemendEnabled', () => {
  beforeEach(() => {
    window.localStorage.removeItem(MARKDOWN_REMEND_STORAGE_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['1', 'true', 'on', 'yes', ' ON ', 'True'])('turns on for %j', (value) => {
    window.localStorage.setItem(MARKDOWN_REMEND_STORAGE_KEY, value);
    expect(markdownRemendEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', 'OFF', 'False', 'No'])('turns off for %j', (value) => {
    window.localStorage.setItem(MARKDOWN_REMEND_STORAGE_KEY, value);
    expect(markdownRemendEnabled()).toBe(false);
  });

  it('falls back to the build setting, then on, for an unset or unreadable value', () => {
    expect(markdownRemendEnabled()).toBe(true);
    window.localStorage.setItem(MARKDOWN_REMEND_STORAGE_KEY, 'tru');
    expect(markdownRemendEnabled()).toBe(true);
    vi.stubEnv('VITE_MARKDOWN_REMEND', '0');
    expect(markdownRemendEnabled()).toBe(false);
    window.localStorage.setItem(MARKDOWN_REMEND_STORAGE_KEY, '1');
    expect(markdownRemendEnabled()).toBe(true);
  });
});
