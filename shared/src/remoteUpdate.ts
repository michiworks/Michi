import type { RemoteConnectionDiagnostic } from './remoteDiagnostics';

export interface MichiBuildInfo {
  version: string;
  revision: string | null;
  dirty?: boolean;
}

/** The body of a Michi backend's GET /api/health. */
export interface MichiBackendHealth {
  status: 'healthy';
  service: 'michi-backend';
  connectionProtocol: 1;
  build: MichiBuildInfo;
  serverId: string;
  serviceMode: boolean;
  serviceBuild: string | null;
  auditLog?: 'unavailable';
}

/** Older backends answer without the later fields; only status and service are certain. */
export function isMichiBackendHealth(body: unknown): body is Pick<MichiBackendHealth, 'status' | 'service'> & Partial<MichiBackendHealth> {
  const health = body as Partial<MichiBackendHealth> | null | undefined;
  return health?.service === 'michi-backend' && health.status === 'healthy';
}

export interface RemoteUpdateStatus {
  local: MichiBuildInfo;
  remote: MichiBuildInfo | null;
  state: 'current' | 'older' | 'different' | 'unknown';
  canUpdate: boolean;
  message?: string;
}

/**
 * The gateway's latest update attempt for one saved machine. An accepted
 * update outlives the view that started it, so any view can follow it.
 */
export interface RemoteUpdateJob {
  connectionId: string;
  attemptId: string;
  phase: 'running' | 'succeeded' | 'failed';
  stage: string;
  message: string;
  startedAt: string;
  finishedAt?: string;
  /** Verified remote version after success. */
  result?: RemoteUpdateStatus;
  /** Saved failure report; omitted while running. */
  diagnostic?: RemoteConnectionDiagnostic;
}
