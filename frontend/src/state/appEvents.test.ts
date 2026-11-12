import { describe, expect, it } from 'vitest';
import definitions from './appEvents.ts?raw';

const sources = import.meta.glob<string>(
  ['../**/*.{ts,tsx}', '!../**/*.{test,spec}.{ts,tsx}', '!./appEvents.ts'],
  { query: '?raw', import: 'default', eager: true },
);

describe('app window events', () => {
  // A string-named event has no compile-time link between its two ends: a
  // removed listener left `michi:focus-digest` and `michi:page-helper-source`
  // dispatched for nothing. Every event defined here needs both ends.
  it('each event is dispatched and subscribed outside tests', () => {
    const names = [...definitions.matchAll(/^export const (\w+) = defineWindowEvent\b/gm)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    const code = Object.values(sources).join('\n');
    const unpaired = names.filter((name) => !new RegExp(`\\b${name}\\.dispatch\\(`).test(code) || !new RegExp(`\\b${name}\\.subscribe\\(`).test(code));
    expect(unpaired).toEqual([]);
  });
});
