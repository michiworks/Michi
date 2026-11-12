import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerModelPicker, type ComposerModelPickerProps } from './ComposerModelPicker';
import { backTarget, hasBackLayer, registerBackLayer } from '../../lib/backStack';

const baseProps: ComposerModelPickerProps = {
  anchor: { x: 100, y: 650, anchorBottom: 610 },
  agentStatus: {
    runtime: 'codex', label: 'Codex', model: 'fast', reasoning: 'medium', hasRequiredKey: true,
    availableRuntimes: [{ id: 'codex', label: 'Codex', available: true }, { id: 'claude', label: 'Claude', available: true }, { id: 'kiro', label: 'Kiro', available: false }],
    capabilities: { modes: true, permissions: true, models: true, providerModels: false, reasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'], apiKeys: false, nativeResume: false, warmSessions: true, saveContext: true, spawnBranches: true },
  },
  resolvedBinding: { runtime: 'codex', model: 'fast', reasoning: 'medium', provider: undefined, source: 'global' },
  catalogCapabilities: null,
  providerModels: [{ id: 'fast', label: 'Fast' }, { id: 'deep', label: 'Deep', description: 'Reasoning model' }],
  modelsLoading: false, modelsError: null,
  onSwitchRuntime: vi.fn(), onSaveModel: vi.fn(), onSaveReasoning: vi.fn(), onRetryModels: vi.fn(), onClose: vi.fn(),
};

describe('ComposerModelPicker', () => {

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('blinks once before selecting, while Back cancels a pending selection immediately', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    vi.useFakeTimers();
    const onSaveModel = vi.fn();
    render(<ComposerModelPicker {...baseProps} onSaveModel={onSaveModel} />);
    fireEvent.click(screen.getByRole('button', { name: /Select model:/ }));
    const deep = screen.getByRole('menuitemradio', { name: /Deep/ });
    fireEvent.click(deep);
    fireEvent.click(deep);
    expect(deep.classList.contains('ui-menu-blink')).toBe(true);
    expect(onSaveModel).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(159); });
    expect(onSaveModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to model settings' }));
    act(() => { vi.advanceTimersByTime(200); });
    expect(onSaveModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Select model:/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Deep/ }));
    act(() => { vi.advanceTimersByTime(160); });
    expect(onSaveModel).toHaveBeenCalledExactlyOnceWith('deep');
    expect(screen.getByRole('slider')).toBeTruthy();
  });

  it('hides effort for an unset binding whose default model has none', () => {
    const onSaveReasoning = vi.fn();
    render(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} resolvedBinding={{ ...baseProps.resolvedBinding, model: undefined }}
      providerModels={[{ id: 'auto', label: 'auto', supportsReasoning: false, supportedReasoningLevels: [] }, { id: 'deep' }]} />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByText('Thinking effort')).toBeNull();
    expect(onSaveReasoning).not.toHaveBeenCalled();
  });

  it("steps the phone's Back like Escape: a list back to the summary, then closed, never the page under it", () => {
    const page = vi.fn();
    const removePage = registerBackLayer(() => ({ level: 'page', back: page }));
    const onClose = vi.fn();
    try {
      const view = render(<ComposerModelPicker {...baseProps} onClose={onClose} />);
      fireEvent.click(screen.getByRole('button', { name: /Select model:/ }));
      expect(screen.getByRole('menu', { name: 'Models' })).toBeTruthy();
      act(() => { backTarget()?.back(); });
      expect(screen.queryByRole('menu', { name: 'Models' })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      act(() => { backTarget()?.back(); });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(page).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      removePage();
    }
    // With no page to go back to, the open picker still holds the system Back.
    const view = render(<ComposerModelPicker {...baseProps} />);
    expect(hasBackLayer()).toBe(true);
    view.unmount();
    expect(hasBackLayer()).toBe(false);
  });

  it('supports nested Escape and restores focus to the trigger', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const onClose = vi.fn();
    const view = render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} onClose={onClose} />);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('menu', { name: 'Models' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Select model: Fast' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    view.unmount();
    trigger.remove();
  });

  it('hides unavailable runtimes and navigates the remaining choices with arrows', () => {
    render(<ComposerModelPicker {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select runtime: Codex' }));
    expect(screen.queryByRole('menuitemradio', { name: /Kiro/ })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Claude' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Codex' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Select runtime: Codex' }));
  });

  it('keeps the menu mounted across runtime changes without inheriting old capabilities', () => {
    const view = render(<ComposerModelPicker {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select runtime: Codex' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude' }));
    view.rerender(<ComposerModelPicker {...baseProps} modelsLoading providerModels={[]}
      resolvedBinding={{ runtime: 'claude', provider: undefined, model: undefined, reasoning: undefined, source: 'pending' }} />);
    expect(screen.getByRole('button', { name: 'Select runtime: Claude' })).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByText('Loading models…')).toBeTruthy();
  });

  it('searches only models by label, identifier and description with a visible empty state', () => {
    render(<ComposerModelPicker {...baseProps} providerModels={Array.from({ length: 10 }, (_, index) => ({ id: `model-${index}`, label: `Model ${index}`, description: index === 5 ? 'Vision' : undefined }))} />);
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));
    const search = screen.getByRole('searchbox', { name: 'Search models' });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'vision' } });
    expect(within(screen.getByRole('menu')).getAllByRole('menuitemradio')).toHaveLength(1);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Model 5 Vision' }));
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('No matching models')).toBeTruthy();
  });

  it('commits only the final drag step and honors the advertised effort levels', () => {
    const onSaveReasoning = vi.fn();
    render(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} />);
    const slider = screen.getByRole('slider');
    expect(slider.getAttribute('max')).toBe('3');
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '2' } });
    fireEvent.change(slider, { target: { value: '3' } });
    expect(onSaveReasoning).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(onSaveReasoning).toHaveBeenCalledExactlyOnceWith('xhigh');
  });

  it('does not save a cancelled drag or reselecting the current value', () => {
    const onSaveReasoning = vi.fn();
    const onSaveModel = vi.fn();
    render(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} onSaveModel={onSaveModel} />);
    const slider = screen.getByRole('slider');
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '3' } });
    fireEvent.pointerCancel(slider);
    expect(slider.getAttribute('aria-valuetext')).toBe('Medium');
    expect(onSaveReasoning).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Fast' }));
    expect(onSaveModel).not.toHaveBeenCalled();
  });

  it('keeps a saved effort shown until the binding catches up, and reverts a failed save', async () => {
    const onSaveReasoning = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Refused'));
    const view = render(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '3' } });
    await act(async () => {});
    // Saved, but the reloaded status has not arrived: no step back to Medium.
    expect(slider.getAttribute('aria-valuetext')).toBe('Extra high');
    view.rerender(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} resolvedBinding={{ ...baseProps.resolvedBinding, reasoning: 'xhigh' }} />);
    expect(slider.getAttribute('aria-valuetext')).toBe('Extra high');
    fireEvent.change(slider, { target: { value: '0' } });
    await act(async () => {});
    expect(slider.getAttribute('aria-valuetext')).toBe('Extra high');
    expect(screen.getByRole('alert').textContent).toBe('Refused');
  });

  it('saves a newer effort after the one in flight, without a Saving row or a step back', async () => {
    let finishFirst!: () => void;
    const onSaveReasoning = vi.fn()
      .mockReturnValueOnce(new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(undefined);
    const view = render(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '3' } });
    expect(screen.queryByText('Saving…')).toBeNull();
    expect((slider as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(slider, { target: { value: '0' } });
    expect(onSaveReasoning).toHaveBeenCalledOnce();
    expect(slider.getAttribute('aria-valuetext')).toBe('Low');
    await act(async () => { finishFirst(); });
    expect(onSaveReasoning).toHaveBeenLastCalledWith('low');
    // The first pick's value arrives after both saves settled.
    view.rerender(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} resolvedBinding={{ ...baseProps.resolvedBinding, reasoning: 'xhigh' }} />);
    expect(slider.getAttribute('aria-valuetext')).toBe('Low');
    view.rerender(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} resolvedBinding={{ ...baseProps.resolvedBinding, reasoning: 'low' }} />);
    expect(slider.getAttribute('aria-valuetext')).toBe('Low');
  });

  it('exposes providers separately with key-configuration status', () => {
    const onSaveProvider = vi.fn();
    render(<ComposerModelPicker {...baseProps} catalogCapabilities={{ ...baseProps.agentStatus!.capabilities, providerModels: true }}
      providers={[{ id: 'openrouter', label: 'OpenRouter', keyLabel: 'Key', envVars: [], defaultModel: 'auto', supportsReasoning: true, hasKey: false }]}
      onSaveProvider={onSaveProvider} />);
    fireEvent.click(screen.getByRole('button', { name: /Select provider/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /OpenRouter No API key configured/ }));
    expect(onSaveProvider).toHaveBeenCalledExactlyOnceWith('openrouter');
  });

  it('dismisses for an outside pointer but leaves trigger toggling to the trigger', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const onClose = vi.fn();
    const view = render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} onClose={onClose} />);
    fireEvent.pointerDown(trigger);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount(); trigger.remove();
  });
});

describe('ComposerModelPicker placement', () => {
  const layout = { content: 230, chrome: 30 };
  const size = (element: HTMLElement) => element.classList.contains('composer-picker-content') ? layout.content
    : element.classList.contains('composer-picker') ? layout.content + layout.chrome : 0;
  const triggerAt = (top: number) => {
    const trigger = document.createElement('button');
    trigger.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 200, right: 290, width: 90, height: 30, x: 200, y: top, toJSON: () => ({}) });
    document.body.append(trigger);
    triggers.push(trigger);
    return trigger;
  };
  const triggers: HTMLElement[] = [];
  const surfaceTop = () => parseFloat(screen.getByRole('dialog', { name: 'Model settings' }).style.top);

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    vi.stubGlobal('innerHeight', 844);
    vi.stubGlobal('innerWidth', 390);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return size(this); });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return size(this); });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const height = this instanceof HTMLElement ? size(this) : 0;
      const top = this instanceof HTMLElement && this.classList.contains('composer-picker-content') ? layout.chrome : 0;
      return { top, bottom: top + height, left: 0, right: 280, width: 280, height, x: 0, y: top, toJSON: () => ({}) };
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); layout.content = 230; triggers.splice(0).forEach((trigger) => trigger.remove()); });

  it('opens below the trigger when the summary does not fit above but fits below', () => {
    const trigger = triggerAt(270);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} />);
    // 256 px above the trigger, 260 px wanted: below, 6 px under its bottom edge.
    expect(surfaceTop()).toBe(306);
  });

  it('still opens above when the summary fits there', () => {
    layout.content = 150;
    const trigger = triggerAt(270);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} />);
    expect(surfaceTop()).toBe(264 - 180);
  });

  it('opens below a composer at the top of the page even when the summary fits above', () => {
    layout.content = 150;
    const trigger = triggerAt(270);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger, preferBelow: true }} />);
    expect(surfaceTop()).toBe(306);
  });

  it('opens below the composer frame that holds the trigger, not over its edge', () => {
    layout.content = 150;
    const trigger = triggerAt(270);
    const frame = document.createElement('div');
    frame.className = 'terminal-composer';
    frame.getBoundingClientRect = () => ({ top: 200, bottom: 310, left: 0, right: 600, width: 600, height: 110, x: 0, y: 200, toJSON: () => ({}) });
    frame.append(trigger);
    document.body.append(frame);
    triggers.push(frame);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger, preferBelow: true }} />);
    expect(surfaceTop()).toBe(316);
  });

  it('flips a below-preferring summary above when only that side fits', () => {
    const trigger = triggerAt(700);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger, preferBelow: true }} />);
    expect(surfaceTop()).toBe(694 - 260);
  });

  it('opens above a composer near the bottom of the window', () => {
    const trigger = triggerAt(700);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} />);
    expect(surfaceTop()).toBe(694 - 260);
  });

  it('keeps the side it opened on while moving to a sub-page', () => {
    const trigger = triggerAt(270);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} />);
    expect(surfaceTop()).toBe(306);
    layout.content = 100;
    fireEvent.click(screen.getByRole('button', { name: 'Select runtime: Codex' }));
    expect(screen.getByRole('menu', { name: 'Runtimes' })).toBeTruthy();
    expect(surfaceTop()).toBe(306);
  });

  describe('Ultracode', () => {
    const claude: Partial<ComposerModelPickerProps> = {
      resolvedBinding: { runtime: 'claude', model: 'opus', reasoning: 'high', provider: undefined, source: 'node' },
      catalogCapabilities: { ...baseProps.agentStatus!.capabilities, ultracode: true },
      providerModels: [{ id: 'opus', label: 'Opus' }],
    };

    it('is a switch under the effort slider on a runtime that has it, saved for the chat', async () => {
      const onSaveUltracode = vi.fn(async () => {});
      const view = render(<ComposerModelPicker {...baseProps} {...claude} ultracode={{ enabled: false }} onSaveUltracode={onSaveUltracode} />);
      const toggle = screen.getByRole('switch', { name: /Ultracode/ });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(toggle.textContent).toMatch(/multi-agent workflow for each task/);
      await act(async () => { fireEvent.click(toggle); });
      expect(onSaveUltracode).toHaveBeenCalledExactlyOnceWith(true);
      expect(screen.queryByRole('alert')).toBeNull();
      // Saved, but the chat's choice has not arrived yet: no step back to off.
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      view.rerender(<ComposerModelPicker {...baseProps} {...claude} ultracode={{ enabled: true, available: true }} onSaveUltracode={onSaveUltracode} />);
      expect(screen.getByRole('switch', { name: /Ultracode/ }).getAttribute('aria-checked')).toBe('true');
    });

    it('says when the model or setup cannot run it, and shows why a save failed', async () => {
      const onSaveUltracode = vi.fn(async () => { throw new Error('Ultracode is not available in this chat'); });
      render(<ComposerModelPicker {...baseProps} {...claude} ultracode={{ enabled: true, available: false }} onSaveUltracode={onSaveUltracode} />);
      const toggle = screen.getByRole('switch', { name: /Ultracode/ });
      expect(toggle.textContent).toMatch(/On, but this model or setup cannot run it/);
      expect(toggle.getAttribute('data-unavailable')).toBe('true');
      await act(async () => { fireEvent.click(toggle); });
      expect(onSaveUltracode).toHaveBeenCalledExactlyOnceWith(false);
      expect(screen.getByRole('alert').textContent).toBe('Ultracode is not available in this chat');
    });

    it('turns at once while it saves, keeps the summary as it is, and turns back after a failure', async () => {
      let fail!: (error: Error) => void;
      const onSaveUltracode = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
      render(<ComposerModelPicker {...baseProps} {...claude} ultracode={{ enabled: false }} onSaveUltracode={onSaveUltracode} />);
      const toggle = screen.getByRole('switch', { name: /Ultracode/ }) as HTMLButtonElement;
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(screen.queryByText('Saving…')).toBeNull();
      expect(toggle.disabled).toBe(false);
      expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(false);
      await act(async () => { fail(new Error('Refused')); });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(screen.getByRole('alert').textContent).toBe('Refused');
    });

    it('is not offered on a runtime without it, or where the chat cannot have it', () => {
      const { rerender } = render(<ComposerModelPicker {...baseProps} ultracode={{ enabled: false }} onSaveUltracode={vi.fn()} />);
      expect(screen.queryByRole('switch')).toBeNull();
      rerender(<ComposerModelPicker {...baseProps} {...claude} />);
      expect(screen.queryByRole('switch')).toBeNull();
    });

    it('Right does not toggle it: only a summary row opens its page', () => {
      const onSaveUltracode = vi.fn();
      render(<ComposerModelPicker {...baseProps} {...claude} ultracode={{ enabled: false }} onSaveUltracode={onSaveUltracode} />);
      const toggle = screen.getByRole('switch', { name: /Ultracode/ });
      toggle.focus();
      fireEvent.keyDown(toggle, { key: 'ArrowRight' });
      expect(onSaveUltracode).not.toHaveBeenCalled();
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});
