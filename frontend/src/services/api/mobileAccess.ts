import type { MobileAccessLink, MobileAccessProvider, MobileAccessStatus } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendFetch } from './backendRequest';

export type MobileAccessAction = 'start' | 'stop' | 'link' | 'login' | 'open-app' | 'provider';

/** What Phone access says when the request never reached Michi on that machine. */
export const MOBILE_ACCESS_UNREACHABLE = 'Couldn’t reach Michi on this machine to check phone access. Check that it is running, then try again.';

async function mobileAccessFetch(connectionId: string, path: string, init: RequestInit): Promise<Response> {
  try {
    return await backendFetch(`${backendApiBase(connectionId)}/mobile-access${path ? `/${path}` : ''}`, init);
  } catch (error) {
    // fetch reports a network or CORS failure as a bare TypeError ("Failed to fetch").
    if (error instanceof TypeError) throw new Error(MOBILE_ACCESS_UNREACHABLE);
    throw error;
  }
}

/**
 * Phone access on a machine: its state, or an action on it. Credentials are
 * the browser's default (same-origin), as for every other API call: a page
 * opened through phone access is served from the same origin as its API, and
 * the desktop's loopback API does not allow credentialed cross-origin reads,
 * so `credentials: 'include'` failed every request from the dev server
 * (:3001 → :3000) as a CORS error, shown as "Failed to fetch".
 */
export async function mobileAccessRequest<T = MobileAccessStatus>(connectionId: string, action?: MobileAccessAction, signal?: AbortSignal, provider?: MobileAccessProvider): Promise<T> {
  const response = await mobileAccessFetch(connectionId, action ?? '', {
    method: action ? 'POST' : 'GET', signal,
    ...(provider ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Mobile access is unavailable on this machine. Update its Michi backend.');
  return body as T;
}
export const createMobileAccessLink = (connectionId: string) => mobileAccessRequest<MobileAccessLink>(connectionId, 'link');

/** Settings › Phone access › Terminal on that machine. */
export async function setPhoneTerminal(connectionId: string, enabled: boolean): Promise<MobileAccessStatus> {
  const response = await mobileAccessFetch(connectionId, 'terminal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Update Michi on this machine to use terminals from your phone.');
  return body as MobileAccessStatus;
}
