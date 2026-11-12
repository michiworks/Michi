/**
 * The runtimes and models a multi-model plan may use right now, for the
 * list_ready_models tool, the card's model picker (GET
 * /multi-model/ready-models) and the validation of every pick.
 *
 * "Ready" means the runtime's local probe passes and, for provider runtimes
 * (capabilities.providerModels), the provider has usable credentials. Every
 * decision goes through the registry and capabilities; no runtime id is
 * compared here.
 */
import { MULTI_MODEL_LIMITS, shortRuntimeLabel, type MultiModelModelPick, type ReadyModelOption, type ReadyModelsDto, type ReadyProviderOption, type ReadyRuntimeOption } from 'michi-shared';
import { MultiModelError } from '../../agents/multiModelTool';
import { listRuntimes } from '../../agents/registry';
import { withDeadline } from '../../agents/runtimeLifecycle';
import type { RuntimeCatalogCache } from '../../agents/runtimeModelCache';
import { hasProviders, type AgentProviderInfo, type AgentRuntime, type ModelInfo } from '../../agents/types';
import { resolveModel, resolveProvider, resolveReasoning } from '../agentConfig';
import { hasBedrockCredentials } from '../bedrockCredentials';
import { log } from '../logger';
import { evaluateProviderReadiness } from '../providerReadiness';
import { getProviderApiKey, listProviderKeyPresence } from '../secrets';
import { listUserProviderKeys } from '../userKeys';
import type { MultiModelModelChoice } from './types';

export interface ReadyModelsDeps {
  /** The FileRuntimeCatalogCache server.ts creates. */
  catalogCache: RuntimeCatalogCache | null;
  /** Per runtime: probing, listing providers and listing models. Default 8000. */
  listTimeoutMs?: number;
  /** The registered runtimes; defaults to the registry. */
  runtimes?: () => readonly AgentRuntime[];
  /** Which of a provider runtime's providers have usable credentials; defaults to the /agent/status inputs. */
  readyProviders?: (providers: readonly AgentProviderInfo[], userId: string | undefined) => AgentProviderInfo[];
}

const DEFAULT_LIST_TIMEOUT_MS = 8_000;
const MAX_RUNTIMES = 12;
const MAX_PROVIDERS = 8;
const MAX_MODELS = 40;

function clampLabel(label: string): string {
  return label.length > MULTI_MODEL_LIMITS.label ? `${label.slice(0, MULTI_MODEL_LIMITS.label - 1)}…` : label;
}

function defaultReadyProviders(providers: readonly AgentProviderInfo[], userId: string | undefined): AgentProviderInfo[] {
  // BYOK: in cloud mode key presence is per user (routes/agent.ts /agent/status).
  const keyPresence: Record<string, boolean> = userId
    ? Object.fromEntries(listUserProviderKeys(userId).map((row) => [row.provider, true]))
    : listProviderKeyPresence(providers.map((provider) => provider.id));
  return evaluateProviderReadiness(providers, {
    keyPresence,
    resolveOperatorKey: (providerId) => getProviderApiKey(providerId, userId),
    hasAwsCredentials: hasBedrockCredentials(),
  }).providers.filter((provider) => provider.hasKey);
}

function configUserId(ownerUserId: string | null): string | undefined {
  return process.env.MICHI_CLOUD === '1' ? ownerUserId ?? undefined : undefined;
}

/**
 * Models that do not answer a chat prompt: speech, transcription, image,
 * music and video generation, embeddings, moderation, and agents that need
 * their own harness (computer use, robotics, deep research). Provider
 * catalogs list them beside the chat models (Google's live catalog lists
 * everything generateContent serves), and a model entry carries no
 * capability field to tell them apart, so the id and label do.
 */
const NON_CHAT_MODEL: readonly RegExp[] = [
  /\btts\b/i, /text[- ]to[- ]speech/i, /transcri(?:be|ption)/i, /\bwhisper\b/i, /\baudio\b/i, /\brealtime\b/i,
  /\bimagen?\b/i, /nano[- ]?banana/i, /dall-e/i, /\bveo\b/i, /\bsora\b/i, /\blyria\b/i, /\bmusic\b/i,
  /\bembed(?:ding)?s?\b/i, /moderation/i, /computer[- ]use/i, /robotics/i, /deep[- ]research/i,
];

function chatModel(model: ModelInfo): boolean {
  return !NON_CHAT_MODEL.some((pattern) => pattern.test(model.id) || pattern.test(model.label ?? ''));
}

/**
 * The models a branch can run: chat models only, one per label (a provider
 * lists a model under its preview and release ids alike). The default is
 * always kept, and it wins its label; otherwise the first listed does.
 */
function chatModels(models: readonly ModelInfo[], defaultModelId: string | null): ModelInfo[] {
  const labelOf = (model: ModelInfo) => (model.label || model.id).trim().toLowerCase();
  const kept = models.filter((model) => model.id === defaultModelId || chatModel(model));
  const owner = new Map<string, string>();
  for (const model of kept) {
    const key = labelOf(model);
    if (!owner.has(key) || model.id === defaultModelId) owner.set(key, model.id);
  }
  return kept.filter((model) => owner.get(labelOf(model)) === model.id);
}

function modelOption(model: ModelInfo, defaultModelId: string | null): ReadyModelOption {
  const option: ReadyModelOption = { modelId: model.id, label: clampLabel(model.label || model.id) };
  if (model.id === defaultModelId) option.isDefault = true;
  if (model.supportedReasoningLevels && model.supportedReasoningLevels.length > 0) option.reasoningLevels = [...model.supportedReasoningLevels];
  if (model.defaultReasoning) option.defaultReasoning = model.defaultReasoning;
  return option;
}

/** One ready runtime as list() reports it, plus what resolvePick needs and the DTO omits. */
interface ReadyRuntime {
  runtime: AgentRuntime;
  /** The DTO entry; its model lists are capped at MAX_MODELS. */
  option: ReadyRuntimeOption;
  /** Every listed model, by provider id ('' without providers): picks are checked against these. */
  catalogs: Map<string, ReadyModelOption[]>;
  /** Provider runtimes: each ready provider's default model. */
  providerDefaults: Map<string, string | null>;
}

/** One probe of every runtime, reused by an operation that lists or resolves several picks. */
export interface ReadySnapshot {
  readonly runtimes: readonly ReadyRuntime[];
}

export class ReadyModelsService {
  private readonly listTimeoutMs: number;
  private readonly runtimes: () => readonly AgentRuntime[];
  private readonly readyProviders: NonNullable<ReadyModelsDeps['readyProviders']>;

  constructor(private readonly deps: ReadyModelsDeps) {
    this.listTimeoutMs = deps.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.runtimes = deps.runtimes ?? listRuntimes;
    this.readyProviders = deps.readyProviders ?? defaultReadyProviders;
  }

  /** Probe every runtime once (each under listTimeoutMs, in parallel). */
  async snapshot(ownerUserId: string | null): Promise<ReadySnapshot> {
    return { runtimes: await this.readyRuntimes(configUserId(ownerUserId)) };
  }

  /** Runtimes that pass checkAvailability(); provider runtimes list only their ready providers. */
  async list(
    ownerUserId: string | null,
    current?: { runtimeId: string; providerId: string | null; modelId: string | null },
    snapshot?: ReadySnapshot,
  ): Promise<ReadyModelsDto> {
    const { runtimes } = snapshot ?? await this.snapshot(ownerUserId);
    return { version: 1, runtimes: runtimes.map((entry) => entry.option), ...(current ? { current } : {}) };
  }

  /** Normalize and validate one pick; throws MultiModelError('model_unavailable', 409) with a readable message. */
  async resolvePick(ownerUserId: string | null, pick: MultiModelModelPick, snapshot?: ReadySnapshot): Promise<MultiModelModelChoice> {
    const userId = configUserId(ownerUserId);
    const ready = (snapshot ?? await this.snapshot(ownerUserId)).runtimes;
    const entry = ready.find((candidate) => candidate.runtime.id === pick.runtimeId);
    if (!entry) {
      const names = ready.map((candidate) => candidate.runtime.id).join(', ') || 'none';
      throw new MultiModelError('model_unavailable', `Runtime "${pick.runtimeId}" is not ready. Ready runtimes: ${names}.`, 409);
    }
    const { option } = entry;
    let providerId: string | null = null;
    let models = entry.catalogs.get('') ?? [];
    let defaultModelId = option.defaultModelId;
    if (option.providers) {
      providerId = pick.providerId ?? option.defaultProviderId;
      const provider = option.providers.find((candidate) => candidate.providerId === providerId);
      if (!provider || providerId === null) {
        const names = option.providers.map((candidate) => candidate.providerId).join(', ');
        throw new MultiModelError('model_unavailable',
          `Provider "${pick.providerId ?? ''}" of ${option.label} is not ready. Ready providers: ${names}.`, 409);
      }
      models = entry.catalogs.get(providerId) ?? [];
      defaultModelId = providerId === option.defaultProviderId ? option.defaultModelId : entry.providerDefaults.get(providerId) ?? null;
    }
    const modelId = pick.modelId ?? defaultModelId;
    const model = models.find((candidate) => candidate.modelId === modelId);
    // The default (configured, or the runtime's own when null) is always allowed, listed or not.
    if (modelId !== null && modelId !== defaultModelId && models.length > 0 && !model) {
      const names = models.slice(0, 12).map((candidate) => candidate.modelId).join(', ');
      throw new MultiModelError('model_unavailable',
        `Model "${modelId ?? ''}" is not available on ${option.label}. Ready models include: ${names}.`, 409);
    }
    return {
      runtimeId: entry.runtime.id,
      providerId,
      modelId,
      reasoning: pick.reasoning ?? resolveReasoning(entry.runtime.id, userId) ?? null,
      runtimeLabel: option.label,
      modelLabel: clampLabel(model?.label ?? modelId ?? 'Default model'),
    };
  }

  /** Labels for a runtime/model this backend knows, ready or not (the caller's own labels): the cached catalog's, else the ids. */
  labelsFor(runtimeId: string | null, providerId: string | null, modelId: string | null): { runtimeLabel: string; modelLabel: string } {
    const runtime = runtimeId ? this.runtimes().find((candidate) => candidate.id === runtimeId) : undefined;
    const cataloged = runtimeId && modelId
      ? this.deps.catalogCache?.loadCatalog(runtimeId, providerId ?? undefined)?.models.find((model) => model.id === modelId)?.label
      : undefined;
    return {
      runtimeLabel: clampLabel(runtime ? shortRuntimeLabel(runtime.label) : runtimeId ?? 'Michi'),
      modelLabel: clampLabel(cataloged || modelId || 'Default model'),
    };
  }

  /** `userId` for config and keys: the owner in cloud mode, else undefined. */
  private async readyRuntimes(userId: string | undefined): Promise<ReadyRuntime[]> {
    const entries = await Promise.all(this.runtimes().slice(0, MAX_RUNTIMES).map((runtime) =>
      withDeadline(this.describe(runtime, userId), this.listTimeoutMs, `${runtime.id} ready check timed out`).catch((error) => {
        log.warn('chat', 'multi-model ready check failed', { runtimeId: runtime.id, error: error instanceof Error ? error.message : String(error) });
        return null;
      })));
    return entries.filter((entry): entry is ReadyRuntime => entry !== null);
  }

  private async describe(runtime: AgentRuntime, userId: string | undefined): Promise<ReadyRuntime | null> {
    let available = true;
    try {
      available = runtime.checkAvailability?.().available ?? true;
    } catch (error) {
      // A probe must never take the list down (routes/agent.ts /agent/status).
      log.warn('chat', 'runtime availability probe failed', { runtimeId: runtime.id, error: error instanceof Error ? error.message : String(error) });
    }
    if (!available) return null;
    const label = clampLabel(shortRuntimeLabel(runtime.label));
    const configuredModel = resolveModel(runtime.id, userId) || null;
    if (!runtime.capabilities.providerModels || !hasProviders(runtime)) {
      const listed = await this.models(runtime, undefined, []);
      const defaultModelId = configuredModel ?? listed.find((model) => model.isDefault)?.id ?? null;
      const models = chatModels(listed, defaultModelId).map((model) => modelOption(model, defaultModelId));
      return {
        runtime,
        option: { runtimeId: runtime.id, label, defaultModelId, defaultProviderId: null, models: models.slice(0, MAX_MODELS) },
        catalogs: new Map([['', models]]),
        providerDefaults: new Map(),
      };
    }
    const all = await runtime.listProviders();
    const ready = this.readyProviders(all, userId).slice(0, MAX_PROVIDERS);
    if (ready.length === 0) return null;
    const configuredProvider = resolveProvider(runtime.id, userId);
    const defaultProvider = ready.find((provider) => provider.id === configuredProvider) ?? ready[0];
    const providerDefaults = new Map<string, string | null>();
    const catalogs = new Map<string, ReadyModelOption[]>();
    const providers: ReadyProviderOption[] = await Promise.all(ready.map(async (provider) => {
      const defaultModel = provider === defaultProvider && provider.id === configuredProvider ? configuredModel : provider.defaultModel || null;
      providerDefaults.set(provider.id, defaultModel);
      const models = chatModels(await this.models(runtime, provider.id, all), defaultModel).map((model) => modelOption(model, defaultModel));
      catalogs.set(provider.id, models);
      return { providerId: provider.id, label: clampLabel(provider.label || provider.id), models: models.slice(0, MAX_MODELS) };
    }));
    return {
      runtime,
      option: {
        runtimeId: runtime.id,
        label,
        defaultModelId: providerDefaults.get(defaultProvider.id) ?? null,
        defaultProviderId: defaultProvider.id,
        models: [],
        providers,
      },
      catalogs,
      providerDefaults,
    };
  }

  /** The full list, cache-first; a failing or slow list leaves [] (only the default can then be picked). */
  private async models(runtime: AgentRuntime, provider: string | undefined, providers: AgentProviderInfo[]): Promise<ModelInfo[]> {
    const cached = this.deps.catalogCache?.loadCatalog(runtime.id, provider);
    if (cached && cached.models.length > 0) return cached.models;
    if (!runtime.listModels) return [];
    try {
      const models = await withDeadline(runtime.listModels({ provider }), this.listTimeoutMs, `${runtime.id} model list timed out`);
      this.deps.catalogCache?.saveCatalog(runtime.id, { models, providers }, provider);
      return models;
    } catch (error) {
      log.warn('chat', 'multi-model model list failed', { runtimeId: runtime.id, provider, error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }
}
