import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import type { AgentCapabilities, AgentModelInfo, AgentProviderInfo, AgentStatus } from '../../services/api';
import type { ResolvedNodeBinding } from '../../state/nodeBindingResolution';
import { ChevronRightIcon, CpuIcon, GaugeIcon, WorkflowIcon } from './icons';
import { REASONING_LABELS, composerIconSize, composerMenuBelowEdge, composerMenusOpenBelow, type PaneMenuAnchor } from './PaneComposerToolbarLeft';
import './ComposerModelPicker.css';
import { resolveComposerModel, resolveComposerReasoning } from './composerReasoning';
import { modelDisplayLabel } from '../../lib/modelLabel';
import type { ComposerUltracode } from './ComposerModelPicker';

const EFFORT_INITIALS: Record<string, string> = { minimal: 'Min', low: 'L', medium: 'M', high: 'H', xhigh: 'XH', max: 'Max' };

interface ComposerModelTriggerProps {
  toolbarTier: 0 | 1 | 2;
  agentStatus: AgentStatus | null;
  resolvedBinding: ResolvedNodeBinding;
  catalogCapabilities: AgentCapabilities | null;
  providerModels: readonly AgentModelInfo[];
  providers?: readonly AgentProviderInfo[];
  isStreaming: boolean;
  /** Shows the binding without offering a picker (the ⌘J assistant's: Settings owns it). */
  locked?: boolean;
  modelMenuOpen?: boolean;
  onOpenModelMenu: (anchor: PaneMenuAnchor) => void;
  /** What switching the model also ends (e.g. a running workflow). */
  switchHint?: string;
  /** The chat's Ultracode choice: an indicator while it is on. */
  ultracode?: ComposerUltracode;
  /** The chat's speed tier: an indicator while its model runs it. */
  serviceTier?: string | null;
}

export function ComposerModelTrigger({ toolbarTier, agentStatus, resolvedBinding, catalogCapabilities, providerModels, providers, isStreaming, locked = false, modelMenuOpen = false, onOpenModelMenu, switchHint, ultracode, serviceTier }: ComposerModelTriggerProps) {
  const caps = catalogCapabilities ?? (resolvedBinding.runtime === agentStatus?.runtime ? agentStatus.capabilities : undefined);
  const ultracodeOn = caps?.ultracode === true && ultracode?.enabled === true;
  const ultracodeLabel = ultracodeOn ? ultracode?.available === false ? 'Ultracode on, but unavailable' : 'Ultracode on' : undefined;
  const tier = serviceTier ? resolveComposerModel(resolvedBinding, agentStatus, providerModels, providers)?.serviceTiers?.find((entry) => entry.id === serviceTier) : undefined;
  const tierLabel = tier ? `${tier.name} on` : undefined;
  const runtimeLabel = agentStatus?.availableRuntimes?.find((runtime) => runtime.id === resolvedBinding.runtime)?.label || resolvedBinding.runtime;
  const hasModel = caps?.providerModels || caps?.models || resolvedBinding.model;
  const modelLabel = modelDisplayLabel(resolvedBinding.runtime, resolvedBinding.model, providerModels);
  const effort = resolveComposerReasoning(resolvedBinding, agentStatus, catalogCapabilities, providerModels, providers);
  const effortLabel = effort.adjustable ? REASONING_LABELS[effort.value ?? ''] ?? effort.value : undefined;
  // A locked binding cannot be switched here, so there is nothing to warn about.
  const hint = locked ? undefined : switchHint;
  const phone = usePhoneLayout();

  return (
    <button type="button" className={`t-toolbar-chip composer-model-trigger${phone ? ' is-icon' : ''}`} data-compact={toolbarTier > 0 || undefined}
      aria-label={`${locked ? 'Model' : 'Model settings'}: ${runtimeLabel}, ${modelLabel}${effortLabel ? `, ${effortLabel} effort` : ''}${tierLabel ? `, ${tierLabel}` : ''}${ultracodeLabel ? `, ${ultracodeLabel}` : ''}${hint ? `. ${hint}` : ''}`}
      title={[[runtimeLabel, modelLabel, effortLabel, tierLabel, ultracodeLabel].filter(Boolean).join(' · '), hint].filter(Boolean).join('. ')}
      aria-haspopup={locked ? undefined : 'dialog'} aria-expanded={locked ? undefined : modelMenuOpen} disabled={isStreaming || locked}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onOpenModelMenu({ x: rect.right, y: composerMenuBelowEdge(event.currentTarget), anchorBottom: rect.top - 6, preferBelow: composerMenusOpenBelow(event.currentTarget),
          align: 'end', trigger: event.currentTarget, keyboard: event.detail === 0 });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        event.stopPropagation();
        if (!modelMenuOpen) event.currentTarget.click();
      }}>
      {phone ? <>
        <CpuIcon size={composerIconSize(true)} />
        {effortLabel && <span className="composer-model-trigger-effort" aria-hidden="true">{EFFORT_INITIALS[effort.value ?? ''] ?? effortLabel.charAt(0)}</span>}
        {tier && <ServiceTierMark phone />}
        {ultracodeOn && <UltracodeMark unavailable={ultracode?.available === false} phone />}
      </> : <>
        <span className="t-chip-label">{hasModel ? modelLabel : runtimeLabel}</span>
        {effortLabel && <span className="composer-model-trigger-effort">{effortLabel}</span>}
        {tier && <ServiceTierMark />}
        {ultracodeOn && <UltracodeMark unavailable={ultracode?.available === false} />}
        {!locked && <ChevronRightIcon className="composer-model-chevron" />}
      </>}
    </button>
  );
}

/** A speed tier is on: the label (aria-label and title) names it. */
function ServiceTierMark({ phone = false }: { phone?: boolean }) {
  return (
    <span className="composer-model-trigger-tier" aria-hidden="true">
      <GaugeIcon size={phone ? composerIconSize(true) - 4 : 'md'} />
    </span>
  );
}

/** Ultracode is on: the label (aria-label and title) says so in words. */
function UltracodeMark({ unavailable, phone = false }: { unavailable: boolean; phone?: boolean }) {
  return (
    <span className="composer-model-trigger-ultracode" data-ultracode="on" data-unavailable={unavailable || undefined} aria-hidden="true">
      <WorkflowIcon size={phone ? composerIconSize(true) - 4 : 'md'} />
    </span>
  );
}
