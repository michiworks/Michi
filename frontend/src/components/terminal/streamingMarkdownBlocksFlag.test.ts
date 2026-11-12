import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY,
  streamingMarkdownBlocksEnabled,
} from './streamingMarkdownBlocksFlag';

describe('streamingMarkdownBlocksEnabled', () => {
  beforeEach(() => {
    window.localStorage.removeItem(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['1', 'true', 'on', 'yes', ' ON ', 'True'])('turns on for %j', (value) => {
    window.localStorage.setItem(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY, value);
    expect(streamingMarkdownBlocksEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', 'OFF', 'False', 'No'])('turns off for %j', (value) => {
    window.localStorage.setItem(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY, value);
    expect(streamingMarkdownBlocksEnabled()).toBe(false);
  });

  it('falls back to the build setting, then on, for an unset or unreadable value', () => {
    expect(streamingMarkdownBlocksEnabled()).toBe(true);
    window.localStorage.setItem(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY, 'tru');
    expect(streamingMarkdownBlocksEnabled()).toBe(true);
    vi.stubEnv('VITE_STREAMING_MARKDOWN_BLOCKS', '0');
    expect(streamingMarkdownBlocksEnabled()).toBe(false);
    window.localStorage.setItem(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY, '1');
    expect(streamingMarkdownBlocksEnabled()).toBe(true);
  });
});
