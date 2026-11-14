import { useEffect, useId, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  META_AGENT_DEFAULT_FIRST_RUN_DAYS,
  META_AGENT_FIRST_RUN_DAYS,
  MICHI_AGENT_RUNTIMES,
  type MetaAgentFirstRunDays,
  type MetaAgentSettings as Settings,
  type MetaAgentSettingsPatch,
} from 'michi-shared';
import { FOLLOW_GLOBAL_PATCH, type MetaAgentInfo } from '../../../../services/api/metaAgent';
import { fetchAgentStatus, type AgentReasoning, type AgentStatus } from '../../../../services/api/agentRuntime';
import {
  metaAgentGuardFailures,
  refreshMetaAgent,
  retryMetaAgentGuard,
  saveMetaAgentSettings,
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
import { META_AGENT_PAGE_POLL_MS, useMetaAgentOverview } from '../../../../state/metaAgent/useMetaAgentOverview';
import { metaAgentStatus } from '../../../../state/metaAgent/metaAgentStatus';
import { retryStoppedMetaAgent } from '../../../../state/metaAgent/metaAgentUpdate';
import { useCompanionName } from '../../../../state/companion/companionName';
import { UPKEEP_HEADLINE } from '../../scheduled/metaAgent/metaAgentCopy';
import { metaAgentRuntimeLabel, runtimeUnavailableText } from './runtimeCopy';
import { SettingsRow } from '../../pages/settings/SettingsSection';
import { BACKGROUND_WORK_LABEL } from '../../rail/settingsPages';
import { smoothScrollBehavior } from '../../../../hooks/useReducedMotion';
import './metaAgentSettings.css';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';

type FormPart = 'runtime' | 'pages';

/**
 * Settings › <name> › Pages (Pages upkeep; Settings › Meta agent before v2):
 * whether the background upkeep writes the workspace homes and the Pages
 * Home, and how far back it first reads a workspace. What it runs on is
 * Background work (BackgroundWorkSettings, under Model); turning <name> off
 * stops it.
 */
export function PagesUpkeepSettings() {
  return <MetaAgentLoader part="pages" />;
}

/**
 * Settings › <name> › Model › Background work: what check-ins and Pages
 * upkeep run on (the Meta agent record): the conversations' settings, or a
 * runtime, model and reasoning of their own. Conversations never use it.
 */
export function BackgroundWorkSettings() {
  return <MetaAgentLoader part="runtime" />;
}

function MetaAgentLoader({ part }: { part: FormPart }) {
  const { status, info, error } = useMetaAgent();
  if (info) return <MetaAgentForm info={info} part={part} />;
  return (
    <>
      {status === 'loading' && <p className="settings-row__note" role="status">Loading…</p>}
      {status === 'unavailable' && (
        <p className="settings-row__note" role="status">This Michi backend does not run Pages upkeep yet. Its settings appear here once it does.</p>
      )}
      {status === 'error' && (
        <p className="settings-row__note" role="alert">
          Couldn’t load Pages upkeep{error ? `: ${error}` : ''}.{' '}
          <button type="button" className="settings-row__link" onClick={() => { void refreshMetaAgent(); }}>Try again</button>
        </p>
      )}
    </>
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

function MetaAgentForm({ info, part }: { info: MetaAgentInfo; part: FormPart }) {
  const name = useCompanionName();
  const agentStatus = useLocalAgentStatus();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const choiceRef = useRef<HTMLSelectElement>(null);
  const choiceId = useId();
  const firstReadId = useId();

  const { settings, resolved } = info;
  const custom = settings.runtimeId !== null;
  const firstRunDays = settings.firstRunDays ?? META_AGENT_DEFAULT_FIRST_RUN_DAYS;
  const failures = metaAgentGuardFailures(info);

  const save = async (patch: MetaAgentSettingsPatch) => {
    setSaving(true);
    setError(null);
    try {
      await saveMetaAgentSettings(patch);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error && err.message ? err.message : 'Couldn’t save the setting');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const runtimeAvailable = (id: string) => agentStatus?.availableRuntimes.find((runtime) => runtime.id === id)?.available !== false;
  // Custom starts from what background work runs on now, so choosing it changes nothing until a
  // runtime is picked; when that runtime cannot run it, it starts from the first one that can.
  const chooseCustom = () => {
    if (custom) return;
    if (info.availability.available) {
      void save({ runtimeId: resolved.runtimeId, providerId: resolved.providerId, modelId: resolved.modelId, reasoning: resolved.reasoning });
      return;
    }
    const fallback = MICHI_AGENT_RUNTIMES.find((id) => id !== resolved.runtimeId && runtimeAvailable(id));
    if (fallback) void save({ runtimeId: fallback, providerId: null, modelId: null, reasoning: null });
  };
  const chooseFollow = () => { if (custom) void save(FOLLOW_GLOBAL_PATCH); };
  const changeRuntime = () => {
    choiceRef.current?.scrollIntoView?.({ behavior: smoothScrollBehavior(), block: 'center' });
    choiceRef.current?.focus({ preventScroll: true });
  };
  const errorNote = error && <p className="settings-row__note" role="alert">{error}</p>;

  if (part === 'runtime') return (
    <>
      <MetaAgentGuardAlert failures={failures} onRetry={retryMetaAgentGuard} onChangeRuntime={changeRuntime} />
      <StoppedAlert info={info} onChangeRuntime={changeRuntime} />
      <SettingsRow label={BACKGROUND_WORK_LABEL} labelFor={choiceId} tip="Check-ins and Pages upkeep run on this. Your conversations stay on Settings › Runtime & model."
        control={(
          <select ref={choiceRef} id={choiceId} className="ui-select settings-row__select" value={custom ? 'custom' : 'same'} disabled={saving}
            onChange={(event) => { if (event.target.value === 'custom') chooseCustom(); else chooseFollow(); }}>
            <option value="same">Same as conversations</option>
            <option value="custom">Custom</option>
          </select>
        )}>
        {!info.availability.available && (
          <p className="settings-row__note" role="status">
            {info.availability.reason ?? `${name} cannot run on ${metaAgentRuntimeLabel(resolved.runtimeId)}.`}
            {!custom && <>{' '}<button type="button" className="settings-row__link" disabled={saving} onClick={chooseCustom}>Use a custom runtime</button></>}
          </p>
        )}
        {errorNote}
      </SettingsRow>
      {custom && <CustomRuntime settings={settings} resolved={resolved} agentStatus={agentStatus} saving={saving} onSave={(patch) => { void save(patch); }} />}
    </>
  );

  return (
    <>
      <SettingsRow label="Keep workspace homes up to date"
        control={<Switch on={settings.writeWorkspaceHomes !== false} disabled={saving} aria-label="Keep workspace homes up to date"
          onChange={(on) => { void save({ writeWorkspaceHomes: on }); }} />} />
      <SettingsRow label="Keep the Pages Home up to date"
        control={<Switch on={settings.maintainSpacesHome !== false} disabled={saving} aria-label="Keep the Pages Home up to date"
          onChange={(on) => { void save({ maintainSpacesHome: on }); }} />} />
      <SettingsRow label="First read" labelFor={firstReadId}
        tip={`How far back it reads a workspace the first time, up to 1,000 conversations; a change applies to workspaces it reads after it. It never reads scheduled-job output, your conversation with ${name}, or archived and deleted conversations.`}
        control={(
          <select id={firstReadId} className="ui-select settings-row__select" value={firstRunDays} disabled={saving}
            onChange={(event) => { void save({ firstRunDays: Number(event.target.value) as MetaAgentFirstRunDays }); }}>
            {META_AGENT_FIRST_RUN_DAYS.map((days) => <option key={days} value={days}>{days} days</option>)}
          </select>
        )}>
        {errorNote}
      </SettingsRow>
    </>
  );
}

/** A custom runtime that can't run: why, in plain words, and how to install it behind a link. */
function UnavailableHint({ id, reason }: { id: string; reason: string | undefined }) {
  const [open, setOpen] = useState(false);
  const { text, install, detail } = runtimeUnavailableText(id, reason);
  const more = install.length > 0 || detail !== null;
  return (
    <p className="settings-row__note">
      {text}
      {more && (
        <>
          {' '}
          <button type="button" className="settings-row__link" aria-expanded={open} onClick={() => setOpen(!open)}>
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
    </p>
  );
}

/** Background work's own runtime, provider, model and reasoning: a row each, under Custom. */
function CustomRuntime({ settings, resolved, agentStatus, saving, onSave }: {
  settings: Settings;
  /** What the record resolves to now: names what "Default" stands for. */
  resolved: MetaAgentInfo['resolved'];
  agentStatus: AgentStatus | null;
  saving: boolean;
  onSave: (patch: MetaAgentSettingsPatch) => void;
}) {
  const runtimeId = settings.runtimeId ?? '';
  const ids = { runtime: useId(), provider: useId(), model: useId(), reasoning: useId() };
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
  // Unavailable runtimes are left out; only a saved choice that became unavailable stays, and says why.
  const runtimes = MICHI_AGENT_RUNTIMES.filter((id) => id === runtimeId || visibleRuntimeIds.has(id));
  const unavailable = runtimeOption(runtimeId)?.available === false;
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
    <>
      <SettingsRow label="Runtime" labelFor={ids.runtime}
        control={(
          <select id={ids.runtime} className="ui-select settings-row__select" aria-label="Background work runtime" value={runtimeId} disabled={saving}
            // A model belongs to one runtime: switching starts from the new runtime's defaults.
            onChange={(event) => { if (event.target.value !== runtimeId) onSave({ runtimeId: event.target.value, providerId: null, modelId: null, reasoning: null }); }}>
            {runtimes.map((id) => <option key={id} value={id}>{metaAgentRuntimeLabel(id)}</option>)}
          </select>
        )}>
        {unavailable && <UnavailableHint id={runtimeId} reason={runtimeOption(runtimeId)?.unavailableReason} />}
      </SettingsRow>
      {(catalog.providers.length > 1 || providerMissing) && (
        <SettingsRow label="Provider" labelFor={ids.provider}
          control={(
            <select id={ids.provider} className="ui-select settings-row__select" aria-label="Background work provider" value={settings.providerId ?? ''} disabled={saving}
              onChange={(event) => onSave({ providerId: event.target.value || null, modelId: null, reasoning: null })}>
              <option value="">{defaultProvider}</option>
              {providerMissing && <option value={settings.providerId!}>{settings.providerId}</option>}
              {catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
            </select>
          )} />
      )}
      <SettingsRow label="Model" labelFor={ids.model}
        control={(
          <select id={ids.model} className="ui-select settings-row__select" aria-label="Background work model" value={settings.modelId ?? ''} disabled={saving}
            onChange={(event) => saveModel(event.target.value || null)}>
            <option value="">{defaultModel}</option>
            {modelMissing && <option value={settings.modelId!}>{modelDisplayLabel(runtimeId, settings.modelId!, catalog.models)}</option>}
            {catalog.models.map((model) => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
          </select>
        )}>
        {catalog.loading && <p className="settings-row__note" role="status">Reading models…</p>}
        {!catalog.loading && catalog.error && (
          <p className="settings-row__note">
            {catalog.error} · <button type="button" className="settings-row__link" onClick={catalog.retry}>Re-check</button>
          </p>
        )}
      </SettingsRow>
      {effort.adjustable && (
        <SettingsRow label="Reasoning" labelFor={ids.reasoning}
          control={(
            <select id={ids.reasoning} className="ui-select settings-row__select" aria-label="Background work reasoning" value={pickedLevel ?? ''} disabled={saving}
              onChange={(event) => onSave({ reasoning: (event.target.value || null) as AgentReasoning | null })}>
              <option value="">{defaultReasoning}</option>
              {effort.levels.map((level: AgentReasoning) => <option key={level} value={level}>{REASONING_LABELS[level] ?? level}</option>)}
            </select>
          )} />
      )}
    </>
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
