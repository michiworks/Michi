import { edgeRowId } from 'michi-shared';
import { serverEntityId } from '../config/backendIdentity';
import type { ProjectEdge } from './chatTypes';

/**
 * An edge's id: its row's id on its backend, so writes, deletes and the
 * bookkeeping around them all name the same row. A workspace's edges share
 * one connection, so leaving the connection out keeps the id unique there.
 */
export function serializedEdgeId(edge: Pick<ProjectEdge, 'source' | 'target' | 'kind'>): string {
  return edgeRowId(edge.kind || 'branch', serverEntityId(edge.source), serverEntityId(edge.target));
}
