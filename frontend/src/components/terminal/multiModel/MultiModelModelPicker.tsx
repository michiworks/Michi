import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MultiModelModelPick, ReadyModelOption, ReadyModelsDto, ReadyRuntimeOption } from 'michi-shared';
import { fetchReadyModels } from '../../../services/api/multiModelRuns';
import { useBackLayer } from '../../../lib/backStack';
import { runtimeGlyph } from './multiModelPresentation';
import { isImeComposing } from '../../../lib/ime';
import './MultiModelModelPicker.css';

/**
 * The plan card's inline model picker: the runtimes and models ready right
 * now (GET /multi-model/ready-models, the list the agent's list_ready_models
 * reads), grouped by runtime with providers as sub-groups. Each option says
 * whether it is this row's model, another row's (not pickable), or ready.
 */

type ReadyModelsState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; dto: ReadyModelsDto };

/** The ready models of one card, fetched on the first `load` and kept for the card's lifetime. */
export function useReadyModels(backendConnectionId: string, workspaceId: string): { state: ReadyModelsState | null; load: () => void } {
  const [state, setState] = useState<ReadyModelsState | null>(null);
  const statusRef = useRef<ReadyModelsState['status'] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const load = useCallback(() => {
    if (statusRef.current === 'loading' || statusRef.current === 'ready') return;
    const controller = new AbortController();
    abortRef.current = controller;
    const settle = (next: ReadyModelsState) => {
      if (controller.signal.aborted) return;
      statusRef.current = next.status;
      setState(next);
    };
    settle({ status: 'loading' });
    fetchReadyModels(backendConnectionId, workspaceId, controller.signal).then(
      (dto) => settle({ status: 'ready', dto }),
      () => settle({ status: 'error' }),
    );
  }, [backendConnectionId, workspaceId]);
  return { state, load };
}

/** A runtime's one-letter mark, in its color. */
export function ModelGlyph({ runtimeId, label }: { runtimeId: string; label: string }) {
  const glyph = runtimeGlyph(runtimeId, label);
  return <span aria-hidden className="glyph" style={{ color: glyph.color }}>{glyph.letter}</span>;
}

/**
 * A pick as the backend resolves it: no provider is the runtime's default
 * provider, and no model is the default model where the list says which one
 * that is (the runtime's, or its default provider's).
 */
function resolvedPick(pick: MultiModelModelPick, dto: ReadyModelsDto): MultiModelModelPick {
  const runtime = dto.runtimes.find((option) => option.runtimeId === pick.runtimeId);
  if (!runtime) return pick;
  const providerId = runtime.providers ? pick.providerId ?? runtime.defaultProviderId : null;
  const modelId = pick.modelId ?? (providerId === runtime.defaultProviderId ? runtime.defaultModelId : null);
  return { runtimeId: pick.runtimeId, providerId, modelId };
}

function samePick(a: MultiModelModelPick, b: MultiModelModelPick, dto: ReadyModelsDto): boolean {
  const x = resolvedPick(a, dto);
  const y = resolvedPick(b, dto);
  return x.runtimeId === y.runtimeId && (x.providerId ?? null) === (y.providerId ?? null) && (x.modelId ?? null) === (y.modelId ?? null);
}

interface PickerGroup {
  key: string;
  runtime: ReadyRuntimeOption;
  /** The runtime's first group carries its heading. */
  first: boolean;
  provider?: string;
  options: Array<{ pick: MultiModelModelPick; label: string }>;
}

/**
 * A list that failed or timed out is empty; its default is then the only pick
 * the backend accepts. The runtime's default model belongs to its default
 * provider: another provider offers its own default, which only the backend
 * knows ("Default model").
 */
function optionsOf(runtime: ReadyRuntimeOption, providerId: string | null, models: readonly ReadyModelOption[]): PickerGroup['options'] {
  if (models.length === 0) {
    const modelId = providerId === null || providerId === runtime.defaultProviderId ? runtime.defaultModelId : null;
    return [{ pick: { runtimeId: runtime.runtimeId, providerId, modelId }, label: modelId ?? 'Default model' }];
  }
  return models.map((model) => ({ pick: { runtimeId: runtime.runtimeId, providerId, modelId: model.modelId }, label: model.label }));
}

function groupsOf(dto: ReadyModelsDto): PickerGroup[] {
  return dto.runtimes.flatMap((runtime): PickerGroup[] => {
    if (!runtime.providers) return [{ key: runtime.runtimeId, runtime, first: true, options: optionsOf(runtime, null, runtime.models) }];
    return runtime.providers.map((provider, index) => ({
      key: `${runtime.runtimeId}/${provider.providerId}`,
      runtime,
      first: index === 0,
      provider: provider.label,
      options: optionsOf(runtime, provider.providerId, provider.models),
    }));
  });
}

const OPTION_SELECTOR = 'button.opt:not(:disabled)';
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Where Escape belongs to the picker: the modal it sits in (the drawer), else its card. */
function pickerScope(root: HTMLElement): HTMLElement {
  return root.closest<HTMLElement>('[aria-modal="true"]') ?? root.closest<HTMLElement>('article') ?? root;
}

/** The control that opened the picker: the focused one, or (a click that focused nothing, as in Safari) its expanded toggle. */
function openerOf(root: HTMLElement): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !root.contains(active)) return active;
  return pickerScope(root).querySelector<HTMLElement>('[data-picker-toggle][aria-expanded="true"]');
}

/**
 * Give the focus back once the picker is gone, unless it went somewhere on
 * purpose: to the opener, or (disabled while the pick is sent, or gone with
 * the row it fixed) to the first control left around where the picker was.
 */
function returnFocus(opener: HTMLElement | null, ancestors: readonly HTMLElement[]) {
  const active = document.activeElement;
  if (active && active !== document.body) return;
  if (opener?.isConnected && !(opener as HTMLButtonElement).disabled) {
    opener.focus({ preventScroll: true });
    return;
  }
  for (const ancestor of ancestors) {
    if (!ancestor.isConnected) continue;
    const target = ancestor.querySelector<HTMLElement>(FOCUSABLE) ?? (ancestor.hasAttribute('tabindex') ? ancestor : null);
    if (target) {
      target.focus({ preventScroll: true });
      return;
    }
  }
}

export function MultiModelModelPicker({ title, ready, onLoad, current, taken, onPick, onClose }: {
  /** "Replace Codex · GPT-6.1 Sol" or "Add a model". */
  title: string;
  ready: ReadyModelsState | null;
  /** Fetch the list (on open, and from Retry after a failure). */
  onLoad: () => void;
  /** The row's own model, when replacing. */
  current?: MultiModelModelPick;
  /** The other live rows' models. */
  taken: readonly MultiModelModelPick[];
  onPick: (pick: MultiModelModelPick) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { onLoad(); }, [onLoad]);
  // The phone's Back closes it before the drawer or page it sits in. It is no
  // Esc layer: its Esc belongs to its own card, not to every pane.
  useBackLayer(true, { back: onClose });
  // Escape and clicks outside close it; the toggle that opened it closes it
  // itself. Escape is the picker's while the focus is in its card (it stays on
  // the toggle while the list loads) or its modal, not in another pane.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || rootRef.current?.contains(target) || target.closest('[data-picker-toggle]')) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeComposing(event)) return;
      const root = rootRef.current;
      const target = event.target;
      if (root && target instanceof Node && target !== document.body && !pickerScope(root).contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (typeof root.scrollIntoView === 'function') root.scrollIntoView({ block: 'nearest' });
    // Before the list takes the focus (the effect below).
    const opener = openerOf(root);
    const ancestors: HTMLElement[] = [];
    for (let at = root.parentElement, scope = pickerScope(root); at; at = at.parentElement) {
      ancestors.push(at);
      if (at === scope) break;
    }
    // Still connected: React only rehearsing an unmount (StrictMode).
    return () => { if (!root.isConnected) returnFocus(opener, ancestors); };
  }, []);
  const status = ready?.status;
  useEffect(() => {
    if (status === 'ready') rootRef.current?.querySelector<HTMLButtonElement>(OPTION_SELECTOR)?.focus();
  }, [status]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const options = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR) ?? [])];
    if (options.length === 0) return;
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % options.length : (at <= 0 ? options.length - 1 : at - 1);
    options[next].focus();
  };

  return (
    <div ref={rootRef} className="picker" role="dialog" aria-label={`${title} · ready models only`} data-card-click="ignore" onKeyDown={onKeyDown}>
      <div className="ph2">{title} · ready models only</div>
      {(!ready || ready.status === 'loading') && <div className="pstate">Loading ready models…</div>}
      {ready?.status === 'error' && (
        <div className="pstate">Couldn&apos;t load the ready models · <button type="button" className="linkbtn" onClick={onLoad}>Retry</button></div>
      )}
      {ready?.status === 'ready' && groupsOf(ready.dto).map((group) => (
        <div key={group.key} role="group" aria-label={group.provider ? `${group.runtime.label} · ${group.provider}` : group.runtime.label}>
          {group.first && <div className="g">{group.runtime.label}</div>}
          {group.provider && <div className="g sub">{group.provider}</div>}
          {group.options.map((option) => {
            const isCurrent = !!current && samePick(option.pick, current, ready.dto);
            const inPlan = !isCurrent && taken.some((pick) => samePick(option.pick, pick, ready.dto));
            return (
              <button
                key={`${option.pick.providerId ?? ''}/${option.pick.modelId ?? ''}`}
                type="button"
                className={isCurrent ? 'opt cur' : 'opt'}
                disabled={inPlan}
                onClick={() => (isCurrent ? onClose() : onPick(option.pick))}
              >
                <ModelGlyph runtimeId={option.pick.runtimeId} label={group.runtime.label} />
                <span className="ol">{option.label}</span>
                <span className="rd">{isCurrent ? 'Current' : inPlan ? 'In the plan' : 'Ready'}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
