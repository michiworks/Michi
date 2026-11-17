import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { closeRemoteAuthentication, completeRemoteAuthentication, getRemoteAuthentication, reportRemoteCredentialError, reportRemoteRuntimeReady, requestRemoteAuthentication, usePendingRemoteAuthentications } from './remoteAuthentication';
import { indexBackendProjects, setKnownBackendConnections } from '../config/backendConnections';
vi.mock('../../../shared/src/remoteCredentials', () => ({ REMOTE_CREDENTIALS: {
  name: 'Example SSO', localAction: 'Refresh Example SSO on this computer', localCommand: ['example-login'],
  remoteCommand: ['example-login', '--remote'], remoteCookie: null,
  remoteCredentialError: /example-login|example sso.*expired/i, localCredentialError: null,
} }));
afterEach(() => { closeRemoteAuthentication(); for (const key of ['runtime:remote', 'incident', 'other']) completeRemoteAuthentication(key); setKnownBackendConnections([]); indexBackendProjects([]); });
const pendingKeys = () => renderHook(() => usePendingRemoteAuthentications()).result.current.map(item => item.key);

it('only prompts for remote credential errors on an SSH-backed node and keeps unrelated errors quiet', () => {
  setKnownBackendConnections([{ id: 'remote', name: 'Remote', transport: 'ssh', sshHost: 'box', hasToken: true, createdAt: 1, updatedAt: 1 }]);
  indexBackendProjects([{ id: 'workspace', backendConnectionId: 'remote', chatIds: ['remote-node'] }]);
  reportRemoteCredentialError('remote-node', 'Codex request timed out');
  reportRemoteCredentialError('local-node', 'Run example-login --remote');
  expect(pendingKeys()).toEqual([]);
  reportRemoteCredentialError('remote-node', 'Example SSO session expired');
  // A turn's error asks from the notice corner: the dialog takes focus only on the user's Sign in.
  expect(getRemoteAuthentication()).toBeNull();
  expect(pendingKeys()).toEqual(['runtime:remote']);
});
it('opens the dialog only for the user, without interrupting active sign-in, and deduplicates automatic prompts', () => {
  const request = { key: 'incident', target: { scope: 'local' as const, host: 'box' } };
  requestRemoteAuthentication(request);
  requestRemoteAuthentication(request);
  expect(getRemoteAuthentication()).toBeNull();
  expect(pendingKeys()).toEqual(['incident']);
  requestRemoteAuthentication(request, true);
  requestRemoteAuthentication({ ...request, key: 'other' }, true);
  expect(getRemoteAuthentication()?.key).toBe('incident');
  expect(pendingKeys()).toEqual(['incident', 'other']);
});
it('allows a later expiry to prompt again after an externally authenticated turn succeeds', () => {
  setKnownBackendConnections([{ id: 'remote', name: 'Remote', transport: 'ssh', sshHost: 'box', hasToken: true, createdAt: 1, updatedAt: 1 }]);
  indexBackendProjects([{ id: 'workspace', backendConnectionId: 'remote', chatIds: ['remote-node'] }]);
  reportRemoteCredentialError('remote-node', 'Run example-login --remote');
  reportRemoteRuntimeReady('local-node');
  expect(pendingKeys()).toEqual(['runtime:remote']);
  reportRemoteRuntimeReady('remote-node');
  expect(pendingKeys()).toEqual([]);
  reportRemoteCredentialError('remote-node', 'Run example-login --remote');
  expect(pendingKeys()).toEqual(['runtime:remote']);
});
