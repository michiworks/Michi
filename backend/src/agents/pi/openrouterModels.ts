/**
 * Dynamic model fetcher for OpenRouter.
 *
 * The upstream pi-ai package ships a static model list that is generated
 * at publish time. This module reads the live catalog from
 * https://openrouter.ai/api/v1/models (public, no key required) with its
 * pricing, modalities and reasoning support, through the same cache as every
 * other provider's discovery (discoverCatalog). Callers fall back to the
 * pi-ai static list when it has nothing.
 */

import type { PiModelInfo } from "./piModelTypes";
import { cachedCatalog, discoverCatalog } from "./providerModelDiscovery";

interface OpenRouterApiModel {
    id: string;
    name?: string;
    description?: string;
    context_length?: number;
    pricing?: { prompt: string; completion: string };
    architecture?: {
        modality?: string;
        input_modalities?: string[];
        output_modalities?: string[];
    };
    top_provider?: {
        context_length?: number;
        max_completion_tokens?: number;
    };
    supported_parameters?: string[];
    reasoning?: unknown;
}

export interface OpenRouterModelInfo extends PiModelInfo {
    reasoning: boolean;
    input: Array<"text" | "image">;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    max_tokens: number;
}

const CATALOG_KEY = "openrouter-catalog";
/** The catalog runs to megabytes, so its download gets longer than a provider's id list. */
const REQUEST_TIMEOUT_MS = 8_000;

function pricePerMillion(value: string | undefined): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed * 1_000_000 : 0;
}

function toModelInfo(m: OpenRouterApiModel): OpenRouterModelInfo {
    return {
        model_id: m.id,
        model_name: m.name || m.id,
        description: m.description,
        context_window_tokens:
            m.top_provider?.context_length ?? m.context_length,
        reasoning:
            !!m.reasoning ||
            !!m.supported_parameters?.some((parameter) =>
                parameter === "reasoning" ||
                parameter === "reasoning_effort" ||
                parameter === "include_reasoning"
            ),
        input: [
            "text" as const,
            ...(m.architecture?.input_modalities?.includes("image")
                ? ["image" as const]
                : []),
        ],
        cost: {
            input: pricePerMillion(m.pricing?.prompt),
            output: pricePerMillion(m.pricing?.completion),
            cacheRead: 0,
            cacheWrite: 0,
        },
        max_tokens: m.top_provider?.max_completion_tokens ?? 16_384,
    };
}

async function readOpenRouterModels(apiKey: string | null | undefined, signal: AbortSignal): Promise<OpenRouterModelInfo[] | null> {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch("https://openrouter.ai/api/v1/models", { headers, signal });
    if (!res.ok) {
        console.warn(`[openrouterModels] /api/v1/models returned ${res.status}`);
        return null;
    }
    const body = (await res.json()) as { data?: OpenRouterApiModel[] };
    if (!Array.isArray(body.data)) {
        console.warn("[openrouterModels] unexpected response shape");
        return null;
    }
    const models = body.data
        .filter(
            (m) =>
                m.id &&
                // Exclude image-generation-only models
                !m.architecture?.modality?.includes("image->") &&
                !m.id.includes("/images/"),
        )
        .map(toModelInfo);
    return models.length > 0 ? models : null;
}

/**
 * The live OpenRouter model catalog (see discoverCatalog for caching, retry
 * and the opt-out). Null when it was never read, so the caller can fall back
 * to the static list.
 */
export function fetchOpenRouterModels(
    apiKey?: string | null,
): Promise<OpenRouterModelInfo[] | null> {
    return discoverCatalog(CATALOG_KEY, (signal) => readOpenRouterModels(apiKey, signal), REQUEST_TIMEOUT_MS);
}

/** The last catalog read, without touching the network. */
export function cachedOpenRouterModels(): OpenRouterModelInfo[] | null {
    return cachedCatalog<OpenRouterModelInfo>(CATALOG_KEY);
}
