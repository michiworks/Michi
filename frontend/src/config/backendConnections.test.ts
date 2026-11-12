import { beforeEach, describe, expect, it } from 'vitest';
import {
  indexBackendProjects, getKnownBackendConnections, setKnownBackendConnections, setActiveBackendConnectionId,
  isLocalProject, projectConnectionId,
} from './backendConnections';

describe('backend connection routing', () => {
  beforeEach(() => {
    indexBackendProjects([]);
    setActiveBackendConnectionId('local');
    setKnownBackendConnections([]);
  });

  it('keeps direct and SSH connections available alongside Local', () => {
    setKnownBackendConnections([
      {
        id: 'direct-1',
        name: 'Direct',
        transport: 'direct',
        apiUrl: 'https://michi.example.com/api',
        hasToken: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'ssh-1',
        name: 'SSH',
        transport: 'ssh',
        sshHost: 'build-server-box',
        remotePort: 3000,
        hasToken: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(getKnownBackendConnections().map((connection) => [connection.id, connection.transport])).toEqual([
      ['local', 'direct'],
      ['direct-1', 'direct'],
      ['ssh-1', 'ssh'],
    ]);
  });
});

describe('projectConnectionId', () => {
  it('reads the connection from the id first, then the field', () => {
    expect(projectConnectionId({ id: 'remote:c1:p1' })).toBe('c1');
    expect(projectConnectionId({ id: 'p1', backendConnectionId: 'c1' })).toBe('c1');
    expect(projectConnectionId({ id: 'remote:c1:p1', backendConnectionId: 'c1' })).toBe('c1');
    expect(projectConnectionId({ id: 'p1' })).toBe('local');
    expect(projectConnectionId({ id: 'p1', backendConnectionId: 'local' })).toBe('local');
  });

  it('never turns a remote id Local when the field disagrees or is lost', () => {
    expect(projectConnectionId({ id: 'remote:c1:p1', backendConnectionId: 'local' })).toBe('c1');
    expect(isLocalProject({ id: 'remote:c1:p1' })).toBe(false);
    expect(() => indexBackendProjects([{ id: 'remote:c1:p1', backendConnectionId: 'c2', chatIds: [] }])).toThrow();
  });

  it('throws on a malformed remote id', () => {
    expect(() => projectConnectionId({ id: 'remote:x' })).toThrow();
  });
});

describe('isLocalProject', () => {
  it('is Local only without a remote id or field', () => {
    expect(isLocalProject({ id: 'p1' })).toBe(true);
    expect(isLocalProject({ id: 'p1', backendConnectionId: 'local' })).toBe(true);
    expect(isLocalProject({ id: 'p1', backendConnectionId: 'c1' })).toBe(false);
  });
});
