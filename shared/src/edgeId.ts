/**
 * The id of an `edges` row, from its kind and the server ids of its
 * endpoints. Every writer uses it, so a window that holds only an edge's kind
 * and endpoints (it keeps no row ids) can delete or update the row.
 */
export function edgeRowId(kind: string, sourceNodeId: string, targetNodeId: string): string {
  return `${kind}-${sourceNodeId}-${targetNodeId}`;
}
