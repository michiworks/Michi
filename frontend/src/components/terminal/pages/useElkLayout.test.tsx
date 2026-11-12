import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useElkLayout } from './useElkLayout';

const engine = vi.hoisted(() => ({ load: vi.fn(), layout: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => {
  engine.load();
  return { default: class { layout = engine.layout; } };
});
const input = { ids: ['n'], edges: [], cardHeights: new Map<string, number>() };
const laid = { children: [{ id: 'n', x: 10, y: 20, width: 100, height: 50 }] };

beforeEach(() => engine.layout.mockReset());

describe('lazy Map layout', () => {
  it('does not load the engine for disabled or empty maps', () => {
    const view = renderHook(({ enabled, ids }) => useElkLayout({ ...input, enabled, ids }),
      { initialProps: { enabled: false, ids: input.ids } });
    view.rerender({ enabled: true, ids: [] });
    expect(engine.load).not.toHaveBeenCalled();
    expect(engine.layout).not.toHaveBeenCalled();
    expect(view.result.current?.ids).toEqual([]);
  });

  it('discards a pending layout when the graph is disabled and reuses the engine on return', async () => {
    let finish!: (value: typeof laid) => void;
    engine.layout.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(laid);
    const view = renderHook(({ enabled }) => useElkLayout({ ...input, enabled }), { initialProps: { enabled: true } });
    await waitFor(() => expect(engine.layout).toHaveBeenCalledTimes(1));
    view.rerender({ enabled: false });
    await act(async () => { finish(laid); });
    expect(view.result.current).toBeNull();
    view.rerender({ enabled: true });
    await waitFor(() => expect(view.result.current?.ids).toEqual(['n']));
    expect(engine.load).toHaveBeenCalledTimes(1);
  });

  it('hands ELK the nodes and edges in the order given, since it considers model order', async () => {
    engine.layout.mockResolvedValue(laid);
    const params = {
      ...input, enabled: true, ids: ['r', 'b', 'a'],
      edges: [{ source: 'r', target: 'b', kind: 'branch' as const }, { source: 'r', target: 'a', kind: 'branch' as const }],
    };
    renderHook(() => useElkLayout(params));
    await waitFor(() => expect(engine.layout).toHaveBeenCalledTimes(1));
    const graph = engine.layout.mock.calls[0][0];
    expect(graph.children.map((child: { id: string }) => child.id)).toEqual(['r', 'b', 'a']);
    expect(graph.edges.map((edge: { id: string }) => edge.id)).toEqual(['r->b', 'r->a']);
  });

  it('does not let an older failure erase a newer layout', async () => {
    let fail!: (reason: Error) => void;
    engine.layout.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; })).mockResolvedValue(laid);
    const view = renderHook(({ cardHeights }) => useElkLayout({ ...input, enabled: true, cardHeights }),
      { initialProps: { cardHeights: input.cardHeights } });
    await waitFor(() => expect(engine.layout).toHaveBeenCalledTimes(1));
    view.rerender({ cardHeights: new Map([['n', 80]]) });
    await waitFor(() => expect(view.result.current?.ids).toEqual(['n']));
    await act(async () => { fail(new Error('stale layout')); });
    expect(view.result.current?.ids).toEqual(['n']);
  });
});
