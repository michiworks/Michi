import { fetchPersistenceCapabilities, supportsArtifactTools } from '../services/api/persistence';
import type { ArtifactEntry } from './chatTypes';

/** Artifacts a new session's first message names at most (an older backend refuses more; a newer one keeps this many). */
export const ARTIFACT_MANIFEST_MAX = 50;

interface ArtifactManifest {
  contextManifest?: Array<{ name: string; filePath: string; url?: string; kind?: ArtifactEntry['kind'] }>;
  artifactCount?: number;
}

const isPinned = (artifact: ArtifactEntry) => typeof artifact.pinnedAt === 'number';

/** Pinned first (most recently pinned first), then most recently updated; name breaks ties. */
function pinnedThenRecent(a: ArtifactEntry, b: ArtifactEntry): number {
  if (isPinned(a) !== isPinned(b)) return isPinned(a) ? -1 : 1;
  if (isPinned(a) && a.pinnedAt !== b.pinnedAt) return (b.pinnedAt as number) - (a.pinnedAt as number);
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.name.localeCompare(b.name);
}

/**
 * What a new session's first message says about the workspace's artifacts.
 * When the backend has the artifact tools: the pinned ones, most recently
 * pinned first, and how many there are in all; the agent finds the rest with
 * list_artifacts / search_artifacts, so the request stays small however many
 * artifacts the workspace holds. An older backend has neither the tools nor
 * artifactCount, so it gets the list itself: pinned first, then the most
 * recently updated, at most ARTIFACT_MANIFEST_MAX (it refuses more).
 */
export function buildArtifactManifest(artifacts: readonly ArtifactEntry[] | undefined, backendHasArtifactTools: boolean): ArtifactManifest {
  const all = artifacts ?? [];
  if (all.length === 0) return {};
  const entry = (artifact: ArtifactEntry) => ({ name: artifact.name, filePath: artifact.filePath, url: artifact.url, kind: artifact.kind });
  if (!backendHasArtifactTools) {
    return { contextManifest: [...all].sort(pinnedThenRecent).slice(0, ARTIFACT_MANIFEST_MAX).map(entry) };
  }
  const pinned = all.filter(isPinned).sort(pinnedThenRecent).slice(0, ARTIFACT_MANIFEST_MAX).map(entry);
  return {
    ...(pinned.length > 0 ? { contextManifest: pinned } : {}),
    artifactCount: all.length,
  };
}

/** How long a backend's answer is reused: a remote backend can be updated while this window runs. */
const ARTIFACT_TOOLS_PROBE_TTL_MS = 5 * 60_000;
/** How long a send waits for a probe; then it sends the full list, which every backend accepts. */
export const ARTIFACT_TOOLS_PROBE_WAIT_MS = 2_000;
/** After a probe failed or outlasted a send's wait, how long sends do not wait for one again. */
export const ARTIFACT_TOOLS_FAILURE_TTL_MS = 30_000;

const artifactToolsProbed = new Map<string, { supported: boolean; at: number }>();
const artifactToolsProbing = new Map<string, { probe: Promise<boolean | null>; at: number }>();
const artifactToolsFailed = new Map<string, number>();

const recentlyFailed = (connectionId: string): boolean => {
  const at = artifactToolsFailed.get(connectionId);
  return at !== undefined && Date.now() - at < ARTIFACT_TOOLS_FAILURE_TTL_MS;
};

/**
 * One probe of the backend of `connectionId` at a time: its answer, or null
 * when it failed. A probe that has hung for a whole failure window is given
 * up on, so the next one can start.
 */
function probeArtifactTools(connectionId: string): Promise<boolean | null> {
  const inFlight = artifactToolsProbing.get(connectionId);
  if (inFlight && Date.now() - inFlight.at < ARTIFACT_TOOLS_FAILURE_TTL_MS) return inFlight.probe;
  // Started after the map holds it, so a probe that fails at once still leaves the map.
  const probe: Promise<boolean | null> = Promise.resolve().then(async () => {
    try {
      const supported = supportsArtifactTools(await fetchPersistenceCapabilities(connectionId, { configureTransport: false }));
      artifactToolsProbed.set(connectionId, { supported, at: Date.now() });
      artifactToolsFailed.delete(connectionId);
      return supported;
    } catch {
      artifactToolsFailed.set(connectionId, Date.now());
      return null;
    } finally {
      if (artifactToolsProbing.get(connectionId)?.probe === probe) artifactToolsProbing.delete(connectionId);
    }
  });
  artifactToolsProbing.set(connectionId, { probe, at: Date.now() });
  return probe;
}

/**
 * Whether the backend of `connectionId` advertises the artifact tools
 * (GET /persistence/capabilities, through the remote proxy for a remote
 * connection). An answer is kept for a while per connection, then asked
 * again; a failed probe answers false and is asked again next time. Sends
 * go through artifactManifestForBackend, which does not wait for an old
 * answer's refresh; this awaits it, for tests of the probe itself.
 * @testonly
 */
export async function backendHasArtifactTools(connectionId: string): Promise<boolean> {
  const known = artifactToolsProbed.get(connectionId);
  if (known && Date.now() - known.at < ARTIFACT_TOOLS_PROBE_TTL_MS) return known.supported;
  return (await probeArtifactTools(connectionId)) ?? false;
}

/**
 * The first message's artifact manifest for a workspace on `connectionId`:
 * buildArtifactManifest with what that backend supports. Ensure-session runs
 * on every send, so this waits for the network only when nothing better is
 * known: a fresh answer is used as it is; an old one, or after a failure
 * (false), is used at once while a probe refreshes it in the background
 * (one that has already settled still wins); with neither, the send waits
 * up to ARTIFACT_TOOLS_PROBE_WAIT_MS for the first probe of this connection,
 * then counts it as an older backend for ARTIFACT_TOOLS_FAILURE_TTL_MS. So a
 * hanging or failing backend costs at most one wait per window. A workspace
 * without artifacts needs no probe.
 */
export async function artifactManifestForBackend(connectionId: string, artifacts: readonly ArtifactEntry[] | undefined): Promise<ArtifactManifest> {
  const ready = knownArtifactManifest(connectionId, artifacts);
  if (ready || !artifacts) return ready ?? {};
  const known = artifactToolsProbed.get(connectionId);
  const fallback = known?.supported ?? false;
  const waitMs = known || recentlyFailed(connectionId) ? 0 : ARTIFACT_TOOLS_PROBE_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const supported = await Promise.race([
    probeArtifactTools(connectionId).then((answer) => answer ?? fallback),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(fallback); }, waitMs); }),
  ]).finally(() => clearTimeout(timer));
  // A first probe that outlasted the wait: later sends use the full list without waiting, until the window ends.
  if (timedOut && waitMs > 0) artifactToolsFailed.set(connectionId, Date.now());
  return buildArtifactManifest(artifacts, supported);
}

/**
 * artifactManifestForBackend's answer when it needs no probe: a workspace
 * without artifacts, or a fresh answer for this connection. Undefined
 * otherwise. A send uses it to start ensure-session in its own tick, as it
 * did before the manifest depended on the backend.
 */
export function knownArtifactManifest(connectionId: string, artifacts: readonly ArtifactEntry[] | undefined): ArtifactManifest | undefined {
  if (!artifacts || artifacts.length === 0) return {};
  const known = artifactToolsProbed.get(connectionId);
  return known && Date.now() - known.at < ARTIFACT_TOOLS_PROBE_TTL_MS ? buildArtifactManifest(artifacts, known.supported) : undefined;
}

/**
 * The artifact an artifact_deleted event names in this workspace: by its id
 * when the event has one (another artifact that took the name since is left
 * alone), else by its exact name, else by the one name that matches ignoring
 * case. Undefined when it is already gone (a replayed event, a hydrated
 * workspace that no longer has it) or the name is ambiguous: then nothing is
 * removed.
 */
export function deletedArtifactId(
  artifacts: readonly ArtifactEntry[] | undefined,
  deleted: { name: string; contextId?: string },
): string | undefined {
  const all = artifacts ?? [];
  if (deleted.contextId) return all.find((artifact) => artifact.id === deleted.contextId)?.id;
  if (!deleted.name) return undefined;
  const exact = all.filter((artifact) => artifact.name === deleted.name);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return undefined;
  const lower = deleted.name.toLowerCase();
  const loose = all.filter((artifact) => artifact.name.toLowerCase() === lower);
  return loose.length === 1 ? loose[0].id : undefined;
}
