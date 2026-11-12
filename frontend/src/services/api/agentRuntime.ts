import { backendFetch } from './backendRequest';
import { normalizeAgentStatus, normalizeAgentModels, normalizeRuntimeCatalog } from 'michi-shared';
import type {
  AgentStatus, AgentOptionsPatch, AgentModelsResponse, RuntimeCatalogResponse,
} from 'michi-shared';
export type {
  AgentReasoning, RuntimeId, AgentCapabilities, AgentProviderInfo,
  WebSearchProviderInfo, AgentRuntimeOption, AgentStatus, AgentModelInfo,
  AgentOptionsPatch, AgentModelsResponse, RuntimeCatalogResponse,
} from 'michi-shared';
import { activeBackendApiBase, backendApiBase, LOCAL_BACKEND_CONNECTION_ID } from '../../config/backendConnections';
import { backendConnectionGeneration } from '../../config/backendConnectionState';
import { connectionIdFromApiUrl } from '../../config/backendIdentity';
import { createCatalogRequestCache } from '../catalogRequestCache';
import { remoteFirstPainted, whenRemoteFirstPaint } from '../../state/remoteFirstPaint';

/** Resolves at once for local or already-painted connections; otherwise holds until the remote's first paint (bounded). */
function afterRemoteFirstPaint(connectionId: string): Promise<void> | undefined {
  return remoteFirstPainted(connectionId) ? undefined : whenRemoteFirstPaint(connectionId);
}

// === Agent runtime API ===

export interface VerifyProviderKeyResult {
  ok: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  error?: string;
}

// One read per backend serves every caller that asks within a moment: the chat
// store, the key gate and the composer all want the same /agent/status at boot,
// and over a tunnel each duplicate costs a round trip. In-flight reads are shared
// for every backend; a settled answer is reused briefly for remote backends only.
// Anything that changes the status (saving options or a key, the reload event)
// drops both, so a later read is always a real one.
const STATUS_REUSE_MS = 2000;
const statusInflight = new Map<string, Promise<AgentStatus>>();
const statusSettled = new Map<string, { at: number; status: AgentStatus }>();

export function invalidateAgentStatus(): void {
  statusInflight.clear();
  statusSettled.clear();
}

if (typeof window !== 'undefined') window.addEventListener('michi:reload-agent-status', invalidateAgentStatus);

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export async function fetchAgentStatus(connectionId?: string, signal?: AbortSignal): Promise<AgentStatus> {
  const base = connectionId === undefined ? activeBackendApiBase() : backendApiBase(connectionId);
  const remote = connectionIdFromApiUrl(base) !== LOCAL_BACKEND_CONNECTION_ID;
  const settled = remote ? statusSettled.get(base) : undefined;
  if (settled && Date.now() - settled.at < STATUS_REUSE_MS) return settled.status;
  let pending = statusInflight.get(base);
  if (!pending) {
    // The shared read has no caller's signal; each caller leaves it by its own.
    const started: Promise<AgentStatus> = (async () => {
      const res = await backendFetch(`${base}/agent/status`);
      if (!res.ok) throw new Error(`fetchAgentStatus failed: ${res.status}`);
      return normalizeAgentStatus(await res.json());
    })();
    pending = started;
    statusInflight.set(base, started);
    started.then(
      (status) => {
        if (statusInflight.get(base) === started) statusSettled.set(base, { at: Date.now(), status });
      },
      () => {},
    ).finally(() => { if (statusInflight.get(base) === started) statusInflight.delete(base); });
  }
  return abortable(pending, signal);
}

/** The boot read of /agent/status: a remote's waits for its first content to paint. */
export async function fetchAgentStatusAfterFirstPaint(connectionId: string | undefined, signal?: AbortSignal): Promise<AgentStatus> {
  const id = connectionId ?? connectionIdFromApiUrl(activeBackendApiBase());
  const held = afterRemoteFirstPaint(id);
  if (held) await abortable(held, signal);
  return fetchAgentStatus(connectionId, signal);
}

export type ReadyStatus = 'pending' | 'ready' | 'failed';

export interface ReadyResponse {
  status: ReadyStatus;
  error: string | null;
}

export async function fetchReady(): Promise<ReadyResponse> {
  const res = await backendFetch(`${activeBackendApiBase()}/ready`);
  if (!res.ok) throw new Error(`fetchReady failed: ${res.status}`);
  const body = await res.json();
  return {
    status:
      body.status === 'ready' || body.status === 'failed' ? body.status : 'pending',
    error: typeof body.error === 'string' ? body.error : null,
  };
}

export async function saveAgentOptions(
  patch: AgentOptionsPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  invalidateAgentStatus();
  const res = await backendFetch(`${activeBackendApiBase()}/agent/options`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  invalidateAgentStatus();
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

const agentModelsCache = createCatalogRequestCache<AgentModelsResponse>();

export async function listAgentModels(opts?: { provider?: string; runtime?: string; refresh?: boolean; connectionId?: string }): Promise<AgentModelsResponse> {
  const base = opts?.connectionId === undefined ? activeBackendApiBase() : backendApiBase(opts.connectionId);
  const generation = backendConnectionGeneration(connectionIdFromApiUrl(base));
  const url = new URL(`${base}/agent/models`, window.location.href);
  if (opts?.provider) url.searchParams.set('provider', opts.provider);
  if (opts?.runtime) url.searchParams.set('expectedRuntime', opts.runtime);
  const load = async (): Promise<AgentModelsResponse> => {
    // An explicit refresh is a click; the boot read waits for the remote's first paint.
    const held = opts?.refresh ? undefined : afterRemoteFirstPaint(connectionIdFromApiUrl(base));
    if (held) await held;
    const res = await backendFetch(url.toString());
    if (!res.ok) throw new Error(`listAgentModels failed: ${res.status}`);
    return normalizeAgentModels(await res.json());
  };
  // Unscoped callers cannot safely cache an endpoint whose runtime is implicit.
  return opts?.runtime
    ? agentModelsCache.load(JSON.stringify([base, generation, opts.runtime, opts.provider ?? '']), load, opts.refresh)
    : load();
}

/**
 * Providers, models, and capabilities for an ARBITRARY runtime (the Agent
 * editor and per-node composer pickers use this for any runtime, not just
 * the active chat runtime). Backend returns cached data when available.
 */
const runtimeCatalogCache = createCatalogRequestCache<RuntimeCatalogResponse>((value) => value.capabilities !== null);

export async function fetchRuntimeCatalog(runtimeId: string, provider?: string, opts?: { refresh?: boolean; connectionId?: string }): Promise<RuntimeCatalogResponse> {
  const base = opts?.connectionId === undefined ? activeBackendApiBase() : backendApiBase(opts.connectionId);
  const generation = backendConnectionGeneration(connectionIdFromApiUrl(base));
  const url = new URL(`${base}/agent/runtime-catalog`, window.location.href);
  url.searchParams.set('runtime', runtimeId);
  if (provider) url.searchParams.set('provider', provider);
  return runtimeCatalogCache.load(JSON.stringify([base, generation, runtimeId, provider ?? '']), async () => {
    const held = opts?.refresh ? undefined : afterRemoteFirstPaint(connectionIdFromApiUrl(base));
    if (held) await held;
    const res = await backendFetch(url.toString());
    if (!res.ok) throw new Error(`fetchRuntimeCatalog failed: ${res.status}`);
    return normalizeRuntimeCatalog(await res.json());
  }, opts?.refresh);
}

export async function saveProviderKey(
  provider: string,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  invalidateAgentStatus();
  const res = await backendFetch(`${activeBackendApiBase()}/agent/provider-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });
  invalidateAgentStatus();
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function clearProviderKey(
  provider: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  invalidateAgentStatus();
  const res = await backendFetch(
    `${activeBackendApiBase()}/agent/provider-key/${encodeURIComponent(provider)}`,
    { method: 'DELETE' },
  );
  invalidateAgentStatus();
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function verifyProviderKey(
  provider: string,
  opts?: { key?: string; model?: string },
): Promise<VerifyProviderKeyResult> {
  const res = await backendFetch(`${activeBackendApiBase()}/agent/provider-key/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key: opts?.key, model: opts?.model }),
  });
  const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
  if (!res.ok) return { ok: false, error: body.error ?? `status ${res.status}` };
  return body;
}

export async function saveWebSearchKey(
  provider: string,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await backendFetch(`${activeBackendApiBase()}/agent/search-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function clearWebSearchKey(
  provider: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await backendFetch(
    `${activeBackendApiBase()}/agent/search-key/${encodeURIComponent(provider)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Bedrock credential configuration
// ---------------------------------------------------------------------------

export type BedrockCredentialSource = 'bearer-token' | 'access-keys' | 'profile' | 'auto';

export interface BedrockConfigSanitized {
  configured: boolean;
  region: string | null;
  credentialSource: BedrockCredentialSource | 'env' | null;
  hasProfile: boolean;
  hasBearerToken: boolean;
  hasAccessKeys: boolean;
  hasAuthRefresh: boolean;
  envDetected: boolean;
  envProfile?: string;
  envRegion?: string;
}

export interface BedrockConfigInput {
  region?: string;
  credentialSource?: BedrockCredentialSource;
  bearerToken?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  profile?: string;
  authRefreshCommand?: string;
}

export async function getBedrockConfig(): Promise<BedrockConfigSanitized> {
  const res = await backendFetch(`${activeBackendApiBase()}/agent/bedrock-config`);
  if (!res.ok) throw new Error(`getBedrockConfig failed: ${res.status}`);
  return res.json();
}

export async function saveBedrockConfig(
  cfg: BedrockConfigInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await backendFetch(`${activeBackendApiBase()}/agent/bedrock-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function clearBedrockConfig(): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await backendFetch(`${activeBackendApiBase()}/agent/bedrock-config`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function verifyBedrockConfig(): Promise<VerifyProviderKeyResult> {
  const res = await backendFetch(`${activeBackendApiBase()}/agent/bedrock-config/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
  if (!res.ok) return { ok: false, error: body.error ?? `status ${res.status}` };
  return body;
}
