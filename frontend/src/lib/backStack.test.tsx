import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backTarget, hasBackLayer, registerBackLayer, topBackLayer, useBackLayer, type BackLayer } from './backStack';

function Layer({ active = true, layer }: { active?: boolean; layer: BackLayer }) {
  useBackLayer(active, layer);
  return null;
}

describe('back stack', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('steps the newest overlay first and the page under every overlay', () => {
    const page = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    const removePage = registerBackLayer(() => ({ level: 'page', back: page }));
    const removeFirst = registerBackLayer(() => ({ back: first }));
    const removeSecond = registerBackLayer(() => ({ back: second }));
    try {
      backTarget()?.back();
      expect(second).toHaveBeenCalledTimes(1);
      removeSecond();
      backTarget()?.back();
      expect(first).toHaveBeenCalledTimes(1);
      removeFirst();
      expect(topBackLayer()?.level).toBe('page');
      backTarget()?.back();
      expect(page).toHaveBeenCalledTimes(1);
    } finally {
      removePage();
      removeFirst();
      removeSecond();
    }
    expect(hasBackLayer()).toBe(false);
    expect(backTarget()).toBeNull();
  });

  it('sends an open menu an Esc before anything else', () => {
    const drawer = vi.fn();
    const remove = registerBackLayer(() => ({ back: drawer }));
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    const keys = vi.fn();
    window.addEventListener('keydown', keys);
    try {
      const target = backTarget();
      expect(target?.kind).toBe('escape');
      target?.back();
      expect(keys).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
      expect(drawer).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', keys);
      remove();
    }
  });

  it('leaves the page alone under a modal nobody can dismiss', () => {
    const remove = registerBackLayer(() => ({ level: 'page', back: vi.fn() }));
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    try {
      expect(backTarget()).toBeNull();
    } finally {
      remove();
    }
  });

  it('registers while active and reads the latest layer when Back runs', () => {
    const before = vi.fn();
    const after = vi.fn();
    const view = render(<Layer layer={{ back: before }} />);
    view.rerender(<Layer layer={{ back: after }} />);
    act(() => backTarget()?.back());
    expect(after).toHaveBeenCalledTimes(1);
    expect(before).not.toHaveBeenCalled();
    view.rerender(<Layer active={false} layer={{ back: after }} />);
    expect(hasBackLayer()).toBe(false);
  });
});
