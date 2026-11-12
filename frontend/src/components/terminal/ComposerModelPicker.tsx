import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useIsPresent } from 'motion/react';
import type { AgentCapabilities, AgentModelInfo, AgentProviderInfo, AgentReasoning, AgentStatus } from '../../services/api';
import type { ResolvedNodeBinding } from '../../state/nodeBindingResolution';
import { measureSurface, PopoverSurface } from '../ui/Popover';
import { useMenuConfirm } from '../ui/useMenuConfirm';
import { pickMenuSide, useAnchoredPosition } from '../ui/useAnchoredPosition';
import { useBackLayer } from '../../lib/backStack';
import { ChevronLeftIcon, ChevronRightIcon, RetryIcon } from './icons';
import { REASONING_LABELS, composerMenuBelowEdge, type PaneMenuAnchor } from './PaneComposerToolbarLeft';
import './ComposerModelPicker.css';
import { resolveComposerReasoning } from './composerReasoning';
import { modelDisplayLabel } from '../../lib/modelLabel';
import { filterAvailableRuntimes } from '../../lib/runtimeVisibility';
import { isImeComposing } from '../../lib/ime';

type PickerPage = 'overview' | 'model' | 'runtime' | 'provider';
type SelectionHandler<T> = (value: T) => void | Promise<void>;

/** A chat's Ultracode choice and the live session's report of it. */
export interface ComposerUltracode {
  enabled: boolean;
  /** False when the live session cannot run it (its model or setup); unknown when absent. */
  available?: boolean;
}

/** What the Ultracode switch says under its label. */
function ultracodeNote(ultracode: ComposerUltracode): string {
  if (ultracode.available === false) return ultracode.enabled
    ? 'On, but this model or setup cannot run it'
    : 'Not available with this model or setup';
  return 'A multi-agent workflow for each task. Uses many more tokens.';
}

export interface ComposerModelPickerProps {
  anchor: PaneMenuAnchor;
  agentStatus: AgentStatus | null;
  resolvedBinding: ResolvedNodeBinding;
  catalogCapabilities: AgentCapabilities | null;
  providerModels: readonly AgentModelInfo[];
  providers?: readonly AgentProviderInfo[];
  modelsLoading: boolean;
  modelsWaiting?: boolean;
  modelsError: string | null;
  onSwitchRuntime: SelectionHandler<string>;
  onSaveProvider?: SelectionHandler<string>;
  onSaveModel: SelectionHandler<string>;
  onSaveReasoning: SelectionHandler<AgentReasoning>;
  onRetryModels: () => void;
  onClose: () => void;
  /** The chat's Ultracode choice; offered when the runtime has it (capabilities.ultracode). */
  ultracode?: ComposerUltracode;
  onSaveUltracode?: SelectionHandler<boolean>;
}

const focusableSelector = 'button:not(:disabled), input:not(:disabled)';

export function ComposerModelPicker({
  anchor, agentStatus, resolvedBinding, catalogCapabilities, providerModels, providers = [],
  modelsLoading, modelsWaiting = false, modelsError, onSwitchRuntime, onSaveProvider,
  onSaveModel, onSaveReasoning, onRetryModels, onClose, ultracode, onSaveUltracode,
}: ComposerModelPickerProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<PickerPage>('overview');
  const [query, setQuery] = useState('');
  // A list pick waits on its page with a "Saving…" row; the effort slider and
  // the Ultracode switch show the pick themselves, so the summary keeps its size.
  const [saving, setSaving] = useState<'list' | 'inline' | null>(null);
  const listSaving = saving === 'list';
  const [ultracodePending, setUltracodePending] = useState<boolean | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { blinkingId, confirm, cancel } = useMenuConfirm();
  const busyRef = useRef(false);
  const queuedRef = useRef<{ run: () => Promise<boolean>; resolve: (saved: boolean) => void } | null>(null);
  const ultracodeSaves = useRef(0);
  const ultracodeEnabledRef = useRef(ultracode?.enabled);
  const savingFocusRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(true);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y, maxHeight: 240 });
  const side = useRef<'above' | 'below' | null>(null);
  const caps = catalogCapabilities ?? (resolvedBinding.runtime === agentStatus?.runtime ? agentStatus.capabilities : null);
  const hasModels = !!(caps?.models || caps?.providerModels || resolvedBinding.model);
  const searchable = page === 'model' && providerModels.length > 7;
  const effort = resolveComposerReasoning(resolvedBinding, agentStatus, catalogCapabilities, providerModels, providers);
  const runtimeLabel = agentStatus?.availableRuntimes?.find((runtime) => runtime.id === resolvedBinding.runtime)?.label || resolvedBinding.runtime;
  const modelLabel = modelDisplayLabel(resolvedBinding.runtime, resolvedBinding.model, providerModels);
  const providerLabel = providers.find((provider) => provider.id === resolvedBinding.provider)?.label || resolvedBinding.provider || 'Default provider';
  const closeRef = useRef(onClose);
  const returnTarget = useRef<PickerPage>('runtime');
  const pageRef = useRef(page);
  useLayoutEffect(() => { closeRef.current = onClose; pageRef.current = page; ultracodeEnabledRef.current = ultracode?.enabled; });

  const dismiss = useCallback((restoreFocus: boolean) => {
    cancel();
    if (restoreFocus) anchor.trigger?.focus({ preventScroll: true });
    closeRef.current();
  }, [anchor.trigger, cancel]);

  const navigate = (next: PickerPage) => {
    cancel();
    if (next !== 'overview') returnTarget.current = next;
    setQuery('');
    setPage(next);
  };

  // Keep the same surface mounted while moving between lists. Focus follows
  // the current page, not catalog revalidation or streamed parent renders.
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [page, query]);

  useLayoutEffect(() => {
    const target = page === 'overview'
      ? bodyRef.current?.querySelector<HTMLButtonElement>(`[data-picker-page="${returnTarget.current}"]`)
      : searchRef.current ?? bodyRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (target ?? bodyRef.current?.querySelector<HTMLElement>(focusableSelector))?.focus({ preventScroll: true });
  }, [page]);

  useLayoutEffect(() => {
    if (saving) return;
    const target = savingFocusRef.current;
    savingFocusRef.current = null;
    // Native disabled controls lose focus while an asynchronous save runs.
    if (target?.isConnected && document.activeElement === document.body) target.focus({ preventScroll: true });
  }, [saving]);

  useLayoutEffect(() => {
    if (page === 'overview' && !effort.adjustable && document.activeElement === document.body) {
      bodyRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus({ preventScroll: true });
    }
  }, [effort.adjustable, page]);

  useAnchoredPosition({ anchor: anchor.trigger ?? null, surfaceRef, dependencies: [anchor, page, searchable], measure: () => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const trigger = anchor.trigger?.getBoundingClientRect();
    const aboveEdge = trigger ? trigger.top - 6 : anchor.anchorBottom;
    const belowEdge = anchor.trigger ? composerMenuBelowEdge(anchor.trigger) : anchor.y;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const height = viewport?.height ?? window.innerHeight;
    const width = viewport?.width ?? window.innerWidth;
    const aboveSpace = aboveEdge === undefined ? 0 : aboveEdge - viewportTop - 8;
    const belowSpace = viewportTop + height - belowEdge - 8;
    const frame = getComputedStyle(surface);
    // The surface grows in (scale .97→1); a pass during that measures the
    // box it settles to, not the scaled one on screen.
    const rect = measureSurface(surface);
    const content = contentRef.current;
    // The exported cap belongs to the scrolling list, not its search/back
    // chrome; the summary page's own cap (CSS) is a little higher.
    const contentCap = content ? parseFloat(getComputedStyle(content).maxHeight) : NaN;
    const listHeight = Number.isFinite(contentCap) ? contentCap : parseFloat(frame.getPropertyValue('--m-maxHeight')) || 240;
    // Measured down to the list's top edge: the search page reserves height
    // under its list, and counting that as chrome would grow it each pass.
    const chromeHeight = content
      ? (content.getBoundingClientRect().top - rect.box.top) / rect.scaleY
        + (parseFloat(frame.paddingBottom) || 0) + (parseFloat(frame.borderBottomWidth) || 0)
      : 0;
    // The summary page picks the side; its sub-pages keep that side so
    // moving between them never flips the surface.
    if (page === 'overview' || side.current === null) {
      const wanted = chromeHeight + (searchable || !content ? listHeight : Math.min(listHeight, content.scrollHeight));
      side.current = pickMenuSide({ aboveSpace, belowSpace, wanted, preferBelow: anchor.preferBelow });
    }
    const above = side.current === 'above';
    const maxHeight = Math.max(80, Math.min(listHeight + chromeHeight, above ? aboveSpace : belowSpace, height - 16));
    const top = above && aboveEdge !== undefined ? aboveEdge - Math.min(rect.height, maxHeight) : belowEdge;
    const next = {
      left: Math.max(viewportLeft + 8, Math.min(anchor.align === 'end' ? (trigger?.right ?? anchor.x) - rect.width : trigger?.left ?? anchor.x, viewportLeft + width - rect.width - 8)),
      top: Math.max(viewportTop + 8, Math.min(top, viewportTop + height - Math.min(rect.height, maxHeight) - 8)),
      maxHeight,
    };
    setPosition((previous) => Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
  } });

  // Inside the caller's <AnimatePresence> a closed picker fades out for a
  // moment (PopoverSurface); meanwhile it takes no clicks, keys or selections.
  const present = useIsPresent();
  useEffect(() => {
    if (!present) cancel();
  }, [present, cancel]);

  // Esc and the phone's Back: a list goes back to the summary, the summary closes.
  const stepBack = useCallback(() => {
    cancel();
    if (pageRef.current !== 'overview') { setPage('overview'); setQuery(''); }
    else dismiss(true);
  }, [cancel, dismiss]);
  useBackLayer(present, { back: stepBack });

  useEffect(() => {
    mountedRef.current = true;
    if (!present) return () => { mountedRef.current = false; };
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (surfaceRef.current?.contains(event.target) || anchor.trigger?.contains(event.target)) return;
      dismiss(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      stepBack();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', keyboard, true);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', keyboard, true);
    };
  }, [present, anchor.trigger, dismiss, stepBack]);

  useLayoutEffect(() => { cancel(); }, [resolvedBinding.runtime, resolvedBinding.provider, resolvedBinding.model, cancel]);

  const select = async (action: () => void | Promise<void>, nextPage = page, inline = false): Promise<boolean> => {
    if (busyRef.current) {
      if (!inline) return false;
      // An inline control stays live while it saves: its newest pick saves
      // next, and one it replaces before then did not fail.
      queuedRef.current?.resolve(true);
      return new Promise((resolve) => { queuedRef.current = { run: () => select(action, nextPage, true), resolve }; });
    }
    busyRef.current = true;
    setSaveError(null);
    try {
      const result = action();
      if (result) {
        if (!inline) savingFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setSaving(inline ? 'inline' : 'list');
        await result;
      }
      if (mountedRef.current) navigate(nextPage);
      return true;
    } catch (error) {
      if (mountedRef.current) setSaveError(error instanceof Error ? error.message : 'Could not save selection');
      return false;
    } finally {
      busyRef.current = false;
      const queued = queuedRef.current;
      queuedRef.current = null;
      if (queued && mountedRef.current) void queued.run().then(queued.resolve);
      else {
        queued?.resolve(false);
        if (mountedRef.current) setSaving(null);
      }
    }
  };

  // The switch shows its pick until the chat's choice arrives with it (a
  // render after the save can settle); a failed last save returns it.
  useLayoutEffect(() => {
    if (ultracodeSaves.current === 0 && ultracodePending === ultracode?.enabled) setUltracodePending(null);
  }, [ultracode?.enabled, ultracodePending]);
  const toggleUltracode = () => {
    if (!ultracode || !onSaveUltracode) return;
    const next = !(ultracodePending ?? ultracode.enabled);
    ultracodeSaves.current += 1;
    setUltracodePending(next);
    void select(() => onSaveUltracode(next), page, true).then((saved) => {
      ultracodeSaves.current -= 1;
      if (!mountedRef.current || ultracodeSaves.current > 0) return;
      setUltracodePending((shown) => !saved || shown === ultracodeEnabledRef.current ? null : shown);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Tab') {
      // Restore the trigger before native Tab advances into the composer.
      dismiss(true);
      return;
    }
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (input?.type === 'range') return;
    if (event.key === 'ArrowLeft' && !input && page !== 'overview') {
      event.preventDefault(); navigate('overview'); return;
    }
    // Right opens a summary row's page; a switch is toggled with Space or Enter only.
    if (event.key === 'ArrowRight' && !input && page === 'overview' && (event.target as HTMLElement).getAttribute('role') !== 'switch') {
      event.preventDefault(); (event.target as HTMLButtonElement).click(); return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    if (input && ['Home', 'End'].includes(event.key)) return;
    const options = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)') ?? []);
    const items = page !== 'overview' && options.length ? options
      : Array.from(bodyRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter((item) => item !== searchRef.current);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : current < 0 ? event.key === 'ArrowDown' ? 0 : items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index].focus({ preventScroll: true });
    items[index].scrollIntoView?.({ block: 'nearest' });
  };

  const catalogStatus = (modelsLoading || modelsError || providerModels.length === 0) && (
    <div className="composer-picker-status" role="status">
      <span>{modelsError || (modelsLoading ? modelsWaiting ? 'Still loading models…' : 'Loading models…' : 'No models available')}</span>
      {(modelsError || modelsWaiting || !modelsLoading) && (
        <button type="button" className="composer-picker-icon" title={modelsError ? 'Retry' : 'Reload models'} aria-label={modelsError ? 'Retry' : 'Reload models'} onClick={() => {
          bodyRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus({ preventScroll: true });
          onRetryModels();
        }}>
          <RetryIcon />
        </button>
      )}
    </div>
  );
  const filteredModels = providerModels.filter((model) => `${model.label ?? ''} ${model.id} ${model.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const summaryRow = (target: PickerPage, label: string, value: string) => (
    <button type="button" className="composer-picker-row composer-picker-summary" data-picker-page={target}
      aria-label={`Select ${label.toLowerCase()}: ${value}`} onClick={() => navigate(target)} disabled={listSaving}>
      <span className="composer-picker-copy"><span className="composer-picker-caption">{label}</span><span className="composer-picker-value">{value}</span></span>
      <ChevronRightIcon />
    </button>
  );
  const option = (id: string, label: string, checked: boolean, action: () => void | Promise<void>, description?: string, disabled = false) => (
    <button key={id} type="button" role="menuitemradio" aria-checked={checked} disabled={disabled || listSaving}
      className={`composer-picker-row${blinkingId === `${page}-${id}` ? ' ui-menu-blink' : ''}`}
      onClick={() => confirm(`${page}-${id}`, () => { if (checked) navigate('overview'); else void select(action, 'overview'); })}>
      <span className="composer-picker-copy"><span className="composer-picker-value">{label}</span>{description && <span className="composer-picker-caption">{description}</span>}</span>
      <span className="michi-menu-glyph" aria-hidden="true">{checked ? '✓' : ''}</span>
    </button>
  );

  return (
    <PopoverSurface ref={surfaceRef} menuKind="composer" left={position.left} top={position.top} width="var(--m-width)" maxWidth="calc(100vw - 16px)" maxHeight={position.maxHeight}
      role="dialog" aria-label="Model settings" escapeLayer="over" className="composer-picker"
      style={{
        overflow: 'hidden',
        // Reserve the search page height so filtering cannot move its navigation.
        height: searchable ? position.maxHeight : undefined,
      }} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <div ref={bodyRef} onKeyDown={onKeyDown} className="composer-picker-body" aria-busy={saving !== null}>
        {page !== 'overview' && (
          <div className="composer-picker-header">
            <button type="button" className="composer-picker-icon" aria-label="Back to model settings" title="Back" onClick={() => navigate('overview')}><ChevronLeftIcon /></button>
          </div>
        )}
        {searchable && (
          <div className="michi-menu-search">
            <input ref={searchRef} type="search" aria-label="Search models" placeholder="Search models" value={query} onChange={(event) => { cancel(); setQuery(event.target.value); }} />
          </div>
        )}
        <div ref={contentRef} className="composer-picker-content" data-page={page}>
          {page === 'overview' ? (
            <>
              {summaryRow('runtime', 'Runtime', runtimeLabel)}
              {caps?.providerModels && onSaveProvider && providers.length > 0 && summaryRow('provider', 'Provider', providerLabel)}
              {hasModels && summaryRow('model', 'Model', modelLabel)}
              {effort.adjustable && <EffortControl key={JSON.stringify([resolvedBinding.runtime, resolvedBinding.provider, resolvedBinding.model, effort.levels])} levels={effort.levels} value={effort.value} disabled={listSaving}
                onSelect={(value) => select(() => onSaveReasoning(value), page, true)} />}
              {caps?.ultracode && ultracode && onSaveUltracode && (
                <button type="button" role="switch" aria-checked={ultracodePending ?? ultracode.enabled} disabled={listSaving}
                  className="composer-picker-row composer-picker-switch" data-unavailable={ultracode.available === false || undefined}
                  onClick={toggleUltracode}>
                  <span className="composer-picker-copy">
                    <span className="composer-picker-value">Ultracode</span>
                    <span className="composer-picker-caption">{ultracodeNote(ultracode)}</span>
                  </span>
                  <span className="composer-picker-switch-track" aria-hidden="true"><span className="composer-picker-switch-thumb" /></span>
                </button>
              )}
              {!caps && catalogStatus}
            </>
          ) : page === 'model' ? (
            <>
              {catalogStatus}
              <div role="menu" aria-label="Models" className="composer-picker-options">
                {resolvedBinding.model && !providerModels.some((model) => model.id === resolvedBinding.model) && !query && option('current', modelLabel, true, () => {}, 'Current model')}
                {filteredModels.map((model) => option(model.id, model.label || model.id, model.id === resolvedBinding.model, () => onSaveModel(model.id), model.description || (caps?.providerModels && model.label !== model.id ? model.id : undefined)))}
              </div>
              {query && !filteredModels.length && <div className="composer-picker-status" role="status">No matching models</div>}
            </>
          ) : page === 'runtime' ? (
            <div role="menu" aria-label="Runtimes" className="composer-picker-options">
              {filterAvailableRuntimes(agentStatus?.availableRuntimes ?? []).map((runtime) =>
                option(runtime.id, runtime.label || runtime.id, runtime.id === resolvedBinding.runtime, () => onSwitchRuntime(runtime.id)))}
            </div>
          ) : (
            <div role="menu" aria-label="Providers" className="composer-picker-options">
              {providers.map((provider) => option(provider.id, provider.label || provider.id, provider.id === resolvedBinding.provider, () => onSaveProvider?.(provider.id), provider.hasKey === false ? 'No API key configured' : undefined))}
            </div>
          )}
          {listSaving && <div role="status" className="composer-picker-status">Saving…</div>}
          {saveError && <div role="alert" className="composer-picker-status composer-picker-error">{saveError}</div>}
        </div>
      </div>
    </PopoverSurface>
  );
}

function EffortControl({ levels, value, disabled, onSelect }: {
  levels: AgentReasoning[]; value?: AgentReasoning; disabled: boolean;
  onSelect: (value: AgentReasoning) => Promise<boolean>;
}) {
  const [preview, setPreview] = useState<AgentReasoning | null>(null);
  const dragging = useRef(false);
  // The newest pick until the value shows it, and every pick made here.
  const awaiting = useRef<AgentReasoning | null>(null);
  const picked = useRef(new Set<AgentReasoning>());
  const current = preview ?? value;
  const index = Math.max(0, levels.findIndex((level) => level === current));
  const label = current ? REASONING_LABELS[current] ?? current : 'Default';
  // A save can settle before the caller's binding catches up (Home reloads
  // agent status afterwards), so a saved pick stays shown until the value
  // arrives, through an earlier pick's value on the way; only a failed save
  // returns the slider to the saved value.
  useLayoutEffect(() => {
    if (dragging.current) return;
    if (awaiting.current !== null && value !== awaiting.current && value !== undefined && picked.current.has(value)) return;
    awaiting.current = null;
    setPreview(null);
  }, [value]);
  const commit = (next: AgentReasoning) => {
    if (next === value && awaiting.current === null) { setPreview(null); return; }
    awaiting.current = next;
    picked.current.add(next);
    setPreview(next);
    void onSelect(next).then((saved) => {
      if (saved || awaiting.current !== next) return;
      awaiting.current = null;
      setPreview(null);
    });
  };
  return (
    <div className="composer-picker-effort">
      <div className="composer-picker-effort-heading"><span>Thinking effort</span><span aria-live="polite">{label}</span></div>
      <input type="range" className="composer-picker-range" aria-label="Thinking effort" aria-valuetext={label} min={0} max={levels.length - 1} step={1} value={index}
        disabled={disabled || levels.length < 2} style={{ '--effort-progress': `${levels.length > 1 ? index / (levels.length - 1) * 100 : 0}%` } as React.CSSProperties}
        onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); }}
        onChange={(event) => { const next = levels[Number(event.target.value)]; setPreview(next); if (!dragging.current) commit(next); }}
        onPointerUp={(event) => { dragging.current = false; commit(levels[Number(event.currentTarget.value)]); }}
        onPointerCancel={() => { dragging.current = false; setPreview(null); }} />
      <div className="composer-picker-effort-stops" aria-hidden="true">
        {levels.map((level) => <span key={level} title={REASONING_LABELS[level] ?? level} data-selected={current === level || undefined} />)}
      </div>
      <div className="composer-picker-effort-extents"><span>{REASONING_LABELS[levels[0]] ?? levels[0]}</span><span>{REASONING_LABELS[levels[levels.length - 1]] ?? levels[levels.length - 1]}</span></div>
    </div>
  );
}
