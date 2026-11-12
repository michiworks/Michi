/**
 * Kiro's ACP `models` payload as Michi models, for the runtime's catalog and
 * a session's live state alike: an open chat and a new one on the same model
 * offer the same reasoning, and the send path checks the catalog.
 */

import { isReasoningLevel, sanitizeReasoningLevels } from 'michi-shared';
import type { ModelInfo } from '../../contract/types';
import { configValues, type AcpConfigOption, type KiroEngine } from './kiroProtocol';

export interface KiroModelSource {
    engine: KiroEngine;
    /** AcpLaunch.standardAcp. */
    standardAcp: boolean;
}

/** The session config option that carries reasoning: Kiro v3's effortLevel, else a standard ACP thought_level. */
export function reasoningConfigOption(configOptions?: AcpConfigOption[]): AcpConfigOption | undefined {
    return configOptions?.find((option) => option.id === 'effortLevel')
        ?? configOptions?.find((option) => option.category === 'thought_level' || option.id === 'thought_level');
}

/**
 * kiro-cli v2 publishes no per-model effort metadata, but its `auto` router
 * rejects `/effort` ("Effort configuration is currently not available on
 * auto"). Mark it explicitly so the composer disables the control and session
 * setup skips applying effort instead of failing the turn. v3 reports this
 * through `_meta.kiro.hasEffort`, so it never needs the override.
 */
const KIRO_V2_MODELS_WITHOUT_EFFORT = new Set(['auto']);

export function markKiroV2EffortSupport(models: ModelInfo[]): ModelInfo[] {
    return models.map((model) => KIRO_V2_MODELS_WITHOUT_EFFORT.has(model.id) && model.supportsReasoning === undefined
        ? { ...model, supportsReasoning: false, supportedReasoningLevels: [] }
        : model);
}

/**
 * A standard ACP agent's reasoning is one session config option for every
 * model: its levels go with each entry. Kiro's own list is kept as it is.
 */
export function withThoughtLevels(list: any[], source: KiroModelSource, configOptions?: AcpConfigOption[]): any[] {
    if (!source.standardAcp) return list;
    const levels = sanitizeReasoningLevels(configValues(reasoningConfigOption(configOptions)).map((value) => value.value)) ?? [];
    return levels.length ? list.map((model) => ({ ...model, thoughtLevels: levels })) : list;
}

/** `list` is `availableModels`, already through withThoughtLevels on a standard ACP agent. */
export function kiroModelInfos(list: any[], source: KiroModelSource): ModelInfo[] {
    const models = list
        .map((m: any): ModelInfo => ({
            id: String(m?.modelId ?? ''),
            label: typeof m?.name === 'string' ? m.name : undefined,
            description: typeof m?.description === 'string' ? m.description : undefined,
            ...(source.engine === 'v3' ? {
                supportsReasoning: m?._meta?.kiro?.hasEffort === true,
                supportedReasoningLevels: sanitizeReasoningLevels(m?._meta?.kiro?.effortLevels),
                ...(isReasoningLevel(m?._meta?.kiro?.defaultEffortLevel)
                    ? { defaultReasoning: m._meta.kiro.defaultEffortLevel } : {}),
            } : source.standardAcp && sanitizeReasoningLevels(m?.thoughtLevels)?.length ? {
                supportsReasoning: true,
                supportedReasoningLevels: sanitizeReasoningLevels(m.thoughtLevels),
            } : {}),
        }))
        .filter((m) => m.id);
    return source.engine === 'v2' ? markKiroV2EffortSupport(models) : models;
}
