import type { ComponentHost, PageComponent, PageComponentInput, PageComponentReference, PageComponentVersion } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendEntityId, serverEntityId } from '../../config/backendIdentity';
import { backendFetch } from './backendRequest';
import { PageApiError, pageApiError } from './pages';

export interface PageComponentLibrary { revision: number; items: PageComponent[] }
export interface PageComponentVersionDto extends PageComponentVersion { propsSchema: PageComponentVersion['propsSchema'] }
export interface PageComponentDetail { component?: PageComponent; version: PageComponentVersionDto; references?: PageComponentReference[] }
export interface ComponentCapability { capability: string; expiresAt: number; host: ComponentHost; version: number; props: Record<string, unknown>; capabilityId?: string }

export class PageComponentApiError extends PageApiError {
  constructor(status: number, code: string, message: string) { super(status, code, message); this.name = 'PageComponentApiError'; }
}

const base = (connectionId: string) => backendApiBase(connectionId);
const idPath = (id: string, connectionId: string) => encodeURIComponent(serverEntityId(id, connectionId));
const mapComponent = (component: PageComponent, connectionId: string): PageComponent => ({
  ...component,
  id: backendEntityId(connectionId, component.id),
  workspaceId: backendEntityId(connectionId, component.workspaceId),
});
const mapVersionSource = (version: PageComponentVersionDto, connectionId: string): PageComponentVersionDto => ({
  ...version,
  source: version.source.kind === 'user'
    ? version.source
    : { ...version.source, nodeId: backendEntityId(connectionId, version.source.nodeId) },
});
// Component props are opaque: like pages.ts, map only the DTOs' own references.
async function request<T>(connectionId: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await backendFetch(`${base(connectionId)}${path}`, init, { mapPayload: false });
  if (!response.ok) {
    const { status, code, message } = await pageApiError(response, 'component_request_failed', 'Component');
    throw new PageComponentApiError(status, code, message);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}
const body = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

export async function listPageComponents(workspaceId: string, connectionId: string, signal?: AbortSignal): Promise<PageComponentLibrary> {
  const result = await request<{ revision: number; items: PageComponent[] }>(connectionId, `/workspaces/${idPath(workspaceId, connectionId)}/components`, { signal });
  return { revision: result.revision, items: result.items.map(item => mapComponent(item, connectionId)) };
}

export async function readPageComponent(componentId: string, workspaceId: string, connectionId: string, version?: number, signal?: AbortSignal): Promise<PageComponentDetail> {
  const query = new URLSearchParams({ workspaceId: serverEntityId(workspaceId, connectionId) });
  if (version !== undefined) query.set('version', String(version));
  const [result, library] = await Promise.all([
    request<PageComponentVersionDto>(connectionId, `/components/${idPath(componentId, connectionId)}?${query}`, { signal }),
    listPageComponents(workspaceId, connectionId, signal),
  ]);
  return { version: mapVersionSource(result, connectionId), component: library.items.find(item => item.id === backendEntityId(connectionId, componentId)) };
}

export async function listPageComponentReferences(componentId: string, workspaceId: string, connectionId: string, signal?: AbortSignal): Promise<PageComponentReference[]> {
  const query = new URLSearchParams({ workspaceId: serverEntityId(workspaceId, connectionId) });
  const result = await request<PageComponentReference[] | { items: PageComponentReference[] }>(connectionId, `/components/${idPath(componentId, connectionId)}/references?${query}`, { signal });
  const items = Array.isArray(result) ? result : result.items;
  return items.map(ref => ({ ...ref, componentId: backendEntityId(connectionId, ref.componentId), workspaceId: backendEntityId(connectionId, ref.workspaceId), ...(ref.pageId ? { pageId: backendEntityId(connectionId, ref.pageId) } : {}), ...(ref.databaseId ? { databaseId: backendEntityId(connectionId, ref.databaseId) } : {}) }));
}

export async function savePageComponent(workspaceId: string, input: PageComponentInput, expectedLibraryRevision: number, connectionId: string, signal?: AbortSignal): Promise<PageComponentDetail> {
  const result = await request<{ component?: PageComponent; version?: PageComponentVersionDto }>(connectionId, `/workspaces/${idPath(workspaceId, connectionId)}/components`, { ...body({ input, expectedLibraryRevision }), signal });
  if (!result.component || !result.version) throw new Error('Component service returned no saved version');
  return { component: mapComponent(result.component, connectionId), version: mapVersionSource(result.version, connectionId) };
}

export type PageComponentLibraryAction = 'enable' | 'disable' | 'activate';
export async function updatePageComponent(componentId: string, action: PageComponentLibraryAction | 'rollback', workspaceId: string, connectionId: string, expectedLibraryRevision: number, version?: number, signal?: AbortSignal): Promise<PageComponent> {
  const payload = { ...(version === undefined ? {} : { version }), expectedLibraryRevision, workspaceId: serverEntityId(workspaceId, connectionId) };
  const result = await request<{ component?: PageComponent } | PageComponent>(connectionId, `/components/${idPath(componentId, connectionId)}/${action}`, { ...body(payload), signal });
  const component: PageComponent | undefined = result !== null && typeof result === 'object' && 'component' in result
    ? (result as { component?: PageComponent }).component
    : result as PageComponent;
  if (!component) throw new Error('Component service returned no component');
  return mapComponent(component, connectionId);
}

export async function deletePageComponent(componentId: string, workspaceId: string, connectionId: string, expectedLibraryRevision: number, signal?: AbortSignal): Promise<void> {
  await request(connectionId, `/components/${idPath(componentId, connectionId)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: serverEntityId(workspaceId, connectionId), expectedLibraryRevision }), signal });
}

export async function mintPageComponentCapability(input: { workspaceId: string; componentId: string; version: number; host: ComponentHost; props: Record<string, unknown>; resources?: unknown[] }, connectionId: string, signal?: AbortSignal): Promise<ComponentCapability> {
  const host = input.host.kind === 'page_block'
    ? { ...input.host, pageId: serverEntityId(input.host.pageId, connectionId) }
    : { ...input.host, databaseId: serverEntityId(input.host.databaseId, connectionId) };
  const result = await request<ComponentCapability>(connectionId, '/component-capabilities', { ...body({ ...input, workspaceId: serverEntityId(input.workspaceId, connectionId), componentId: serverEntityId(input.componentId, connectionId), host }), signal });
  return result;
}

export async function callPageComponentCapability(capabilityId: string, capability: string, call: { method: string; resourceId?: string; args: unknown[] }, connectionId: string, signal?: AbortSignal): Promise<unknown> {
  const routeId = encodeURIComponent(capabilityId || capability);
  const result = await request<{ result?: unknown } | unknown>(connectionId, `/component-capabilities/${routeId}`, { ...body(call), signal });
  return result && typeof result === 'object' && 'result' in result ? (result as { result?: unknown }).result : result;
}

export async function revokePageComponentCapability(capability: string, connectionId: string, signal?: AbortSignal): Promise<void> {
  await request(connectionId, `/component-capabilities/${encodeURIComponent(capability)}`, { method: 'DELETE', signal });
}
