import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  formatTokenCount,
  META_AGENT_DEFAULT_FIRST_RUN_DAYS,
  META_AGENT_FIRST_RUN_DAYS,
  META_AGENT_RUNTIMES,
  type MetaAgentFirstRunDays,
  type MetaAgentSettings as Settings,
  type MetaAgentSettingsPatch,
  type MetaAgentToolApproval,
  type MetaAgentUsageToday,
} from 'michi-shared';
import { FOLLOW_GLOBAL_PATCH, type MetaAgentInfo } from '../../../../services/api/metaAgent';
import { fetchAgentStatus, type AgentReasoning, type AgentStatus } from '../../../../services/api/agentRuntime';
import {
  metaAgentGuardFailures,
  refreshMetaAgent,
  retryMetaAgentGuard,
  saveMetaAgentSettings,
  saveMetaAgentToolApproval,
  useMetaAgent,
} from '../../../../state/metaAgent/useMetaAgent';
import type { ResolvedNodeBinding } from '../../../../state/nodeBindingResolution';
import { useRuntimeCatalog } from '../../../../hooks/useRuntimeCatalog';
import { filterAvailableRuntimes } from '../../../../lib/runtimeVisibility';
import { useBackendScope } from '../../../../hooks/useBackendScope';
import { resolveComposerReasoning } from '../../composerReasoning';
import { modelDisplayLabel } from '../../../../lib/modelLabel';
import { REASONING_LABELS } from '../../PaneComposerToolbarLeft';
import { Button, Switch } from '../../../ui/controls';
import { MetaAgentGuardAlert } from './MetaAgentGuardAlert';
import { META_AGENT_PAGE_POLL_MS, pauseMetaAgentMaintenance, refreshMetaAgentOverview, useMetaAgentOverview } from '../../../../state/metaAgent/useMetaAgentOverview';
import { metaAgentStatus } from '../../../../state/metaAgent/metaAgentStatus';
import { retryStoppedMetaAgent } from '../../../../state/metaAgent/metaAgentUpdate';
import { useCompanionName } from '../../../../state/companion/companionName';
import { UPKEEP_HEADLINE } from '../../scheduled/metaAgent/metaAgentCopy';
import {
  isMetaAgentRuntimeSupported, metaAgentProfileText, metaAgentRuntimeLabel, runtimeUnavailableText, type MetaAgentProfile,
} from './runtimeCopy';
import { smoothScrollBehavior } from '../../../../hooks/useReducedMotion';
import './metaAgentSettings.css';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';

/**
 * Settings › <name> › Pages upkeep (DESIGN-v2 §1.5; Settings › Meta agent
 * before v2): which runtime the background Pages upkeep uses, how it is
 * restricted, and what it reads and writes. Its subsections are h3s under
 * the page's Pages upkeep heading.
 */
export function PagesUpkeepSettings() {
  const { status, info, error } = useMetaAgent();
  return (
    <div className="meta-set">
      {status === 'loading' && !info && <p className="meta-set__quiet" role="status">Loading Pages upkeep…</p>}
      {status === 'unavailable' && (
        <p className="meta-set__quiet" role="status">This Michi backend does not run Pages upkeep yet. Its settings appear here once it does.</p>
      )}
      {status === 'error' && !info && (
        <p className="meta-set__quiet is-error" role="alert">
          Couldn’t load Pages upkeep{error ? `: ${error}` : ''}.{' '}
          <button type="button" className="meta-set__link" onClick={() => { void refreshMetaAgent(); }}>Try again</button>
        </p>
      )}
      {info && <MetaAgentForm info={info} />}
    </div>
  );
}

/** The local backend's agent status: what the global runtime settings are now. */
export function useLocalAgentStatus(): AgentStatus | null {
  const scope = useBackendScope(LOCAL_BACKEND_CONNECTION_ID);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    fetchAgentStatus(LOCAL_BACKEND_CONNECTION_ID, controller.signal).then(
      (next) => { if (live) setStatus(next); },
      () => { if (live) setStatus(null); },
    );
    return () => { live = false; controller.abort(); };
  }, [scope.key]);
  return status;
}

/** A section whose setting was just saved shows "Saved" beside its heading for this long. */
const SAVED_MS = 2_000;

type SettingsSection = 'runtime' | 'reading' | 'writing';

function useSavedNote(): { saved: SettingsSection | null; noteSaved: (section: SettingsSection) => void } {
  const [saved, setSaved] = useState<SettingsSection | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const noteSaved = useCallback((section: SettingsSection) => {
    if (timer.current) clearTimeout(timer.current);
    setSaved(section);
    timer.current = setTimeout(() => { timer.current = null; setSaved(null); }, SAVED_MS);
  }, []);
  return { saved, noteSaved };
}

function SectionError({ error, section }: { error: { section: SettingsSection; message: string } | null; section: SettingsSection }) {
  return error?.section === section ? <p className="meta-set__error" role="alert">{error.message}</p> : null;
}

function SectionHead({ id, title, saved }: { id?: string; title: string; saved: boolean }) {
  return (
    <div className="meta-set__head">
      <h3 id={id}>{title}</h3>
      <span className="meta-set__saved" aria-live="polite">{saved && <><Check size={13} strokeWidth={2} aria-hidden="true" />Saved</>}</span>
    </div>
  );
}

function MetaAgentForm({ info }: { info: MetaAgentInfo }) {
  const name = useCompanionName();
  const agentStatus = useLocalAgentStatus();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ section: SettingsSection; message: string } | null>(null);
  const { saved, noteSaved } = useSavedNote();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const runtimeRef = useRef<HTMLElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const radioName = useId();
  const headingId = useId();

  const { settings, resolved } = info;
  const custom = settings.runtimeId !== null;
  const firstRunDays = settings.firstRunDays ?? META_AGENT_DEFAULT_FIRST_RUN_DAYS;
  const failures = metaAgentGuardFailures(info);
  const globalProfile: MetaAgentProfile | null = resolved.followsGlobal
    ? resolved
    : agentStatus ? { runtimeId: agentStatus.runtime, modelId: agentStatus.model ?? null, reasoning: agentStatus.reasoning ?? null } : null;

  const save = async (patch: MetaAgentSettingsPatch, section: SettingsSection = 'runtime') => {
    setSaving(true);
    setError(null);
    try {
      await saveMetaAgentSettings(patch);
      if (mounted.current) noteSaved(section);
    } catch (err) {
      if (mounted.current) setError({ section, message: err instanceof Error && err.message ? err.message : 'Couldn’t save the Pages upkeep settings' });
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const runtimeAvailable = (id: string) => isMetaAgentRuntimeSupported(id)
    && agentStatus?.availableRuntimes.find((runtime) => runtime.id === id)?.available !== false;
  // Custom starts from what Pages upkeep runs on now, so choosing it changes nothing until a
  // runtime is picked; when that runtime cannot run it, it starts from the first one that can.
  const chooseCustom = () => {
    if (custom) return;
    if (info.availability.available) {
      void save({ runtimeId: resolved.runtimeId, providerId: resolved.providerId, modelId: resolved.modelId, reasoning: resolved.reasoning });
      return;
    }
    const fallback = META_AGENT_RUNTIMES.find((id) => id !== resolved.runtimeId && runtimeAvailable(id));
    if (fallback) void save({ runtimeId: fallback, providerId: null, modelId: null, reasoning: null });
  };
  const chooseFollow = () => { if (custom) void save(FOLLOW_GLOBAL_PATCH); };
  const changeRuntime = () => {
    runtimeRef.current?.scrollIntoView?.({ behavior: smoothScrollBehavior(), block: 'start' });
    customRef.current?.focus({ preventScroll: true });
  };
  // Tool approvals sit near the bottom; a request waiting for a decision is pointed to from the top,
  // where the approval notice's Review opens this page.
  const approvalsRef = useRef<HTMLElement>(null);
  const pendingApprovals = (info.toolApprovals ?? []).filter((request) => request.state === 'pending').length;
  const reviewApprovals = () => {
    approvalsRef.current?.scrollIntoView?.({ behavior: smoothScrollBehavior(), block: 'start' });
    approvalsRef.current?.querySelector<HTMLButtonElement>('[data-pending] button')?.focus({ preventScroll: true });
  };

  return (
    <>
      {pendingApprovals > 0 && (
        <p className="meta-set__pending" role="status">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
          {pendingApprovals === 1 ? 'A tool is waiting for your approval.' : `${pendingApprovals} tools are waiting for your approval.`}{' '}
          <button type="button" className="meta-set__link" onClick={reviewApprovals}>Review</button>
        </p>
      )}
      <MetaAgentGuardAlert failures={failures} onRetry={retryMetaAgentGuard} onChangeRuntime={changeRuntime} />
      <StoppedAlert info={info} onChangeRuntime={changeRuntime} />

      <section className="meta-set__sec" ref={runtimeRef} aria-labelledby={headingId}>
        <SectionHead id={headingId} title="Runtime" saved={saved === 'runtime'} />
        <div className="meta-set__body">
        {!info.availability.available && (
          <div className="meta-set__notice" role="status">
            <TriangleAlert size={15} strokeWidth={1.75} aria-hidden="true" />
            <p>{info.availability.reason ?? `Pages upkeep cannot run on ${metaAgentRuntimeLabel(resolved.runtimeId)}.`}</p>
            {!custom && <Button disabled={saving} onClick={chooseCustom}>Use a custom runtime</Button>}
          </div>
        )}
        <div className="meta-set__radio" data-checked={!custom}>
          <label className="meta-set__radio-head">
            <input type="radio" name={radioName} checked={!custom} disabled={saving} onChange={chooseFollow} />
            <span>
              <span className="meta-set__radio-t">Follow global settings</span>
              <span className="meta-set__radio-d">
                {globalProfile ? `Now ${metaAgentProfileText(globalProfile)}. ` : 'Uses Settings › Runtime (global). '}
                Change the global settings and Pages upkeep follows from its next run.
              </span>
            </span>
          </label>
        </div>
        <div className="meta-set__radio" data-checked={custom}>
          <label className="meta-set__radio-head">
            <input ref={customRef} type="radio" name={radioName} checked={custom} disabled={saving} onChange={chooseCustom} />
            <span>
              <span className="meta-set__radio-t">Custom</span>
              <span className="meta-set__radio-d">Only for Pages upkeep. Your conversation with {name}, and its check-ins, stay on what the conversation uses.</span>
            </span>
          </label>
          {custom && <CustomRuntime settings={settings} resolved={resolved} agentStatus={agentStatus} saving={saving} onSave={(patch) => { void save(patch); }} />}
        </div>
        <SectionError error={error} section="runtime" />
        </div>
      </section>

      <section className="meta-set__sec">
        <SectionHead title="Reading" saved={saved === 'reading'} />
        <div className="meta-set__body">
        <BackgroundUpdatesRow name={name} onSaved={() => noteSaved('reading')} onError={(message) => setError(message ? { section: 'reading', message } : null)} />
        <SettingRow label="First run" control={(
          <select
            className="ui-select"
            aria-label="First-run range"
            title="Applies to workspaces read for the first time after the change"
            value={firstRunDays}
            disabled={saving}
            onChange={(event) => { void save({ firstRunDays: Number(event.target.value) as MetaAgentFirstRunDays }, 'reading'); }}
          >
            {META_AGENT_FIRST_RUN_DAYS.map((days) => <option key={days} value={days}>{days} days</option>)}
          </select>
        )}>
          Last {firstRunDays} days of conversations, up to 1,000
        </SettingRow>
        <SettingRow label="Never read">
          Scheduled-job output, your conversation with {name}, and archived or deleted conversations
        </SettingRow>
        <SectionError error={error} section="reading" />
        </div>
      </section>

      <section className="meta-set__sec">
        <SectionHead title="Writing" saved={saved === 'writing'} />
        <div className="meta-set__body">
        <SettingRow label="Workspace homes" control={(
          <>
            <span className="meta-set__state">{settings.writeWorkspaceHomes !== false ? 'On' : 'Off'}</span>
            <Switch on={settings.writeWorkspaceHomes !== false} disabled={saving} aria-label="Write workspace homes"
              onChange={(on) => { void save({ writeWorkspaceHomes: on }, 'writing'); }} />
          </>
        )}>
          Keeps each workspace’s home page up to date
        </SettingRow>
        <SettingRow label="Pages home" control={(
          <>
            <span className="meta-set__state">{settings.maintainSpacesHome !== false ? 'On' : 'Off'}</span>
            <Switch on={settings.maintainSpacesHome !== false} disabled={saving} aria-label="Maintain the Pages home"
              onChange={(on) => { void save({ maintainSpacesHome: on }, 'writing'); }} />
          </>
        )}>
          Keeps the overview on the Pages Home up to date from the workspace homes
        </SettingRow>
        <SettingRow label="Blocks you edited" control={(
          <>
            <span className="meta-set__state">Always on</span>
            <Switch on disabled onChange={() => {}} aria-label="Human-edited blocks only get suggestions" />
          </>
        )}>
          {name} suggests a change and you accept it. On home pages it updates its own blocks directly, also after you tick or edit them
        </SettingRow>
        <SectionError error={error} section="writing" />
        </div>
      </section>

      <ToolApprovals info={info} sectionRef={approvalsRef} />

      <section className="meta-set__sec">
        <h3>Usage</h3>
        <div className="meta-set__body"><p className="meta-set__usage">{usageText(info.usageToday ?? null)}</p></div>
      </section>
    </>
  );
}

const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`;

function usageText(usage: MetaAgentUsageToday | null): string {
  if (!usage) return 'Today’s usage could not be counted.';
  const calls = `Today: ${plural(usage.checks, 'check')}, ${plural(usage.modelCalls, 'AI call')}`;
  return usage.tokens === null
    ? `${calls}; the AI service didn’t say how many tokens it used.`
    : `${calls}, about ${formatTokenCount(usage.tokens)} tokens.`;
}

/**
 * Pausing and resuming the background updates: the same switch as the
 * Pages upkeep row in Scheduled. The conversation keeps working while paused.
 */
function BackgroundUpdatesRow({ name, onSaved, onError }: { name: string; onSaved: () => void; onError: (message: string | null) => void }) {
  const load = useMetaAgentOverview(META_AGENT_PAGE_POLL_MS);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  if (load.kind === 'unavailable') {
    return <SettingRow label="Background updates">Checks every workspace for new conversations every 60 seconds</SettingRow>;
  }
  const paused = load.kind === 'ready' && load.overview.state === 'paused';
  const toggle = (on: boolean) => {
    setBusy(true);
    onError(null);
    pauseMetaAgentMaintenance(!on).then(
      () => { if (mounted.current) onSaved(); },
      (reason: unknown) => {
        if (mounted.current) onError(reason instanceof Error && reason.message ? reason.message : 'Couldn’t change the background updates');
        void refreshMetaAgentOverview();
      },
    ).finally(() => { if (mounted.current) setBusy(false); });
  };
  return (
    <SettingRow label="Background updates" control={(
      <>
        <span className="meta-set__state">{load.kind !== 'ready' ? '' : paused ? 'Paused' : 'On'}</span>
        <Switch on={load.kind === 'ready' && !paused} disabled={busy || load.kind !== 'ready'} aria-label="Background updates"
          onChange={toggle} />
      </>
    )}>
      {paused
        ? `Paused. New conversations aren’t read and pages aren’t updated in the background. Your conversation with ${name} still works.`
        : 'Checks every workspace for new conversations every 60 seconds; when nothing is new, no AI is used'}
    </SettingRow>
  );
}

function SettingRow({ label, control, children }: {
  label: string;
  control?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="meta-set__row">
      <span className="meta-set__row-k">{label}</span>
      <span className="meta-set__row-v">{children}</span>
      <span className="meta-set__ctl">{control}</span>
    </div>
  );
}

/** One runtime that can't be chosen: why, in plain words, and how to install it behind a link. */
function UnavailableHint({ id, reason }: { id: string; reason: string | undefined }) {
  const [open, setOpen] = useState(false);
  const { text, install, detail } = runtimeUnavailableText(id, reason);
  const more = install.length > 0 || detail !== null;
  return (
    <li>
      {text}
      {more && (
        <>
          {' '}
          <button type="button" className="meta-set__link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {install.length ? 'How to install' : 'Details'}
          </button>
        </>
      )}
      {open && install.length > 0 && (
        <span className="meta-set__install">
          Run {install.length > 1 ? 'one of these' : 'this'} in a terminal, then reopen Settings:
          {install.map((command) => <code key={command}>{command}</code>)}
        </span>
      )}
      {open && !install.length && detail && <span className="meta-set__install">{detail}</span>}
    </li>
  );
}

function CustomRuntime({ settings, resolved, agentStatus, saving, onSave }: {
  settings: Settings;
  /** What the record resolves to now: names what "Default" stands for. */
  resolved: MetaAgentInfo['resolved'];
  agentStatus: AgentStatus | null;
  saving: boolean;
  onSave: (patch: MetaAgentSettingsPatch) => void;
}) {
  const runtimeId = settings.runtimeId ?? '';
  const catalog = useRuntimeCatalog({ enabled: true, connectionId: LOCAL_BACKEND_CONNECTION_ID, runtime: runtimeId, provider: settings.providerId });
  const binding: ResolvedNodeBinding = {
    runtime: runtimeId,
    provider: settings.providerId ?? undefined,
    model: settings.modelId ?? undefined,
    reasoning: settings.reasoning ?? undefined,
    source: 'global',
  };
  const effortFor = (model: ResolvedNodeBinding['model']) => resolveComposerReasoning(
    { ...binding, model }, agentStatus, catalog.capabilities, catalog.models, catalog.providers);
  const effort = effortFor(binding.model);
  const pickedLevel = settings.reasoning !== null && effort.levels.includes(settings.reasoning) ? settings.reasoning : null;
  const modelMissing = !!settings.modelId && !catalog.models.some((model) => model.id === settings.modelId);
  const providerMissing = !!settings.providerId && !catalog.providers.some((provider) => provider.id === settings.providerId);
  const runtimeOption = (id: string) => agentStatus?.availableRuntimes.find((runtime) => runtime.id === id);
  const visibleRuntimeIds = new Set(filterAvailableRuntimes(agentStatus?.availableRuntimes ?? []).map((runtime) => runtime.id));
  // Unavailable runtimes are hidden; only a saved choice that became unavailable is explained.
  const unavailableIds = META_AGENT_RUNTIMES.filter((id) => id === runtimeId && runtimeOption(id)?.available === false);
  // "Default" names what it stands for, read from the resolved runtime of the same runtime only.
  const sameRuntime = resolved.runtimeId === runtimeId;
  const defaultOf = (value: string | null | undefined) => (sameRuntime && value ? `Default (${value})` : 'Default');
  const defaultProvider = settings.providerId === null
    ? defaultOf(catalog.providers.find((provider) => provider.id === resolved.providerId)?.label ?? resolved.providerId) : 'Default';
  const defaultModel = settings.modelId === null && resolved.modelId
    ? defaultOf(modelDisplayLabel(runtimeId, resolved.modelId, catalog.models)) : 'Default';
  const defaultReasoning = settings.reasoning === null && resolved.reasoning
    ? defaultOf(REASONING_LABELS[resolved.reasoning] ?? resolved.reasoning) : 'Default';

  // A reasoning level the new model does not offer goes back to the model's default.
  const saveModel = (next: string | null) => {
    const levels = effortFor(next ?? undefined);
    const drop = settings.reasoning !== null && levels.known && catalog.models.length > 0 && !levels.levels.includes(settings.reasoning);
    onSave(drop ? { modelId: next, reasoning: null } : { modelId: next });
  };

  return (
    <div className="meta-set__custom">
      <div className="meta-set__chips" role="group" aria-label="Pages upkeep runtime">
        {META_AGENT_RUNTIMES.filter((id) => visibleRuntimeIds.has(id) && isMetaAgentRuntimeSupported(id)).map((id) => (
            <Button
              key={id}
              className="meta-set__chip"
              aria-pressed={id === runtimeId}
              disabled={saving}
              // A model belongs to one runtime: switching starts from the new runtime's defaults.
              onClick={() => { if (id !== runtimeId) onSave({ runtimeId: id, providerId: null, modelId: null, reasoning: null }); }}
            >
              {metaAgentRuntimeLabel(id)}
            </Button>
        ))}
      </div>
      {unavailableIds.length > 0 && (
        <ul className="meta-set__hints">
          {unavailableIds.map((id) => <UnavailableHint key={id} id={id} reason={runtimeOption(id)?.unavailableReason} />)}
        </ul>
      )}
      <div className="meta-set__pickers">
        {(catalog.providers.length > 1 || providerMissing) && (
          <label className="meta-set__picker">
            Provider
            <select
              className="ui-select"
              aria-label="Pages upkeep provider"
              value={settings.providerId ?? ''}
              disabled={saving}
              onChange={(event) => onSave({ providerId: event.target.value || null, modelId: null, reasoning: null })}
            >
              <option value="">{defaultProvider}</option>
              {providerMissing && <option value={settings.providerId!}>{settings.providerId}</option>}
              {catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
            </select>
          </label>
        )}
        <label className="meta-set__picker">
          Model
          <select
            className="ui-select"
            aria-label="Pages upkeep model"
            value={settings.modelId ?? ''}
            disabled={saving}
            onChange={(event) => saveModel(event.target.value || null)}
          >
            <option value="">{defaultModel}</option>
            {modelMissing && <option value={settings.modelId!}>{modelDisplayLabel(runtimeId, settings.modelId!, catalog.models)}</option>}
            {catalog.models.map((model) => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
          </select>
        </label>
        {effort.adjustable && (
          <label className="meta-set__picker">
            Reasoning
            <select
              className="ui-select"
              aria-label="Pages upkeep reasoning"
              value={pickedLevel ?? ''}
              disabled={saving}
              onChange={(event) => onSave({ reasoning: (event.target.value || null) as AgentReasoning | null })}
            >
              <option value="">{defaultReasoning}</option>
              {effort.levels.map((level: AgentReasoning) => <option key={level} value={level}>{REASONING_LABELS[level] ?? level}</option>)}
            </select>
          </label>
        )}
        {catalog.loading && <span className="meta-set__catalog">Reading models…</span>}
        {!catalog.loading && catalog.error && (
          <span className="meta-set__catalog">
            {catalog.error} · <button type="button" className="meta-set__link" onClick={catalog.retry}>Re-check</button>
          </span>
        )}
      </div>
    </div>
  );
}

const sentence = (text: string) => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * The rail's Settings dot when nothing else on this page explains it: errors
 * stopped background maintenance, or the overview says the runtime cannot run
 * it. A failed tool check and an unavailable runtime have their own blocks.
 */
function StoppedAlert({ info, onChangeRuntime }: { info: MetaAgentInfo; onChangeRuntime: () => void }) {
  const { status: infoStatus } = useMetaAgent();
  const load = useMetaAgentOverview(META_AGENT_PAGE_POLL_MS);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  if (load.kind !== 'ready') return null;
  const status = metaAgentStatus({ info, infoStatus, overview: load.overview, runtimeLabel: metaAgentRuntimeLabel });
  if (status.kind !== 'stopped' && !(status.kind === 'unsupported' && info.availability.available)) return null;
  // Same path as Scheduled › Pages upkeep's Retry: resume what stopped, then run one round now.
  const retry = () => {
    setBusy(true);
    retryStoppedMetaAgent(LOCAL_BACKEND_CONNECTION_ID)
      .catch((reason: unknown) => { toast.error(reason instanceof Error && reason.message ? reason.message : 'Couldn’t retry Pages upkeep'); })
      .finally(() => { if (mounted.current) setBusy(false); });
  };
  return (
    <div className="meta-set__alert" role="alert">
      <TriangleAlert className="meta-set__alert-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
      <div className="meta-set__alert-body">
        <b>{status.kind === 'stopped' ? UPKEEP_HEADLINE.stopped : UPKEEP_HEADLINE.unsupported}</b>
        <p>{sentence(status.reason ?? 'The reason is unknown')} {status.stop?.reason === 'signed-out'
          // The backend tries a sign-in stop again on its own (maintenanceCoordinator.ts SIGN_IN_RETRY_MS).
          ? 'It tries again every hour, or press Retry once sign-in works.'
          : 'Pages won’t update in the background until it runs again.'}</p>
        {status.stop?.detail && <p className="meta-set__alert-detail">{status.stop.detail}</p>}
      </div>
      <div className="meta-set__alert-actions">
        {status.kind === 'stopped' && (
          <Button variant="primary" size="sm" disabled={busy} onClick={retry}>{busy ? 'Retrying…' : 'Retry'}</Button>
        )}
        <Button size="sm" onClick={onChangeRuntime}>Change runtime</Button>
      </div>
    </div>
  );
}

const APPROVAL_STATE: Record<MetaAgentToolApproval['state'], string> = {
  pending: 'Needs approval',
  approved: 'Allowed',
  denied: 'Denied',
  revoked: 'Revoked',
};

function ToolApprovals({ info, sectionRef }: { info: MetaAgentInfo; sectionRef: React.Ref<HTMLElement> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const decide = async (id: string, state: 'approved' | 'denied' | 'revoked') => {
    setBusy(true); setError(null);
    try { await saveMetaAgentToolApproval(id, state); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t save approval'); }
    finally { setBusy(false); }
  };
  if (!info.toolApprovals?.length) return null;
  return (
    <section className="meta-set__sec" ref={sectionRef} aria-labelledby={headingId}>
      <h3 id={headingId}>Tool approvals</h3>
      <div className="meta-set__body">
        <p className="meta-set__note">
          An allowed tool can run in background updates with any valid arguments, including the external changes it makes.
          The approval lasts until you revoke it or the tool’s definition or connection changes.
        </p>
        {info.toolApprovals.map((request) => {
          const pending = request.state === 'pending';
          return (
            <div className="meta-set__row" key={request.id} data-pending={pending || undefined}>
              <span className="meta-set__row-k">{request.server} / {request.tool}</span>
              {request.description && <span className="meta-set__row-v">{request.description}</span>}
              <span className="meta-set__ctl">
                <span className="meta-set__state">{APPROVAL_STATE[request.state]}</span>
                {request.state !== 'approved' && (
                  <Button size="sm" variant={pending ? 'primary' : 'secondary'} disabled={busy}
                    onClick={() => { void decide(request.id, 'approved'); }}>Always allow</Button>
                )}
                {pending && <Button size="sm" disabled={busy} onClick={() => { void decide(request.id, 'denied'); }}>Deny</Button>}
                {request.state === 'approved' && <Button size="sm" disabled={busy} onClick={() => { void decide(request.id, 'revoked'); }}>Revoke</Button>}
              </span>
            </div>
          );
        })}
        {error && <p className="meta-set__error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
