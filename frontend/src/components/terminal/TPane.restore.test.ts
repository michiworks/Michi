import { describe, it, expect } from 'vitest';
import { resolvePaneRestore, type PaneScrollEntry } from './TPane';

// resolvePaneRestore decides where a freshly-mounted idle pane lands:
// first message newer than the saved lastSeen horizon ("unseen"), else the
// message that topped the viewport when the pane was left mid-history
// ("anchor"), else the bottom. The horizon deliberately comes from the
// pane's own save cache rather than node.viewedAt — activateTree resets
// viewedAt to Date.now() in the same click that opens the pane, so viewedAt
// is always "just now" by the time the pane can read it.

const entry = (over: Partial<PaneScrollEntry> = {}): PaneScrollEntry => ({
  anchorId: 'm2',
  offset: -40,
  atBottom: false,
  lastSeen: 1000,
  ...over,
});

const msgs = [
  { id: 'm1', createdAt: 500 },
  { id: 'm2', createdAt: 800 },
  { id: 'm3', createdAt: 1000 },
];

describe('resolvePaneRestore', () => {
  it('messages without createdAt are never unseen', () => {
    const legacyMsgs = [{ id: 'm1' }, { id: 'm2' }];
    const got = resolvePaneRestore(entry({ atBottom: true }), legacyMsgs);
    expect(got?.kind).toBe('bottom');
  });

  it('a pane left mid-history reopens at its saved anchor and offset', () => {
    expect(resolvePaneRestore(entry(), msgs)).toEqual({ kind: 'anchor', anchorId: 'm2', offset: -40 });
  });

  it('messages newer than the horizon win over the saved anchor', () => {
    const got = resolvePaneRestore(entry(), [...msgs, { id: 'm4', createdAt: 1200 }]);
    expect(got).toEqual({ kind: 'unseen', anchorId: 'm4', offset: 0 });
  });

  it('a pane left at the bottom, or whose anchor is gone, opens at the bottom', () => {
    expect(resolvePaneRestore(entry({ atBottom: true }), msgs)?.kind).toBe('bottom');
    expect(resolvePaneRestore(entry({ anchorId: 'deleted' }), msgs)?.kind).toBe('bottom');
    expect(resolvePaneRestore(undefined, msgs)?.kind).toBe('bottom');
  });
});
