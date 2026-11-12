/**
 * Live provider model discovery.
 *
 * pi-ai ships a model catalog generated when the package is published, so a
 * model a provider released after that publish can be neither listed nor
 * selected: `getModels(provider)` keeps answering with the snapshot baked into
 * the installed version. This module asks each provider's own `/models`
 * endpoint for the live catalog and caches it. The cache itself
 * (`discoverCatalog`) also serves OpenRouter's richer catalog in
 * `openrouterModels.ts`.
 *
 * The live answer is metadata-poor — ids, sometimes a display name and a
 * context length, never cost, thinking levels or compat flags. Discovery
 * therefore only ever *adds* ids; a model the static catalog already knows
 * keeps its descriptor. New ids are described by the caller
 * (`synthesizeProviderModel` in piProviders.ts), which uses the provider's
 * pinned entry as a template.
 *
 * Best effort by contract: every failure (offline, 404, unparsable body,
 * timeout) falls back to the last good snapshot and then to null, and the
 * caller uses the static catalog alone. `MICHI_MODEL_DISCOVERY=0` disables the
 * network calls entirely.
 */

export type ModelDiscoveryDialect = "openai" | "anthropic" | "gemini";

export interface LiveProviderModel {
    id: string;
    name?: string;
    /** Upstream creation time, when the provider reports one. */
    created?: number;
    contextWindow?: number;
    maxTokens?: number;
}

export interface ModelDiscoveryRequest {
    provider: string;
    /** Catalog base URL, normally taken from the static catalog entry. */
    baseUrl: string;
    dialect: ModelDiscoveryDialect;
    apiKey?: string | null;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 4_000;

interface CacheEntry {
    models: unknown[];
    fetchedAt: number;
    /** Last failure, so an offline machine retries once a minute, not per call. */
    failedAt: number | null;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown[] | null>>();

/** Discovery is on unless the deployment opts out. */
export function isModelDiscoveryEnabled(): boolean {
    return process.env.MICHI_MODEL_DISCOVERY !== "0";
}

/** Last good catalog under `key`, without touching the network. */
export function cachedCatalog<T>(key: string): T[] | null {
    return (cache.get(key)?.models as T[] | undefined) ?? null;
}

/** Last good live catalog for a provider, without touching the network. */
export function cachedDiscoveredModels(provider: string): LiveProviderModel[] | null {
    return cachedCatalog<LiveProviderModel>(provider);
}

/**
 * Drop cached entries and pending requests between test cases.
 * @testonly
 */
export function resetModelDiscoveryForTests(): void {
    cache.clear();
    inflight.clear();
}

function trimSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

/** All three dialects answer under `<baseUrl>/models`. */
export function discoveryUrlFor(baseUrl: string): string {
    return `${trimSlash(baseUrl)}/models`;
}

function headersFor(dialect: ModelDiscoveryDialect, apiKey: string): Record<string, string> {
    switch (dialect) {
        case "anthropic":
            return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
        case "gemini":
            // Header rather than ?key= so the secret never lands in a URL log.
            return { "x-goog-api-key": apiKey };
        default:
            return { Authorization: `Bearer ${apiKey}` };
    }
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOpenAiBody(body: unknown): LiveProviderModel[] {
    const rows = Array.isArray(body)
        ? body
        : Array.isArray((body as any)?.data)
            ? (body as any).data
            : Array.isArray((body as any)?.models)
                ? (body as any).models
                : [];
    const models: LiveProviderModel[] = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const id = typeof (row as any).id === "string" ? (row as any).id : undefined;
        if (!id) continue;
        models.push({
            id,
            name: typeof (row as any).name === "string" ? (row as any).name : undefined,
            created: finiteNumber((row as any).created),
            contextWindow: finiteNumber((row as any).context_window ?? (row as any).context_length),
            maxTokens: finiteNumber((row as any).max_completion_tokens),
        });
    }
    return models;
}

function parseAnthropicBody(body: unknown): LiveProviderModel[] {
    const rows = Array.isArray((body as any)?.data) ? (body as any).data : [];
    const models: LiveProviderModel[] = [];
    for (const row of rows) {
        const id = typeof (row as any)?.id === "string" ? (row as any).id : undefined;
        if (!id) continue;
        // Anthropic reports created_at as ISO 8601, not epoch seconds.
        const createdAt = typeof (row as any).created_at === "string" ? Date.parse((row as any).created_at) : NaN;
        models.push({
            id,
            name: typeof (row as any).display_name === "string" ? (row as any).display_name : undefined,
            created: Number.isFinite(createdAt) ? createdAt : undefined,
        });
    }
    return models;
}

function parseGeminiBody(body: unknown): LiveProviderModel[] {
    const rows = Array.isArray((body as any)?.models) ? (body as any).models : [];
    const models: LiveProviderModel[] = [];
    for (const row of rows) {
        const name = typeof (row as any)?.name === "string" ? (row as any).name : undefined;
        if (!name) continue;
        // Gemini answers `models/gemini-3.8-flash`; the API takes the bare id.
        const id = name.startsWith("models/") ? name.slice("models/".length) : name;
        const methods: unknown = (row as any).supportedGenerationMethods;
        if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
        models.push({
            id,
            name: typeof (row as any).displayName === "string" ? (row as any).displayName : undefined,
            contextWindow: finiteNumber((row as any).inputTokenLimit),
            maxTokens: finiteNumber((row as any).outputTokenLimit),
        });
    }
    return models;
}

function parseDiscoveryBody(dialect: ModelDiscoveryDialect, body: unknown): LiveProviderModel[] {
    switch (dialect) {
        case "anthropic":
            return parseAnthropicBody(body);
        case "gemini":
            return parseGeminiBody(body);
        default:
            return parseOpenAiBody(body);
    }
}

async function fetchLiveModels(request: ModelDiscoveryRequest, signal: AbortSignal): Promise<LiveProviderModel[] | null> {
    const apiKey = request.apiKey ?? "";
    const res = await fetch(discoveryUrlFor(request.baseUrl), {
        headers: apiKey ? headersFor(request.dialect, apiKey) : {},
        signal,
    });
    if (!res.ok) {
        console.warn(`[providerModelDiscovery] ${request.provider} /models returned ${res.status}`);
        return null;
    }
    const models = parseDiscoveryBody(request.dialect, await res.json());
    return models.length > 0 ? models : null;
}

async function readCatalog<T>(
    key: string,
    fetchRows: (signal: AbortSignal) => Promise<T[] | null>,
    timeoutMs: number,
): Promise<T[] | null> {
    const controller = new AbortController();
    // Bounds the background download, body included; callers bound their own wait.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
        return await fetchRows(controller.signal);
    } catch (err) {
        if (controller.signal.aborted) {
            console.warn(`[providerModelDiscovery] ${key} catalog timed out`);
        } else {
            console.warn(`[providerModelDiscovery] ${key} catalog failed:`, err);
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A live catalog under `key`: cached for CACHE_TTL_MS, single-flight while a
 * request is in progress, not retried for FAILURE_TTL_MS after a failure, and
 * stale-on-error afterwards. `fetchRows` answers null (or throws) for a
 * failure. Returns null when nothing has ever been fetched, so callers can
 * tell "no news" from "empty". MICHI_MODEL_DISCOVERY=0 keeps it offline.
 */
export async function discoverCatalog<T>(
    key: string,
    fetchRows: (signal: AbortSignal) => Promise<T[] | null>,
    timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T[] | null> {
    const entry = cache.get(key) as { models: T[]; fetchedAt: number; failedAt: number | null } | undefined;
    const now = Date.now();
    if (entry && entry.models.length > 0 && now - entry.fetchedAt < CACHE_TTL_MS) {
        return entry.models;
    }
    if (!isModelDiscoveryEnabled()) return entry?.models ?? null;
    if (entry?.failedAt && now - entry.failedAt < FAILURE_TTL_MS) {
        return entry.models.length > 0 ? entry.models : null;
    }

    const pending = inflight.get(key) as Promise<T[] | null> | undefined;
    if (pending) return pending;

    const task = (async () => {
        const models = await readCatalog(key, fetchRows, timeoutMs);
        if (models) {
            cache.set(key, { models, fetchedAt: Date.now(), failedAt: null });
            return models;
        }
        const previous = cache.get(key) as { models: T[]; fetchedAt: number } | undefined;
        cache.set(key, {
            models: previous?.models ?? [],
            fetchedAt: previous?.fetchedAt ?? 0,
            failedAt: Date.now(),
        });
        return previous?.models.length ? previous.models : null;
    })();

    inflight.set(key, task);
    try {
        return await task;
    } finally {
        inflight.delete(key);
    }
}

/** The live catalog of a provider's own `/models` endpoint (see discoverCatalog). */
export function discoverProviderModels(
    request: ModelDiscoveryRequest,
): Promise<LiveProviderModel[] | null> {
    return discoverCatalog(request.provider, (signal) => fetchLiveModels(request, signal));
}
