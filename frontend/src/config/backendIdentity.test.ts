import { describe, expect, it } from 'vitest';
import { isLocalConnectionId, LOCAL_BACKEND_CONNECTION_ID, namesRemoteEntity } from './backendIdentity';

describe('isLocalConnectionId', () => {
  it('counts a missing id as Local', () => {
    expect(isLocalConnectionId(undefined)).toBe(true);
    expect(isLocalConnectionId(null)).toBe(true);
    expect(isLocalConnectionId('')).toBe(true);
    expect(isLocalConnectionId(LOCAL_BACKEND_CONNECTION_ID)).toBe(true);
    expect(isLocalConnectionId('x')).toBe(false);
  });
});

describe('namesRemoteEntity', () => {
  it('treats any remote prefix as remote, a malformed one too', () => {
    expect(namesRemoteEntity('remote:c1:n1')).toBe(true);
    expect(namesRemoteEntity('remote:x')).toBe(true);
    expect(namesRemoteEntity('remote:local:n1')).toBe(true);
    expect(namesRemoteEntity('n1')).toBe(false);
  });
});
