import { describe, expect, it } from 'vitest';
import { OPEN_BACKGROUND_WORK_EVENT, readOpenBackgroundWorkDetail } from './backgroundWorkEvents';

function read(detail: unknown) {
  return readOpenBackgroundWorkDetail(new CustomEvent(OPEN_BACKGROUND_WORK_EVENT, { detail }));
}

describe('open background work requests', () => {
  it('keep a multi-model row focus: the thread key and its step', () => {
    expect(read({ nodeId: 'n1', focus: { kind: 'workflow', runKey: 'k', threadKey: 't1', step: 2 } }))
      .toEqual({ nodeId: 'n1', focus: { kind: 'workflow', runKey: 'k', threadKey: 't1', step: 2 } });
    expect(read({ nodeId: 'n1', focus: { kind: 'workflow', runKey: 'k', step: 0 } }))
      .toEqual({ nodeId: 'n1', focus: { kind: 'workflow', runKey: 'k', step: 0 } });
  });

  it('drop a bad thread key or step and keep the run', () => {
    for (const extra of [
      { threadKey: '' }, { threadKey: 'abcdefghi' }, { threadKey: 7 },
      { step: 3 }, { step: -1 }, { step: 1.5 }, { step: '1' },
    ]) {
      expect(read({ nodeId: 'n1', focus: { kind: 'workflow', runKey: 'k', ...extra } }), JSON.stringify(extra))
        .toEqual({ nodeId: 'n1', focus: { kind: 'workflow', runKey: 'k' } });
    }
    expect(read({ nodeId: 'n1', focus: { kind: 'workflow', threadKey: 't1' } })).toEqual({ nodeId: 'n1' });
    expect(read({ focus: { kind: 'workflow', runKey: 'k' } })).toBeNull();
  });
});
