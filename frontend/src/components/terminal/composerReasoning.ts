import { resolveReasoningOptions } from 'michi-shared';
import type { AgentCapabilities, AgentModelInfo, AgentProviderInfo, AgentStatus } from '../../services/api';
import type { ResolvedNodeBinding } from '../../state/nodeBindingResolution';

function bindingProvider(binding: ResolvedNodeBinding, status: AgentStatus | null, providers: readonly AgentProviderInfo[]) {
  const providerList = providers.length ? providers : binding.runtime === status?.runtime ? status.providers : undefined;
  return providerList?.find((entry) => entry.id === binding.provider);
}

/** The catalog entry of the model the binding runs: its own, else the provider's or catalog's default. */
export function resolveComposerModel(
  binding: ResolvedNodeBinding,
  status: AgentStatus | null,
  models: readonly AgentModelInfo[],
  providers: readonly AgentProviderInfo[] = [],
): AgentModelInfo | undefined {
  const provider = bindingProvider(binding, status, providers);
  return binding.model ? models.find((entry) => entry.id === binding.model)
    : models.find((entry) => entry.id === provider?.defaultModel) ?? models.find((entry) => entry.isDefault) ?? models[0];
}

export function resolveComposerReasoning(
  binding: ResolvedNodeBinding,
  status: AgentStatus | null,
  capabilities: AgentCapabilities | null,
  models: readonly AgentModelInfo[],
  providers: readonly AgentProviderInfo[] = [],
) {
  const caps = capabilities ?? (binding.runtime === status?.runtime ? status.capabilities : null);
  const provider = bindingProvider(binding, status, providers);
  const model = resolveComposerModel(binding, status, models, providers);
  // Until a model catalog resolves this binding, runtime-wide levels can
  // advertise options the selected model does not support.
  const awaitingModel = !model && !!(caps?.models || caps?.providerModels);
  const options = resolveReasoningOptions(caps, model, provider, binding.reasoning);
  return {
    ...options,
    // Keep the resolved send value while hiding choices whose availability
    // is still unknown. Opening the picker must not change an existing binding.
    levels: awaitingModel ? [] : options.levels,
    adjustable: !awaitingModel && options.adjustable,
    known: caps != null,
  };
}
