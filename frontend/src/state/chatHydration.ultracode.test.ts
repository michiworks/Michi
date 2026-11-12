import { describe, expect, it } from 'vitest';
import { hydrateBackendWorkspaces } from './chatHydration';
import { reduceNodes } from './chatReducers';

describe('a chat\'s Ultracode choice', () => {
  it('is hydrated from the server-owned node column and changed only by its own action', () => {
    const state = hydrateBackendWorkspaces([{
      workspace: { id: 'ws1', name: 'Test', created_at: 1 },
      trees: [
        { id: 't1', root_node_id: 'on', created_at: 1, last_active_at: 1 },
        { id: 't2', root_node_id: 'off', created_at: 2, last_active_at: 2 },
      ],
      nodes: [
        { id: 'on', created_at: 1, kind: 'chat', ultracode: 1 },
        { id: 'off', created_at: 2, kind: 'chat', ultracode: 0 },
      ],
      edges: [], messages: [], artifacts: [],
    }]);
    expect(state.nodes.on.ultracode).toBe(true);
    expect(state.nodes.off.ultracode).toBeUndefined();
    const switchedOn = reduceNodes(state.nodes, { type: 'set-ultracode', nodeId: 'off', enabled: true });
    expect(switchedOn.off.ultracode).toBe(true);
    expect(switchedOn.on).toBe(state.nodes.on);
    const switchedOff = reduceNodes(switchedOn, { type: 'set-ultracode', nodeId: 'on', enabled: false });
    expect(switchedOff.on.ultracode).toBeUndefined();
    // No change keeps the same state object.
    expect(reduceNodes(switchedOff, { type: 'set-ultracode', nodeId: 'on', enabled: false })).toBe(switchedOff);
    expect(reduceNodes(switchedOff, { type: 'set-ultracode', nodeId: 'missing', enabled: true })).toBe(switchedOff);
  });
});
