import { describe, expect, it } from 'vitest';
import { backendEntityId } from '../config/backendIdentity';
import type { Project } from './chatTypes';
import { moveTargetsFor } from './moveTargets';
import { sameBackendConnection } from '../config/backendConnections';

const project = (id: string, extra: Partial<Project> = {}): Project =>
  ({ id, name: id, chatIds: [], edges: [], trees: [], ...extra }) as unknown as Project;

describe('moveTargetsFor', () => {
  const remoteId = backendEntityId('conn-1', 'r1');
  const projects = [
    project('l1'),
    project('l2'),
    project('archived', { archivedAt: 1 }),
    project('trashed', { deletedAt: 1 }),
    project('assistant', { system: 'assistant' }),
    project(remoteId, { backendConnectionId: 'conn-1' }),
    project('r2', { backendConnectionId: 'conn-1' }),
  ];

  it('lists only the live user workspaces on the source\'s own connection', () => {
    expect(moveTargetsFor(projects, 'l1')).toEqual([{ id: 'l2', name: 'l2' }]);
  });

  it('lets a remote thread move within its own connection', () => {
    expect(moveTargetsFor(projects, remoteId)).toEqual([{ id: 'r2', name: 'r2' }]);
  });

  it('is empty for an unknown source', () => {
    expect(moveTargetsFor(projects, 'gone')).toEqual([]);
  });
});

describe('sameBackendConnection', () => {
  it('reads the connection from a remote id when the project does not name it', () => {
    expect(sameBackendConnection(project(backendEntityId('conn-1', 'a')), project('b', { backendConnectionId: 'conn-1' }))).toBe(true);
    expect(sameBackendConnection(project(backendEntityId('conn-1', 'a')), project('local'))).toBe(false);
    expect(sameBackendConnection(project('x', { backendConnectionId: 'local' }), project('y'))).toBe(true);
  });
});
