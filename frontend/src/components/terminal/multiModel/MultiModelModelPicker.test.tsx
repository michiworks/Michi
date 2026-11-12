import React, { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReadyModelsDto } from 'michi-shared';
import { MultiModelModelPicker } from './MultiModelModelPicker';
import { backTarget, hasBackLayer, registerBackLayer } from '../../../lib/backStack';

const DTO: ReadyModelsDto = {
  version: 1,
  runtimes: [
    { runtimeId: 'codex', label: 'Codex', defaultModelId: 'sol', defaultProviderId: null, models: [{ modelId: 'sol', label: 'GPT-6.1 Sol' }, { modelId: 'astra', label: 'GPT-6 Astra' }] },
    // Its list failed or timed out: only the default can be picked.
    { runtimeId: 'kiro', label: 'Kiro', defaultModelId: 'fable-5.1', defaultProviderId: null, models: [] },
    // The runtime's default model is its default provider's; OpenAI's list is empty.
    {
      runtimeId: 'pi', label: 'Pi', defaultModelId: 'argon', defaultProviderId: 'google', models: [],
      providers: [{ providerId: 'google', label: 'Google', models: [{ modelId: 'argon', label: 'Argon' }] }, { providerId: 'openai', label: 'OpenAI', models: [] }],
    },
  ],
};

function renderPicker(props: Partial<React.ComponentProps<typeof MultiModelModelPicker>> = {}) {
  const handlers = { onLoad: vi.fn(), onPick: vi.fn(), onClose: vi.fn() };
  const { unmount } = render(
    <div>
      <article>
        <button type="button">outside</button>
        <MultiModelModelPicker title="Add a model" ready={{ status: 'ready', dto: DTO }} taken={[]} {...handlers} {...props} />
      </article>
      <input aria-label="another pane" />
    </div>,
  );
  return { ...handlers, unmount, picker: screen.getByRole('dialog', { name: 'Add a model · ready models only' }) };
}

describe('MultiModelModelPicker', () => {
  it('offers the default of a runtime or provider whose model list is empty', () => {
    const { picker, onPick, onLoad } = renderPicker();
    expect(onLoad).toHaveBeenCalledTimes(1);
    fireEvent.click(within(within(picker).getByRole('group', { name: 'Kiro' })).getByRole('button', { name: /fable-5\.1/ }));
    expect(onPick).toHaveBeenLastCalledWith({ runtimeId: 'kiro', providerId: null, modelId: 'fable-5.1' });
    fireEvent.click(within(within(picker).getByRole('group', { name: 'Pi · OpenAI' })).getByRole('button', { name: /Default model/ }));
    expect(onPick).toHaveBeenLastCalledWith({ runtimeId: 'pi', providerId: 'openai', modelId: null });
  });

  it('offers a non-default provider with an empty list its own default, not the runtime\'s', () => {
    const { picker } = renderPicker();
    const openai = within(within(picker).getByRole('group', { name: 'Pi · OpenAI' })).getByRole('button');
    expect(openai.textContent).toBe('πDefault modelReady');
  });

  it('matches a row without a model or provider to the default it resolves to', () => {
    const { picker } = renderPicker({
      current: { runtimeId: 'pi', providerId: null, modelId: null },
      taken: [{ runtimeId: 'kiro', providerId: null, modelId: null }],
    });
    expect(within(within(picker).getByRole('group', { name: 'Pi · Google' })).getByRole('button').textContent).toContain('Current');
    expect(within(within(picker).getByRole('group', { name: 'Pi · OpenAI' })).getByRole('button').textContent).toContain('Ready');
    const kiro = within(within(picker).getByRole('group', { name: 'Kiro' })).getByRole('button') as HTMLButtonElement;
    expect([kiro.disabled, kiro.textContent]).toEqual([true, 'Kfable-5.1In the plan']);
  });

  it('marks the row\'s own model and the other rows\' models', () => {
    const { picker, onPick, onClose } = renderPicker({
      current: { runtimeId: 'codex', providerId: null, modelId: 'astra' },
      taken: [{ runtimeId: 'codex', providerId: null, modelId: 'sol' }],
    });
    const sol = within(picker).getByRole('button', { name: /GPT-6\.1 Sol/ }) as HTMLButtonElement;
    expect([sol.disabled, sol.textContent]).toEqual([true, 'XGPT-6.1 SolIn the plan']);
    const astra = within(picker).getByRole('button', { name: /GPT-6 Astra/ });
    expect(astra.textContent).toContain('Current');
    fireEvent.click(astra);
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says it is loading, and offers Retry after a failure', () => {
    const { picker, onLoad, unmount } = renderPicker({ ready: { status: 'loading' } });
    expect(picker.textContent).toContain('Loading ready models…');
    unmount();
    const failed = renderPicker({ ready: { status: 'error' }, onLoad });
    expect(failed.picker.textContent).toContain("Couldn't load the ready models");
    fireEvent.click(within(failed.picker).getByRole('button', { name: 'Retry' }));
    expect(onLoad).toHaveBeenCalledTimes(3);
  });

  it("closes on the phone's Back before the drawer it sits in", () => {
    const drawer = vi.fn();
    const removeDrawer = registerBackLayer(() => ({ back: drawer }));
    try {
      const { onClose, unmount } = renderPicker();
      act(() => { backTarget()?.back(); });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(drawer).not.toHaveBeenCalled();
      unmount();
    } finally {
      removeDrawer();
    }
    const { unmount } = renderPicker();
    expect(hasBackLayer()).toBe(true);
    unmount();
    expect(hasBackLayer()).toBe(false);
  });

  it('closes on Escape while the focus is still outside it (the list is loading)', () => {
    const { onClose } = renderPicker({ ready: { status: 'loading' } });
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves with the arrow keys and closes on Escape or a click outside', () => {
    const { picker, onClose } = renderPicker({ taken: [{ runtimeId: 'codex', providerId: null, modelId: 'astra' }] });
    const enabled = within(picker).getAllByRole('button').filter((button) => !(button as HTMLButtonElement).disabled);
    expect(document.activeElement).toBe(enabled[0]);
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(enabled[1]);
    fireEvent.keyDown(picker, { key: 'ArrowUp' });
    fireEvent.keyDown(picker, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(enabled.at(-1));
    fireEvent.keyDown(picker, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(within(picker).getAllByRole('button')[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('leaves Escape alone while the focus is outside its card, as in another pane', () => {
    const { onClose } = renderPicker();
    const elsewhere = screen.getByRole('textbox', { name: 'another pane' });
    elsewhere.focus();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    elsewhere.dispatchEvent(escape);
    expect(onClose).not.toHaveBeenCalled();
    expect(escape.defaultPrevented).toBe(false);
  });
});

/** A card with its toggle, the way the run cards open the picker. */
function Toggled({ ready = { status: 'ready', dto: DTO } as const }: { ready?: React.ComponentProps<typeof MultiModelModelPicker>['ready'] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <article>
        <button type="button">first</button>
        <div>
          <button type="button" data-picker-toggle aria-expanded={open} onClick={() => setOpen((value) => !value)}>Replace model</button>
          {open && <MultiModelModelPicker title="Add a model" ready={ready} onLoad={() => {}} taken={[]} onPick={() => setOpen(false)} onClose={() => setOpen(false)} />}
        </div>
      </article>
      <input aria-label="another pane" />
    </div>
  );
}

describe('MultiModelModelPicker focus', () => {
  const toggle = () => screen.getByRole('button', { name: 'Replace model' });

  it('gives the focus back to its toggle on Escape or a pick', () => {
    render(<Toggled />);
    toggle().focus();
    fireEvent.click(toggle());
    const option = within(screen.getByRole('dialog')).getAllByRole('button')[0];
    expect(document.activeElement).toBe(option);
    fireEvent.keyDown(option, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(toggle());
    fireEvent.click(toggle());
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button')[1]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it('finds its toggle when the click focused nothing (Safari)', () => {
    render(<Toggled />);
    fireEvent.click(toggle());
    expect(document.activeElement?.closest('[role="dialog"]')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(toggle());
  });

  it('leaves the focus where it went', () => {
    render(<Toggled ready={{ status: 'loading' }} />);
    fireEvent.click(toggle());
    const elsewhere = screen.getByRole('textbox', { name: 'another pane' });
    elsewhere.focus();
    act(() => { fireEvent.click(toggle()); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});
